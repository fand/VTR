use std::path::Path;
use std::time::Duration;

use anyhow::Result;
use serde_json::{Value, json};
use vtr_core::jsonl_server::{self, ControlError, ControlResult, Reply};

use crate::tap::Handle;

/// Under the editor's 30s client timeout, so quiet waits return (empty)
/// instead of timing out client-side.
const WAIT_TIMEOUT: Duration = Duration::from_secs(25);

/// Serve the JSON Lines control API on a unix domain socket. Blocks forever.
///
/// Requests:  {"cmd":"start","dir"?:"/abs/path","tl"?:T,"rate"?:R}
///          | {"cmd":"stop"} | {"cmd":"status"} | {"cmd":"wait","since"?:N}
///          | {"cmd":"monitor","since"?:N}
/// Responses: {"ok":true,...} | {"ok":false,"error":"..."}
///
/// `wait` long-polls the event log: blocks until an event with seq > since
/// exists, then replies {"ok":true,"seq":M,"events":[...]}. Timeout replies
/// with empty events. A `since` that predates the buffer (overflow) or comes
/// from another process — or a missing `since` (baseline) — replies
/// "reset":true plus a full "status" snapshot to re-baseline from.
///
/// `monitor` long-polls the live OSC log the same way, replying
/// {"ok":true,"seq":M,"lines":[...]}. Resets carry no snapshot — the
/// stream just continues from the returned seq. Polling is what turns
/// monitor capture on; an unpolled tap skips the work.
pub fn serve(path: &Path, handle: Handle) -> Result<()> {
    // Stateless per connection: every request is answered from the shared
    // tap handle.
    jsonl_server::serve(
        path,
        "vtr-tap",
        || (),
        move |request, _: &mut ()| {
            // Long-polls block for up to WAIT_TIMEOUT, so they answer off-thread.
            if request["cmd"].as_str() == Some("wait") {
                let handle = handle.clone();
                return Reply::defer(move |request| wait_response(request, &handle));
            }
            if request["cmd"].as_str() == Some("monitor") {
                let handle = handle.clone();
                return Reply::defer(move |request| monitor_response(request, &handle));
            }
            Reply::Now(dispatch_value(request, &handle))
        },
    )
}

fn wait_response(request: &Value, handle: &Handle) -> ControlResult {
    let log = handle.event_log();
    let (seq, events, reset) = match request.get("since").and_then(Value::as_u64) {
        Some(n) => {
            let r = log.wait_since(n, WAIT_TIMEOUT);
            (r.seq, r.events, r.reset)
        }
        // No cursor = baseline request: current seq + snapshot, no events.
        None => (log.newest(), Vec::new(), true),
    };
    let mut resp = json!({"seq": seq, "events": events});
    if reset {
        // seq was read BEFORE this snapshot: an event landing in between is
        // > seq and gets delivered on the next wait; the snapshot may just
        // be newer than seq, which the editor's idempotent apply tolerates.
        // The reverse order would swallow transitions.
        let status = handle.status()?;
        resp["reset"] = json!(true);
        resp["status"] = serde_json::to_value(status).unwrap_or(Value::Null);
    }
    Ok(resp)
}

/// Answer one request line without a socket, for tests.
pub fn dispatch(line: &str, handle: &Handle) -> Value {
    match serde_json::from_str::<Value>(line) {
        Ok(request) => {
            let result = dispatch_value(&request, handle);
            jsonl_server::response(&request, result)
        }
        // No id to echo: the request never parsed.
        Err(e) => jsonl_server::response(&Value::Null, Err(ControlError::BadJson(e.to_string()))),
    }
}

fn monitor_response(request: &Value, handle: &Handle) -> ControlResult {
    let log = handle.monitor_log();
    let (seq, lines, reset) = match request.get("since").and_then(Value::as_u64) {
        Some(n) => {
            let r = log.wait_since(n, WAIT_TIMEOUT);
            (r.seq, r.events, r.reset)
        }
        // No cursor = baseline request: current seq, no lines.
        None => (log.newest(), Vec::new(), true),
    };
    let mut resp = json!({"seq": seq, "lines": lines});
    if reset {
        resp["reset"] = json!(true);
    }
    Ok(resp)
}

fn dispatch_value(request: &Value, handle: &Handle) -> ControlResult {
    match request["cmd"].as_str() {
        Some("start") => {
            let clip = handle.start_clip(
                request["dir"].as_str().map(Into::into),
                request["tl"].as_f64(),
                request["rate"].as_f64(),
            )?;
            Ok(json!({ "clip": clip }))
        }
        Some("stop") => {
            handle.stop_clip()?;
            Ok(json!({}))
        }
        Some("status") => Ok(json!({"status": handle.status()?})),
        Some("wait") => Err("wait not supported here".into()),
        Some("monitor") => Err("monitor not supported here".into()),
        _ => Err(ControlError::UnknownCmd),
    }
}
