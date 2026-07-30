//! Unix-socket JSON Lines control API, same framing/id-echo style as the
//! tap's, but **stateful per connection**: each connection owns a
//! dedup-wrapped resolver, so per-frame `resolve` calls return deltas.
//!
//! Requests:  {"cmd":"load","path":"…"|"events":[…],"name"?:"…","duration"?:D,
//!             "triggers"?:[…],"routes"?:{"10010":9000},
//!             "origin"?:"…","keep"?:true}
//!          | {"cmd":"resolve","t":T} | {"cmd":"resolve","follow":true}
//!          | {"cmd":"play"|"stop"|"seek","origin"?:"…"[,"t":T]}
//!          | {"cmd":"watch","gen":N} | {"cmd":"status"}
//! Responses: {"ok":true,...} | {"ok":false,"error":"..."}
//!
//! `events` is the inline form of `load`: the same objects as session.jsonl
//! lines, parsed — the editor uses it to sync its unexported project without
//! touching disk. `resolve` with `follow` resolves at the push transport's
//! playhead (reply carries `t`), so a client can track the transport that
//! `play`/`stop`/`seek` (or relayed `/vtr/*`) drive.
//!
//! Transport replies carry `gen` (a counter that bumps on every accepted
//! mutation) and `origin` (who wrote last). A follower suppresses its own
//! echo by applying a state only when `gen` moved and `origin` is not its
//! own. `watch` long-polls: it blocks until `gen` differs from the given
//! value (or a ~1 s timeout), then replies with the current transport
//! snapshot — the transport-axis analogue of the tap's `wait`.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixListener;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::Duration;

use anyhow::{Context, Result};
use serde_json::{Map, Value, json};

use crate::pattern::TriggerPatterns;
use crate::resolver::{DedupResolver, Mode, Resolver};
use crate::session;
use crate::state::{LoadedSession, SharedState};
use crate::transport::Transport;

pub struct Ctx {
    pub shared: Arc<SharedState>,
    pub transport: Transport,
    pub connections: AtomicU64,
}

/// `watch` long-poll timeout: on no change, reply with the same gen and
/// let the client re-issue. Bounds per-request blocking, not correctness.
const WATCH_TIMEOUT: Duration = Duration::from_millis(1000);

/// Per-connection resolver, rebuilt when the session epoch moves (a `load`
/// anywhere resets every connection: the next `resolve` is a full
/// catch-up).
struct ConnState {
    epoch: u64,
    resolver: Option<DedupResolver>,
}

fn origin_of(request: &Value) -> &str {
    request["origin"].as_str().unwrap_or("")
}

/// Serve the control API. Blocks forever.
pub fn serve(path: &Path, ctx: Arc<Ctx>) -> Result<()> {
    if path.exists() {
        std::fs::remove_file(path).with_context(|| format!("remove stale socket {path:?}"))?;
    }
    let listener = UnixListener::bind(path).with_context(|| format!("bind {path:?}"))?;
    for stream in listener.incoming() {
        let Ok(stream) = stream else { continue };
        let ctx = ctx.clone();
        thread::spawn(move || {
            ctx.connections.fetch_add(1, Ordering::Relaxed);
            let result = (|| -> std::io::Result<()> {
                let mut writer = stream.try_clone()?;
                let reader = BufReader::new(stream);
                let mut conn = ConnState {
                    epoch: 0,
                    resolver: None,
                };
                for line in reader.lines() {
                    let line = line?;
                    if line.trim().is_empty() {
                        continue;
                    }
                    let resp = dispatch_line(&line, &ctx, &mut conn);
                    writer.write_all(resp.to_string().as_bytes())?;
                    writer.write_all(b"\n")?;
                }
                Ok(())
            })();
            ctx.connections.fetch_sub(1, Ordering::Relaxed);
            if let Err(e) = result {
                eprintln!("vtr-player: control conn error: {e}");
            }
        });
    }
    Ok(())
}

fn dispatch_line(line: &str, ctx: &Ctx, conn: &mut ConnState) -> Value {
    let request: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(e) => return json!({"ok": false, "error": format!("bad json: {e}")}),
    };
    let mut response = dispatch(&request, ctx, conn);
    if let Some(id) = request.get("id") {
        response["id"] = id.clone();
    }
    response
}

fn dispatch(request: &Value, ctx: &Ctx, conn: &mut ConnState) -> Value {
    match request["cmd"].as_str() {
        Some("load") => load(request, ctx),
        Some("resolve") => resolve(request, ctx, conn),
        Some("play") => {
            ctx.transport.play(origin_of(request));
            transport_reply(ctx)
        }
        Some("stop") => {
            ctx.transport.stop(origin_of(request));
            transport_reply(ctx)
        }
        Some("seek") => {
            let Some(t) = request["t"].as_f64().filter(|v| v.is_finite()) else {
                return json!({"ok": false, "error": "missing t"});
            };
            ctx.transport.request_seek(t, origin_of(request));
            transport_reply(ctx)
        }
        Some("watch") => watch(request, ctx),
        Some("status") => status(ctx),
        _ => json!({"ok": false, "error": "unknown cmd"}),
    }
}

fn transport_json(s: &crate::transport::TransportSnap) -> Value {
    json!({
        "ok": true,
        "playing": s.playing,
        "playhead": s.t,
        "gen": s.generation,
        "origin": s.origin,
    })
}

fn transport_reply(ctx: &Ctx) -> Value {
    transport_json(&ctx.transport.snapshot())
}

/// Long-poll the transport: block until `gen` moves (or a timeout), then
/// reply with the current snapshot. A timeout replies with the same gen.
fn watch(request: &Value, ctx: &Ctx) -> Value {
    let since = request["gen"].as_u64().unwrap_or(0);
    transport_json(&ctx.transport.watch(since, WATCH_TIMEOUT))
}

fn parse_route_overrides(v: Option<&Value>) -> HashMap<u16, u16> {
    let mut out = HashMap::new();
    let Some(Value::Object(map)) = v else {
        return out;
    };
    for (k, v) in map {
        if let (Ok(src), Some(dst)) = (
            k.parse::<u16>(),
            v.as_u64().and_then(|p| u16::try_from(p).ok()),
        ) {
            out.insert(src, dst);
        }
    }
    out
}

fn load(request: &Value, ctx: &Ctx) -> Value {
    let triggers: Vec<String> = request["triggers"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|v| v.as_str().map(String::from))
        .collect();
    let (mut s, label) = if let Some(path) = request["path"].as_str() {
        match session::load(Path::new(path)) {
            Ok(s) => (s, path.to_string()),
            Err(e) => return json!({"ok": false, "error": format!("load failed: {e}")}),
        }
    } else if let Some(events) = request["events"].as_array() {
        let label = request["name"].as_str().unwrap_or("(inline)").to_string();
        (session::from_values(events.clone()), label)
    } else {
        return json!({"ok": false, "error": "missing path or events"});
    };
    // Inline sessions have no session_end marker; let the caller state the
    // project duration instead of falling back to the last event's t.
    if let Some(d) = request["duration"].as_f64().filter(|v| v.is_finite()) {
        s.duration = d;
    }
    let mut routes = s.routes.clone();
    routes.extend(parse_route_overrides(request.get("routes")));

    let routes_json: Map<String, Value> = routes
        .iter()
        .map(|(src, dst)| (src.to_string(), json!(dst)))
        .collect();
    let reply = json!({
        "ok": true,
        "duration": s.duration,
        "routes": routes_json,
        "events": s.len(),
        "addresses": s.addrs.len(),
        "skipped": s.skipped,
    });

    let loaded = Arc::new(LoadedSession {
        path: PathBuf::from(label),
        session: Arc::new(s),
        triggers: TriggerPatterns::compile(&triggers),
        routes,
    });
    // Swap atomically; every connection's resolver resets via the epoch
    // bump (next resolve is a full catch-up). `keep` swaps the session
    // without touching the transport — no stop, no rewind, no gen bump —
    // so a live edit (the editor's residency reload) lands mid-playback
    // without yanking every follower to 0. The default stop+rewind stays
    // for File-workflow clients (the tox), stamped with the loader's
    // origin so the loader's own follower can suppress the echo.
    ctx.shared.swap(loaded);
    if request["keep"].as_bool() != Some(true) {
        ctx.transport.on_load(origin_of(request));
    }
    reply
}

fn resolve(request: &Value, ctx: &Ctx, conn: &mut ConnState) -> Value {
    // One transport snapshot for the whole reply: follow resolves at its
    // playhead, and gen/origin let the client suppress its own echo.
    let tr = ctx.transport.snapshot();
    let t = if request["follow"].as_bool() == Some(true) {
        tr.t
    } else {
        let Some(t) = request["t"].as_f64().filter(|v| v.is_finite()) else {
            return json!({"ok": false, "error": "missing t"});
        };
        t
    };
    let (epoch, loaded) = ctx.shared.snapshot();
    let Some(loaded) = loaded else {
        return json!({"ok": false, "error": "no session loaded"});
    };
    if conn.resolver.is_none() || conn.epoch != epoch {
        conn.epoch = epoch;
        conn.resolver = Some(DedupResolver::new(Resolver::new(
            loaded.session.clone(),
            Some(&|a: &str| loaded.triggers.matches(a)),
            0.5,
        )));
    }
    let (mode, emits) = conn.resolver.as_mut().unwrap().step(t);
    let events: Vec<Value> = emits
        .into_iter()
        .map(|(port, addr, args)| json!([port, addr, args]))
        .collect();
    json!({
        "ok": true,
        "mode": match mode { Mode::Pump => "pump", Mode::Seek => "seek" },
        "t": t,
        "playing": tr.playing,
        "gen": tr.generation,
        "origin": tr.origin,
        "events": events,
    })
}

fn status(ctx: &Ctx) -> Value {
    let (_, loaded) = ctx.shared.snapshot();
    let s = ctx.transport.snapshot();
    json!({
        "ok": true,
        "status": {
            "loaded": loaded.map(|l| l.path.clone()),
            "playing": s.playing,
            "playhead": s.t,
            "gen": s.generation,
            "origin": s.origin,
            "connections": ctx.connections.load(Ordering::Relaxed),
        }
    })
}
