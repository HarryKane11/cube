//! `cube-relay` (serve) and `cube-relay owner-invite`.

use std::process::ExitCode;

use cube_relay::{db, Config};
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

const USAGE: &str = "\
cube-relay — team relay for Cube

Usage:
  cube-relay                          serve
  cube-relay owner-invite [--days N]  print a new owner invite link (N: 1-30, default 7)
  cube-relay --version

Configuration (environment):
  CUBE_RELAY_BIND           address to listen on                      [127.0.0.1:8484]
  CUBE_RELAY_DB             SQLite file                               [./cube-relay.db]
  CUBE_RELAY_NAME           workspace name shown to members           [Team]
  CUBE_RELAY_PUBLIC_HOST    host[:port] clients dial; required unless bound to loopback
  CUBE_RELAY_TRUSTED_PROXY  comma-separated proxy addresses whose X-Forwarded-For is believed
  CUBE_RELAY_BLOB_MAX_MB    largest file a member may upload, in MiB  [10]
  CUBE_RELAY_BLOB_QUOTA_MB  what all files together may take, in MiB  [1024]
  RUST_LOG                  log filter                                [info]
";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    match args.as_slice() {
        [] => serve(),
        ["owner-invite"] => owner_invite(db::DEFAULT_INVITE_DAYS),
        ["owner-invite", "--days", days] => match days.parse::<u64>() {
            Ok(days) => owner_invite(days),
            Err(_) => fail("--days takes a number between 1 and 30"),
        },
        ["--version" | "-V"] => {
            println!("cube-relay {}", env!("CARGO_PKG_VERSION"));
            ExitCode::SUCCESS
        }
        ["--help" | "-h" | "help"] => {
            print!("{USAGE}");
            ExitCode::SUCCESS
        }
        _ => {
            eprint!("{USAGE}");
            ExitCode::from(2)
        }
    }
}

fn fail(message: impl std::fmt::Display) -> ExitCode {
    eprintln!("cube-relay: {message}");
    ExitCode::FAILURE
}

/// Prints the link to stdout and nothing to the log: whoever can run this can
/// read the database file anyway, and the link must not land in log storage.
fn owner_invite(days: u64) -> ExitCode {
    let cfg = match Config::from_env() {
        Ok(cfg) => cfg,
        Err(e) => return fail(e),
    };
    match cube_relay::owner_invite(&cfg, days) {
        Ok(link) => {
            println!("{link}");
            eprintln!(
                "Owner invite for {} (valid {days} day(s), one use). Whoever opens it in Cube becomes the owner.",
                cfg.public_host
            );
            ExitCode::SUCCESS
        }
        Err(e) => fail(e),
    }
}

fn serve() -> ExitCode {
    let cfg = match Config::from_env() {
        Ok(cfg) => cfg,
        Err(e) => return fail(e),
    };
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .with_ansi(std::io::IsTerminal::is_terminal(&std::io::stderr()))
        .with_writer(std::io::stderr)
        .init();

    let runtime = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
        Ok(rt) => rt,
        Err(e) => return fail(e),
    };
    runtime.block_on(async move {
        let listener = match TcpListener::bind(cfg.bind).await {
            Ok(l) => l,
            Err(e) => return fail(format!("cannot listen on {}: {e}", cfg.bind)),
        };
        let shutdown = CancellationToken::new();
        tokio::spawn(wait_for_signal(shutdown.clone()));
        match cube_relay::serve(cfg, listener, shutdown).await {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => fail(e),
        }
    })
}

async fn wait_for_signal(shutdown: CancellationToken) {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        match signal(SignalKind::terminate()) {
            Ok(mut term) => {
                tokio::select! {
                    _ = tokio::signal::ctrl_c() => {}
                    _ = term.recv() => {}
                }
            }
            Err(_) => {
                let _ = tokio::signal::ctrl_c().await;
            }
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
    shutdown.cancel();
}
