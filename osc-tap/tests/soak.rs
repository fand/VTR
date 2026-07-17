use std::net::UdpSocket;
use std::thread;
use std::time::{Duration, Instant};

use osc_tap::config::Config;
use osc_tap::tap::{Handle, Tap};
use rosc::{OscMessage, OscPacket, OscType};
use serde_json::Value;

fn start_tap(outdir: &std::path::Path) -> Tap {
    // Fake TD that drains the forward socket in the background.
    let td = UdpSocket::bind("127.0.0.1:0").unwrap();
    td.set_read_timeout(Some(Duration::from_millis(500)))
        .unwrap();
    let forward = td.local_addr().unwrap();
    thread::spawn(move || {
        let mut buf = [0u8; 65_507];
        while td.recv(&mut buf).is_ok() {}
    });
    Tap::start(Config {
        listen: "127.0.0.1:0".parse().unwrap(),
        forward,
        beacon: "127.0.0.1:0".parse().unwrap(),
        outdir: outdir.to_path_buf(),
    })
    .unwrap()
}

fn encode_msg(addr: &str, args: Vec<OscType>) -> Vec<u8> {
    rosc::encoder::encode(&OscPacket::Message(OscMessage {
        addr: addr.to_string(),
        args,
    }))
    .unwrap()
}

fn wait_events(handle: &Handle, n: u64, timeout: Duration) {
    let deadline = Instant::now() + timeout;
    loop {
        let status = handle.status().unwrap();
        if status.events >= n {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "timed out: {}/{n} events, {} dropped",
            status.events,
            status.dropped
        );
        thread::sleep(Duration::from_millis(20));
    }
}

fn read_events(path: &std::path::Path) -> Vec<Value> {
    std::fs::read_to_string(path)
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str::<Value>(l).unwrap())
        .filter(|v| v.get("type").is_none())
        .collect()
}

/// Burst: send N messages back-to-back; every one must be recorded in order.
#[test]
fn burst_no_loss() {
    const N: usize = 2000;
    let tmp = tempfile::tempdir().unwrap();
    let tap = start_tap(tmp.path());
    let handle = tap.handle();
    let tx = UdpSocket::bind("127.0.0.1:0").unwrap();

    let clip = handle.start_clip(None).unwrap();
    for i in 0..N {
        tx.send_to(
            &encode_msg("/burst", vec![OscType::Int(i as i32)]),
            tap.listen_addr,
        )
        .unwrap();
    }
    wait_events(&handle, N as u64, Duration::from_secs(10));
    let status = handle.status().unwrap();
    handle.stop_clip().unwrap();

    assert_eq!(status.dropped, 0, "writer backlog dropped packets");
    let events = read_events(&clip);
    assert_eq!(events.len(), N);
    for (i, e) in events.iter().enumerate() {
        assert_eq!(e["args"][0], i as i64, "out of order at {i}");
    }
}

/// 120Hz for 10s. Run manually: cargo test --release -- --ignored soak_120hz
#[test]
#[ignore]
fn soak_120hz() {
    const HZ: f64 = 120.0;
    const SECS: f64 = 10.0;
    let n = (HZ * SECS) as usize;
    let tmp = tempfile::tempdir().unwrap();
    let tap = start_tap(tmp.path());
    let handle = tap.handle();
    let tx = UdpSocket::bind("127.0.0.1:0").unwrap();

    let clip = handle.start_clip(None).unwrap();
    let period = Duration::from_secs_f64(1.0 / HZ);
    let start = Instant::now();
    for i in 0..n {
        let target = start + period * i as u32;
        while Instant::now() < target {
            std::hint::spin_loop();
        }
        tx.send_to(
            &encode_msg("/soak", vec![OscType::Int(i as i32), OscType::Float(0.5)]),
            tap.listen_addr,
        )
        .unwrap();
    }
    wait_events(&handle, n as u64, Duration::from_secs(10));
    let status = handle.status().unwrap();
    handle.stop_clip().unwrap();

    assert_eq!(status.dropped, 0);
    let events = read_events(&clip);
    assert_eq!(events.len(), n);

    // Gap stats over recorded arrival times.
    let ts: Vec<f64> = events.iter().map(|e| e["t"].as_f64().unwrap()).collect();
    let mut gaps: Vec<f64> = ts.windows(2).map(|w| w[1] - w[0]).collect();
    gaps.sort_by(f64::total_cmp);
    let median = gaps[gaps.len() / 2];
    let p99 = gaps[(gaps.len() as f64 * 0.99) as usize];
    println!("gap median {:.3}ms, p99 {:.3}ms", median * 1e3, p99 * 1e3);
    assert!((median - 1.0 / HZ).abs() < 0.002, "median {median}");
}
