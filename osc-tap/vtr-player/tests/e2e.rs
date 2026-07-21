//! End-to-end tests: temp session.jsonl + fake app UDP socket + fake
//! controller socket + real unix control socket, mirroring the tap's
//! harness.

use std::io::{BufRead, BufReader, Write};
use std::net::UdpSocket;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use vtr_player::{control, start, Player, PlayerConfig};

struct Harness {
    player: Player,
    /// Fake VJ app on the routed forward port.
    app: UdpSocket,
    app_port: u16,
    /// Fake controller; its port is the player's echo port.
    controller: UdpSocket,
    /// Sender socket faking the tap's relay.
    tap: UdpSocket,
    control_path: PathBuf,
}

fn start_player(dir: &Path, tap_control: Option<PathBuf>) -> Harness {
    let app = UdpSocket::bind("127.0.0.1:0").unwrap();
    app.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
    let controller = UdpSocket::bind("127.0.0.1:0").unwrap();
    controller
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    let player = start(PlayerConfig {
        relay: "127.0.0.1:0".parse().unwrap(),
        echo_port: controller.local_addr().unwrap().port(),
        tap_control,
        emit_host: "127.0.0.1".parse().unwrap(),
    })
    .unwrap();
    let control_path = dir.join("vtr-player.sock");
    {
        let ctx = player.ctx.clone();
        let path = control_path.clone();
        thread::spawn(move || control::serve(&path, ctx));
    }
    let app_port = app.local_addr().unwrap().port();
    Harness {
        player,
        app,
        app_port,
        controller,
        tap: UdpSocket::bind("127.0.0.1:0").unwrap(),
        control_path,
    }
}

impl Harness {
    fn connect(&self) -> Conn {
        let deadline = Instant::now() + Duration::from_secs(2);
        let stream = loop {
            match UnixStream::connect(&self.control_path) {
                Ok(s) => break s,
                Err(_) => {
                    assert!(Instant::now() < deadline, "control socket not up");
                    thread::sleep(Duration::from_millis(10));
                }
            }
        };
        Conn {
            reader: BufReader::new(stream.try_clone().unwrap()),
            writer: stream,
        }
    }

    /// Send a tap-wrapped relay frame from the given origin.
    fn relay(&self, origin: &str, addr: &str, args: Vec<rosc::OscType>) {
        let osc = rosc::encoder::encode(&rosc::OscPacket::Message(rosc::OscMessage {
            addr: addr.to_string(),
            args,
        }))
        .unwrap();
        let mut frame = format!("v1 {origin}\n").into_bytes();
        frame.extend_from_slice(&osc);
        self.tap.send_to(&frame, self.player.relay_addr).unwrap();
    }

    fn recv_app(&self) -> (String, Vec<rosc::OscType>) {
        let mut buf = [0u8; 65_507];
        let n = self.app.recv(&mut buf).unwrap();
        let (_, packet) = rosc::decoder::decode_udp(&buf[..n]).unwrap();
        match packet {
            rosc::OscPacket::Message(m) => (m.addr, m.args),
            other => panic!("expected message, got {other:?}"),
        }
    }

    fn recv_controller(&self) -> (String, Vec<rosc::OscType>) {
        let mut buf = [0u8; 1024];
        let n = self.controller.recv(&mut buf).unwrap();
        let (_, packet) = rosc::decoder::decode_udp(&buf[..n]).unwrap();
        match packet {
            rosc::OscPacket::Message(m) => (m.addr, m.args),
            other => panic!("expected message, got {other:?}"),
        }
    }
}

struct Conn {
    reader: BufReader<UnixStream>,
    writer: UnixStream,
}

impl Conn {
    fn request(&mut self, req: Value) -> Value {
        writeln!(self.writer, "{req}").unwrap();
        let mut line = String::new();
        self.reader.read_line(&mut line).unwrap();
        serde_json::from_str(&line).unwrap()
    }
}

fn ev(t: f64, a: &str, args: &[f64]) -> Value {
    json!({"t": t, "port": 10010, "a": a, "types": "f".repeat(args.len()), "args": args})
}

fn write_session(dir: &Path, app_port: u16, events: &[Value]) -> PathBuf {
    let path = dir.join("session.jsonl");
    let mut lines = vec![json!({
        "type": "session_start", "t": 0.0,
        "routes": [format!("10010->{app_port}")],
    })];
    lines.extend_from_slice(events);
    lines.push(json!({"type": "session_end", "t": 60.0}));
    let text: Vec<String> = lines.iter().map(|l| l.to_string()).collect();
    std::fs::write(&path, text.join("\n") + "\n").unwrap();
    path
}

fn f(v: f64) -> rosc::OscType {
    rosc::OscType::Float(v as f32)
}

fn float_of(args: &[rosc::OscType]) -> f64 {
    match args[0] {
        rosc::OscType::Float(v) => v as f64,
        ref other => panic!("expected float, got {other:?}"),
    }
}

#[test]
fn load_replies_with_session_facts() {
    let tmp = tempfile::tempdir().unwrap();
    let h = start_player(tmp.path(), None);
    let path = write_session(
        tmp.path(),
        h.app_port,
        &[ev(1.0, "/a", &[1.0]), ev(2.0, "/b", &[2.0])],
    );
    let mut c = h.connect();
    let resp = c.request(json!({"cmd": "load", "path": path, "id": 1}));
    assert_eq!(resp["ok"], true, "resp = {resp}");
    assert_eq!(resp["id"], 1);
    assert_eq!(resp["duration"], 60.0);
    assert_eq!(resp["events"], 2);
    assert_eq!(resp["addresses"], 2);
    assert_eq!(resp["skipped"], 0);
    assert_eq!(resp["routes"]["10010"], h.app_port);
}

#[test]
fn push_play_emits_events_in_order() {
    let tmp = tempfile::tempdir().unwrap();
    let h = start_player(tmp.path(), None);
    let path = write_session(
        tmp.path(),
        h.app_port,
        &[
            ev(0.05, "/a", &[1.0]),
            ev(0.10, "/a", &[2.0]),
            ev(0.15, "/a", &[3.0]),
        ],
    );
    let mut c = h.connect();
    assert_eq!(c.request(json!({"cmd": "load", "path": path}))["ok"], true);

    h.relay("192.0.2.1:9000", "/vtr/play", vec![]);
    for want in [1.0, 2.0, 3.0] {
        let (addr, args) = h.recv_app();
        assert_eq!(addr, "/a");
        assert_eq!(float_of(&args), want);
    }

    let resp = c.request(json!({"cmd": "status"}));
    assert_eq!(resp["status"]["playing"], true);
    assert!(resp["status"]["playhead"].as_f64().unwrap() > 0.1);

    h.relay("192.0.2.1:9000", "/vtr/stop", vec![]);
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        let resp = c.request(json!({"cmd": "status"}));
        if resp["status"]["playing"] == false {
            break;
        }
        assert!(Instant::now() < deadline, "transport did not stop");
        thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn seek_emits_coalesced_catchup_and_drops_stale_seeks() {
    let tmp = tempfile::tempdir().unwrap();
    let h = start_player(tmp.path(), None);
    // /a carries its own time as value at every integer second.
    let events: Vec<Value> = (1..=50).map(|i| ev(i as f64, "/a", &[i as f64])).collect();
    let path = write_session(tmp.path(), h.app_port, &events);
    let mut c = h.connect();
    assert_eq!(c.request(json!({"cmd": "load", "path": path}))["ok"], true);

    // Burst of seeks; only the newest pending one may be resolved per tick.
    for i in 1..=50 {
        h.relay("192.0.2.1:9000", "/vtr/seek", vec![f(i as f64)]);
    }
    // The final state must reflect the last seek.
    let deadline = Instant::now() + Duration::from_secs(2);
    let mut got: Vec<f64> = Vec::new();
    loop {
        let (addr, args) = h.recv_app();
        assert_eq!(addr, "/a");
        got.push(float_of(&args));
        if *got.last().unwrap() == 50.0 {
            break;
        }
        assert!(Instant::now() < deadline, "final seek never applied: {got:?}");
    }
    assert!(
        got.len() < 50,
        "a 50-seek burst must coalesce, got {} emissions",
        got.len()
    );
}

#[test]
fn punch_in_primes_resolved_state() {
    let tmp = tempfile::tempdir().unwrap();
    let h = start_player(tmp.path(), None);
    let path = write_session(
        tmp.path(),
        h.app_port,
        &[
            ev(1.0, "/a", &[1.0]),
            ev(2.0, "/a", &[2.0]),
            ev(10.0, "/a", &[10.0]),
        ],
    );
    let mut c = h.connect();
    assert_eq!(c.request(json!({"cmd": "load", "path": path}))["ok"], true);

    // Relayed /vtr/rec/start 3.0: emit the state at 3.0 to the app.
    h.relay("192.0.2.1:9000", "/vtr/rec/start", vec![f(3.0)]);
    let (addr, args) = h.recv_app();
    assert_eq!(addr, "/a");
    assert_eq!(float_of(&args), 2.0);
}

#[test]
fn echo_follows_tap_event_log_and_greets_new_origins() {
    let tmp = tempfile::tempdir().unwrap();
    // Fake tap control socket serving the wait API.
    let tap_sock = tmp.path().join("osc-tap.sock");
    let (trigger_tx, trigger_rx) = mpsc::channel::<Value>();
    {
        let listener = UnixListener::bind(&tap_sock).unwrap();
        thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut writer = stream;
            let mut line = String::new();
            // Baseline wait (no since): recording=false snapshot.
            reader.read_line(&mut line).unwrap();
            writeln!(
                writer,
                "{}",
                json!({"ok": true, "seq": 0, "events": [], "reset": true,
                       "status": {"recording": false}})
            )
            .unwrap();
            // Long-poll waits: answer with whatever the test injects.
            loop {
                line.clear();
                if reader.read_line(&mut line).unwrap() == 0 {
                    return;
                }
                let Ok(reply) = trigger_rx.recv() else { return };
                writeln!(writer, "{reply}").unwrap();
            }
        });
    }

    let h = start_player(tmp.path(), Some(tap_sock));
    // Give the tap client a moment to take the baseline.
    thread::sleep(Duration::from_millis(100));

    // First contact from a new origin: immediate /vtr/rec 0 echo.
    h.relay("127.0.0.1:9001", "/vtr/clock", vec![f(1.0)]);
    let (addr, args) = h.recv_controller();
    assert_eq!(addr, "/vtr/rec");
    assert_eq!(float_of(&args), 0.0);

    // rec_started in the tap event log -> /vtr/rec 1 to the origin.
    trigger_tx
        .send(json!({"ok": true, "seq": 1,
                     "events": [{"ev": "rec_started", "clip": "x.jsonl"}]}))
        .unwrap();
    let (addr, args) = h.recv_controller();
    assert_eq!(addr, "/vtr/rec");
    assert_eq!(float_of(&args), 1.0);

    // rec_stopped -> /vtr/rec 0.
    trigger_tx
        .send(json!({"ok": true, "seq": 2,
                     "events": [{"ev": "rec_stopped", "clip": "x.jsonl"}]}))
        .unwrap();
    let (addr, args) = h.recv_controller();
    assert_eq!(addr, "/vtr/rec");
    assert_eq!(float_of(&args), 0.0);
}

#[test]
fn resolve_returns_per_connection_deltas_with_dedup() {
    let tmp = tempfile::tempdir().unwrap();
    let h = start_player(tmp.path(), None);
    let path = write_session(
        tmp.path(),
        h.app_port,
        &[
            ev(1.0, "/a", &[1.0]),
            ev(5.0, "/a", &[1.0]), // same value again
            ev(5.2, "/b", &[2.0]),
        ],
    );
    let mut c1 = h.connect();
    let mut c2 = h.connect();
    assert_eq!(c1.request(json!({"cmd": "load", "path": path}))["ok"], true);

    // First resolve per connection: full catch-up (seek).
    let r = c1.request(json!({"cmd": "resolve", "t": 5.1}));
    assert_eq!(r["mode"], "seek");
    assert_eq!(r["events"], json!([[10010, "/a", [1.0]]]));

    // Continuous forward: pump.
    let r = c1.request(json!({"cmd": "resolve", "t": 5.3}));
    assert_eq!(r["mode"], "pump");
    assert_eq!(r["events"], json!([[10010, "/b", [2.0]]]));

    // Jump back across the 5.0 event: catch-up would re-send [1.0] but
    // dedup suppresses the identical value.
    let r = c1.request(json!({"cmd": "resolve", "t": 2.0}));
    assert_eq!(r["mode"], "seek");
    assert_eq!(r["events"], json!([]));

    // The other connection has its own state: full catch-up.
    let r = c2.request(json!({"cmd": "resolve", "t": 5.3}));
    assert_eq!(r["mode"], "seek");
    assert_eq!(
        r["events"],
        json!([[10010, "/a", [1.0]], [10010, "/b", [2.0]]])
    );
}

#[test]
fn load_swaps_session_and_resets_connections() {
    let tmp = tempfile::tempdir().unwrap();
    let h = start_player(tmp.path(), None);
    let path = write_session(tmp.path(), h.app_port, &[ev(1.0, "/a", &[1.0])]);
    let mut c = h.connect();
    assert_eq!(c.request(json!({"cmd": "load", "path": path}))["ok"], true);
    assert_eq!(
        c.request(json!({"cmd": "resolve", "t": 2.0}))["events"],
        json!([[10010, "/a", [1.0]]])
    );
    // Reload: dedup state must not survive — next resolve is a full catch-up.
    assert_eq!(c.request(json!({"cmd": "load", "path": path}))["ok"], true);
    let r = c.request(json!({"cmd": "resolve", "t": 2.0}));
    assert_eq!(r["mode"], "seek");
    assert_eq!(r["events"], json!([[10010, "/a", [1.0]]]));

    let resp = c.request(json!({"cmd": "status"}));
    assert_eq!(resp["status"]["playing"], false);
    assert_eq!(resp["status"]["playhead"], 0.0);
    assert!(resp["status"]["loaded"].as_str().is_some());
}

#[test]
fn unrouted_ports_are_never_emitted() {
    let tmp = tempfile::tempdir().unwrap();
    let h = start_player(tmp.path(), None);
    // One event on the routed port, one on a port with no route (e.g. a
    // listen port that must never receive replays).
    let path = write_session(
        tmp.path(),
        h.app_port,
        &[
            json!({"t": 0.05, "port": 20000, "a": "/unrouted", "types": "f", "args": [9.0]}),
            ev(0.10, "/a", &[1.0]),
        ],
    );
    let mut c = h.connect();
    assert_eq!(c.request(json!({"cmd": "load", "path": path}))["ok"], true);
    h.relay("192.0.2.1:9000", "/vtr/play", vec![]);
    let (addr, _) = h.recv_app();
    assert_eq!(addr, "/a", "only the routed event reaches the app");
}

#[test]
fn resolve_without_session_errors() {
    let tmp = tempfile::tempdir().unwrap();
    let h = start_player(tmp.path(), None);
    let mut c = h.connect();
    let r = c.request(json!({"cmd": "resolve", "t": 1.0}));
    assert_eq!(r["ok"], false);
    let r = c.request(json!({"cmd": "nope"}));
    assert_eq!(r["ok"], false);
}

#[test]
fn inline_load_replies_with_session_facts() {
    let tmp = tempfile::tempdir().unwrap();
    let h = start_player(tmp.path(), None);
    let mut c = h.connect();
    let resp = c.request(json!({
        "cmd": "load",
        "events": [ev(1.0, "/a", &[1.0]), ev(2.0, "/b", &[2.0])],
        "duration": 30.0,
        "name": "(editor)",
    }));
    assert_eq!(resp["ok"], true, "resp = {resp}");
    assert_eq!(resp["duration"], 30.0);
    assert_eq!(resp["events"], 2);
    assert_eq!(resp["addresses"], 2);
    assert_eq!(resp["skipped"], 0);
    // No routes: the push transport stays silent for inline sessions.
    assert_eq!(resp["routes"], json!({}));

    let st = c.request(json!({"cmd": "status"}));
    assert_eq!(st["status"]["loaded"], "(editor)");

    // The inline session resolves like a file-loaded one.
    let r = c.request(json!({"cmd": "resolve", "t": 1.5}));
    assert_eq!(r["ok"], true, "resp = {r}");
    assert_eq!(r["events"], json!([[10010, "/a", [1.0]]]));
}

#[test]
fn transport_cmds_drive_playhead_and_follow_resolve() {
    let tmp = tempfile::tempdir().unwrap();
    let h = start_player(tmp.path(), None);
    let mut c = h.connect();
    let resp = c.request(json!({
        "cmd": "load",
        "events": [ev(0.05, "/a", &[1.0]), ev(0.10, "/a", &[2.0]), ev(5.0, "/a", &[3.0])],
        "duration": 60.0,
    }));
    assert_eq!(resp["ok"], true, "resp = {resp}");

    // seek goes through the emit loop's mailbox; poll until it lands.
    assert_eq!(c.request(json!({"cmd": "seek", "t": 2.0}))["ok"], true);
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        let head = c.request(json!({"cmd": "status"}))["status"]["playhead"]
            .as_f64()
            .unwrap();
        if (head - 2.0).abs() < 0.01 {
            break;
        }
        assert!(Instant::now() < deadline, "seek never landed (head {head})");
        thread::sleep(Duration::from_millis(10));
    }

    // follow: resolve at the transport playhead, catch-up to the seek.
    let r = c.request(json!({"cmd": "resolve", "follow": true}));
    assert_eq!(r["ok"], true, "resp = {r}");
    assert!((r["t"].as_f64().unwrap() - 2.0).abs() < 0.2, "t = {}", r["t"]);
    assert_eq!(r["playing"], false);
    assert_eq!(r["events"], json!([[10010, "/a", [2.0]]]));

    // play advances the playhead; stop freezes it.
    let r = c.request(json!({"cmd": "play"}));
    assert_eq!(r["playing"], true);
    thread::sleep(Duration::from_millis(50));
    let r = c.request(json!({"cmd": "resolve", "follow": true}));
    assert!(r["t"].as_f64().unwrap() > 2.0, "t = {}", r["t"]);

    let r = c.request(json!({"cmd": "stop"}));
    assert_eq!(r["playing"], false);
    let frozen = r["playhead"].as_f64().unwrap();
    thread::sleep(Duration::from_millis(30));
    let r = c.request(json!({"cmd": "resolve", "follow": true}));
    assert!((r["t"].as_f64().unwrap() - frozen).abs() < 1e-6);
}
