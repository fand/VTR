//! TS↔Rust curve parity: the editor draws with `shared/curve.ts` while
//! playback resolves with `curve::value_at`. Both are hand-written copies of
//! the same de Casteljau + 48-step bisection, so the golden fixture pins
//! them to bit-identical results — drift in either copy fails here and in
//! the editor's `curve.test.ts`, which reads the same file.
//!
//! Regenerate the fixture from the TS side only when the semantics
//! deliberately change (see the fixture's `comment` field).

use serde_json::Value;
use vtr_player::curve::{value_at, Knot};

fn handle(k: &Value, key: &str) -> Option<[f64; 2]> {
    let a = k.get(key)?.as_array()?;
    Some([a[0].as_f64().unwrap(), a[1].as_f64().unwrap()])
}

#[test]
fn value_at_matches_the_editor_fixture_bit_for_bit() {
    let raw = include_str!("fixtures/curve_eval.json");
    let fx: Value = serde_json::from_str(raw).unwrap();
    for case in fx["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let knots: Vec<Knot> = case["knots"]
            .as_array()
            .unwrap()
            .iter()
            .map(|k| Knot {
                t: k["t"].as_f64().unwrap(),
                v: k["v"].as_f64().unwrap(),
                i: handle(k, "i"),
                o: handle(k, "o"),
            })
            .collect();
        let samples = case["samples"].as_array().unwrap();
        let expected = case["expected"].as_array().unwrap();
        assert_eq!(samples.len(), expected.len(), "{name}: malformed fixture");
        for (ts, want) in samples.iter().zip(expected) {
            let t = ts.as_f64().unwrap();
            let want = want.as_f64().unwrap();
            let got = value_at(&knots, t);
            assert_eq!(
                got.to_bits(),
                want.to_bits(),
                "{name} at t={t}: got {got}, want {want}"
            );
        }
    }
}
