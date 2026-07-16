use std::io::{BufRead, BufReader, Write};
use std::net::UdpSocket;
use std::os::unix::net::UnixStream;
use std::thread;
use std::time::{Duration, Instant};

use osc_tap::config::Config;
use osc_tap::tap::{Handle, Tap};
use rosc::{OscBundle, OscMessage, OscPacket, OscTime, OscType};
use serde_json::Value;

fn start_tap(outdir: &std::path::Path) -> (Tap, UdpSocket) {
    let td = UdpSocket::bind("127.0.0.1:0").unwrap();
    td.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
    let tap = Tap::start(Config {
        listen: "127.0.0.1:0".parse().unwrap(),
        forward: td.local_addr().unwrap(),
        beacon: "127.0.0.1:0".parse().unwrap(),
        outdir: outdir.to_path_buf(),
    })
    .unwrap();
    (tap, td)
}

fn encode_msg(addr: &str, args: Vec<OscType>) -> Vec<u8> {
    rosc::encoder::encode(&OscPacket::Message(OscMessage {
        addr: addr.to_string(),
        args,
    }))
    .unwrap()
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
    let (tap, td) = start_tap(tmp.path());
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
    let (tap, _td) = start_tap(tmp.path());
    let handle = tap.handle();
    let tx = UdpSocket::bind("127.0.0.1:0").unwrap();

    let clip = handle.start_clip().unwrap();
    assert!(handle.start_clip().is_err(), "double start must fail");

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
    let bundle = rosc::encoder::encode(&OscPacket::Bundle(OscBundle {
        timetag: OscTime { seconds: 0, fractional: 1 },
        content: vec![
            OscPacket::Message(OscMessage {
                addr: "/b1".into(),
                args: vec![OscType::Int(1)],
            }),
            OscPacket::Message(OscMessage {
                addr: "/b2".into(),
                args: vec![OscType::Int(2)],
            }),
        ],
    }))
    .unwrap();
    tx.send_to(&bundle, tap.listen_addr).unwrap();

    wait_events(&handle, 5);
    handle.stop_clip().unwrap();
    assert!(handle.stop_clip().is_err(), "double stop must fail");

    let lines = read_lines(&clip);
    assert_eq!(lines[0]["type"], "session_start");
    assert!(lines[0]["wall"].is_string());
    assert_eq!(lines.last().unwrap()["type"], "session_end");

    let events = &lines[1..lines.len() - 1];
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
    let (tap, _td) = start_tap(tmp.path());
    let handle = tap.handle();
    let tx = UdpSocket::bind("127.0.0.1:0").unwrap();

    tx.send_to(
        &encode_msg("/tap/timeline", vec![OscType::Float(42.0)]),
        tap.beacon_addr,
    )
    .unwrap();
    // Wait for the beacon to land.
    let deadline = Instant::now() + Duration::from_secs(2);
    while handle.status().unwrap().beacon_tl.is_none() {
        assert!(Instant::now() < deadline, "beacon not received");
        thread::sleep(Duration::from_millis(10));
    }

    let clip = handle.start_clip().unwrap();
    thread::sleep(Duration::from_millis(50));
    tx.send_to(&encode_msg("/x", vec![OscType::Int(1)]), tap.listen_addr)
        .unwrap();
    wait_events(&handle, 1);
    handle.stop_clip().unwrap();

    let lines = read_lines(&clip);
    let tl = lines[1]["tl"].as_f64().unwrap();
    // tl = 42.0 + elapsed since beacon (>=50ms, well under 2s).
    assert!(tl > 42.0 && tl < 44.0, "tl = {tl}");
}

#[test]
fn control_socket_roundtrip() {
    let tmp = tempfile::tempdir().unwrap();
    let (tap, _td) = start_tap(tmp.path());
    let sock_path = tmp.path().join("tap.sock");
    {
        let handle = tap.handle();
        let sock_path = sock_path.clone();
        thread::spawn(move || osc_tap::control::serve(&sock_path, handle));
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
