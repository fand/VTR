//! Bezier curve lines (`type:"curve"`): parsing and evaluation.
//!
//! A curve controls one numeric arg of an address over its knots' time
//! span. Consecutive knots span one cubic segment (p1 = knot + o handle,
//! p2 = next + i handle; missing handle = linear third), unless the left
//! knot carries `s`: then the segment is a step that holds the left value.
//! Outside the span the value extends flat, mirroring the seek rule for
//! discrete data.
//! Semantics are defined by `tests/conformance_resolver.rs` /
//! `tests/conformance_session.rs`; the schema by the top-level README.

use serde_json::{Map, Value};

#[derive(Debug, Clone)]
pub struct Knot {
    pub t: f64,
    pub v: f64,
    /// Incoming handle offset [dt, dv], dt <= 0.
    pub i: Option<[f64; 2]>,
    /// Outgoing handle offset [dt, dv], dt >= 0.
    pub o: Option<[f64; 2]>,
    /// Step segment: the value holds at `v` until the next knot's t, then
    /// jumps. `o` and the next knot's `i` are dead — ignored, not rejected.
    /// Meaningless on the last knot (flat extension already holds).
    pub s: bool,
}

/// A parsed curve line, address not yet interned.
#[derive(Debug, Clone)]
pub struct CurveData {
    pub port: u16,
    pub addr: String,
    /// Controlled arg index in the template.
    pub arg: usize,
    pub types: String,
    /// Message template; emissions replace `template[arg]`.
    pub template: Vec<Value>,
    pub knots: Vec<Knot>,
}

fn parse_handle(v: Option<&Value>) -> Option<[f64; 2]> {
    let arr = v?.as_array()?;
    if arr.len() != 2 {
        return None;
    }
    Some([arr[0].as_f64()?, arr[1].as_f64()?])
}

/// Parse a `type:"curve"` object. None = malformed (caller counts skipped).
pub fn parse(obj: &Map<String, Value>) -> Option<CurveData> {
    let port = u16::try_from(obj.get("port")?.as_u64()?).ok()?;
    let addr = obj.get("a")?.as_str()?.to_string();
    let arg = usize::try_from(obj.get("arg")?.as_u64()?).ok()?;
    let template: Vec<Value> = match obj.get("args") {
        Some(Value::Array(a)) => a.clone(),
        _ => return None,
    };
    if arg >= template.len() {
        return None;
    }
    let types = match obj.get("types") {
        Some(Value::String(s)) => s.clone(),
        _ => String::new(),
    };
    let knots_json = obj.get("knots")?.as_array()?;
    let mut knots = Vec::with_capacity(knots_json.len());
    for k in knots_json {
        let k = k.as_object()?;
        knots.push(Knot {
            t: k.get("t")?.as_f64()?,
            v: k.get("v")?.as_f64()?,
            i: parse_handle(k.get("i")),
            o: parse_handle(k.get("o")),
            s: k.get("s").and_then(Value::as_bool).unwrap_or(false),
        });
    }
    if knots.len() < 2 || knots.windows(2).any(|w| w[1].t <= w[0].t) {
        return None;
    }
    Some(CurveData {
        port,
        addr,
        arg,
        types,
        template,
        knots,
    })
}

type Ctrl = [(f64, f64); 4];

/// Control points of the segment between k0 and k1. Handle dt is clamped so
/// x stays inside the segment (hand-written files keep monotone time).
fn segment_ctrl(k0: &Knot, k1: &Knot) -> Ctrl {
    let span = k1.t - k0.t;
    let p1 = match k0.o {
        Some([dt, dv]) => (k0.t + dt.clamp(0.0, span), k0.v + dv),
        None => (k0.t + span / 3.0, k0.v + (k1.v - k0.v) / 3.0),
    };
    let p2 = match k1.i {
        Some([dt, dv]) => (k1.t + dt.clamp(-span, 0.0), k1.v + dv),
        None => (k1.t - span / 3.0, k1.v - (k1.v - k0.v) / 3.0),
    };
    [(k0.t, k0.v), p1, p2, (k1.t, k1.v)]
}

/// De Casteljau evaluation: repeated lerps keep flat spans exactly flat
/// (Bernstein weights drift by ~1 ulp, which would defeat the resolver's
/// duplicate-sample suppression).
fn bez(p: &Ctrl, u: f64) -> (f64, f64) {
    let lerp = |a: f64, b: f64| a + (b - a) * u;
    let q0 = (lerp(p[0].0, p[1].0), lerp(p[0].1, p[1].1));
    let q1 = (lerp(p[1].0, p[2].0), lerp(p[1].1, p[2].1));
    let q2 = (lerp(p[2].0, p[3].0), lerp(p[2].1, p[3].1));
    let r0 = (lerp(q0.0, q1.0), lerp(q0.1, q1.1));
    let r1 = (lerp(q1.0, q2.0), lerp(q1.1, q2.1));
    (lerp(r0.0, r1.0), lerp(r0.1, r1.1))
}

/// Curve value at time t: bisection for the u where x(u) = t, flat outside
/// the span.
pub fn value_at(knots: &[Knot], t: f64) -> f64 {
    let first = &knots[0];
    let last = &knots[knots.len() - 1];
    if t <= first.t {
        return first.v;
    }
    if t >= last.t {
        return last.v;
    }
    // Rightmost knot with knot.t <= t.
    let seg = knots.partition_point(|k| k.t <= t) - 1;
    // Step segment: hold the left value; the jump lands on the right knot.
    if knots[seg].s {
        return knots[seg].v;
    }
    let p = segment_ctrl(&knots[seg], &knots[seg + 1]);
    let (mut lo, mut hi) = (0.0_f64, 1.0_f64);
    for _ in 0..48 {
        let mid = (lo + hi) / 2.0;
        if bez(&p, mid).0 < t {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    bez(&p, (lo + hi) / 2.0).1
}
