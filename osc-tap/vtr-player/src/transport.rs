//! Push transport: an internal playhead plus an emit loop that resolves
//! `step(now)` and sends UDP to the forward ports from the session routes.
//! Seeks go through a one-slot latest-wins mailbox: the emit loop always
//! takes the newest pending seek and stale ones are simply overwritten
//! (drag-safe, no fixed throttle).

use std::net::{IpAddr, UdpSocket};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use rosc::{OscMessage, OscPacket, OscType};
use serde_json::Value;

use crate::resolver::{DedupResolver, Emit, Resolver};
use crate::state::{LoadedSession, SharedState};

const TICK: Duration = Duration::from_millis(5);

struct TState {
    playing: bool,
    base_t: f64,
    anchor: Instant,
}

impl TState {
    fn playhead(&self) -> f64 {
        if self.playing {
            self.base_t + self.anchor.elapsed().as_secs_f64()
        } else {
            self.base_t
        }
    }
}

struct Inner {
    shared: Arc<SharedState>,
    state: Mutex<TState>,
    /// Latest-wins seek mailbox.
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
            }),
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

    pub fn play(&self) {
        let mut st = self.inner.state.lock().unwrap();
        if !st.playing {
            st.anchor = Instant::now();
            st.playing = true;
        }
    }

    pub fn stop(&self) {
        let mut st = self.inner.state.lock().unwrap();
        if st.playing {
            st.base_t = st.playhead();
            st.playing = false;
        }
    }

    pub fn request_seek(&self, t: f64) {
        *self.inner.seek.lock().unwrap() = Some(t);
    }

    pub fn playhead(&self) -> f64 {
        self.inner.state.lock().unwrap().playhead()
    }

    pub fn playing(&self) -> bool {
        self.inner.state.lock().unwrap().playing
    }

    /// Called on `load`: stop, rewind, drop any pending seek. The emit
    /// loop rebuilds its resolver on the epoch change it will observe.
    pub fn on_load(&self) {
        let mut st = self.inner.state.lock().unwrap();
        st.playing = false;
        st.base_t = 0.0;
        *self.inner.seek.lock().unwrap() = None;
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
        if let Some(t) = inner.seek.lock().unwrap().take() {
            let mut st = inner.state.lock().unwrap();
            st.base_t = t;
            st.anchor = Instant::now();
            drop(st);
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
