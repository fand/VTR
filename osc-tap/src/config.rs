use std::net::SocketAddr;
use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct Config {
    /// Address to receive OSC on (forwarded to `forward`).
    pub listen: SocketAddr,
    /// Destination for the raw datagrams (TD).
    pub forward: SocketAddr,
    /// Address to receive `/tap/timeline` beacons on.
    pub beacon: SocketAddr,
    /// Directory clip files are written to.
    pub outdir: PathBuf,
}
