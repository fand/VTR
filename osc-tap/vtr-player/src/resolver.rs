//! Playback state resolver: turns a playhead position into OSC emissions.
//!
//! Port of `td/src/vtr_core/resolver.py` — the Python module stays the
//! executable conformance reference (see `td/tests/test_resolver.py`).
//! Two modes (protocol v2; see the top-level README):
//!
//! - Continuous forward (0 < step <= jump_threshold): event pump — every
//!   event in (prev, pos] in order, full fidelity, triggers fire.
//! - Anything else (first step after reset, forward jump, backward move):
//!   seek — per-address catch-up to the last value <= pos, one message per
//!   address, triggers suppressed. Steps with a known previous state only
//!   re-resolve the addresses touched in between.
//!
//! An address with no event <= pos emits nothing on seek: its pre-session
//! state is unknowable from the file.

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
        Self {
            session,
            jump_threshold,
            is_trigger,
            prev: None,
        }
    }

    /// Forget the previous position; the next step() seeks from scratch.
    pub fn reset(&mut self) {
        self.prev = None;
    }

    pub fn step(&mut self, pos: f64) -> Vec<Emit> {
        self.step_with_mode(pos).1
    }

    pub fn step_with_mode(&mut self, pos: f64) -> (Mode, Vec<Emit>) {
        let prev = self.prev.replace(pos);
        if self.session.is_empty() {
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

    fn pump(&self, prev: f64, pos: f64) -> Vec<Emit> {
        let lo = self.session.t.partition_point(|&x| x <= prev);
        let hi = self.session.t.partition_point(|&x| x <= pos);
        (lo..hi).map(|i| self.emit(i)).collect()
    }

    /// Addresses with at least one event in (t0, t1].
    fn touched(&self, t0: f64, t1: f64) -> Vec<usize> {
        let lo = self.session.t.partition_point(|&x| x <= t0);
        let hi = self.session.t.partition_point(|&x| x <= t1);
        let set: BTreeSet<usize> = self.session.addr_id[lo..hi]
            .iter()
            .map(|&a| a as usize)
            .collect();
        set.into_iter().collect()
    }

    fn catchup(&self, pos: f64, addr_ids: &[usize]) -> Vec<Emit> {
        let mut chosen: Vec<usize> = Vec::new();
        for &k in addr_ids {
            if self.is_trigger[k] {
                continue;
            }
            let j = self.session.addr_t[k].partition_point(|&x| x <= pos);
            if j > 0 {
                chosen.push(self.session.addr_events[k][j - 1]);
            }
        }
        chosen.sort_unstable(); // deterministic, time-ordered
        chosen.into_iter().map(|i| self.emit(i)).collect()
    }
}

/// Connection-layer wrapper adding snapshot dedup on seeks (per spec, new
/// vs. vtr_core): catch-up emissions exactly equal to the per-connection
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

    /// Forget position AND dedup state; the next step is a full catch-up.
    pub fn reset(&mut self) {
        self.inner.reset();
        self.last.clear();
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
    fn reset_clears_dedup_state() {
        let s = load(&[ev(1.0, "/a", vec![1.0])]);
        let mut r = dedup(&s);
        assert_eq!(r.step(2.0).1.len(), 1);
        r.reset();
        assert_eq!(r.step(2.0).1.len(), 1, "full catch-up after reset");
    }
}
