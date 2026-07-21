//! Conformance suite: 1:1 translation of `td/tests/test_resolver.py`.
//! The Python originals (run by `cd td && uv run pytest`) stay the
//! executable reference; keep names and fixtures in sync.

use std::io::Write as _;
use std::sync::Arc;

use serde_json::{json, Value};
use vtr_player::resolver::{Emit, Resolver};
use vtr_player::session::{self, Session};

fn load(lines: &[Value]) -> Arc<Session> {
    let tmp = tempfile::tempdir().unwrap();
    let p = tmp.path().join("session.jsonl");
    let mut f = std::fs::File::create(&p).unwrap();
    for l in lines {
        writeln!(f, "{l}").unwrap();
    }
    Arc::new(session::load(&p).unwrap())
}

fn ev(t: f64, a: &str, args: &[f64]) -> Value {
    json!({"t": t, "port": 10010, "a": a, "types": "f".repeat(args.len()), "args": args})
}

fn emit(port: u16, a: &str, args: &[f64]) -> Emit {
    (port, a.to_string(), args.iter().map(|&v| json!(v)).collect())
}

fn resolver(s: &Arc<Session>) -> Resolver {
    Resolver::new(s.clone(), None, 0.5)
}

fn is_kick(addr: &str) -> bool {
    addr.starts_with("/kick")
}

/// First float arg of each emission.
fn firsts(out: &[Emit]) -> Vec<f64> {
    out.iter().map(|e| e.2[0].as_f64().unwrap()).collect()
}

#[test]
fn test_first_step_is_full_catchup() {
    let s = load(&[ev(0.1, "/a", &[1.0]), ev(0.2, "/b", &[2.0]), ev(0.3, "/a", &[3.0])]);
    let mut r = resolver(&s);
    assert_eq!(
        r.step(5.0),
        vec![emit(10010, "/b", &[2.0]), emit(10010, "/a", &[3.0])]
    );
}

#[test]
fn test_pump_emits_every_event_once_in_order() {
    let s = load(&[
        ev(1.0, "/fader", &[1.0]),
        ev(1.1, "/fader", &[1.1]),
        ev(1.2, "/fader", &[1.2]),
        ev(1.3, "/fader", &[1.3]),
    ]);
    let mut r = resolver(&s);
    r.step(1.0); // seek lands on the t=1.0 event
    assert_eq!(firsts(&r.step(1.3)), vec![1.1, 1.2, 1.3]); // (prev, pos], no coalescing
    assert_eq!(r.step(1.3), vec![]); // pos unchanged
    assert_eq!(r.step(1.4), vec![]); // nothing new
}

#[test]
fn test_forward_jump_coalesces_per_address() {
    let s = load(&[
        ev(0.0, "/idle", &[9.0]),
        ev(1.0, "/a", &[1.0]),
        ev(1.5, "/a", &[2.0]),
        ev(2.0, "/b", &[3.0]),
    ]);
    let mut r = resolver(&s);
    r.step(0.5);
    // Jump 0.5 -> 3.0: /a coalesced to its last value, /idle untouched -> not re-sent.
    assert_eq!(
        r.step(3.0),
        vec![emit(10010, "/a", &[2.0]), emit(10010, "/b", &[3.0])]
    );
}

#[test]
fn test_backward_reresolves_only_touched_addresses() {
    let s = load(&[
        ev(0.5, "/a", &[1.0]),
        ev(2.0, "/a", &[2.0]),
        ev(2.5, "/late", &[7.0]),
        ev(0.6, "/idle", &[9.0]),
    ]);
    let mut r = resolver(&s);
    r.step(3.0);
    // Back to 1.0: /a returns to its 0.5s value; /late has nothing <= 1.0 -> silent;
    // /idle untouched in (1.0, 3.0] -> not re-sent.
    assert_eq!(r.step(1.0), vec![emit(10010, "/a", &[1.0])]);
}

#[test]
fn test_triggers_fire_on_pump_but_not_on_seek() {
    let s = load(&[ev(1.0, "/kick", &[1.0]), ev(1.1, "/fader", &[0.5])]);
    let mut r = Resolver::new(s.clone(), Some(&is_kick), 0.5);
    assert_eq!(r.step(5.0), vec![emit(10010, "/fader", &[0.5])]); // seek suppresses the trigger
    r.reset();
    r.step(0.9);
    let out = r.step(1.2); // continuous forward fires it
    assert!(out.contains(&emit(10010, "/kick", &[1.0])));
}

#[test]
fn test_reset_forces_full_catchup() {
    let s = load(&[ev(0.1, "/a", &[1.0])]);
    let mut r = resolver(&s);
    r.step(1.0);
    assert_eq!(r.step(1.1), vec![]);
    r.reset();
    assert_eq!(r.step(1.2), vec![emit(10010, "/a", &[1.0])]);
}

#[test]
fn test_empty_session() {
    let s = load(&[json!({"type": "session_start", "t": 0.0, "routes": []})]);
    let mut r = resolver(&s);
    assert_eq!(r.step(1.0), vec![]);
}

#[test]
fn test_jump_threshold_is_configurable() {
    let s = load(&[
        ev(1.0, "/fader", &[1.0]),
        ev(1.5, "/fader", &[1.5]),
        ev(2.0, "/fader", &[2.0]),
    ]);
    let mut r = Resolver::new(s.clone(), None, 2.0);
    r.step(0.5);
    assert_eq!(firsts(&r.step(2.0)), vec![1.0, 1.5, 2.0]); // 1.5s step still pumps
}
