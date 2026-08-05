//! Client for the tap's control socket: long-polls the `wait` API and turns
//! the recording event log into player state. Two consumers:
//!
//! - the rec LED / mirror suppression in `Echo` (`set_rec`), fed by both the
//!   baseline status snapshot and the `rec_started`/`rec_stopped` events;
//! - punch-in: on `rec_started` the transport is primed to the take's
//!   timeline position and started, so whatever follows the transport (TD,
//!   the editor) lands on the punch-in point without any rec awareness of
//!   its own.
//!
//! Priming fires on the *event* only, never on a baseline snapshot: a player
//! that (re)connects mid-take sees `recording: true` in the baseline but has
//! no `tl` to prime with, so it leaves the transport alone. Accepted — the
//! take is already running and nobody asked for a seek.

use std::io::{BufRead, BufReader, Write as _};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use anyhow::Result;
use serde_json::{json, Value};

use crate::echo::Echo;
use crate::state::SharedState;
use crate::transport::Transport;

/// Wait this long after a dropped or refused connection before retrying —
/// the tap may just be restarting, and a busy loop would spin a core.
const RECONNECT_BACKOFF: Duration = Duration::from_secs(1);

/// Long-poll the tap's `wait` API for rec transitions; reconnect with
/// backoff. Each (re)connect starts with a cursor-less `wait` whose baseline
/// status snapshot seeds the rec state without waiting for a change.
pub fn spawn(
    path: PathBuf,
    echo: Echo,
    transport: Transport,
    shared: Arc<SharedState>,
) -> Result<()> {
    echo.set_follows_tap();
    thread::Builder::new()
        .name("tap-client".into())
        .spawn(move || loop {
            if let Ok(stream) = UnixStream::connect(&path) {
                let _ = follow(&echo, &transport, &shared, stream);
            }
            thread::sleep(RECONNECT_BACKOFF);
        })?;
    Ok(())
}

fn follow(
    echo: &Echo,
    transport: &Transport,
    shared: &SharedState,
    stream: UnixStream,
) -> std::io::Result<()> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut writer = stream;
    let read_reply = |r: &mut BufReader<UnixStream>| -> std::io::Result<Value> {
        let mut line = String::new();
        if r.read_line(&mut line)? == 0 {
            return Err(std::io::Error::from(std::io::ErrorKind::UnexpectedEof));
        }
        serde_json::from_str(&line).map_err(std::io::Error::other)
    };

    // Baseline: no cursor -> reset + status snapshot with the current
    // recording flag.
    let mut seq: Option<u64> = None;
    loop {
        match seq {
            None => writeln!(writer, "{}", json!({"cmd": "wait"}))?,
            Some(n) => writeln!(writer, "{}", json!({"cmd": "wait", "since": n}))?,
        }
        let resp = read_reply(&mut reader)?;
        if resp["ok"] != json!(true) {
            return Err(std::io::Error::other(format!("tap wait failed: {resp}")));
        }
        if let Some(rec) = resp["status"]["recording"].as_bool() {
            // Baseline or reset: snapshot carries the truth. The transport
            // stays out of it (see the module doc).
            echo.set_rec(rec);
        }
        for ev in resp["events"].as_array().into_iter().flatten() {
            match ev["ev"].as_str() {
                Some("rec_started") => {
                    echo.set_rec(true);
                    punch_in(transport, shared, ev["tl"].as_f64());
                }
                // Stopping a take leaves the transport running, like
                // `/vtr/rec/stop` always has.
                Some("rec_stopped") => echo.set_rec(false),
                _ => {}
            }
        }
        seq = resp["seq"].as_u64().or(seq);
    }
}

/// Punch-in: put the transport on the take's start position and run it, so
/// the loaded session plays as backing while the take records. With no
/// session there is nothing to resolve, so nothing moves. Without a `tl` (no
/// clock beacon) the position is unknown — start where we are rather than
/// guess.
fn punch_in(transport: &Transport, shared: &SharedState, tl: Option<f64>) {
    if shared.snapshot().1.is_none() {
        return;
    }
    if let Some(t) = tl.filter(|t| t.is_finite()) {
        // Priming bypasses the write hold (recording wins) and takes no hold
        // itself, so the `play` right behind it is always accepted.
        transport.prime_seek(t);
    }
    transport.play("rec");
}
