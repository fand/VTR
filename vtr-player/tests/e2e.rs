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

use serde_json::{Value, json};
use vtr_player::{Player, PlayerConfig, control, start};

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
    start_player_with(dir, tap_control, None)
}

fn start_player_with(
    dir: &Path,
    tap_control: Option<PathBuf>,
    echo_host: Option<std::net::IpAddr>,
) -> Harness {
    let app = UdpSocket::bind("127.0.0.1:0").unwrap();
    app.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
    let controller = UdpSocket::bind("127.0.0.1:0").unwrap();
    controller
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    let player = start(PlayerConfig {
        relay: "127.0.0.1:0".parse().unwrap(),
        echo_port: controller.local_addr().unwrap().port(),
        echo_host,
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

    /// Next controller message with this address; other control feedback
    /// (greetings) in between is skipped. The read timeout still bounds the
    /// wait, so a missing message fails the test.
    fn recv_controller_msg(&self, want: &str) -> Vec<rosc::OscType> {
        loop {
            let (addr, args) = self.recv_controller();
            if addr == want {
                return args;
            }
        }
    }
}

struct Conn {
    reader: BufReader<UnixStream>,
    writer: UnixStream,
}

impl Conn {
    fn request(&mut self, req: Value) -> Value {
        self.send(req);
        self.read_reply()
    }

    fn send(&mut self, req: Value) {
        writeln!(self.writer, "{req}").unwrap();
    }

    fn read_reply(&mut self) -> Value {
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
    // Initial seek extends /a's first value before t=0.05; the pump then
    // re-sends it when it crosses the event (full fidelity, no dedup).
    for want in [1.0, 1.0, 2.0, 3.0] {
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
        assert!(
            Instant::now() < deadline,
            "final seek never applied: {got:?}"
        );
    }
    assert!(
        got.len() < 50,
        "a 50-seek burst must coalesce, got {} emissions",
        got.len()
    );
}

/// Poll `status` until the predicate holds, or fail after 2s. The tap client
/// runs on its own long-poll thread, so nothing it does lands at a fixed
/// delay.
fn wait_status(c: &mut Conn, what: &str, pred: impl Fn(&Value) -> bool) -> Value {
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        let s = c.request(json!({"cmd": "status"}))["status"].clone();
        if pred(&s) {
            return s;
        }
        assert!(Instant::now() < deadline, "{what}: status = {s}");
        thread::sleep(Duration::from_millis(10));
    }
}

/// Fake tap control socket serving the `wait` API: answers the baseline with
/// `recording=false`, then replies to each long poll with whatever the test
/// pushes into the returned sender.
fn fake_tap(path: &Path) -> mpsc::Sender<Value> {
    let (trigger_tx, trigger_rx) = mpsc::channel::<Value>();
    let listener = UnixListener::bind(path).unwrap();
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
    trigger_tx
}

fn rec_started(seq: u64, tl: Option<f64>) -> Value {
    let mut event = json!({"ev": "rec_started", "clip": "x.jsonl"});
    if let Some(tl) = tl {
        event["tl"] = json!(tl);
    }
    json!({"ok": true, "seq": seq, "events": [event]})
}

/// Punch-in: rec start in the tap event log primes the transport to the
/// take's timeline position and starts it, so followers land on the punch-in
/// point and the session plays as backing.
#[test]
fn punch_in_primes_and_plays_on_rec_started() {
    let tmp = tempfile::tempdir().unwrap();
    let tap_sock = tmp.path().join("vtr-tap.sock");
    let trigger_tx = fake_tap(&tap_sock);
    let h = start_player(tmp.path(), Some(tap_sock));
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
    let gen0 = c.request(json!({"cmd": "status"}))["status"]["gen"]
        .as_u64()
        .unwrap();

    trigger_tx.send(rec_started(1, Some(3.0))).unwrap();

    // The app gets the state resolved at 3.0.
    let (addr, args) = h.recv_app();
    assert_eq!(addr, "/a");
    assert_eq!(float_of(&args), 2.0);

    let s = wait_status(&mut c, "punch-in should play", |s| s["playing"] == true);
    assert_eq!(s["origin"], "rec");
    assert!(s["gen"].as_u64().unwrap() > gen0, "status = {s}");
    // At tl, plus whatever has elapsed since it started running.
    let head = s["playhead"].as_f64().unwrap();
    assert!((3.0..4.0).contains(&head), "playhead = {head}");
}

/// No `tl` (no clock beacon): start where we are rather than guess.
#[test]
fn punch_in_without_tl_plays_without_seeking() {
    let tmp = tempfile::tempdir().unwrap();
    let tap_sock = tmp.path().join("vtr-tap.sock");
    let trigger_tx = fake_tap(&tap_sock);
    let h = start_player(tmp.path(), Some(tap_sock));
    let path = write_session(tmp.path(), h.app_port, &[ev(1.0, "/a", &[1.0])]);
    let mut c = h.connect();
    assert_eq!(c.request(json!({"cmd": "load", "path": path}))["ok"], true);
    assert_eq!(
        c.request(json!({"cmd": "seek", "t": 5.0, "origin": "editor"}))["ok"],
        true
    );
    // Without a tl there is no priming, so the play is an ordinary foreign
    // write: let the editor's hold expire or it would be rejected.
    thread::sleep(Duration::from_millis(500));

    trigger_tx.send(rec_started(1, None)).unwrap();

    let s = wait_status(&mut c, "punch-in should play", |s| s["playing"] == true);
    let head = s["playhead"].as_f64().unwrap();
    assert!((5.0..6.0).contains(&head), "playhead = {head}");
}

/// Nothing to resolve without a session, so nothing moves.
#[test]
fn punch_in_does_nothing_without_a_session() {
    let tmp = tempfile::tempdir().unwrap();
    let tap_sock = tmp.path().join("vtr-tap.sock");
    let trigger_tx = fake_tap(&tap_sock);
    let h = start_player(tmp.path(), Some(tap_sock));
    let mut c = h.connect();
    // The rec LED is the handshake: once it flips, the event is processed.
    h.relay("127.0.0.1:9001", "/vtr/origin", vec![]);
    assert_eq!(float_of(&h.recv_controller_msg("/vtr/rec")), 0.0);

    trigger_tx.send(rec_started(1, Some(3.0))).unwrap();
    assert_eq!(float_of(&h.recv_controller_msg("/vtr/rec")), 1.0);

    let s = c.request(json!({"cmd": "status"}))["status"].clone();
    assert_eq!(s["playing"], false);
    assert_eq!(s["playhead"], 0.0);
    assert_eq!(s["gen"], 0);
}

/// Stopping a take leaves the transport running, like `/vtr/rec/stop`.
#[test]
fn rec_stopped_leaves_the_transport_alone() {
    let tmp = tempfile::tempdir().unwrap();
    let tap_sock = tmp.path().join("vtr-tap.sock");
    let trigger_tx = fake_tap(&tap_sock);
    let h = start_player(tmp.path(), Some(tap_sock));
    let path = write_session(tmp.path(), h.app_port, &[ev(1.0, "/a", &[1.0])]);
    let mut c = h.connect();
    assert_eq!(c.request(json!({"cmd": "load", "path": path}))["ok"], true);
    h.relay("127.0.0.1:9001", "/vtr/origin", vec![]);
    assert_eq!(float_of(&h.recv_controller_msg("/vtr/rec")), 0.0);

    trigger_tx.send(rec_started(1, Some(3.0))).unwrap();
    assert_eq!(float_of(&h.recv_controller_msg("/vtr/rec")), 1.0);
    let running = wait_status(&mut c, "punch-in should play", |s| s["playing"] == true);

    trigger_tx
        .send(json!({"ok": true, "seq": 2,
                     "events": [{"ev": "rec_stopped", "clip": "x.jsonl"}]}))
        .unwrap();
    assert_eq!(float_of(&h.recv_controller_msg("/vtr/rec")), 0.0);

    let s = c.request(json!({"cmd": "status"}))["status"].clone();
    assert_eq!(s["playing"], true);
    assert_eq!(s["gen"], running["gen"]);
    assert_eq!(s["origin"], "rec");
}

#[test]
fn echo_follows_tap_event_log_and_greets_new_origins() {
    let tmp = tempfile::tempdir().unwrap();
    let tap_sock = tmp.path().join("vtr-tap.sock");
    let trigger_tx = fake_tap(&tap_sock);

    let h = start_player(tmp.path(), Some(tap_sock));
    // Give the tap client a moment to take the baseline.
    thread::sleep(Duration::from_millis(100));

    // First contact from a new origin: an immediate greeting with the
    // whole control state, /vtr/rec 0 then /vtr/echo 1.
    h.relay("127.0.0.1:9001", "/vtr/clock", vec![f(1.0)]);
    let (addr, args) = h.recv_controller();
    assert_eq!(addr, "/vtr/rec");
    assert_eq!(float_of(&args), 0.0);
    let (addr, args) = h.recv_controller();
    assert_eq!(addr, "/vtr/echo");
    assert_eq!(float_of(&args), 1.0);

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
fn playback_mirrors_to_an_origin_that_never_sent_a_vtr_command() {
    let tmp = tempfile::tempdir().unwrap();
    let h = start_player(tmp.path(), None);
    let path = write_session(tmp.path(), h.app_port, &[ev(1.0, "/fader", &[0.75])]);
    let mut c = h.connect();
    assert_eq!(c.request(json!({"cmd": "load", "path": path}))["ok"], true);

    // The tap's stand-in for plain app traffic: this origin has no /vtr
    // button, and registering it is all the mirror needs.
    h.relay("127.0.0.1:9001", "/vtr/origin", vec![]);
    assert_eq!(c.request(json!({"cmd": "seek", "t": 2.0}))["ok"], true);

    assert_eq!(float_of(&h.recv_controller_msg("/fader")), 0.75);
}

#[test]
fn mirror_is_silent_while_recording() {
    let tmp = tempfile::tempdir().unwrap();
    let tap_sock = tmp.path().join("vtr-tap.sock");
    let trigger_tx = fake_tap(&tap_sock);
    let h = start_player(tmp.path(), Some(tap_sock));
    // Two values, so the seek after rec stops isn't swallowed by dedup.
    let path = write_session(
        tmp.path(),
        h.app_port,
        &[ev(1.0, "/fader", &[0.75]), ev(2.5, "/fader", &[0.25])],
    );
    let mut c = h.connect();
    assert_eq!(c.request(json!({"cmd": "load", "path": path}))["ok"], true);
    thread::sleep(Duration::from_millis(100));

    // Registering greets the origin with the baseline control state.
    h.relay("127.0.0.1:9001", "/vtr/origin", vec![]);
    assert_eq!(float_of(&h.recv_controller_msg("/vtr/rec")), 0.0);

    // Recording: mirroring the replay back would feed it into the clip.
    // The punch-in primes the transport to 2.0 and runs it from there.
    trigger_tx.send(rec_started(1, Some(2.0))).unwrap();
    assert_eq!(float_of(&h.recv_controller_msg("/vtr/rec")), 1.0);
    // The app still gets it; the controller does not.
    assert_eq!(h.recv_app().0, "/fader");
    h.controller
        .set_read_timeout(Some(Duration::from_millis(200)))
        .unwrap();
    let mut buf = [0u8; 1024];
    assert!(h.controller.recv(&mut buf).is_err(), "mirrored while rec");

    // Stopped again: the mirror comes back. The seek is from "rec" because
    // the punch-in holds the transport for a moment.
    trigger_tx
        .send(json!({"ok": true, "seq": 2,
                     "events": [{"ev": "rec_stopped", "clip": "x.jsonl"}]}))
        .unwrap();
    h.controller
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    assert_eq!(float_of(&h.recv_controller_msg("/vtr/rec")), 0.0);
    assert_eq!(
        c.request(json!({"cmd": "seek", "t": 3.0, "origin": "rec"}))["ok"],
        true
    );
    assert_eq!(float_of(&h.recv_controller_msg("/fader")), 0.25);
}

#[test]
fn mirror_waits_for_the_tap_baseline() {
    let tmp = tempfile::tempdir().unwrap();
    let tap_sock = tmp.path().join("vtr-tap.sock");
    // Tap not up yet: rec state is unknown — a recording could already be
    // running, so the mirror must stay silent until the baseline arrives.
    let h = start_player(tmp.path(), Some(tap_sock.clone()));
    let path = write_session(
        tmp.path(),
        h.app_port,
        &[ev(1.0, "/fader", &[0.75]), ev(2.5, "/fader", &[0.25])],
    );
    let mut c = h.connect();
    assert_eq!(c.request(json!({"cmd": "load", "path": path}))["ok"], true);
    h.relay("127.0.0.1:9001", "/vtr/origin", vec![]);
    // Greeting carries /vtr/echo only: there is no rec baseline to send.
    let (addr, _) = h.recv_controller();
    assert_eq!(addr, "/vtr/echo");
    assert_eq!(c.request(json!({"cmd": "seek", "t": 2.0}))["ok"], true);
    // The app still gets the values; the controller does not.
    assert_eq!(h.recv_app().0, "/fader");
    h.controller
        .set_read_timeout(Some(Duration::from_millis(200)))
        .unwrap();
    let mut buf = [0u8; 1024];
    assert!(h.controller.recv(&mut buf).is_err(), "mirrored before baseline");

    // The tap comes up and reports recording=false: the mirror opens.
    let _tap = fake_tap(&tap_sock);
    h.controller
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    assert_eq!(float_of(&h.recv_controller_msg("/vtr/rec")), 0.0);
    assert_eq!(c.request(json!({"cmd": "seek", "t": 3.0}))["ok"], true);
    assert_eq!(float_of(&h.recv_controller_msg("/fader")), 0.25);
}

#[test]
fn vtr_echo_toggles_the_mirror_and_confirms_to_targets() {
    let tmp = tempfile::tempdir().unwrap();
    let h = start_player(tmp.path(), None);
    let path = write_session(
        tmp.path(),
        h.app_port,
        &[ev(1.0, "/fader", &[0.75]), ev(2.5, "/fader", &[0.25])],
    );
    let mut c = h.connect();
    assert_eq!(c.request(json!({"cmd": "load", "path": path}))["ok"], true);

    // Off. The first contact greets with the pre-toggle state (1), then the
    // toggle is confirmed (0) — the button ends up right either way.
    h.relay("127.0.0.1:9001", "/vtr/echo", vec![f(0.0)]);
    assert_eq!(float_of(&h.recv_controller_msg("/vtr/echo")), 1.0);
    assert_eq!(float_of(&h.recv_controller_msg("/vtr/echo")), 0.0);
    assert_eq!(c.request(json!({"cmd": "seek", "t": 2.0}))["ok"], true);
    // The app is not affected by the toggle.
    assert_eq!(h.recv_app().0, "/fader");
    h.controller
        .set_read_timeout(Some(Duration::from_millis(200)))
        .unwrap();
    let mut buf = [0u8; 1024];
    assert!(h.controller.recv(&mut buf).is_err(), "mirrored while off");

    // On again: confirmed, and the resync mirrors the playhead value the
    // controller missed while it was off.
    h.controller
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    h.relay("127.0.0.1:9001", "/vtr/echo", vec![f(1.0)]);
    assert_eq!(float_of(&h.recv_controller_msg("/vtr/echo")), 1.0);
    assert_eq!(float_of(&h.recv_controller_msg("/fader")), 0.75);
    // And live mirroring resumes.
    assert_eq!(c.request(json!({"cmd": "seek", "t": 3.0}))["ok"], true);
    assert_eq!(float_of(&h.recv_controller_msg("/fader")), 0.25);
}

#[test]
fn vtr_echo_on_resyncs_every_address_without_touching_the_app() {
    let tmp = tempfile::tempdir().unwrap();
    let h = start_player(tmp.path(), None);
    let path = write_session(
        tmp.path(),
        h.app_port,
        &[
            ev(1.0, "/a", &[0.25]),
            ev(2.0, "/b", &[0.5]),
            ev(3.0, "/a", &[0.75]),
        ],
    );
    let mut c = h.connect();
    assert_eq!(c.request(json!({"cmd": "load", "path": path}))["ok"], true);
    h.relay("127.0.0.1:9001", "/vtr/origin", vec![]);
    assert_eq!(c.request(json!({"cmd": "seek", "t": 4.0}))["ok"], true);

    // Flush order is unordered per flush: collect both addresses.
    let recv_pair = || {
        let (mut a, mut b) = (None, None);
        while a.is_none() || b.is_none() {
            let (addr, args) = h.recv_controller();
            match addr.as_str() {
                "/a" => a = Some(float_of(&args)),
                "/b" => b = Some(float_of(&args)),
                _ => {}
            }
        }
        (a.unwrap(), b.unwrap())
    };
    assert_eq!(recv_pair(), (0.75, 0.5));
    // Drain the seek's app emissions so the quiet check below is real.
    h.recv_app();
    h.recv_app();

    // The mirror is on and up to date, so this toggles nothing — but the
    // full state still goes out once (a manual sync request).
    h.relay("127.0.0.1:9001", "/vtr/echo", vec![f(1.0)]);
    assert_eq!(recv_pair(), (0.75, 0.5));
    // The app stream is untouched: nothing is re-sent there.
    h.app.set_read_timeout(Some(Duration::from_millis(200))).unwrap();
    let mut buf = [0u8; 1024];
    assert!(h.app.recv(&mut buf).is_err(), "resync leaked to the app");
}

#[test]
fn a_pinned_echo_host_is_fed_without_ever_being_heard_from() {
    let tmp = tempfile::tempdir().unwrap();
    // Nothing ever reaches the relay in this test: the pinned host is the
    // only reason anything goes out.
    let h = start_player_with(tmp.path(), None, Some("127.0.0.1".parse().unwrap()));
    let path = write_session(tmp.path(), h.app_port, &[ev(1.0, "/fader", &[0.75])]);
    let mut c = h.connect();
    assert_eq!(c.request(json!({"cmd": "load", "path": path}))["ok"], true);
    assert_eq!(c.request(json!({"cmd": "seek", "t": 2.0}))["ok"], true);

    let (addr, args) = h.recv_controller();
    assert_eq!(addr, "/fader");
    assert_eq!(float_of(&args), 0.75);
}

#[test]
fn a_pinned_host_is_not_fed_twice_when_it_also_registers() {
    let tmp = tempfile::tempdir().unwrap();
    let h = start_player_with(tmp.path(), None, Some("127.0.0.1".parse().unwrap()));
    let path = write_session(tmp.path(), h.app_port, &[ev(1.0, "/fader", &[0.75])]);
    let mut c = h.connect();
    assert_eq!(c.request(json!({"cmd": "load", "path": path}))["ok"], true);
    // Same IP arrives on the relay too: it must not double up.
    h.relay("127.0.0.1:9001", "/vtr/origin", vec![]);
    assert_eq!(c.request(json!({"cmd": "seek", "t": 2.0}))["ok"], true);

    h.recv_controller_msg("/fader");
    h.controller
        .set_read_timeout(Some(Duration::from_millis(200)))
        .unwrap();
    let mut buf = [0u8; 1024];
    assert!(h.controller.recv(&mut buf).is_err(), "sent twice");
}

#[test]
fn mirror_coalesces_a_dense_stream() {
    let tmp = tempfile::tempdir().unwrap();
    let h = start_player(tmp.path(), None);
    // ~120 Hz on one address, the rate a controller actually records at.
    let events: Vec<Value> = (0..120)
        .map(|i| ev(0.05 + i as f64 / 120.0, "/fader", &[i as f64 / 120.0]))
        .collect();
    let path = write_session(tmp.path(), h.app_port, &events);
    let mut c = h.connect();
    assert_eq!(c.request(json!({"cmd": "load", "path": path}))["ok"], true);
    h.relay("127.0.0.1:9001", "/vtr/origin", vec![]);
    assert_eq!(c.request(json!({"cmd": "play"}))["ok"], true);

    // Count both streams over the same window.
    let window = Duration::from_millis(500);
    let deadline = Instant::now() + window;
    let count = |sock: &UdpSocket| {
        let mut n = 0;
        let mut buf = [0u8; 1024];
        while Instant::now() < deadline {
            sock.set_read_timeout(Some(Duration::from_millis(50))).unwrap();
            if sock.recv(&mut buf).is_ok() {
                n += 1;
            }
        }
        n
    };
    let app_n = count(&h.app);
    let ctrl_n = count(&h.controller);
    assert!(app_n > 20, "app should see the full stream, got {app_n}");
    // 500ms at 50 Hz is 25 flushes; allow slack, but it must be far under
    // the app's per-event rate.
    assert!(
        ctrl_n <= 35 && ctrl_n < app_n,
        "mirror not coalesced: {ctrl_n} vs app {app_n}"
    );
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

    // First resolve per connection: full catch-up (seek). /b's first event
    // is still ahead (5.2) -> its value extends backward.
    let r = c1.request(json!({"cmd": "resolve", "t": 5.1}));
    assert_eq!(r["mode"], "seek");
    assert_eq!(
        r["events"],
        json!([[10010, "/a", [1.0]], [10010, "/b", [2.0]]])
    );

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

    // The inline session resolves like a file-loaded one; /b's first event
    // (t=2.0) extends backward.
    let r = c.request(json!({"cmd": "resolve", "t": 1.5}));
    assert_eq!(r["ok"], true, "resp = {r}");
    assert_eq!(
        r["events"],
        json!([[10010, "/a", [1.0]], [10010, "/b", [2.0]]])
    );
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
    assert!(
        (r["t"].as_f64().unwrap() - 2.0).abs() < 0.2,
        "t = {}",
        r["t"]
    );
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

#[test]
fn transport_cmds_carry_gen_and_origin_and_honor_hold() {
    let tmp = tempfile::tempdir().unwrap();
    let h = start_player(tmp.path(), None);
    let mut c = h.connect();

    // A seek reports a bumped gen and its origin.
    let r = c.request(json!({"cmd": "seek", "t": 1.0, "origin": "editor"}));
    assert_eq!(r["ok"], true, "resp = {r}");
    let gen1 = r["gen"].as_u64().unwrap();
    assert!(gen1 >= 1);
    assert_eq!(r["origin"], "editor");
    assert!((r["playhead"].as_f64().unwrap() - 1.0).abs() < 0.05);

    // A foreign origin inside the hold window is rejected: gen unchanged,
    // playhead unmoved.
    let r = c.request(json!({"cmd": "seek", "t": 9.0, "origin": "td"}));
    assert_eq!(r["gen"].as_u64().unwrap(), gen1, "hold should reject td");
    assert_eq!(r["origin"], "editor");
    assert!((r["playhead"].as_f64().unwrap() - 1.0).abs() < 0.05);

    // Same origin still wins and bumps gen.
    let r = c.request(json!({"cmd": "seek", "t": 3.0, "origin": "editor"}));
    assert!(r["gen"].as_u64().unwrap() > gen1);

    // status and resolve surface the same fields.
    let s = c.request(json!({"cmd": "status"}));
    assert_eq!(s["status"]["origin"], "editor");
    assert!(s["status"]["gen"].as_u64().unwrap() > gen1);
}

#[test]
fn load_with_keep_preserves_the_transport() {
    let tmp = tempfile::tempdir().unwrap();
    let h = start_player(tmp.path(), None);
    let mut c = h.connect();
    assert_eq!(
        c.request(json!({"cmd": "load", "events": [ev(1.0, "/a", &[1.0])], "duration": 60.0}))
            ["ok"],
        true
    );
    let r = c.request(json!({"cmd": "seek", "t": 2.0, "origin": "editor"}));
    let gen0 = r["gen"].as_u64().unwrap();

    // keep: session swaps, transport untouched (position, gen, origin).
    let r = c.request(json!({
        "cmd": "load", "keep": true, "origin": "editor",
        "events": [ev(1.0, "/a", &[2.0])], "duration": 60.0,
    }));
    assert_eq!(r["ok"], true, "resp = {r}");
    let s = c.request(json!({"cmd": "status"}));
    assert!((s["status"]["playhead"].as_f64().unwrap() - 2.0).abs() < 0.05);
    assert_eq!(s["status"]["gen"].as_u64().unwrap(), gen0);
    assert_eq!(s["status"]["origin"], "editor");

    // Default load: stop + rewind, gen bumped with the loader's origin.
    let r = c.request(json!({
        "cmd": "load", "origin": "editor",
        "events": [ev(1.0, "/a", &[3.0])], "duration": 60.0,
    }));
    assert_eq!(r["ok"], true, "resp = {r}");
    let s = c.request(json!({"cmd": "status"}));
    assert_eq!(s["status"]["playhead"], 0.0);
    assert!(s["status"]["gen"].as_u64().unwrap() > gen0);
    assert_eq!(s["status"]["origin"], "editor");
}

#[test]
fn watch_blocks_until_gen_changes() {
    let tmp = tempfile::tempdir().unwrap();
    let h = start_player(tmp.path(), None);
    let mut c = h.connect();
    let g = c.request(json!({"cmd": "status"}))["status"]["gen"]
        .as_u64()
        .unwrap();

    // Watch on a second connection, blocking in a thread.
    let mut w = h.connect();
    let handle = thread::spawn(move || w.request(json!({"cmd": "watch", "gen": g})));

    // Let the watcher block, then change the transport from another origin.
    thread::sleep(Duration::from_millis(100));
    c.request(json!({"cmd": "seek", "t": 4.0, "origin": "editor"}));

    let r = handle.join().unwrap();
    assert_eq!(r["ok"], true, "resp = {r}");
    assert!(r["gen"].as_u64().unwrap() > g, "watch should wake: {r}");
    assert_eq!(r["origin"], "editor");
    assert!((r["playhead"].as_f64().unwrap() - 4.0).abs() < 0.05);
}

#[test]
fn watch_does_not_block_later_requests_on_the_same_connection() {
    let tmp = tempfile::tempdir().unwrap();
    let h = start_player(tmp.path(), None);
    let mut c = h.connect();
    let g = c.request(json!({"cmd": "status"}))["status"]["gen"]
        .as_u64()
        .unwrap();

    // Park a watch, then send a status behind it on the same socket.
    c.send(json!({"cmd": "watch", "gen": g, "id": 1}));
    thread::sleep(Duration::from_millis(100));
    c.send(json!({"cmd": "status", "id": 2}));

    // The status answers first: the watch waits on its own thread.
    let first = c.read_reply();
    assert_eq!(first["id"], 2, "status queued behind watch: {first}");
    let second = c.read_reply();
    assert_eq!(second["id"], 1, "resp = {second}");
    assert_eq!(second["gen"].as_u64().unwrap(), g);
}

#[test]
fn watch_times_out_with_same_gen() {
    let tmp = tempfile::tempdir().unwrap();
    let h = start_player(tmp.path(), None);
    let mut c = h.connect();
    let g = c.request(json!({"cmd": "status"}))["status"]["gen"]
        .as_u64()
        .unwrap();
    // Nothing changes: watch returns after the server timeout, same gen.
    let start = Instant::now();
    let r = c.request(json!({"cmd": "watch", "gen": g}));
    assert!(
        start.elapsed() >= Duration::from_millis(900),
        "should block ~1s"
    );
    assert_eq!(r["gen"].as_u64().unwrap(), g);
}
