use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr, UdpSocket};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use rosc::{OscMessage, OscPacket, OscType};

use vtr_core::{relay_frame, RateLimitedLog};

/// How often a still-active source IP is re-reported to the player. Must stay
/// well under the player's own origin expiry (3 min) so a live controller
/// never falls out of its registry.
const ORIGIN_REFRESH: Duration = Duration::from_secs(60);

/// Fire-and-forget rec-transition OSC to the TD tox (`--td-notify`). Plain,
/// unwrapped messages — not the `"v1 <origin>"` relay framing — so a TD
/// `oscin` DAT parses them natively.
pub(super) struct Notify {
    sock: UdpSocket,
    addr: SocketAddr,
    log: RateLimitedLog,
}

impl Notify {
    pub(super) fn new(addr: SocketAddr) -> Result<Self> {
        Ok(Self {
            sock: UdpSocket::bind("0.0.0.0:0").context("bind td-notify socket")?,
            addr,
            log: RateLimitedLog::new("vtr-tap"),
        })
    }

    pub(super) fn send(&mut self, addr: &str, args: Vec<OscType>) {
        let packet = OscPacket::Message(OscMessage {
            addr: addr.into(),
            args,
        });
        match rosc::encoder::encode(&packet) {
            Ok(buf) => {
                if let Err(e) = self.sock.send_to(&buf, self.addr) {
                    self.log.log(&format!("td-notify send error: {e}"));
                }
            }
            Err(e) => self.log.log(&format!("td-notify encode error: {e}")),
        }
    }
}

/// Tells the player which hosts talk to us, so it can mirror playback back
/// to them (`origin IP : echo port`). The player only ever learns an origin
/// from a relayed `/vtr/*` datagram, so a controller with no `/vtr` button
/// would never get anything; this reports plain app senders too, as a
/// relay-framed `/vtr/origin`. Internal to the tap->player hop — controllers
/// never send it, and the player's relay drops the unknown address after
/// registering the origin.
pub(super) struct OriginNotifier {
    seen: HashMap<IpAddr, Instant>,
    sock: UdpSocket,
    relay: SocketAddr,
    log: RateLimitedLog,
}

impl OriginNotifier {
    pub(super) fn new(relay: SocketAddr) -> Result<Self> {
        Ok(Self {
            seen: HashMap::new(),
            sock: UdpSocket::bind("0.0.0.0:0").context("bind origin-notify socket")?,
            relay,
            log: RateLimitedLog::new("vtr-tap"),
        })
    }

    /// Called for every inbound datagram: one lookup on the hot path, a
    /// send only when the IP is new or its last report aged out.
    pub(super) fn note(&mut self, origin: SocketAddr, now: Instant) {
        let ip = origin.ip();
        if self
            .seen
            .get(&ip)
            .is_some_and(|last| now.duration_since(*last) < ORIGIN_REFRESH)
        {
            return;
        }
        self.seen.insert(ip, now);
        self.seen
            .retain(|_, last| now.duration_since(*last) < ORIGIN_REFRESH);
        self.send(origin);
    }

    fn send(&mut self, origin: SocketAddr) {
        let packet = OscPacket::Message(OscMessage {
            addr: "/vtr/origin".into(),
            args: vec![],
        });
        let Ok(payload) = rosc::encoder::encode(&packet) else {
            return;
        };
        let frame = relay_frame::encode(origin, &payload);
        if let Err(e) = self.sock.send_to(&frame, self.relay) {
            self.log.log(&format!("origin-notify send error: {e}"));
        }
    }
}
