use std::net::SocketAddr;
use std::path::PathBuf;

use clap::Parser;
use vtr_tap::config::Config;
use vtr_tap::{control, tap::Tap};

/// OSC recording proxy: forwards datagrams unchanged, logs parsed copies as JSONL.
#[derive(Parser, Debug)]
#[command(name = "vtr-tap", version)]
struct Cli {
    /// UDP port to receive OSC on
    #[arg(long, default_value_t = 10010)]
    listen: u16,

    /// Forward destination (TD)
    #[arg(long, default_value = "127.0.0.1:10011")]
    forward: SocketAddr,

    /// Relay destination for /vtr/* control datagrams (vtr-player)
    #[arg(long, default_value = "127.0.0.1:10013")]
    relay: SocketAddr,

    /// Directory to write clip files to
    #[arg(long, default_value = ".")]
    outdir: PathBuf,

    /// Control socket path (unix domain socket)
    #[arg(long, default_value = "./vtr-tap.sock")]
    control: PathBuf,

    /// Exit when stdin reaches EOF (parent process died). For child-process supervision.
    #[arg(long)]
    exit_on_stdin_close: bool,
}

fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    let config = Config {
        listen: SocketAddr::from(([0, 0, 0, 0], cli.listen)),
        forward: cli.forward,
        relay: cli.relay,
        outdir: cli.outdir,
        beacon_max_age_s: 5.0,
    };
    if cli.exit_on_stdin_close {
        std::thread::spawn(|| {
            use std::io::Read;
            let mut buf = [0u8; 64];
            loop {
                match std::io::stdin().read(&mut buf) {
                    Ok(0) | Err(_) => {
                        eprintln!("vtr-tap: stdin closed, exiting");
                        std::process::exit(0);
                    }
                    Ok(_) => {}
                }
            }
        });
    }

    let tap = Tap::start(config.clone())?;
    eprintln!(
        "vtr-tap: listen {} -> {}, relay {}, outdir {:?}, control {:?}",
        tap.listen_addr, config.forward, config.relay, config.outdir, cli.control
    );
    control::serve(&cli.control, tap.handle())
}
