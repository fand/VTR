use std::net::{SocketAddr, UdpSocket};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{SyncSender, TrySendError};
use std::sync::Arc;
use std::time::Instant;

use anyhow::Result;
use rosc::OscMessage;

use vtr_core::{flatten, RateLimitedLog, MAX_DATAGRAM};

use super::beacon::BeaconState;
use super::notify::OriginNotifier;
use super::writer::Msg;

/// Kernel receive buffer for the listen socket (best effort).
pub(super) const RECV_BUF_BYTES: usize = 4 * 1024 * 1024;

/// A `/vtr/*` datagram bound for the control thread, with its origin for
/// the player relay.
pub(super) struct CtlPacket {
    pub origin: SocketAddr,
    pub buf: Vec<u8>,
    pub msgs: Vec<OscMessage>,
}

pub(super) struct Recv {
    pub listen: UdpSocket,
    pub forward: UdpSocket,
    pub origins: OriginNotifier,
    pub beacon: BeaconState,
    pub tx: SyncSender<Msg>,
    pub ctl_tx: SyncSender<CtlPacket>,
    pub dropped: Arc<AtomicU64>,
    pub received: Arc<AtomicU64>,
}

/// Stamp, forward raw, hand off to the writer. `/vtr/*` control datagrams go
/// to the control thread instead — never to the app, never to the writer.
/// Decoding happens here only on a `/vtr/` byte-scan hit, so a false positive
/// is forwarded raw from the same thread, in order; the hot path stays
/// scan + forward + try_send.
pub(super) fn recv_loop(r: Recv) {
    let Recv {
        listen,
        forward,
        mut origins,
        beacon,
        tx,
        ctl_tx,
        dropped,
        received,
    } = r;
    let mut buf = [0u8; MAX_DATAGRAM];
    // TD down turns every forward into an error (~120/s); throttle.
    let mut recv_log = RateLimitedLog::new("vtr-tap");
    let mut fwd_log = RateLimitedLog::new("vtr-tap");
    let mut ctl_log = RateLimitedLog::new("vtr-tap");
    loop {
        let (n, origin) = match listen.recv_from(&mut buf) {
            Ok(r) => r,
            Err(e) => {
                recv_log.log(&format!("recv error: {e}"));
                continue;
            }
        };
        let t = Instant::now();
        received.fetch_add(1, Ordering::Relaxed);
        // Before the /vtr split: control datagrams register the origin on
        // their own, but going through the same path costs one lookup a
        // minute and keeps the branch out.
        origins.note(origin, t);
        if contains_vtr(&buf[..n]) {
            if let Some(msgs) = decode_control(&buf[..n]) {
                match ctl_tx.try_send(CtlPacket {
                    origin,
                    buf: buf[..n].to_vec(),
                    msgs,
                }) {
                    Ok(()) => {}
                    Err(TrySendError::Full(_)) => {
                        ctl_log.log("control backlog full, /vtr datagram dropped");
                    }
                    Err(TrySendError::Disconnected(_)) => break,
                }
                continue;
            }
            // False positive (`/vtr/` in a string arg, `/x/vtr/y`):
            // app data, forwarded raw below.
        }
        if let Err(e) = forward.send(&buf[..n]) {
            fwd_log.log(&format!("forward error: {e}"));
        }
        let snapshot = *beacon.lock().unwrap();
        match tx.try_send(Msg::Packet {
            buf: buf[..n].to_vec(),
            t,
            beacon: snapshot,
        }) {
            Ok(()) => {}
            Err(TrySendError::Full(_)) => {
                let d = dropped.fetch_add(1, Ordering::Relaxed) + 1;
                if d == 1 || d % 1000 == 0 {
                    eprintln!("vtr-tap: writer backlog full, {d} packets dropped");
                }
            }
            Err(TrySendError::Disconnected(_)) => break,
        }
    }
}

/// Cheap scan deciding whether a datagram might be control at all.
fn contains_vtr(buf: &[u8]) -> bool {
    buf.windows(5).any(|w| w == b"/vtr/")
}

/// A datagram is control iff it decodes to a message whose address starts
/// with `/vtr/`, or a bundle containing at least one such message. Returns
/// the flattened messages, or None for app data (including false positives:
/// `/vtr/` inside a string arg, addresses like `/x/vtr/y`).
fn decode_control(buf: &[u8]) -> Option<Vec<OscMessage>> {
    let (_, packet) = rosc::decoder::decode_udp(buf).ok()?;
    let mut msgs = Vec::new();
    flatten(packet, &mut msgs);
    msgs.iter()
        .any(|m| m.addr.starts_with("/vtr/"))
        .then_some(msgs)
}

/// Bind a UDP socket, optionally enlarging the kernel receive buffer (best effort).
pub(super) fn bind_udp(addr: SocketAddr, recv_buf: Option<usize>) -> Result<UdpSocket> {
    let domain = if addr.is_ipv4() {
        socket2::Domain::IPV4
    } else {
        socket2::Domain::IPV6
    };
    let socket = socket2::Socket::new(domain, socket2::Type::DGRAM, None)?;
    if let Some(bytes) = recv_buf {
        if let Err(e) = socket.set_recv_buffer_size(bytes) {
            eprintln!("vtr-tap: warn: set_recv_buffer_size({bytes}) failed: {e}");
        }
    }
    socket.bind(&addr.into())?;
    Ok(socket.into())
}
