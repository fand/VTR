//! Conformance suite for playback resolution. Originally translated 1:1
//! from the Python reference (`td/tests/test_resolver.py`, removed); this
//! suite now defines the semantics.

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
    // Back to 1.0: /a returns to its 0.5s value; /late (first event 2.5)
    // extends its first value backward; /idle untouched in (1.0, 3.0] -> not re-sent.
    assert_eq!(
        r.step(1.0),
        vec![emit(10010, "/a", &[1.0]), emit(10010, "/late", &[7.0])]
    );
}

#[test]
fn test_seek_before_first_event_extends_first_value() {
    // TODO example: data points only in t=10..20; seek to t=1 resolves the t=10 value.
    let s = load(&[ev(10.0, "/curve", &[0.25]), ev(20.0, "/curve", &[0.75])]);
    let mut r = resolver(&s);
    assert_eq!(r.step(1.0), vec![emit(10010, "/curve", &[0.25])]);
}

#[test]
fn test_trigger_stays_silent_before_first_event_on_seek() {
    let s = load(&[ev(10.0, "/kick", &[1.0])]);
    let mut r = Resolver::new(s.clone(), Some(&is_kick), 0.5);
    assert_eq!(r.step(1.0), vec![]);
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

// ---------------------------------------------------------------------------
// Bezier curves (session `type:"curve"` lines).

/// Linear 2-knot curve on `a` controlling args[arg] of the given template.
fn curve(a: &str, arg: usize, template: &[f64], span: [f64; 2], vals: [f64; 2]) -> Value {
    json!({
        "type": "curve", "port": 10010, "a": a, "arg": arg,
        "types": "f".repeat(template.len()), "args": template,
        "knots": [
            {"t": span[0], "v": vals[0]},
            {"t": span[1], "v": vals[1]},
        ],
    })
}

fn assert_first_near(out: &[Emit], want: f64) {
    assert_eq!(out.len(), 1, "expected one emission, got {out:?}");
    let got = out[0].2[0].as_f64().unwrap();
    assert!((got - want).abs() < 1e-9, "got {got}, want {want}");
}

#[test]
fn test_pump_interpolates_curve_per_step() {
    let s = load(&[curve("/x", 0, &[0.0], [0.0, 1.0], [0.0, 1.0])]);
    let mut r = resolver(&s);
    assert_first_near(&r.step(0.0), 0.0); // first step: seek catch-up
    assert_first_near(&r.step(0.25), 0.25);
    assert_first_near(&r.step(0.5), 0.5);
    assert_first_near(&r.step(0.75), 0.75);
}

#[test]
fn test_pump_lands_final_value_at_span_end_then_goes_quiet() {
    let s = load(&[curve("/x", 0, &[0.0], [0.0, 1.0], [0.0, 1.0])]);
    let mut r = resolver(&s);
    r.step(0.9);
    assert_first_near(&r.step(1.3), 1.0); // clamped to the span end
    assert_eq!(r.step(1.7), vec![]); // finished: no more samples
}

#[test]
fn test_pump_skips_duplicate_flat_samples() {
    let s = load(&[curve("/x", 0, &[0.0], [0.0, 1.0], [0.5, 0.5])]);
    let mut r = resolver(&s);
    assert_first_near(&r.step(0.0), 0.5);
    assert_eq!(r.step(0.2), vec![]); // same value: suppressed
    assert_eq!(r.step(0.4), vec![]);
}

#[test]
fn test_seek_resolves_curve_value_at_pos() {
    let s = load(&[curve("/x", 0, &[0.0], [1.0, 2.0], [0.0, 1.0])]);
    let mut r = resolver(&s);
    assert_first_near(&r.step(1.5), 0.5); // inside the span
    let mut r = resolver(&s);
    assert_first_near(&r.step(9.0), 1.0); // after: flat at the last knot
    let mut r = resolver(&s);
    assert_first_near(&r.step(0.2), 0.0); // before: clamps to the first knot
}

#[test]
fn test_event_vs_curve_latest_definition_wins() {
    let s = load(&[
        curve("/x", 0, &[0.0], [0.0, 1.0], [0.0, 1.0]),
        ev(2.0, "/x", &[9.0]),
    ]);
    // Curve span passed, then a later event: the event wins.
    let mut r = resolver(&s);
    assert_eq!(firsts(&r.step(3.0)), vec![9.0]);
    // Inside the span, before the event: the curve wins.
    let mut r = resolver(&s);
    assert_first_near(&r.step(0.5), 0.5);
    // Between span end and the event: the curve's end value still wins.
    let mut r = resolver(&s);
    assert_first_near(&r.step(1.5), 1.0);
}

#[test]
fn test_same_time_tie_goes_to_curve() {
    let s = load(&[
        ev(1.0, "/x", &[9.0]),
        curve("/x", 0, &[0.0], [0.0, 1.0], [0.0, 1.0]),
    ]);
    let mut r = resolver(&s);
    assert_first_near(&r.step(1.0), 1.0); // not 9.0
}

#[test]
fn test_curves_on_one_address_merge_into_one_message() {
    let s = load(&[
        curve("/xy", 0, &[0.0, 0.0], [0.0, 1.0], [0.0, 1.0]),
        curve("/xy", 1, &[0.0, 0.0], [0.0, 1.0], [1.0, 0.0]),
    ]);
    let mut r = resolver(&s);
    r.step(0.0);
    let out = r.step(0.25);
    assert_eq!(out.len(), 1);
    assert!((out[0].2[0].as_f64().unwrap() - 0.25).abs() < 1e-9);
    assert!((out[0].2[1].as_f64().unwrap() - 0.75).abs() < 1e-9);
}

#[test]
fn test_trigger_curve_suppressed_on_seek() {
    let s = load(&[curve("/kick", 0, &[0.0], [0.0, 1.0], [0.0, 1.0])]);
    let mut r = Resolver::new(s.clone(), Some(&is_kick), 0.5);
    assert_eq!(r.step(0.5), vec![]); // seek: triggers stay silent
}

#[test]
fn test_backward_seek_into_curve_reresolves() {
    let s = load(&[curve("/x", 0, &[0.0], [0.0, 1.0], [0.0, 1.0])]);
    let mut r = resolver(&s);
    r.step(2.0); // past the span: 1.0
    assert_first_near(&r.step(0.5), 0.5); // scrub back inside
}

#[test]
fn test_pump_resumes_after_seek_dedup() {
    let s = load(&[curve("/x", 0, &[0.0], [0.0, 2.0], [0.0, 1.0])]);
    let mut r = resolver(&s);
    r.step(1.0); // seek: 0.5, recorded as the group's last sample
    assert_first_near(&r.step(1.2), 0.6); // pump continues from there
}
