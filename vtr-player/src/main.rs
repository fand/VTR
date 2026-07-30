use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;

use clap::Parser;

/// Resolver server: replays session.jsonl to the VJ app (push transport),
/// answers per-frame sync queries, and echoes rec state to controllers.
#[derive(Parser, Debug)]
#[command(name = "vtr-player", version)]
struct Cli {
    /// UDP address receiving tap-relayed /vtr/* datagrams
    #[arg(long, default_value = "127.0.0.1:10013")]
    relay: SocketAddr,

    /// Control socket path (unix domain socket)
    #[arg(long, default_value = "./vtr-player.sock")]
    control: PathBuf,

    /// Port controller feedback is sent to (source IP : echo port)
    #[arg(long, default_value_t = 9000)]
    echo_port: u16,

    /// Always feed this host back, on top of the origins seen on the relay
    /// (a controller pinned this way never ages out of the registry)
    #[arg(long)]
    echo_host: Option<IpAddr>,

    /// vtr-tap control socket, followed for rec-state echo
    #[arg(long)]
    tap_control: Option<PathBuf>,

    /// Exit when stdin reaches EOF (parent process died). For child-process supervision.
    #[arg(long)]
    exit_on_stdin_close: bool,
}

fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    if cli.exit_on_stdin_close {
        std::thread::spawn(|| {
            use std::io::Read;
            let mut buf = [0u8; 64];
            loop {
                match std::io::stdin().read(&mut buf) {
                    Ok(0) | Err(_) => {
                        eprintln!("vtr-player: stdin closed, exiting");
                        std::process::exit(0);
                    }
                    Ok(_) => {}
                }
            }
        });
    }

    let player = vtr_player::start(vtr_player::PlayerConfig {
        relay: cli.relay,
        echo_port: cli.echo_port,
        echo_host: cli.echo_host,
        tap_control: cli.tap_control.clone(),
        emit_host: "127.0.0.1".parse().unwrap(),
    })?;
    eprintln!(
        "vtr-player: relay {}, echo {:?}:{}, tap control {:?}, control {:?}",
        player.relay_addr, cli.echo_host, cli.echo_port, cli.tap_control, cli.control
    );
    vtr_player::control::serve(&cli.control, player.ctx)
}
