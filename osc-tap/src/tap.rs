use std::fs::File;
use std::io::Write as _;
use std::net::{SocketAddr, UdpSocket};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Instant;

use anyhow::{Context, Result};
use rosc::{OscMessage, OscPacket, OscType};
use serde::Serialize;
use serde_json::{json, Value};

use crate::config::Config;

const MAX_DATAGRAM: usize = 65_507;
/// Kernel receive buffer for the listen socket (best effort).
const RECV_BUF_BYTES: usize = 4 * 1024 * 1024;
/// Max packets queued to the writer before we drop (and count) instead of blocking.
const CHANNEL_CAP: usize = 65_536;

/// Latest beacon: (TD timeline seconds, arrival time).
type BeaconState = Arc<Mutex<Option<(f64, Instant)>>>;

pub struct Tap {
    pub listen_addr: SocketAddr,
    pub beacon_addr: SocketAddr,
    handle: Handle,
}

#[derive(Clone)]
pub struct Handle {
    tx: SyncSender<Msg>,
}

enum Msg {
    Packet {
        buf: Vec<u8>,
        t: Instant,
        beacon: Option<(f64, Instant)>,
    },
    Start {
        reply: Sender<Result<PathBuf, String>>,
    },
    Stop {
        reply: Sender<Result<(), String>>,
    },
    Status {
        reply: Sender<Status>,
    },
}

#[derive(Debug, Clone, Serialize)]
pub struct Status {
    pub recording: bool,
    pub clip: Option<PathBuf>,
    pub events: u64,
    /// Extrapolated TD timeline seconds as of now.
    pub beacon_tl: Option<f64>,
    /// Seconds since the last beacon arrived.
    pub beacon_age: Option<f64>,
    /// Packets dropped because the writer backlog was full.
    pub dropped: u64,
}

impl Handle {
    pub fn start_clip(&self) -> Result<PathBuf, String> {
        let (tx, rx) = mpsc::channel();
        self.tx
            .send(Msg::Start { reply: tx })
            .map_err(|_| "writer thread gone".to_string())?;
        rx.recv().map_err(|_| "writer thread gone".to_string())?
    }

    pub fn stop_clip(&self) -> Result<(), String> {
        let (tx, rx) = mpsc::channel();
        self.tx
            .send(Msg::Stop { reply: tx })
            .map_err(|_| "writer thread gone".to_string())?;
        rx.recv().map_err(|_| "writer thread gone".to_string())?
    }

    pub fn status(&self) -> Result<Status, String> {
        let (tx, rx) = mpsc::channel();
        self.tx
            .send(Msg::Status { reply: tx })
            .map_err(|_| "writer thread gone".to_string())?;
        rx.recv().map_err(|_| "writer thread gone".to_string())
    }
}

impl Tap {
    pub fn start(config: Config) -> Result<Tap> {
        let listen = bind_udp(config.listen, Some(RECV_BUF_BYTES))
            .with_context(|| format!("bind listen {}", config.listen))?;
        let beacon_sock = bind_udp(config.beacon, None)
            .with_context(|| format!("bind beacon {}", config.beacon))?;
        let forward = UdpSocket::bind("0.0.0.0:0").context("bind forward socket")?;
        forward
            .connect(config.forward)
            .with_context(|| format!("connect forward {}", config.forward))?;

        let listen_addr = listen.local_addr()?;
        let beacon_addr = beacon_sock.local_addr()?;
        std::fs::create_dir_all(&config.outdir)?;

        let beacon: BeaconState = Arc::new(Mutex::new(None));
        let dropped = Arc::new(AtomicU64::new(0));
        let (tx, rx) = mpsc::sync_channel::<Msg>(CHANNEL_CAP);

        // recv thread: stamp, forward raw, hand off to writer. No parsing here.
        {
            let beacon = beacon.clone();
            let tx = tx.clone();
            let dropped = dropped.clone();
            thread::Builder::new().name("recv".into()).spawn(move || {
                let mut buf = [0u8; MAX_DATAGRAM];
                loop {
                    let n = match listen.recv(&mut buf) {
                        Ok(n) => n,
                        Err(e) => {
                            eprintln!("osc-tap: recv error: {e}");
                            continue;
                        }
                    };
                    let t = Instant::now();
                    if let Err(e) = forward.send(&buf[..n]) {
                        eprintln!("osc-tap: forward error: {e}");
                    }
                    let snapshot = *beacon.lock().unwrap();
                    match tx.try_send(Msg::Packet {
                        buf: buf[..n].to_vec(),
                        t,
                        beacon: snapshot,
                    }) {
                        Ok(()) => {}
                        Err(TrySendError::Full(_)) => {
                            let d = dropped.fetch_add(1, Ordering::Relaxed) + 1;
                            if d == 1 || d % 1000 == 0 {
                                eprintln!("osc-tap: writer backlog full, {d} packets dropped");
                            }
                        }
                        Err(TrySendError::Disconnected(_)) => break,
                    }
                }
            })?;
        }

        // beacon thread
        {
            let beacon = beacon.clone();
            thread::Builder::new().name("beacon".into()).spawn(move || {
                let mut buf = [0u8; MAX_DATAGRAM];
                loop {
                    let n = match beacon_sock.recv(&mut buf) {
                        Ok(n) => n,
                        Err(e) => {
                            eprintln!("osc-tap: beacon recv error: {e}");
                            continue;
                        }
                    };
                    let now = Instant::now();
                    let Ok((_, packet)) = rosc::decoder::decode_udp(&buf[..n]) else {
                        continue;
                    };
                    let mut msgs = Vec::new();
                    flatten(packet, &mut msgs);
                    for m in msgs {
                        if m.addr != "/tap/timeline" {
                            continue;
                        }
                        let tl = match m.args.first() {
                            Some(OscType::Float(f)) => Some(*f as f64),
                            Some(OscType::Double(d)) => Some(*d),
                            _ => None,
                        };
                        if let Some(tl) = tl {
                            *beacon.lock().unwrap() = Some((tl, now));
                        }
                    }
                }
            })?;
        }

        // writer thread
        {
            let outdir = config.outdir.clone();
            let beacon = beacon.clone();
            let dropped = dropped.clone();
            let listen_port = listen_addr.port();
            let forward_addr = config.forward;
            thread::Builder::new()
                .name("writer".into())
                .spawn(move || writer_loop(rx, outdir, listen_port, forward_addr, beacon, dropped))?;
        }

        Ok(Tap {
            listen_addr,
            beacon_addr,
            handle: Handle { tx },
        })
    }

    pub fn handle(&self) -> Handle {
        self.handle.clone()
    }
}

struct Recording {
    file: File,
    path: PathBuf,
    epoch: Instant,
    events: u64,
}

fn writer_loop(
    rx: mpsc::Receiver<Msg>,
    outdir: PathBuf,
    listen_port: u16,
    forward_addr: SocketAddr,
    beacon: BeaconState,
    dropped: Arc<AtomicU64>,
) {
    let mut rec: Option<Recording> = None;

    for msg in rx {
        match msg {
            Msg::Packet { buf, t, beacon } => {
                let Some(r) = rec.as_mut() else { continue };
                // Arrived before the clip started.
                let Some(dt) = t.checked_duration_since(r.epoch) else {
                    continue;
                };
                let Ok((_, packet)) = rosc::decoder::decode_udp(&buf).map_err(|e| {
                    eprintln!("osc-tap: OSC parse error: {e}");
                }) else {
                    continue;
                };
                let ts = round6(dt.as_secs_f64());
                let tl = beacon.map(|(v, at)| round6(v + signed_secs_since(t, at)));
                let mut msgs = Vec::new();
                flatten(packet, &mut msgs);
                for m in msgs {
                    let mut line = serde_json::Map::new();
                    line.insert("t".into(), json!(ts));
                    if let Some(tl) = tl {
                        line.insert("tl".into(), json!(tl));
                    }
                    line.insert("port".into(), json!(listen_port));
                    line.insert("a".into(), json!(m.addr));
                    let args: Vec<Value> = m.args.iter().filter_map(arg_to_json).collect();
                    line.insert("args".into(), Value::Array(args));
                    if write_line(&mut r.file, &Value::Object(line)) {
                        r.events += 1;
                    }
                }
            }
            Msg::Start { reply } => {
                if rec.is_some() {
                    let _ = reply.send(Err("already recording".into()));
                    continue;
                }
                match start_recording(&outdir, listen_port, forward_addr) {
                    Ok(r) => {
                        let _ = reply.send(Ok(r.path.clone()));
                        rec = Some(r);
                    }
                    Err(e) => {
                        let _ = reply.send(Err(e.to_string()));
                    }
                }
            }
            Msg::Stop { reply } => match rec.take() {
                Some(mut r) => {
                    let t = round6(r.epoch.elapsed().as_secs_f64());
                    write_line(&mut r.file, &json!({"type": "session_end", "t": t}));
                    let _ = reply.send(Ok(()));
                }
                None => {
                    let _ = reply.send(Err("not recording".into()));
                }
            },
            Msg::Status { reply } => {
                let now = Instant::now();
                let (beacon_tl, beacon_age) = match *beacon.lock().unwrap() {
                    Some((v, at)) => {
                        let age = signed_secs_since(now, at);
                        (Some(round6(v + age)), Some(round6(age)))
                    }
                    None => (None, None),
                };
                let _ = reply.send(Status {
                    recording: rec.is_some(),
                    clip: rec.as_ref().map(|r| r.path.clone()),
                    events: rec.as_ref().map(|r| r.events).unwrap_or(0),
                    beacon_tl,
                    beacon_age,
                    dropped: dropped.load(Ordering::Relaxed),
                });
            }
        }
    }
}

fn start_recording(
    outdir: &std::path::Path,
    listen_port: u16,
    forward_addr: SocketAddr,
) -> Result<Recording> {
    let now = chrono::Local::now();
    let stamp = now.format("%Y%m%d-%H%M%S");
    let mut path = outdir.join(format!("clip-{stamp}.jsonl"));
    let mut i = 1;
    while path.exists() {
        path = outdir.join(format!("clip-{stamp}-{i}.jsonl"));
        i += 1;
    }
    let mut file = File::create_new(&path).with_context(|| format!("create {path:?}"))?;
    let header = json!({
        "type": "session_start",
        "t": 0.0,
        "wall": now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "host": forward_addr.ip().to_string(),
        "routes": [format!("{}->{}", listen_port, forward_addr.port())],
    });
    write_line(&mut file, &header);
    Ok(Recording {
        file,
        path,
        epoch: Instant::now(),
        events: 0,
    })
}

/// Write one JSON line and flush so a crash loses nothing.
fn write_line(file: &mut File, value: &Value) -> bool {
    let mut line = value.to_string();
    line.push('\n');
    match file.write_all(line.as_bytes()).and_then(|_| file.flush()) {
        Ok(()) => true,
        Err(e) => {
            eprintln!("osc-tap: write error: {e}");
            false
        }
    }
}

fn flatten(packet: OscPacket, out: &mut Vec<OscMessage>) {
    match packet {
        OscPacket::Message(m) => out.push(m),
        OscPacket::Bundle(b) => {
            for p in b.content {
                flatten(p, out);
            }
        }
    }
}

fn arg_to_json(arg: &OscType) -> Option<Value> {
    match arg {
        // Shortest f32 repr, reparsed as f64, so 0.42f32 logs as 0.42.
        OscType::Float(f) => Some(json!(f.to_string().parse::<f64>().unwrap_or(*f as f64))),
        OscType::Double(d) => Some(json!(d)),
        OscType::Int(i) => Some(json!(i)),
        OscType::Long(i) => Some(json!(i)),
        OscType::String(s) => Some(json!(s)),
        OscType::Bool(b) => Some(json!(b)),
        OscType::Color(c) => Some(json!(format!(
            "#{:02x}{:02x}{:02x}{:02x}",
            c.red, c.green, c.blue, c.alpha
        ))),
        OscType::Inf => Some(json!("<impulse>")),
        OscType::Nil => Some(Value::Null),
        OscType::Blob(b) => {
            eprintln!("osc-tap: warn: blob arg skipped ({} bytes)", b.len());
            None
        }
        other => {
            eprintln!("osc-tap: warn: unsupported arg {other:?}, stringified");
            Some(json!(format!("{other:?}")))
        }
    }
}

/// Bind a UDP socket, optionally enlarging the kernel receive buffer (best effort).
fn bind_udp(addr: SocketAddr, recv_buf: Option<usize>) -> Result<UdpSocket> {
    let domain = if addr.is_ipv4() {
        socket2::Domain::IPV4
    } else {
        socket2::Domain::IPV6
    };
    let socket = socket2::Socket::new(domain, socket2::Type::DGRAM, None)?;
    if let Some(bytes) = recv_buf {
        if let Err(e) = socket.set_recv_buffer_size(bytes) {
            eprintln!("osc-tap: warn: set_recv_buffer_size({bytes}) failed: {e}");
        }
    }
    socket.bind(&addr.into())?;
    Ok(socket.into())
}

fn round6(x: f64) -> f64 {
    (x * 1e6).round() / 1e6
}

fn signed_secs_since(t: Instant, since: Instant) -> f64 {
    match t.checked_duration_since(since) {
        Some(d) => d.as_secs_f64(),
        None => -since.duration_since(t).as_secs_f64(),
    }
}
