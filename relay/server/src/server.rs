//! The network side of the relay: the WebSocket (handshake, frames after
//! `ready`, passing accepted events on to the connected members who may read
//! them) and the two HTTP requests that carry a file's bytes.
//!
//! All shared state sits behind one mutex that is never held across an
//! `.await`. A publish is stored and handed to the queues of its audience
//! while the lock is held, so every client sees events in `seq` order.
//!
//! Who may read what is decided in `db`. This module asks it for every event
//! and every request and keeps no copy of a channel's member list.
//!
//! A file's bytes are read from and written to disk outside the lock. Only
//! judging a ticket and recording a finished upload happen under it.

use std::collections::HashMap;
use std::net::{IpAddr, Ipv6Addr, SocketAddr};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::extract::ws::{Message, Utf8Bytes, WebSocket, WebSocketUpgrade};
use axum::body::Body;
use axum::extract::{ConnectInfo, Path, State};
use axum::http::header::{AUTHORIZATION, CONTENT_LENGTH, CONTENT_TYPE, RETRY_AFTER, WWW_AUTHENTICATE};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
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
use tokio::sync::{mpsc, Semaphore};
use tokio::time::timeout;
use tokio_util::io::ReaderStream;
use tokio_util::sync::CancellationToken;
use tracing::{debug, error, info, warn};

use crate::blob::{Op, ReceiveError, Store, Tickets};
use crate::config::Config;
use crate::db::{
    clean_file_author, clean_member_name, is_pubkey, is_sha256, sha256_hex, valid_file_path, valid_ident,
    Audience, Db, InviteTerms, Member, OpError, Role, DEFAULT_INVITE_DAYS, MAX_INVITE_DAYS, MAX_INVITE_USES,
    STALE_MESSAGE,
};
use crate::limiter::SlidingWindow;

const RELAY_VERSION: &str = "cube-relay/1";
/// What this relay does beyond the first version, named in `ready`.
/// `channels`: private channels, channel member lists, `sync` by channel.
/// `files`: a shared folder per channel (`file.put`, `file.drop`, tickets,
/// `/blob`, `files.list`, `files.history`, `file.touch`).
const FEATURES: [&str; 4] = ["channels", "join-page", "profiles", "files"];
/// The requests that may carry an `id`, which every answer to them repeats.
const ASKS_WITH_ID: [&str; 3] = ["blob.ticket", "files.list", "files.history"];
/// How many versions of one path `files.history` returns.
const HISTORY_LIMIT: usize = 100;
/// The longest ticket a request may present; the ones issued are 43 characters.
const MAX_TICKET_CHARS: usize = 128;
/// What goes out with every answer to a `/blob` request: the bytes are data,
/// never a page, and nothing in between keeps a copy.
const BLOB_HEADERS: [(&str, &str); 2] = [("x-content-type-options", "nosniff"), ("cache-control", "no-store")];
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
        conv: Option<String>,
    },
    #[serde(rename = "invite.create")]
    InviteCreate { role: Option<String>, uses: Option<u64>, days: Option<u64>, conv: Option<String> },
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
    #[serde(rename = "conv.members")]
    ConvMembers { conv: String },
    #[serde(rename = "settings.set")]
    SettingsSet { member_invites: bool },
    #[serde(rename = "blob.ticket")]
    BlobTicket { id: Option<String>, op: String, conv: String, sha: String, size: Option<u64> },
    #[serde(rename = "files.list")]
    FilesList {
        id: Option<String>,
        conv: String,
        #[serde(default)]
        deleted: bool,
    },
    #[serde(rename = "files.history")]
    FilesHistory { id: Option<String>, conv: String, path: String },
    #[serde(rename = "file.touch")]
    FileTouch { id: Option<String>, conv: String, path: String, on: bool, by: Option<serde_json::Value> },
    #[serde(rename = "ping")]
    Ping,
}

impl ClientFrame {
    /// The `id` the client gave this request, to be repeated in its answer.
    fn ask_id(&self) -> Option<&str> {
        match self {
            ClientFrame::BlobTicket { id, .. }
            | ClientFrame::FilesList { id, .. }
            | ClientFrame::FilesHistory { id, .. } => id.as_deref(),
            _ => None,
        }
    }
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
    /// `sync` requests, per connection.
    sync_rate: SlidingWindow<u64>,
    /// `file.touch` requests, per connection.
    touch_rate: SlidingWindow<u64>,
    /// Upload tickets issued, per key.
    upload_rate: SlidingWindow<String>,
    /// The tickets for `/blob` requests that are out.
    tickets: Tickets,
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
    /// Where the bytes of files are kept.
    blobs: Store,
    /// One permit per upload being received.
    uploads: Semaphore,
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

/// What a request that broke a rule is answered with. `stale` also says what
/// the channel has at the path, so the client can show both sides.
fn refusal_frame(id: Option<&str>, error: &OpError) -> Utf8Bytes {
    match error {
        OpError::Refused { code, message } => error_frame(id, code, message),
        OpError::Stale { current } => {
            let mut reply = json!({"t": "error", "code": "stale", "message": STALE_MESSAGE, "current": current});
            if let Some(id) = id {
                reply["id"] = json!(id);
            }
            frame(reply)
        }
        OpError::Internal(_) => error_frame(id, "internal", "internal error"),
    }
}

/// Adds the request's `id` to its answer, if it had one.
fn with_id(mut reply: serde_json::Value, id: Option<String>) -> serde_json::Value {
    if let Some(id) = id {
        reply["id"] = json!(id);
    }
    reply
}

/// The `id` of a request that could not be read as a whole, if it is one of
/// the kinds that carry one: its answer names it all the same.
fn malformed_ask_id(text: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    let kind = value.get("t")?.as_str()?;
    if !ASKS_WITH_ID.contains(&kind) {
        return None;
    }
    value.get("id")?.as_str().filter(|id| valid_ident(id)).map(str::to_string)
}

/// The ticket of a `/blob` request. It is read from the `Authorization`
/// header and nowhere else: an address ends up in logs and histories.
fn bearer(headers: &HeaderMap) -> Option<&str> {
    let value = headers.get(AUTHORIZATION)?.to_str().ok()?;
    let (scheme, token) = value.split_once(' ')?;
    let token = token.trim();
    (scheme.eq_ignore_ascii_case("bearer") && !token.is_empty() && token.len() <= MAX_TICKET_CHARS).then_some(token)
}

/// A short answer to a `/blob` request.
fn blob_reply(status: StatusCode, text: &'static str) -> Response {
    let mut response = Response::new(Body::from(text));
    *response.status_mut() = status;
    let headers = response.headers_mut();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("text/plain; charset=utf-8"));
    for (name, value) in BLOB_HEADERS {
        headers.insert(name, HeaderValue::from_static(value));
    }
    response
}

/// The one answer for a ticket that is missing, unknown, expired, used, or
/// was issued for something else.
fn blob_unauthorized() -> Response {
    let mut response = blob_reply(StatusCode::UNAUTHORIZED, "a valid ticket is required\n");
    response.headers_mut().insert(WWW_AUTHENTICATE, HeaderValue::from_static("Bearer"));
    response
}

fn ok_frame() -> Utf8Bytes {
    frame(json!({"t": "ok"}))
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

    /// Queues an event frame for the connections of the members who may have
    /// it. Membership was read for this event just now; a connection carries
    /// only its key.
    fn deliver(&self, audience: &Audience, frame: &Utf8Bytes) {
        for c in self.conns.values() {
            let wanted = match audience {
                Audience::Everyone => true,
                Audience::Only(members) => members.contains(&c.pubkey),
            };
            if wanted && c.tx.try_send(frame.clone()).is_err() {
                c.kill.cancel();
            }
        }
    }

    /// Queues a frame that is not stored for the connections of the members
    /// in `audience`, leaving out the one who sent it.
    fn deliver_to_others(&self, audience: &Audience, sender: &str, frame: &Utf8Bytes) {
        for c in self.conns.values() {
            let wanted = c.pubkey != sender
                && match audience {
                    Audience::Everyone => true,
                    Audience::Only(members) => members.contains(&c.pubkey),
                };
            if wanted && c.tx.try_send(frame.clone()).is_err() {
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
        let blob_dir = cfg.blob_dir();
        let blobs = Store::open(&blob_dir)
            .map_err(|e| format!("cannot keep files in {}: {e}", blob_dir.display()))?;
        let l = &cfg.limits;
        let core = Core {
            db,
            conns: HashMap::new(),
            next_conn: 1,
            fail_addr: SlidingWindow::new(l.auth_fail_max, l.auth_fail_window),
            fail_key: SlidingWindow::new(l.auth_fail_max, l.auth_fail_window),
            publish_rate: SlidingWindow::new(l.publish_max, l.publish_window),
            sync_rate: SlidingWindow::new(l.sync_max, l.sync_window),
            touch_rate: SlidingWindow::new(l.touch_max, l.touch_window),
            upload_rate: SlidingWindow::new(l.blob_put_max, l.blob_put_window),
            tickets: Tickets::default(),
        };
        let uploads = Semaphore::new(l.blob_uploads_max.max(1));
        Ok(Arc::new(Relay { cfg, ws, core: Mutex::new(core), blobs, uploads, shutdown }))
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
                    Err(OpError::Refused { .. } | OpError::Stale { .. }) => {
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
    /// so `head` and the first broadcast event leave no gap. `head` is the
    /// last seq this member is served, not the last one stored.
    fn register(&self, core: &mut Core, me: &Member) -> Result<Session, Denial> {
        let db = &core.db;
        let (members, head, member_invites) = match (db.members(), db.head_for(&me.pubkey), db.member_invites()) {
            (Ok(members), Ok(head), Ok(member_invites)) => (members, head, member_invites),
            (Err(e), _, _) | (_, Err(e), _) | (_, _, Err(e)) => {
                error!(error = %e, "could not build the ready frame");
                return Err(DENIED_UNAVAILABLE);
            }
        };
        let ready = frame(json!({
            "t": "ready",
            "you": {"pubkey": me.pubkey, "name": me.name, "role": me.role},
            "members": members,
            "head": head,
            "features": FEATURES,
            "settings": {"member_invites": member_invites},
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
            let id = malformed_ask_id(text);
            self.core().send(conn, error_frame(id.as_deref(), "bad_request", "unknown or malformed frame"));
            return;
        };
        match parsed {
            ClientFrame::Ping => self.core().send(conn, frame(json!({"t": "pong"}))),
            ClientFrame::Publish { event } => self.publish(conn, pubkey, event),
            ClientFrame::FileTouch { id, conv, path, on, by } => self.touch(conn, pubkey, id, conv, path, on, by),
            other => {
                // What the answer repeats, so the client can tell which request it is for.
                let id = other.ask_id().map(str::to_string);
                if id.as_deref().is_some_and(|id| !valid_ident(id)) {
                    self.core().send(conn, error_frame(None, "bad_request", "id must be a short string"));
                    return;
                }
                let id = id.as_deref();
                let mut core = self.core();
                // Every `sync` counts, before any other work is done for it.
                if matches!(other, ClientFrame::Sync { .. }) && !core.sync_rate.try_acquire(&conn, Instant::now()) {
                    core.send(conn, error_frame(None, "rate_limited", "syncing too fast"));
                    return;
                }
                match self.operate(&mut core, pubkey, other) {
                    Ok(reply) => core.send(conn, reply),
                    Err(refusal) => {
                        if let OpError::Internal(e) = &refusal {
                            error!(error = %e, "request failed");
                        }
                        core.send(conn, refusal_frame(id, &refusal));
                        if matches!(refusal, OpError::Refused { code: "not_member", .. }) {
                            core.kill(conn);
                        }
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
            ClientFrame::Sync { after, conv } => {
                if conv.as_deref().is_some_and(|conv| !valid_ident(conv)) {
                    return refuse("bad_request", "conv must be a short string");
                }
                let l = &self.cfg.limits;
                let page = core.db.sync_for(&me.pubkey, after, conv.as_deref(), l.sync_page, l.sync_page_bytes)?;
                let mut reply = json!({"t": "events", "events": page.events, "more": page.more, "next": page.next});
                if let Some(conv) = conv {
                    reply["conv"] = json!(conv);
                }
                Ok(frame(reply))
            }
            ClientFrame::InviteCreate { role, uses, days, conv } => {
                let role = match role.as_deref() {
                    None | Some("member") => Role::Member,
                    Some("admin") => Role::Admin,
                    Some("owner") => {
                        return refuse("forbidden", "the owner invite is made with `cube-relay owner-invite`")
                    }
                    Some(_) => return refuse("bad_request", "role must be member or admin"),
                };
                let uses = uses.unwrap_or(1);
                if !(1..=MAX_INVITE_USES).contains(&uses) {
                    return refuse("bad_request", "uses must be between 1 and 100");
                }
                let days = days.unwrap_or(DEFAULT_INVITE_DAYS);
                if !(1..=MAX_INVITE_DAYS).contains(&days) {
                    return refuse("bad_request", "days must be between 1 and 30");
                }
                // Whether this member may make it is decided with the invite's
                // channel, in one transaction.
                let terms = InviteTerms { role, uses, days, conv: conv.as_deref() };
                let invite = core.db.create_invite_as(&me.pubkey, terms, now)?;
                info!(invite = %invite.id, role = role.as_str(), by = short(&me.pubkey), "invite created");
                Ok(frame(json!({"t": "invite", "token": invite.token, "expires_at": invite.expires_at})))
            }
            ClientFrame::InviteList => {
                let invites = core.db.list_invites_for(&me.pubkey, now)?;
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
                core.tickets.drop_member(&target);
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
            ClientFrame::ConvMembers { conv } => {
                let found = core.db.conv_members(&me.pubkey, &conv)?;
                Ok(frame(json!({
                    "t": "conv.members",
                    "conv": conv,
                    "private": found.private,
                    "members": found.members,
                })))
            }
            ClientFrame::SettingsSet { member_invites } => {
                core.db.set_member_invites(&me.pubkey, member_invites)?;
                info!(member_invites, by = short(&me.pubkey), "settings changed");
                core.broadcast(&frame(json!({"t": "settings", "member_invites": member_invites})));
                Ok(ok_frame())
            }
            ClientFrame::BlobTicket { id, op, conv, sha, size } => {
                let op = match op.as_str() {
                    "put" => Op::Put,
                    "get" => Op::Get,
                    _ => return refuse("bad_request", "op must be put or get"),
                };
                if !valid_ident(&conv) {
                    return refuse("bad_request", "conv must be a short string");
                }
                if !is_sha256(&sha) {
                    return refuse("bad_request", "sha must be 64 lower-case hex characters");
                }
                let l = &self.cfg.limits;
                let instant = Instant::now();
                let size = match op {
                    Op::Put => {
                        let Some(size) = size else {
                            return refuse("bad_request", "size is required for put");
                        };
                        let known =
                            core.db.check_upload(&me.pubkey, &conv, &sha, size, l.blob_max_bytes, l.blob_quota_bytes)?;
                        // Nothing to send: the workspace has these bytes, whoever
                        // uploaded them and for whichever channel. That is said
                        // only for a hash together with its exact size.
                        if known && self.blobs.has(&sha, size) {
                            let reply = json!({"t": "blob.ticket", "op": op.as_str(), "sha": sha, "have": true});
                            return Ok(frame(with_id(reply, id)));
                        }
                        size
                    }
                    Op::Get => core.db.check_download(&me.pubkey, &conv, &sha)?,
                };
                if core.tickets.held_by(&me.pubkey, instant) >= l.blob_tickets_per_member {
                    return refuse("rate_limited", "too many unused tickets; use them or wait a minute");
                }
                if op == Op::Put && !core.upload_rate.try_acquire(&me.pubkey, instant) {
                    return refuse("rate_limited", "uploading too fast");
                }
                let ticket = core.tickets.issue(&me.pubkey, op, &conv, &sha, size, l.blob_ticket_ttl, instant);
                let expires = now.saturating_add(l.blob_ticket_ttl.as_secs());
                let reply =
                    json!({"t": "blob.ticket", "op": op.as_str(), "sha": sha, "ticket": ticket, "expires": expires});
                Ok(frame(with_id(reply, id)))
            }
            ClientFrame::FilesList { id, conv, deleted } => {
                let files = core.db.files(&me.pubkey, &conv, deleted)?;
                Ok(frame(with_id(json!({"t": "files", "conv": conv, "files": files}), id)))
            }
            ClientFrame::FilesHistory { id, conv, path } => {
                let versions = core.db.file_history(&me.pubkey, &conv, &path, HISTORY_LIMIT)?;
                let reply = json!({"t": "files.history", "conv": conv, "path": path, "versions": versions});
                Ok(frame(with_id(reply, id)))
            }
            ClientFrame::Publish { .. } | ClientFrame::Ping | ClientFrame::FileTouch { .. } => {
                refuse("bad_request", "unexpected frame")
            }
        }
    }

    /// "Someone is working on this file": passed on to the other members who
    /// can read the channel and kept nowhere. The sender hears back only when
    /// it was refused, and then with the `id` it gave, if it gave one, so a
    /// client can tell that refusal from one that matters to the person.
    #[allow(clippy::too_many_arguments)]
    fn touch(&self, conn: u64, pubkey: &str, id: Option<String>, conv: String, path: String, on: bool, by: Option<serde_json::Value>) {
        let id = id.as_deref().filter(|id| valid_ident(id));
        let mut core = self.core();
        // Every touch counts, before any other work is done for it.
        if !core.touch_rate.try_acquire(&conn, Instant::now()) {
            return core.send(conn, error_frame(id, "rate_limited", "touching too fast"));
        }
        let Ok(by) = clean_file_author(by.as_ref()) else {
            return core.send(conn, error_frame(id, "bad_request", "by needs an agent name and, if given, a #rrggbb color"));
        };
        if !valid_ident(&conv) || !valid_file_path(&path) {
            return core.send(conn, error_frame(id, "bad_request", "conv and path must be a channel and a file path"));
        }
        let audience = match core.db.member(pubkey) {
            Ok(Some(_)) => core.db.readers(pubkey, &conv),
            Ok(None) => Err(OpError::Refused { code: "not_member", message: "not a member" }),
            Err(e) => Err(OpError::Internal(e)),
        };
        match audience {
            Ok(audience) => {
                let touch = json!({"t": "file.touch", "conv": conv, "path": path, "on": on, "pubkey": pubkey, "by": by});
                core.deliver_to_others(&audience, pubkey, &frame(touch));
            }
            Err(refusal) => {
                if let OpError::Internal(e) = &refusal {
                    error!(error = %e, "request failed");
                }
                core.send(conn, refusal_frame(id, &refusal));
                if matches!(refusal, OpError::Refused { code: "not_member", .. }) {
                    core.kill(conn);
                }
            }
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
                    // Read after the event was applied, so a member it just added is in.
                    match core.db.audience(done.seq) {
                        Ok(audience) => {
                            core.deliver(&audience, &frame(EventFrame { t: "event", seq: done.seq, event: &event }));
                        }
                        // Nobody is sent it live; it is stored, and a later sync returns it.
                        Err(e) => error!(error = %e, seq = done.seq, "could not read who an event is for"),
                    }
                }
            }
            Err(refusal) => {
                if let OpError::Internal(e) = &refusal {
                    error!(error = %e, kind = %event.kind, "could not store an event");
                }
                core.send(conn, refusal_frame(Some(&event.id), &refusal));
                if matches!(refusal, OpError::Refused { code: "not_member", .. }) {
                    core.kill(conn);
                }
            }
        }
    }

    // ---- files over HTTP -------------------------------------------------------

    /// `PUT /blob/<sha>`: takes the bytes a ticket was issued for.
    async fn blob_put(&self, sha: &str, headers: &HeaderMap, body: Body) -> Response {
        let Some(token) = bearer(headers) else {
            return blob_unauthorized();
        };
        // Asked before the ticket is used up, so a client that forgot the
        // header, or came at a busy moment, can try again with the same one.
        let length = headers.get(CONTENT_LENGTH).and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<u64>().ok());
        let Some(length) = length else {
            return blob_reply(StatusCode::LENGTH_REQUIRED, "Content-Length is required\n");
        };
        let Ok(_permit) = self.uploads.try_acquire() else {
            let mut response = blob_reply(StatusCode::SERVICE_UNAVAILABLE, "too many uploads at once, try again\n");
            response.headers_mut().insert(RETRY_AFTER, HeaderValue::from_static("1"));
            return response;
        };
        let Some(ticket) = self.core().tickets.redeem(token, Op::Put, sha, Instant::now()) else {
            return blob_unauthorized();
        };
        if length != ticket.size {
            return blob_reply(StatusCode::PAYLOAD_TOO_LARGE, "the length is not the one the ticket was issued for\n");
        }

        let limit = self.cfg.limits.blob_upload_timeout;
        let upload = match timeout(limit, self.blobs.receive(body, ticket.size, &ticket.sha)).await {
            Ok(Ok(upload)) => upload,
            Ok(Err(ReceiveError::TooLong)) => {
                return blob_reply(StatusCode::PAYLOAD_TOO_LARGE, "more bytes than the ticket was issued for\n")
            }
            Ok(Err(ReceiveError::Incomplete)) => {
                return blob_reply(StatusCode::BAD_REQUEST, "the upload ended before all of it arrived\n")
            }
            Ok(Err(ReceiveError::Mismatch)) => {
                return blob_reply(StatusCode::UNPROCESSABLE_ENTITY, "the bytes do not have this SHA-256\n")
            }
            Ok(Err(ReceiveError::Io(e))) => {
                error!(error = %e, "could not write an upload");
                return blob_reply(StatusCode::INTERNAL_SERVER_ERROR, "internal error\n");
            }
            Err(_) => return blob_reply(StatusCode::REQUEST_TIMEOUT, "the upload took too long\n"),
        };

        // Counted against the quota and given its name in one step, so two
        // uploads that each fit cannot both be stored when together they do not.
        let mut core = self.core();
        let quota = self.cfg.limits.blob_quota_bytes;
        match core.db.store_blob(&ticket.sha, ticket.size, &ticket.pubkey, unix_now(), quota) {
            Ok(added) => match self.blobs.keep(upload, &ticket.sha) {
                Ok(()) => {
                    info!(sha = short(&ticket.sha), size = ticket.size, by = short(&ticket.pubkey), "file stored");
                    blob_reply(StatusCode::CREATED, "stored\n")
                }
                Err(e) => {
                    error!(error = %e, "could not put an upload in place");
                    if added {
                        let _ = core.db.forget_blob(&ticket.sha);
                    }
                    blob_reply(StatusCode::INTERNAL_SERVER_ERROR, "internal error\n")
                }
            },
            Err(OpError::Refused { code: "quota", .. }) => {
                blob_reply(StatusCode::INSUFFICIENT_STORAGE, "the workspace's storage for files is full\n")
            }
            // The uploader was removed from the team while the bytes were on their way.
            Err(OpError::Refused { .. } | OpError::Stale { .. }) => blob_unauthorized(),
            Err(OpError::Internal(e)) => {
                error!(error = %e, "could not record an upload");
                blob_reply(StatusCode::INTERNAL_SERVER_ERROR, "internal error\n")
            }
        }
    }

    /// `GET /blob/<sha>`: hands out the bytes a ticket was issued for.
    async fn blob_get(&self, sha: &str, headers: &HeaderMap) -> Response {
        let Some(token) = bearer(headers) else {
            return blob_unauthorized();
        };
        let ticket = {
            let mut core = self.core();
            let Some(ticket) = core.tickets.redeem(token, Op::Get, sha, Instant::now()) else {
                return blob_unauthorized();
            };
            // The ticket was issued up to a minute ago: its holder may have
            // been taken out of the channel, or off the team, since.
            match core.db.can_read(&ticket.pubkey, &ticket.conv) {
                Ok(true) => ticket,
                Ok(false) => return blob_unauthorized(),
                Err(e) => {
                    error!(error = %e, "could not check a download");
                    return blob_reply(StatusCode::INTERNAL_SERVER_ERROR, "internal error\n");
                }
            }
        };
        // The name is the ticket's hash, which was checked to be hex when it was issued.
        let opened = match tokio::fs::File::open(self.blobs.path(&ticket.sha)).await {
            Ok(file) => file.metadata().await.map(|meta| (file, meta.len())),
            Err(e) => Err(e),
        };
        let Ok((file, length)) = opened else {
            return blob_reply(StatusCode::NOT_FOUND, "the relay does not have this file\n");
        };
        let mut response = Response::new(Body::from_stream(ReaderStream::new(file)));
        let headers = response.headers_mut();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/octet-stream"));
        headers.insert(CONTENT_LENGTH, HeaderValue::from(length));
        for (name, value) in BLOB_HEADERS {
            headers.insert(name, HeaderValue::from_static(value));
        }
        response
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

/// The page an invite link opens in a browser. It is the same for every visitor: the invite
/// itself is in the part of the address a browser does not send.
async fn join_page(State(relay): State<Arc<Relay>>) -> Response {
    let mut response = axum::response::IntoResponse::into_response(crate::join::page(&relay.cfg.name, relay.cfg.app_url.as_deref()));
    for (name, value) in crate::join::HEADERS {
        response.headers_mut().insert(name, axum::http::HeaderValue::from_static(value));
    }
    response
}

async fn blob_put(State(relay): State<Arc<Relay>>, Path(sha): Path<String>, headers: HeaderMap, body: Body) -> Response {
    relay.blob_put(&sha, &headers, body).await
}

async fn blob_get(State(relay): State<Arc<Relay>>, Path(sha): Path<String>, headers: HeaderMap) -> Response {
    relay.blob_get(&sha, &headers).await
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

/// Serves `/ws`, `/healthz`, `/join` and `/blob/<sha>` on `listener` until
/// `shutdown` is cancelled.
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
        .route("/join", get(join_page))
        .route("/ws", get(ws_handler))
        .route("/blob/{sha}", get(blob_get).put(blob_put))
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
