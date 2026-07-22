//! Push transport: an internal playhead plus an emit loop that resolves
//! `step(now)` and sends UDP to the forward ports from the session routes.
//! Seeks go through a one-slot latest-wins mailbox: the emit loop always
//! takes the newest pending seek and stale ones are simply overwritten
//! (drag-safe, no fixed throttle).
//!
//! Every mutation (`play`/`stop`/`seek`/`on_load`) carries an `origin` and
//! bumps a generation counter `generation`, so followers can suppress the echo of
//! their own writes (apply a state only when `generation` moved *and* the origin
//! is not theirs). Concurrent writers are arbitrated by a hold rule: a
//! foreign origin is rejected while the last writer is still within
//! `HOLD` — last-touched wins without a tug of war. The playhead itself is
//! session-independent: seeks move it even with no session loaded (only
//! resolve/emit needs one).

use std::net::{IpAddr, UdpSocket};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use rosc::{OscMessage, OscPacket, OscType};
use serde_json::Value;

use crate::resolver::{DedupResolver, Emit, Resolver};
use crate::state::{LoadedSession, SharedState};

const TICK: Duration = Duration::from_millis(5);
/// Concurrent-write hold window: a foreign origin is rejected while the
/// last accepted write is younger than this.
const HOLD: Duration = Duration::from_millis(400);

/// Write arbitration: accept a write from `incoming` given the current
/// holder and how long ago it last wrote (`None` = idle, no holder).
/// Same origin always wins; a foreign origin waits out the hold window.
fn accepts(incoming: &str, holder: &str, since: Option<Duration>) -> bool {
    match since {
        None => true,
        Some(d) => incoming == holder || d >= HOLD,
    }
}

/// Read-side view of the transport: playhead, run state, and the
/// generation/origin of the last mutation.
pub struct TransportSnap {
    pub t: f64,
    pub playing: bool,
    pub generation: u64,
    pub origin: String,
}

struct TState {
    playing: bool,
    base_t: f64,
    anchor: Instant,
    /// Bumps on every accepted state change; watchers wake on the delta.
    generation: u64,
    /// Origin of the last accepted mutation (`""` = system, e.g. load).
    origin: String,
    /// When the last write was accepted (`None` = idle, no current holder).
    last_write: Option<Instant>,
}

impl TState {
    fn playhead(&self) -> f64 {
        if self.playing {
            self.base_t + self.anchor.elapsed().as_secs_f64()
        } else {
            self.base_t
        }
    }

    fn snap(&self) -> TransportSnap {
        TransportSnap {
            t: self.playhead(),
            playing: self.playing,
            generation: self.generation,
            origin: self.origin.clone(),
        }
    }

    /// May this origin write right now?
    fn accepts(&self, origin: &str) -> bool {
        accepts(origin, &self.origin, self.last_write.map(|w| w.elapsed()))
    }

    /// Record an accepted mutation: bump generation, take ownership, refresh hold.
    fn commit(&mut self, origin: &str, now: Instant) {
        self.generation += 1;
        self.origin = origin.to_string();
        self.last_write = Some(now);
    }
}

struct Inner {
    shared: Arc<SharedState>,
    state: Mutex<TState>,
    /// Signaled on every accepted mutation (generation bump) for `watch`.
    changed: Condvar,
    /// Latest-wins seek mailbox (the t to emit once).
    seek: Mutex<Option<f64>>,
    sock: UdpSocket,
    host: IpAddr,
}

#[derive(Clone)]
pub struct Transport {
    inner: Arc<Inner>,
}

impl Transport {
    pub fn start(shared: Arc<SharedState>, host: IpAddr) -> Result<Transport> {
        let sock = UdpSocket::bind("0.0.0.0:0").context("bind transport socket")?;
        let inner = Arc::new(Inner {
            shared,
            state: Mutex::new(TState {
                playing: false,
                base_t: 0.0,
                anchor: Instant::now(),
                generation: 0,
                origin: String::new(),
                last_write: None,
            }),
            changed: Condvar::new(),
            seek: Mutex::new(None),
            sock,
            host,
        });
        {
            let inner = inner.clone();
            thread::Builder::new()
                .name("transport".into())
                .spawn(move || emit_loop(inner))?;
        }
        Ok(Transport { inner })
    }

    pub fn play(&self, origin: &str) {
        let now = Instant::now();
        let mut st = self.inner.state.lock().unwrap();
        if !st.accepts(origin) || st.playing {
            return; // rejected by hold, or already playing (no change)
        }
        st.anchor = now;
        st.playing = true;
        st.commit(origin, now);
        self.inner.changed.notify_all();
    }

    pub fn stop(&self, origin: &str) {
        let now = Instant::now();
        let mut st = self.inner.state.lock().unwrap();
        if !st.accepts(origin) || !st.playing {
            return;
        }
        st.base_t = st.playhead();
        st.playing = false;
        st.commit(origin, now);
        self.inner.changed.notify_all();
    }

    pub fn request_seek(&self, t: f64, origin: &str) {
        let now = Instant::now();
        let mut st = self.inner.state.lock().unwrap();
        if !st.accepts(origin) {
            return;
        }
        // Move the playhead synchronously so reads/replies never observe a
        // bumped generation against a stale position; the mailbox only asks the
        // emit loop to push the resolved frame (needed while paused).
        st.base_t = t;
        st.anchor = now;
        st.commit(origin, now);
        drop(st);
        *self.inner.seek.lock().unwrap() = Some(t);
        self.inner.changed.notify_all();
    }

    pub fn playhead(&self) -> f64 {
        self.inner.state.lock().unwrap().playhead()
    }

    pub fn playing(&self) -> bool {
        self.inner.state.lock().unwrap().playing
    }

    pub fn snapshot(&self) -> TransportSnap {
        self.inner.state.lock().unwrap().snap()
    }

    /// Block until the transport's generation differs from `generation`, or `timeout`
    /// elapses; return the current snapshot either way (a timeout replies
    /// with the same generation, so a caller just re-issues).
    pub fn watch(&self, generation: u64, timeout: Duration) -> TransportSnap {
        let deadline = Instant::now() + timeout;
        let mut st = self.inner.state.lock().unwrap();
        while st.generation == generation {
            let now = Instant::now();
            if now >= deadline {
                break;
            }
            let (guard, res) = self.inner.changed.wait_timeout(st, deadline - now).unwrap();
            st = guard;
            if res.timed_out() {
                break;
            }
        }
        st.snap()
    }

    /// Called on `load`: stop, rewind, drop any pending seek, and bump generation
    /// with a system origin so followers re-baseline to t=0/stopped. The
    /// emit loop rebuilds its resolver on the epoch change it will observe.
    pub fn on_load(&self) {
        let mut st = self.inner.state.lock().unwrap();
        st.playing = false;
        st.base_t = 0.0;
        *self.inner.seek.lock().unwrap() = None;
        st.generation += 1;
        st.origin = String::new();
        // A load is not a holder: leave the transport idle for the next writer.
        st.last_write = None;
        self.inner.changed.notify_all();
    }
}

fn emit_loop(inner: Arc<Inner>) {
    let mut cur_epoch = 0u64;
    let mut resolver: Option<DedupResolver> = None;
    let mut loaded: Option<Arc<LoadedSession>> = None;
    loop {
        thread::sleep(TICK);
        let (epoch, l) = inner.shared.snapshot();
        if epoch != cur_epoch {
            cur_epoch = epoch;
            resolver = l.as_ref().map(|l| {
                DedupResolver::new(Resolver::new(
                    l.session.clone(),
                    Some(&|a: &str| l.triggers.matches(a)),
                    0.5,
                ))
            });
            // Pending seeks are NOT cleared here: on_load() already did,
            // synchronously before the load reply — a seek arriving after
            // that targets the new session and must survive this tick.
            loaded = l;
        }
        let (Some(l), Some(r)) = (&loaded, &mut resolver) else {
            continue;
        };
        // base_t/anchor are already set by request_seek; the mailbox just
        // asks us to push the resolved frame once (covers the paused case).
        if let Some(t) = inner.seek.lock().unwrap().take() {
            let (_, emits) = r.step(t);
            send(&inner, l, &emits);
        }
        let pos = {
            let st = inner.state.lock().unwrap();
            if !st.playing {
                continue;
            }
            st.playhead()
        };
        let (_, emits) = r.step(pos);
        send(&inner, l, &emits);
    }
}

fn send(inner: &Inner, loaded: &LoadedSession, emits: &[Emit]) {
    for (port, addr, args) in emits {
        // Only routed ports are emitted — never back to a listen port.
        let Some(&dst) = loaded.routes.get(port) else {
            continue;
        };
        let Ok(buf) = rosc::encoder::encode(&OscPacket::Message(OscMessage {
            addr: addr.clone(),
            args: to_osc_args(args),
        })) else {
            continue;
        };
        let _ = inner.sock.send_to(&buf, (inner.host, dst));
    }
}

/// JSON args back to OSC. The columnar model does not keep f32-vs-f64
/// apart post-resolve, so numbers encode as Float (the dominant recorded
/// tag) or Int/Long.
fn to_osc_args(args: &[Value]) -> Vec<OscType> {
    args.iter()
        .map(|v| match v {
            Value::Number(n) if n.is_i64() => {
                let i = n.as_i64().unwrap();
                match i32::try_from(i) {
                    Ok(i) => OscType::Int(i),
                    Err(_) => OscType::Long(i),
                }
            }
            Value::Number(n) => OscType::Float(n.as_f64().unwrap_or(0.0) as f32),
            Value::String(s) => OscType::String(s.clone()),
            Value::Bool(b) => OscType::Bool(*b),
            Value::Null => OscType::Nil,
            other => OscType::String(other.to_string()),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_arbitration() {
        // Idle transport: anyone may write.
        assert!(accepts("td", "editor", None));
        // Same holder always wins, even mid-window.
        assert!(accepts("editor", "editor", Some(Duration::ZERO)));
        // Foreign origin inside the window loses.
        assert!(!accepts("td", "editor", Some(Duration::ZERO)));
        assert!(!accepts(
            "td",
            "editor",
            Some(HOLD - Duration::from_millis(1))
        ));
        // Foreign origin after the window takes over.
        assert!(accepts("td", "editor", Some(HOLD)));
    }

    fn transport() -> Transport {
        Transport::start(
            Arc::new(SharedState::default()),
            "127.0.0.1".parse().unwrap(),
        )
        .unwrap()
    }

    #[test]
    fn play_stop_bump_gen_only_on_change() {
        let t = transport();
        assert_eq!(t.snapshot().generation, 0);
        t.play("editor");
        let s = t.snapshot();
        assert_eq!(s.generation, 1);
        assert!(s.playing);
        assert_eq!(s.origin, "editor");
        // Redundant play: no state change, no generation bump.
        t.play("editor");
        assert_eq!(t.snapshot().generation, 1);
        t.stop("editor");
        let s = t.snapshot();
        assert_eq!(s.generation, 2);
        assert!(!s.playing);
        // Redundant stop: no bump.
        t.stop("editor");
        assert_eq!(t.snapshot().generation, 2);
    }

    #[test]
    fn seek_moves_playhead_without_a_session() {
        let t = transport();
        t.request_seek(5.0, "editor");
        let s = t.snapshot();
        assert_eq!(s.t, 5.0);
        assert_eq!(s.generation, 1);
        assert_eq!(s.origin, "editor");
    }

    #[test]
    fn hold_rejects_foreign_writer_in_window() {
        let t = transport();
        t.request_seek(5.0, "editor");
        let generation = t.snapshot().generation;
        // td is foreign and editor just wrote: rejected, no change.
        t.request_seek(9.0, "td");
        let s = t.snapshot();
        assert_eq!(s.t, 5.0);
        assert_eq!(s.generation, generation);
        assert_eq!(s.origin, "editor");
        // Same origin still wins.
        t.request_seek(7.0, "editor");
        assert_eq!(t.snapshot().t, 7.0);
    }

    #[test]
    fn watch_returns_immediately_on_stale_gen() {
        let t = transport();
        t.play("editor");
        let g = t.snapshot().generation;
        // Watching an older generation returns at once.
        let snap = t.watch(g - 1, Duration::from_secs(5));
        assert_eq!(snap.generation, g);
    }

    #[test]
    fn watch_times_out_when_gen_is_current() {
        let t = transport();
        let g = t.snapshot().generation;
        let start = Instant::now();
        let snap = t.watch(g, Duration::from_millis(50));
        assert!(start.elapsed() >= Duration::from_millis(50));
        assert_eq!(snap.generation, g);
    }
}
