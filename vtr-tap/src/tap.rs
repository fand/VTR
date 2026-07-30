use std::collections::{HashMap, VecDeque};
use std::fs::File;
use std::io::Write as _;
use std::net::{IpAddr, SocketAddr, UdpSocket};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender, SyncSender, TrySendError};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use rosc::{OscMessage, OscPacket, OscType};
use serde::Serialize;
use serde_json::{json, Value};

use crate::config::Config;

const MAX_DATAGRAM: usize = 65_507;
/// Kernel receive buffer for the listen socket (best effort).
const RECV_BUF_BYTES: usize = 4 * 1024 * 1024;
/// Max packets queued to the writer before we drop (and count) instead of blocking.
/// Bounds packet COUNT, not bytes: worst case ~4 GB of heap at max datagram
/// size. Fine for a trusted LAN; don't shrink it without a real need.
const CHANNEL_CAP: usize = 65_536;
/// Control (`/vtr/*`) messages are low-rate (~10 Hz clock + rare rec/transport);
/// a small bound keeps a stalled control thread from hoarding memory.
const CTL_CHANNEL_CAP: usize = 256;
/// How often a still-active source IP is re-reported to the player. Must stay
/// well under the player's own origin expiry (3 min) so a live controller
/// never falls out of its registry.
const ORIGIN_REFRESH: Duration = Duration::from_secs(60);

/// Logs at most once per second; counts what it swallowed in between.
struct RateLimitedLog {
    last: Option<Instant>,
    suppressed: u64,
}

impl RateLimitedLog {
    fn new() -> Self {
        Self {
            last: None,
            suppressed: 0,
        }
    }

    fn log(&mut self, msg: &str) {
        let now = Instant::now();
        if self.last.is_none_or(|l| (now - l).as_secs_f64() >= 1.0) {
            if self.suppressed > 0 {
                eprintln!("vtr-tap: {msg} ({} similar suppressed)", self.suppressed);
            } else {
                eprintln!("vtr-tap: {msg}");
            }
            self.suppressed = 0;
            self.last = Some(now);
        } else {
            self.suppressed += 1;
        }
    }
}

/// Latest `/vtr/clock` beacon.
#[derive(Debug, Clone, Copy)]
pub struct Beacon {
    /// Master timeline seconds.
    pub t: f64,
    /// Timeline speed: 1.0 = playing, 0.0 = paused, negative = reverse.
    pub rate: f64,
    pub at: Instant,
}

impl Beacon {
    /// Extrapolate the timeline position to `now`.
    fn tl_at(&self, now: Instant) -> f64 {
        self.t + self.rate * signed_secs_since(now, self.at)
    }
}

type BeaconState = Arc<Mutex<Option<Beacon>>>;

/// Fire-and-forget rec-transition OSC to the TD tox (`--td-notify`). Plain,
/// unwrapped messages — not the `"v1 <origin>"` relay framing — so a TD
/// `oscin` DAT parses them natively.
struct Notify {
    sock: UdpSocket,
    addr: SocketAddr,
    log: RateLimitedLog,
}

impl Notify {
    fn send(&mut self, addr: &str, args: Vec<OscType>) {
        let packet = OscPacket::Message(OscMessage {
            addr: addr.into(),
            args,
        });
        match rosc::encoder::encode(&packet) {
            Ok(buf) => {
                if let Err(e) = self.sock.send_to(&buf, self.addr) {
                    self.log.log(&format!("td-notify send error: {e}"));
                }
            }
            Err(e) => self.log.log(&format!("td-notify encode error: {e}")),
        }
    }
}

/// Tells the player which hosts talk to us, so it can mirror playback back
/// to them (`origin IP : echo port`). The player only ever learns an origin
/// from a relayed `/vtr/*` datagram, so a controller with no `/vtr` button
/// would never get anything; this reports plain app senders too, as a
/// relay-framed `/vtr/origin`. Internal to the tap->player hop — controllers
/// never send it, and the player's relay drops the unknown address after
/// registering the origin.
struct OriginNotifier {
    seen: HashMap<IpAddr, Instant>,
    sock: UdpSocket,
    relay: SocketAddr,
    log: RateLimitedLog,
}

impl OriginNotifier {
    fn new(relay: SocketAddr) -> Result<Self> {
        Ok(Self {
            seen: HashMap::new(),
            sock: UdpSocket::bind("0.0.0.0:0").context("bind origin-notify socket")?,
            relay,
            log: RateLimitedLog::new(),
        })
    }

    /// Called for every inbound datagram: one lookup on the hot path, a
    /// send only when the IP is new or its last report aged out.
    fn note(&mut self, origin: SocketAddr, now: Instant) {
        let ip = origin.ip();
        if self
            .seen
            .get(&ip)
            .is_some_and(|last| now.duration_since(*last) < ORIGIN_REFRESH)
        {
            return;
        }
        self.seen.insert(ip, now);
        self.seen
            .retain(|_, last| now.duration_since(*last) < ORIGIN_REFRESH);
        self.send(origin);
    }

    fn send(&mut self, origin: SocketAddr) {
        let packet = OscPacket::Message(OscMessage {
            addr: "/vtr/origin".into(),
            args: vec![],
        });
        let Ok(payload) = rosc::encoder::encode(&packet) else {
            return;
        };
        let mut frame = format!("v1 {origin}\n").into_bytes();
        frame.extend_from_slice(&payload);
        if let Err(e) = self.sock.send_to(&frame, self.relay) {
            self.log.log(&format!("origin-notify send error: {e}"));
        }
    }
}

/// Recording transitions, in order. Local (control socket) and remote (OSC)
/// start/stops emit the same events.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "ev", rename_all = "snake_case")]
pub enum Event {
    RecStarted {
        clip: PathBuf,
        #[serde(skip_serializing_if = "Option::is_none")]
        tl: Option<f64>,
    },
    RecStopped {
        clip: PathBuf,
    },
}

/// Rec transitions are rare; 64 outlives any realistic wait gap.
const EVENT_LOG_CAP: usize = 64;

struct LogState {
    /// seq of the next event to be pushed; starts at 1, only grows.
    next_seq: u64,
    events: VecDeque<(u64, Event)>,
}

/// Ring buffer of `(seq, Event)` shared between the writer thread (push)
/// and control-socket wait threads (wait_since).
#[derive(Clone)]
pub struct EventLog {
    inner: Arc<(Mutex<LogState>, Condvar)>,
}

pub struct WaitResult {
    /// Newest seq the caller should wait from next.
    pub seq: u64,
    pub events: Vec<Event>,
    /// The caller's cursor is unusable (overflowed past or from another
    /// process); it must re-baseline from a status snapshot.
    pub reset: bool,
}

impl EventLog {
    fn new() -> Self {
        Self {
            inner: Arc::new((
                Mutex::new(LogState {
                    next_seq: 1,
                    events: VecDeque::new(),
                }),
                Condvar::new(),
            )),
        }
    }

    fn push(&self, event: Event) {
        let (lock, cvar) = &*self.inner;
        let mut st = lock.lock().unwrap();
        let seq = st.next_seq;
        st.next_seq += 1;
        st.events.push_back((seq, event));
        while st.events.len() > EVENT_LOG_CAP {
            st.events.pop_front();
        }
        cvar.notify_all();
    }

    /// Newest seq (0 when nothing was ever pushed).
    pub fn newest(&self) -> u64 {
        self.inner.0.lock().unwrap().next_seq - 1
    }

    /// Block until an event with seq > n exists, then return everything
    /// after n. Timeout returns empty events with the cursor unchanged.
    /// With buffered seqs oldest..=newest, serving needs n >= oldest-1;
    /// n < oldest-1 (overflow) or n > newest (other process) is a reset.
    pub fn wait_since(&self, n: u64, timeout: Duration) -> WaitResult {
        let (lock, cvar) = &*self.inner;
        let deadline = Instant::now() + timeout;
        let mut st = lock.lock().unwrap();
        loop {
            let newest = st.next_seq - 1;
            let lost = st.events.front().is_some_and(|&(oldest, _)| n + 1 < oldest);
            if n > newest || lost {
                return WaitResult {
                    seq: newest,
                    events: Vec::new(),
                    reset: true,
                };
            }
            if newest > n {
                return WaitResult {
                    seq: newest,
                    events: st
                        .events
                        .iter()
                        .filter(|(s, _)| *s > n)
                        .map(|(_, e)| e.clone())
                        .collect(),
                    reset: false,
                };
            }
            let now = Instant::now();
            if now >= deadline {
                return WaitResult {
                    seq: n,
                    events: Vec::new(),
                    reset: false,
                };
            }
            st = cvar.wait_timeout(st, deadline - now).unwrap().0;
        }
    }
}

pub struct Tap {
    pub listen_addr: SocketAddr,
    handle: Handle,
}

#[derive(Clone)]
pub struct Handle {
    tx: SyncSender<Msg>,
    log: EventLog,
}

enum Msg {
    Packet {
        buf: Vec<u8>,
        t: Instant,
        beacon: Option<Beacon>,
    },
    Start {
        /// Record into this directory instead of the default outdir.
        dir: Option<PathBuf>,
        /// Seed the beacon before starting so the clip header carries tl.
        tl: Option<f64>,
        rate: Option<f64>,
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
    /// Extrapolated master timeline seconds as of now.
    pub beacon_tl: Option<f64>,
    /// Seconds since the last beacon arrived.
    pub beacon_age: Option<f64>,
    /// Timeline speed from the last beacon.
    pub beacon_rate: Option<f64>,
    /// Packets dropped because the writer backlog was full. Reset per clip
    /// start so drops attribute to the current recording.
    pub dropped: u64,
    /// Packets received on the listen socket since process start, recording
    /// or not. `events` only moves while recording, so a live receive rate
    /// must be derived from deltas of this counter instead.
    pub received: u64,
    /// First write failure since the last clip start (latched).
    pub write_error: Option<String>,
    /// Write failures since the last clip start.
    pub write_errors: u64,
    /// Seconds since the current clip started.
    pub rec_t: Option<f64>,
    /// Most recently finished clip.
    pub last_clip: Option<PathBuf>,
}

impl Handle {
    pub fn start_clip(
        &self,
        dir: Option<PathBuf>,
        tl: Option<f64>,
        rate: Option<f64>,
    ) -> Result<PathBuf, String> {
        let (tx, rx) = mpsc::channel();
        self.tx
            .send(Msg::Start {
                dir,
                tl,
                rate,
                reply: tx,
            })
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

    pub fn event_log(&self) -> &EventLog {
        &self.log
    }
}

impl Tap {
    pub fn start(config: Config) -> Result<Tap> {
        let listen = bind_udp(config.listen, Some(RECV_BUF_BYTES))
            .with_context(|| format!("bind listen {}", config.listen))?;
        let forward = UdpSocket::bind("0.0.0.0:0").context("bind forward socket")?;
        forward
            .connect(config.forward)
            .with_context(|| format!("connect forward {}", config.forward))?;
        let relay_sock = UdpSocket::bind("0.0.0.0:0").context("bind relay socket")?;
        let notify = match config.td_notify {
            Some(addr) => Some(Notify {
                sock: UdpSocket::bind("0.0.0.0:0").context("bind td-notify socket")?,
                addr,
                log: RateLimitedLog::new(),
            }),
            None => None,
        };

        let listen_addr = listen.local_addr()?;
        std::fs::create_dir_all(&config.outdir)?;

        let beacon: BeaconState = Arc::new(Mutex::new(None));
        let dropped = Arc::new(AtomicU64::new(0));
        let received = Arc::new(AtomicU64::new(0));
        let event_log = EventLog::new();
        let (tx, rx) = mpsc::sync_channel::<Msg>(CHANNEL_CAP);
        let (ctl_tx, ctl_rx) = mpsc::sync_channel::<CtlPacket>(CTL_CHANNEL_CAP);

        // recv thread: stamp, forward raw, hand off to writer. `/vtr/*`
        // control datagrams go to the control thread instead — never to the
        // app, never to the writer. Decoding happens here only on a `/vtr/`
        // byte-scan hit, so a false positive is forwarded raw from the same
        // thread, in order; the hot path stays scan + forward + try_send.
        {
            let beacon = beacon.clone();
            let tx = tx.clone();
            let dropped = dropped.clone();
            let received = received.clone();
            let mut origins = OriginNotifier::new(config.relay)?;
            thread::Builder::new().name("recv".into()).spawn(move || {
                let mut buf = [0u8; MAX_DATAGRAM];
                // TD down turns every forward into an error (~120/s); throttle.
                let mut recv_log = RateLimitedLog::new();
                let mut fwd_log = RateLimitedLog::new();
                let mut ctl_log = RateLimitedLog::new();
                loop {
                    let (n, origin) = match listen.recv_from(&mut buf) {
                        Ok(r) => r,
                        Err(e) => {
                            recv_log.log(&format!("recv error: {e}"));
                            continue;
                        }
                    };
                    let t = Instant::now();
                    received.fetch_add(1, Ordering::Relaxed);
                    // Before the /vtr split: control datagrams register the
                    // origin on their own, but going through the same path
                    // costs one lookup a minute and keeps the branch out.
                    origins.note(origin, t);
                    if contains_vtr(&buf[..n]) {
                        if let Some(msgs) = decode_control(&buf[..n]) {
                            match ctl_tx.try_send(CtlPacket {
                                origin,
                                buf: buf[..n].to_vec(),
                                msgs,
                            }) {
                                Ok(()) => {}
                                Err(TrySendError::Full(_)) => {
                                    ctl_log.log("control backlog full, /vtr datagram dropped");
                                }
                                Err(TrySendError::Disconnected(_)) => break,
                            }
                            continue;
                        }
                        // False positive (`/vtr/` in a string arg, `/x/vtr/y`):
                        // app data, forwarded raw below.
                    }
                    if let Err(e) = forward.send(&buf[..n]) {
                        fwd_log.log(&format!("forward error: {e}"));
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
                                eprintln!("vtr-tap: writer backlog full, {d} packets dropped");
                            }
                        }
                        Err(TrySendError::Disconnected(_)) => break,
                    }
                }
            })?;
        }

        // control thread: dispatches `/vtr/*` (beacon update, rec start/stop)
        // and relays every control datagram to the player. Not inline in recv:
        // start_clip blocks on a writer round trip that opens the clip file —
        // that stall must not sit on the 120 Hz listen socket.
        {
            let beacon = beacon.clone();
            let handle = Handle {
                tx: tx.clone(),
                log: event_log.clone(),
            };
            let relay_addr = config.relay;
            thread::Builder::new().name("control".into()).spawn(move || {
                let mut arg_log = RateLimitedLog::new();
                let mut rec_log = RateLimitedLog::new();
                let mut unknown_log = RateLimitedLog::new();
                let mut mixed_log = RateLimitedLog::new();
                let mut clock_src_log = RateLimitedLog::new();
                let mut relay_log = RateLimitedLog::new();
                // Last /vtr/clock sender, for multi-sender arbitration warnings.
                let mut last_clock: Option<(SocketAddr, Instant)> = None;
                for pkt in ctl_rx {
                    // Relay first, fire-and-forget: a dead player is invisible.
                    let mut frame = format!("v1 {}\n", pkt.origin).into_bytes();
                    frame.extend_from_slice(&pkt.buf);
                    if let Err(e) = relay_sock.send_to(&frame, relay_addr) {
                        relay_log.log(&format!("relay send error: {e}"));
                    }
                    let now = Instant::now();
                    for m in &pkt.msgs {
                        match m.addr.as_str() {
                            "/vtr/clock" => {
                                // Silently dropping these left all clips without tl
                                // and no hint why; say what arrived instead.
                                let Some(t) = arg_as_f64(m.args.first()) else {
                                    arg_log.log(&format!(
                                        "warn: /vtr/clock arg not numeric ({:?}), beacon ignored",
                                        m.args.first()
                                    ));
                                    continue;
                                };
                                let rate = arg_as_f64(m.args.get(1)).unwrap_or(1.0);
                                // NaN/inf would serialize tl as null and poison
                                // every later extrapolation; drop the beacon.
                                if !t.is_finite() || !rate.is_finite() {
                                    continue;
                                }
                                // Last-write-wins across senders; warn when the
                                // source flips within a few seconds.
                                if let Some((src, at)) = last_clock {
                                    if src != pkt.origin && (now - at).as_secs_f64() < 3.0 {
                                        clock_src_log.log(&format!(
                                            "warn: /vtr/clock from multiple senders ({src}, {})",
                                            pkt.origin
                                        ));
                                    }
                                }
                                last_clock = Some((pkt.origin, now));
                                *beacon.lock().unwrap() = Some(Beacon { t, rate, at: now });
                            }
                            // Controller-facing toggle: no beacon seed.
                            "/vtr/rec" => {
                                match arg_as_f64(m.args.first()).filter(|v| v.is_finite()) {
                                    Some(v) if v != 0.0 => {
                                        match handle.start_clip(None, None, None) {
                                            Ok(path) => {
                                                eprintln!("vtr-tap: /vtr/rec 1 -> {path:?}")
                                            }
                                            // Idempotent: already recording is a no-op.
                                            Err(e) => rec_log
                                                .log(&format!("/vtr/rec 1 ignored: {e}")),
                                        }
                                    }
                                    Some(_) => match handle.stop_clip() {
                                        Ok(()) => eprintln!("vtr-tap: /vtr/rec 0"),
                                        // Idempotent: not recording is a no-op.
                                        Err(e) => {
                                            rec_log.log(&format!("/vtr/rec 0 ignored: {e}"))
                                        }
                                    },
                                    None => arg_log.log(&format!(
                                        "warn: /vtr/rec arg not numeric ({:?}), dropped",
                                        m.args.first()
                                    )),
                                }
                            }
                            "/vtr/rec/start" => {
                                // Optional [tl] [rate] seed the beacon (in the
                                // writer) so the clip starts with a correct tl.
                                // Bad args: ignore, still start.
                                let tl = arg_as_f64(m.args.first()).filter(|v| v.is_finite());
                                let rate = arg_as_f64(m.args.get(1)).filter(|v| v.is_finite());
                                match handle.start_clip(None, tl, rate) {
                                    Ok(path) => eprintln!("vtr-tap: /vtr/rec/start -> {path:?}"),
                                    // Idempotent: already recording is a no-op.
                                    Err(e) => {
                                        rec_log.log(&format!("/vtr/rec/start ignored: {e}"))
                                    }
                                }
                            }
                            "/vtr/rec/stop" => match handle.stop_clip() {
                                Ok(()) => eprintln!("vtr-tap: /vtr/rec/stop"),
                                // Idempotent: not recording is a no-op.
                                Err(e) => rec_log.log(&format!("/vtr/rec/stop ignored: {e}")),
                            },
                            // Player-handled addresses and unknowns: relay
                            // already happened.
                            a if a.starts_with("/vtr/") => {
                                if !matches!(
                                    a,
                                    "/vtr/play" | "/vtr/stop" | "/vtr/seek" | "/vtr/echo"
                                ) {
                                    unknown_log.log(&format!("warn: unknown {a} dropped"));
                                }
                            }
                            // Mixed bundle: a consumed datagram is never
                            // partially re-encoded and forwarded.
                            a => mixed_log.log(&format!(
                                "warn: non-/vtr message {a} in a control bundle dropped"
                            )),
                        }
                    }
                }
            })?;
        }

        // writer thread
        {
            let writer = Writer {
                outdir: config.outdir.clone(),
                listen_port: listen_addr.port(),
                forward_addr: config.forward,
                beacon: beacon.clone(),
                dropped: dropped.clone(),
                received: received.clone(),
                beacon_max_age_s: config.beacon_max_age_s,
                event_log: event_log.clone(),
                notify,
                rec: None,
                last_clip: None,
                write_error: None,
                write_errors: 0,
            };
            thread::Builder::new()
                .name("writer".into())
                .spawn(move || writer_loop(rx, writer))?;
        }

        Ok(Tap {
            listen_addr,
            handle: Handle { tx, log: event_log },
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

fn writer_loop(rx: mpsc::Receiver<Msg>, mut w: Writer) {
    for msg in rx {
        w.handle(msg);
    }
}

/// Writer-thread state, split out so unit tests can drive it directly.
struct Writer {
    outdir: PathBuf,
    listen_port: u16,
    forward_addr: SocketAddr,
    beacon: BeaconState,
    dropped: Arc<AtomicU64>,
    received: Arc<AtomicU64>,
    beacon_max_age_s: f64,
    event_log: EventLog,
    notify: Option<Notify>,
    rec: Option<Recording>,
    last_clip: Option<PathBuf>,
    /// First write failure since the last clip start; disk-full mid-show
    /// must show up in status, not only on stderr.
    write_error: Option<String>,
    write_errors: u64,
}

impl Writer {
    /// write_line + latch: the first failure since clip start is kept for
    /// status; every failure counts.
    fn write(&mut self, file: &mut File, value: &Value) {
        match write_line(file, value) {
            Ok(()) => {}
            Err(e) => {
                self.write_errors += 1;
                if self.write_error.is_none() {
                    self.write_error = Some(e);
                }
            }
        }
    }

    fn handle(&mut self, msg: Msg) {
        match msg {
            Msg::Packet { buf, t, beacon } => {
                let Some(mut rec) = self.rec.take() else { return };
                // Arrived before the clip started.
                let Some(dt) = t.checked_duration_since(rec.epoch) else {
                    self.rec = Some(rec);
                    return;
                };
                let Ok((_, packet)) = rosc::decoder::decode_udp(&buf).map_err(|e| {
                    eprintln!("vtr-tap: OSC parse error: {e}");
                }) else {
                    self.rec = Some(rec);
                    return;
                };
                let ts = round6(dt.as_secs_f64());
                // A beacon older than the cutoff means TD stopped talking
                // (quit, network); its extrapolation would be plausible but
                // wrong — omit tl per the "omit when unknown" contract. A
                // rate-0 pause keeps beaconing, so its age stays low.
                let tl = beacon
                    .filter(|b| signed_secs_since(t, b.at) <= self.beacon_max_age_s)
                    .map(|b| round6(b.tl_at(t)))
                    .filter(|v| v.is_finite());
                let mut msgs = Vec::new();
                flatten(packet, &mut msgs);
                for m in msgs {
                    let mut line = serde_json::Map::new();
                    line.insert("t".into(), json!(ts));
                    if let Some(tl) = tl {
                        line.insert("tl".into(), json!(tl));
                    }
                    line.insert("port".into(), json!(self.listen_port));
                    line.insert("a".into(), json!(m.addr));
                    let mut types = String::new();
                    let mut args: Vec<Value> = Vec::with_capacity(m.args.len());
                    for (tag, v) in m.args.iter().filter_map(arg_to_json_tagged) {
                        types.push(tag);
                        args.push(v);
                    }
                    line.insert("types".into(), json!(types));
                    line.insert("args".into(), Value::Array(args));
                    let before = self.write_errors;
                    self.write(&mut rec.file, &Value::Object(line));
                    if self.write_errors == before {
                        rec.events += 1;
                    }
                }
                self.rec = Some(rec);
            }
            Msg::Start {
                dir,
                tl: tl_seed,
                rate,
                reply,
            } => {
                let now = Instant::now();
                // Seed the beacon first (even on a redundant start) so the
                // clip starts with a correct tl — the official sync mechanism.
                if let Some(t) = tl_seed.filter(|v| v.is_finite()) {
                    let rate = rate.filter(|v| v.is_finite()).unwrap_or(1.0);
                    *self.beacon.lock().unwrap() = Some(Beacon { t, rate, at: now });
                }
                if self.rec.is_some() {
                    let _ = reply.send(Err("already recording".into()));
                    return;
                }
                // Timeline position at clip start, same age filter as packet
                // stamping; into the session_start header, the event, and the
                // TD notification (which also wants the beacon rate).
                let fresh = self
                    .beacon
                    .lock()
                    .unwrap()
                    .filter(|b| signed_secs_since(now, b.at) <= self.beacon_max_age_s);
                let tl = fresh.map(|b| round6(b.tl_at(now))).filter(|v| v.is_finite());
                let notify_rate = fresh.map(|b| b.rate).filter(|v| v.is_finite()).unwrap_or(1.0);
                match start_recording(
                    dir.as_deref().unwrap_or(&self.outdir),
                    self.listen_port,
                    self.forward_addr,
                    tl,
                ) {
                    Ok(r) => {
                        // Fresh counters: errors and drops attribute to THIS clip.
                        self.write_error = None;
                        self.write_errors = 0;
                        self.dropped.store(0, Ordering::Relaxed);
                        let _ = reply.send(Ok(r.path.clone()));
                        self.event_log.push(Event::RecStarted {
                            clip: r.path.clone(),
                            tl,
                        });
                        if let Some(n) = &mut self.notify {
                            // Args omitted when the clock is unknown: the tox
                            // then starts playback without seeking.
                            let args = match tl {
                                Some(tl) => {
                                    vec![OscType::Double(tl), OscType::Double(notify_rate)]
                                }
                                None => vec![],
                            };
                            n.send("/vtr/rec/start", args);
                        }
                        self.rec = Some(r);
                    }
                    Err(e) => {
                        let _ = reply.send(Err(e.to_string()));
                    }
                }
            }
            Msg::Stop { reply } => match self.rec.take() {
                Some(mut r) => {
                    let t = round6(r.epoch.elapsed().as_secs_f64());
                    // The per-clip counters reset on the next Start; the
                    // summary line is the only durable record that this
                    // clip lost data.
                    let mut s = serde_json::Map::new();
                    s.insert("type".into(), json!("summary"));
                    s.insert("t".into(), json!(t));
                    s.insert("events".into(), json!(r.events));
                    s.insert(
                        "dropped".into(),
                        json!(self.dropped.load(Ordering::Relaxed)),
                    );
                    s.insert("write_errors".into(), json!(self.write_errors));
                    if let Some(e) = &self.write_error {
                        s.insert("write_error".into(), json!(e));
                    }
                    self.write(&mut r.file, &Value::Object(s));
                    self.write(&mut r.file, &json!({"type": "session_end", "t": t}));
                    let _ = reply.send(Ok(()));
                    self.last_clip = Some(r.path.clone());
                    self.event_log.push(Event::RecStopped { clip: r.path });
                    if let Some(n) = &mut self.notify {
                        n.send("/vtr/rec/stop", vec![]);
                    }
                }
                None => {
                    let _ = reply.send(Err("not recording".into()));
                }
            },
            Msg::Status { reply } => {
                let now = Instant::now();
                let (beacon_tl, beacon_age, beacon_rate) = match *self.beacon.lock().unwrap() {
                    Some(b) => (
                        Some(round6(b.tl_at(now))),
                        Some(round6(signed_secs_since(now, b.at))),
                        Some(b.rate),
                    ),
                    None => (None, None, None),
                };
                let _ = reply.send(Status {
                    recording: self.rec.is_some(),
                    clip: self.rec.as_ref().map(|r| r.path.clone()),
                    events: self.rec.as_ref().map(|r| r.events).unwrap_or(0),
                    beacon_tl,
                    beacon_age,
                    beacon_rate,
                    dropped: self.dropped.load(Ordering::Relaxed),
                    received: self.received.load(Ordering::Relaxed),
                    write_error: self.write_error.clone(),
                    write_errors: self.write_errors,
                    rec_t: self
                        .rec
                        .as_ref()
                        .map(|r| round6(r.epoch.elapsed().as_secs_f64())),
                    last_clip: self.last_clip.clone(),
                });
            }
        }
    }
}

fn start_recording(
    outdir: &std::path::Path,
    listen_port: u16,
    forward_addr: SocketAddr,
    tl: Option<f64>,
) -> Result<Recording> {
    std::fs::create_dir_all(outdir).with_context(|| format!("create dir {outdir:?}"))?;
    let now = chrono::Local::now();
    let stamp = now.format("%Y%m%d-%H%M%S");
    let mut path = outdir.join(format!("clip-{stamp}.jsonl"));
    let mut i = 1;
    while path.exists() {
        path = outdir.join(format!("clip-{stamp}-{i}.jsonl"));
        i += 1;
    }
    let mut file = File::create_new(&path).with_context(|| format!("create {path:?}"))?;
    let mut header = json!({
        "type": "session_start",
        "t": 0.0,
        "wall": now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "host": forward_addr.ip().to_string(),
        "routes": [format!("{}->{}", listen_port, forward_addr.port())],
    });
    // Omit when unknown, like the per-event tl.
    if let Some(tl) = tl {
        header["tl"] = json!(tl);
    }
    // Header write failure surfaces on the first packet write instead.
    let _ = write_line(&mut file, &header);
    Ok(Recording {
        file,
        path,
        epoch: Instant::now(),
        events: 0,
    })
}

/// Write one JSON line and flush so a crash loses nothing.
fn write_line(file: &mut File, value: &Value) -> Result<(), String> {
    let mut line = value.to_string();
    line.push('\n');
    file.write_all(line.as_bytes())
        .and_then(|_| file.flush())
        .map_err(|e| {
            eprintln!("vtr-tap: write error: {e}");
            e.to_string()
        })
}

/// A `/vtr/*` datagram bound for the control thread, with its origin for
/// the player relay.
struct CtlPacket {
    origin: SocketAddr,
    buf: Vec<u8>,
    msgs: Vec<OscMessage>,
}

/// Cheap scan deciding whether a datagram might be control at all.
fn contains_vtr(buf: &[u8]) -> bool {
    buf.windows(5).any(|w| w == b"/vtr/")
}

/// A datagram is control iff it decodes to a message whose address starts
/// with `/vtr/`, or a bundle containing at least one such message. Returns
/// the flattened messages, or None for app data (including false positives:
/// `/vtr/` inside a string arg, addresses like `/x/vtr/y`).
fn decode_control(buf: &[u8]) -> Option<Vec<OscMessage>> {
    let (_, packet) = rosc::decoder::decode_udp(buf).ok()?;
    let mut msgs = Vec::new();
    flatten(packet, &mut msgs);
    msgs.iter()
        .any(|m| m.addr.starts_with("/vtr/"))
        .then_some(msgs)
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

/// int64s beyond ±2^53 don't survive a JS JSON.parse (f64 rounding).
const JS_SAFE_INT: u64 = 1 << 53;

/// JSON value plus its OSC type tag. `types` in the JSONL line is these tags
/// concatenated, so a skipped arg (blob) must skip its tag too.
fn arg_to_json_tagged(arg: &OscType) -> Option<(char, Value)> {
    match arg {
        // Shortest f32 repr, reparsed as f64, so 0.42f32 logs as 0.42.
        OscType::Float(f) => Some(('f', json!(f.to_string().parse::<f64>().unwrap_or(*f as f64)))),
        OscType::Double(d) => Some(('d', json!(d))),
        OscType::Int(i) => Some(('i', json!(i))),
        OscType::Long(i) if i.unsigned_abs() > JS_SAFE_INT => Some(('h', json!(i.to_string()))),
        OscType::Long(i) => Some(('h', json!(i))),
        OscType::String(s) => Some(('s', json!(s))),
        OscType::Bool(true) => Some(('T', json!(true))),
        OscType::Bool(false) => Some(('F', json!(false))),
        OscType::Color(c) => Some((
            'r',
            json!(format!(
                "#{:02x}{:02x}{:02x}{:02x}",
                c.red, c.green, c.blue, c.alpha
            )),
        )),
        OscType::Inf => Some(('I', json!("<impulse>"))),
        OscType::Nil => Some(('N', Value::Null)),
        OscType::Blob(b) => {
            eprintln!("vtr-tap: warn: blob arg skipped ({} bytes)", b.len());
            None
        }
        other => {
            eprintln!("vtr-tap: warn: unsupported arg {other:?}, stringified");
            Some(('s', json!(format!("{other:?}"))))
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
            eprintln!("vtr-tap: warn: set_recv_buffer_size({bytes}) failed: {e}");
        }
    }
    socket.bind(&addr.into())?;
    Ok(socket.into())
}

fn arg_as_f64(arg: Option<&OscType>) -> Option<f64> {
    match arg {
        Some(OscType::Float(f)) => Some(*f as f64),
        Some(OscType::Double(d)) => Some(*d),
        // Some senders beacon ints (e.g. a paused rate of 0); accept them.
        Some(OscType::Int(i)) => Some(*i as f64),
        Some(OscType::Long(i)) => Some(*i as f64),
        _ => None,
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    fn test_writer(outdir: &std::path::Path) -> Writer {
        Writer {
            outdir: outdir.to_path_buf(),
            listen_port: 1,
            forward_addr: "127.0.0.1:9".parse().unwrap(),
            beacon: Arc::new(Mutex::new(None)),
            dropped: Arc::new(AtomicU64::new(0)),
            received: Arc::new(AtomicU64::new(0)),
            beacon_max_age_s: 5.0,
            event_log: EventLog::new(),
            notify: None,
            rec: None,
            last_clip: None,
            write_error: None,
            write_errors: 0,
        }
    }

    fn status_of(w: &mut Writer) -> Status {
        let (tx, rx) = mpsc::channel();
        w.handle(Msg::Status { reply: tx });
        rx.recv().unwrap()
    }

    fn start_clip(w: &mut Writer) -> PathBuf {
        let (tx, rx) = mpsc::channel();
        w.handle(Msg::Start { dir: None, tl: None, rate: None, reply: tx });
        rx.recv().unwrap().unwrap()
    }

    fn packet_msg() -> Msg {
        let buf = rosc::encoder::encode(&OscPacket::Message(OscMessage {
            addr: "/x".into(),
            args: vec![OscType::Int(1)],
        }))
        .unwrap();
        Msg::Packet {
            buf,
            t: Instant::now(),
            beacon: None,
        }
    }

    #[test]
    fn write_failure_latches_into_status() {
        let tmp = tempfile::tempdir().unwrap();
        let mut w = test_writer(tmp.path());
        let path = start_clip(&mut w);
        // Swap in a read-only handle: every write now fails like a dead disk.
        w.rec.as_mut().unwrap().file = File::open(&path).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(2));

        w.handle(packet_msg());
        w.handle(packet_msg());
        let st = status_of(&mut w);
        assert!(st.recording);
        assert_eq!(st.events, 0, "failed writes must not count as events");
        assert_eq!(st.write_errors, 2);
        assert!(st.write_error.is_some(), "status must carry the error");

        // The latch survives stop (the operator sees it after the show).
        let (tx, rx) = mpsc::channel();
        w.handle(Msg::Stop { reply: tx });
        rx.recv().unwrap().unwrap();
        assert!(status_of(&mut w).write_error.is_some());
    }

    #[test]
    fn tags_cover_every_serialized_type() {
        let cases = [
            (OscType::Float(0.42), 'f', json!(0.42)),
            (OscType::Double(0.5), 'd', json!(0.5)),
            (OscType::Int(3), 'i', json!(3)),
            (OscType::Long(3), 'h', json!(3)),
            (OscType::String("hi".into()), 's', json!("hi")),
            (OscType::Bool(true), 'T', json!(true)),
            (OscType::Bool(false), 'F', json!(false)),
            (
                OscType::Color(rosc::OscColor {
                    red: 255,
                    green: 0,
                    blue: 16,
                    alpha: 32,
                }),
                'r',
                json!("#ff001020"),
            ),
            (OscType::Inf, 'I', json!("<impulse>")),
            (OscType::Nil, 'N', Value::Null),
        ];
        for (arg, tag, value) in cases {
            let (t, v) = arg_to_json_tagged(&arg).unwrap();
            assert_eq!((t, v), (tag, value), "arg {arg:?}");
        }
    }

    #[test]
    fn big_long_becomes_string_small_stays_number() {
        let big = (1i64 << 53) + 1;
        assert_eq!(
            arg_to_json_tagged(&OscType::Long(big)).unwrap(),
            ('h', json!(big.to_string()))
        );
        assert_eq!(
            arg_to_json_tagged(&OscType::Long(-big)).unwrap(),
            ('h', json!((-big).to_string()))
        );
        assert_eq!(
            arg_to_json_tagged(&OscType::Long(i64::MIN)).unwrap(),
            ('h', json!(i64::MIN.to_string()))
        );
        // Exactly ±2^53 is representable in f64: stays a number.
        assert_eq!(
            arg_to_json_tagged(&OscType::Long(1 << 53)).unwrap(),
            ('h', json!(1i64 << 53))
        );
    }

    #[test]
    fn blob_skips_value_and_tag() {
        assert!(arg_to_json_tagged(&OscType::Blob(vec![1, 2, 3])).is_none());
    }

    #[test]
    fn written_line_has_aligned_types_and_args() {
        let tmp = tempfile::tempdir().unwrap();
        let mut w = test_writer(tmp.path());
        let path = start_clip(&mut w);
        std::thread::sleep(std::time::Duration::from_millis(2));

        // Blob in the middle: its tag must vanish with its value.
        let buf = rosc::encoder::encode(&OscPacket::Message(OscMessage {
            addr: "/mixed".into(),
            args: vec![
                OscType::Float(1.5),
                OscType::Blob(vec![9]),
                OscType::Int(2),
            ],
        }))
        .unwrap();
        w.handle(Msg::Packet {
            buf,
            t: Instant::now(),
            beacon: None,
        });

        let (tx, rx) = mpsc::channel();
        w.handle(Msg::Stop { reply: tx });
        rx.recv().unwrap().unwrap();

        let text = std::fs::read_to_string(&path).unwrap();
        let line: Value = serde_json::from_str(
            text.lines()
                .find(|l| l.contains("/mixed"))
                .expect("event line"),
        )
        .unwrap();
        assert_eq!(line["types"], json!("fi"));
        assert_eq!(line["args"], json!([1.5, 2]));
    }

    fn stop_clip(w: &mut Writer) {
        let (tx, rx) = mpsc::channel();
        w.handle(Msg::Stop { reply: tx });
        rx.recv().unwrap().unwrap();
    }

    fn notify_receiver() -> (UdpSocket, Notify) {
        let rx = UdpSocket::bind("127.0.0.1:0").unwrap();
        rx.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
        let notify = Notify {
            sock: UdpSocket::bind("127.0.0.1:0").unwrap(),
            addr: rx.local_addr().unwrap(),
            log: RateLimitedLog::new(),
        };
        (rx, notify)
    }

    fn recv_osc(rx: &UdpSocket) -> OscMessage {
        let mut buf = [0u8; 1024];
        let n = rx.recv(&mut buf).unwrap();
        let (_, packet) = rosc::decoder::decode_udp(&buf[..n]).unwrap();
        match packet {
            OscPacket::Message(m) => m,
            p => panic!("expected message, got {p:?}"),
        }
    }

    #[test]
    fn notify_sends_rec_transitions_with_seeded_clock() {
        let tmp = tempfile::tempdir().unwrap();
        let mut w = test_writer(tmp.path());
        let (rx, notify) = notify_receiver();
        w.notify = Some(notify);

        let (tx, reply) = mpsc::channel();
        w.handle(Msg::Start {
            dir: None,
            tl: Some(42.5),
            rate: Some(2.0),
            reply: tx,
        });
        reply.recv().unwrap().unwrap();
        let m = recv_osc(&rx);
        assert_eq!(m.addr, "/vtr/rec/start");
        assert_eq!(m.args, vec![OscType::Double(42.5), OscType::Double(2.0)]);

        // Redundant start fails and must not notify: the next datagram on
        // the wire is the stop.
        let (tx, reply) = mpsc::channel();
        w.handle(Msg::Start {
            dir: None,
            tl: None,
            rate: None,
            reply: tx,
        });
        assert!(reply.recv().unwrap().is_err());

        stop_clip(&mut w);
        let m = recv_osc(&rx);
        assert_eq!(m.addr, "/vtr/rec/stop");
        assert!(m.args.is_empty());
    }

    #[test]
    fn notify_omits_args_without_clock() {
        let tmp = tempfile::tempdir().unwrap();
        let mut w = test_writer(tmp.path());
        let (rx, notify) = notify_receiver();
        w.notify = Some(notify);

        start_clip(&mut w);
        let m = recv_osc(&rx);
        assert_eq!(m.addr, "/vtr/rec/start");
        assert!(m.args.is_empty(), "unknown clock must omit args");
    }

    #[test]
    fn event_log_serves_after_cursor() {
        let log = EventLog::new();
        for i in 0..3 {
            log.push(Event::RecStopped {
                clip: PathBuf::from(format!("{i}.jsonl")),
            });
        }
        let r = log.wait_since(0, Duration::ZERO);
        assert!(!r.reset);
        assert_eq!(r.seq, 3);
        assert_eq!(r.events.len(), 3);

        let r = log.wait_since(2, Duration::ZERO);
        assert_eq!(r.events.len(), 1);
        assert_eq!(r.seq, 3);
    }

    #[test]
    fn event_log_timeout_keeps_cursor() {
        let log = EventLog::new();
        log.push(Event::RecStopped { clip: "a".into() });
        let r = log.wait_since(1, Duration::from_millis(5));
        assert!(!r.reset);
        assert_eq!(r.seq, 1);
        assert!(r.events.is_empty());
    }

    #[test]
    fn event_log_overflow_resets() {
        let log = EventLog::new();
        for _ in 0..(EVENT_LOG_CAP as u64 + 5) {
            log.push(Event::RecStopped { clip: "a".into() });
        }
        // Cursor 0 predates the buffer: events were lost.
        let r = log.wait_since(0, Duration::ZERO);
        assert!(r.reset);
        assert_eq!(r.seq, EVENT_LOG_CAP as u64 + 5);
        assert!(r.events.is_empty());
        // Oldest still-served cursor.
        let r = log.wait_since(5, Duration::ZERO);
        assert!(!r.reset);
        assert_eq!(r.events.len(), EVENT_LOG_CAP);
    }

    #[test]
    fn event_log_cursor_ahead_resets() {
        // A cursor from a previous process: newest here is 0.
        let log = EventLog::new();
        let r = log.wait_since(7, Duration::ZERO);
        assert!(r.reset);
        assert_eq!(r.seq, 0);
    }

    #[test]
    fn event_log_push_wakes_blocked_wait() {
        let log = EventLog::new();
        let waiter = {
            let log = log.clone();
            std::thread::spawn(move || log.wait_since(0, Duration::from_secs(5)))
        };
        std::thread::sleep(std::time::Duration::from_millis(20));
        log.push(Event::RecStarted {
            clip: "a".into(),
            tl: Some(1.5),
        });
        let r = waiter.join().unwrap();
        assert!(!r.reset);
        assert_eq!(r.seq, 1);
        assert_eq!(r.events.len(), 1);
    }

    #[test]
    fn event_serialization_shape() {
        let started = serde_json::to_value(Event::RecStarted {
            clip: "a.jsonl".into(),
            tl: Some(42.0),
        })
        .unwrap();
        assert_eq!(
            started,
            json!({"ev": "rec_started", "clip": "a.jsonl", "tl": 42.0})
        );
        let no_tl = serde_json::to_value(Event::RecStarted {
            clip: "a.jsonl".into(),
            tl: None,
        })
        .unwrap();
        assert_eq!(no_tl, json!({"ev": "rec_started", "clip": "a.jsonl"}));
        let stopped = serde_json::to_value(Event::RecStopped { clip: "a.jsonl".into() }).unwrap();
        assert_eq!(stopped, json!({"ev": "rec_stopped", "clip": "a.jsonl"}));
    }

    #[test]
    fn start_stop_emit_events_and_status_fields() {
        let tmp = tempfile::tempdir().unwrap();
        let mut w = test_writer(tmp.path());
        assert_eq!(status_of(&mut w).rec_t, None);

        let path = start_clip(&mut w);
        std::thread::sleep(std::time::Duration::from_millis(2));
        let st = status_of(&mut w);
        assert!(st.rec_t.is_some_and(|t| t > 0.0));
        assert_eq!(st.last_clip, None);

        stop_clip(&mut w);
        let st = status_of(&mut w);
        assert_eq!(st.rec_t, None);
        assert_eq!(st.last_clip, Some(path.clone()));

        let r = w.event_log.wait_since(0, Duration::ZERO);
        assert_eq!(r.seq, 2);
        let json = serde_json::to_value(&r.events).unwrap();
        assert_eq!(json[0]["ev"], "rec_started");
        assert_eq!(json[1]["ev"], "rec_stopped");
        assert_eq!(json[1]["clip"], json!(path));

        // Failed start (already recording) must not emit an event.
        start_clip(&mut w);
        let (tx, rx) = mpsc::channel();
        w.handle(Msg::Start { dir: None, tl: None, rate: None, reply: tx });
        assert!(rx.recv().unwrap().is_err());
        assert_eq!(w.event_log.newest(), 3);
    }

    #[test]
    fn start_stamps_tl_into_header_and_event() {
        let tmp = tempfile::tempdir().unwrap();
        let mut w = test_writer(tmp.path());
        *w.beacon.lock().unwrap() = Some(Beacon {
            t: 42.0,
            rate: 0.0,
            at: Instant::now(),
        });
        let path = start_clip(&mut w);

        let text = std::fs::read_to_string(&path).unwrap();
        let header: Value = serde_json::from_str(text.lines().next().unwrap()).unwrap();
        assert_eq!(header["type"], "session_start");
        assert_eq!(header["tl"], json!(42.0));

        let r = w.event_log.wait_since(0, Duration::ZERO);
        let ev = serde_json::to_value(&r.events[0]).unwrap();
        assert_eq!(ev["tl"], json!(42.0));

        // Stale beacon: tl omitted, like per-event stamping.
        stop_clip(&mut w);
        w.beacon_max_age_s = -1.0;
        let path = start_clip(&mut w);
        let text = std::fs::read_to_string(&path).unwrap();
        let header: Value = serde_json::from_str(text.lines().next().unwrap()).unwrap();
        assert!(header.get("tl").is_none());
    }

    #[test]
    fn stop_writes_summary_before_session_end() {
        let tmp = tempfile::tempdir().unwrap();
        let mut w = test_writer(tmp.path());
        let path = start_clip(&mut w);
        std::thread::sleep(std::time::Duration::from_millis(2));
        w.handle(packet_msg());
        w.dropped.store(3, Ordering::Relaxed);

        let (tx, rx) = mpsc::channel();
        w.handle(Msg::Stop { reply: tx });
        rx.recv().unwrap().unwrap();

        let text = std::fs::read_to_string(&path).unwrap();
        let lines: Vec<Value> = text
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        let summary = &lines[lines.len() - 2];
        assert_eq!(summary["type"], json!("summary"));
        assert_eq!(summary["events"], json!(1));
        assert_eq!(summary["dropped"], json!(3));
        assert_eq!(summary["write_errors"], json!(0));
        assert!(
            summary.get("write_error").is_none(),
            "clean clip must omit write_error"
        );
        assert_eq!(lines.last().unwrap()["type"], json!("session_end"));
    }

    #[test]
    fn summary_carries_write_error() {
        let tmp = tempfile::tempdir().unwrap();
        let mut w = test_writer(tmp.path());
        let path = start_clip(&mut w);
        // Fail one packet write on a read-only handle, then restore the
        // real handle so the summary itself can be written.
        let good = std::mem::replace(
            &mut w.rec.as_mut().unwrap().file,
            File::open(&path).unwrap(),
        );
        w.handle(packet_msg());
        w.rec.as_mut().unwrap().file = good;

        let (tx, rx) = mpsc::channel();
        w.handle(Msg::Stop { reply: tx });
        rx.recv().unwrap().unwrap();

        let text = std::fs::read_to_string(&path).unwrap();
        let summary: Value = serde_json::from_str(
            text.lines()
                .find(|l| l.contains("\"summary\""))
                .expect("summary line"),
        )
        .unwrap();
        assert_eq!(summary["write_errors"], json!(1));
        assert!(summary["write_error"].as_str().is_some());
        assert_eq!(summary["events"], json!(0));
    }

    #[test]
    fn counters_reset_per_clip_start() {
        let tmp = tempfile::tempdir().unwrap();
        let mut w = test_writer(tmp.path());
        w.write_error = Some("old".into());
        w.write_errors = 7;
        w.dropped.store(9, Ordering::Relaxed);

        start_clip(&mut w);
        let st = status_of(&mut w);
        assert_eq!(st.write_error, None);
        assert_eq!(st.write_errors, 0);
        assert_eq!(st.dropped, 0, "drops attribute to the current recording");
    }
}
