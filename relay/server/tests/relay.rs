//! End-to-end tests: a real relay on an ephemeral port, real WebSocket clients.

use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use cube_proto::{
    auth_message, claim_message, event_id, generate_key, parse_invite_link, pubkey_hex, sign_event,
    sign_text, verify_event, Event, SigningKey,
};
use cube_relay::{Config, Limits};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};
use tokio_util::sync::CancellationToken;

type Sock = WebSocketStream<MaybeTlsStream<TcpStream>>;

const WAIT: Duration = Duration::from_secs(10);
const GENERIC_AUTH: &str = "not a member or bad signature";
const GENERIC_CLAIM: &str = "invite not valid or bad signature";

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs()
}

fn t(v: &Value) -> &str {
    v["t"].as_str().unwrap_or("")
}

// ---- the relay under test ----------------------------------------------------------

struct TestRelay {
    host: String,
    cfg: Config,
    shutdown: CancellationToken,
    _dir: tempfile::TempDir,
}

impl Drop for TestRelay {
    fn drop(&mut self) {
        self.shutdown.cancel();
    }
}

impl TestRelay {
    async fn start() -> TestRelay {
        TestRelay::start_with(|_| {}).await
    }

    async fn start_with(tweak: impl FnOnce(&mut Config)) -> TestRelay {
        let dir = tempfile::tempdir().unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let mut cfg = Config {
            bind: addr,
            db_path: dir.path().join("relay.db"),
            name: "Test Team".to_string(),
            public_host: addr.to_string(),
            trusted_proxies: Vec::new(),
            app_url: None,
            limits: Limits::default(),
        };
        tweak(&mut cfg);
        let shutdown = CancellationToken::new();
        tokio::spawn({
            let (cfg, shutdown) = (cfg.clone(), shutdown.clone());
            async move { cube_relay::serve(cfg, listener, shutdown).await.unwrap() }
        });
        let relay = TestRelay { host: addr.to_string(), cfg, shutdown, _dir: dir };
        // Answers only once the relay has opened its database and is serving.
        let (status, _, body) = http_get(&relay.host, "/healthz", &[]).await;
        assert_eq!((status.as_str(), body.as_str()), ("HTTP/1.1 200 OK", "ok"));
        relay
    }

    fn url(&self) -> String {
        format!("ws://{}/ws", self.host)
    }

    /// What `cube-relay owner-invite` does, returning the token from the link.
    fn owner_token(&self) -> String {
        let link = cube_relay::owner_invite(&self.cfg, 7).unwrap();
        assert!(link.starts_with(&format!("cube+ws://{}/#invite=", self.host)), "{link}");
        let parsed = parse_invite_link(&link).unwrap();
        assert_eq!(parsed.url, self.url());
        assert_eq!(parsed.host, self.host);
        parsed.token
    }

    async fn owner(&self, name: &str) -> Peer {
        claim(self, generate_key(), &self.owner_token(), name).await.unwrap()
    }

    /// A new member invited by `inviter` (who must be allowed to invite).
    async fn join(&self, inviter: &mut Peer, role: &str, name: &str) -> Peer {
        let token = inviter.invite(json!({"role": role})).await;
        claim(self, generate_key(), &token, name).await.unwrap()
    }

    fn sql(&self, statement: &str) {
        let conn = rusqlite::Connection::open(&self.cfg.db_path).unwrap();
        conn.busy_timeout(Duration::from_secs(5)).unwrap();
        conn.execute(statement, []).unwrap();
    }
}

/// A minimal HTTP/1.1 GET: status line, lower-cased headers, body.
async fn http_get(host: &str, path: &str, headers: &[(&str, &str)]) -> (String, String, String) {
    let host = host.to_string();
    let mut request = format!("GET {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n");
    for (name, value) in headers {
        request.push_str(&format!("{name}: {value}\r\n"));
    }
    request.push_str("\r\n");
    tokio::task::spawn_blocking(move || {
        let mut stream = std::net::TcpStream::connect(&host).unwrap();
        stream.set_read_timeout(Some(WAIT)).unwrap();
        stream.write_all(request.as_bytes()).unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        let (head, body) = response.split_once("\r\n\r\n").unwrap_or((&response, ""));
        let (status, headers) = head.split_once("\r\n").unwrap_or((head, ""));
        (status.to_string(), headers.to_lowercase(), body.to_string())
    })
    .await
    .unwrap()
}

// ---- a client ------------------------------------------------------------------------

async fn send(sock: &mut Sock, value: Value) {
    sock.send(Message::text(value.to_string())).await.unwrap();
}

/// The next JSON frame, or `None` once the relay has closed the connection.
async fn recv(sock: &mut Sock) -> Option<Value> {
    loop {
        let next = tokio::time::timeout(WAIT, sock.next()).await.expect("the relay sent nothing in time");
        match next {
            Some(Ok(Message::Text(text))) => return Some(serde_json::from_str(text.as_str()).unwrap()),
            Some(Ok(Message::Ping(_) | Message::Pong(_))) => continue,
            Some(Ok(Message::Close(_))) | Some(Err(_)) | None => return None,
            Some(Ok(other)) => panic!("unexpected frame {other:?}"),
        }
    }
}

async fn closed(sock: &mut Sock) -> bool {
    let deadline = Instant::now() + WAIT;
    while Instant::now() < deadline {
        if recv(sock).await.is_none() {
            return true;
        }
    }
    false
}

/// Connects and returns the first frame (`hello`, or `denied` when the address is blocked).
async fn connect(relay: &TestRelay, forwarded_for: Option<&str>) -> (Sock, Value) {
    let mut request = relay.url().into_client_request().unwrap();
    if let Some(value) = forwarded_for {
        request.headers_mut().insert("x-forwarded-for", value.parse().unwrap());
    }
    let (mut sock, _) = connect_async(request).await.unwrap();
    let first = recv(&mut sock).await.expect("no first frame");
    (sock, first)
}

fn auth_frame(relay: &TestRelay, key: &SigningKey, hello: &Value) -> Value {
    let message = auth_message(&relay.host, hello["ws"].as_str().unwrap(), hello["nonce"].as_str().unwrap());
    json!({"t": "auth", "pubkey": pubkey_hex(key), "host": relay.host, "sig": sign_text(key, &message)})
}

fn claim_frame(relay: &TestRelay, key: &SigningKey, hello: &Value, token: &str, name: &str) -> Value {
    let message =
        claim_message(&relay.host, hello["ws"].as_str().unwrap(), hello["nonce"].as_str().unwrap(), token);
    json!({
        "t": "claim", "invite": token, "pubkey": pubkey_hex(key), "name": name,
        "host": relay.host, "sig": sign_text(key, &message),
    })
}

/// Sends one handshake frame; `Ok` with the peer on `ready`, `Err` with the `denied` frame.
async fn handshake(mut sock: Sock, hello: Value, key: SigningKey, frame: Value) -> Result<Peer, Value> {
    assert_eq!(t(&hello), "hello", "{hello}");
    send(&mut sock, frame).await;
    let reply = recv(&mut sock).await.expect("no answer to the handshake");
    match t(&reply) {
        "ready" => Ok(Peer {
            sock,
            key,
            ws: hello["ws"].as_str().unwrap().to_string(),
            ready: reply,
            inbox: VecDeque::new(),
        }),
        "denied" => {
            assert!(closed(&mut sock).await, "a denied connection must be closed");
            Err(reply)
        }
        other => panic!("unexpected answer {other}: {reply}"),
    }
}

async fn auth(relay: &TestRelay, key: &SigningKey) -> Result<Peer, Value> {
    let (sock, hello) = connect(relay, None).await;
    let frame = auth_frame(relay, key, &hello);
    handshake(sock, hello, key.clone(), frame).await
}

async fn claim(relay: &TestRelay, key: SigningKey, token: &str, name: &str) -> Result<Peer, Value> {
    let (sock, hello) = connect(relay, None).await;
    let frame = claim_frame(relay, &key, &hello, token, name);
    handshake(sock, hello, key, frame).await
}

struct Peer {
    sock: Sock,
    key: SigningKey,
    ws: String,
    ready: Value,
    /// `event`, `members` and `settings` frames that arrived while waiting for a reply.
    inbox: VecDeque<Value>,
}

impl Peer {
    fn pk(&self) -> String {
        pubkey_hex(&self.key)
    }

    fn role(&self) -> &str {
        self.ready["you"]["role"].as_str().unwrap()
    }

    /// Sends a request and returns its reply, setting broadcasts aside.
    async fn ask(&mut self, request: Value) -> Value {
        send(&mut self.sock, request).await;
        loop {
            let frame = recv(&mut self.sock).await.expect("connection closed while waiting for a reply");
            match t(&frame) {
                "event" | "members" | "settings" => self.inbox.push_back(frame),
                _ => return frame,
            }
        }
    }

    /// The next broadcast frame of type `kind`.
    async fn broadcast(&mut self, kind: &str) -> Value {
        if let Some(i) = self.inbox.iter().position(|f| t(f) == kind) {
            return self.inbox.remove(i).unwrap();
        }
        loop {
            let frame = recv(&mut self.sock).await.expect("connection closed while waiting for a broadcast");
            if t(&frame) == kind {
                return frame;
            }
            self.inbox.push_back(frame);
        }
    }

    fn sign(&self, kind: &str, body: Value) -> Event {
        sign_event(&self.key, now(), kind, &self.ws, &body.to_string())
    }

    async fn send_event(&mut self, event: &Event) -> Value {
        self.ask(json!({"t": "publish", "event": event})).await
    }

    async fn publish(&mut self, kind: &str, body: Value) -> Value {
        let event = self.sign(kind, body);
        let reply = self.send_event(&event).await;
        if t(&reply) == "ok" {
            assert_eq!(reply["id"], json!(event.id));
        }
        reply
    }

    /// Publishes and insists on `ok`; returns the seq.
    async fn must(&mut self, kind: &str, body: Value) -> u64 {
        let reply = self.publish(kind, body).await;
        assert_eq!(t(&reply), "ok", "{reply}");
        reply["seq"].as_u64().unwrap()
    }

    async fn invite(&mut self, options: Value) -> String {
        let mut request = options;
        request["t"] = json!("invite.create");
        let reply = self.ask(request).await;
        assert_eq!(t(&reply), "invite", "{reply}");
        assert!(reply["expires_at"].as_u64().unwrap() > now());
        reply["token"].as_str().unwrap().to_string()
    }

    /// Everything after `after`, following `more`.
    async fn sync_from(&mut self, mut after: u64) -> (Vec<Value>, usize) {
        let mut all = Vec::new();
        let mut pages = 0;
        loop {
            let reply = self.ask(json!({"t": "sync", "after": after})).await;
            assert_eq!(t(&reply), "events", "{reply}");
            pages += 1;
            let events = reply["events"].as_array().unwrap().clone();
            assert!(events.len() <= 200);
            if let Some(last) = events.last() {
                after = last["seq"].as_u64().unwrap();
            }
            all.extend(events);
            if reply["more"] != json!(true) {
                return (all, pages);
            }
        }
    }

    async fn head(&mut self) -> u64 {
        self.sync_from(0).await.0.last().map_or(0, |e| e["seq"].as_u64().unwrap())
    }

    /// One `sync` request, for everything or for one channel.
    async fn sync_page(&mut self, after: u64, conv: Option<&str>) -> Value {
        let mut request = json!({"t": "sync", "after": after});
        if let Some(conv) = conv {
            request["conv"] = json!(conv);
        }
        let reply = self.ask(request).await;
        assert_eq!(t(&reply), "events", "{reply}");
        reply
    }

    /// Everything after `after`, following `next` the way the app does.
    /// Returns the events and the number of pages it took.
    async fn sync_all(&mut self, mut after: u64, conv: Option<&str>) -> (Vec<Value>, usize) {
        let mut all = Vec::new();
        let mut pages = 0;
        loop {
            let page = self.sync_page(after, conv).await;
            pages += 1;
            let events = page["events"].as_array().unwrap().clone();
            let more = page["more"] == json!(true);
            // A page that promises more must bring something and move the position.
            assert!(!more || !events.is_empty(), "an empty page said there is more: {page}");
            let next = page["next"].as_u64().unwrap();
            if let Some(last) = events.last() {
                assert_eq!(json!(next), last["seq"]);
            }
            assert!(!more || next > after);
            after = next;
            all.extend(events);
            if !more {
                return (all, pages);
            }
        }
    }

    /// The live `event` frames up to and including the one with seq `until`,
    /// which this peer must be sent.
    async fn live_until(&mut self, until: u64) -> Vec<Value> {
        let mut seen = Vec::new();
        loop {
            let frame = self.broadcast("event").await;
            let seq = frame["seq"].as_u64().unwrap();
            assert!(seq <= until, "waiting for event {until}, which was never sent; got {seq}");
            seen.push(frame);
            if seq == until {
                return seen;
            }
        }
    }

    /// What the relay says to a new connection of this member.
    async fn ready_again(&self, relay: &TestRelay) -> Value {
        auth(relay, &self.key).await.unwrap().ready
    }
}

fn seqs(events: &[Value]) -> Vec<u64> {
    events.iter().map(|e| e["seq"].as_u64().unwrap()).collect()
}

fn post(conv: &str, id: &str, text: &str) -> Value {
    json!({"conv": conv, "msg": {"id": id, "text": text}})
}

fn error_code(reply: &Value) -> &str {
    assert_eq!(t(reply), "error", "{reply}");
    reply["code"].as_str().unwrap()
}

fn assert_denied(result: Result<Peer, Value>, code: &str, message: &str) {
    match result {
        Ok(_) => panic!("the handshake was accepted"),
        Err(frame) => {
            assert_eq!(frame, json!({"t": "denied", "code": code, "message": message}));
        }
    }
}

fn members_of(frame: &Value) -> Vec<(String, String)> {
    frame["members"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| (m["name"].as_str().unwrap().to_string(), m["role"].as_str().unwrap().to_string()))
        .collect()
}

fn pair(name: &str, role: &str) -> (String, String) {
    (name.to_string(), role.to_string())
}

// ---- transport -----------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn the_invite_page_is_the_same_for_everyone_and_locked_down() {
    let relay = TestRelay::start().await;
    let (status, headers, body) = http_get(&relay.host, "/join", &[]).await;
    assert_eq!(status, "HTTP/1.1 200 OK");
    let headers = headers.to_ascii_lowercase();
    assert!(headers.contains("content-type: text/html"), "{headers}");
    assert!(headers.contains("content-security-policy: default-src 'none'"), "{headers}");
    assert!(headers.contains("referrer-policy: no-referrer"), "{headers}");
    assert!(headers.contains("cache-control: no-store"), "{headers}");
    assert!(body.contains("Open in Cube"));
    // A token in the query string is not something the page ever uses or echoes.
    let (status, _, with_query) = http_get(&relay.host, "/join?invite=abcdefghijklmnopqrstuvwxyz", &[]).await;
    assert_eq!(status, "HTTP/1.1 200 OK");
    assert!(!with_query.contains("abcdefghijklmnopqrstuvwxyz"));
    assert_eq!(with_query, body);
}

#[tokio::test(flavor = "multi_thread")]
async fn healthz_answers_ok_without_cors_headers() {
    let relay = TestRelay::start().await;
    let (status, headers, body) =
        http_get(&relay.host, "/healthz", &[("Origin", "https://evil.example")]).await;
    assert_eq!(status, "HTTP/1.1 200 OK");
    assert_eq!(body, "ok");
    assert!(!headers.contains("access-control"), "{headers}");

    let (status, headers, _) = http_get(&relay.host, "/ws", &[("Origin", "https://evil.example")]).await;
    assert!(status.starts_with("HTTP/1.1 4"), "{status}");
    assert!(!headers.contains("access-control"), "{headers}");

    let (status, _, _) = http_get(&relay.host, "/other", &[]).await;
    assert_eq!(status, "HTTP/1.1 404 Not Found");
}

#[tokio::test(flavor = "multi_thread")]
async fn hello_names_the_workspace_and_a_fresh_nonce() {
    let relay = TestRelay::start().await;
    let (_a, first) = connect(&relay, None).await;
    let (_b, second) = connect(&relay, None).await;
    assert_eq!(first["relay"], json!("cube-relay/1"));
    assert_eq!(first["name"], json!("Test Team"));
    assert_eq!(first["ws"], second["ws"]);
    assert_eq!(first["ws"].as_str().unwrap().len(), 32);
    assert_eq!(first["nonce"].as_str().unwrap().len(), 64);
    assert_ne!(first["nonce"], second["nonce"]);
    assert!(first["time"].as_u64().unwrap().abs_diff(now()) < 5);
}

// ---- joining -------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn owner_invite_makes_the_owner() {
    let relay = TestRelay::start().await;
    let token = relay.owner_token();
    let first_key = generate_key();
    let mut first = claim(&relay, first_key.clone(), &token, "Ann").await.unwrap();
    assert_eq!(first.role(), "owner");
    assert_eq!(first.ready["you"]["pubkey"], json!(first.pk()));
    assert_eq!(first.ready["you"]["name"], json!("Ann"));
    assert_eq!(first.ready["head"], json!(0));
    assert_eq!(members_of(&first.ready), vec![pair("Ann", "owner")]);
    assert!(first.ready["members"][0]["joined_at"].as_u64().unwrap().abs_diff(now()) < 5);

    // The link works once.
    assert_denied(claim(&relay, generate_key(), &token, "Mallory").await, "denied", GENERIC_CLAIM);

    // The owner comes back with nothing but the key.
    let again = auth(&relay, &first_key).await.unwrap();
    assert_eq!(again.role(), "owner");

    // A later owner invite replaces the owner, who becomes an admin.
    let second = relay.owner("Bea").await;
    assert_eq!(second.role(), "owner");
    assert_eq!(members_of(&second.ready), vec![pair("Ann", "admin"), pair("Bea", "owner")]);
    let update = first.broadcast("members").await;
    assert_eq!(members_of(&update), vec![pair("Ann", "admin"), pair("Bea", "owner")]);

    // The earlier owner lost what only an owner may do.
    let reply = first.ask(json!({"t": "invite.create", "role": "admin"})).await;
    assert_eq!(error_code(&reply), "forbidden");
}

#[tokio::test(flavor = "multi_thread")]
async fn member_invite_is_single_use_and_expires() {
    let relay = TestRelay::start().await;
    let mut owner = relay.owner("Ann").await;

    let token = owner.invite(json!({})).await;
    let bea = claim(&relay, generate_key(), &token, "Bea").await.unwrap();
    assert_eq!(bea.role(), "member");
    assert_eq!(members_of(&owner.broadcast("members").await), vec![pair("Ann", "owner"), pair("Bea", "member")]);
    assert_denied(claim(&relay, generate_key(), &token, "Cy").await, "denied", GENERIC_CLAIM);

    // A token that was never issued is answered the same way.
    let unknown = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    assert_denied(claim(&relay, generate_key(), unknown, "Cy").await, "denied", GENERIC_CLAIM);

    // Two uses: the third claim fails.
    let token = owner.invite(json!({"uses": 2, "days": 30})).await;
    for name in ["Cy", "Di"] {
        claim(&relay, generate_key(), &token, name).await.unwrap();
    }
    assert_denied(claim(&relay, generate_key(), &token, "Ed").await, "denied", GENERIC_CLAIM);

    // An expired invite fails like any other bad one.
    let token = owner.invite(json!({})).await;
    let listed = owner.ask(json!({"t": "invite.list"})).await;
    assert_eq!(listed["invites"].as_array().unwrap().len(), 1);
    relay.sql("UPDATE invites SET expires_at = 1000 WHERE ws = (SELECT ws FROM workspace)");
    assert_denied(claim(&relay, generate_key(), &token, "Ed").await, "denied", GENERIC_CLAIM);
    let listed = owner.ask(json!({"t": "invite.list"})).await;
    assert_eq!(listed["invites"], json!([]));

    // An existing member cannot spend an invite, and it stays usable.
    let token = owner.invite(json!({})).await;
    assert_denied(claim(&relay, bea.key.clone(), &token, "Bea again").await, "denied", GENERIC_CLAIM);
    claim(&relay, generate_key(), &token, "Ed").await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn invites_are_listed_without_tokens_and_can_be_revoked() {
    let relay = TestRelay::start().await;
    let mut owner = relay.owner("Ann").await;
    let mut admin = relay.join(&mut owner, "admin", "Bea").await;
    let mut member = relay.join(&mut owner, "member", "Cy").await;

    // Limits on what may be asked for.
    for bad in [json!({"uses": 0}), json!({"uses": 101}), json!({"days": 0}), json!({"days": 31}), json!({"role": "king"})] {
        let mut request = bad;
        request["t"] = json!("invite.create");
        assert_eq!(error_code(&owner.ask(request).await), "bad_request");
    }
    assert_eq!(error_code(&owner.ask(json!({"t": "invite.create", "role": "owner"})).await), "forbidden");
    assert_eq!(error_code(&member.ask(json!({"t": "invite.create"})).await), "forbidden");
    // A member is shown the invites they made, which is none.
    assert_eq!(member.ask(json!({"t": "invite.list"})).await, json!({"t": "invites", "invites": []}));
    assert_eq!(error_code(&admin.ask(json!({"t": "invite.create", "role": "admin"})).await), "forbidden");

    let admin_token = owner.invite(json!({"role": "admin", "days": 2})).await;
    let member_token = admin.invite(json!({"uses": 3})).await;

    let listed = admin.ask(json!({"t": "invite.list"})).await;
    assert_eq!(t(&listed), "invites");
    let text = listed.to_string();
    assert!(!text.contains(&admin_token) && !text.contains(&member_token));
    assert!(!text.contains("token"), "{text}");
    let invites = listed["invites"].as_array().unwrap();
    assert_eq!(invites.len(), 2);
    let by_role = |role: &str| invites.iter().find(|i| i["role"] == json!(role)).unwrap().clone();
    let (admin_invite, member_invite) = (by_role("admin"), by_role("member"));
    assert_eq!(admin_invite["created_by"], json!(owner.pk()));
    assert_eq!(admin_invite["uses_left"], json!(1));
    assert!(admin_invite["expires_at"].as_u64().unwrap().abs_diff(now() + 2 * 86_400) < 5);
    assert_eq!(member_invite["created_by"], json!(admin.pk()));
    assert_eq!(member_invite["uses_left"], json!(3));
    assert!(member_invite["expires_at"].as_u64().unwrap().abs_diff(now() + 7 * 86_400) < 5);

    // An admin revokes member invites only; a member revokes nothing.
    let revoke = |id: &Value| json!({"t": "invite.revoke", "id": id});
    assert_eq!(error_code(&member.ask(revoke(&member_invite["id"])).await), "forbidden");
    assert_eq!(error_code(&admin.ask(revoke(&admin_invite["id"])).await), "forbidden");
    assert_eq!(admin.ask(revoke(&member_invite["id"])).await, json!({"t": "ok"}));
    assert_eq!(error_code(&admin.ask(revoke(&member_invite["id"])).await), "not_found");
    assert_denied(claim(&relay, generate_key(), &member_token, "Di").await, "denied", GENERIC_CLAIM);

    let di = claim(&relay, generate_key(), &admin_token, "Di").await.unwrap();
    assert_eq!(di.role(), "admin");
}

// ---- authenticating ------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn auth_is_denied_with_one_generic_message() {
    let relay = TestRelay::start().await;
    let owner = relay.owner("Ann").await;

    // Not a member.
    let stranger = auth(&relay, &generate_key()).await;
    assert_denied(stranger, "denied", GENERIC_AUTH);

    // A member's key with a signature that does not verify.
    let (sock, hello) = connect(&relay, None).await;
    let mut frame = auth_frame(&relay, &owner.key, &hello);
    frame["sig"] = json!(sign_text(&generate_key(), "something else"));
    assert_denied(handshake(sock, hello, owner.key.clone(), frame).await, "denied", GENERIC_AUTH);

    // A member's key and no usable signature at all.
    let (sock, hello) = connect(&relay, None).await;
    let mut frame = auth_frame(&relay, &owner.key, &hello);
    frame["sig"] = json!("");
    assert_denied(handshake(sock, hello, owner.key.clone(), frame).await, "denied", GENERIC_AUTH);

    // Something that is not a key.
    let (sock, hello) = connect(&relay, None).await;
    let mut frame = auth_frame(&relay, &owner.key, &hello);
    frame["pubkey"] = json!("me");
    assert_denied(handshake(sock, hello, owner.key.clone(), frame).await, "denied", GENERIC_AUTH);

    // A claim answer where an auth answer belongs.
    let (sock, hello) = connect(&relay, None).await;
    let mut frame = auth_frame(&relay, &owner.key, &hello);
    let claim_text = claim_message(&relay.host, hello["ws"].as_str().unwrap(), hello["nonce"].as_str().unwrap(), "x");
    frame["sig"] = json!(sign_text(&owner.key, &claim_text));
    assert_denied(handshake(sock, hello, owner.key.clone(), frame).await, "denied", GENERIC_AUTH);
}

#[tokio::test(flavor = "multi_thread")]
async fn wrong_host_is_denied() {
    let relay = TestRelay::start().await;
    let owner = relay.owner("Ann").await;
    let evil = "relay.evil.example";

    // What a look-alike relay would pass on: signed for, and naming, another host.
    let (sock, hello) = connect(&relay, None).await;
    let message = auth_message(evil, hello["ws"].as_str().unwrap(), hello["nonce"].as_str().unwrap());
    let frame = json!({"t": "auth", "pubkey": owner.pk(), "host": evil, "sig": sign_text(&owner.key, &message)});
    assert_denied(handshake(sock, hello, owner.key.clone(), frame).await, "denied", GENERIC_AUTH);

    // The same signature with the host field rewritten to the real one.
    let (sock, hello) = connect(&relay, None).await;
    let message = auth_message(evil, hello["ws"].as_str().unwrap(), hello["nonce"].as_str().unwrap());
    let frame = json!({"t": "auth", "pubkey": owner.pk(), "host": relay.host, "sig": sign_text(&owner.key, &message)});
    assert_denied(handshake(sock, hello, owner.key.clone(), frame).await, "denied", GENERIC_AUTH);

    // Signed for the real host, but naming another.
    let (sock, hello) = connect(&relay, None).await;
    let mut frame = auth_frame(&relay, &owner.key, &hello);
    frame["host"] = json!(evil);
    assert_denied(handshake(sock, hello, owner.key.clone(), frame).await, "denied", GENERIC_AUTH);

    // `localhost` is not the configured host either, even though it reaches the relay.
    let (sock, hello) = connect(&relay, None).await;
    let other = relay.host.replace("127.0.0.1", "localhost");
    let message = auth_message(&other, hello["ws"].as_str().unwrap(), hello["nonce"].as_str().unwrap());
    let frame = json!({"t": "auth", "pubkey": owner.pk(), "host": other, "sig": sign_text(&owner.key, &message)});
    assert_denied(handshake(sock, hello, owner.key.clone(), frame).await, "denied", GENERIC_AUTH);

    // A claim for the wrong host fails too, and does not spend the invite.
    let token = relay.owner_token();
    let key = generate_key();
    let (sock, hello) = connect(&relay, None).await;
    let message = claim_message(evil, hello["ws"].as_str().unwrap(), hello["nonce"].as_str().unwrap(), &token);
    let frame = json!({
        "t": "claim", "invite": token, "pubkey": pubkey_hex(&key), "name": "Bea",
        "host": evil, "sig": sign_text(&key, &message),
    });
    assert_denied(handshake(sock, hello, key.clone(), frame).await, "denied", GENERIC_CLAIM);
    assert_eq!(claim(&relay, key, &token, "Bea").await.unwrap().role(), "owner");
}

#[tokio::test(flavor = "multi_thread")]
async fn an_answer_works_for_one_connection_only() {
    let relay = TestRelay::start().await;
    let owner = relay.owner("Ann").await;

    // Signed for another connection's nonce.
    let (_other, other_hello) = connect(&relay, None).await;
    let (sock, hello) = connect(&relay, None).await;
    let frame = auth_frame(&relay, &owner.key, &other_hello);
    assert_denied(handshake(sock, hello, owner.key.clone(), frame).await, "denied", GENERIC_AUTH);

    // A frame that was accepted once is worthless on a new connection.
    let (sock, hello) = connect(&relay, None).await;
    let frame = auth_frame(&relay, &owner.key, &hello);
    handshake(sock, hello, owner.key.clone(), frame.clone()).await.unwrap();
    let (sock, hello) = connect(&relay, None).await;
    assert_denied(handshake(sock, hello, owner.key.clone(), frame).await, "denied", GENERIC_AUTH);
}

#[tokio::test(flavor = "multi_thread")]
async fn nothing_but_auth_or_claim_before_ready() {
    let relay = TestRelay::start().await;
    let owner = relay.owner("Ann").await;
    let event = owner.sign("conv.put", json!({"conv": "c", "name": "C"}));

    for frame in [
        json!({"t": "ping"}),
        json!({"t": "sync", "after": 0}),
        json!({"t": "publish", "event": event}),
        json!({"t": "invite.create"}),
        json!({"hello": "there"}),
    ] {
        let (sock, hello) = connect(&relay, None).await;
        let result = handshake(sock, hello, owner.key.clone(), frame).await;
        assert_denied(result, "bad_request", "expected auth or claim");
    }

    // Not JSON, and a binary frame.
    let (mut sock, _) = connect(&relay, None).await;
    sock.send(Message::text("not json")).await.unwrap();
    assert_eq!(recv(&mut sock).await.unwrap()["code"], json!("bad_request"));
    assert!(closed(&mut sock).await);
    let (mut sock, _) = connect(&relay, None).await;
    sock.send(Message::binary(vec![1u8, 2, 3])).await.unwrap();
    assert_eq!(recv(&mut sock).await.unwrap()["code"], json!("bad_request"));
    assert!(closed(&mut sock).await);

    // Nothing was published by any of that.
    let mut owner = owner;
    assert_eq!(owner.head().await, 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn handshake_has_a_deadline() {
    let relay = TestRelay::start_with(|cfg| cfg.limits.handshake_timeout = Duration::from_millis(300)).await;
    let (mut sock, hello) = connect(&relay, None).await;
    assert_eq!(t(&hello), "hello");
    let started = Instant::now();
    let frame = recv(&mut sock).await.unwrap();
    assert_eq!(frame["t"], json!("denied"));
    assert_eq!(frame["code"], json!("timeout"));
    assert!(closed(&mut sock).await);
    let waited = started.elapsed();
    assert!(waited >= Duration::from_millis(250) && waited < Duration::from_secs(5), "{waited:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn bad_names_are_refused_before_the_invite_is_looked_at() {
    let relay = TestRelay::start().await;
    let token = relay.owner_token();
    for name in ["", "   ", "line\nbreak", &"x".repeat(65)] {
        let result = claim(&relay, generate_key(), &token, name).await;
        assert_denied(result, "bad_request", "name must be 1 to 64 characters");
    }
    let owner = claim(&relay, generate_key(), &token, "  Ann  ").await.unwrap();
    assert_eq!(owner.ready["you"]["name"], json!("Ann"));
}

// ---- rate limits ---------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn failed_handshakes_are_rate_limited_per_address() {
    let relay = TestRelay::start().await;
    let owner = relay.owner("Ann").await;

    // `X-Forwarded-For` is ignored because no proxy is trusted: every attempt
    // counts against the one real address, whatever the header says.
    for i in 0..10 {
        let forwarded = format!("203.0.113.{i}");
        let (sock, hello) = connect(&relay, Some(&forwarded)).await;
        let key = generate_key();
        let frame = auth_frame(&relay, &key, &hello);
        assert_denied(handshake(sock, hello, key, frame).await, "denied", GENERIC_AUTH);
    }
    let (mut sock, first) = connect(&relay, Some("198.51.100.77")).await;
    assert_eq!(
        first,
        json!({"t": "denied", "code": "rate_limited", "message": "too many failed attempts, try again in a minute"})
    );
    assert!(closed(&mut sock).await);

    // The block is on the address, so it holds for a real member too.
    let (mut sock, first) = connect(&relay, None).await;
    assert_eq!(first["code"], json!("rate_limited"));
    assert!(closed(&mut sock).await);
    drop(owner);
}

#[tokio::test(flavor = "multi_thread")]
async fn failed_handshakes_are_rate_limited_per_key_behind_a_trusted_proxy() {
    let relay = TestRelay::start_with(|cfg| cfg.trusted_proxies = vec!["127.0.0.1".parse().unwrap()]).await;
    let owner = relay.owner("Ann").await;
    let victim = owner.pk();

    // Ten addresses, one failure each, all in the owner's name.
    for i in 0..10 {
        let forwarded = format!("203.0.113.{i}");
        let (sock, hello) = connect(&relay, Some(&forwarded)).await;
        let frame = json!({"t": "auth", "pubkey": victim, "host": relay.host, "sig": "00"});
        assert_denied(handshake(sock, hello, generate_key(), frame).await, "denied", GENERIC_AUTH);
    }
    // The key is now limited, from any address...
    let (sock, hello) = connect(&relay, Some("203.0.113.200")).await;
    assert_eq!(t(&hello), "hello");
    let frame = json!({"t": "auth", "pubkey": victim, "host": relay.host, "sig": "00"});
    assert_denied(
        handshake(sock, hello, generate_key(), frame).await,
        "rate_limited",
        "too many failed attempts, try again in a minute",
    );
    // ...but its owner, who can sign, is not locked out by other people's failures.
    let (sock, hello) = connect(&relay, Some("198.51.100.5")).await;
    let frame = auth_frame(&relay, &owner.key, &hello);
    handshake(sock, hello, owner.key.clone(), frame).await.unwrap();

    // Each address is counted on its own: one of them reaching the limit
    // leaves the others alone. The client-supplied entry on the left is ignored.
    for _ in 0..9 {
        let (sock, hello) = connect(&relay, Some("198.51.100.99, 203.0.113.0")).await;
        let key = generate_key();
        let frame = auth_frame(&relay, &key, &hello);
        assert_denied(handshake(sock, hello, key, frame).await, "denied", GENERIC_AUTH);
    }
    let (_, first) = connect(&relay, Some("203.0.113.0")).await;
    assert_eq!(first["code"], json!("rate_limited"));
    let (_, first) = connect(&relay, Some("198.51.100.99")).await;
    assert_eq!(t(&first), "hello");
}

#[tokio::test(flavor = "multi_thread")]
async fn publishing_is_rate_limited_per_key() {
    let relay = TestRelay::start().await;
    let mut owner = relay.owner("Ann").await;
    let mut bea = relay.join(&mut owner, "member", "Bea").await;
    owner.must("conv.put", json!({"conv": "c", "name": "C"})).await;

    for i in 0..30 {
        bea.must("msg.post", json!({"conv": "c", "msg": {"id": format!("b{i}"), "text": "hi"}})).await;
    }
    let reply = bea.publish("msg.post", json!({"conv": "c", "msg": {"id": "b30", "text": "hi"}})).await;
    assert_eq!(error_code(&reply), "rate_limited");

    // The limit is per key, not per connection...
    let mut second = auth(&relay, &bea.key).await.unwrap();
    let reply = second.publish("msg.post", json!({"conv": "c", "msg": {"id": "b31", "text": "hi"}})).await;
    assert_eq!(error_code(&reply), "rate_limited");
    // ...and another member is unaffected.
    owner.must("msg.post", json!({"conv": "c", "msg": {"id": "a0", "text": "hi"}})).await;
    assert_eq!(owner.head().await, 32);
}

// ---- events --------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn accepted_events_reach_every_member_in_order() {
    let relay = TestRelay::start().await;
    let mut owner = relay.owner("Ann").await;
    let mut bea = relay.join(&mut owner, "member", "Bea").await;

    assert_eq!(owner.must("conv.put", json!({"conv": "c", "name": "C"})).await, 1);
    for i in 0..10u64 {
        let seq = bea.must("msg.post", json!({"conv": "c", "msg": {"id": format!("m{i}"), "text": "hi", "agent": {"id": "a", "name": "Coder", "engine": "x"}}})).await;
        assert_eq!(seq, i + 2);
    }
    for peer in [&mut owner, &mut bea] {
        for seq in 1..=11u64 {
            let frame = peer.broadcast("event").await;
            assert_eq!(frame["seq"], json!(seq));
            let event: Event = serde_json::from_value(frame).unwrap();
            assert_eq!(verify_event(&event), Ok(()));
            assert_eq!(event.ws, peer.ws);
        }
    }

    // A member who connects later is told where the log stands and can read all of it.
    let mut late = auth(&relay, &bea.key).await.unwrap();
    assert_eq!(late.ready["head"], json!(11));
    let (events, _) = late.sync_from(0).await;
    assert_eq!(events.len(), 11);
    assert_eq!(late.ask(json!({"t": "ping"})).await, json!({"t": "pong"}));
    assert_eq!(error_code(&late.ask(json!({"t": "dance"})).await), "bad_request");
    send(&mut late.sock, json!("just a string")).await;
    assert_eq!(error_code(&recv(&mut late.sock).await.unwrap()), "bad_request");
}

#[tokio::test(flavor = "multi_thread")]
async fn tampered_events_are_refused() {
    let relay = TestRelay::start().await;
    let mut owner = relay.owner("Ann").await;
    owner.must("conv.put", json!({"conv": "c", "name": "C"})).await;
    let good = owner.sign("msg.post", json!({"conv": "c", "msg": {"id": "m1", "text": "pay 10"}}));

    // The body changed after signing.
    let mut event = good.clone();
    event.body = event.body.replace("pay 10", "pay 1000");
    assert_eq!(error_code(&owner.send_event(&event).await), "bad_id");

    // ...and the id recomputed to match: now the signature is for another id.
    event.id = event_id(&event.pubkey, event.created_at, &event.kind, &event.ws, &event.body);
    let reply = owner.send_event(&event).await;
    assert_eq!(error_code(&reply), "bad_signature");
    assert_eq!(reply["id"], json!(event.id));

    // One flipped character in the signature.
    let mut event = good.clone();
    let sig = event.sig.take().unwrap();
    let flipped = if sig.starts_with('0') { "1" } else { "0" };
    event.sig = Some(format!("{flipped}{}", &sig[1..]));
    assert_eq!(error_code(&owner.send_event(&event).await), "bad_signature");

    // No signature, or marked as already redacted.
    let mut event = good.clone();
    event.sig = None;
    assert_eq!(error_code(&owner.send_event(&event).await), "bad_request");
    let mut event = good.clone();
    event.redacted = true;
    assert_eq!(error_code(&owner.send_event(&event).await), "bad_request");

    // Not an event at all.
    assert_eq!(error_code(&owner.ask(json!({"t": "publish", "event": {"id": 5}})).await), "bad_request");

    // None of it was stored or passed on; the untouched event still goes through.
    assert_eq!(owner.head().await, 1);
    assert_eq!(t(&owner.send_event(&good).await), "ok");
    assert_eq!(owner.head().await, 2);
}

#[tokio::test(flavor = "multi_thread")]
async fn an_event_must_be_signed_by_the_connections_key() {
    let relay = TestRelay::start().await;
    let mut owner = relay.owner("Ann").await;
    let mut bea = relay.join(&mut owner, "member", "Bea").await;
    owner.must("conv.put", json!({"conv": "c", "name": "C"})).await;

    // A perfectly valid event by the owner, sent over Bea's connection.
    let event = owner.sign("msg.post", json!({"conv": "c", "msg": {"id": "m1", "text": "from the owner"}}));
    assert_eq!(verify_event(&event), Ok(()));
    assert_eq!(error_code(&bea.send_event(&event).await), "wrong_key");

    // A valid event by a key that is not a member, sent over Bea's connection.
    let outsider = generate_key();
    let event = sign_event(&outsider, now(), "msg.post", &bea.ws, r#"{"conv":"c","msg":{"id":"m2","text":"x"}}"#);
    assert_eq!(error_code(&bea.send_event(&event).await), "wrong_key");

    // An event for another workspace.
    let event = sign_event(&bea.key, now(), "msg.post", "another-workspace", r#"{"conv":"c","msg":{"id":"m3","text":"x"}}"#);
    assert_eq!(error_code(&bea.send_event(&event).await), "wrong_workspace");

    assert_eq!(owner.head().await, 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn replay_is_idempotent_for_the_author_and_refused_for_others() {
    let relay = TestRelay::start().await;
    let mut owner = relay.owner("Ann").await;
    let mut bea = relay.join(&mut owner, "member", "Bea").await;
    owner.must("conv.put", json!({"conv": "c", "name": "C"})).await;

    let event = bea.sign("msg.post", json!({"conv": "c", "msg": {"id": "m1", "text": "once"}}));
    let first = bea.send_event(&event).await;
    assert_eq!(first, json!({"t": "ok", "id": event.id, "seq": 2}));
    bea.must("msg.post", json!({"conv": "c", "msg": {"id": "m2", "text": "later"}})).await;

    // The retry gets the original answer, and nothing new is stored or sent.
    let retry = bea.send_event(&event).await;
    assert_eq!(retry, first);
    // Also from another connection of the same key.
    let mut bea_again = auth(&relay, &bea.key).await.unwrap();
    assert_eq!(bea_again.send_event(&event).await, first);

    // The same event replayed by another member is refused.
    let replay = owner.send_event(&event).await;
    assert_eq!(error_code(&replay), "wrong_key");
    assert_eq!(replay["id"], json!(event.id));

    let (events, _) = owner.sync_from(0).await;
    assert_eq!(events.len(), 3);
    assert_eq!(events.iter().filter(|e| e["id"] == json!(event.id)).count(), 1);
    // Exactly three event frames were broadcast.
    for seq in 1..=3 {
        assert_eq!(owner.broadcast("event").await["seq"], json!(seq));
    }
    assert_eq!(owner.ask(json!({"t": "ping"})).await, json!({"t": "pong"}));
    assert!(owner.inbox.iter().all(|f| t(f) != "event"), "{:?}", owner.inbox);
}

#[tokio::test(flavor = "multi_thread")]
async fn edit_is_for_the_author_only_and_replaces_earlier_versions() {
    let relay = TestRelay::start().await;
    let mut owner = relay.owner("Ann").await;
    let mut bea = relay.join(&mut owner, "member", "Bea").await;
    let mut cy = relay.join(&mut owner, "member", "Cy").await;
    owner.must("conv.put", json!({"conv": "c", "name": "C"})).await;
    owner.must("conv.put", json!({"conv": "d", "name": "D"})).await;
    bea.must("msg.post", json!({"conv": "c", "msg": {"id": "m1", "text": "first draft with a pasted password"}})).await;

    let edit = |text: &str| json!({"conv": "c", "id": "m1", "msg": {"id": "m1", "text": text}});
    assert_eq!(error_code(&cy.publish("msg.edit", edit("hijacked")).await), "forbidden");
    // Not even the owner edits someone else's words.
    assert_eq!(error_code(&owner.publish("msg.edit", edit("hijacked")).await), "forbidden");
    assert_eq!(error_code(&bea.publish("msg.edit", json!({"conv": "d", "id": "m1", "msg": {"text": "x"}})).await), "wrong_conv");
    assert_eq!(error_code(&bea.publish("msg.edit", json!({"conv": "c", "id": "nope", "msg": {"text": "x"}})).await), "not_found");

    bea.must("msg.edit", edit("second version")).await;
    bea.must("msg.edit", edit("final version")).await;

    // A member who syncs later gets only the last version.
    let mut late = relay.join(&mut owner, "member", "Di").await;
    let (events, _) = late.sync_from(0).await;
    let text = serde_json::to_string(&events).unwrap();
    assert!(!text.contains("pasted password") && !text.contains("second version"), "{text}");
    assert!(text.contains("final version"));
    let of_m1: Vec<&Value> = events.iter().filter(|e| e["kind"] != json!("conv.put")).collect();
    assert_eq!(of_m1.len(), 3);
    for old in &of_m1[..2] {
        assert_eq!(old["redacted"], json!(true));
        assert!(old.get("sig").is_none());
        assert_eq!(old["body"], json!(r#"{"conv":"c","id":"m1","gone":true}"#));
        assert_eq!(old["pubkey"], json!(bea.pk()));
    }
    let last: Event = serde_json::from_value(of_m1[2].clone()).unwrap();
    assert!(!last.redacted);
    assert_eq!(verify_event(&last), Ok(()));
}

#[tokio::test(flavor = "multi_thread")]
async fn delete_by_an_admin_redacts_the_message_for_later_syncs() {
    let relay = TestRelay::start().await;
    let mut owner = relay.owner("Ann").await;
    let mut admin = relay.join(&mut owner, "admin", "Bea").await;
    let mut cy = relay.join(&mut owner, "member", "Cy").await;
    let mut di = relay.join(&mut owner, "member", "Di").await;
    owner.must("conv.put", json!({"conv": "c", "name": "C"})).await;
    owner.must("conv.put", json!({"conv": "d", "name": "D"})).await;

    let secret = "sk-live-PASTED-BY-MISTAKE-7731";
    let post_seq = cy.must("msg.post", json!({"conv": "c", "msg": {"id": "m1", "text": secret}})).await;
    let edit_seq = cy.must("msg.edit", json!({"conv": "c", "id": "m1", "msg": {"id": "m1", "text": format!("{secret} (edited)")}})).await;

    // The scan used at the end of this test does find the text while it exists.
    let on_disk = |needle: &str| {
        ["", "-wal"].iter().any(|suffix| {
            let path = format!("{}{suffix}", relay.cfg.db_path.display());
            std::fs::read(path).is_ok_and(|bytes| bytes.windows(needle.len()).any(|w| w == needle.as_bytes()))
        })
    };
    assert!(on_disk(secret));

    // Another member may not delete it; the channel must match.
    assert_eq!(error_code(&di.publish("msg.delete", json!({"conv": "c", "id": "m1"})).await), "forbidden");
    assert_eq!(error_code(&admin.publish("msg.delete", json!({"conv": "d", "id": "m1"})).await), "wrong_conv");
    assert_eq!(error_code(&admin.publish("msg.delete", json!({"conv": "c", "id": "nope"})).await), "not_found");

    let delete_seq = admin.must("msg.delete", json!({"conv": "c", "id": "m1"})).await;
    let live = cy.broadcast("event").await;
    assert_eq!(live["kind"], json!("conv.put"));

    // Once deleted it can be neither edited nor deleted again.
    assert_eq!(error_code(&cy.publish("msg.edit", json!({"conv": "c", "id": "m1", "msg": {"text": "back"}})).await), "gone");
    assert_eq!(error_code(&cy.publish("msg.delete", json!({"conv": "c", "id": "m1"})).await), "gone");
    // Its id stays taken.
    assert_eq!(error_code(&cy.publish("msg.post", json!({"conv": "c", "msg": {"id": "m1", "text": "new"}})).await), "duplicate_msg");

    // A member who joins afterwards never receives what was said.
    let mut late = relay.join(&mut owner, "member", "Ed").await;
    let (events, _) = late.sync_from(0).await;
    let text = serde_json::to_string(&events).unwrap();
    assert!(!text.contains(secret), "{text}");
    let by_seq = |seq: u64| events.iter().find(|e| e["seq"] == json!(seq)).unwrap();
    for seq in [post_seq, edit_seq] {
        let event = by_seq(seq);
        assert_eq!(event["redacted"], json!(true));
        assert!(event.get("sig").is_none());
        assert_eq!(event["body"], json!(r#"{"conv":"c","id":"m1","gone":true}"#));
        assert_eq!(event["pubkey"], json!(cy.pk()));
        assert_eq!(event["id"].as_str().unwrap().len(), 64);
    }
    let deletion: Event = serde_json::from_value(by_seq(delete_seq).clone()).unwrap();
    assert_eq!(deletion.pubkey, admin.pk());
    assert_eq!(verify_event(&deletion), Ok(()));
    // Everything that was not rewritten still verifies.
    for event in &events {
        if event.get("redacted").is_none() {
            let event: Event = serde_json::from_value(event.clone()).unwrap();
            assert_eq!(verify_event(&event), Ok(()));
        }
    }

    // The text is gone from the files on disk as well.
    assert!(!on_disk(secret), "the deleted text is still in the database files");

    // The author can delete their own message.
    cy.must("msg.post", json!({"conv": "c", "msg": {"id": "m2", "text": "mine"}})).await;
    cy.must("msg.delete", json!({"conv": "c", "id": "m2"})).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn channel_rules() {
    let relay = TestRelay::start().await;
    let mut owner = relay.owner("Ann").await;
    let mut admin = relay.join(&mut owner, "admin", "Bea").await;
    let mut cy = relay.join(&mut owner, "member", "Cy").await;
    let mut di = relay.join(&mut owner, "member", "Di").await;

    // Posting needs a channel.
    assert_eq!(error_code(&cy.publish("msg.post", json!({"conv": "c", "msg": {"id": "m0", "text": "x"}})).await), "no_conv");

    // Whoever names a new channel first owns it.
    cy.must("conv.put", json!({"conv": "c", "name": "Cy's channel"})).await;
    assert_eq!(error_code(&di.publish("conv.put", json!({"conv": "c", "name": "Di's now"})).await), "forbidden");
    assert_eq!(error_code(&di.publish("conv.put", json!({"conv": "c", "name": "Cy's channel", "archived": true})).await), "forbidden");
    cy.must("conv.put", json!({"conv": "c", "name": "Renamed by its creator"})).await;
    admin.must("conv.put", json!({"conv": "c", "name": "Renamed by an admin"})).await;
    owner.must("conv.put", json!({"conv": "c", "name": "Renamed by the owner"})).await;

    // Anyone posts; message ids are unique across the workspace.
    di.must("msg.post", json!({"conv": "c", "msg": {"id": "m1", "text": "hello", "parent": null}})).await;
    di.must("conv.put", json!({"conv": "d", "name": "D"})).await;
    assert_eq!(error_code(&cy.publish("msg.post", json!({"conv": "d", "msg": {"id": "m1", "text": "x"}})).await), "duplicate_msg");

    // Archived channels take no posts until they are restored.
    admin.must("conv.put", json!({"conv": "c", "name": "Archived", "archived": true})).await;
    assert_eq!(error_code(&di.publish("msg.post", json!({"conv": "c", "msg": {"id": "m2", "text": "x"}})).await), "archived");
    cy.must("conv.put", json!({"conv": "c", "name": "Back", "archived": false})).await;
    di.must("msg.post", json!({"conv": "c", "msg": {"id": "m2", "text": "x"}})).await;

    // Malformed bodies and unknown kinds.
    assert_eq!(error_code(&cy.publish("conv.put", json!({"conv": "e"})).await), "bad_body");
    assert_eq!(error_code(&cy.publish("msg.post", json!({"conv": "c", "msg": {"text": "no id"}})).await), "bad_body");
    assert_eq!(error_code(&cy.publish("member.add", json!({"conv": "c"})).await), "unknown_kind");
    let event = sign_event(&cy.key, now(), "conv.put", &cy.ws, "not json");
    assert_eq!(error_code(&cy.send_event(&event).await), "bad_body");
}

#[tokio::test(flavor = "multi_thread")]
async fn old_and_oversized_events_are_refused() {
    let relay = TestRelay::start().await;
    let mut owner = relay.owner("Ann").await;
    owner.must("conv.put", json!({"conv": "c", "name": "C"})).await;

    // More than ten minutes from relay time, either way.
    for created_at in [now() - 660, now() + 660] {
        let event = sign_event(&owner.key, created_at, "msg.post", &owner.ws, r#"{"conv":"c","msg":{"id":"old","text":"x"}}"#);
        assert_eq!(error_code(&owner.send_event(&event).await), "bad_time");
    }
    let event = sign_event(&owner.key, now() - 540, "msg.post", &owner.ws, r#"{"conv":"c","msg":{"id":"recent","text":"x"}}"#);
    assert_eq!(t(&owner.send_event(&event).await), "ok");

    // A body of exactly 64 KB is fine; one byte more is not.
    let body_of = |len: usize, id: &str| {
        let empty = json!({"conv": "c", "msg": {"id": id, "text": ""}}).to_string();
        let body = json!({"conv": "c", "msg": {"id": id, "text": "x".repeat(len - empty.len())}}).to_string();
        assert_eq!(body.len(), len);
        body
    };
    let event = sign_event(&owner.key, now(), "msg.post", &owner.ws, &body_of(64 * 1024, "big"));
    assert_eq!(t(&owner.send_event(&event).await), "ok");
    let event = sign_event(&owner.key, now(), "msg.post", &owner.ws, &body_of(64 * 1024 + 1, "bigger"));
    assert_eq!(error_code(&owner.send_event(&event).await), "too_large");

    // A frame over 256 KB ends the connection.
    // (The relay may hang up before the whole frame is written, so the send itself can fail.)
    let _ = owner
        .sock
        .send(Message::text(json!({"t": "ping", "pad": "x".repeat(300 * 1024)}).to_string()))
        .await;
    assert!(closed(&mut owner.sock).await);
}

#[tokio::test(flavor = "multi_thread")]
async fn sync_is_paged() {
    let relay = TestRelay::start_with(|cfg| cfg.limits.publish_max = 100_000).await;
    let mut owner = relay.owner("Ann").await;
    owner.must("conv.put", json!({"conv": "c", "name": "C"})).await;
    for i in 0..430 {
        owner.must("msg.post", json!({"conv": "c", "msg": {"id": format!("m{i}"), "text": "hi"}})).await;
    }

    let first = owner.ask(json!({"t": "sync", "after": 0})).await;
    assert_eq!(first["events"].as_array().unwrap().len(), 200);
    assert_eq!(first["more"], json!(true));
    assert_eq!(first["events"][0]["seq"], json!(1));
    assert_eq!(first["events"][199]["seq"], json!(200));

    let (events, pages) = owner.sync_from(0).await;
    assert_eq!(pages, 3);
    let seqs: Vec<u64> = events.iter().map(|e| e["seq"].as_u64().unwrap()).collect();
    assert_eq!(seqs, (1..=431).collect::<Vec<u64>>());

    let (events, pages) = owner.sync_from(400).await;
    assert_eq!((events.len(), pages), (31, 1));
    let exact = owner.ask(json!({"t": "sync", "after": 231})).await;
    assert_eq!(exact["events"].as_array().unwrap().len(), 200);
    assert_eq!(exact["more"], json!(false));

    // A position ahead of the log (the relay was restored from a backup): the
    // client sees `head` in `ready` and starts over; a sync from there is empty.
    let ahead = owner.ask(json!({"t": "sync", "after": 5000})).await;
    assert_eq!(ahead, json!({"t": "events", "events": [], "more": false, "next": 431}));
    let again = auth(&relay, &owner.key).await.unwrap();
    assert_eq!(again.ready["head"], json!(431));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_client_that_does_not_keep_up_is_disconnected() {
    let relay = TestRelay::start_with(|cfg| {
        cfg.limits.publish_max = 100_000;
        cfg.limits.queue_frames = 8;
    })
    .await;
    let mut owner = relay.owner("Ann").await;
    let mut slow = relay.join(&mut owner, "member", "Slow").await;
    owner.must("conv.put", json!({"conv": "c", "name": "C"})).await;
    drop(owner);

    // A second connection publishes ~19 MB while `slow` reads nothing.
    let mut busy = relay.owner("Busy").await;
    let text = "x".repeat(60_000);
    let total = 320;
    for i in 0..total {
        busy.inbox.clear();
        busy.must("msg.post", json!({"conv": "c", "msg": {"id": format!("m{i}"), "text": text}})).await;
    }

    // The relay gave up on the slow connection instead of buffering without bound.
    let mut received = 0;
    while let Some(frame) = recv(&mut slow.sock).await {
        if t(&frame) == "event" {
            received += 1;
        }
    }
    assert!(received < total, "the slow client received everything ({received} events)");

    // It reconnects and syncs what it missed.
    let mut back = auth(&relay, &slow.key).await.unwrap();
    assert_eq!(back.ready["head"], json!(total + 1));
    let (events, pages) = back.sync_from(0).await;
    assert_eq!(events.len(), total as usize + 1);
    // Pages are also cut by size, so this took many more than two.
    assert!(pages > 10, "{pages}");
}

// ---- members -------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn a_removed_member_is_disconnected_and_denied() {
    let relay = TestRelay::start().await;
    let mut owner = relay.owner("Ann").await;
    let mut admin = relay.join(&mut owner, "admin", "Bea").await;
    let mut cy = relay.join(&mut owner, "member", "Cy").await;
    let mut cy_second = auth(&relay, &cy.key).await.unwrap();
    let di = relay.join(&mut owner, "member", "Di").await;
    owner.must("conv.put", json!({"conv": "c", "name": "C"})).await;
    cy.must("msg.post", json!({"conv": "c", "msg": {"id": "m1", "text": "before"}})).await;
    let admins_invite = admin.invite(json!({})).await;

    // Who may remove whom.
    let remove = |pk: String| json!({"t": "member.remove", "pubkey": pk});
    assert_eq!(error_code(&cy.ask(remove(di.pk())).await), "forbidden");
    assert_eq!(error_code(&admin.ask(remove(owner.pk())).await), "forbidden");
    assert_eq!(error_code(&admin.ask(remove(admin.pk())).await), "forbidden");
    assert_eq!(error_code(&owner.ask(remove(owner.pk())).await), "forbidden");
    assert_eq!(error_code(&owner.ask(remove("f".repeat(64))).await), "not_found");

    assert_eq!(admin.ask(remove(cy.pk())).await, json!({"t": "ok"}));

    // Both of Cy's connections are closed at once.
    assert!(closed(&mut cy.sock).await);
    assert!(closed(&mut cy_second.sock).await);
    // Everyone else sees the new list.
    let expected = vec![pair("Ann", "owner"), pair("Bea", "admin"), pair("Di", "member")];
    let mut update = owner.broadcast("members").await;
    while members_of(&update) != expected {
        update = owner.broadcast("members").await;
    }

    // The key no longer authenticates, and is answered like any stranger's.
    assert_denied(auth(&relay, &cy.key).await, "denied", GENERIC_AUTH);

    // What Cy said stays, attributed to the old key.
    let (events, _) = owner.sync_from(0).await;
    assert!(events.iter().any(|e| e["pubkey"] == json!(cy.pk()) && e["kind"] == json!("msg.post")));

    // Removing an admin also cancels the invites that admin made.
    assert_eq!(owner.ask(remove(admin.pk())).await, json!({"t": "ok"}));
    assert!(closed(&mut admin.sock).await);
    assert_denied(claim(&relay, generate_key(), &admins_invite, "Eve").await, "denied", GENERIC_CLAIM);

    // A removed person can come back only with a new invite, as a new member.
    let token = owner.invite(json!({})).await;
    let back = claim(&relay, cy.key.clone(), &token, "Cy").await.unwrap();
    assert_eq!(back.role(), "member");
}

#[tokio::test(flavor = "multi_thread")]
async fn roles_and_names() {
    let relay = TestRelay::start().await;
    let mut owner = relay.owner("Ann").await;
    let mut bea = relay.join(&mut owner, "member", "Bea").await;
    let mut cy = relay.join(&mut owner, "member", "Cy").await;
    let role = |pk: String, role: &str| json!({"t": "member.role", "pubkey": pk, "role": role});

    assert_eq!(error_code(&bea.ask(role(cy.pk(), "admin")).await), "forbidden");
    assert_eq!(error_code(&owner.ask(role(cy.pk(), "owner")).await), "forbidden");
    assert_eq!(error_code(&owner.ask(role(owner.pk(), "member")).await), "forbidden");
    assert_eq!(error_code(&owner.ask(role(cy.pk(), "boss")).await), "bad_request");
    assert_eq!(error_code(&owner.ask(role("0".repeat(64), "admin")).await), "not_found");

    assert_eq!(owner.ask(role(bea.pk(), "admin")).await, json!({"t": "ok"}));
    let expected = vec![pair("Ann", "owner"), pair("Bea", "admin"), pair("Cy", "member")];
    let mut update = cy.broadcast("members").await;
    while members_of(&update) != expected {
        update = cy.broadcast("members").await;
    }
    // The new role applies on the connection Bea already has.
    let token = bea.invite(json!({})).await;
    assert_eq!(error_code(&bea.ask(role(cy.pk(), "admin")).await), "forbidden");

    // Demoting takes the admin's invites along.
    assert_eq!(owner.ask(role(bea.pk(), "member")).await, json!({"t": "ok"}));
    assert_eq!(error_code(&bea.ask(json!({"t": "invite.create"})).await), "forbidden");
    assert_denied(claim(&relay, generate_key(), &token, "Di").await, "denied", GENERIC_CLAIM);

    // Anyone renames themselves, and only themselves.
    assert_eq!(cy.ask(json!({"t": "member.rename", "name": "  Cyrus "})).await, json!({"t": "ok"}));
    let expected = vec![pair("Ann", "owner"), pair("Bea", "member"), pair("Cyrus", "member")];
    let mut update = owner.broadcast("members").await;
    while members_of(&update) != expected {
        update = owner.broadcast("members").await;
    }
    assert_eq!(error_code(&cy.ask(json!({"t": "member.rename", "name": ""})).await), "bad_request");
    assert_eq!(error_code(&cy.ask(json!({"t": "member.rename", "name": "a\u{0007}b"})).await), "bad_request");
}

// ---- private channels ----------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn ready_names_features_and_settings() {
    let relay = TestRelay::start().await;
    let owner = relay.owner("Ann").await;
    assert_eq!(owner.ready["features"], json!(["channels", "join-page", "profiles"]));
    assert_eq!(owner.ready["settings"], json!({"member_invites": true}));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_private_channel_is_invisible_to_those_outside_it() {
    let relay = TestRelay::start().await;
    let mut owner = relay.owner("Ann").await;
    let mut admin = relay.join(&mut owner, "admin", "Bea").await;
    let mut cy = relay.join(&mut owner, "member", "Cy").await;
    let mut di = relay.join(&mut owner, "member", "Di").await;

    let public = owner.must("conv.put", json!({"conv": "pub", "name": "Public"})).await;
    cy.must("conv.put", json!({"conv": "p", "name": "Secret plans", "private": true})).await;
    cy.must("msg.post", post("p", "m1", "only for the two of us")).await;
    let added = cy.must("conv.add", json!({"conv": "p", "member": di.pk()})).await;
    di.must("msg.post", post("p", "m2", "agreed")).await;
    let marker = di.must("msg.post", post("pub", "m3", "hello all")).await;
    assert_eq!((public, added, marker), (1, 4, 6));

    // Live: the owner and an admin are sent the public events and nothing else.
    for outsider in [&mut owner, &mut admin] {
        let live = outsider.live_until(marker).await;
        assert_eq!(seqs(&live), vec![public, marker]);
    }
    assert_eq!(seqs(&cy.live_until(marker).await), vec![1, 2, 3, 4, 5, 6]);
    // Di was sent the channel from the event that brought her in.
    assert_eq!(seqs(&di.live_until(marker).await), vec![1, 4, 5, 6]);

    // Sync and head: the same view. The seqs in between are simply not there.
    for outsider in [&mut owner, &mut admin] {
        let (events, pages) = outsider.sync_all(0, None).await;
        assert_eq!((seqs(&events), pages), (vec![public, marker], 1));
        let text = serde_json::to_string(&events).unwrap();
        assert!(!text.contains("Secret plans") && !text.contains("only for the two of us"), "{text}");
        for conv in ["p", "nowhere"] {
            let page = outsider.sync_page(0, Some(conv)).await;
            assert_eq!(page, json!({"t": "events", "events": [], "more": false, "next": marker, "conv": conv}));
        }
        assert_eq!(outsider.ready_again(&relay).await["head"], json!(marker));
    }
    // More in the channel moves the head of those in it only.
    let latest = cy.must("msg.post", post("p", "m4", "one more")).await;
    assert_eq!(owner.ready_again(&relay).await["head"], json!(marker));
    assert_eq!(admin.ready_again(&relay).await["head"], json!(marker));
    assert_eq!(di.ready_again(&relay).await["head"], json!(latest));
    assert_eq!(seqs(&di.sync_all(0, Some("p")).await.0), vec![2, 3, 4, 5, 7]);

    // Changing it: every answer is the one a channel that was never made gets,
    // whether or not the message id exists.
    for outsider in [&mut owner, &mut admin] {
        let me = outsider.pk();
        for conv in ["p", "nowhere"] {
            for (kind, body) in [
                ("msg.post", post(conv, "m9", "let me in")),
                ("msg.post", post(conv, "m1", "let me in")),
                ("msg.edit", json!({"conv": conv, "id": "m1", "msg": {"id": "m1", "text": "mine"}})),
                ("msg.edit", json!({"conv": conv, "id": "nope", "msg": {"text": "mine"}})),
                ("msg.delete", json!({"conv": conv, "id": "m1"})),
                ("msg.delete", json!({"conv": conv, "id": "nope"})),
                ("conv.add", json!({"conv": conv, "member": me})),
                ("conv.remove", json!({"conv": conv, "member": di.pk()})),
            ] {
                let reply = outsider.publish(kind, body).await;
                assert_eq!(error_code(&reply), "no_conv", "{kind} in {conv}");
                assert_eq!(reply["message"], json!("the channel does not exist"));
            }
            let reply = outsider.ask(json!({"t": "conv.members", "conv": conv})).await;
            assert_eq!(reply, json!({"t": "error", "code": "no_conv", "message": "the channel does not exist"}));
            let reply = outsider.ask(json!({"t": "invite.create", "conv": conv})).await;
            assert_eq!(reply, json!({"t": "error", "code": "no_conv", "message": "the channel does not exist"}));
        }
        // Not even a rename or archiving, which an owner or admin may do to any public channel.
        let reply = outsider.publish("conv.put", json!({"conv": "p", "name": "Opened up", "archived": true})).await;
        assert_eq!(error_code(&reply), "no_conv");
        let reply = outsider.publish("conv.put", json!({"conv": "p", "name": "Opened up", "private": false})).await;
        assert_eq!(error_code(&reply), "no_conv");
        // Through a channel they can read, the message is "not found".
        let reply = outsider.publish("msg.delete", json!({"conv": "pub", "id": "m1"})).await;
        assert_eq!(error_code(&reply), "not_found");
    }

    // None of that was stored, and the channel is as it was for those in it.
    assert_eq!(seqs(&cy.sync_all(0, None).await.0), vec![1, 2, 3, 4, 5, 6, 7]);
    let members = cy.ask(json!({"t": "conv.members", "conv": "p"})).await;
    assert_eq!(members["private"], json!(true));
    assert_eq!(members["members"].as_array().unwrap().len(), 2);

    // Visibility is fixed when the channel is made.
    let reply = cy.publish("conv.put", json!({"conv": "p", "name": "Open", "private": false})).await;
    assert_eq!(error_code(&reply), "visibility_fixed");
    let reply = owner.publish("conv.put", json!({"conv": "pub", "name": "Closed", "private": true})).await;
    assert_eq!(error_code(&reply), "visibility_fixed");
}

#[tokio::test(flavor = "multi_thread")]
async fn sync_does_not_stall_on_a_long_run_of_private_events() {
    let relay = TestRelay::start_with(|cfg| cfg.limits.publish_max = 100_000).await;
    let mut owner = relay.owner("Ann").await;
    let mut cy = relay.join(&mut owner, "member", "Cy").await;

    owner.must("conv.put", json!({"conv": "pub", "name": "Public"})).await;
    cy.must("conv.put", json!({"conv": "p", "name": "P", "private": true})).await;
    for i in 0..450 {
        cy.must("msg.post", post("p", &format!("a{i}"), "x")).await;
    }
    let middle = owner.must("msg.post", post("pub", "pub1", "x")).await;
    for i in 0..30 {
        cy.must("msg.post", post("p", &format!("b{i}"), "x")).await;
    }
    assert_eq!(middle, 453);

    // More than two full pages of rows lie between the owner's two events:
    // one request returns both and says that is all.
    let page = owner.sync_page(0, None).await;
    assert_eq!(seqs(page["events"].as_array().unwrap()), vec![1, middle]);
    assert_eq!((page["more"].clone(), page["next"].clone()), (json!(false), json!(middle)));
    let page = owner.sync_page(middle, None).await;
    assert_eq!(page, json!({"t": "events", "events": [], "more": false, "next": middle}));
    let page = owner.sync_page(1, None).await;
    assert_eq!(seqs(page["events"].as_array().unwrap()), vec![middle]);
    assert_eq!(owner.ready_again(&relay).await["head"], json!(middle));

    // The member reads all of it, in pages, overall and by channel.
    let (events, pages) = cy.sync_all(0, None).await;
    assert_eq!((events.len(), pages), (483, 3));
    assert_eq!(seqs(&events), (1..=483).collect::<Vec<u64>>());
    let (events, pages) = cy.sync_all(0, Some("p")).await;
    assert_eq!((events.len(), pages), (481, 3));
    assert!(events.iter().all(|e| e["body"].as_str().unwrap().contains(r#""conv":"p""#)));
    assert_eq!(cy.ready_again(&relay).await["head"], json!(483));
}

#[tokio::test(flavor = "multi_thread")]
async fn adding_and_removing_a_channel_member() {
    let relay = TestRelay::start().await;
    let mut owner = relay.owner("Ann").await;
    let mut cy = relay.join(&mut owner, "member", "Cy").await;
    let mut di = relay.join(&mut owner, "member", "Di").await;
    let mut ed = relay.join(&mut owner, "member", "Ed").await;
    let member = |conv: &str, pk: String| json!({"conv": conv, "member": pk});

    cy.must("conv.put", json!({"conv": "p", "name": "P", "private": true})).await;
    cy.must("msg.post", post("p", "m1", "before Di")).await;
    cy.must("msg.post", post("p", "m2", "still before Di")).await;

    // Only someone in the channel adds to it; the one added must be on the team.
    assert_eq!(error_code(&di.publish("conv.add", member("p", di.pk())).await), "no_conv");
    assert_eq!(error_code(&cy.publish("conv.add", member("p", "f".repeat(64))).await), "not_found");
    assert_eq!(error_code(&cy.publish("conv.add", member("p", "Di".to_string())).await), "bad_body");

    // The event that adds Di is the first thing she is sent of the channel...
    let added = cy.must("conv.add", member("p", di.pk())).await;
    let frame = di.broadcast("event").await;
    assert_eq!((frame["seq"].clone(), frame["kind"].clone()), (json!(added), json!("conv.add")));
    let event: Event = serde_json::from_value(frame).unwrap();
    assert_eq!(verify_event(&event), Ok(()));
    assert_eq!(event.pubkey, cy.pk());
    // ...and asking for the channel returns it from its first event.
    let (history, _) = di.sync_all(0, Some("p")).await;
    assert_eq!(seqs(&history), vec![1, 2, 3, 4]);
    assert_eq!(history[0]["kind"], json!("conv.put"));
    assert!(history[1]["body"].as_str().unwrap().contains("before Di"));
    assert_eq!(di.ready_again(&relay).await["head"], json!(added));

    let listed = di.ask(json!({"t": "conv.members", "conv": "p"})).await;
    assert_eq!((t(&listed), listed["conv"].clone(), listed["private"].clone()), ("conv.members", json!("p"), json!(true)));
    let rows = listed["members"].as_array().unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!((rows[0]["pubkey"].clone(), rows[0]["added_by"].clone()), (json!(cy.pk()), json!(cy.pk())));
    assert_eq!((rows[1]["pubkey"].clone(), rows[1]["added_by"].clone()), (json!(di.pk()), json!(cy.pk())));
    assert!(rows[1]["added_at"].as_u64().unwrap().abs_diff(now()) < 5);

    // She is a full member of the channel: posts, and brings in Ed.
    di.must("msg.post", post("p", "m3", "thanks")).await;
    di.must("conv.add", member("p", ed.pk())).await;
    assert_eq!(seqs(&ed.live_until(6).await), vec![6]);

    // Taking someone else out is for the channel's creator (or an owner/admin in it).
    assert_eq!(error_code(&di.publish("conv.remove", member("p", ed.pk())).await), "forbidden");
    assert_eq!(error_code(&di.publish("conv.remove", member("p", cy.pk())).await), "forbidden");
    assert_eq!(error_code(&owner.publish("conv.remove", member("p", di.pk())).await), "no_conv");

    // The removal reaches Di live; what follows in the channel does not.
    let removed = cy.must("conv.remove", member("p", di.pk())).await;
    assert_eq!(seqs(&di.live_until(removed).await), vec![5, 6, 7]);
    cy.must("msg.post", post("p", "m4", "after Di")).await;
    let marker = owner.must("conv.put", json!({"conv": "pub", "name": "Public"})).await;
    assert_eq!(seqs(&di.live_until(marker).await), vec![marker]);

    // In sync she is left with the removal and nothing else of the channel.
    let (events, _) = di.sync_all(0, None).await;
    assert_eq!(seqs(&events), vec![removed, marker]);
    assert_eq!(events[0]["kind"], json!("conv.remove"));
    assert_eq!(di.sync_page(0, Some("p")).await["events"], json!([]));
    assert_eq!(di.ready_again(&relay).await["head"], json!(marker));
    assert_eq!(error_code(&di.publish("msg.post", post("p", "m5", "hello?")).await), "no_conv");
    assert_eq!(error_code(&di.ask(json!({"t": "conv.members", "conv": "p"})).await), "no_conv");
    // The owner, never in it, saw none of this.
    assert_eq!(seqs(&owner.sync_all(0, None).await.0), vec![marker]);

    // Ed is still in and has all of it; then he leaves by himself.
    assert_eq!(seqs(&ed.sync_all(0, Some("p")).await.0), vec![1, 2, 3, 4, 5, 6, 7, 8]);
    let left = ed.must("conv.remove", member("p", ed.pk())).await;
    assert_eq!(seqs(&ed.live_until(left).await), vec![7, 8, marker, left]);
    assert_eq!(seqs(&ed.sync_all(0, None).await.0), vec![marker, left]);

    // Removal from the team takes a member out of their channels: coming back
    // with a new invite, under the same key, does not bring the channel back.
    assert_eq!(owner.ask(json!({"t": "member.remove", "pubkey": cy.pk()})).await, json!({"t": "ok"}));
    assert!(closed(&mut cy.sock).await);
    let token = owner.invite(json!({})).await;
    let mut back = claim(&relay, cy.key.clone(), &token, "Cy").await.unwrap();
    assert_eq!(back.ready["head"], json!(marker));
    assert_eq!(seqs(&back.sync_all(0, None).await.0), vec![marker]);
    assert_eq!(error_code(&back.publish("msg.post", post("p", "m6", "home?")).await), "no_conv");
}

#[tokio::test(flavor = "multi_thread")]
async fn members_invite_to_channels_they_are_in() {
    let relay = TestRelay::start().await;
    let mut owner = relay.owner("Ann").await;
    let mut admin = relay.join(&mut owner, "admin", "Bea").await;
    let mut cy = relay.join(&mut owner, "member", "Cy").await;
    let mut di = relay.join(&mut owner, "member", "Di").await;
    let create = |options: Value| {
        let mut request = options;
        request["t"] = json!("invite.create");
        request
    };

    cy.must("conv.put", json!({"conv": "p", "name": "P", "private": true})).await;
    cy.must("msg.post", post("p", "m1", "welcome")).await;
    di.must("conv.put", json!({"conv": "q", "name": "Q", "private": true})).await;
    owner.must("conv.put", json!({"conv": "pub", "name": "Public"})).await;

    // A member: only with a channel, only one they can read, only as a member.
    for refused in [json!({}), json!({"conv": "q"}), json!({"conv": "nowhere"}), json!({"conv": "p", "role": "admin"})] {
        let reply = cy.ask(create(refused)).await;
        assert_eq!(reply, json!({"t": "error", "code": "forbidden", "message": "not allowed to make this invite"}));
    }
    let token = cy.invite(json!({"conv": "p"})).await;
    let to_public = di.invite(json!({"conv": "pub", "uses": 2})).await;

    // Members see and revoke their own invites; the owner sees all of them, but
    // not which private channel one leads to.
    let mine = cy.ask(json!({"t": "invite.list"})).await;
    let mine = mine["invites"].as_array().unwrap();
    assert_eq!(mine.len(), 1);
    assert_eq!((mine[0]["conv"].clone(), mine[0]["created_by"].clone(), mine[0]["role"].clone()), (json!("p"), json!(cy.pk()), json!("member")));
    let all = owner.ask(json!({"t": "invite.list"})).await;
    let all = all["invites"].as_array().unwrap();
    assert_eq!(all.len(), 2);
    let by = |pk: String| all.iter().find(|i| i["created_by"] == json!(pk)).unwrap().clone();
    assert_eq!(by(cy.pk())["conv"], json!(null));
    assert_eq!(by(di.pk())["conv"], json!("pub"));
    assert!(!serde_json::to_string(all).unwrap().contains("token"));
    let revoke = |id: &Value| json!({"t": "invite.revoke", "id": id});
    assert_eq!(error_code(&di.ask(revoke(&mine[0]["id"])).await), "forbidden");
    assert_eq!(di.ask(revoke(&by(di.pk())["id"])).await, json!({"t": "ok"}));
    assert_denied(claim(&relay, generate_key(), &to_public, "Nobody").await, "denied", GENERIC_CLAIM);

    // Whoever claims Cy's invite is in the channel from the first moment.
    let mut ed = claim(&relay, generate_key(), &token, "Ed").await.unwrap();
    assert_eq!(ed.role(), "member");
    assert_eq!(ed.ready["head"], json!(4));
    assert_eq!(seqs(&ed.sync_all(0, None).await.0), vec![1, 2, 4]);
    let listed = ed.ask(json!({"t": "conv.members", "conv": "p"})).await;
    let rows = listed["members"].as_array().unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!((rows[1]["pubkey"].clone(), rows[1]["added_by"].clone()), (json!(ed.pk()), json!(cy.pk())));
    let said = ed.must("msg.post", post("p", "m2", "hi")).await;
    assert_eq!(seqs(&cy.live_until(said).await), vec![1, 2, 4, said]);

    // The owner and admins invite to channels they can read, and to none they cannot.
    assert_eq!(error_code(&owner.ask(create(json!({"conv": "p"}))).await), "no_conv");
    let token = admin.invite(json!({"conv": "pub"})).await;
    let mut fay = claim(&relay, generate_key(), &token, "Fay").await.unwrap();
    let listed = fay.ask(json!({"t": "conv.members", "conv": "pub"})).await;
    assert_eq!(listed["private"], json!(false));
    assert_eq!(listed["members"][1]["added_by"], json!(admin.pk()));

    // Only the owner changes the setting; everyone connected is told.
    let off = json!({"t": "settings.set", "member_invites": false});
    assert_eq!(error_code(&cy.ask(off.clone()).await), "forbidden");
    assert_eq!(error_code(&admin.ask(off.clone()).await), "forbidden");
    assert_eq!(error_code(&owner.ask(json!({"t": "settings.set"})).await), "bad_request");
    assert_eq!(error_code(&owner.ask(json!({"t": "settings.set", "member_invites": "no"})).await), "bad_request");
    let outstanding = cy.invite(json!({"conv": "p", "uses": 5})).await;
    assert_eq!(owner.ask(off).await, json!({"t": "ok"}));
    for peer in [&mut owner, &mut admin, &mut cy, &mut di, &mut ed, &mut fay] {
        assert_eq!(peer.broadcast("settings").await, json!({"t": "settings", "member_invites": false}));
    }
    assert_eq!(cy.ready_again(&relay).await["settings"], json!({"member_invites": false}));

    // Off: members make no invites, and the ones they had made stop working.
    assert_eq!(error_code(&cy.ask(create(json!({"conv": "p"}))).await), "forbidden");
    assert_denied(claim(&relay, generate_key(), &outstanding, "Gus").await, "denied", GENERIC_CLAIM);
    // The owner and admins are not affected.
    admin.invite(json!({})).await;

    assert_eq!(owner.ask(json!({"t": "settings.set", "member_invites": true})).await, json!({"t": "ok"}));
    assert_eq!(cy.broadcast("settings").await, json!({"t": "settings", "member_invites": true}));
    cy.invite(json!({"conv": "p"})).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn sync_is_rate_limited_per_connection() {
    let relay = TestRelay::start_with(|cfg| cfg.limits.sync_max = 5).await;
    let mut owner = relay.owner("Ann").await;
    for _ in 0..5 {
        owner.sync_page(0, None).await;
    }
    for request in [json!({"t": "sync", "after": 0}), json!({"t": "sync", "after": 0, "conv": "c"})] {
        let reply = owner.ask(request).await;
        assert_eq!(reply, json!({"t": "error", "code": "rate_limited", "message": "syncing too fast"}));
    }
    // Nothing else on the connection is held back, and another connection of
    // the same member has its own allowance.
    assert_eq!(owner.ask(json!({"t": "ping"})).await, json!({"t": "pong"}));
    owner.must("conv.put", json!({"conv": "c", "name": "C"})).await;
    let mut second = auth(&relay, &owner.key).await.unwrap();
    assert_eq!(second.sync_page(0, None).await["next"], json!(1));

    // A channel id that could not exist is refused as malformed.
    let reply = second.ask(json!({"t": "sync", "after": 0, "conv": ""})).await;
    assert_eq!(error_code(&reply), "bad_request");
}

// ---- migration -----------------------------------------------------------------------

/// The schema of version 1, as relays before per-channel access created it.
const SCHEMA_V1: &str = "
CREATE TABLE workspace (ws TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
CREATE TABLE members (
    ws TEXT NOT NULL, pubkey TEXT NOT NULL, name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
    joined_at INTEGER NOT NULL, PRIMARY KEY (ws, pubkey)
);
CREATE UNIQUE INDEX members_one_owner ON members (ws) WHERE role = 'owner';
CREATE TABLE invites (
    ws TEXT NOT NULL, id TEXT NOT NULL, token_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
    uses_left INTEGER NOT NULL, expires_at INTEGER NOT NULL, created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL, PRIMARY KEY (ws, id), UNIQUE (ws, token_hash)
);
CREATE TABLE events (
    ws TEXT NOT NULL, seq INTEGER NOT NULL, id TEXT NOT NULL, pubkey TEXT NOT NULL,
    created_at INTEGER NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL, sig TEXT,
    redacted INTEGER NOT NULL DEFAULT 0, msg_id TEXT, PRIMARY KEY (ws, seq), UNIQUE (ws, id)
);
CREATE INDEX events_by_msg ON events (ws, msg_id) WHERE msg_id IS NOT NULL;
CREATE TABLE convs (
    ws TEXT NOT NULL, conv TEXT NOT NULL, creator TEXT NOT NULL,
    archived INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (ws, conv)
);
CREATE TABLE messages (
    ws TEXT NOT NULL, id TEXT NOT NULL, author TEXT NOT NULL, conv TEXT NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (ws, id)
);
";

const V1_WS: &str = "00112233445566778899aabbccddeeff";

/// Writes a version 1 database as an older relay left it: Ann (owner) and Bob,
/// two channels, three posts (one deleted, so its row is redacted) and a
/// sub-agent offer. Returns the events as they were signed.
fn write_v1_database(path: &std::path::Path, ann: &SigningKey, bob: &SigningKey) -> Vec<Event> {
    use rusqlite::params;
    let conn = rusqlite::Connection::open(path).unwrap();
    conn.execute_batch(SCHEMA_V1).unwrap();
    conn.execute("INSERT INTO workspace VALUES (?1, 1000)", params![V1_WS]).unwrap();
    for (key, name, role) in [(ann, "Ann", "owner"), (bob, "Bob", "member")] {
        conn.execute("INSERT INTO members VALUES (?1, ?2, ?3, ?4, 1000)", params![V1_WS, pubkey_hex(key), name, role])
            .unwrap();
    }
    for (conv, creator) in [("general", ann), ("random", bob)] {
        conn.execute("INSERT INTO convs VALUES (?1, ?2, ?3, 0)", params![V1_WS, conv, pubkey_hex(creator)]).unwrap();
    }
    for (id, conv, deleted) in [("m1", "general", false), ("m2", "random", true), ("m3", "random", false)] {
        conn.execute("INSERT INTO messages VALUES (?1, ?2, ?3, ?4, ?5)", params![V1_WS, id, pubkey_hex(bob), conv, deleted])
            .unwrap();
    }
    let at = now() - 3600;
    let events = vec![
        sign_event(ann, at, "conv.put", V1_WS, r#"{"conv":"general","name":"General"}"#),
        sign_event(bob, at, "conv.put", V1_WS, r#"{"conv":"random","name":"Random"}"#),
        sign_event(bob, at, "msg.post", V1_WS, r#"{"conv":"general","msg":{"id":"m1","text":"hello from version 1"}}"#),
        sign_event(bob, at, "msg.post", V1_WS, r#"{"conv":"random","msg":{"id":"m2","text":"pasted by mistake"}}"#),
        sign_event(bob, at, "msg.delete", V1_WS, r#"{"conv":"random","id":"m2"}"#),
        sign_event(ann, at, "agent.put", V1_WS, r#"{"agent":{"id":"sub","name":"Legal"}}"#),
        sign_event(bob, at, "msg.post", V1_WS, r#"{"conv":"random","msg":{"id":"m3","text":"kept"}}"#),
    ];
    for (i, event) in events.iter().enumerate() {
        let seq = i as i64 + 1;
        let (body, sig, redacted) = if seq == 4 {
            (r#"{"conv":"random","id":"m2","gone":true}"#.to_string(), None, true)
        } else {
            (event.body.clone(), event.sig.clone(), false)
        };
        let msg_id = match seq {
            3 => Some("m1"),
            4 | 5 => Some("m2"),
            7 => Some("m3"),
            _ => None,
        };
        conn.execute(
            "INSERT INTO events VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![V1_WS, seq, event.id, event.pubkey, event.created_at as i64, event.kind, body, sig, redacted, msg_id],
        )
        .unwrap();
    }
    events
}

#[tokio::test(flavor = "multi_thread")]
async fn a_version_1_database_is_served_after_migration() {
    let (ann_key, bob_key) = (generate_key(), generate_key());
    let mut written = Vec::new();
    let relay = TestRelay::start_with(|cfg| written = write_v1_database(&cfg.db_path, &ann_key, &bob_key)).await;

    // The members of before come back with their keys, to the same workspace.
    let mut ann = auth(&relay, &ann_key).await.unwrap();
    let mut bob = auth(&relay, &bob_key).await.unwrap();
    assert_eq!(ann.ws, V1_WS);
    assert_eq!(ann.role(), "owner");
    assert_eq!(ann.ready["head"], json!(7));
    assert_eq!(ann.ready["settings"], json!({"member_invites": true}));

    // Everyone, a newcomer included, reads everything that was there: the
    // channels are public, the events are the ones that were signed.
    let mut newcomer = relay.join(&mut ann, "member", "Cy").await;
    assert_eq!(newcomer.ready["head"], json!(7));
    for peer in [&mut ann, &mut bob, &mut newcomer] {
        let (events, _) = peer.sync_all(0, None).await;
        assert_eq!(seqs(&events), vec![1, 2, 3, 4, 5, 6, 7]);
        for (served, original) in events.iter().zip(&written) {
            assert_eq!(served["id"], json!(original.id));
            if served["seq"] == json!(4) {
                assert_eq!(served["redacted"], json!(true));
                assert!(!served.to_string().contains("pasted by mistake"));
            } else {
                let event: Event = serde_json::from_value(served.clone()).unwrap();
                assert_eq!(verify_event(&event), Ok(()));
            }
        }
        assert_eq!(seqs(&peer.sync_all(0, Some("random")).await.0), vec![2, 4, 5, 7]);
        for (conv, creator) in [("general", &ann_key), ("random", &bob_key)] {
            let listed = peer.ask(json!({"t": "conv.members", "conv": conv})).await;
            assert_eq!(listed["private"], json!(false));
            assert_eq!(listed["members"].as_array().unwrap().len(), 1);
            assert_eq!(listed["members"][0]["pubkey"], json!(pubkey_hex(creator)));
        }
    }

    // The old rules still hold on the old rows, and the log goes on.
    assert_eq!(error_code(&bob.publish("msg.edit", json!({"conv": "random", "id": "m2", "msg": {"text": "back"}})).await), "gone");
    assert_eq!(error_code(&newcomer.publish("msg.post", post("general", "m1", "again")).await), "duplicate_msg");
    assert_eq!(newcomer.must("msg.post", post("general", "m4", "hello from version 2")).await, 8);
    assert_eq!(bob.must("msg.edit", json!({"conv": "random", "id": "m3", "msg": {"id": "m3", "text": "edited"}})).await, 9);
    assert_eq!(seqs(&ann.live_until(9).await), vec![8, 9]);

    // Opening the file again is not a second migration.
    let conn = rusqlite::Connection::open(&relay.cfg.db_path).unwrap();
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
    assert_eq!(version, 2);
    cube_relay::owner_invite(&relay.cfg, 7).unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_version_1_row_with_an_unreadable_body_stops_the_relay_from_starting() {
    let dir = tempfile::tempdir().unwrap();
    let db_path = dir.path().join("relay.db");
    write_v1_database(&db_path, &generate_key(), &generate_key());
    {
        let conn = rusqlite::Connection::open(&db_path).unwrap();
        conn.execute("UPDATE events SET body = '{\"msg\":' WHERE seq = 3", []).unwrap();
    }
    let before = std::fs::read(&db_path).unwrap();

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let cfg = Config {
        bind: addr,
        db_path: db_path.clone(),
        name: "Test Team".to_string(),
        public_host: addr.to_string(),
        trusted_proxies: Vec::new(),
            app_url: None,
        limits: Limits::default(),
    };
    let error = cube_relay::serve(cfg.clone(), listener, CancellationToken::new()).await.unwrap_err().to_string();
    assert!(error.contains("from schema version 1 to 2"), "{error}");
    assert!(error.contains("left unchanged"), "{error}");
    assert!(error.contains("event 3 (msg.post)"), "{error}");
    assert!(cube_relay::owner_invite(&cfg, 7).is_err());

    // The binary says the same and exits with a failure.
    let db = db_path.to_str().unwrap().to_string();
    let (ok, stdout, stderr) =
        tokio::task::spawn_blocking(move || run(env!("CARGO_BIN_EXE_cube-relay"), &["owner-invite"], &[("CUBE_RELAY_DB", &db)]))
            .await
            .unwrap();
    assert!(!ok);
    assert!(stdout.is_empty());
    assert!(stderr.contains("event 3 (msg.post)"), "{stderr}");

    // Nothing was written: the rows, the tables and the version are as they were.
    let conn = rusqlite::Connection::open(&db_path).unwrap();
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
    assert_eq!(version, 0);
    let new_table: bool = conn
        .query_row("SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE name = 'conv_members')", [], |r| r.get(0))
        .unwrap();
    assert!(!new_table);
    let rows: i64 = conn.query_row("SELECT COUNT(*) FROM events", [], |r| r.get(0)).unwrap();
    assert_eq!(rows, 7);
    drop(conn);
    assert_eq!(std::fs::read(&db_path).unwrap().len(), before.len());
}

// ---- the binaries --------------------------------------------------------------------

fn run(program: &str, args: &[&str], env: &[(&str, &str)]) -> (bool, String, String) {
    let mut command = Command::new(program);
    command.args(args).env_remove("RUST_LOG");
    for name in ["CUBE_RELAY_BIND", "CUBE_RELAY_DB", "CUBE_RELAY_NAME", "CUBE_RELAY_PUBLIC_HOST", "CUBE_RELAY_TRUSTED_PROXY"] {
        command.env_remove(name);
    }
    for (name, value) in env {
        command.env(name, value);
    }
    let output = command.output().unwrap();
    (
        output.status.success(),
        String::from_utf8(output.stdout).unwrap(),
        String::from_utf8(output.stderr).unwrap(),
    )
}

#[test]
fn relay_refuses_a_public_bind_without_public_host() {
    let relay = env!("CARGO_BIN_EXE_cube-relay");
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("relay.db");
    let db = db.to_str().unwrap();

    for command in [&[][..], &["owner-invite"][..]] {
        let (ok, stdout, stderr) = run(relay, command, &[("CUBE_RELAY_BIND", "0.0.0.0:18484"), ("CUBE_RELAY_DB", db)]);
        assert!(!ok);
        assert!(stdout.is_empty());
        assert!(stderr.contains("CUBE_RELAY_PUBLIC_HOST is required"), "{stderr}");
    }
    assert!(!std::path::Path::new(db).exists());
}

#[test]
fn owner_invite_prints_the_link_to_stdout_only() {
    let relay = env!("CARGO_BIN_EXE_cube-relay");
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("relay.db");
    let db = db.to_str().unwrap();

    let (ok, stdout, stderr) = run(relay, &["owner-invite"], &[("CUBE_RELAY_DB", db)]);
    assert!(ok, "{stderr}");
    let link = parse_invite_link(stdout.trim()).unwrap();
    assert_eq!(stdout.lines().count(), 1);
    assert_eq!(link.url, "ws://127.0.0.1:8484/ws");
    assert!(!stderr.contains(&link.token));

    // Behind TLS the link is cube+wss and names the public host.
    let env = [("CUBE_RELAY_DB", db), ("CUBE_RELAY_BIND", "0.0.0.0:8484"), ("CUBE_RELAY_PUBLIC_HOST", "relay.example.com")];
    let (ok, stdout, stderr) = run(relay, &["owner-invite", "--days", "1"], &env);
    assert!(ok, "{stderr}");
    assert!(stdout.starts_with("cube+wss://relay.example.com/#invite="), "{stdout}");
    let second = parse_invite_link(stdout.trim()).unwrap();
    assert_ne!(second.token, link.token);

    // The database holds neither token.
    let bytes = std::fs::read(db).unwrap();
    for token in [&link.token, &second.token] {
        assert!(!bytes.windows(token.len()).any(|w| w == token.as_bytes()));
    }

    let (ok, _, _) = run(relay, &["owner-invite", "--days", "31"], &[("CUBE_RELAY_DB", db)]);
    assert!(!ok);
    let (ok, _, _) = run(relay, &["nonsense"], &[]);
    assert!(!ok);
}

#[tokio::test(flavor = "multi_thread")]
async fn cube_peer_round_trip() {
    let relay = TestRelay::start().await;
    let link = cube_relay::owner_invite(&relay.cfg, 7).unwrap();
    let (url, host) = (relay.url(), relay.host.clone());
    let dir = tempfile::tempdir().unwrap();
    let ann_key = dir.path().join("ann.key").to_str().unwrap().to_string();
    let bea_key = dir.path().join("bea.key").to_str().unwrap().to_string();

    let lines = tokio::task::spawn_blocking(move || {
        let peer = env!("CARGO_BIN_EXE_cube-peer");
        let json = |args: &[&str]| -> Value {
            let (ok, stdout, stderr) = run(peer, args, &[]);
            let value: Value = serde_json::from_str(stdout.trim()).unwrap_or_else(|_| panic!("{stdout} {stderr}"));
            assert_eq!(value["ok"], json!(ok), "{value}");
            value
        };
        let as_peer = |key: &str, args: &[&str]| {
            json(&[&["--key", key, "--relay", url.as_str(), "--host", host.as_str()][..], args].concat())
        };
        let ann = |args: &[&str]| as_peer(&ann_key, args);
        let bea = |args: &[&str]| as_peer(&bea_key, args);

        // Ann claims the owner invite; the key file is created private.
        let joined = json(&["--key", &ann_key, "join", &link, "--name", "Ann"]);
        assert_eq!(joined["you"]["role"], json!("owner"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&ann_key).unwrap().permissions().mode() & 0o777, 0o600);
        }
        // The link cannot be used twice.
        let again = json(&["--key", &bea_key, "join", &link, "--name", "Bea"]);
        assert_eq!(again["code"], json!("denied"));

        assert_eq!(ann(&["conv", "general", "General"])["seq"], json!(1));
        let invite = ann(&["invite"]);
        let joined = json(&["--key", &bea_key, "join", invite["link"].as_str().unwrap(), "--name", "Bea"]);
        assert_eq!(joined["you"]["role"], json!("member"));
        assert_eq!(bea(&["invite", "--role", "admin"])["code"], json!("forbidden"));

        // Ann listens from the start while Bea posts, edits and deletes.
        let mut listener = Command::new(peer)
            .args(["--key", &ann_key, "--relay", &url, "--host", &host, "listen", "--from", "0"])
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut stdout = BufReader::new(listener.stdout.take().unwrap()).lines();
        // Wait until it has replayed the history, so what follows arrives live.
        let mut lines = vec![serde_json::from_str::<Value>(&stdout.next().unwrap().unwrap()).unwrap()];
        assert_eq!(lines[0]["seq"], json!(1));

        let posted = bea(&["post", "general", "hello from bea"]);
        assert_eq!(posted["seq"], json!(2));
        let msg_id = posted["msg_id"].as_str().unwrap().to_string();
        assert_eq!(ann(&["edit", "general", &msg_id, "not mine"])["code"], json!("forbidden"));
        assert_eq!(bea(&["edit", "general", &msg_id, "hello again"])["seq"], json!(3));
        assert_eq!(ann(&["delete", "general", &msg_id])["seq"], json!(4));

        for line in stdout {
            let value: Value = serde_json::from_str(&line.unwrap()).unwrap();
            let done = value["seq"] == json!(4);
            lines.push(value);
            if done {
                break;
            }
        }
        listener.kill().unwrap();
        listener.wait().unwrap();
        lines
    })
    .await
    .unwrap();

    let events: Vec<&Value> = lines.iter().filter(|l| l["t"] == json!("event")).collect();
    let kinds: Vec<&str> = events.iter().map(|e| e["kind"].as_str().unwrap()).collect();
    assert_eq!(kinds, vec!["conv.put", "msg.post", "msg.edit", "msg.delete"]);
    assert!(events[1]["body"].as_str().unwrap().contains("hello from bea"));
}

#[tokio::test(flavor = "multi_thread")]
async fn cube_peer_private_channels() {
    let relay = TestRelay::start().await;
    let link = cube_relay::owner_invite(&relay.cfg, 7).unwrap();
    let (url, host) = (relay.url(), relay.host.clone());
    let dir = tempfile::tempdir().unwrap();
    let key_file = |name: &str| dir.path().join(name).to_str().unwrap().to_string();
    let (ann_key, bea_key, cy_key) = (key_file("ann.key"), key_file("bea.key"), key_file("cy.key"));

    tokio::task::spawn_blocking(move || {
        let peer = env!("CARGO_BIN_EXE_cube-peer");
        // Every line of output is one JSON object; the last one is the command's result.
        let lines = |args: &[&str]| -> Vec<Value> {
            let (ok, stdout, stderr) = run(peer, args, &[]);
            let lines: Vec<Value> = stdout
                .lines()
                .map(|line| serde_json::from_str(line).unwrap_or_else(|_| panic!("{line} {stderr}")))
                .collect();
            assert_eq!(lines.last().unwrap()["ok"], json!(ok), "{stdout}");
            lines
        };
        let as_peer = |key: &str, args: &[&str]| {
            let mut out = lines(&[&["--key", key, "--relay", url.as_str(), "--host", host.as_str()][..], args].concat());
            let result = out.pop().unwrap();
            (out, result)
        };
        let ann = |args: &[&str]| as_peer(&ann_key, args).1;
        let bea = |args: &[&str]| as_peer(&bea_key, args).1;
        let cy = |args: &[&str]| as_peer(&cy_key, args).1;
        let join = |key: &str, link: &str, name: &str| lines(&["--key", key, "join", link, "--name", name]).pop().unwrap();

        let joined = join(&ann_key, &link, "Ann");
        assert_eq!(joined["features"], json!(["channels", "join-page", "profiles"]));
        assert_eq!(joined["settings"], json!({"member_invites": true}));
        let ann_pk = joined["you"]["pubkey"].as_str().unwrap().to_string();

        // A private channel, made and written in by Ann.
        assert_eq!(ann(&["conv", "plans", "Plans", "--private"])["seq"], json!(1));
        assert_eq!(ann(&["post", "plans", "the plan"])["seq"], json!(2));

        // Bea joins the team and sees nothing of it.
        let invite = ann(&["invite"]);
        let joined = join(&bea_key, invite["link"].as_str().unwrap(), "Bea");
        let bea_pk = joined["you"]["pubkey"].as_str().unwrap().to_string();
        let status = bea(&["status"]);
        assert_eq!((status["head"].clone(), status["you"]["role"].clone()), (json!(0), json!("member")));
        assert_eq!(status["features"], json!(["channels", "join-page", "profiles"]));
        assert_eq!(bea(&["sync"]), json!({"ok": true, "events": 0, "next": 0}));
        assert_eq!(bea(&["post", "plans", "hello?"])["code"], json!("no_conv"));
        assert_eq!(bea(&["members", "plans"])["code"], json!("no_conv"));
        assert_eq!(bea(&["add", "plans", &bea_pk])["code"], json!("no_conv"));

        // Ann adds her: the channel's history is there from the start.
        let added = ann(&["add", "plans", &bea_pk]);
        assert_eq!((added["seq"].clone(), added["kind"].clone()), (json!(3), json!("conv.add")));
        let (events, result) = as_peer(&bea_key, &["sync", "--conv", "plans"]);
        assert_eq!(result, json!({"ok": true, "events": 3, "next": 3, "conv": "plans"}));
        let kinds: Vec<&str> = events.iter().map(|e| e["kind"].as_str().unwrap()).collect();
        assert_eq!(kinds, vec!["conv.put", "msg.post", "conv.add"]);
        assert!(events.iter().all(|e| e["t"] == json!("event")));
        let members = bea(&["members", "plans"]);
        assert_eq!(members["private"], json!(true));
        let in_it: Vec<&str> = members["members"].as_array().unwrap().iter().map(|m| m["pubkey"].as_str().unwrap()).collect();
        assert_eq!(in_it, vec![ann_pk.as_str(), bea_pk.as_str()]);

        // A member's invite to the channel puts the newcomer in it.
        assert_eq!(bea(&["invite"])["code"], json!("forbidden"));
        let invite = bea(&["invite", "--conv", "plans"]);
        assert_eq!(invite["conv"], json!("plans"));
        let joined = join(&cy_key, invite["link"].as_str().unwrap(), "Cy");
        assert_eq!(joined["head"], json!(3));
        assert_eq!(cy(&["post", "plans", "glad to be here"])["seq"], json!(4));

        // Ann takes Bea out: Bea is left with the removal alone.
        let removed = ann(&["remove", "plans", &bea_pk]);
        assert_eq!((removed["seq"].clone(), removed["kind"].clone()), (json!(5), json!("conv.remove")));
        let (events, result) = as_peer(&bea_key, &["sync", "--after", "0"]);
        assert_eq!(result, json!({"ok": true, "events": 1, "next": 5}));
        assert_eq!((events[0]["seq"].clone(), events[0]["kind"].clone()), (json!(5), json!("conv.remove")));
        assert_eq!(bea(&["sync", "--conv", "plans"]), json!({"ok": true, "events": 0, "next": 5, "conv": "plans"}));

        // The setting is the owner's.
        assert_eq!(cy(&["settings", "--member-invites", "false"])["code"], json!("forbidden"));
        assert_eq!(ann(&["settings", "--member-invites", "false"]), json!({"ok": true, "member_invites": false}));
        assert_eq!(cy(&["status"])["settings"], json!({"member_invites": false}));
        assert_eq!(cy(&["invite", "--conv", "plans"])["code"], json!("forbidden"));
    })
    .await
    .unwrap();
}
