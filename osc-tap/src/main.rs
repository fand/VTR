use std::net::SocketAddr;
use std::path::PathBuf;

use clap::Parser;
use osc_tap::config::Config;
use osc_tap::{control, tap::Tap};

/// OSC recording proxy: forwards datagrams unchanged, logs parsed copies as JSONL.
#[derive(Parser, Debug)]
#[command(name = "osc-tap", version)]
struct Cli {
    /// UDP port to receive OSC on
    #[arg(long, default_value_t = 10010)]
    listen: u16,

    /// Forward destination (TD)
    #[arg(long, default_value = "127.0.0.1:10011")]
    forward: SocketAddr,

    /// UDP port to receive /tap/timeline beacons on
    #[arg(long, default_value_t = 10012)]
    beacon: u16,

    /// Directory to write clip files to
    #[arg(long, default_value = ".")]
    outdir: PathBuf,

    /// Control socket path (unix domain socket)
    #[arg(long, default_value = "./osc-tap.sock")]
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
        beacon: SocketAddr::from(([0, 0, 0, 0], cli.beacon)),
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
                        eprintln!("osc-tap: stdin closed, exiting");
                        std::process::exit(0);
                    }
                    Ok(_) => {}
                }
            }
        });
    }

    let tap = Tap::start(config.clone())?;
    eprintln!(
        "osc-tap: listen {} -> {}, beacon {}, outdir {:?}, control {:?}",
        tap.listen_addr, config.forward, tap.beacon_addr, config.outdir, cli.control
    );
    control::serve(&cli.control, tap.handle())
}
