pub mod control;
pub mod curve;
pub mod echo;
pub mod pattern;
pub mod relay;
pub mod resolver;
pub mod session;
pub mod state;
pub mod transport;

use std::net::{IpAddr, SocketAddr, UdpSocket};
use std::path::PathBuf;
use std::sync::atomic::AtomicU64;
use std::sync::Arc;

use anyhow::{Context, Result};

pub struct PlayerConfig {
    /// Where the tap relays `/vtr/*` datagrams to.
    pub relay: SocketAddr,
    /// Controller feedback goes to `origin IP : echo_port`.
    pub echo_port: u16,
    /// Always-on feedback target, on top of the origins the relay learns.
    /// Set it when a controller must be fed without waiting to be heard from.
    pub echo_host: Option<IpAddr>,
    /// Tap control socket to follow rec state from (None disables echo).
    pub tap_control: Option<PathBuf>,
    /// Host push emissions are sent to (the VJ app).
    pub emit_host: IpAddr,
}

pub struct Player {
    pub relay_addr: SocketAddr,
    pub ctx: Arc<control::Ctx>,
}

/// Bind sockets and spawn the relay / transport / tap-client threads.
/// The control server is started separately with `control::serve`.
pub fn start(cfg: PlayerConfig) -> Result<Player> {
    let shared = Arc::new(state::SharedState::default());
    let relay_sock = UdpSocket::bind(cfg.relay).with_context(|| format!("bind relay {}", cfg.relay))?;
    let relay_addr = relay_sock.local_addr()?;
    let echo = echo::Echo::new(cfg.echo_port, cfg.echo_host)?;
    if let Some(path) = cfg.tap_control {
        echo.spawn_tap_client(path)?;
    }
    let transport = transport::Transport::start(shared.clone(), cfg.emit_host, echo.clone())?;
    relay::spawn(relay_sock, shared.clone(), transport.clone(), echo)?;
    Ok(Player {
        relay_addr,
        ctx: Arc::new(control::Ctx {
            shared,
            transport,
            connections: AtomicU64::new(0),
        }),
    })
}
