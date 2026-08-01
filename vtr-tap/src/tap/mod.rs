mod beacon;
mod ctl;
mod eventlog;
mod jsonl;
mod notify;
mod recv;
mod writer;

use std::net::{SocketAddr, UdpSocket};
use std::path::PathBuf;
use std::sync::atomic::AtomicU64;
use std::sync::mpsc::{self, Sender, SyncSender};
use std::sync::{Arc, Mutex};
use std::thread;

use anyhow::{Context, Result};

use crate::config::Config;

pub use beacon::Beacon;
pub use eventlog::{Event, EventLog, WaitResult};
pub use writer::Status;

use beacon::BeaconState;
use notify::{Notify, OriginNotifier};
use writer::Msg;

pub struct Tap {
    pub listen_addr: SocketAddr,
    handle: Handle,
}

#[derive(Clone)]
pub struct Handle {
    tx: SyncSender<Msg>,
    log: EventLog,
}

impl Handle {
    pub fn start_clip(
        &self,
        dir: Option<PathBuf>,
        tl: Option<f64>,
        rate: Option<f64>,
    ) -> Result<PathBuf, String> {
        self.ask(|reply| Msg::Start {
            dir,
            tl,
            rate,
            reply,
        })?
    }

    pub fn stop_clip(&self) -> Result<(), String> {
        self.ask(|reply| Msg::Stop { reply })?
    }

    pub fn status(&self) -> Result<Status, String> {
        self.ask(|reply| Msg::Status { reply })
    }

    pub fn event_log(&self) -> &EventLog {
        &self.log
    }

    /// Round trip to the writer thread: send a reply channel, block on it.
    fn ask<T>(&self, msg: impl FnOnce(Sender<T>) -> Msg) -> Result<T, String> {
        let (tx, rx) = mpsc::channel();
        self.tx
            .send(msg(tx))
            .map_err(|_| "writer thread gone".to_string())?;
        rx.recv().map_err(|_| "writer thread gone".to_string())
    }
}

impl Tap {
    pub fn start(config: Config) -> Result<Tap> {
        let listen = recv::bind_udp(config.listen, Some(recv::RECV_BUF_BYTES))
            .with_context(|| format!("bind listen {}", config.listen))?;
        let forward = UdpSocket::bind("0.0.0.0:0").context("bind forward socket")?;
        forward
            .connect(config.forward)
            .with_context(|| format!("connect forward {}", config.forward))?;
        let relay_sock = UdpSocket::bind("0.0.0.0:0").context("bind relay socket")?;
        let notify = config.td_notify.map(Notify::new).transpose()?;

        let listen_addr = listen.local_addr()?;
        std::fs::create_dir_all(&config.outdir)?;

        let beacon: BeaconState = Arc::new(Mutex::new(None));
        let dropped = Arc::new(AtomicU64::new(0));
        let received = Arc::new(AtomicU64::new(0));
        let event_log = EventLog::new();
        let (tx, rx) = mpsc::sync_channel::<Msg>(writer::CHANNEL_CAP);
        let (ctl_tx, ctl_rx) = mpsc::sync_channel(ctl::CTL_CHANNEL_CAP);

        let recv = recv::Recv {
            listen,
            forward,
            origins: OriginNotifier::new(config.relay)?,
            beacon: beacon.clone(),
            tx: tx.clone(),
            ctl_tx,
            dropped: dropped.clone(),
            received: received.clone(),
        };
        thread::Builder::new()
            .name("recv".into())
            .spawn(move || recv::recv_loop(recv))?;

        let ctl = ctl::Ctl {
            rx: ctl_rx,
            relay_sock,
            relay_addr: config.relay,
            beacon: beacon.clone(),
            handle: Handle {
                tx: tx.clone(),
                log: event_log.clone(),
            },
        };
        thread::Builder::new()
            .name("control".into())
            .spawn(move || ctl::control_loop(ctl))?;

        let writer = writer::Writer::new(
            &config,
            listen_addr.port(),
            beacon,
            dropped,
            received,
            event_log.clone(),
            notify,
        );
        thread::Builder::new()
            .name("writer".into())
            .spawn(move || writer::writer_loop(rx, writer))?;

        Ok(Tap {
            listen_addr,
            handle: Handle { tx, log: event_log },
        })
    }

    pub fn handle(&self) -> Handle {
        self.handle.clone()
    }
}
