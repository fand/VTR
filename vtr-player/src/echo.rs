//! Controller feedback at `source IP : echo port`, to every origin the
//! relay has seen recently (a `/vtr/*` datagram, or a `/vtr/origin` the tap
//! sends for plain app traffic):
//!
//! - `/vtr/rec <0|1>` on rec-state change, and once immediately on first
//!   contact from a new origin (initial sync for late-started controllers).
//!   Rec state comes from a client thread long-polling the tap control
//!   socket's `wait`.
//! - the resolved playback values, mirrored by the transport so a
//!   controller's faders follow the timeline (`mirror`).

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write as _};
use std::net::{IpAddr, UdpSocket};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use rosc::{OscMessage, OscPacket, OscType};
use serde_json::{json, Value};

/// Origin entries expire after 3 minutes of `/vtr/*` silence.
const EXPIRY: Duration = Duration::from_secs(180);
const RECONNECT_BACKOFF: Duration = Duration::from_secs(1);

struct Inner {
    origins: Mutex<HashMap<IpAddr, Instant>>,
    /// None until the tap reported a baseline.
    rec: Mutex<Option<bool>>,
    sock: UdpSocket,
    echo_port: u16,
}

#[derive(Clone)]
pub struct Echo {
    inner: Arc<Inner>,
}

impl Echo {
    pub fn new(echo_port: u16) -> Result<Echo> {
        let sock = UdpSocket::bind("0.0.0.0:0").context("bind echo socket")?;
        Ok(Echo {
            inner: Arc::new(Inner {
                origins: Mutex::new(HashMap::new()),
                rec: Mutex::new(None),
                sock,
                echo_port,
            }),
        })
    }

    /// Called by the relay for every `/vtr/*` datagram. A new (or expired)
    /// origin gets the current rec state echoed once immediately.
    pub fn register(&self, ip: IpAddr) {
        let now = Instant::now();
        let fresh_contact = {
            let mut origins = self.inner.origins.lock().unwrap();
            let fresh = origins
                .insert(ip, now)
                .is_none_or(|last| now.duration_since(last) > EXPIRY);
            fresh
        };
        if fresh_contact {
            if let Some(rec) = *self.inner.rec.lock().unwrap() {
                self.send(ip, rec);
            }
        }
    }

    /// Update rec state; on change, echo to every live origin.
    pub fn set_rec(&self, rec: bool) {
        let changed = {
            let mut cur = self.inner.rec.lock().unwrap();
            let changed = *cur != Some(rec);
            *cur = Some(rec);
            changed
        };
        if !changed {
            return;
        }
        for ip in self.live() {
            self.send(ip, rec);
        }
    }

    /// Mirror resolved playback values back to every live origin, so a
    /// controller's faders follow the timeline. Silent while recording: the
    /// values would come straight back in through the tap and land in the
    /// clip.
    pub fn mirror(&self, msgs: &[OscMessage]) {
        if *self.inner.rec.lock().unwrap() == Some(true) {
            return;
        }
        let live = self.live();
        if live.is_empty() {
            return;
        }
        for m in msgs {
            let Ok(buf) = rosc::encoder::encode(&OscPacket::Message(m.clone())) else {
                continue;
            };
            for &ip in &live {
                let _ = self.inner.sock.send_to(&buf, (ip, self.inner.echo_port));
            }
        }
    }

    fn live(&self) -> Vec<IpAddr> {
        let now = Instant::now();
        self.inner
            .origins
            .lock()
            .unwrap()
            .iter()
            .filter(|&(_, &last)| now.duration_since(last) <= EXPIRY)
            .map(|(&ip, _)| ip)
            .collect()
    }

    fn send(&self, ip: IpAddr, rec: bool) {
        let Ok(buf) = rosc::encoder::encode(&OscPacket::Message(OscMessage {
            addr: "/vtr/rec".into(),
            args: vec![OscType::Float(if rec { 1.0 } else { 0.0 })],
        })) else {
            return;
        };
        let _ = self.inner.sock.send_to(&buf, (ip, self.inner.echo_port));
    }

    /// Long-poll the tap's `wait` API for rec transitions; reconnect with
    /// backoff. Each (re)connect starts with a cursor-less `wait` whose
    /// baseline status snapshot seeds the rec state without waiting for a
    /// change.
    pub fn spawn_tap_client(&self, path: PathBuf) -> Result<()> {
        let echo = self.clone();
        thread::Builder::new()
            .name("tap-client".into())
            .spawn(move || loop {
                if let Ok(stream) = UnixStream::connect(&path) {
                    let _ = follow_tap(&echo, stream);
                }
                thread::sleep(RECONNECT_BACKOFF);
            })?;
        Ok(())
    }
}

fn follow_tap(echo: &Echo, stream: UnixStream) -> std::io::Result<()> {
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
            // Baseline or reset: snapshot carries the truth.
            echo.set_rec(rec);
        }
        for ev in resp["events"].as_array().into_iter().flatten() {
            match ev["ev"].as_str() {
                Some("rec_started") => echo.set_rec(true),
                Some("rec_stopped") => echo.set_rec(false),
                _ => {}
            }
        }
        seq = resp["seq"].as_u64().or(seq);
    }
}
