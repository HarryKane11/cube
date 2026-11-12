//! `cube-peer`: a developer tool that acts as one teammate against a relay.
//!
//! It speaks the same protocol as the Cube app (see `docs/team-relay.md`) and
//! prints one JSON object per line on stdout. It is for testing: the key sits
//! in a plain file and nothing is pinned between runs.

use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use clap::{Parser, Subcommand};
use cube_proto::{
    auth_message, claim_message, format_invite_link, generate_key, key_from_hex, key_to_hex,
    parse_invite_link, pubkey_hex, sign_event, sign_text, verify_event, Event, SigningKey,
};
use cube_relay::config::{is_local_host, normalize_host};
use futures_util::{SinkExt, StreamExt};
use rand::RngCore;
use serde_json::{json, Value};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

const REPLY_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Parser)]
#[command(name = "cube-peer", about = "Act as a teammate against a cube-relay (developer tool)")]
struct Cli {
    /// File holding this peer's private key (hex). `join` creates it, mode 0600.
    #[arg(long, global = true, value_name = "FILE")]
    key: Option<PathBuf>,
    /// Relay URL, e.g. ws://127.0.0.1:8484/ws or wss://relay.example.com/ws.
    #[arg(long, global = true, value_name = "URL")]
    relay: Option<String>,
    /// The host[:port] to sign for; defaults to the one in --relay.
    #[arg(long, global = true, value_name = "HOST")]
    host: Option<String>,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Claim an invite link and become a member.
    Join {
        link: String,
        #[arg(long)]
        name: String,
    },
    /// Post a message to a channel.
    Post { conv: String, text: String },
    /// Create or rename a channel (publishes conv.put).
    Conv { conv: String, name: String },
    /// Replace the text of a message you posted.
    Edit { conv: String, msg_id: String, text: String },
    /// Delete a message.
    Delete { conv: String, msg_id: String },
    /// Offer a sub-agent to the team (publishes agent.put).
    Agent {
        id: String,
        name: String,
        brief: String,
        #[arg(long, default_value = "")]
        instructions: String,
    },
    /// Print every event and member-list frame as one JSON line until killed.
    Listen {
        /// First replay history after this sequence number (0 for everything).
        #[arg(long, value_name = "SEQ")]
        from: Option<u64>,
    },
    /// Make an invite and print its link.
    Invite {
        #[arg(long, default_value = "member")]
        role: String,
    },
}

/// A failure, printed as `{"ok":false,"code":…,"message":…}`.
struct Fail {
    code: String,
    message: String,
}

impl Fail {
    fn new(code: &str, message: impl Into<String>) -> Fail {
        Fail { code: code.to_string(), message: message.into() }
    }
}

type Res<T> = Result<T, Fail>;

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn random_id() -> String {
    let mut raw = [0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut raw);
    hex::encode(raw)
}

fn print_line(value: &Value) {
    println!("{value}");
}

// ---- key file --------------------------------------------------------------------

fn load_key(path: &Path) -> Res<SigningKey> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let meta = std::fs::metadata(path)
            .map_err(|e| Fail::new("key", format!("cannot read key file {}: {e}", path.display())))?;
        if meta.permissions().mode() & 0o077 != 0 {
            return Err(Fail::new(
                "key",
                format!("key file {} is readable by others; run chmod 600 on it", path.display()),
            ));
        }
    }
    let text = std::fs::read_to_string(path)
        .map_err(|e| Fail::new("key", format!("cannot read key file {}: {e}", path.display())))?;
    key_from_hex(&text).map_err(|_| Fail::new("key", format!("{} does not hold a key", path.display())))
}

fn create_key(path: &Path) -> Res<SigningKey> {
    use std::io::Write;
    let key = generate_key();
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|e| Fail::new("key", format!("cannot create key file {}: {e}", path.display())))?;
    writeln!(file, "{}", key_to_hex(&key))
        .map_err(|e| Fail::new("key", format!("cannot write key file {}: {e}", path.display())))?;
    Ok(key)
}

// ---- connection --------------------------------------------------------------------

struct Client {
    socket: WebSocketStream<MaybeTlsStream<TcpStream>>,
    /// Workspace id from `hello`.
    ws: String,
    nonce: String,
}

/// Checks a relay URL the way the app does: `wss://` anywhere, `ws://` only
/// for a local relay. Returns the `host[:port]` it names.
fn authority_of(url: &str) -> Res<String> {
    let (tls, rest) = if let Some(rest) = url.strip_prefix("wss://") {
        (true, rest)
    } else if let Some(rest) = url.strip_prefix("ws://") {
        (false, rest)
    } else {
        return Err(Fail::new("usage", "--relay must start with ws:// or wss://"));
    };
    let authority = rest.split('/').next().unwrap_or("");
    let host = normalize_host(authority).map_err(|_| Fail::new("usage", "--relay names no valid host"))?;
    if !tls && !is_local_host(&host) {
        return Err(Fail::new("usage", "ws:// is only allowed for localhost, 127.0.0.1 and [::1]"));
    }
    Ok(host)
}

impl Client {
    async fn open(url: &str) -> Res<Client> {
        authority_of(url)?;
        let (socket, _) = connect_async(url)
            .await
            .map_err(|e| Fail::new("connect", format!("cannot connect to {url}: {e}")))?;
        let mut client = Client { socket, ws: String::new(), nonce: String::new() };
        let hello = client.recv().await?;
        match hello.get("t").and_then(Value::as_str) {
            Some("hello") => {}
            Some("denied") => return Err(denied(&hello)),
            _ => return Err(Fail::new("protocol", "the relay did not say hello")),
        }
        client.ws = text_field(&hello, "ws")?;
        client.nonce = text_field(&hello, "nonce")?;
        Ok(client)
    }

    async fn send(&mut self, value: Value) -> Res<()> {
        self.socket
            .send(Message::text(value.to_string()))
            .await
            .map_err(|e| Fail::new("connect", format!("send failed: {e}")))
    }

    /// The next JSON text frame.
    async fn recv(&mut self) -> Res<Value> {
        loop {
            let next = tokio::time::timeout(REPLY_TIMEOUT, self.socket.next())
                .await
                .map_err(|_| Fail::new("timeout", "the relay did not answer in time"))?;
            return match next {
                Some(Ok(Message::Text(text))) => serde_json::from_str(text.as_str())
                    .map_err(|_| Fail::new("protocol", "the relay sent something that is not JSON")),
                Some(Ok(Message::Ping(_) | Message::Pong(_))) => continue,
                Some(Ok(_)) | None => Err(Fail::new("closed", "the relay closed the connection")),
                Some(Err(e)) => Err(Fail::new("closed", format!("connection lost: {e}"))),
            };
        }
    }

    /// Like `recv`, but waits without a deadline; `None` when the relay closes.
    async fn recv_forever(&mut self) -> Res<Option<Value>> {
        loop {
            return match self.socket.next().await {
                Some(Ok(Message::Text(text))) => serde_json::from_str(text.as_str())
                    .map(Some)
                    .map_err(|_| Fail::new("protocol", "the relay sent something that is not JSON")),
                Some(Ok(Message::Ping(_) | Message::Pong(_))) => continue,
                Some(Ok(_)) | None => Ok(None),
                Some(Err(e)) => Err(Fail::new("closed", format!("connection lost: {e}"))),
            };
        }
    }

    async fn ready(&mut self) -> Res<Value> {
        let reply = self.recv().await?;
        match reply.get("t").and_then(Value::as_str) {
            Some("ready") => Ok(reply),
            Some("denied") => Err(denied(&reply)),
            _ => Err(Fail::new("protocol", "expected ready or denied")),
        }
    }

    async fn auth(&mut self, key: &SigningKey, host: &str) -> Res<Value> {
        let sig = sign_text(key, &auth_message(host, &self.ws, &self.nonce));
        self.send(json!({"t": "auth", "pubkey": pubkey_hex(key), "host": host, "sig": sig})).await?;
        self.ready().await
    }

    async fn claim(&mut self, key: &SigningKey, host: &str, token: &str, name: &str) -> Res<Value> {
        let sig = sign_text(key, &claim_message(host, &self.ws, &self.nonce, token));
        self.send(json!({
            "t": "claim", "invite": token, "pubkey": pubkey_hex(key), "name": name, "host": host, "sig": sig,
        }))
        .await?;
        self.ready().await
    }

    /// Signs and publishes an event, then waits for the relay's answer to it.
    async fn publish(&mut self, key: &SigningKey, kind: &str, body: Value) -> Res<(Event, u64)> {
        let event = sign_event(key, now(), kind, &self.ws, &body.to_string());
        self.send(json!({"t": "publish", "event": event})).await?;
        loop {
            let reply = self.recv().await?;
            if reply.get("id").and_then(Value::as_str) != Some(event.id.as_str()) {
                continue;
            }
            match reply.get("t").and_then(Value::as_str) {
                Some("ok") => {
                    let seq = reply.get("seq").and_then(Value::as_u64).unwrap_or(0);
                    return Ok((event, seq));
                }
                Some("error") => return Err(denied(&reply)),
                _ => continue,
            }
        }
    }

    /// Sends a request and waits for a frame of type `want` (or an error).
    async fn request(&mut self, request: Value, want: &str) -> Res<Value> {
        self.send(request).await?;
        loop {
            let reply = self.recv().await?;
            match reply.get("t").and_then(Value::as_str) {
                Some(t) if t == want => return Ok(reply),
                Some("error") if reply.get("id").is_none() => return Err(denied(&reply)),
                _ => continue,
            }
        }
    }
}

fn text_field(value: &Value, name: &str) -> Res<String> {
    value
        .get(name)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| Fail::new("protocol", format!("the relay's frame has no `{name}`")))
}

fn denied(frame: &Value) -> Fail {
    Fail::new(
        frame.get("code").and_then(Value::as_str).unwrap_or("error"),
        frame.get("message").and_then(Value::as_str).unwrap_or(""),
    )
}

// ---- commands --------------------------------------------------------------------

async fn connect(cli: &Cli) -> Res<(Client, SigningKey, String)> {
    let key_path = cli.key.as_deref().ok_or_else(|| Fail::new("usage", "--key <file> is required"))?;
    let url = cli.relay.as_deref().ok_or_else(|| Fail::new("usage", "--relay <ws url> is required"))?;
    let host = match cli.host.as_deref() {
        Some(host) => host.to_string(),
        None => authority_of(url)?,
    };
    let key = load_key(key_path)?;
    let mut client = Client::open(url).await?;
    client.auth(&key, &host).await?;
    Ok((client, key, host))
}

async fn published(cli: &Cli, kind: &str, body: Value, extra: Value) -> Res<Value> {
    let (mut client, key, _) = connect(cli).await?;
    let (event, seq) = client.publish(&key, kind, body).await?;
    let mut out = json!({"ok": true, "id": event.id, "seq": seq, "kind": kind});
    if let (Some(out), Some(extra)) = (out.as_object_mut(), extra.as_object()) {
        out.extend(extra.clone());
    }
    Ok(out)
}

/// Prints an event frame if the event verifies (or is marked redacted).
fn print_event(frame: &Value, ws: &str) {
    let ok = match serde_json::from_value::<Event>(frame.clone()) {
        Ok(event) if event.ws != ws => false,
        Ok(event) if event.redacted => true,
        Ok(event) => verify_event(&event).is_ok(),
        Err(_) => false,
    };
    if ok {
        print_line(frame);
    } else {
        let id = frame.get("id").and_then(Value::as_str).unwrap_or("?");
        eprintln!("cube-peer: dropped event {id}: it does not verify");
    }
}

async fn listen(cli: &Cli, from: Option<u64>) -> Res<Value> {
    let (mut client, _, _) = connect(cli).await?;
    let ws = client.ws.clone();
    if let Some(after) = from {
        client.send(json!({"t": "sync", "after": after})).await?;
    }
    while let Some(frame) = client.recv_forever().await? {
        match frame.get("t").and_then(Value::as_str) {
            Some("event") => print_event(&frame, &ws),
            Some("members") => print_line(&frame),
            Some("events") => {
                let mut last = None;
                for item in frame.get("events").and_then(Value::as_array).into_iter().flatten() {
                    let mut item = item.clone();
                    if let Some(obj) = item.as_object_mut() {
                        obj.insert("t".to_string(), json!("event"));
                    }
                    last = item.get("seq").and_then(Value::as_u64).or(last);
                    print_event(&item, &ws);
                }
                if frame.get("more").and_then(Value::as_bool) == Some(true) {
                    if let Some(after) = last {
                        client.send(json!({"t": "sync", "after": after})).await?;
                    }
                }
            }
            _ => {}
        }
    }
    Err(Fail::new("closed", "the relay closed the connection"))
}

async fn run(cli: Cli) -> Res<Value> {
    match &cli.command {
        Command::Join { link, name } => {
            let key_path = cli.key.as_deref().ok_or_else(|| Fail::new("usage", "--key <file> is required"))?;
            let link = parse_invite_link(link).map_err(|e| Fail::new("link", e.to_string()))?;
            let key = if key_path.exists() { load_key(key_path)? } else { create_key(key_path)? };
            let mut client = Client::open(&link.url).await?;
            let ready = client.claim(&key, &link.host, &link.token, name).await?;
            Ok(json!({
                "ok": true,
                "relay": link.url,
                "host": link.host,
                "ws": client.ws,
                "you": ready.get("you"),
                "members": ready.get("members"),
                "head": ready.get("head"),
            }))
        }
        Command::Conv { conv, name } => {
            published(&cli, "conv.put", json!({"conv": conv, "name": name}), json!({"conv": conv})).await
        }
        Command::Post { conv, text } => {
            let msg_id = random_id();
            let body = json!({"conv": conv, "msg": {"id": msg_id, "text": text}});
            published(&cli, "msg.post", body, json!({"conv": conv, "msg_id": msg_id})).await
        }
        Command::Edit { conv, msg_id, text } => {
            let body = json!({"conv": conv, "id": msg_id, "msg": {"id": msg_id, "text": text}});
            published(&cli, "msg.edit", body, json!({"conv": conv, "msg_id": msg_id})).await
        }
        Command::Delete { conv, msg_id } => {
            let body = json!({"conv": conv, "id": msg_id});
            published(&cli, "msg.delete", body, json!({"conv": conv, "msg_id": msg_id})).await
        }
        Command::Agent { id, name, brief, instructions } => {
            let agent = json!({"id": id, "name": name, "role": "", "brief": brief, "instructions": instructions, "palette": ["#1FA864", "#9BE15D", "#12B5CB"]});
            published(&cli, "agent.put", json!({"agent": agent}), json!({"agent": id})).await
        }
        Command::Listen { from } => listen(&cli, *from).await,
        Command::Invite { role } => {
            if role != "member" && role != "admin" {
                return Err(Fail::new("usage", "--role must be member or admin"));
            }
            let (mut client, _, host) = connect(&cli).await?;
            let reply = client.request(json!({"t": "invite.create", "role": role}), "invite").await?;
            let token = text_field(&reply, "token")?;
            let tls = cli.relay.as_deref().is_some_and(|url| url.starts_with("wss://"));
            Ok(json!({
                "ok": true,
                "link": format_invite_link(&host, tls, &token),
                "role": role,
                "expires_at": reply.get("expires_at"),
            }))
        }
    }
}

#[tokio::main]
async fn main() -> ExitCode {
    // tokio-tungstenite's rustls support leaves the choice of crypto provider to the binary.
    let _ = rustls::crypto::ring::default_provider().install_default();
    let cli = Cli::parse();
    match run(cli).await {
        Ok(value) => {
            print_line(&value);
            ExitCode::SUCCESS
        }
        Err(fail) => {
            print_line(&json!({"ok": false, "code": fail.code, "message": fail.message}));
            ExitCode::FAILURE
        }
    }
}
