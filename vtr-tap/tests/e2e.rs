use std::io::{BufRead, BufReader, Write};
use std::net::UdpSocket;
use std::os::unix::net::UnixStream;
use std::thread;
use std::time::{Duration, Instant};

use vtr_tap::config::Config;
use vtr_tap::tap::{Handle, Tap};
use rosc::{OscBundle, OscMessage, OscPacket, OscTime, OscType};
use serde_json::Value;

/// (tap, fake TD on the forward port, fake player on the relay port)
fn start_tap(outdir: &std::path::Path) -> (Tap, UdpSocket, UdpSocket) {
    let td = UdpSocket::bind("127.0.0.1:0").unwrap();
    td.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
    let player = UdpSocket::bind("127.0.0.1:0").unwrap();
    player.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
    let tap = Tap::start(Config {
        listen: "127.0.0.1:0".parse().unwrap(),
        forward: td.local_addr().unwrap(),
        relay: player.local_addr().unwrap(),
        outdir: outdir.to_path_buf(),
        beacon_max_age_s: 5.0,
    })
    .unwrap();
    (tap, td, player)
}

fn encode_msg(addr: &str, args: Vec<OscType>) -> Vec<u8> {
    rosc::encoder::encode(&OscPacket::Message(OscMessage {
        addr: addr.to_string(),
        args,
    }))
    .unwrap()
}

fn encode_bundle(msgs: Vec<(&str, Vec<OscType>)>) -> Vec<u8> {
    rosc::encoder::encode(&OscPacket::Bundle(OscBundle {
        timetag: OscTime {
            seconds: 0,
            fractional: 1,
        },
        content: msgs
            .into_iter()
            .map(|(addr, args)| {
                OscPacket::Message(OscMessage {
                    addr: addr.to_string(),
                    args,
                })
            })
            .collect(),
    }))
    .unwrap()
}

/// Split a relay frame into its `"v1 <origin>"` header and raw payload.
fn split_relay(frame: &[u8]) -> (String, Vec<u8>) {
    let nl = frame.iter().position(|&b| b == b'\n').expect("header");
    (
        std::str::from_utf8(&frame[..nl]).unwrap().to_string(),
        frame[nl + 1..].to_vec(),
    )
}

fn relay_addr_of(payload: &[u8]) -> String {
    let (_, packet) = rosc::decoder::decode_udp(payload).unwrap();
    match packet {
        OscPacket::Message(m) => m.addr,
        OscPacket::Bundle(_) => String::new(),
    }
}

/// Next relay frame that isn't a `/vtr/origin` announcement — those are
/// emitted for any new source IP and would race ahead of the frame a test
/// actually cares about.
fn recv_relay(player: &UdpSocket) -> (String, Vec<u8>) {
    let mut buf = [0u8; 1024];
    loop {
        let n = player.recv(&mut buf).unwrap();
        let (header, payload) = split_relay(&buf[..n]);
        if relay_addr_of(&payload) != "/vtr/origin" {
            return (header, payload);
        }
    }
}

fn wait_events(handle: &Handle, n: u64) {
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        if handle.status().unwrap().events >= n {
            return;
        }
        assert!(Instant::now() < deadline, "timed out waiting for {n} events");
        thread::sleep(Duration::from_millis(10));
    }
}

fn wait_recording(handle: &Handle, want: bool) {
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        if handle.status().unwrap().recording == want {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "timed out waiting for recording={want}"
        );
        thread::sleep(Duration::from_millis(10));
    }
}

fn wait_beacon(handle: &Handle) {
    let deadline = Instant::now() + Duration::from_secs(2);
    while handle.status().unwrap().beacon_tl.is_none() {
        assert!(Instant::now() < deadline, "beacon not received");
        thread::sleep(Duration::from_millis(10));
    }
}

fn read_lines(path: &std::path::Path) -> Vec<Value> {
    std::fs::read_to_string(path)
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect()
}

#[test]
fn forwards_raw_bytes_even_when_not_recording() {
    let tmp = tempfile::tempdir().unwrap();
    let (tap, td, _player) = start_tap(tmp.path());
    let tx = UdpSocket::bind("127.0.0.1:0").unwrap();

    let sent = encode_msg("/a", vec![OscType::Float(0.5)]);
    tx.send_to(&sent, tap.listen_addr).unwrap();

    let mut buf = [0u8; 1024];
    let n = td.recv(&mut buf).unwrap();
    assert_eq!(&buf[..n], &sent[..]);
}

#[test]
fn records_events_with_types_and_session_lines() {
    let tmp = tempfile::tempdir().unwrap();
    let (tap, _td, _player) = start_tap(tmp.path());
    let handle = tap.handle();
    let tx = UdpSocket::bind("127.0.0.1:0").unwrap();

    let clip = handle.start_clip(None, None, None).unwrap();
    assert!(
        handle.start_clip(None, None, None).is_err(),
        "double start must fail"
    );

    tx.send_to(
        &encode_msg("/fader", vec![OscType::Float(0.42)]),
        tap.listen_addr,
    )
    .unwrap();
    tx.send_to(&encode_msg("/kick-on", vec![]), tap.listen_addr)
        .unwrap();
    tx.send_to(
        &encode_msg(
            "/mixed",
            vec![
                OscType::Int(7),
                OscType::Double(1.5),
                OscType::String("hi".into()),
                OscType::Bool(true),
            ],
        ),
        tap.listen_addr,
    )
    .unwrap();
    // Bundle expands to individual messages.
    let bundle = encode_bundle(vec![
        ("/b1", vec![OscType::Int(1)]),
        ("/b2", vec![OscType::Int(2)]),
    ]);
    tx.send_to(&bundle, tap.listen_addr).unwrap();

    wait_events(&handle, 5);
    handle.stop_clip().unwrap();
    assert!(handle.stop_clip().is_err(), "double stop must fail");

    let lines = read_lines(&clip);
    assert_eq!(lines[0]["type"], "session_start");
    assert!(lines[0]["wall"].is_string());
    assert_eq!(lines.last().unwrap()["type"], "session_end");
    let summary = &lines[lines.len() - 2];
    assert_eq!(summary["type"], "summary");
    assert_eq!(summary["events"], 5);
    assert_eq!(summary["dropped"], 0);

    let events = &lines[1..lines.len() - 2];
    assert_eq!(events.len(), 5);
    assert_eq!(events[0]["a"], "/fader");
    assert!((events[0]["args"][0].as_f64().unwrap() - 0.42).abs() < 1e-9);
    assert_eq!(events[1]["a"], "/kick-on");
    assert_eq!(events[1]["args"].as_array().unwrap().len(), 0);
    assert_eq!(events[2]["args"][0], 7);
    assert_eq!(events[2]["args"][1], 1.5);
    assert_eq!(events[2]["args"][2], "hi");
    assert_eq!(events[2]["args"][3], true);
    assert_eq!(events[3]["a"], "/b1");
    assert_eq!(events[4]["a"], "/b2");

    // t is monotonic and starts near 0.
    let ts: Vec<f64> = events.iter().map(|e| e["t"].as_f64().unwrap()).collect();
    assert!(ts.windows(2).all(|w| w[0] <= w[1]));
    assert!(ts[0] >= 0.0 && ts[0] < 1.0);

    // No beacon was sent: tl must be absent.
    assert!(events.iter().all(|e| e.get("tl").is_none()));
}

#[test]
fn stamps_tl_from_beacon() {
    let tmp = tempfile::tempdir().unwrap();
    let (tap, _td, _player) = start_tap(tmp.path());
    let handle = tap.handle();
    let tx = UdpSocket::bind("127.0.0.1:0").unwrap();

    tx.send_to(
        &encode_msg("/vtr/clock", vec![OscType::Float(42.0)]),
        tap.listen_addr,
    )
    .unwrap();
    wait_beacon(&handle);

    let clip = handle.start_clip(None, None, None).unwrap();
    thread::sleep(Duration::from_millis(50));
    tx.send_to(&encode_msg("/x", vec![OscType::Int(1)]), tap.listen_addr)
        .unwrap();
    wait_events(&handle, 1);
    handle.stop_clip().unwrap();

    let lines = read_lines(&clip);
    let tl = lines[1]["tl"].as_f64().unwrap();
    // tl = 42.0 + elapsed since beacon (>=50ms, well under 2s), rate defaults to 1.
    assert!(tl > 42.0 && tl < 44.0, "tl = {tl}");
}

#[test]
fn clock_rate_zero_freezes_tl() {
    let tmp = tempfile::tempdir().unwrap();
    let (tap, _td, _player) = start_tap(tmp.path());
    let handle = tap.handle();
    let tx = UdpSocket::bind("127.0.0.1:0").unwrap();

    // Paused timeline at t=42.
    tx.send_to(
        &encode_msg("/vtr/clock", vec![OscType::Float(42.0), OscType::Float(0.0)]),
        tap.listen_addr,
    )
    .unwrap();
    wait_beacon(&handle);
    assert_eq!(handle.status().unwrap().beacon_rate, Some(0.0));

    let clip = handle.start_clip(None, None, None).unwrap();
    thread::sleep(Duration::from_millis(300));
    tx.send_to(&encode_msg("/x", vec![OscType::Int(1)]), tap.listen_addr)
        .unwrap();
    wait_events(&handle, 1);
    handle.stop_clip().unwrap();

    let lines = read_lines(&clip);
    let tl = lines[1]["tl"].as_f64().unwrap();
    // rate=0: tl must not advance past the beacon value.
    assert!((tl - 42.0).abs() < 1e-6, "tl = {tl}");
}

#[test]
fn control_socket_roundtrip() {
    let tmp = tempfile::tempdir().unwrap();
    let (tap, _td, _player) = start_tap(tmp.path());
    let sock_path = tmp.path().join("tap.sock");
    {
        let handle = tap.handle();
        let sock_path = sock_path.clone();
        thread::spawn(move || vtr_tap::control::serve(&sock_path, handle));
    }
    // Wait for the socket to appear.
    let deadline = Instant::now() + Duration::from_secs(2);
    let stream = loop {
        match UnixStream::connect(&sock_path) {
            Ok(s) => break s,
            Err(_) => {
                assert!(Instant::now() < deadline, "control socket not up");
                thread::sleep(Duration::from_millis(10));
            }
        }
    };
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let mut writer = stream;
    let mut request = |cmd: &str| -> Value {
        writeln!(writer, r#"{{"cmd":"{cmd}"}}"#).unwrap();
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        serde_json::from_str(&line).unwrap()
    };

    let status = request("status");
    assert_eq!(status["ok"], true);
    assert_eq!(status["status"]["recording"], false);

    let start = request("start");
    assert_eq!(start["ok"], true);
    assert!(start["clip"].as_str().unwrap().ends_with(".jsonl"));

    let again = request("start");
    assert_eq!(again["ok"], false);

    let stop = request("stop");
    assert_eq!(stop["ok"], true);

    let bad = request("nope");
    assert_eq!(bad["ok"], false);
}

#[test]
fn control_replies_echo_request_id() {
    let tmp = tempfile::tempdir().unwrap();
    let (tap, _td, _player) = start_tap(tmp.path());
    let handle = tap.handle();

    let resp = vtr_tap::control::dispatch(r#"{"cmd":"status","id":7}"#, &handle);
    assert_eq!(resp["ok"], true);
    assert_eq!(resp["id"], 7);

    // No id in the request -> no id in the reply.
    let resp = vtr_tap::control::dispatch(r#"{"cmd":"status"}"#, &handle);
    assert!(resp.get("id").is_none());
}

#[test]
fn start_with_dir_records_into_it() {
    let tmp = tempfile::tempdir().unwrap();
    let (tap, _td, _player) = start_tap(tmp.path());
    let handle = tap.handle();
    let tx = UdpSocket::bind("127.0.0.1:0").unwrap();

    // The dir does not exist yet; start must create it.
    let dir = tmp.path().join("bundle").join("clips");
    let line = serde_json::json!({"cmd": "start", "dir": dir}).to_string();
    let resp = vtr_tap::control::dispatch(&line, &handle);
    assert_eq!(resp["ok"], true, "resp = {resp}");
    let clip = std::path::PathBuf::from(resp["clip"].as_str().unwrap());
    assert_eq!(clip.parent().unwrap(), dir);

    tx.send_to(&encode_msg("/x", vec![OscType::Int(1)]), tap.listen_addr)
        .unwrap();
    wait_events(&handle, 1);
    handle.stop_clip().unwrap();

    let lines = read_lines(&clip);
    assert_eq!(lines[1]["a"], "/x");
}

#[test]
fn control_start_accepts_tl() {
    let tmp = tempfile::tempdir().unwrap();
    let (tap, _td, _player) = start_tap(tmp.path());
    let handle = tap.handle();
    let tx = UdpSocket::bind("127.0.0.1:0").unwrap();

    let resp = vtr_tap::control::dispatch(r#"{"cmd":"start","tl":42.0,"rate":0.0}"#, &handle);
    assert_eq!(resp["ok"], true, "resp = {resp}");
    let clip = std::path::PathBuf::from(resp["clip"].as_str().unwrap());

    thread::sleep(Duration::from_millis(50));
    tx.send_to(&encode_msg("/x", vec![OscType::Int(1)]), tap.listen_addr)
        .unwrap();
    wait_events(&handle, 1);
    handle.stop_clip().unwrap();

    let lines = read_lines(&clip);
    // rate 0: header and event tl stay at the seeded value.
    assert_eq!(lines[0]["tl"].as_f64().unwrap(), 42.0);
    assert!((lines[1]["tl"].as_f64().unwrap() - 42.0).abs() < 1e-6);
}

#[test]
fn stale_beacon_omits_tl() {
    let tmp = tempfile::tempdir().unwrap();
    let td = UdpSocket::bind("127.0.0.1:0").unwrap();
    td.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
    // Short cutoff so the test doesn't sleep for seconds.
    let tap = Tap::start(Config {
        listen: "127.0.0.1:0".parse().unwrap(),
        forward: td.local_addr().unwrap(),
        relay: "127.0.0.1:9".parse().unwrap(),
        outdir: tmp.path().to_path_buf(),
        beacon_max_age_s: 0.3,
    })
    .unwrap();
    let handle = tap.handle();
    let tx = UdpSocket::bind("127.0.0.1:0").unwrap();

    // Playing beacon (rate 1) that then goes silent (TD quit mid-recording).
    tx.send_to(
        &encode_msg("/vtr/clock", vec![OscType::Float(42.0)]),
        tap.listen_addr,
    )
    .unwrap();
    wait_beacon(&handle);

    let clip = handle.start_clip(None, None, None).unwrap();
    // Let the beacon go stale (well past the 0.3s cutoff).
    thread::sleep(Duration::from_millis(600));
    tx.send_to(&encode_msg("/x", vec![OscType::Int(1)]), tap.listen_addr)
        .unwrap();
    wait_events(&handle, 1);
    handle.stop_clip().unwrap();

    // "omit when unknown": a stale extrapolation must not be stamped.
    let lines = read_lines(&clip);
    assert!(lines[1].get("tl").is_none(), "line = {}", lines[1]);
}

#[test]
fn osc_rec_start_and_stop_control_recording() {
    let tmp = tempfile::tempdir().unwrap();
    let (tap, _td, _player) = start_tap(tmp.path());
    let handle = tap.handle();
    let tx = UdpSocket::bind("127.0.0.1:0").unwrap();

    tx.send_to(&encode_msg("/vtr/rec/start", vec![]), tap.listen_addr)
        .unwrap();
    wait_recording(&handle, true);
    let clip = handle.status().unwrap().clip.unwrap();

    tx.send_to(&encode_msg("/x", vec![OscType::Int(1)]), tap.listen_addr)
        .unwrap();
    wait_events(&handle, 1);

    tx.send_to(&encode_msg("/vtr/rec/stop", vec![]), tap.listen_addr)
        .unwrap();
    wait_recording(&handle, false);

    assert_eq!(handle.status().unwrap().last_clip, Some(clip.clone()));
    let lines = read_lines(&clip);
    assert_eq!(lines[0]["type"], "session_start");
    assert_eq!(lines[1]["a"], "/x");
    assert_eq!(lines.last().unwrap()["type"], "session_end");

    // Both transitions landed in the event log.
    let r = handle.event_log().wait_since(0, Duration::ZERO);
    assert!(!r.reset);
    assert_eq!(r.seq, 2);
    let evs = serde_json::to_value(&r.events).unwrap();
    assert_eq!(evs[0]["ev"], "rec_started");
    assert_eq!(evs[1]["ev"], "rec_stopped");
    assert_eq!(evs[1]["clip"], serde_json::json!(clip));
}

#[test]
fn rec_start_tl_arg_seeds_the_clock() {
    // /vtr/rec/start 42.0 with no /vtr/clock ever sent: the header carries
    // tl ≈ 42 and event tl continues from it.
    let tmp = tempfile::tempdir().unwrap();
    let (tap, _td, _player) = start_tap(tmp.path());
    let handle = tap.handle();
    let tx = UdpSocket::bind("127.0.0.1:0").unwrap();

    tx.send_to(
        &encode_msg("/vtr/rec/start", vec![OscType::Float(42.0)]),
        tap.listen_addr,
    )
    .unwrap();
    wait_recording(&handle, true);
    thread::sleep(Duration::from_millis(50));
    tx.send_to(&encode_msg("/x", vec![OscType::Int(1)]), tap.listen_addr)
        .unwrap();
    wait_events(&handle, 1);
    tx.send_to(&encode_msg("/vtr/rec/stop", vec![]), tap.listen_addr)
        .unwrap();
    wait_recording(&handle, false);

    let clip = handle.status().unwrap().last_clip.unwrap();
    let lines = read_lines(&clip);
    let header_tl = lines[0]["tl"].as_f64().unwrap();
    assert!((42.0..43.0).contains(&header_tl), "header tl = {header_tl}");
    let tl = lines[1]["tl"].as_f64().unwrap();
    assert!(tl > 42.0 && tl < 44.0, "tl = {tl}");

    let r = handle.event_log().wait_since(0, Duration::ZERO);
    let evs = serde_json::to_value(&r.events).unwrap();
    assert!(evs[0]["tl"].as_f64().unwrap() >= 42.0);
}

#[test]
fn rec_msgs_are_idempotent() {
    let tmp = tempfile::tempdir().unwrap();
    let (tap, _td, _player) = start_tap(tmp.path());
    let handle = tap.handle();
    let tx = UdpSocket::bind("127.0.0.1:0").unwrap();

    // Stop while idle: nothing happens, no event.
    tx.send_to(&encode_msg("/vtr/rec/stop", vec![]), tap.listen_addr)
        .unwrap();
    thread::sleep(Duration::from_millis(100));
    assert!(!handle.status().unwrap().recording);
    assert_eq!(handle.event_log().newest(), 0);

    // Double start: one clip, one rec_started.
    tx.send_to(&encode_msg("/vtr/rec/start", vec![]), tap.listen_addr)
        .unwrap();
    wait_recording(&handle, true);
    let clip = handle.status().unwrap().clip;
    tx.send_to(&encode_msg("/vtr/rec/start", vec![]), tap.listen_addr)
        .unwrap();
    thread::sleep(Duration::from_millis(100));
    let st = handle.status().unwrap();
    assert!(st.recording);
    assert_eq!(st.clip, clip);
    assert_eq!(handle.event_log().newest(), 1, "no second rec_started");
    assert_eq!(std::fs::read_dir(tmp.path()).unwrap().count(), 1);
}

#[test]
fn vtr_rec_toggle_starts_and_stops() {
    let tmp = tempfile::tempdir().unwrap();
    let (tap, _td, _player) = start_tap(tmp.path());
    let handle = tap.handle();
    let tx = UdpSocket::bind("127.0.0.1:0").unwrap();

    // 1 starts, without seeding the beacon.
    tx.send_to(
        &encode_msg("/vtr/rec", vec![OscType::Float(1.0)]),
        tap.listen_addr,
    )
    .unwrap();
    wait_recording(&handle, true);
    assert_eq!(handle.status().unwrap().beacon_tl, None, "no beacon seed");
    let clip = handle.status().unwrap().clip.unwrap();
    let lines = read_lines(&clip);
    assert!(lines[0].get("tl").is_none(), "header must carry no tl");

    // Redundant 1: idempotent.
    tx.send_to(
        &encode_msg("/vtr/rec", vec![OscType::Float(1.0)]),
        tap.listen_addr,
    )
    .unwrap();
    thread::sleep(Duration::from_millis(100));
    assert_eq!(handle.status().unwrap().clip, Some(clip.clone()));
    assert_eq!(handle.event_log().newest(), 1);

    // 0 stops (int arg accepted too).
    tx.send_to(
        &encode_msg("/vtr/rec", vec![OscType::Int(0)]),
        tap.listen_addr,
    )
    .unwrap();
    wait_recording(&handle, false);
    assert_eq!(handle.status().unwrap().last_clip, Some(clip));

    // Redundant 0: idempotent.
    tx.send_to(
        &encode_msg("/vtr/rec", vec![OscType::Int(0)]),
        tap.listen_addr,
    )
    .unwrap();
    thread::sleep(Duration::from_millis(100));
    assert_eq!(handle.event_log().newest(), 2);
}

#[test]
fn vtr_msgs_are_never_forwarded_nor_recorded() {
    let tmp = tempfile::tempdir().unwrap();
    let (tap, td, _player) = start_tap(tmp.path());
    let handle = tap.handle();
    let tx = UdpSocket::bind("127.0.0.1:0").unwrap();

    let clip = handle.start_clip(None, None, None).unwrap();
    tx.send_to(
        &encode_msg("/vtr/clock", vec![OscType::Float(1.0)]),
        tap.listen_addr,
    )
    .unwrap();
    let marker = encode_msg("/x", vec![OscType::Int(1)]);
    tx.send_to(&marker, tap.listen_addr).unwrap();

    // The first datagram TD sees is the marker: /vtr/clock was consumed.
    let mut buf = [0u8; 1024];
    let n = td.recv(&mut buf).unwrap();
    assert_eq!(&buf[..n], &marker[..]);

    wait_events(&handle, 1);
    handle.stop_clip().unwrap();
    let lines = read_lines(&clip);
    let addrs: Vec<&str> = lines
        .iter()
        .filter(|l| l.get("a").is_some())
        .map(|l| l["a"].as_str().unwrap())
        .collect();
    assert_eq!(addrs, vec!["/x"], "control msgs must not be recorded");
}

#[test]
fn relay_carries_origin_and_payload() {
    let tmp = tempfile::tempdir().unwrap();
    let (tap, _td, player) = start_tap(tmp.path());
    let tx = UdpSocket::bind("127.0.0.1:0").unwrap();

    let sent = encode_msg("/vtr/seek", vec![OscType::Float(3.5)]);
    tx.send_to(&sent, tap.listen_addr).unwrap();

    let (header, payload) = recv_relay(&player);
    assert_eq!(header, format!("v1 {}", tx.local_addr().unwrap()));
    assert_eq!(payload, sent, "payload must be the raw datagram");
}

#[test]
fn plain_app_traffic_announces_its_origin_once() {
    let tmp = tempfile::tempdir().unwrap();
    let (tap, _td, player) = start_tap(tmp.path());
    let tx = UdpSocket::bind("127.0.0.1:0").unwrap();

    // Plain app OSC — no /vtr in it — still tells the player who sent it,
    // so playback can be mirrored back to a controller with no /vtr button.
    let fader = encode_msg("/fader", vec![OscType::Float(0.5)]);
    tx.send_to(&fader, tap.listen_addr).unwrap();
    let mut buf = [0u8; 1024];
    let n = player.recv(&mut buf).unwrap();
    let (header, payload) = split_relay(&buf[..n]);
    assert_eq!(header, format!("v1 {}", tx.local_addr().unwrap()));
    assert_eq!(relay_addr_of(&payload), "/vtr/origin");

    // Same IP again inside the refresh window: nothing more.
    tx.send_to(&fader, tap.listen_addr).unwrap();
    player
        .set_read_timeout(Some(Duration::from_millis(200)))
        .unwrap();
    assert!(player.recv(&mut buf).is_err(), "origin must not repeat");
}

#[test]
fn mixed_bundle_drops_non_vtr_siblings() {
    let tmp = tempfile::tempdir().unwrap();
    let (tap, td, _player) = start_tap(tmp.path());
    let handle = tap.handle();
    let tx = UdpSocket::bind("127.0.0.1:0").unwrap();

    let clip = handle.start_clip(None, None, None).unwrap();
    // /vtr/clock is handled, /app is dropped — never re-encoded and forwarded.
    let mixed = encode_bundle(vec![
        ("/vtr/clock", vec![OscType::Float(42.0)]),
        ("/app", vec![OscType::Int(1)]),
    ]);
    tx.send_to(&mixed, tap.listen_addr).unwrap();
    wait_beacon(&handle);

    let marker = encode_msg("/x", vec![OscType::Int(1)]);
    tx.send_to(&marker, tap.listen_addr).unwrap();
    let mut buf = [0u8; 1024];
    let n = td.recv(&mut buf).unwrap();
    assert_eq!(&buf[..n], &marker[..], "nothing of the bundle is forwarded");

    wait_events(&handle, 1);
    handle.stop_clip().unwrap();
    let lines = read_lines(&clip);
    assert!(
        lines.iter().all(|l| l.get("a").map(|a| a != "/app").unwrap_or(true)),
        "dropped sibling must not be recorded"
    );
}

#[test]
fn plain_bundles_forward_byte_identical() {
    let tmp = tempfile::tempdir().unwrap();
    let (tap, td, _player) = start_tap(tmp.path());
    let tx = UdpSocket::bind("127.0.0.1:0").unwrap();

    let bundle = encode_bundle(vec![
        ("/b1", vec![OscType::Int(1)]),
        ("/b2", vec![OscType::Int(2)]),
    ]);
    tx.send_to(&bundle, tap.listen_addr).unwrap();

    let mut buf = [0u8; 1024];
    let n = td.recv(&mut buf).unwrap();
    assert_eq!(&buf[..n], &bundle[..]);
}

#[test]
fn vtr_lookalikes_forward_byte_identical() {
    let tmp = tempfile::tempdir().unwrap();
    let (tap, td, _player) = start_tap(tmp.path());
    let tx = UdpSocket::bind("127.0.0.1:0").unwrap();
    let mut buf = [0u8; 1024];

    // "/vtr/" in a string arg: byte-scan hit, but app data.
    let string_arg = encode_msg("/label", vec![OscType::String("/vtr/rec".into())]);
    tx.send_to(&string_arg, tap.listen_addr).unwrap();
    let n = td.recv(&mut buf).unwrap();
    assert_eq!(&buf[..n], &string_arg[..]);

    // "/vtr/" not at the start of the address: app data.
    let infix = encode_msg("/x/vtr/y", vec![OscType::Int(1)]);
    tx.send_to(&infix, tap.listen_addr).unwrap();
    let n = td.recv(&mut buf).unwrap();
    assert_eq!(&buf[..n], &infix[..]);
}

#[test]
fn unknown_vtr_addresses_are_dropped() {
    let tmp = tempfile::tempdir().unwrap();
    let (tap, td, _player) = start_tap(tmp.path());
    let handle = tap.handle();
    let tx = UdpSocket::bind("127.0.0.1:0").unwrap();

    tx.send_to(&encode_msg("/vtr/nope", vec![]), tap.listen_addr)
        .unwrap();
    let marker = encode_msg("/x", vec![OscType::Int(1)]);
    tx.send_to(&marker, tap.listen_addr).unwrap();

    let mut buf = [0u8; 1024];
    let n = td.recv(&mut buf).unwrap();
    assert_eq!(&buf[..n], &marker[..], "unknown /vtr/* must not be forwarded");
    assert!(!handle.status().unwrap().recording);
}

#[test]
fn wait_long_polls_the_event_log() {
    let tmp = tempfile::tempdir().unwrap();
    let (tap, _td, _player) = start_tap(tmp.path());
    let handle = tap.handle();
    let sock_path = tmp.path().join("tap.sock");
    {
        let handle = handle.clone();
        let sock_path = sock_path.clone();
        thread::spawn(move || vtr_tap::control::serve(&sock_path, handle));
    }
    let deadline = Instant::now() + Duration::from_secs(2);
    let stream = loop {
        match UnixStream::connect(&sock_path) {
            Ok(s) => break s,
            Err(_) => {
                assert!(Instant::now() < deadline, "control socket not up");
                thread::sleep(Duration::from_millis(10));
            }
        }
    };
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let mut writer = stream;
    let mut read_reply = || -> Value {
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        serde_json::from_str(&line).unwrap()
    };

    // Baseline (no since): reset + snapshot + current seq, no events.
    writeln!(writer, r#"{{"cmd":"wait","id":1}}"#).unwrap();
    let resp = read_reply();
    assert_eq!(resp["id"], 1);
    assert_eq!(resp["reset"], true);
    assert_eq!(resp["seq"], 0);
    assert_eq!(resp["events"].as_array().unwrap().len(), 0);
    assert_eq!(resp["status"]["recording"], false);

    // A blocked wait must not stall other requests on the same connection.
    writeln!(writer, r#"{{"cmd":"wait","since":0,"id":2}}"#).unwrap();
    thread::sleep(Duration::from_millis(50));
    writeln!(writer, r#"{{"cmd":"status","id":3}}"#).unwrap();
    let resp = read_reply();
    assert_eq!(resp["id"], 3, "status must answer while wait blocks");

    // The blocked wait wakes on a (local) start.
    let clip = handle.start_clip(None, None, None).unwrap();
    let resp = read_reply();
    assert_eq!(resp["id"], 2);
    assert_eq!(resp["seq"], 1);
    assert_eq!(resp["events"][0]["ev"], "rec_started");

    // OSC-path stops flow through the same log; events arrive in order.
    handle.stop_clip().unwrap();
    writeln!(writer, r#"{{"cmd":"wait","since":1,"id":4}}"#).unwrap();
    let resp = read_reply();
    assert_eq!(resp["id"], 4);
    assert_eq!(resp["seq"], 2);
    assert_eq!(resp["events"][0]["ev"], "rec_stopped");
    assert_eq!(resp["events"][0]["clip"], serde_json::json!(clip));

    // A cursor from another process (ahead of newest): reset + snapshot.
    writeln!(writer, r#"{{"cmd":"wait","since":99,"id":5}}"#).unwrap();
    let resp = read_reply();
    assert_eq!(resp["id"], 5);
    assert_eq!(resp["reset"], true);
    assert_eq!(resp["seq"], 2);
    assert!(resp["status"].is_object());
}

#[test]
fn monitor_long_polls_live_osc() {
    let tmp = tempfile::tempdir().unwrap();
    let (tap, _td, _player) = start_tap(tmp.path());
    let sock_path = tmp.path().join("tap.sock");
    {
        let handle = tap.handle();
        let sock_path = sock_path.clone();
        thread::spawn(move || vtr_tap::control::serve(&sock_path, handle));
    }
    let deadline = Instant::now() + Duration::from_secs(2);
    let stream = loop {
        match UnixStream::connect(&sock_path) {
            Ok(s) => break s,
            Err(_) => {
                assert!(Instant::now() < deadline, "control socket not up");
                thread::sleep(Duration::from_millis(10));
            }
        }
    };
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let mut writer = stream;
    let mut read_reply = || -> Value {
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        serde_json::from_str(&line).unwrap()
    };

    // Baseline (no since): reset + current seq, no lines.
    writeln!(writer, r#"{{"cmd":"monitor","id":1}}"#).unwrap();
    let resp = read_reply();
    assert_eq!(resp["reset"], true);
    assert_eq!(resp["seq"], 0);
    assert_eq!(resp["lines"].as_array().unwrap().len(), 0);

    // A blocked monitor poll wakes on app traffic, idle (not recording).
    writeln!(writer, r#"{{"cmd":"monitor","since":0,"id":2}}"#).unwrap();
    thread::sleep(Duration::from_millis(50));
    let tx = UdpSocket::bind("127.0.0.1:0").unwrap();
    tx.send_to(
        &encode_msg("/fader", vec![OscType::Float(0.5)]),
        tap.listen_addr,
    )
    .unwrap();
    let resp = read_reply();
    assert_eq!(resp["id"], 2);
    assert_eq!(resp["seq"], 1);
    let line = &resp["lines"][0];
    assert_eq!(line["a"], "/fader");
    assert_eq!(line["types"], "f");
    assert_eq!(line["args"][0], 0.5);
    assert_eq!(
        line["from"].as_str().unwrap(),
        tx.local_addr().unwrap().to_string()
    );
    assert!(line["wall"].as_u64().is_some());

    // /vtr control traffic never shows up in the monitor.
    writeln!(writer, r#"{{"cmd":"monitor","since":1,"id":3}}"#).unwrap();
    thread::sleep(Duration::from_millis(50));
    tx.send_to(
        &encode_msg("/vtr/clock", vec![OscType::Float(1.0)]),
        tap.listen_addr,
    )
    .unwrap();
    tx.send_to(&encode_msg("/b", vec![OscType::Int(2)]), tap.listen_addr)
        .unwrap();
    let resp = read_reply();
    assert_eq!(resp["id"], 3);
    let lines = resp["lines"].as_array().unwrap();
    assert!(lines.iter().all(|l| l["a"] != "/vtr/clock"));
    assert_eq!(lines.last().unwrap()["a"], "/b");
}

#[test]
fn non_finite_beacon_is_rejected() {
    let tmp = tempfile::tempdir().unwrap();
    let (tap, _td, _player) = start_tap(tmp.path());
    let handle = tap.handle();
    let tx = UdpSocket::bind("127.0.0.1:0").unwrap();

    tx.send_to(
        &encode_msg("/vtr/clock", vec![OscType::Float(f32::NAN)]),
        tap.listen_addr,
    )
    .unwrap();
    thread::sleep(Duration::from_millis(200));
    // The NaN beacon must not be accepted at all.
    assert!(handle.status().unwrap().beacon_tl.is_none());

    let clip = handle.start_clip(None, None, None).unwrap();
    tx.send_to(&encode_msg("/x", vec![OscType::Int(1)]), tap.listen_addr)
        .unwrap();
    wait_events(&handle, 1);
    handle.stop_clip().unwrap();

    // No "tl": null artifacts either.
    let lines = read_lines(&clip);
    assert!(lines[1].get("tl").is_none(), "line = {}", lines[1]);
}
