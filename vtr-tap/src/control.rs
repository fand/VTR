use std::path::Path;
use std::time::Duration;

use anyhow::Result;
use serde_json::{Value, json};
use vtr_core::jsonl_server::{self, Reply};

use crate::tap::Handle;

/// Under the editor's 30s client timeout, so quiet waits return (empty)
/// instead of timing out client-side.
const WAIT_TIMEOUT: Duration = Duration::from_secs(25);

/// Serve the JSON Lines control API on a unix domain socket. Blocks forever.
///
/// Requests:  {"cmd":"start","dir"?:"/abs/path","tl"?:T,"rate"?:R}
///          | {"cmd":"stop"} | {"cmd":"status"} | {"cmd":"wait","since"?:N}
/// Responses: {"ok":true,...} | {"ok":false,"error":"..."}
///
/// `wait` long-polls the event log: blocks until an event with seq > since
/// exists, then replies {"ok":true,"seq":M,"events":[...]}. Timeout replies
/// with empty events. A `since` that predates the buffer (overflow) or comes
/// from another process — or a missing `since` (baseline) — replies
/// "reset":true plus a full "status" snapshot to re-baseline from.
pub fn serve(path: &Path, handle: Handle) -> Result<()> {
    // Stateless per connection: every request is answered from the shared
    // tap handle.
    jsonl_server::serve(
        path,
        "vtr-tap",
        || (),
        move |request, _: &mut ()| {
            // `wait` blocks for up to WAIT_TIMEOUT, so it answers off-thread.
            if request["cmd"].as_str() == Some("wait") {
                let handle = handle.clone();
                return Reply::defer(move |request| wait_response(request, &handle));
            }
            Reply::Now(dispatch_value(request, &handle))
        },
    )
}

fn wait_response(request: &Value, handle: &Handle) -> Value {
    let log = handle.event_log();
    let (seq, events, reset) = match request.get("since").and_then(Value::as_u64) {
        Some(n) => {
            let r = log.wait_since(n, WAIT_TIMEOUT);
            (r.seq, r.events, r.reset)
        }
        // No cursor = baseline request: current seq + snapshot, no events.
        None => (log.newest(), Vec::new(), true),
    };
    let mut resp = json!({"ok": true, "seq": seq, "events": events});
    if reset {
        // seq was read BEFORE this snapshot: an event landing in between is
        // > seq and gets delivered on the next wait; the snapshot may just
        // be newer than seq, which the editor's idempotent apply tolerates.
        // The reverse order would swallow transitions.
        match handle.status() {
            Ok(status) => {
                resp["reset"] = json!(true);
                resp["status"] = serde_json::to_value(status).unwrap_or(Value::Null);
            }
            Err(e) => return json!({"ok": false, "error": e}),
        }
    }
    resp
}

/// Answer one request line without a socket, for tests.
pub fn dispatch(line: &str, handle: &Handle) -> Value {
    let request: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(e) => return json!({"ok": false, "error": format!("bad json: {e}")}),
    };
    jsonl_server::with_id(&request, dispatch_value(&request, handle))
}

fn dispatch_value(request: &Value, handle: &Handle) -> Value {
    match request["cmd"].as_str() {
        Some("start") => match handle.start_clip(
            request["dir"].as_str().map(Into::into),
            request["tl"].as_f64(),
            request["rate"].as_f64(),
        ) {
            Ok(path) => json!({"ok": true, "clip": path}),
            Err(e) => json!({"ok": false, "error": e}),
        },
        Some("stop") => match handle.stop_clip() {
            Ok(()) => json!({"ok": true}),
            Err(e) => json!({"ok": false, "error": e}),
        },
        Some("status") => match handle.status() {
            Ok(status) => json!({"ok": true, "status": status}),
            Err(e) => json!({"ok": false, "error": e}),
        },
        Some("wait") => json!({"ok": false, "error": "wait not supported here"}),
        _ => json!({"ok": false, "error": "unknown cmd"}),
    }
}
