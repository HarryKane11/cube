//! Configuration read from `CUBE_RELAY_*` variables. The relay holds no secrets,
//! so none are read here.

use std::fmt;
use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::time::Duration;

use cube_proto::{format_invite_link, parse_invite_link};

/// A well-formed token used only to run a host through the invite-link parser.
const PROBE_TOKEN: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

/// The fixed numbers from `docs/team-relay.md`. They are not configurable from
/// the environment; tests shorten some of them.
#[derive(Clone, Debug)]
pub struct Limits {
    /// A connection must finish `auth` or `claim` within this time.
    pub handshake_timeout: Duration,
    /// A nonce is refused once it is this old.
    pub nonce_ttl: Duration,
    /// Failed handshakes allowed per address and per claimed key within `auth_fail_window`.
    pub auth_fail_max: usize,
    pub auth_fail_window: Duration,
    /// Publish attempts allowed per key within `publish_window`.
    pub publish_max: usize,
    pub publish_window: Duration,
    /// `sync` requests allowed per connection within `sync_window`.
    pub sync_max: usize,
    pub sync_window: Duration,
    /// Frames that may wait for a slow client before it is disconnected.
    pub queue_frames: usize,
    /// Largest incoming WebSocket frame.
    pub max_frame_bytes: usize,
    /// Largest event body.
    pub max_body_bytes: usize,
    /// Events per `events` frame.
    pub sync_page: usize,
    /// An `events` frame is cut short once its bodies add up to this many bytes.
    pub sync_page_bytes: usize,
    /// How far `created_at` may be from relay time, in seconds.
    pub created_at_skew_secs: u64,
}

impl Default for Limits {
    fn default() -> Self {
        Limits {
            handshake_timeout: Duration::from_secs(10),
            nonce_ttl: Duration::from_secs(60),
            auth_fail_max: 10,
            auth_fail_window: Duration::from_secs(60),
            publish_max: 30,
            publish_window: Duration::from_secs(10),
            sync_max: 60,
            sync_window: Duration::from_secs(10),
            queue_frames: 1000,
            max_frame_bytes: 256 * 1024,
            max_body_bytes: 64 * 1024,
            sync_page: 200,
            sync_page_bytes: 1024 * 1024,
            created_at_skew_secs: 600,
        }
    }
}

#[derive(Clone, Debug)]
pub struct Config {
    pub bind: SocketAddr,
    pub db_path: PathBuf,
    pub name: String,
    /// `host[:port]` clients dial, lower-case. Every handshake must name it.
    pub public_host: String,
    /// Peers whose `X-Forwarded-For` is believed.
    pub trusted_proxies: Vec<IpAddr>,
    pub limits: Limits,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigError(pub String);

impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ConfigError {}

fn err<T>(message: impl Into<String>) -> Result<T, ConfigError> {
    Err(ConfigError(message.into()))
}

/// Lower-cases a `host[:port]` and checks it with the same parser clients use
/// for invite links, so a link this relay prints is one the app accepts.
pub fn normalize_host(host: &str) -> Result<String, ConfigError> {
    let host = host.trim().to_ascii_lowercase();
    match parse_invite_link(&format_invite_link(&host, true, PROBE_TOKEN)) {
        Ok(link) if link.host == host => Ok(host),
        _ => err(format!(
            "CUBE_RELAY_PUBLIC_HOST must be a bare host or host:port (no scheme, no path), got `{host}`"
        )),
    }
}

/// True for the hosts the app accepts over plain `ws://`:
/// `localhost`, `127.0.0.1` and `[::1]`, with or without a port.
pub fn is_local_host(host: &str) -> bool {
    parse_invite_link(&format_invite_link(host, false, PROBE_TOKEN)).is_ok()
}

impl Config {
    pub fn from_env() -> Result<Config, ConfigError> {
        Config::from_lookup(|name| std::env::var(name).ok())
    }

    /// Builds the configuration from any source of variables (the process
    /// environment in production, a map in tests).
    pub fn from_lookup(get: impl Fn(&str) -> Option<String>) -> Result<Config, ConfigError> {
        let get = |name: &str| get(name).map(|v| v.trim().to_string()).filter(|v| !v.is_empty());

        let bind_text = get("CUBE_RELAY_BIND").unwrap_or_else(|| "127.0.0.1:8484".to_string());
        let bind: SocketAddr = match bind_text.parse() {
            Ok(addr) => addr,
            Err(_) => {
                return err(format!(
                    "CUBE_RELAY_BIND must be an IP address and port such as 127.0.0.1:8484, got `{bind_text}`"
                ))
            }
        };

        let db_path = PathBuf::from(get("CUBE_RELAY_DB").unwrap_or_else(|| "./cube-relay.db".to_string()));

        let name = get("CUBE_RELAY_NAME").unwrap_or_else(|| "Team".to_string());
        if name.chars().count() > 100 || name.chars().any(char::is_control) {
            return err("CUBE_RELAY_NAME must be at most 100 characters with no control characters");
        }

        let public_host = match get("CUBE_RELAY_PUBLIC_HOST") {
            Some(host) => normalize_host(&host)?,
            None if bind.ip().to_canonical().is_loopback() => {
                if bind.port() == 0 {
                    return err("CUBE_RELAY_PUBLIC_HOST is required when CUBE_RELAY_BIND uses port 0");
                }
                normalize_host(&bind.to_string())?
            }
            None => {
                return err(format!(
                    "CUBE_RELAY_PUBLIC_HOST is required because CUBE_RELAY_BIND ({bind}) is not a loopback address. \
                     Set it to the host (and port, if not 443) that clients dial, e.g. relay.example.com"
                ))
            }
        };

        let mut trusted_proxies = Vec::new();
        if let Some(list) = get("CUBE_RELAY_TRUSTED_PROXY") {
            for entry in list.split(',').map(str::trim).filter(|e| !e.is_empty()) {
                match entry.parse::<IpAddr>() {
                    Ok(ip) => trusted_proxies.push(ip.to_canonical()),
                    Err(_) => {
                        return err(format!(
                            "CUBE_RELAY_TRUSTED_PROXY must be a comma-separated list of IP addresses, got `{entry}`"
                        ))
                    }
                }
            }
        }

        Ok(Config {
            bind,
            db_path,
            name,
            public_host,
            trusted_proxies,
            limits: Limits::default(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn cfg(vars: &[(&str, &str)]) -> Result<Config, ConfigError> {
        let map: HashMap<String, String> =
            vars.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        Config::from_lookup(|name| map.get(name).cloned())
    }

    #[test]
    fn defaults_are_local() {
        let c = cfg(&[]).unwrap();
        assert_eq!(c.bind.to_string(), "127.0.0.1:8484");
        assert_eq!(c.public_host, "127.0.0.1:8484");
        assert_eq!(c.name, "Team");
        assert!(c.trusted_proxies.is_empty());
        assert_eq!(c.db_path, PathBuf::from("./cube-relay.db"));
    }

    #[test]
    fn public_bind_needs_public_host() {
        for bind in ["0.0.0.0:8484", "192.168.1.5:8484", "[::]:8484"] {
            let e = cfg(&[("CUBE_RELAY_BIND", bind)]).unwrap_err();
            assert!(e.0.contains("CUBE_RELAY_PUBLIC_HOST is required"), "{e}");
        }
        let c = cfg(&[
            ("CUBE_RELAY_BIND", "0.0.0.0:8484"),
            ("CUBE_RELAY_PUBLIC_HOST", "Relay.Example.com"),
        ])
        .unwrap();
        assert_eq!(c.public_host, "relay.example.com");
    }

    #[test]
    fn loopback_bind_defaults_public_host() {
        let c = cfg(&[("CUBE_RELAY_BIND", "[::1]:9000")]).unwrap();
        assert_eq!(c.public_host, "[::1]:9000");
        assert!(is_local_host(&c.public_host));
        assert!(cfg(&[("CUBE_RELAY_BIND", "127.0.0.1:0")]).is_err());
    }

    #[test]
    fn bad_values_are_refused() {
        assert!(cfg(&[("CUBE_RELAY_BIND", "localhost:8484")]).is_err());
        assert!(cfg(&[("CUBE_RELAY_PUBLIC_HOST", "https://relay.example.com")]).is_err());
        assert!(cfg(&[("CUBE_RELAY_PUBLIC_HOST", "relay.example.com/ws")]).is_err());
        assert!(cfg(&[("CUBE_RELAY_PUBLIC_HOST", "user@relay.example.com")]).is_err());
        assert!(cfg(&[("CUBE_RELAY_TRUSTED_PROXY", "10.0.0.0/8")]).is_err());
        assert!(cfg(&[("CUBE_RELAY_TRUSTED_PROXY", "caddy")]).is_err());
        assert!(cfg(&[("CUBE_RELAY_NAME", "a\nb")]).is_err());
    }

    #[test]
    fn trusted_proxy_list() {
        let c = cfg(&[("CUBE_RELAY_TRUSTED_PROXY", "10.0.0.2, ::1 ,::ffff:10.0.0.3")]).unwrap();
        let want: Vec<IpAddr> = ["10.0.0.2", "::1", "10.0.0.3"]
            .iter()
            .map(|s| s.parse().unwrap())
            .collect();
        assert_eq!(c.trusted_proxies, want);
    }

    #[test]
    fn local_hosts() {
        for h in ["localhost", "localhost:8484", "127.0.0.1:1", "[::1]:8484"] {
            assert!(is_local_host(h), "{h}");
        }
        for h in ["relay.example.com", "192.168.0.2:8484", "localhost.example.com"] {
            assert!(!is_local_host(h), "{h}");
        }
    }
}
