use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::Path;
use std::thread;

use anyhow::{Context, Result};
use serde_json::{json, Value};

use crate::tap::Handle;

/// Serve the JSON Lines control API on a unix domain socket. Blocks forever.
///
/// Requests:  {"cmd":"start"} | {"cmd":"stop"} | {"cmd":"status"}
/// Responses: {"ok":true,...} | {"ok":false,"error":"..."}
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
            if let Err(e) = serve_conn(stream, handle) {
                eprintln!("osc-tap: control conn error: {e}");
            }
        });
    }
    Ok(())
}

fn serve_conn(stream: UnixStream, handle: Handle) -> std::io::Result<()> {
    let reader = BufReader::new(stream.try_clone()?);
    let mut writer = stream;
    for line in reader.lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let response = dispatch(&line, &handle);
        writer.write_all(response.to_string().as_bytes())?;
        writer.write_all(b"\n")?;
    }
    Ok(())
}

pub fn dispatch(line: &str, handle: &Handle) -> Value {
    let request: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(e) => return json!({"ok": false, "error": format!("bad json: {e}")}),
    };
    match request["cmd"].as_str() {
        Some("start") => match handle.start_clip() {
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
        _ => json!({"ok": false, "error": "unknown cmd"}),
    }
}
