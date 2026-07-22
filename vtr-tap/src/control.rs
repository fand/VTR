use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixListener;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use anyhow::{Context, Result};
use serde_json::{json, Value};

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
    // Remove a stale socket from a previous run.
    if path.exists() {
        std::fs::remove_file(path).with_context(|| format!("remove stale socket {path:?}"))?;
    }
    let listener = UnixListener::bind(path).with_context(|| format!("bind {path:?}"))?;
    for stream in listener.incoming() {
        let Ok(stream) = stream else { continue };
        let handle = handle.clone();
        thread::spawn(move || {
            let Ok(writer) = stream.try_clone() else { return };
            let reader = BufReader::new(stream);
            if let Err(e) = serve_conn(reader, writer, handle) {
                eprintln!("vtr-tap: control conn error: {e}");
            }
        });
    }
    Ok(())
}

/// Generic over the stream halves so a future Windows transport (TCP or
/// named pipe) only swaps the listener loop in `serve`.
fn serve_conn<R, W>(reader: R, writer: W, handle: Handle) -> std::io::Result<()>
where
    R: BufRead,
    W: Write + Send + 'static,
{
    // Shared writer: `wait` blocks for up to WAIT_TIMEOUT, so it replies
    // from its own thread; other id-multiplexed requests on this connection
    // must not stall behind it. Out-of-order replies are fine — the editor
    // matches by id.
    let writer = Arc::new(Mutex::new(writer));
    for line in reader.lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let request: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(e) => {
                let resp = json!({"ok": false, "error": format!("bad json: {e}")});
                write_response(&writer, &resp)?;
                continue;
            }
        };
        if request["cmd"].as_str() == Some("wait") {
            let handle = handle.clone();
            let writer = writer.clone();
            thread::spawn(move || {
                let resp = with_id(&request, wait_response(&request, &handle));
                // Connection may be gone by the time the wait wakes.
                let _ = write_response(&writer, &resp);
            });
            continue;
        }
        let resp = with_id(&request, dispatch_value(&request, &handle));
        write_response(&writer, &resp)?;
    }
    Ok(())
}

fn write_response<W: Write>(writer: &Arc<Mutex<W>>, resp: &Value) -> std::io::Result<()> {
    let mut w = writer.lock().unwrap();
    w.write_all(resp.to_string().as_bytes())?;
    w.write_all(b"\n")
}

/// Echo the request id so the client can match replies to requests.
fn with_id(request: &Value, mut response: Value) -> Value {
    if let Some(id) = request.get("id") {
        response["id"] = id.clone();
    }
    response
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

pub fn dispatch(line: &str, handle: &Handle) -> Value {
    let request: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(e) => return json!({"ok": false, "error": format!("bad json: {e}")}),
    };
    with_id(&request, dispatch_value(&request, handle))
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
