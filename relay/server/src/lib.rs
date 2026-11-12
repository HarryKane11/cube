//! `cube-relay`: the team relay for Cube, as specified in `docs/team-relay.md`.
//!
//! The relay stores and passes on signed events for exactly one workspace. It
//! holds no secrets and runs no agents.

pub mod config;
pub mod db;
mod limiter;
mod server;

use std::time::{SystemTime, UNIX_EPOCH};

pub use config::{Config, ConfigError, Limits};
pub use server::serve;

/// Makes a new owner invite and returns its link.
///
/// This is what `cube-relay owner-invite` runs. The link is returned to the
/// caller and written nowhere else; only the token's SHA-256 is stored. An
/// earlier owner invite that was not claimed stops working.
pub fn owner_invite(cfg: &Config, days: u64) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    if !(1..=db::MAX_INVITE_DAYS).contains(&days) {
        return Err("days must be between 1 and 30".into());
    }
    let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
    let mut db = db::Db::open(&cfg.db_path, now)?;
    let invite = db.create_owner_invite(days, now)?;
    let tls = !config::is_local_host(&cfg.public_host);
    Ok(cube_proto::format_invite_link(&cfg.public_host, tls, &invite.token))
}
