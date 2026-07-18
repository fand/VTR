use std::net::SocketAddr;
use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct Config {
    /// Address to receive OSC on (forwarded to `forward`).
    pub listen: SocketAddr,
    /// Destination for the raw datagrams (TD).
    pub forward: SocketAddr,
    /// Address to receive `/clock` beacons and `/rec/start` / `/rec/stop` on.
    pub beacon: SocketAddr,
    /// Directory clip files are written to.
    pub outdir: PathBuf,
    /// Omit `tl` when the last beacon is older than this (seconds). A stale
    /// extrapolation looks plausible but poisons the editor's auto-align.
    pub beacon_max_age_s: f64,
}
