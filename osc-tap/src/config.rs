use std::net::SocketAddr;
use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct Config {
    /// Address to receive OSC on (forwarded to `forward`).
    pub listen: SocketAddr,
    /// Destination for the raw datagrams (TD).
    pub forward: SocketAddr,
    /// Destination for relayed `/vtr/*` control datagrams (vtr-player).
    pub relay: SocketAddr,
    /// Rec-transition notifications for the TD tox: plain OSC
    /// `/vtr/rec/start [tl rate]` / `/vtr/rec/stop`, sent on every state
    /// change regardless of initiator (control socket or `/vtr/rec*`).
    pub td_notify: Option<SocketAddr>,
    /// Directory clip files are written to.
    pub outdir: PathBuf,
    /// Omit `tl` when the last beacon is older than this (seconds). A stale
    /// extrapolation looks plausible but poisons the editor's auto-align.
    pub beacon_max_age_s: f64,
}
