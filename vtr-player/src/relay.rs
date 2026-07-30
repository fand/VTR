//! Receiver for tap-wrapped `/vtr/*` datagrams: `"v1 <ip>:<port>\n"`
//! header followed by the raw OSC bytes. Registers origins for echo and
//! dispatches transport commands. `/vtr/clock` and `/vtr/rec` only refresh
//! the origin registry — rec handling is the tap's business, and the rec
//! echo is driven by the tap event log regardless of which command changed
//! the state.

use std::net::UdpSocket;
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use anyhow::Result;
use vtr_core::{arg_as_f64, flatten, relay_frame, RateLimitedLog, MAX_DATAGRAM};

use crate::echo::Echo;
use crate::state::SharedState;
use crate::transport::Transport;

pub fn spawn(
    sock: UdpSocket,
    shared: Arc<SharedState>,
    transport: Transport,
    echo: Echo,
) -> Result<()> {
    thread::Builder::new().name("relay".into()).spawn(move || {
        let mut buf = [0u8; MAX_DATAGRAM];
        let mut recv_log = RateLimitedLog::new("vtr-player");
        let mut frame_log = RateLimitedLog::new("vtr-player");
        loop {
            let n = match sock.recv(&mut buf) {
                Ok(n) => n,
                Err(e) => {
                    // A persistent socket error would otherwise spin this
                    // thread silently at 100% CPU for the rest of the show.
                    recv_log.log(&format!("warn: relay recv failed: {e}"));
                    thread::sleep(Duration::from_millis(10));
                    continue;
                }
            };
            let Some((origin, payload)) = relay_frame::parse(&buf[..n]) else {
                frame_log.log(&format!("warn: bad relay frame ({n} bytes) dropped"));
                continue;
            };
            let Ok((_, packet)) = rosc::decoder::decode_udp(payload) else {
                continue;
            };
            let mut msgs = Vec::new();
            flatten(packet, &mut msgs);
            if msgs.iter().any(|m| m.addr.starts_with("/vtr/")) {
                echo.register(origin.ip());
            }
            for m in &msgs {
                match m.addr.as_str() {
                    // Controller transport commands share the origin "osc",
                    // so both TD and the editor follow them.
                    "/vtr/play" => transport.play("osc"),
                    // Mirror toggle: pause/resume playback-value feedback.
                    // Global, like every other /vtr command.
                    "/vtr/echo" => {
                        if let Some(v) = arg_as_f64(m.args.first()).filter(|v| v.is_finite()) {
                            let on = v != 0.0;
                            echo.set_mirror_on(on);
                            // Every truthy /vtr/echo also mirrors the full
                            // current state once (like a seek's catch-up),
                            // so the controller snaps to the timeline even
                            // if the mirror was already on.
                            if on {
                                transport.request_echo_resync();
                            }
                        }
                    }
                    "/vtr/stop" => transport.stop("osc"),
                    "/vtr/seek" => {
                        if let Some(t) = arg_as_f64(m.args.first()).filter(|v| v.is_finite()) {
                            transport.request_seek(t, "osc");
                        }
                    }
                    // Punch-in priming: resolve at t and emit to the app,
                    // only with a session loaded and a t given. Not a user
                    // gesture — it bypasses the hold rule (recording wins)
                    // and takes no hold itself.
                    "/vtr/rec/start" => {
                        if let Some(t) = arg_as_f64(m.args.first()).filter(|v| v.is_finite()) {
                            if shared.snapshot().1.is_some() {
                                transport.prime_seek(t);
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
    })?;
    Ok(())
}
