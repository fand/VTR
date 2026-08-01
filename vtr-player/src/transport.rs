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

use std::collections::HashMap;
use std::net::{IpAddr, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use rosc::{OscMessage, OscPacket, OscType};
use serde_json::Value;

use crate::echo::Echo;
use crate::resolver::{DedupResolver, Emit, Resolver};
use crate::state::{LoadedSession, SharedState};

const TICK: Duration = Duration::from_millis(5);
/// Controller mirror cadence. The emit loop runs at 200 Hz for the app, but a
/// controller only has to *look* right, and it is usually a tablet on wifi —
/// 50 Hz is plenty and cuts the packet rate by 4.
const MIRROR_TICK: Duration = Duration::from_millis(20);
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
    /// `/vtr/echo 1` asked for a full mirror resync (all addresses at the
    /// playhead, mirror only).
    resync: AtomicBool,
    sock: UdpSocket,
    host: IpAddr,
    echo: Echo,
}

/// Emits staged for the controller mirror between flushes, latest value per
/// (port, address).
type Pending = HashMap<(u16, String), Vec<Value>>;

#[derive(Clone)]
pub struct Transport {
    inner: Arc<Inner>,
}

impl Transport {
    pub fn start(shared: Arc<SharedState>, host: IpAddr, echo: Echo) -> Result<Transport> {
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
            resync: AtomicBool::new(false),
            sock,
            host,
            echo,
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
        // emit loop to push the resolved frame (needed while paused). The
        // mailbox write stays under the state lock (state → seek, same
        // order as on_load) so racing seeks can't leave the mailbox
        // holding a t the state has already superseded.
        st.base_t = t;
        st.anchor = now;
        st.commit(origin, now);
        *self.inner.seek.lock().unwrap() = Some(t);
        drop(st);
        self.inner.changed.notify_all();
    }

    /// Punch-in priming (`/vtr/rec/start`): apply unconditionally —
    /// recording wins over any transport tug-of-war, so the hold rule does
    /// not apply — and without becoming a holder (origin "", no
    /// `last_write`), so the next writer is accepted at once. Still bumps
    /// the generation: followers re-baseline to the primed position.
    pub fn prime_seek(&self, t: f64) {
        let mut st = self.inner.state.lock().unwrap();
        st.base_t = t;
        st.anchor = Instant::now();
        st.generation += 1;
        st.origin.clear();
        st.last_write = None;
        *self.inner.seek.lock().unwrap() = Some(t);
        drop(st);
        self.inner.changed.notify_all();
    }

    /// `/vtr/echo 1`: ask the emit loop to mirror the full current state —
    /// every address resolved at the playhead, like a seek's catch-up — so
    /// a controller that sat out (mirror off, joined late) snaps to the
    /// timeline. Mirror only; the app stream and its dedup are untouched.
    pub fn request_echo_resync(&self) {
        self.inner.resync.store(true, Ordering::Relaxed);
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

    /// Called on `load`: stop, rewind, drop any pending seek, and bump
    /// generation with the loader's origin so followers re-baseline to
    /// t=0/stopped — except the loader itself, which suppresses its own
    /// echo. The emit loop rebuilds its resolver on the epoch change it
    /// will observe.
    pub fn on_load(&self, origin: &str) {
        let mut st = self.inner.state.lock().unwrap();
        st.playing = false;
        st.base_t = 0.0;
        *self.inner.seek.lock().unwrap() = None;
        st.generation += 1;
        st.origin = origin.to_string();
        // A load is not a holder: leave the transport idle for the next writer.
        st.last_write = None;
        self.inner.changed.notify_all();
    }
}

fn emit_loop(inner: Arc<Inner>) {
    let mut cur_epoch = 0u64;
    let mut resolver: Option<DedupResolver> = None;
    let mut loaded: Option<Arc<LoadedSession>> = None;
    let mut pending: Pending = Pending::new();
    let mut last_mirror = Instant::now();
    loop {
        thread::sleep(TICK);
        // Ahead of every early-out below: the last values of a stop or a
        // seek must not sit in `pending` until the next emit.
        if !pending.is_empty() && last_mirror.elapsed() >= MIRROR_TICK {
            inner.echo.mirror(&drain_mirror(&mut pending));
            last_mirror = Instant::now();
        }
        let (epoch, l) = inner.shared.snapshot();
        if epoch != cur_epoch {
            cur_epoch = epoch;
            // Carry the dedup state across the swap: a live session reload
            // (the editor's residency load during playback) must not
            // re-send values the receivers already hold.
            let last = resolver.take().map(DedupResolver::into_last).unwrap_or_default();
            resolver = l.as_ref().map(|l| {
                DedupResolver::with_last(
                    Resolver::new(
                        l.session.clone(),
                        Some(&|a: &str| l.triggers.matches(a)),
                        0.5,
                    ),
                    last,
                )
            });
            // Pending seeks are NOT cleared here: on_load() already did,
            // synchronously before the load reply — a seek arriving after
            // that targets the new session and must survive this tick.
            loaded = l;
        }
        let (Some(l), Some(r)) = (&loaded, &mut resolver) else {
            continue;
        };
        // Full mirror resync (`/vtr/echo 1`): every routed address at the
        // playhead, staged for the mirror only. Live emits this tick land
        // after and overwrite — newest wins as usual.
        if inner.resync.swap(false, Ordering::Relaxed) {
            let t = inner.state.lock().unwrap().playhead();
            for (port, addr, args) in r.snapshot_at(t) {
                if l.routes.contains_key(&port) {
                    pending.insert((port, addr), args);
                }
            }
        }
        // base_t/anchor are already set by request_seek; the mailbox just
        // asks us to push the resolved frame once (covers the paused case).
        if let Some(t) = inner.seek.lock().unwrap().take() {
            let (_, emits) = r.step(t);
            send(&inner, l, &emits, &mut pending);
        }
        let pos = {
            let st = inner.state.lock().unwrap();
            if !st.playing {
                continue;
            }
            st.playhead()
        };
        let (_, emits) = r.step(pos);
        send(&inner, l, &emits, &mut pending);
    }
}

fn send(inner: &Inner, loaded: &LoadedSession, emits: &[Emit], pending: &mut Pending) {
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
        // The controller gets the same value, but coalesced: staging by
        // (port, address) means a flush carries the newest value only, so
        // slowing the mirror down can never leave a fader on a stale one.
        pending.insert((*port, addr.clone()), args.clone());
    }
}

fn drain_mirror(pending: &mut Pending) -> Vec<OscMessage> {
    pending
        .drain()
        .map(|((_, addr), args)| OscMessage {
            addr,
            args: to_osc_args(&args),
        })
        .collect()
}

/// JSON args back to OSC. The columnar model does not keep f32-vs-f64
/// apart post-resolve, so numbers encode as Float (the dominant recorded
/// tag) or Int/Long — except values Float can't round-trip, which keep
/// their d-tagged precision as Double (long timestamps, fine positions):
/// the resolve-over-socket path replays them at full precision, and push
/// playback must not disagree with it.
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
            Value::Number(n) => {
                let f = n.as_f64().unwrap_or(0.0);
                if (f as f32) as f64 == f {
                    OscType::Float(f as f32)
                } else {
                    OscType::Double(f)
                }
            }
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
    fn to_osc_args_keeps_double_precision() {
        let args = vec![
            serde_json::json!(0.5),                  // f32-exact: stays Float
            serde_json::json!(1_753_776_000.123_45), // needs f64: Double
            serde_json::json!(7),
        ];
        let out = to_osc_args(&args);
        assert_eq!(out[0], OscType::Float(0.5));
        assert_eq!(out[1], OscType::Double(1_753_776_000.123_45));
        assert_eq!(out[2], OscType::Int(7));
    }

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
            // No origin ever registers, so the mirror is a no-op here.
            Echo::new(0, None).unwrap(),
        )
        .unwrap()
    }

    #[test]
    fn mirror_staging_keeps_only_the_newest_value_per_address() {
        let mut pending = Pending::new();
        pending.insert((10010, "/a".into()), vec![Value::from(1.0)]);
        pending.insert((10010, "/a".into()), vec![Value::from(2.0)]);
        // Same address on another session port stays its own entry.
        pending.insert((10020, "/a".into()), vec![Value::from(3.0)]);
        let mut msgs = drain_mirror(&mut pending);
        msgs.sort_by_key(|m| format!("{:?}", m.args));
        assert!(pending.is_empty());
        assert_eq!(
            msgs.iter().map(|m| m.addr.as_str()).collect::<Vec<_>>(),
            ["/a", "/a"]
        );
        assert_eq!(
            msgs.iter().map(|m| m.args.clone()).collect::<Vec<_>>(),
            [vec![OscType::Float(2.0)], vec![OscType::Float(3.0)]]
        );
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
    fn prime_seek_bypasses_hold_without_taking_it() {
        let t = transport();
        t.request_seek(5.0, "editor");
        // Punch-in applies mid-hold, bumps the generation, clears the origin.
        t.prime_seek(9.0);
        let s = t.snapshot();
        assert_eq!(s.t, 9.0);
        assert_eq!(s.generation, 2);
        assert_eq!(s.origin, "");
        // Priming is not a holder: a foreign writer is accepted at once.
        t.request_seek(3.0, "td");
        let s = t.snapshot();
        assert_eq!(s.t, 3.0);
        assert_eq!(s.origin, "td");
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
