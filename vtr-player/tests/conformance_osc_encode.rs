//! Conformance suite for the recorded-tag → replayed-OSC chain: a
//! `session.jsonl` line, through the resolver, to the bytes the push
//! transport hands to rosc.
//!
//! README.md's JSONL schema requires replay to encode by the line's `types`
//! rather than by guessing from the JSON value. `r`, `I` and out-of-range
//! `h` args are all recorded as JSON strings, so guessing sends them back
//! out as OSC strings — a different message signature from the one that was
//! recorded. These tests pin the tags all the way through.

use std::io::Write as _;
use std::sync::Arc;

use rosc::{OscColor, OscType};
use serde_json::{json, Value};
use vtr_core::osc_json;
use vtr_player::resolver::Resolver;
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

/// Resolve at `t` and encode every emission the way the push transport does.
fn replay(lines: &[Value], t: f64) -> Vec<(String, Vec<OscType>)> {
    let s = load(lines);
    Resolver::new(s, None, 0.5)
        .step(t)
        .into_iter()
        .map(|e| (e.addr, osc_json::args_from_json(&e.types, &e.args)))
        .collect()
}

const COLOR: OscColor = OscColor {
    red: 255,
    green: 0,
    blue: 16,
    alpha: 32,
};

#[test]
fn test_string_shaped_args_replay_as_their_recorded_types() {
    let out = replay(
        &[json!({
            "t": 1.0, "port": 10010, "a": "/pad", "types": "rIh",
            "args": ["#ff001020", "<impulse>", "-12345678901234567"],
        })],
        2.0,
    );
    assert_eq!(
        out,
        vec![(
            "/pad".to_string(),
            vec![
                OscType::Color(COLOR),
                OscType::Inf,
                OscType::Long(-12345678901234567),
            ]
        )]
    );
}

#[test]
fn test_numeric_args_replay_at_their_recorded_width() {
    // The float pool holds all four as f64; only the tags say which OSC
    // type each came in as.
    let out = replay(
        &[json!({
            "t": 1.0, "port": 10010, "a": "/mix", "types": "fdih",
            "args": [0.42, 0.5, 7, 7],
        })],
        2.0,
    );
    assert_eq!(
        out,
        vec![(
            "/mix".to_string(),
            vec![
                OscType::Float(0.42),
                OscType::Double(0.5),
                OscType::Int(7),
                OscType::Long(7),
            ]
        )]
    );
}

#[test]
fn test_curve_samples_carry_the_curve_lines_types() {
    // args[0] is swept by the curve, args[1] comes from the template. Both
    // must keep the curve line's tags.
    let out = replay(
        &[json!({
            "type": "curve", "port": 10010, "a": "/x", "arg": 0,
            "types": "di", "args": [0.0, 3],
            "knots": [{"t": 0.0, "v": 0.0}, {"t": 4.0, "v": 1.0}],
        })],
        4.0,
    );
    assert_eq!(
        out,
        vec![(
            "/x".to_string(),
            vec![OscType::Double(1.0), OscType::Int(3)]
        )]
    );
}

#[test]
fn test_lines_without_types_fall_back_to_guessing() {
    // Pre-`types` clips and editor-added events. Integral numbers become
    // Int, the rest Float — the old, tagless behavior.
    let out = replay(
        &[json!({"t": 1.0, "port": 10010, "a": "/old", "args": [7, 0.25, "hi"]})],
        2.0,
    );
    assert_eq!(
        out,
        vec![(
            "/old".to_string(),
            vec![
                OscType::Int(7),
                OscType::Float(0.25),
                OscType::String("hi".into()),
            ]
        )]
    );
}
