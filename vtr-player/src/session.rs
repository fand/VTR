//! Columnar in-memory model of an exported session.jsonl.
//!
//! Semantics are defined by `tests/conformance_session.rs` (originally
//! ported from a Python reference, since removed).
//! Events are stored as columns so multi-million-event sessions stay
//! compact; per-address indexes make seek catch-up a binary search.

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::Path;

use anyhow::{Context, Result};
use serde_json::Value;

use crate::curve::{self, Knot};
use crate::pick;

/// OSC type tags whose args can live in the shared float pool. Everything
/// else (strings, blobs, bools, ...) keeps its parsed args in `raw_args`
/// verbatim.
const NUMERIC_TAGS: &str = "fdih";
const INT_TAGS: &str = "ih";

/// One `type:"curve"` line, address interned into `Session::addrs`.
#[derive(Debug)]
pub struct Curve {
    pub addr_id: u32,
    pub arg: usize,
    pub types: String,
    pub template: Vec<Value>,
    pub knots: Vec<Knot>,
}

/// All curves on one address, merged into a single message per sample.
/// Members are arg-sorted; the first one's template supplies the untouched
/// args. The span is the union of the members' knot spans.
#[derive(Debug)]
pub struct CurveGroup {
    pub addr_id: u32,
    pub members: Vec<usize>,
    pub start: f64,
    pub end: f64,
}

#[derive(Debug, Default)]
pub struct Session {
    // Event columns, time-sorted.
    pub t: Vec<f64>,
    pub addr_id: Vec<u32>,
    pub types_id: Vec<u32>,
    pub arg_off: Vec<usize>,
    pub arg_len: Vec<usize>,
    pub argpool: Vec<f64>,
    /// Event index -> args, for non-numeric events.
    pub raw_args: HashMap<usize, Vec<Value>>,
    // Tables.
    /// id -> (address, listen port)
    pub addrs: Vec<(String, u16)>,
    pub types_tbl: Vec<String>,
    // Per-address event indices (time-ordered) and their times.
    pub addr_events: Vec<Vec<usize>>,
    pub addr_t: Vec<Vec<f64>>,
    // Bezier curves and their per-address groups.
    pub curves: Vec<Curve>,
    pub curve_groups: Vec<CurveGroup>,
    /// addr id -> index into `curve_groups`, or none.
    pub addr_group: Vec<Option<usize>>,
    // Header / trailer.
    /// listen port -> forward port
    pub routes: HashMap<u16, u16>,
    pub duration: f64,
    /// Malformed lines dropped during load.
    pub skipped: u64,
}

impl Session {
    pub fn len(&self) -> usize {
        self.t.len()
    }

    pub fn is_empty(&self) -> bool {
        self.t.is_empty()
    }

    /// (address, listen port) of event i.
    pub fn event_addr(&self, i: usize) -> &(String, u16) {
        &self.addrs[self.addr_id[i] as usize]
    }

    /// Args of event i, ints restored per the OSC type tags.
    pub fn event_args(&self, i: usize) -> Vec<Value> {
        if let Some(raw) = self.raw_args.get(&i) {
            return raw.clone();
        }
        let off = self.arg_off[i];
        let vals = &self.argpool[off..off + self.arg_len[i]];
        let types = &self.types_tbl[self.types_id[i] as usize];
        types
            .chars()
            .zip(vals)
            .map(|(tag, &v)| {
                if INT_TAGS.contains(tag) {
                    Value::from(v as i64)
                } else {
                    Value::from(v)
                }
            })
            .collect()
    }

    /// Merged message for curve group g at time t: the first member's
    /// template with each controlled arg replaced by its winning curve's
    /// interpolated value (int-tagged args rounded). Several curves on one
    /// arg follow the event rule: the one with the latest definition time
    /// (`min(t, span end)` once `t >= span start`) wins, ties go to the
    /// later line (the newer edit); before every span the earliest curve
    /// supplies its flat-left value. Values extend flat outside a span.
    pub fn curve_group_args(&self, g: usize, t: f64) -> Vec<Value> {
        let group = &self.curve_groups[g];
        let mut args = self.curves[group.members[0]].template.clone();
        // Members are arg-sorted; each run of one arg picks a single winner.
        let mut i = 0;
        while i < group.members.len() {
            let arg = self.curves[group.members[i]].arg;
            let mut j = i + 1;
            while j < group.members.len() && self.curves[group.members[j]].arg == arg {
                j += 1;
            }
            let run = &group.members[i..j];
            i = j;
            // Line order = candidate order, so ties go to the newer edit.
            let cands: Vec<pick::Candidate> = run
                .iter()
                .map(|&m| {
                    let knots = &self.curves[m].knots;
                    let start = knots[0].t;
                    ((start <= t).then(|| t.min(knots[knots.len() - 1].t)), start)
                })
                .collect();
            let (w, _) = pick::pick_latest_or_earliest(&cands).expect("run is non-empty");
            let m = run[w];
            let c = &self.curves[m];
            let v = curve::value_at(&c.knots, t);
            let val = match c.types.chars().nth(c.arg) {
                Some(tag) if INT_TAGS.contains(tag) => Value::from(v.round() as i64),
                _ => Value::from(v),
            };
            while args.len() <= c.arg {
                args.push(Value::Null);
            }
            args[c.arg] = val;
        }
        args
    }
}

fn parse_routes(routes: Option<&Value>) -> HashMap<u16, u16> {
    let mut out = HashMap::new();
    let Some(Value::Array(items)) = routes else {
        return out;
    };
    for r in items {
        let s = match r {
            Value::String(s) => s.clone(),
            other => other.to_string(),
        };
        if let Some((src, dst)) = s.split_once("->") {
            if let (Ok(src), Ok(dst)) = (src.parse::<u16>(), dst.parse::<u16>()) {
                out.insert(src, dst);
            }
        }
    }
    out
}

/// Load a session.jsonl. Malformed lines are counted, never fatal.
pub fn load(path: &Path) -> Result<Session> {
    let file = File::open(path).with_context(|| format!("open {path:?}"))?;
    let reader = BufReader::new(file);
    let mut values: Vec<Option<Value>> = Vec::new();
    for line in reader.lines() {
        let line = line?;
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        values.push(serde_json::from_str::<Value>(line).ok());
    }
    Ok(build(values))
}

/// Build a session from already-parsed event objects (the control API's
/// inline `load`). Same schema as session.jsonl lines; marker lines
/// (`type`) are honored, non-objects count as skipped.
pub fn from_values(values: Vec<Value>) -> Session {
    build(values.into_iter().map(Some).collect())
}

/// Shared builder: `None` entries are unparseable lines (counted skipped).
fn build(values: Vec<Option<Value>>) -> Session {
    let mut ts: Vec<f64> = Vec::new();
    let mut addr_ids: Vec<u32> = Vec::new();
    let mut types_ids: Vec<u32> = Vec::new();
    let mut offs: Vec<usize> = Vec::new();
    let mut lens: Vec<usize> = Vec::new();
    let mut pool: Vec<f64> = Vec::new();
    let mut raw: HashMap<usize, Vec<Value>> = HashMap::new();
    let mut addr_map: HashMap<(String, u16), u32> = HashMap::new();
    let mut addrs: Vec<(String, u16)> = Vec::new();
    let mut types_map: HashMap<String, u32> = HashMap::new();
    let mut types_tbl: Vec<String> = Vec::new();
    let mut routes: HashMap<u16, u16> = HashMap::new();
    let mut duration: Option<f64> = None;
    let mut skipped: u64 = 0;
    let mut curves: Vec<Curve> = Vec::new();

    for obj in values {
        let Some(obj) = obj else {
            skipped += 1;
            continue;
        };
        let Some(obj) = obj.as_object() else {
            skipped += 1;
            continue;
        };
        match obj.get("type") {
            Some(t) if t == "session_start" => {
                routes = parse_routes(obj.get("routes"));
                continue;
            }
            Some(t) if t == "session_end" => {
                if let Some(t) = obj.get("t").and_then(Value::as_f64) {
                    duration = Some(t);
                }
                continue;
            }
            Some(t) if t == "curve" => {
                match curve::parse(obj) {
                    Some(cd) => {
                        let key = (cd.addr, cd.port);
                        let aid = *addr_map.entry(key.clone()).or_insert_with(|| {
                            addrs.push(key);
                            (addrs.len() - 1) as u32
                        });
                        curves.push(Curve {
                            addr_id: aid,
                            arg: cd.arg,
                            types: cd.types,
                            template: cd.template,
                            knots: cd.knots,
                        });
                    }
                    None => skipped += 1,
                }
                continue;
            }
            // Unknown control line: tolerate for forward compat.
            Some(_) => continue,
            None => {}
        }
        let (Some(t), Some(port), Some(addr)) = (
            obj.get("t").and_then(Value::as_f64),
            obj.get("port")
                .and_then(Value::as_u64)
                .and_then(|p| u16::try_from(p).ok()),
            obj.get("a").and_then(Value::as_str),
        ) else {
            skipped += 1;
            continue;
        };
        let args: Vec<Value> = match obj.get("args") {
            Some(Value::Array(a)) => a.clone(),
            _ => Vec::new(),
        };
        let types = match obj.get("types") {
            Some(Value::String(s)) => s.clone(),
            _ => String::new(),
        };

        let key = (addr.to_string(), port);
        let aid = *addr_map
            .entry(key.clone())
            .or_insert_with(|| {
                addrs.push(key);
                (addrs.len() - 1) as u32
            });
        let tid = *types_map.entry(types.clone()).or_insert_with(|| {
            types_tbl.push(types.clone());
            (types_tbl.len() - 1) as u32
        });

        let i = ts.len();
        ts.push(t);
        addr_ids.push(aid);
        types_ids.push(tid);
        let numeric = types.chars().count() == args.len()
            && types.chars().all(|tag| NUMERIC_TAGS.contains(tag))
            && args.iter().all(Value::is_number);
        if numeric {
            offs.push(pool.len());
            lens.push(args.len());
            pool.extend(args.iter().filter_map(Value::as_f64));
        } else {
            offs.push(0);
            lens.push(0);
            raw.insert(i, args);
        }
    }

    // Exports are time-sorted already; reorder defensively if not.
    if ts.windows(2).any(|w| w[1] < w[0]) {
        let mut order: Vec<usize> = (0..ts.len()).collect();
        order.sort_by(|&a, &b| ts[a].total_cmp(&ts[b]));
        let inv: HashMap<usize, usize> =
            order.iter().enumerate().map(|(new, &old)| (old, new)).collect();
        raw = raw.into_iter().map(|(i, a)| (inv[&i], a)).collect();
        ts = order.iter().map(|&i| ts[i]).collect();
        addr_ids = order.iter().map(|&i| addr_ids[i]).collect();
        types_ids = order.iter().map(|&i| types_ids[i]).collect();
        offs = order.iter().map(|&i| offs[i]).collect();
        lens = order.iter().map(|&i| lens[i]).collect();
    }

    let mut addr_events: Vec<Vec<usize>> = vec![Vec::new(); addrs.len()];
    let mut addr_t: Vec<Vec<f64>> = vec![Vec::new(); addrs.len()];
    for (i, (&aid, &t)) in addr_ids.iter().zip(&ts).enumerate() {
        addr_events[aid as usize].push(i);
        addr_t[aid as usize].push(t);
    }

    // Group curves per address (one merged message per sample).
    let mut addr_group: Vec<Option<usize>> = vec![None; addrs.len()];
    let mut curve_groups: Vec<CurveGroup> = Vec::new();
    for (ci, c) in curves.iter().enumerate() {
        let slot = &mut addr_group[c.addr_id as usize];
        let gi = match *slot {
            Some(g) => g,
            None => {
                curve_groups.push(CurveGroup {
                    addr_id: c.addr_id,
                    members: Vec::new(),
                    start: f64::INFINITY,
                    end: f64::NEG_INFINITY,
                });
                let g = curve_groups.len() - 1;
                *slot = Some(g);
                g
            }
        };
        let g = &mut curve_groups[gi];
        g.members.push(ci);
        g.start = g.start.min(c.knots[0].t);
        g.end = g.end.max(c.knots[c.knots.len() - 1].t);
    }
    for g in &mut curve_groups {
        g.members.sort_by_key(|&m| curves[m].arg);
    }

    let duration = duration.unwrap_or_else(|| {
        let last_event = ts.last().copied().unwrap_or(0.0);
        curve_groups
            .iter()
            .fold(last_event, |acc, g| acc.max(g.end))
    });

    Session {
        t: ts,
        addr_id: addr_ids,
        types_id: types_ids,
        arg_off: offs,
        arg_len: lens,
        argpool: pool,
        raw_args: raw,
        addrs,
        types_tbl,
        addr_events,
        addr_t,
        curves,
        curve_groups,
        addr_group,
        routes,
        duration,
        skipped,
    }
}
