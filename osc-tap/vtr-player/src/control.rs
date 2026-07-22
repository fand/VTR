//! Unix-socket JSON Lines control API, same framing/id-echo style as the
//! tap's, but **stateful per connection**: each connection owns a
//! dedup-wrapped resolver, so per-frame `resolve` calls return deltas.
//!
//! Requests:  {"cmd":"load","path":"…"|"events":[…],"name"?:"…","duration"?:D,
//!             "triggers"?:[…],"routes"?:{"10010":9000}}
//!          | {"cmd":"resolve","t":T} | {"cmd":"resolve","follow":true}
//!          | {"cmd":"play"} | {"cmd":"stop"} | {"cmd":"seek","t":T}
//!          | {"cmd":"status"}
//! Responses: {"ok":true,...} | {"ok":false,"error":"..."}
//!
//! `events` is the inline form of `load`: the same objects as session.jsonl
//! lines, parsed — the editor uses it to sync its unexported project without
//! touching disk. `resolve` with `follow` resolves at the push transport's
//! playhead (reply carries `t`), so a client can track the transport that
//! `play`/`stop`/`seek` (or relayed `/vtr/*`) drive.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixListener;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;

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

/// Per-connection resolver, rebuilt when the session epoch moves (a `load`
/// anywhere resets every connection: the next `resolve` is a full
/// catch-up).
struct ConnState {
    epoch: u64,
    resolver: Option<DedupResolver>,
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
            ctx.transport.play("");
            transport_reply(ctx)
        }
        Some("stop") => {
            ctx.transport.stop("");
            transport_reply(ctx)
        }
        Some("seek") => {
            let Some(t) = request["t"].as_f64().filter(|v| v.is_finite()) else {
                return json!({"ok": false, "error": "missing t"});
            };
            ctx.transport.request_seek(t, "");
            transport_reply(ctx)
        }
        Some("status") => status(ctx),
        _ => json!({"ok": false, "error": "unknown cmd"}),
    }
}

fn transport_reply(ctx: &Ctx) -> Value {
    json!({
        "ok": true,
        "playing": ctx.transport.playing(),
        "playhead": ctx.transport.playhead(),
    })
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
    // Swap atomically; the transport stops and every connection's resolver
    // resets via the epoch bump.
    ctx.shared.swap(loaded);
    ctx.transport.on_load();
    reply
}

fn resolve(request: &Value, ctx: &Ctx, conn: &mut ConnState) -> Value {
    // follow: resolve at the push transport's playhead, so a per-frame
    // client can track a transport someone else drives (editor preview).
    let t = if request["follow"].as_bool() == Some(true) {
        ctx.transport.playhead()
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
        "playing": ctx.transport.playing(),
        "events": events,
    })
}

fn status(ctx: &Ctx) -> Value {
    let (_, loaded) = ctx.shared.snapshot();
    json!({
        "ok": true,
        "status": {
            "loaded": loaded.map(|l| l.path.clone()),
            "playing": ctx.transport.playing(),
            "playhead": ctx.transport.playhead(),
            "connections": ctx.connections.load(Ordering::Relaxed),
        }
    })
}
