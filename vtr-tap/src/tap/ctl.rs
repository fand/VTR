use std::net::{SocketAddr, UdpSocket};
use std::sync::mpsc::Receiver;
use std::time::Instant;

use vtr_core::{arg_as_f64, relay_frame, RateLimitedLog, PLAYER_ADDRS};

use super::beacon::{Beacon, BeaconState};
use super::recv::CtlPacket;
use super::Handle;

/// Control (`/vtr/*`) messages are low-rate (~10 Hz clock + rare rec/transport);
/// a small bound keeps a stalled control thread from hoarding memory.
pub(super) const CTL_CHANNEL_CAP: usize = 256;

pub(super) struct Ctl {
    pub rx: Receiver<CtlPacket>,
    pub relay_sock: UdpSocket,
    pub relay_addr: SocketAddr,
    pub beacon: BeaconState,
    pub handle: Handle,
}

/// Dispatch `/vtr/*` (beacon update, rec start/stop) and relay every control
/// datagram to the player. Not inline in recv: start_clip blocks on a writer
/// round trip that opens the clip file — that stall must not sit on the
/// 120 Hz listen socket.
pub(super) fn control_loop(c: Ctl) {
    let Ctl {
        rx,
        relay_sock,
        relay_addr,
        beacon,
        handle,
    } = c;
    let mut arg_log = RateLimitedLog::new("vtr-tap");
    let mut rec_log = RateLimitedLog::new("vtr-tap");
    let mut unknown_log = RateLimitedLog::new("vtr-tap");
    let mut mixed_log = RateLimitedLog::new("vtr-tap");
    let mut clock_src_log = RateLimitedLog::new("vtr-tap");
    let mut relay_log = RateLimitedLog::new("vtr-tap");
    // Last /vtr/clock sender, for multi-sender arbitration warnings.
    let mut last_clock: Option<(SocketAddr, Instant)> = None;
    for pkt in rx {
        // Relay first, fire-and-forget: a dead player is invisible.
        let frame = relay_frame::encode(pkt.origin, &pkt.buf);
        if let Err(e) = relay_sock.send_to(&frame, relay_addr) {
            relay_log.log(&format!("relay send error: {e}"));
        }
        let now = Instant::now();
        for m in &pkt.msgs {
            match m.addr.as_str() {
                "/vtr/clock" => {
                    // Silently dropping these left all clips without tl
                    // and no hint why; say what arrived instead.
                    let Some(t) = arg_as_f64(m.args.first()) else {
                        arg_log.log(&format!(
                            "warn: /vtr/clock arg not numeric ({:?}), beacon ignored",
                            m.args.first()
                        ));
                        continue;
                    };
                    let rate = arg_as_f64(m.args.get(1)).unwrap_or(1.0);
                    // NaN/inf would serialize tl as null and poison
                    // every later extrapolation; drop the beacon.
                    if !t.is_finite() || !rate.is_finite() {
                        continue;
                    }
                    // Last-write-wins across senders; warn when the
                    // source flips within a few seconds.
                    if let Some((src, at)) = last_clock {
                        if src != pkt.origin && (now - at).as_secs_f64() < 3.0 {
                            clock_src_log.log(&format!(
                                "warn: /vtr/clock from multiple senders ({src}, {})",
                                pkt.origin
                            ));
                        }
                    }
                    last_clock = Some((pkt.origin, now));
                    *beacon.lock().unwrap() = Some(Beacon { t, rate, at: now });
                }
                // Controller-facing toggle: no beacon seed.
                "/vtr/rec" => match arg_as_f64(m.args.first()).filter(|v| v.is_finite()) {
                    Some(v) if v != 0.0 => match handle.start_clip(None, None, None) {
                        Ok(path) => eprintln!("vtr-tap: /vtr/rec 1 -> {path:?}"),
                        // Idempotent: already recording is a no-op.
                        Err(e) => rec_log.log(&format!("/vtr/rec 1 ignored: {e}")),
                    },
                    Some(_) => match handle.stop_clip() {
                        Ok(()) => eprintln!("vtr-tap: /vtr/rec 0"),
                        // Idempotent: not recording is a no-op.
                        Err(e) => rec_log.log(&format!("/vtr/rec 0 ignored: {e}")),
                    },
                    None => arg_log.log(&format!(
                        "warn: /vtr/rec arg not numeric ({:?}), dropped",
                        m.args.first()
                    )),
                },
                "/vtr/rec/start" => {
                    // Optional [tl] [rate] seed the beacon (in the
                    // writer) so the clip starts with a correct tl.
                    // Bad args: ignore, still start.
                    let tl = arg_as_f64(m.args.first()).filter(|v| v.is_finite());
                    let rate = arg_as_f64(m.args.get(1)).filter(|v| v.is_finite());
                    match handle.start_clip(None, tl, rate) {
                        Ok(path) => eprintln!("vtr-tap: /vtr/rec/start -> {path:?}"),
                        // Idempotent: already recording is a no-op.
                        Err(e) => rec_log.log(&format!("/vtr/rec/start ignored: {e}")),
                    }
                }
                "/vtr/rec/stop" => match handle.stop_clip() {
                    Ok(()) => eprintln!("vtr-tap: /vtr/rec/stop"),
                    // Idempotent: not recording is a no-op.
                    Err(e) => rec_log.log(&format!("/vtr/rec/stop ignored: {e}")),
                },
                // Player-handled addresses and unknowns: relay
                // already happened.
                a if a.starts_with("/vtr/") => {
                    if !PLAYER_ADDRS.contains(&a) {
                        unknown_log.log(&format!("warn: unknown {a} dropped"));
                    }
                }
                // Mixed bundle: a consumed datagram is never
                // partially re-encoded and forwarded.
                a => mixed_log.log(&format!(
                    "warn: non-/vtr message {a} in a control bundle dropped"
                )),
            }
        }
    }
}
