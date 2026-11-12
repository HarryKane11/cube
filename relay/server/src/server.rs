//! The WebSocket side of the relay: handshake, frames after `ready`, and
//! passing accepted events on to every connected member.
//!
//! All shared state sits behind one mutex that is never held across an
//! `.await`. A publish is stored and handed to every connection's queue while
//! the lock is held, so every client sees events in `seq` order.

use std::collections::HashMap;
use std::net::{IpAddr, Ipv6Addr, SocketAddr};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::extract::ws::{Message, Utf8Bytes, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, State};
use axum::http::HeaderMap;
use axum::response::Response;
use axum::routing::get;
use axum::Router;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use cube_proto::{auth_message, claim_message, verify_event, verify_text, Event, ProtoError};
use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio::time::timeout;
use tokio_util::sync::CancellationToken;
use tracing::{debug, error, info, warn};

use crate::config::Config;
use crate::db::{
    clean_member_name, sha256_hex, Db, Member, OpError, Role, DEFAULT_INVITE_DAYS, MAX_INVITE_DAYS,
    MAX_INVITE_USES,
};
use crate::limiter::SlidingWindow;

const RELAY_VERSION: &str = "cube-relay/1";
/// How long a single write to a client may take before the handshake gives up.
const WRITE_TIMEOUT: Duration = Duration::from_secs(5);

type BoxError = Box<dyn std::error::Error + Send + Sync>;

/// What a refused handshake is told. `auth` failures all look the same, so the
/// relay does not reveal who is a member; `claim` failures all look the same,
/// so it does not reveal whether a token exists, expired or was used up.
#[derive(Clone, Copy)]
struct Denial {
    code: &'static str,
    message: &'static str,
}

const DENIED_AUTH: Denial = Denial { code: "denied", message: "not a member or bad signature" };
const DENIED_CLAIM: Denial = Denial { code: "denied", message: "invite not valid or bad signature" };
const DENIED_RATE: Denial = Denial { code: "rate_limited", message: "too many failed attempts, try again in a minute" };
const DENIED_FRAME: Denial = Denial { code: "bad_request", message: "expected auth or claim" };
const DENIED_NAME: Denial = Denial { code: "bad_request", message: "name must be 1 to 64 characters" };
const DENIED_TIMEOUT: Denial = Denial { code: "timeout", message: "handshake not completed in time" };
const DENIED_UNAVAILABLE: Denial = Denial { code: "unavailable", message: "try again later" };

// Neither enum derives Debug: an invite token or a message body must not end up in a log line.
#[derive(Deserialize)]
#[serde(tag = "t")]
enum Handshake {
    #[serde(rename = "auth")]
    Auth { pubkey: String, host: String, sig: String },
    #[serde(rename = "claim")]
    Claim { invite: String, pubkey: String, name: String, host: String, sig: String },
}

#[derive(Deserialize)]
#[serde(tag = "t")]
enum ClientFrame {
    #[serde(rename = "publish")]
    Publish { event: serde_json::Value },
    #[serde(rename = "sync")]
    Sync {
        #[serde(default)]
        after: u64,
    },
    #[serde(rename = "invite.create")]
    InviteCreate { role: Option<String>, uses: Option<u64>, days: Option<u64> },
    #[serde(rename = "invite.list")]
    InviteList,
    #[serde(rename = "invite.revoke")]
    InviteRevoke { id: String },
    #[serde(rename = "member.remove")]
    MemberRemove { pubkey: String },
    #[serde(rename = "member.role")]
    MemberRole { pubkey: String, role: String },
    #[serde(rename = "member.rename")]
    MemberRename { name: String },
    #[serde(rename = "ping")]
    Ping,
}

#[derive(Serialize)]
struct EventFrame<'a> {
    t: &'static str,
    seq: u64,
    #[serde(flatten)]
    event: &'a Event,
}

struct Conn {
    pubkey: String,
    tx: mpsc::Sender<Utf8Bytes>,
    kill: CancellationToken,
}

struct Core {
    db: Db,
    conns: HashMap<u64, Conn>,
    next_conn: u64,
    fail_addr: SlidingWindow<IpAddr>,
    fail_key: SlidingWindow<String>,
    publish_rate: SlidingWindow<String>,
}

/// An authenticated connection, as handed from the handshake to its tasks.
struct Session {
    id: u64,
    pubkey: String,
    rx: mpsc::Receiver<Utf8Bytes>,
    kill: CancellationToken,
}

pub struct Relay {
    cfg: Config,
    ws: String,
    core: Mutex<Core>,
    shutdown: CancellationToken,
}

fn unix_now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn frame(value: impl Serialize) -> Utf8Bytes {
    serde_json::to_string(&value)
        .unwrap_or_else(|_| r#"{"t":"error","code":"internal","message":"internal error"}"#.to_string())
        .into()
}

fn error_frame(id: Option<&str>, code: &str, message: &str) -> Utf8Bytes {
    match id {
        Some(id) => frame(json!({"t": "error", "id": id, "code": code, "message": message})),
        None => frame(json!({"t": "error", "code": code, "message": message})),
    }
}

fn ok_frame() -> Utf8Bytes {
    frame(json!({"t": "ok"}))
}

fn is_pubkey(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// The first characters of a public key, for log lines.
fn short(pubkey: &str) -> &str {
    pubkey.get(..12).unwrap_or(pubkey)
}

/// The address failed attempts are counted against: an IPv6 client is its /64,
/// since one machine can use any address in it.
fn rate_key(ip: IpAddr) -> IpAddr {
    match ip.to_canonical() {
        IpAddr::V6(v6) => {
            let s = v6.segments();
            IpAddr::V6(Ipv6Addr::new(s[0], s[1], s[2], s[3], 0, 0, 0, 0))
        }
        v4 => v4,
    }
}

/// The client's address. `X-Forwarded-For` is read only when the peer is a
/// trusted proxy, and then the right-most entry that is not itself a trusted
/// proxy is used: entries further left were supplied by the client.
fn client_addr(trusted: &[IpAddr], peer: IpAddr, headers: &HeaderMap) -> IpAddr {
    let peer = peer.to_canonical();
    if !trusted.contains(&peer) {
        return peer;
    }
    let entries: Vec<&str> = headers
        .get_all("x-forwarded-for")
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .map(str::trim)
        .filter(|e| !e.is_empty())
        .collect();
    for entry in entries.iter().rev() {
        match entry.parse::<IpAddr>() {
            Ok(ip) => {
                let ip = ip.to_canonical();
                if !trusted.contains(&ip) {
                    return ip;
                }
            }
            Err(_) => return peer,
        }
    }
    peer
}

impl Core {
    /// Queues a frame for one connection; a full queue disconnects it.
    fn send(&self, conn: u64, frame: Utf8Bytes) {
        if let Some(c) = self.conns.get(&conn) {
            if c.tx.try_send(frame).is_err() {
                c.kill.cancel();
            }
        }
    }

    fn broadcast(&self, frame: &Utf8Bytes) {
        for c in self.conns.values() {
            if c.tx.try_send(frame.clone()).is_err() {
                c.kill.cancel();
            }
        }
    }

    fn broadcast_members(&self) {
        match self.db.members() {
            Ok(members) => self.broadcast(&frame(json!({"t": "members", "members": members}))),
            Err(e) => error!(error = %e, "could not read the member list"),
        }
    }

    fn kill(&self, conn: u64) {
        if let Some(c) = self.conns.get(&conn) {
            c.kill.cancel();
        }
    }

    /// Closes every connection of a key at once.
    fn drop_key(&mut self, pubkey: &str) {
        self.conns.retain(|_, c| {
            if c.pubkey == pubkey {
                c.kill.cancel();
                false
            } else {
                true
            }
        });
    }

    fn note_failure(&mut self, addr: IpAddr, key: Option<&str>, now: Instant) {
        self.fail_addr.record(&addr, now);
        if let Some(key) = key {
            self.fail_key.record(&key.to_string(), now);
        }
    }
}

impl Relay {
    pub fn open(cfg: Config, shutdown: CancellationToken) -> Result<Arc<Relay>, BoxError> {
        let db = Db::open(&cfg.db_path, unix_now())?;
        let ws = db.ws().to_string();
        let l = &cfg.limits;
        let core = Core {
            db,
            conns: HashMap::new(),
            next_conn: 1,
            fail_addr: SlidingWindow::new(l.auth_fail_max, l.auth_fail_window),
            fail_key: SlidingWindow::new(l.auth_fail_max, l.auth_fail_window),
            publish_rate: SlidingWindow::new(l.publish_max, l.publish_window),
        };
        Ok(Arc::new(Relay { cfg, ws, core: Mutex::new(core), shutdown }))
    }

    fn core(&self) -> MutexGuard<'_, Core> {
        // A panic while holding the lock leaves the data as SQLite last committed it.
        self.core.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn addr_blocked(&self, addr: IpAddr) -> bool {
        self.core().fail_addr.is_blocked(&addr, Instant::now())
    }

    fn note_addr_failure(&self, addr: IpAddr) {
        self.core().note_failure(addr, None, Instant::now());
    }

    // ---- handshake -----------------------------------------------------------

    /// Judges the one frame a connection may send before `ready`.
    fn handshake(&self, text: &str, nonce: &str, issued: Instant, addr: IpAddr) -> Result<Session, Denial> {
        let now = Instant::now();
        let Ok(hs) = serde_json::from_str::<Handshake>(text) else {
            self.note_addr_failure(addr);
            return Err(DENIED_FRAME);
        };
        let fresh = issued.elapsed() < self.cfg.limits.nonce_ttl;
        let host = &self.cfg.public_host;

        match hs {
            Handshake::Auth { pubkey, host: claimed_host, sig } => {
                let key_ok = is_pubkey(&pubkey);
                let proof = key_ok
                    && fresh
                    && claimed_host == *host
                    && verify_text(&pubkey, &auth_message(host, &self.ws, nonce), &sig);
                let key = key_ok.then_some(pubkey.as_str());

                let mut core = self.core();
                if core.fail_addr.is_blocked(&addr, now) {
                    core.note_failure(addr, key, now);
                    return Err(DENIED_RATE);
                }
                let member = if proof {
                    match core.db.member(&pubkey) {
                        Ok(m) => m,
                        Err(e) => {
                            error!(error = %e, "member lookup failed");
                            return Err(DENIED_UNAVAILABLE);
                        }
                    }
                } else {
                    None
                };
                match member {
                    // A member who proves their key gets in even while others
                    // are failing in that key's name; otherwise anyone who
                    // knows a public key could lock its owner out.
                    Some(me) => self.register(&mut core, &me),
                    None => {
                        let blocked = key.is_some_and(|k| core.fail_key.is_blocked(&k.to_string(), now));
                        core.note_failure(addr, key, now);
                        debug!(%addr, "auth refused");
                        Err(if blocked { DENIED_RATE } else { DENIED_AUTH })
                    }
                }
            }
            Handshake::Claim { invite, pubkey, name, host: claimed_host, sig } => {
                let Some(name) = clean_member_name(&name) else {
                    self.note_addr_failure(addr);
                    return Err(DENIED_NAME);
                };
                let key_ok = is_pubkey(&pubkey);
                let token_ok = matches!(URL_SAFE_NO_PAD.decode(&invite), Ok(raw) if raw.len() == 32);
                let proof = key_ok
                    && token_ok
                    && fresh
                    && claimed_host == *host
                    && verify_text(&pubkey, &claim_message(host, &self.ws, nonce, &invite), &sig);
                let key = key_ok.then_some(pubkey.as_str());

                let mut core = self.core();
                let blocked = core.fail_addr.is_blocked(&addr, now)
                    || key.is_some_and(|k| core.fail_key.is_blocked(&k.to_string(), now));
                if blocked {
                    core.note_failure(addr, key, now);
                    return Err(DENIED_RATE);
                }
                if !proof {
                    core.note_failure(addr, key, now);
                    debug!(%addr, "claim refused");
                    return Err(DENIED_CLAIM);
                }
                match core.db.claim(&sha256_hex(invite.as_bytes()), &pubkey, &name, unix_now()) {
                    Ok(me) => {
                        info!(member = short(&me.pubkey), role = me.role.as_str(), "invite claimed");
                        // Everyone already connected learns of the new member
                        // (and of an owner change); the newcomer gets the list in `ready`.
                        core.broadcast_members();
                        self.register(&mut core, &me)
                    }
                    Err(OpError::Refused { .. }) => {
                        core.note_failure(addr, key, now);
                        debug!(%addr, "claim refused");
                        Err(DENIED_CLAIM)
                    }
                    Err(OpError::Internal(e)) => {
                        error!(error = %e, "claim failed");
                        Err(DENIED_UNAVAILABLE)
                    }
                }
            }
        }
    }

    /// Adds the connection and queues its `ready` frame. Done under the lock,
    /// so `head` and the first broadcast event leave no gap.
    fn register(&self, core: &mut Core, me: &Member) -> Result<Session, Denial> {
        let (members, head) = match (core.db.members(), core.db.head()) {
            (Ok(members), Ok(head)) => (members, head),
            (Err(e), _) | (_, Err(e)) => {
                error!(error = %e, "could not build the ready frame");
                return Err(DENIED_UNAVAILABLE);
            }
        };
        let ready = frame(json!({
            "t": "ready",
            "you": {"pubkey": me.pubkey, "name": me.name, "role": me.role},
            "members": members,
            "head": head,
        }));
        let (tx, rx) = mpsc::channel(self.cfg.limits.queue_frames.max(1));
        let _ = tx.try_send(ready);
        let kill = self.shutdown.child_token();
        let id = core.next_conn;
        core.next_conn += 1;
        core.conns.insert(id, Conn { pubkey: me.pubkey.clone(), tx, kill: kill.clone() });
        Ok(Session { id, pubkey: me.pubkey.clone(), rx, kill })
    }

    // ---- after ready -----------------------------------------------------------

    fn handle_frame(&self, conn: u64, pubkey: &str, text: &str) {
        let Ok(parsed) = serde_json::from_str::<ClientFrame>(text) else {
            self.core().send(conn, error_frame(None, "bad_request", "unknown or malformed frame"));
            return;
        };
        match parsed {
            ClientFrame::Ping => self.core().send(conn, frame(json!({"t": "pong"}))),
            ClientFrame::Publish { event } => self.publish(conn, pubkey, event),
            other => {
                let mut core = self.core();
                match self.operate(&mut core, pubkey, other) {
                    Ok(reply) => core.send(conn, reply),
                    Err(OpError::Refused { code, message }) => {
                        core.send(conn, error_frame(None, code, message));
                        if code == "not_member" {
                            core.kill(conn);
                        }
                    }
                    Err(OpError::Internal(e)) => {
                        error!(error = %e, "request failed");
                        core.send(conn, error_frame(None, "internal", "internal error"));
                    }
                }
            }
        }
    }

    /// Everything but `publish` and `ping`. The caller's role is read from the
    /// database each time, so a role change or removal applies at once.
    fn operate(&self, core: &mut Core, pubkey: &str, request: ClientFrame) -> Result<Utf8Bytes, OpError> {
        let refuse = |code, message| Err(OpError::Refused { code, message });
        let Some(me) = core.db.member(pubkey)? else {
            return refuse("not_member", "not a member");
        };
        let now = unix_now();
        match request {
            ClientFrame::Sync { after } => {
                let l = &self.cfg.limits;
                let (events, more) = core.db.sync(after, l.sync_page, l.sync_page_bytes)?;
                Ok(frame(json!({"t": "events", "events": events, "more": more})))
            }
            ClientFrame::InviteCreate { role, uses, days } => {
                let role = match role.as_deref() {
                    None | Some("member") => Role::Member,
                    Some("admin") => Role::Admin,
                    Some("owner") => {
                        return refuse("forbidden", "the owner invite is made with `cube-relay owner-invite`")
                    }
                    Some(_) => return refuse("bad_request", "role must be member or admin"),
                };
                let allowed = match me.role {
                    Role::Owner => true,
                    Role::Admin => role == Role::Member,
                    Role::Member => false,
                };
                if !allowed {
                    return refuse("forbidden", "not allowed to make this invite");
                }
                let uses = uses.unwrap_or(1);
                if !(1..=MAX_INVITE_USES).contains(&uses) {
                    return refuse("bad_request", "uses must be between 1 and 100");
                }
                let days = days.unwrap_or(DEFAULT_INVITE_DAYS);
                if !(1..=MAX_INVITE_DAYS).contains(&days) {
                    return refuse("bad_request", "days must be between 1 and 30");
                }
                let invite = core.db.create_invite(role, uses, days, &me.pubkey, now)?;
                info!(invite = %invite.id, role = role.as_str(), by = short(&me.pubkey), "invite created");
                Ok(frame(json!({"t": "invite", "token": invite.token, "expires_at": invite.expires_at})))
            }
            ClientFrame::InviteList => {
                if !me.role.is_staff() {
                    return refuse("forbidden", "only the owner and admins manage invites");
                }
                let invites = core.db.list_invites(now)?;
                Ok(frame(json!({"t": "invites", "invites": invites})))
            }
            ClientFrame::InviteRevoke { id } => {
                core.db.revoke_invite(&me.pubkey, &id)?;
                info!(by = short(&me.pubkey), "invite revoked");
                Ok(ok_frame())
            }
            ClientFrame::MemberRemove { pubkey: target } => {
                core.db.remove_member(&me.pubkey, &target)?;
                info!(member = short(&target), by = short(&me.pubkey), "member removed");
                core.drop_key(&target);
                core.broadcast_members();
                Ok(ok_frame())
            }
            ClientFrame::MemberRole { pubkey: target, role } => {
                let role = match role.as_str() {
                    "admin" => Role::Admin,
                    "member" => Role::Member,
                    "owner" => return refuse("forbidden", "ownership moves only through the owner invite"),
                    _ => return refuse("bad_request", "role must be member or admin"),
                };
                core.db.set_role(&me.pubkey, &target, role)?;
                info!(member = short(&target), role = role.as_str(), "role changed");
                core.broadcast_members();
                Ok(ok_frame())
            }
            ClientFrame::MemberRename { name } => {
                let Some(name) = clean_member_name(&name) else {
                    return refuse("bad_request", "name must be 1 to 64 characters");
                };
                core.db.rename_member(&me.pubkey, &name)?;
                core.broadcast_members();
                Ok(ok_frame())
            }
            ClientFrame::Publish { .. } | ClientFrame::Ping => refuse("bad_request", "unexpected frame"),
        }
    }

    fn publish(&self, conn: u64, pubkey: &str, raw: serde_json::Value) {
        // Echo the id back only if it looks like one.
        let id = raw
            .get("id")
            .and_then(serde_json::Value::as_str)
            .filter(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()))
            .map(str::to_string);
        let reject = |code: &str, message: &str| {
            self.core().send(conn, error_frame(id.as_deref(), code, message));
        };

        // Every attempt counts, accepted or not, before any other work is done.
        if !self.core().publish_rate.try_acquire(&pubkey.to_string(), Instant::now()) {
            return reject("rate_limited", "publishing too fast");
        }
        let Ok(event) = serde_json::from_value::<Event>(raw) else {
            return reject("bad_request", "event is malformed");
        };
        if event.redacted || event.sig.is_none() {
            return reject("bad_request", "event must be signed");
        }
        if event.body.len() > self.cfg.limits.max_body_bytes {
            return reject("too_large", "body is larger than 64 KB");
        }
        if event.pubkey != pubkey {
            return reject("wrong_key", "event is not signed by this connection's key");
        }
        if event.ws != self.ws {
            return reject("wrong_workspace", "event is for another workspace");
        }
        match verify_event(&event) {
            Ok(()) => {}
            Err(ProtoError::BadId) => return reject("bad_id", "id does not match the event"),
            Err(ProtoError::BadField(_)) => return reject("bad_request", "event is malformed"),
            Err(_) => return reject("bad_signature", "signature does not verify"),
        }

        let mut core = self.core();
        match core.db.publish(&event, unix_now(), self.cfg.limits.created_at_skew_secs) {
            Ok(done) => {
                core.send(conn, frame(json!({"t": "ok", "id": event.id, "seq": done.seq})));
                if done.fresh {
                    debug!(seq = done.seq, kind = %event.kind, by = short(pubkey), "event accepted");
                    core.broadcast(&frame(EventFrame { t: "event", seq: done.seq, event: &event }));
                }
            }
            Err(OpError::Refused { code, message }) => {
                core.send(conn, error_frame(Some(&event.id), code, message));
                if code == "not_member" {
                    core.kill(conn);
                }
            }
            Err(OpError::Internal(e)) => {
                error!(error = %e, kind = %event.kind, "could not store an event");
                core.send(conn, error_frame(Some(&event.id), "internal", "internal error"));
            }
        }
    }
}

// ---- connection tasks ------------------------------------------------------------

enum Incoming {
    Text(Utf8Bytes),
    /// A binary frame: the protocol is JSON text frames only.
    Invalid,
    Closed,
}

async fn next_text(stream: &mut SplitStream<WebSocket>) -> Incoming {
    loop {
        match stream.next().await {
            Some(Ok(Message::Text(text))) => return Incoming::Text(text),
            Some(Ok(Message::Ping(_) | Message::Pong(_))) => continue,
            Some(Ok(Message::Binary(_))) => return Incoming::Invalid,
            // An oversized frame surfaces here as an error and ends the connection.
            Some(Ok(Message::Close(_))) | Some(Err(_)) | None => return Incoming::Closed,
        }
    }
}

async fn send_now(sink: &mut SplitSink<WebSocket, Message>, text: Utf8Bytes) -> bool {
    matches!(timeout(WRITE_TIMEOUT, sink.send(Message::Text(text))).await, Ok(Ok(())))
}

async fn deny(sink: &mut SplitSink<WebSocket, Message>, denial: Denial) {
    let text = frame(json!({"t": "denied", "code": denial.code, "message": denial.message}));
    if send_now(sink, text).await {
        let _ = timeout(WRITE_TIMEOUT, sink.send(Message::Close(None))).await;
    }
}

async fn write_loop(
    mut sink: SplitSink<WebSocket, Message>,
    mut rx: mpsc::Receiver<Utf8Bytes>,
    kill: CancellationToken,
) {
    loop {
        tokio::select! {
            biased;
            _ = kill.cancelled() => break,
            next = rx.recv() => {
                let Some(text) = next else { break };
                tokio::select! {
                    _ = kill.cancelled() => break,
                    sent = sink.send(Message::Text(text)) => {
                        if sent.is_err() {
                            kill.cancel();
                            break;
                        }
                    }
                }
            }
        }
    }
    let _ = timeout(Duration::from_secs(1), sink.send(Message::Close(None))).await;
}

async fn handle_socket(relay: Arc<Relay>, socket: WebSocket, addr: IpAddr) {
    let (mut sink, mut stream) = socket.split();
    let addr = rate_key(addr);

    if relay.addr_blocked(addr) {
        deny(&mut sink, DENIED_RATE).await;
        return;
    }

    // The deadline counts from the moment the connection is accepted.
    let deadline = tokio::time::Instant::now() + relay.cfg.limits.handshake_timeout;

    // The nonce lives in this task and nowhere else; it is used for exactly one frame.
    let mut nonce_bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = hex::encode(nonce_bytes);
    let issued = Instant::now();
    let hello = frame(json!({
        "t": "hello",
        "relay": RELAY_VERSION,
        "ws": relay.ws,
        "name": relay.cfg.name,
        "nonce": nonce,
        "time": unix_now(),
    }));
    if !send_now(&mut sink, hello).await {
        return;
    }

    let first = tokio::select! {
        _ = relay.shutdown.cancelled() => return,
        first = tokio::time::timeout_at(deadline, next_text(&mut stream)) => first,
    };
    let text = match first {
        Ok(Incoming::Text(text)) => text,
        Ok(Incoming::Closed) => return,
        Ok(Incoming::Invalid) => {
            relay.note_addr_failure(addr);
            deny(&mut sink, DENIED_FRAME).await;
            return;
        }
        Err(_) => {
            relay.note_addr_failure(addr);
            deny(&mut sink, DENIED_TIMEOUT).await;
            return;
        }
    };

    let session = match relay.handshake(text.as_str(), &nonce, issued, addr) {
        Ok(session) => session,
        Err(denial) => {
            deny(&mut sink, denial).await;
            return;
        }
    };
    drop(text);
    let Session { id, pubkey, rx, kill } = session;
    debug!(conn = id, member = short(&pubkey), "connected");

    let writer = tokio::spawn(write_loop(sink, rx, kill.clone()));
    loop {
        let incoming = tokio::select! {
            _ = kill.cancelled() => break,
            incoming = next_text(&mut stream) => incoming,
        };
        match incoming {
            Incoming::Text(text) => relay.handle_frame(id, &pubkey, text.as_str()),
            Incoming::Invalid | Incoming::Closed => break,
        }
    }
    relay.core().conns.remove(&id);
    kill.cancel();
    let _ = writer.await;
    debug!(conn = id, member = short(&pubkey), "disconnected");
}

async fn ws_handler(
    State(relay): State<Arc<Relay>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    upgrade: WebSocketUpgrade,
) -> Response {
    let addr = client_addr(&relay.cfg.trusted_proxies, peer.ip(), &headers);
    let max = relay.cfg.limits.max_frame_bytes;
    upgrade
        .max_message_size(max)
        .max_frame_size(max)
        .on_upgrade(move |socket| handle_socket(relay, socket, addr))
}

/// Serves `/ws` and `/healthz` on `listener` until `shutdown` is cancelled.
/// No CORS headers are added anywhere.
pub async fn serve(cfg: Config, listener: TcpListener, shutdown: CancellationToken) -> Result<(), BoxError> {
    let relay = Relay::open(cfg, shutdown.clone())?;
    let local = listener.local_addr()?;
    if relay.cfg.trusted_proxies.is_empty() && !local.ip().is_loopback() {
        warn!("no CUBE_RELAY_TRUSTED_PROXY set: behind a proxy, every client would share the proxy's address for rate limiting");
    }
    info!(
        listen = %local,
        public_host = %relay.cfg.public_host,
        workspace = %relay.ws,
        name = %relay.cfg.name,
        "cube-relay is serving"
    );
    let app = Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .route("/ws", get(ws_handler))
        .with_state(relay);
    axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>())
        .with_graceful_shutdown(shutdown.cancelled_owned())
        .await?;
    info!("cube-relay stopped");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    fn xff(values: &[&str]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for v in values {
            h.append("x-forwarded-for", v.parse().unwrap());
        }
        h
    }

    #[test]
    fn forwarded_for_is_ignored_from_untrusted_peers() {
        let h = xff(&["203.0.113.9"]);
        assert_eq!(client_addr(&[], ip("198.51.100.1"), &h), ip("198.51.100.1"));
        assert_eq!(client_addr(&[ip("10.0.0.2")], ip("198.51.100.1"), &h), ip("198.51.100.1"));
    }

    #[test]
    fn forwarded_for_from_a_trusted_proxy() {
        let trusted = [ip("10.0.0.2"), ip("10.0.0.3")];
        assert_eq!(client_addr(&trusted, ip("10.0.0.2"), &xff(&["203.0.113.9"])), ip("203.0.113.9"));
        // The client put a made-up address first; the proxy appended the real one.
        assert_eq!(
            client_addr(&trusted, ip("10.0.0.2"), &xff(&["1.2.3.4, 203.0.113.9"])),
            ip("203.0.113.9")
        );
        // Two proxies in a row, as two header lines.
        assert_eq!(
            client_addr(&trusted, ip("10.0.0.2"), &xff(&["1.2.3.4, 203.0.113.9", "10.0.0.3"])),
            ip("203.0.113.9")
        );
        // Nothing usable: fall back to the peer.
        assert_eq!(client_addr(&trusted, ip("10.0.0.2"), &HeaderMap::new()), ip("10.0.0.2"));
        assert_eq!(client_addr(&trusted, ip("10.0.0.2"), &xff(&["203.0.113.9, garbage"])), ip("10.0.0.2"));
        assert_eq!(client_addr(&trusted, ip("10.0.0.2"), &xff(&["10.0.0.3"])), ip("10.0.0.2"));
        // An IPv4 peer seen through a dual-stack socket.
        assert_eq!(
            client_addr(&trusted, ip("::ffff:10.0.0.2"), &xff(&["203.0.113.9"])),
            ip("203.0.113.9")
        );
    }

    #[test]
    fn ipv6_clients_are_counted_per_64() {
        assert_eq!(rate_key(ip("2001:db8:1:2:3:4:5:6")), ip("2001:db8:1:2::"));
        assert_eq!(rate_key(ip("2001:db8:1:2::1")), rate_key(ip("2001:db8:1:2:ffff::9")));
        assert_ne!(rate_key(ip("2001:db8:1:2::1")), rate_key(ip("2001:db8:1:3::1")));
        assert_eq!(rate_key(ip("192.0.2.7")), ip("192.0.2.7"));
        assert_eq!(rate_key(ip("::ffff:192.0.2.7")), ip("192.0.2.7"));
    }
}
