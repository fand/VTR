//! Conformance suite: 1:1 translation of `td/tests/test_session.py`.
//! The Python originals (run by `cd td && uv run pytest`) stay the
//! executable reference; keep names and fixtures in sync.

use std::io::Write as _;
use std::path::PathBuf;

use serde_json::{json, Value};
use vtr_player::session::{self, Session};

fn write(dir: &std::path::Path, lines: &[Value]) -> PathBuf {
    let p = dir.join("session.jsonl");
    let mut f = std::fs::File::create(&p).unwrap();
    for l in lines {
        match l {
            Value::String(s) => writeln!(f, "{s}").unwrap(),
            other => writeln!(f, "{other}").unwrap(),
        }
    }
    p
}

fn load(lines: &[Value]) -> Session {
    let tmp = tempfile::tempdir().unwrap();
    session::load(&write(tmp.path(), lines)).unwrap()
}

fn ev(t: f64, a: &str, args: Value, types: Option<&str>, port: u16) -> Value {
    let types = types
        .map(String::from)
        .unwrap_or_else(|| "f".repeat(args.as_array().unwrap().len()));
    json!({"t": t, "port": port, "a": a, "types": types, "args": args})
}

fn fader(t: f64) -> Value {
    ev(t, "/fader", json!([0.5]), None, 10010)
}

fn header() -> Value {
    json!({"type": "session_start", "t": 0.0, "routes": ["10010->10011"]})
}

#[test]
fn test_header_routes_and_trailer_duration() {
    let s = load(&[
        header(),
        fader(0.5),
        fader(1.0),
        json!({"type": "session_end", "t": 40.0}),
    ]);
    assert_eq!(s.routes, [(10010, 10011)].into());
    assert_eq!(s.duration, 40.0);
    assert_eq!(s.len(), 2);
    assert_eq!(s.skipped, 0);
}

#[test]
fn test_duration_falls_back_to_last_event() {
    let s = load(&[header(), fader(0.5), fader(2.5)]);
    assert_eq!(s.duration, 2.5);
}

#[test]
fn test_empty_session() {
    let s = load(&[header()]);
    assert_eq!(s.len(), 0);
    assert_eq!(s.duration, 0.0);
    assert!(s.addr_events.is_empty());
}

#[test]
fn test_numeric_args_round_trip_with_int_tags() {
    let s = load(&[ev(0.1, "/fader", json!([0.25, 3, 7]), Some("fih"), 10010)]);
    let args = s.event_args(0);
    assert_eq!(args, vec![json!(0.25), json!(3), json!(7)]);
    assert!(args[0].is_f64());
    assert!(args[1].is_i64());
    assert!(args[2].is_i64());
}

#[test]
fn test_non_numeric_args_kept_verbatim() {
    let s = load(&[
        ev(0.1, "/fader", json!(["cue", 1.5]), Some("sf"), 10010),
        fader(0.2),
    ]);
    assert_eq!(s.event_args(0), vec![json!("cue"), json!(1.5)]);
    assert_eq!(s.event_args(1), vec![json!(0.5)]);
    assert!(s.raw_args.contains_key(&0) && !s.raw_args.contains_key(&1));
}

#[test]
fn test_malformed_lines_are_counted_not_fatal() {
    let s = load(&[
        json!("not json"),
        json!({"t": 1.0, "a": "/x"}),
        fader(0.5),
        json!({"type": "future_thing"}),
    ]);
    assert_eq!(s.len(), 1); // fader(0.5)
    // garbage + missing port; unknown control line tolerated silently
    assert_eq!(s.skipped, 2);
}

#[test]
fn test_event_addr_and_per_address_index() {
    let s = load(&[
        ev(0.1, "/a", json!([0.5]), None, 10010),
        ev(0.2, "/b", json!([0.5]), None, 10020),
        ev(0.3, "/a", json!([0.5]), None, 10010),
    ]);
    assert_eq!(s.event_addr(1), &("/b".to_string(), 10020));
    assert_eq!(s.addrs.len(), 2);
    let ia = s
        .addrs
        .iter()
        .position(|a| a == &("/a".to_string(), 10010))
        .unwrap();
    assert_eq!(s.addr_events[ia], vec![0, 2]);
    assert_eq!(s.addr_t[ia], vec![0.1, 0.3]);
}

#[test]
fn test_unsorted_input_is_reordered() {
    let s = load(&[
        ev(2.0, "/fader", json!([2.0]), None, 10010),
        ev(1.0, "/fader", json!([1.0]), Some("s"), 10010),
    ]);
    assert_eq!(s.t, vec![1.0, 2.0]);
    assert_eq!(s.event_args(0), vec![json!(1.0)]); // raw_args remapped with the sort
    assert_eq!(s.event_args(1), vec![json!(2.0)]);
    assert!(s.addr_t[0].windows(2).all(|w| w[1] >= w[0]));
}
