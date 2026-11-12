//! `cube-peer`: a developer tool that acts as one teammate against a relay.
//!
//! It speaks the same protocol as the Cube app (see `docs/team-relay.md`) and
//! prints one JSON object per line on stdout. It is for testing: the key sits
//! in a plain file and nothing is pinned between runs.

use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use clap::{Parser, Subcommand};
use cube_proto::{
    auth_message, claim_message, format_invite_link, generate_key, key_from_hex, key_to_hex,
    parse_invite_link, pubkey_hex, sign_event, sign_text, verify_event, Event, SigningKey,
};
use cube_relay::config::{is_local_host, normalize_host};
use cube_relay::db::sha256_hex;
use futures_util::{SinkExt, StreamExt};
use http_body_util::{BodyExt, Full};
use hyper::body::Bytes;
use hyper_util::rt::TokioIo;
use rand::RngCore;
use serde_json::{json, Value};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

const REPLY_TIMEOUT: Duration = Duration::from_secs(15);
/// How long sending or fetching one file may take.
const TRANSFER_TIMEOUT: Duration = Duration::from_secs(150);

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
    Conv {
        conv: String,
        name: String,
        /// Create it as a private channel: only its members can read it.
        #[arg(long)]
        private: bool,
    },
    /// Put a member (public key, hex) in a channel (publishes conv.add).
    Add { conv: String, pubkey: String },
    /// Take a member out of a channel, or leave it yourself (publishes conv.remove).
    Remove { conv: String, pubkey: String },
    /// Print who is in a channel.
    Members { conv: String },
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
    /// Put a local file in a channel's folder: upload it unless the relay
    /// already has it, then publish file.put.
    PutFile {
        conv: String,
        file: PathBuf,
        /// The path in the channel; defaults to the file's name.
        #[arg(long, value_name = "PATH")]
        path: Option<String>,
        /// Say that an agent of this name made the file.
        #[arg(long, value_name = "NAME")]
        agent: Option<String>,
        /// The sha this copy started from, or "" for "there is no file there";
        /// the relay refuses (stale) if the channel has something else.
        #[arg(long, value_name = "SHA")]
        base: Option<String>,
    },
    /// Fetch a file from a channel's folder and check its hash.
    GetFile {
        conv: String,
        path: String,
        to: PathBuf,
        /// Fetch this earlier version instead of the current one.
        #[arg(long, value_name = "SHA")]
        sha: Option<String>,
    },
    /// Print the files in a channel's folder.
    Files {
        conv: String,
        /// Also list the paths whose file was deleted.
        #[arg(long)]
        deleted: bool,
    },
    /// Delete the file at a path for everyone (publishes file.drop).
    DropFile {
        conv: String,
        path: String,
        #[arg(long, value_name = "NAME")]
        agent: Option<String>,
        /// As for put-file.
        #[arg(long, value_name = "SHA")]
        base: Option<String>,
    },
    /// Print the versions of the file at a path, newest first.
    History { conv: String, path: String },
    /// Ask for a ticket to the relay's file store and print it, for testing a client's own
    /// transfer code against a relay. `op` is put or get; a put needs --size.
    Ticket {
        conv: String,
        op: String,
        sha: String,
        #[arg(long, value_name = "BYTES")]
        size: Option<u64>,
    },
    /// Tell the others in a channel that you are working on a file (or, with --off, stopped).
    Touch {
        conv: String,
        path: String,
        #[arg(long)]
        off: bool,
        #[arg(long, value_name = "NAME")]
        agent: Option<String>,
    },
    /// Print every event, member-list, settings and file.touch frame as one JSON line until killed.
    Listen {
        /// First replay history after this sequence number (0 for everything).
        #[arg(long, value_name = "SEQ")]
        from: Option<u64>,
    },
    /// Print what the relay serves after a sequence number, one event per
    /// line, then a line with `next`; with --conv, one channel only.
    Sync {
        #[arg(long, value_name = "SEQ", default_value_t = 0)]
        after: u64,
        #[arg(long, value_name = "ID")]
        conv: Option<String>,
    },
    /// Make an invite and print its link.
    Invite {
        #[arg(long, default_value = "member")]
        role: String,
        /// Put whoever claims it in this channel.
        #[arg(long, value_name = "ID")]
        conv: Option<String>,
    },
    /// Print what the relay says on connecting: you, members, head, features, settings.
    Status,
    /// Change a workspace setting (owner only).
    Settings {
        /// Whether members may invite people to channels they are in.
        #[arg(long, value_name = "BOOL", action = clap::ArgAction::Set)]
        member_invites: bool,
    },
}

/// A failure, printed as `{"ok":false,"code":…,"message":…}`; a `stale`
/// one also says what the channel has (`"current"`).
struct Fail {
    code: String,
    message: String,
    current: Option<String>,
}

impl Fail {
    fn new(code: &str, message: impl Into<String>) -> Fail {
        Fail { code: code.to_string(), message: message.into(), current: None }
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
    endpoint_of(url).map(|(_, host)| host)
}

/// Whether a relay URL is TLS, and the `host[:port]` it names.
fn endpoint_of(url: &str) -> Res<(bool, String)> {
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
    Ok((tls, host))
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

    /// Asks for pages after `after` until the relay says there are no more,
    /// printing each event. Returns how many it printed and the last `next`.
    async fn sync_all(&mut self, mut after: u64, conv: Option<&str>) -> Res<(u64, u64)> {
        let ws = self.ws.clone();
        let mut printed = 0;
        loop {
            let mut request = json!({"t": "sync", "after": after});
            if let Some(conv) = conv {
                request["conv"] = json!(conv);
            }
            let page = self.request(request, "events").await?;
            for item in page.get("events").and_then(Value::as_array).into_iter().flatten() {
                print_event(&as_event_frame(item), &ws);
                printed += 1;
            }
            after = next_after(&page).unwrap_or(after);
            if page.get("more").and_then(Value::as_bool) != Some(true) {
                return Ok((printed, after));
            }
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

    /// Sends a request under a fresh `id` and waits for the answer that
    /// repeats it, whatever else arrives in between.
    async fn ask(&mut self, mut request: Value) -> Res<Value> {
        let id = format!("ask-{}", random_id());
        request["id"] = json!(id);
        self.send(request).await?;
        loop {
            let reply = self.recv().await?;
            if reply.get("id").and_then(Value::as_str) != Some(id.as_str()) {
                continue;
            }
            return match reply.get("t").and_then(Value::as_str) {
                Some("error") => Err(denied(&reply)),
                _ => Ok(reply),
            };
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
    let mut fail = Fail::new(
        frame.get("code").and_then(Value::as_str).unwrap_or("error"),
        frame.get("message").and_then(Value::as_str).unwrap_or(""),
    );
    fail.current = frame.get("current").and_then(Value::as_str).map(str::to_string);
    fail
}

// ---- files over HTTP ---------------------------------------------------------------

async fn exchange<S>(stream: S, request: hyper::Request<Full<Bytes>>) -> Result<(u16, Vec<u8>), String>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let (mut sender, connection) =
        hyper::client::conn::http1::handshake(TokioIo::new(stream)).await.map_err(|e| e.to_string())?;
    tokio::spawn(async move {
        let _ = connection.await;
    });
    let response = sender.send_request(request).await.map_err(|e| e.to_string())?;
    let status = response.status().as_u16();
    let body = response.into_body().collect().await.map_err(|e| e.to_string())?;
    Ok((status, body.to_bytes().to_vec()))
}

/// One `/blob/<sha>` request to the relay named by `--relay`, with the
/// ticket as its only credential. Returns the status and the body.
async fn blob_request(url: &str, method: &str, sha: &str, ticket: &str, body: Option<Vec<u8>>) -> Res<(u16, Vec<u8>)> {
    let (tls, host) = endpoint_of(url)?;
    let transfer = async {
        let body = body.unwrap_or_default();
        let request = hyper::Request::builder()
            .method(method)
            .uri(format!("/blob/{sha}"))
            .header("host", host.as_str())
            .header("authorization", format!("Bearer {ticket}"))
            .header("content-length", body.len())
            .body(Full::new(Bytes::from(body)))
            .map_err(|e| e.to_string())?;
        // `host` may leave the port out; then it is the scheme's.
        let has_port = !host.ends_with(']') && host.rsplit_once(':').is_some_and(|(_, port)| port.parse::<u16>().is_ok());
        let address = if has_port { host.clone() } else { format!("{host}:{}", if tls { 443 } else { 80 }) };
        let tcp = TcpStream::connect(&address).await.map_err(|e| e.to_string())?;
        if !tls {
            return exchange(tcp, request).await;
        }
        let mut roots = rustls::RootCertStore::empty();
        roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        let config = rustls::ClientConfig::builder().with_root_certificates(roots).with_no_client_auth();
        let name = if has_port { host.rsplit_once(':').map_or(host.as_str(), |(name, _)| name) } else { host.as_str() };
        let name = rustls::pki_types::ServerName::try_from(name.trim_matches(['[', ']']).to_string())
            .map_err(|e| e.to_string())?;
        let stream = tokio_rustls::TlsConnector::from(Arc::new(config)).connect(name, tcp).await.map_err(|e| e.to_string())?;
        exchange(stream, request).await
    };
    match tokio::time::timeout(TRANSFER_TIMEOUT, transfer).await {
        Ok(Ok(done)) => Ok(done),
        Ok(Err(e)) => Err(Fail::new("connect", format!("{method} /blob failed: {e}"))),
        Err(_) => Err(Fail::new("timeout", "the transfer took too long")),
    }
}

/// What a `/blob` request that was not answered with `want` is reported as.
fn blob_status(status: u16, want: u16) -> Res<()> {
    if status == want {
        return Ok(());
    }
    let code = match status {
        401 => "ticket",
        404 => "not_found",
        413 => "too_big",
        422 => "hash_mismatch",
        507 => "quota",
        _ => "http",
    };
    Err(Fail::new(code, format!("the relay answered {status}")))
}

/// The `by` of a file event or a touch, when `--agent` was given.
fn by_agent(agent: &Option<String>) -> Option<Value> {
    agent.as_ref().map(|agent| json!({"agent": agent}))
}

// ---- commands --------------------------------------------------------------------

/// Connects and authenticates; also returns the relay's `ready` frame.
async fn connect_ready(cli: &Cli) -> Res<(Client, SigningKey, String, Value)> {
    let key_path = cli.key.as_deref().ok_or_else(|| Fail::new("usage", "--key <file> is required"))?;
    let url = cli.relay.as_deref().ok_or_else(|| Fail::new("usage", "--relay <ws url> is required"))?;
    let host = match cli.host.as_deref() {
        Some(host) => host.to_string(),
        None => authority_of(url)?,
    };
    let key = load_key(key_path)?;
    let mut client = Client::open(url).await?;
    let ready = client.auth(&key, &host).await?;
    Ok((client, key, host, ready))
}

async fn connect(cli: &Cli) -> Res<(Client, SigningKey, String)> {
    let (client, key, host, _) = connect_ready(cli).await?;
    Ok((client, key, host))
}

/// What `join` and `status` print of a `ready` frame.
fn ready_fields(ready: &Value) -> Value {
    json!({
        "you": ready.get("you"),
        "members": ready.get("members"),
        "head": ready.get("head"),
        "features": ready.get("features"),
        "settings": ready.get("settings"),
    })
}

/// An item of an `events` frame, shaped like a live `event` frame.
fn as_event_frame(item: &Value) -> Value {
    let mut item = item.clone();
    if let Some(obj) = item.as_object_mut() {
        obj.insert("t".to_string(), json!("event"));
    }
    item
}

/// Where to continue after an `events` frame: its `next`, or the last seq in
/// it for a relay that does not send one.
fn next_after(page: &Value) -> Option<u64> {
    page.get("next").and_then(Value::as_u64).or_else(|| {
        let events = page.get("events").and_then(Value::as_array)?;
        events.last()?.get("seq").and_then(Value::as_u64)
    })
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
            Some("members" | "settings" | "file.touch") => print_line(&frame),
            Some("events") => {
                for item in frame.get("events").and_then(Value::as_array).into_iter().flatten() {
                    print_event(&as_event_frame(item), &ws);
                }
                if frame.get("more").and_then(Value::as_bool) == Some(true) {
                    if let Some(after) = next_after(&frame) {
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
            let mut out = json!({"ok": true, "relay": link.url, "host": link.host, "ws": client.ws});
            if let (Some(out), Some(fields)) = (out.as_object_mut(), ready_fields(&ready).as_object()) {
                out.extend(fields.clone());
            }
            Ok(out)
        }
        Command::Conv { conv, name, private } => {
            let mut body = json!({"conv": conv, "name": name});
            if *private {
                // Only said when asked for: a rename must not claim a visibility.
                body["private"] = json!(true);
            }
            published(&cli, "conv.put", body, json!({"conv": conv})).await
        }
        Command::Add { conv, pubkey } => {
            let body = json!({"conv": conv, "member": pubkey});
            published(&cli, "conv.add", body, json!({"conv": conv, "member": pubkey})).await
        }
        Command::Remove { conv, pubkey } => {
            let body = json!({"conv": conv, "member": pubkey});
            published(&cli, "conv.remove", body, json!({"conv": conv, "member": pubkey})).await
        }
        Command::Members { conv } => {
            let (mut client, _, _) = connect(&cli).await?;
            let reply = client.request(json!({"t": "conv.members", "conv": conv}), "conv.members").await?;
            Ok(json!({
                "ok": true,
                "conv": reply.get("conv"),
                "private": reply.get("private"),
                "members": reply.get("members"),
            }))
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
        Command::PutFile { conv, file, path, agent, base } => {
            let url = cli.relay.as_deref().ok_or_else(|| Fail::new("usage", "--relay <ws url> is required"))?;
            let bytes = std::fs::read(file)
                .map_err(|e| Fail::new("file", format!("cannot read {}: {e}", file.display())))?;
            let path = match path {
                Some(path) => path.clone(),
                None => file
                    .file_name()
                    .and_then(|name| name.to_str())
                    .map(str::to_string)
                    .ok_or_else(|| Fail::new("usage", "--path is required: the file has no usable name"))?,
            };
            let (sha, size) = (sha256_hex(&bytes), bytes.len());
            let (mut client, key, _) = connect(&cli).await?;
            let ticket = client
                .ask(json!({"t": "blob.ticket", "op": "put", "conv": conv, "sha": sha, "size": size}))
                .await?;
            // The relay may have these bytes already: then there is nothing to send.
            let uploaded = ticket.get("have").and_then(Value::as_bool) != Some(true);
            if uploaded {
                let (status, _) = blob_request(url, "PUT", &sha, &text_field(&ticket, "ticket")?, Some(bytes)).await?;
                blob_status(status, 201)?;
            }
            let mut body = json!({"conv": conv, "path": path, "sha": sha, "size": size});
            if let Some(base) = base {
                body["base"] = json!(base);
            }
            if let Some(by) = by_agent(agent) {
                body["by"] = by;
            }
            let (event, seq) = client.publish(&key, "file.put", body).await?;
            Ok(json!({
                "ok": true, "id": event.id, "seq": seq, "kind": "file.put",
                "conv": conv, "path": path, "sha": sha, "size": size, "uploaded": uploaded,
            }))
        }
        Command::GetFile { conv, path, to, sha } => {
            let url = cli.relay.as_deref().ok_or_else(|| Fail::new("usage", "--relay <ws url> is required"))?;
            let (mut client, _, _) = connect(&cli).await?;
            let sha = match sha {
                Some(sha) => sha.clone(),
                None => {
                    let listed = client.ask(json!({"t": "files.list", "conv": conv})).await?;
                    let files = listed.get("files").and_then(Value::as_array).cloned().unwrap_or_default();
                    // The relay keeps one file per path whatever its spelling, so any spelling finds it.
                    let found = files
                        .iter()
                        .find(|file| {
                            file.get("path").and_then(Value::as_str).is_some_and(|p| p.to_lowercase() == path.to_lowercase())
                        })
                        .ok_or_else(|| Fail::new("not_found", "the channel has no file at this path"))?;
                    text_field(found, "sha")?
                }
            };
            let ticket = client.ask(json!({"t": "blob.ticket", "op": "get", "conv": conv, "sha": sha})).await?;
            let (status, bytes) = blob_request(url, "GET", &sha, &text_field(&ticket, "ticket")?, None).await?;
            blob_status(status, 200)?;
            // The relay is not trusted with the content: what arrived must be what was named.
            if sha256_hex(&bytes) != sha {
                return Err(Fail::new("hash_mismatch", "what the relay sent does not have the file's SHA-256"));
            }
            std::fs::write(to, &bytes).map_err(|e| Fail::new("file", format!("cannot write {}: {e}", to.display())))?;
            Ok(json!({"ok": true, "conv": conv, "path": path, "sha": sha, "size": bytes.len(), "to": to.display().to_string()}))
        }
        Command::Files { conv, deleted } => {
            let (mut client, _, _) = connect(&cli).await?;
            let mut request = json!({"t": "files.list", "conv": conv});
            if *deleted {
                request["deleted"] = json!(true);
            }
            let reply = client.ask(request).await?;
            Ok(json!({"ok": true, "conv": reply.get("conv"), "files": reply.get("files")}))
        }
        Command::DropFile { conv, path, agent, base } => {
            let mut body = json!({"conv": conv, "path": path});
            if let Some(base) = base {
                body["base"] = json!(base);
            }
            if let Some(by) = by_agent(agent) {
                body["by"] = by;
            }
            published(&cli, "file.drop", body, json!({"conv": conv, "path": path})).await
        }
        Command::History { conv, path } => {
            let (mut client, _, _) = connect(&cli).await?;
            let reply = client.ask(json!({"t": "files.history", "conv": conv, "path": path})).await?;
            Ok(json!({
                "ok": true,
                "conv": reply.get("conv"),
                "path": reply.get("path"),
                "versions": reply.get("versions"),
            }))
        }
        Command::Ticket { conv, op, sha, size } => {
            let (mut client, _, _) = connect(&cli).await?;
            let mut request = json!({"t": "blob.ticket", "op": op, "conv": conv, "sha": sha});
            if let Some(size) = size {
                request["size"] = json!(size);
            }
            let reply = client.ask(request).await?;
            Ok(json!({"ok": true, "op": op, "sha": sha, "ticket": reply.get("ticket"), "have": reply.get("have"), "expires": reply.get("expires")}))
        }
        Command::Touch { conv, path, off, agent } => {
            let (mut client, _, _) = connect(&cli).await?;
            let mut touch = json!({"t": "file.touch", "conv": conv, "path": path, "on": !off});
            if let Some(by) = by_agent(agent) {
                touch["by"] = by;
            }
            client.send(touch).await?;
            // A touch that is passed on is not answered. Requests are answered
            // in order, so a `pong` with no error before it means it went through.
            client.request(json!({"t": "ping"}), "pong").await?;
            Ok(json!({"ok": true, "conv": conv, "path": path, "on": !off}))
        }
        Command::Listen { from } => listen(&cli, *from).await,
        Command::Sync { after, conv } => {
            let (mut client, _, _) = connect(&cli).await?;
            let (events, next) = client.sync_all(*after, conv.as_deref()).await?;
            let mut out = json!({"ok": true, "events": events, "next": next});
            if let Some(conv) = conv {
                out["conv"] = json!(conv);
            }
            Ok(out)
        }
        Command::Invite { role, conv } => {
            if role != "member" && role != "admin" {
                return Err(Fail::new("usage", "--role must be member or admin"));
            }
            let (mut client, _, host) = connect(&cli).await?;
            let mut request = json!({"t": "invite.create", "role": role});
            if let Some(conv) = conv {
                request["conv"] = json!(conv);
            }
            let reply = client.request(request, "invite").await?;
            let token = text_field(&reply, "token")?;
            let tls = cli.relay.as_deref().is_some_and(|url| url.starts_with("wss://"));
            let mut out = json!({
                "ok": true,
                "link": format_invite_link(&host, tls, &token),
                "role": role,
                "expires_at": reply.get("expires_at"),
            });
            if let Some(conv) = conv {
                out["conv"] = json!(conv);
            }
            Ok(out)
        }
        Command::Status => {
            let (_, _, _, ready) = connect_ready(&cli).await?;
            let mut out = ready_fields(&ready);
            out["ok"] = json!(true);
            Ok(out)
        }
        Command::Settings { member_invites } => {
            let (mut client, _, _) = connect(&cli).await?;
            client.request(json!({"t": "settings.set", "member_invites": member_invites}), "ok").await?;
            Ok(json!({"ok": true, "member_invites": member_invites}))
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
            let mut out = json!({"ok": false, "code": fail.code, "message": fail.message});
            if let Some(current) = fail.current {
                out["current"] = json!(current);
            }
            print_line(&out);
            ExitCode::FAILURE
        }
    }
}
