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

/// The expected emission for an `ev`/`curve` line: those helpers tag every
/// arg `f`, and the resolver carries the recorded tags through to the OSC
/// encoder, so the tags are part of what a step must produce.
fn emit(port: u16, a: &str, args: &[f64]) -> Emit {
    Emit {
        port,
        addr: a.to_string(),
        types: "f".repeat(args.len()),
        args: args.iter().map(|&v| json!(v)).collect(),
    }
}

fn resolver(s: &Arc<Session>) -> Resolver {
    Resolver::new(s.clone(), None, 0.5)
}

fn is_kick(addr: &str) -> bool {
    addr.starts_with("/kick")
}

/// First float arg of each emission.
fn firsts(out: &[Emit]) -> Vec<f64> {
    out.iter().map(|e| e.args[0].as_f64().unwrap()).collect()
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

/// Curve on `a` with hand-written knots (step flags, mixed segments).
fn curve_knots(a: &str, arg: usize, template: &[f64], knots: Value) -> Value {
    json!({
        "type": "curve", "port": 10010, "a": a, "arg": arg,
        "types": "f".repeat(template.len()), "args": template,
        "knots": knots,
    })
}

fn assert_first_near(out: &[Emit], want: f64) {
    assert_eq!(out.len(), 1, "expected one emission, got {out:?}");
    let got = out[0].args[0].as_f64().unwrap();
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
    assert!((out[0].args[0].as_f64().unwrap() - 0.25).abs() < 1e-9);
    assert!((out[0].args[1].as_f64().unwrap() - 0.75).abs() < 1e-9);
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

#[test]
fn test_pump_orders_curve_sample_and_events_by_time() {
    // One step crosses the span end (sample clamps to t=1.0) and a later
    // event: the event is the later write and must land last.
    let s = load(&[
        curve("/x", 0, &[0.0], [0.0, 1.0], [0.0, 1.0]),
        ev(1.1, "/x", &[9.0]),
    ]);
    let mut r = resolver(&s);
    r.step(0.95);
    assert_eq!(firsts(&r.step(1.15)), vec![1.0, 9.0]);
}

#[test]
fn test_pump_same_time_tie_goes_to_curve() {
    // Event exactly at the span end: the curve is the edit layer and wins.
    let s = load(&[
        curve("/x", 0, &[0.0], [0.0, 1.0], [0.0, 1.0]),
        ev(1.0, "/x", &[9.0]),
    ]);
    let mut r = resolver(&s);
    r.step(0.95);
    assert_eq!(firsts(&r.step(1.05)), vec![9.0, 1.0]);
}

#[test]
fn test_seek_before_event_and_curve_clamps_to_the_earliest_definition() {
    // Both definitions lie after pos: clamp to the earlier one.
    // Event first: its value extends flat-left.
    let s = load(&[
        ev(2.0, "/x", &[9.0]),
        curve("/x", 0, &[0.0], [5.0, 6.0], [0.5, 1.0]),
    ]);
    let mut r = resolver(&s);
    assert_eq!(firsts(&r.step(1.0)), vec![9.0]);
    // Curve first: its flat-left value wins.
    let s = load(&[
        ev(7.0, "/x", &[9.0]),
        curve("/x", 0, &[0.0], [5.0, 6.0], [0.5, 1.0]),
    ]);
    let mut r = resolver(&s);
    assert_first_near(&r.step(1.0), 0.5);
    // Same time: the tie goes to the curve (edit layer), like everywhere.
    let s = load(&[
        ev(5.0, "/x", &[9.0]),
        curve("/x", 0, &[0.0], [5.0, 6.0], [0.5, 1.0]),
    ]);
    let mut r = resolver(&s);
    assert_first_near(&r.step(1.0), 0.5);
}

#[test]
fn test_same_arg_curves_with_disjoint_spans_take_turns() {
    // Two curves on one (addr, arg): A ramps [1,2], B ramps [10,11]. The
    // one with the latest definition time <= pos wins, so A plays its span
    // and holds until B's span starts.
    let s = load(&[
        curve("/x", 0, &[0.0], [1.0, 2.0], [0.0, 1.0]),
        curve("/x", 0, &[0.0], [10.0, 11.0], [5.0, 6.0]),
    ]);
    let mut r = resolver(&s);
    assert_first_near(&r.step(0.5), 0.0); // before both: A's flat-left
    let mut r = resolver(&s);
    assert_first_near(&r.step(1.5), 0.5); // inside A
    let mut r = resolver(&s);
    assert_first_near(&r.step(5.0), 1.0); // between: A's end holds
    let mut r = resolver(&s);
    assert_first_near(&r.step(10.5), 5.5); // inside B
    // Pump through A's span: A interpolates, B stays out of the way.
    let mut r = resolver(&s);
    r.step(1.0);
    assert_first_near(&r.step(1.25), 0.25);
}

#[test]
fn test_events_in_a_gap_between_curve_pieces_win() {
    // Track priority overdubs a take over a curve: the export carves the
    // curve into pieces around the take (epsilon-shrunk so its edges don't
    // shadow the take's edge events) and keeps the take's events in the
    // gap. The gap must play the take, not the left piece's held end.
    let s = load(&[
        curve("/x", 0, &[0.0], [0.0, 1.999_999], [0.0, 1.0]),
        curve("/x", 0, &[0.0], [4.000_001, 10.0], [5.0, 6.0]),
        ev(2.0, "/x", &[7.0]),
        ev(3.0, "/x", &[8.0]),
    ]);
    // Seek into the gap: the take's last event outranks the left piece.
    let mut r = resolver(&s);
    assert_eq!(firsts(&r.step(3.0)), vec![8.0]);
    // Pump across the punch-in: the left piece lands its end value, then
    // the take's event — and nothing clobbers it further into the gap.
    let mut r = resolver(&s);
    r.step(1.95);
    assert_eq!(firsts(&r.step(2.05)), vec![1.0, 7.0]);
    assert_eq!(r.step(2.5), vec![]);
    assert_eq!(firsts(&r.step(3.0)), vec![8.0]);
    assert_eq!(r.step(3.4), vec![]);
    // The right piece takes over once its span starts.
    let mut r = resolver(&s);
    assert_first_near(&r.step(4.000_001), 5.0);
    let mut r = resolver(&s);
    assert_first_near(&r.step(11.0), 6.0);
}

#[test]
fn test_right_piece_takes_over_from_its_start_after_a_gap_event() {
    let s = load(&[
        curve("/x", 0, &[0.0], [0.0, 2.0], [0.0, 1.0]),
        curve("/x", 0, &[0.0], [4.0, 6.0], [5.0, 6.0]),
        ev(3.0, "/x", &[9.0]),
    ]);
    let mut r = resolver(&s);
    assert_eq!(firsts(&r.step(3.5)), vec![9.0]); // in the gap: the event
    assert_first_near(&r.step(4.0), 5.0); // pump into the right piece
    assert_first_near(&r.step(5.0), 5.5); // jump: seek picks it too
    // Same from a cold seek straight into the right span.
    let mut r = resolver(&s);
    assert_first_near(&r.step(4.5), 5.25);
}

#[test]
fn test_gap_without_events_still_holds_the_left_piece() {
    // No events in the gap: unchanged behavior — the left piece's flat
    // end value holds until the right piece starts.
    let s = load(&[
        curve("/x", 0, &[0.0], [0.0, 2.0], [0.0, 1.0]),
        curve("/x", 0, &[0.0], [4.0, 6.0], [5.0, 6.0]),
    ]);
    let mut r = resolver(&s);
    r.step(1.8);
    assert_first_near(&r.step(2.2), 1.0); // pump lands the end value
    assert_eq!(r.step(2.6), vec![]); // gap: quiet, the value stands
    assert_eq!(r.step(3.0), vec![]);
    assert_eq!(r.step(3.8), vec![]);
    assert_first_near(&r.step(4.2), 5.1); // the right piece takes over
    let mut r = resolver(&s);
    assert_first_near(&r.step(3.0), 1.0); // seek into the gap: the same value
}

#[test]
fn test_overlapping_args_merge_but_a_disjoint_piece_is_its_own_group() {
    let s = load(&[
        curve("/xy", 0, &[0.0, 0.0], [0.0, 2.0], [0.0, 2.0]),
        curve("/xy", 1, &[0.0, 0.0], [1.0, 3.0], [1.0, 0.0]),
        curve("/xy", 0, &[0.0, 0.0], [8.0, 10.0], [4.0, 5.0]),
    ]);
    assert_eq!(s.curve_groups.len(), 2);
    // Overlapping spans (different args) stay one merged message.
    let mut r = resolver(&s);
    r.step(1.0);
    let out = r.step(1.5);
    assert_eq!(out.len(), 1, "one message per sample: {out:?}");
    assert!((out[0].args[0].as_f64().unwrap() - 1.5).abs() < 1e-9);
    assert!((out[0].args[1].as_f64().unwrap() - 0.75).abs() < 1e-9);
    // The disjoint piece is its own group: it wins alone past its start and
    // sends its own template for the args it doesn't control.
    let mut r = resolver(&s);
    let out = r.step(9.0);
    assert_eq!(out.len(), 1);
    assert!((out[0].args[0].as_f64().unwrap() - 4.5).abs() < 1e-9);
    assert_eq!(out[0].args[1], json!(0.0));
}

// ---------------------------------------------------------------------------
// Step segments (knot `s`): the value holds at the left knot's `v` until the
// next knot's t, then jumps.

/// A held value is the knot's `v` verbatim — no bezier math ran on it.
fn assert_first_exact(out: &[Emit], want: f64) {
    assert_eq!(out.len(), 1, "expected one emission, got {out:?}");
    let got = out[0].args[0].as_f64().unwrap();
    assert_eq!(got.to_bits(), want.to_bits(), "got {got}, want {want}");
}

#[test]
fn test_pump_holds_a_step_span_without_duplicate_emissions() {
    let s = load(&[curve_knots(
        "/x",
        0,
        &[0.0],
        json!([{"t": 0.0, "v": 0.25, "s": true}, {"t": 1.0, "v": 0.75}]),
    )]);
    let mut r = resolver(&s);
    assert_first_exact(&r.step(0.0), 0.25); // first step: seek catch-up
    assert_eq!(r.step(0.3), vec![]); // held: dedup suppresses the resample
    assert_eq!(r.step(0.6), vec![]);
    assert_eq!(r.step(0.999), vec![]);
    assert_first_exact(&r.step(1.0), 0.75); // the jump lands on the knot
    assert_eq!(r.step(1.4), vec![]); // span finished
}

#[test]
fn test_step_value_jumps_exactly_at_the_right_knot() {
    let s = load(&[curve_knots(
        "/x",
        0,
        &[0.0],
        json!([
            {"t": 0.0, "v": 0.25, "s": true},
            {"t": 1.0, "v": 0.75, "s": true},
            {"t": 2.0, "v": 0.5},
        ]),
    )]);
    for (t, want) in [
        (0.5, 0.25),
        (0.999_999, 0.25),
        (1.0, 0.75),
        (1.5, 0.75),
        (1.999_999, 0.75),
        (2.0, 0.5),
    ] {
        let mut r = resolver(&s);
        assert_first_exact(&r.step(t), want);
    }
}

#[test]
fn test_seek_into_a_step_span_resolves_the_held_value() {
    let s = load(&[curve_knots(
        "/x",
        0,
        &[0.0],
        json!([{"t": 1.0, "v": 0.25, "s": true}, {"t": 2.0, "v": 0.75}]),
    )]);
    let mut r = resolver(&s);
    assert_first_exact(&r.step(1.75), 0.25); // inside the hold
    let mut r = resolver(&s);
    assert_first_exact(&r.step(0.2), 0.25); // before: clamps to the first knot
    let mut r = resolver(&s);
    assert_first_exact(&r.step(9.0), 0.75); // after: flat at the last knot
    let mut r = resolver(&s);
    r.step(9.0);
    assert_first_exact(&r.step(1.25), 0.25); // scrub back into the hold
}

#[test]
fn test_mixed_step_and_bezier_segments_in_one_curve() {
    // [0,1) holds 0.2; [1,2) interpolates 0.4 -> 0.8; [2,3) holds 0.8.
    let s = load(&[curve_knots(
        "/x",
        0,
        &[0.0],
        json!([
            {"t": 0.0, "v": 0.2, "s": true},
            {"t": 1.0, "v": 0.4},
            {"t": 2.0, "v": 0.8, "s": true},
            {"t": 3.0, "v": 0.1},
        ]),
    )]);
    let mut r = resolver(&s);
    assert_first_exact(&r.step(0.0), 0.2);
    assert_eq!(r.step(0.4), vec![]); // still held
    // Jump onto the knot; its own segment is bezier, so the bisection's
    // ~1 ulp shows up here (same in the editor's evalCurve) — near, not exact.
    assert_first_near(&r.step(1.0), 0.4);
    assert_first_near(&r.step(1.4), 0.56); // bezier segment interpolates
    assert_first_near(&r.step(1.8), 0.72);
    assert_first_exact(&r.step(2.0), 0.8); // hold takes over at its knot
    assert_eq!(r.step(2.4), vec![]);
    assert_eq!(r.step(2.8), vec![]);
    assert_first_exact(&r.step(3.0), 0.1); // last knot: the final jump
}

#[test]
fn test_same_arg_nested_span_yields_back_to_the_outer_curve() {
    // Outer [0,10] ramp, inner [2,4] flat 9 (appended later). Inside the
    // inner span the inner curve wins the def-time tie; after it ends the
    // outer curve's later definition takes over again.
    let s = load(&[
        curve("/x", 0, &[0.0], [0.0, 10.0], [0.0, 1.0]),
        curve("/x", 0, &[0.0], [2.0, 4.0], [9.0, 9.0]),
    ]);
    let mut r = resolver(&s);
    assert_first_near(&r.step(3.0), 9.0); // inner wins the tie at pos
    let mut r = resolver(&s);
    assert_first_near(&r.step(5.0), 0.5); // outer def 5 > inner def 4
}
