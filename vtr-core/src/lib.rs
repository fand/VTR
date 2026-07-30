//! Helpers shared by vtr-tap and vtr-player: rate-limited stderr logging,
//! OSC packet/arg utilities, and the tap→player relay frame codec.

use std::net::SocketAddr;
use std::time::Instant;

use rosc::{OscMessage, OscPacket, OscType};

/// Largest UDP datagram either binary sends or receives.
pub const MAX_DATAGRAM: usize = 65_507;

/// `/vtr/*` addresses the tap relays for the player to act on. The tap
/// consumes `/vtr/clock` and `/vtr/rec*` itself, and `/vtr/origin` exists
/// only on the tap→player hop, so none of those belong here: anything else
/// under `/vtr/` is unknown and worth a warning.
pub const PLAYER_ADDRS: &[&str] = &["/vtr/play", "/vtr/stop", "/vtr/seek", "/vtr/echo"];

/// Logs at most once per second; counts what it swallowed in between.
/// stderr is a pipe to the editor, so per-packet paths must go through this.
pub struct RateLimitedLog {
    prefix: &'static str,
    last: Option<Instant>,
    suppressed: u64,
}

impl RateLimitedLog {
    /// `prefix` names the binary, e.g. `"vtr-tap"`.
    pub fn new(prefix: &'static str) -> Self {
        Self {
            prefix,
            last: None,
            suppressed: 0,
        }
    }

    pub fn log(&mut self, msg: &str) {
        let now = Instant::now();
        if self.last.is_none_or(|l| (now - l).as_secs_f64() >= 1.0) {
            if self.suppressed > 0 {
                eprintln!(
                    "{}: {msg} ({} similar suppressed)",
                    self.prefix, self.suppressed
                );
            } else {
                eprintln!("{}: {msg}", self.prefix);
            }
            self.suppressed = 0;
            self.last = Some(now);
        } else {
            self.suppressed += 1;
        }
    }
}

/// Flatten bundles (recursively) into their messages, in order.
pub fn flatten(packet: OscPacket, out: &mut Vec<OscMessage>) {
    match packet {
        OscPacket::Message(m) => out.push(m),
        OscPacket::Bundle(b) => {
            for p in b.content {
                flatten(p, out);
            }
        }
    }
}

/// Numeric OSC arg widened to f64; None for missing or non-numeric.
pub fn arg_as_f64(arg: Option<&OscType>) -> Option<f64> {
    match arg {
        Some(OscType::Float(f)) => Some(*f as f64),
        Some(OscType::Double(d)) => Some(*d),
        Some(OscType::Int(i)) => Some(*i as f64),
        Some(OscType::Long(i)) => Some(*i as f64),
        _ => None,
    }
}

/// The tap→player relay frame: `"v1 <ip>:<port>\n"` header followed by raw
/// OSC payload bytes. The origin is the datagram's sender, so the player
/// knows whom to feed back.
pub mod relay_frame {
    use super::SocketAddr;

    pub fn encode(origin: SocketAddr, payload: &[u8]) -> Vec<u8> {
        let mut frame = format!("v1 {origin}\n").into_bytes();
        frame.extend_from_slice(payload);
        frame
    }

    pub fn parse(buf: &[u8]) -> Option<(SocketAddr, &[u8])> {
        let nl = buf.iter().position(|&b| b == b'\n')?;
        let header = std::str::from_utf8(&buf[..nl]).ok()?;
        let origin = header.strip_prefix("v1 ")?.parse().ok()?;
        Some((origin, &buf[nl + 1..]))
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn round_trips() {
            let origin: SocketAddr = "192.168.1.20:9000".parse().unwrap();
            let payload = b"\0\0osc-ish payload with \n newline";
            let frame = encode(origin, payload);
            let (got_origin, got_payload) = parse(&frame).unwrap();
            assert_eq!(got_origin, origin);
            assert_eq!(got_payload, payload);
        }

        #[test]
        fn rejects_bad_frames() {
            assert!(parse(b"").is_none());
            assert!(parse(b"no newline").is_none());
            assert!(parse(b"v2 1.2.3.4:1\npayload").is_none());
            assert!(parse(b"v1 not-an-addr\npayload").is_none());
        }
    }
}
