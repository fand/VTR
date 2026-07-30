//! Playback state resolver: turns a playhead position into OSC emissions.
//!
//! Semantics are defined by `tests/conformance_resolver.rs` (originally
//! ported from a Python reference, since removed).
//! Two modes (protocol v2; see the top-level README):
//!
//! - Continuous forward (0 < step <= jump_threshold): event pump — every
//!   event in (prev, pos] in order, full fidelity, triggers fire.
//! - Anything else (first step after reset, forward jump, backward move):
//!   seek — per-address catch-up to the last value <= pos, one message per
//!   address, triggers suppressed. Steps with a known previous state only
//!   re-resolve the addresses touched in between.
//!
//! On seek, an address whose events all lie after pos clamps to its first
//! event: values extend flat before the first data point, like DAW
//! automation left of its first point. Triggers stay suppressed.
//!
//! Bezier curves (session `type:"curve"` lines) resolve alongside events:
//! - Pump: after the recorded events, each curve group whose span overlaps
//!   the step emits its interpolated sample at min(pos, span end); a sample
//!   identical to the group's previous one is skipped (flat regions don't
//!   spam the tick rate).
//! - Seek: per address, the definition with the latest time <= pos wins —
//!   an event at its t, a curve at min(pos, span end) once pos >= span
//!   start; ties go to the curve (it is the edit layer). An address whose
//!   definitions all lie after pos clamps to the earliest one. Outside its
//!   span a curve extends flat, and triggers stay suppressed.

use std::collections::{BTreeSet, HashMap};
use std::sync::Arc;

use serde_json::Value;

use crate::session::Session;

/// (listen port, address, args) — the caller maps port through routes and sends.
pub type Emit = (u16, String, Vec<Value>);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Pump,
    Seek,
}

pub struct Resolver {
    session: Arc<Session>,
    jump_threshold: f64,
    is_trigger: Vec<bool>,
    prev: Option<f64>,
    /// Per curve group: the last synthesized args, so flat curve regions
    /// don't re-emit an unchanged message every tick.
    group_last: Vec<Option<Vec<Value>>>,
}

impl Resolver {
    pub fn new(
        session: Arc<Session>,
        trigger_matcher: Option<&dyn Fn(&str) -> bool>,
        jump_threshold: f64,
    ) -> Self {
        let is_trigger = session
            .addrs
            .iter()
            .map(|(addr, _port)| trigger_matcher.is_some_and(|m| m(addr)))
            .collect();
        let group_last = vec![None; session.curve_groups.len()];
        Self {
            session,
            jump_threshold,
            is_trigger,
            prev: None,
            group_last,
        }
    }

    /// Forget the previous position; the next step() seeks from scratch.
    pub fn reset(&mut self) {
        self.prev = None;
        self.group_last.fill(None);
    }

    pub fn step(&mut self, pos: f64) -> Vec<Emit> {
        self.step_with_mode(pos).1
    }

    pub fn step_with_mode(&mut self, pos: f64) -> (Mode, Vec<Emit>) {
        let prev = self.prev.replace(pos);
        if self.session.is_empty() && self.session.curve_groups.is_empty() {
            return (Mode::Seek, Vec::new());
        }
        let Some(prev) = prev else {
            let all: Vec<usize> = (0..self.session.addrs.len()).collect();
            return (Mode::Seek, self.catchup(pos, &all));
        };
        if pos == prev {
            return (Mode::Pump, Vec::new());
        }
        if pos < prev {
            let touched = self.touched(pos, prev);
            return (Mode::Seek, self.catchup(pos, &touched));
        }
        if pos - prev > self.jump_threshold {
            let touched = self.touched(prev, pos);
            return (Mode::Seek, self.catchup(pos, &touched));
        }
        (Mode::Pump, self.pump(prev, pos))
    }

    fn emit(&self, i: usize) -> Emit {
        let (addr, port) = self.session.event_addr(i);
        (*port, addr.clone(), self.session.event_args(i))
    }

    fn pump(&mut self, prev: f64, pos: f64) -> Vec<Emit> {
        let session = self.session.clone();
        let lo = session.t.partition_point(|&x| x <= prev);
        let hi = session.t.partition_point(|&x| x <= pos);
        // Events and curve samples merge in time order — a step can cross a
        // span end and a later event at once, and the later write must land
        // last (the seek rule). Curve samples clamp to the span end so the
        // final value always lands; same-time ties go to the curve.
        // (time, tiebreak, emission): usize::MAX sorts curves after events.
        let mut out: Vec<(f64, usize, Emit)> =
            (lo..hi).map(|i| (session.t[i], i, self.emit(i))).collect();
        for (g, group) in session.curve_groups.iter().enumerate() {
            if pos < group.start || prev >= group.end {
                continue;
            }
            let t = pos.min(group.end);
            let args = session.curve_group_args(g, t);
            if self.group_last[g].as_ref() == Some(&args) {
                continue;
            }
            let (addr, port) = &session.addrs[group.addr_id as usize];
            out.push((t, usize::MAX, (*port, addr.clone(), args.clone())));
            self.group_last[g] = Some(args);
        }
        out.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));
        out.into_iter().map(|(_, _, e)| e).collect()
    }

    /// Addresses with at least one event — or an active curve span — in (t0, t1].
    fn touched(&self, t0: f64, t1: f64) -> Vec<usize> {
        let lo = self.session.t.partition_point(|&x| x <= t0);
        let hi = self.session.t.partition_point(|&x| x <= t1);
        let mut set: BTreeSet<usize> = self.session.addr_id[lo..hi]
            .iter()
            .map(|&a| a as usize)
            .collect();
        for group in &self.session.curve_groups {
            // A curve's value moves continuously, so any span overlap counts.
            if group.start <= t1 && group.end > t0 {
                set.insert(group.addr_id as usize);
            }
        }
        set.into_iter().collect()
    }

    /// Full catch-up at `pos` without touching the playhead state: one
    /// message per address with its value at pos (triggers suppressed, like
    /// any seek). For mirror resyncs — position tracking and the curve
    /// dedup state are untouched.
    pub fn snapshot_at(&self, pos: f64) -> Vec<Emit> {
        if self.session.is_empty() && self.session.curve_groups.is_empty() {
            return Vec::new();
        }
        let all: Vec<usize> = (0..self.session.addrs.len()).collect();
        self.resolve_at(pos, &all).0
    }

    fn catchup(&mut self, pos: f64, addr_ids: &[usize]) -> Vec<Emit> {
        let (emits, sampled) = self.resolve_at(pos, addr_ids);
        // A seek lands the curve value, so pump dedup counts it as sent.
        for (g, args) in sampled {
            self.group_last[g] = Some(args);
        }
        emits
    }

    /// Resolve every address in `addr_ids` at `pos`. Returns the emissions
    /// plus the curve samples among them as (group, args); the caller
    /// decides whether they update the pump dedup state.
    fn resolve_at(&self, pos: f64, addr_ids: &[usize]) -> (Vec<Emit>, Vec<(usize, Vec<Value>)>) {
        let session = &self.session;
        // (definition time, tiebreak, event index or curve group).
        enum Src {
            Event(usize),
            Group(usize),
        }
        let mut chosen: Vec<(f64, usize, Src)> = Vec::new();
        for &k in addr_ids {
            if self.is_trigger[k] {
                continue;
            }
            let times = &session.addr_t[k];
            let j = times.partition_point(|&x| x <= pos);
            // Defined event: the last one at or before pos.
            let event = (j > 0).then(|| (times[j - 1], session.addr_events[k][j - 1]));
            // Defined curve: the group once pos has reached its span.
            let group = session.addr_group[k].filter(|&g| session.curve_groups[g].start <= pos);
            let pick = match (event, group) {
                // Latest definition wins; ties go to the curve (edit layer).
                (Some((et, i)), Some(g)) => {
                    let gt = pos.min(session.curve_groups[g].end);
                    if et > gt {
                        Src::Event(i)
                    } else {
                        Src::Group(g)
                    }
                }
                (Some((_, i)), None) => Src::Event(i),
                (None, Some(g)) => Src::Group(g),
                // Nothing defined at pos: clamp to the earliest definition
                // (values extend flat before the first data point).
                (None, None) => {
                    let ev0 = times.first().map(|&t| (t, session.addr_events[k][0]));
                    let grp = session.addr_group[k].map(|g| (session.curve_groups[g].start, g));
                    match (ev0, grp) {
                        (Some((et, i)), Some((gt, g))) => {
                            if et < gt {
                                Src::Event(i)
                            } else {
                                Src::Group(g)
                            }
                        }
                        (Some((_, i)), None) => Src::Event(i),
                        (None, Some((_, g))) => Src::Group(g),
                        (None, None) => continue,
                    }
                }
            };
            match pick {
                Src::Event(i) => chosen.push((session.t[i], i, Src::Event(i))),
                Src::Group(g) => {
                    let def = pos.min(session.curve_groups[g].end).max(session.curve_groups[g].start);
                    chosen.push((def, usize::MAX, Src::Group(g)));
                }
            }
        }
        // Deterministic, time-ordered; curve samples after same-time events.
        chosen.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));
        let mut sampled: Vec<(usize, Vec<Value>)> = Vec::new();
        let emits = chosen
            .into_iter()
            .map(|(_, _, src)| match src {
                Src::Event(i) => self.emit(i),
                Src::Group(g) => {
                    let args = session.curve_group_args(g, pos);
                    sampled.push((g, args.clone()));
                    let (addr, port) = &session.addrs[session.curve_groups[g].addr_id as usize];
                    (*port, addr.clone(), args)
                }
            })
            .collect();
        (emits, sampled)
    }
}

/// Connection-layer wrapper adding snapshot dedup on seeks (per spec —
/// not in the resolver core): catch-up emissions exactly equal to the per-connection
/// last-emitted value are skipped. Exact equality only — no epsilon
/// (archival fidelity). Pump emissions are never deduped but do update the
/// last-emitted values, so a later seek dedups against what was actually
/// sent.
pub struct DedupResolver {
    inner: Resolver,
    last: HashMap<(u16, String), Vec<Value>>,
}

impl DedupResolver {
    pub fn new(inner: Resolver) -> Self {
        Self {
            inner,
            last: HashMap::new(),
        }
    }

    /// Rebuild around a fresh resolver (session swap) while keeping the
    /// last-emitted values: receivers still hold them, so the catch-up
    /// after the swap must not re-send unchanged state.
    pub fn with_last(inner: Resolver, last: HashMap<(u16, String), Vec<Value>>) -> Self {
        Self { inner, last }
    }

    /// Move the last-emitted map out, for `with_last` on the next session.
    pub fn into_last(self) -> HashMap<(u16, String), Vec<Value>> {
        self.last
    }

    /// Forget position AND dedup state; the next step is a full catch-up.
    pub fn reset(&mut self) {
        self.inner.reset();
        self.last.clear();
    }

    /// Full-state snapshot at `pos`, bypassing dedup and leaving the
    /// last-emitted map alone: the caller mirrors it to a side channel, so
    /// the app's stream must not count these as already sent.
    pub fn snapshot_at(&self, pos: f64) -> Vec<Emit> {
        self.inner.snapshot_at(pos)
    }

    pub fn step(&mut self, pos: f64) -> (Mode, Vec<Emit>) {
        let (mode, emits) = self.inner.step_with_mode(pos);
        let emits = match mode {
            Mode::Pump => {
                for (port, addr, args) in &emits {
                    self.last.insert((*port, addr.clone()), args.clone());
                }
                emits
            }
            Mode::Seek => emits
                .into_iter()
                .filter(|(port, addr, args)| {
                    let key = (*port, addr.clone());
                    if self.last.get(&key) == Some(args) {
                        return false;
                    }
                    self.last.insert(key, args.clone());
                    true
                })
                .collect(),
        };
        (mode, emits)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session;
    use serde_json::json;
    use std::io::Write as _;

    fn load(lines: &[Value]) -> Arc<Session> {
        let mut f = tempfile::NamedTempFile::new().unwrap();
        for l in lines {
            writeln!(f, "{l}").unwrap();
        }
        Arc::new(session::load(f.path()).unwrap())
    }

    fn ev(t: f64, a: &str, args: Vec<f64>) -> Value {
        json!({"t": t, "port": 10010, "a": a, "types": "f".repeat(args.len()), "args": args})
    }

    fn dedup(s: &Arc<Session>) -> DedupResolver {
        DedupResolver::new(Resolver::new(s.clone(), None, 0.5))
    }

    #[test]
    fn seek_dedups_exact_equal_catchup() {
        // /a carries the same value at 1.0 and 4.0.
        let s = load(&[ev(1.0, "/a", vec![1.0]), ev(4.0, "/a", vec![1.0])]);
        let mut r = dedup(&s);
        let (mode, emits) = r.step(5.0);
        assert_eq!(mode, Mode::Seek);
        assert_eq!(emits.len(), 1);
        // Backward seek re-resolves /a (touched in (3,5]), but the catch-up
        // value equals the last emitted one.
        let (mode, emits) = r.step(3.0);
        assert_eq!(mode, Mode::Seek);
        assert_eq!(emits, vec![]);
    }

    #[test]
    fn near_equal_floats_are_not_deduped() {
        let s = load(&[
            ev(1.0, "/a", vec![1.0]),
            ev(2.0, "/a", vec![1.0 + 1e-12]),
        ]);
        let mut r = dedup(&s);
        r.step(1.4); // lands on 1.0
        // Jump past 2.0: catch-up value differs by 1e-12 -> emitted.
        let (_, emits) = r.step(5.0);
        assert_eq!(emits.len(), 1);
        assert_eq!(emits[0].2[0].as_f64().unwrap(), 1.0 + 1e-12);
    }

    #[test]
    fn dedup_state_is_per_connection() {
        let s = load(&[ev(1.0, "/a", vec![1.0])]);
        let mut r1 = dedup(&s);
        let mut r2 = dedup(&s);
        assert_eq!(r1.step(2.0).1.len(), 1);
        // A fresh connection must still get the full catch-up.
        assert_eq!(r2.step(2.0).1.len(), 1);
        // But r1 re-seeking stays quiet.
        assert_eq!(r1.step(3.0).1.len(), 0);
    }

    #[test]
    fn pump_updates_last_emitted() {
        let s = load(&[
            ev(1.0, "/a", vec![1.0]),
            ev(1.2, "/a", vec![7.0]),
            ev(2.0, "/a", vec![7.0]),
        ]);
        let mut r = dedup(&s);
        r.step(1.1); // seek lands on [1.0]
        let (mode, emits) = r.step(1.3); // pump emits [7.0]
        assert_eq!(mode, Mode::Pump);
        assert_eq!(emits.len(), 1);
        // Jump: catch-up (to the 2.0 event, also [7.0]) equals what the
        // pump actually sent -> deduped.
        let (mode, emits) = r.step(5.0);
        assert_eq!(mode, Mode::Seek);
        assert_eq!(emits, vec![]);
    }

    #[test]
    fn with_last_carries_dedup_across_sessions() {
        let s1 = load(&[ev(1.0, "/a", vec![1.0])]);
        let mut r1 = dedup(&s1);
        assert_eq!(r1.step(2.0).1.len(), 1);
        // Session swap, same current value: the carried state suppresses
        // the post-swap catch-up.
        let s2 = load(&[ev(1.0, "/a", vec![1.0]), ev(3.0, "/a", vec![2.0])]);
        let mut r2 =
            DedupResolver::with_last(Resolver::new(s2.clone(), None, 0.5), r1.into_last());
        assert_eq!(r2.step(2.0).1.len(), 0);
        // A changed value still emits.
        assert_eq!(r2.step(3.5).1.len(), 1);
    }

    #[test]
    fn seek_before_first_event_emits_once_then_dedups() {
        let s = load(&[ev(10.0, "/a", vec![5.0])]);
        let mut r = dedup(&s);
        // Seek before the first data point: extended first value emitted.
        let (mode, emits) = r.step(1.0);
        assert_eq!(mode, Mode::Seek);
        assert_eq!(emits.len(), 1);
        assert_eq!(emits[0].2[0].as_f64().unwrap(), 5.0);
        // Jump past the event, then scrub back before it: catch-up
        // re-resolves /a to the same value -> deduped, quiet.
        assert_eq!(r.step(11.0).1, vec![]);
        assert_eq!(r.step(2.0).1, vec![]);
        assert_eq!(r.step(1.0).1, vec![]);
    }

    #[test]
    fn snapshot_at_returns_every_address_and_leaves_state_alone() {
        let s = load(&[
            ev(1.0, "/a", vec![1.0]),
            ev(2.0, "/b", vec![2.0]),
            ev(3.0, "/a", vec![3.0]),
        ]);
        let mut r = dedup(&s);
        assert_eq!(r.step(10.0).1.len(), 2);
        // Everything is up to date: a plain re-seek stays quiet...
        assert_eq!(r.step(9.0).1.len(), 0);
        // ...but a snapshot returns the full state anyway.
        let snap = r.snapshot_at(9.0);
        assert_eq!(snap.len(), 2);
        assert_eq!(snap[0].1, "/b");
        assert_eq!(snap[1].1, "/a");
        assert_eq!(snap[1].2[0].as_f64().unwrap(), 3.0);
        // And it disturbs neither dedup nor position tracking.
        assert_eq!(r.step(8.0).1.len(), 0);
    }

    #[test]
    fn reset_clears_dedup_state() {
        let s = load(&[ev(1.0, "/a", vec![1.0])]);
        let mut r = dedup(&s);
        assert_eq!(r.step(2.0).1.len(), 1);
        r.reset();
        assert_eq!(r.step(2.0).1.len(), 1, "full catch-up after reset");
    }
}
