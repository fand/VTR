use std::fs::File;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use serde::Serialize;
use serde_json::{json, Value};

use vtr_core::{flatten, osc_json, RateLimitedLog};

use crate::config::Config;

use super::beacon::{signed_secs_since, Beacon, BeaconState};
use super::eventlog::{Event, EventLog};
use super::jsonl::{round6, write_line};
use super::MonitorLog;

/// Decode for the monitor only while a consumer actually polls. Above the
/// editor's 30s long-poll cadence, so an attached editor never flaps.
const MONITOR_ACTIVE: Duration = Duration::from_secs(60);

/// Max packets queued to the writer before we drop (and count) instead of
/// blocking. Bounds packet COUNT, not bytes: worst case ~4 GB of heap at max
/// datagram size. Fine for a trusted LAN; don't shrink it without a real need.
pub(super) const CHANNEL_CAP: usize = 65_536;

pub(super) enum Msg {
    Packet {
        buf: Vec<u8>,
        t: Instant,
        /// Sender, for the monitor stream (recordings don't keep it).
        origin: SocketAddr,
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

struct Recording {
    file: File,
    path: PathBuf,
    epoch: Instant,
    events: u64,
}

pub(super) fn writer_loop(rx: mpsc::Receiver<Msg>, mut w: Writer) {
    for msg in rx {
        w.handle(msg);
    }
}

/// Writer-thread state, split out so unit tests can drive it directly.
pub(super) struct Writer {
    outdir: PathBuf,
    listen_port: u16,
    forward_addr: SocketAddr,
    beacon: BeaconState,
    dropped: Arc<AtomicU64>,
    received: Arc<AtomicU64>,
    beacon_max_age_s: f64,
    event_log: EventLog,
    monitor: MonitorLog,
    rec: Option<Recording>,
    last_clip: Option<PathBuf>,
    /// First write failure since the last clip start; disk-full mid-show
    /// must show up in status, not only on stderr.
    write_error: Option<String>,
    write_errors: u64,
    /// Per-packet error paths, throttled: stderr is a pipe to the editor
    /// and writes serialize across threads.
    parse_log: RateLimitedLog,
    arg_log: RateLimitedLog,
    write_log: RateLimitedLog,
}

impl Writer {
    pub(super) fn new(
        config: &Config,
        listen_port: u16,
        beacon: BeaconState,
        dropped: Arc<AtomicU64>,
        received: Arc<AtomicU64>,
        event_log: EventLog,
        monitor: MonitorLog,
    ) -> Self {
        Self {
            outdir: config.outdir.clone(),
            listen_port,
            forward_addr: config.forward,
            beacon,
            dropped,
            received,
            beacon_max_age_s: config.beacon_max_age_s,
            event_log,
            monitor,
            rec: None,
            last_clip: None,
            write_error: None,
            write_errors: 0,
            parse_log: RateLimitedLog::new("vtr-tap"),
            arg_log: RateLimitedLog::new("vtr-tap"),
            write_log: RateLimitedLog::new("vtr-tap"),
        }
    }

    /// write_line + latch: the first failure since clip start is kept for
    /// status; every failure counts.
    fn write(&mut self, file: &mut File, value: &Value) {
        match write_line(file, value) {
            Ok(()) => {}
            Err(e) => {
                self.write_log.log(&format!("write error: {e}"));
                self.write_errors += 1;
                if self.write_error.is_none() {
                    self.write_error = Some(e);
                }
            }
        }
    }

    fn handle(&mut self, msg: Msg) {
        match msg {
            Msg::Packet {
                buf,
                t,
                origin,
                beacon,
            } => {
                let mut rec = self.rec.take();
                let monitoring = self.monitor.polled_within(MONITOR_ACTIVE);
                // Clip-relative seconds; None while idle or for a packet
                // that arrived before the clip started.
                let rec_ts = rec
                    .as_ref()
                    .and_then(|r| t.checked_duration_since(r.epoch))
                    .map(|dt| round6(dt.as_secs_f64()));
                // Nobody listening: skip the decode entirely.
                if rec_ts.is_none() && !monitoring {
                    self.rec = rec;
                    return;
                }
                // Rate-limited: a controller streaming malformed OSC at
                // 120 Hz must not turn the writer thread into a stderr pump.
                let packet = match rosc::decoder::decode_udp(&buf) {
                    Ok((_, p)) => p,
                    Err(e) => {
                        self.parse_log.log(&format!("OSC parse error: {e}"));
                        self.rec = rec;
                        return;
                    }
                };
                // A beacon older than the cutoff means TD stopped talking
                // (quit, network); its extrapolation would be plausible but
                // wrong — omit tl per the "omit when unknown" contract. A
                // rate-0 pause keeps beaconing, so its age stays low.
                let tl = beacon
                    .filter(|b| signed_secs_since(t, b.at) <= self.beacon_max_age_s)
                    .map(|b| round6(b.tl_at(t)))
                    .filter(|v| v.is_finite());
                let wall = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0);
                let mut msgs = Vec::new();
                flatten(packet, &mut msgs);
                for m in msgs {
                    let mut types = String::new();
                    let mut args: Vec<Value> = Vec::with_capacity(m.args.len());
                    for (tag, v) in m
                        .args
                        .iter()
                        .filter_map(|a| osc_json::to_json(a, &mut self.arg_log))
                    {
                        types.push(tag);
                        args.push(v);
                    }
                    if let (Some(ts), Some(rec)) = (rec_ts, rec.as_mut()) {
                        let mut line = serde_json::Map::new();
                        line.insert("t".into(), json!(ts));
                        if let Some(tl) = tl {
                            line.insert("tl".into(), json!(tl));
                        }
                        line.insert("port".into(), json!(self.listen_port));
                        line.insert("a".into(), json!(m.addr.clone()));
                        line.insert("types".into(), json!(types.clone()));
                        line.insert("args".into(), Value::Array(args.clone()));
                        let before = self.write_errors;
                        self.write(&mut rec.file, &Value::Object(line));
                        if self.write_errors == before {
                            rec.events += 1;
                        }
                    }
                    if monitoring {
                        let mut line = serde_json::Map::new();
                        line.insert("wall".into(), json!(wall));
                        if let Some(tl) = tl {
                            line.insert("tl".into(), json!(tl));
                        }
                        line.insert("port".into(), json!(self.listen_port));
                        line.insert("a".into(), json!(m.addr));
                        line.insert("types".into(), json!(types));
                        line.insert("args".into(), Value::Array(args));
                        line.insert("from".into(), json!(origin.to_string()));
                        self.monitor.push(Value::Object(line));
                    }
                }
                self.rec = rec;
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
                // stamping; into the session_start header and the event.
                let tl = self
                    .beacon
                    .lock()
                    .unwrap()
                    .filter(|b| signed_secs_since(now, b.at) <= self.beacon_max_age_s)
                    .map(|b| round6(b.tl_at(now)))
                    .filter(|v| v.is_finite());
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
    outdir: &Path,
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

#[cfg(test)]
mod tests {
    use super::*;
    use rosc::{OscMessage, OscPacket, OscType};
    use std::sync::mpsc;
    use std::sync::Mutex;
    use std::time::Duration;

    fn test_writer(outdir: &Path) -> Writer {
        let config = Config {
            listen: "127.0.0.1:0".parse().unwrap(),
            forward: "127.0.0.1:9".parse().unwrap(),
            relay: "127.0.0.1:9".parse().unwrap(),
            outdir: outdir.to_path_buf(),
            beacon_max_age_s: 5.0,
        };
        Writer::new(
            &config,
            1,
            Arc::new(Mutex::new(None)),
            Arc::new(AtomicU64::new(0)),
            Arc::new(AtomicU64::new(0)),
            EventLog::new(super::super::eventlog::EVENT_LOG_CAP),
            MonitorLog::new(super::super::eventlog::MONITOR_LOG_CAP),
        )
    }

    fn status_of(w: &mut Writer) -> Status {
        let (tx, rx) = mpsc::channel();
        w.handle(Msg::Status { reply: tx });
        rx.recv().unwrap()
    }

    fn start_clip(w: &mut Writer) -> PathBuf {
        let (tx, rx) = mpsc::channel();
        w.handle(Msg::Start {
            dir: None,
            tl: None,
            rate: None,
            reply: tx,
        });
        rx.recv().unwrap().unwrap()
    }

    fn stop_clip(w: &mut Writer) {
        let (tx, rx) = mpsc::channel();
        w.handle(Msg::Stop { reply: tx });
        rx.recv().unwrap().unwrap();
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
            origin: "127.0.0.1:9000".parse().unwrap(),
            beacon: None,
        }
    }

    #[test]
    fn monitor_gets_lines_only_while_polled() {
        let tmp = tempfile::tempdir().unwrap();
        let mut w = test_writer(tmp.path());

        // Idle and never polled: the packet is not even decoded.
        w.handle(packet_msg());
        assert_eq!(w.monitor.newest(), 0);

        // A poll arms the monitor; the next packet lands as a line.
        w.monitor.wait_since(0, Duration::ZERO);
        w.handle(packet_msg());
        let r = w.monitor.wait_since(0, Duration::ZERO);
        assert_eq!(r.events.len(), 1);
        let line = &r.events[0];
        assert_eq!(line["a"], serde_json::json!("/x"));
        assert_eq!(line["types"], serde_json::json!("i"));
        assert_eq!(line["args"], serde_json::json!([1]));
        assert_eq!(line["from"], serde_json::json!("127.0.0.1:9000"));
        assert!(line["wall"].as_u64().is_some_and(|v| v > 0));
    }

    #[test]
    fn monitor_and_recording_both_see_a_packet() {
        let tmp = tempfile::tempdir().unwrap();
        let mut w = test_writer(tmp.path());
        let path = start_clip(&mut w);
        std::thread::sleep(std::time::Duration::from_millis(2));
        w.monitor.wait_since(0, Duration::ZERO);

        w.handle(packet_msg());
        assert_eq!(status_of(&mut w).events, 1, "recording still counts");
        assert_eq!(w.monitor.newest(), 1);

        stop_clip(&mut w);
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.lines().any(|l| l.contains("\"/x\"")));
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
            origin: "127.0.0.1:9000".parse().unwrap(),
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
        w.handle(Msg::Start {
            dir: None,
            tl: None,
            rate: None,
            reply: tx,
        });
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
