//! Wire format shared by `cube-relay` and the Cube app.
//!
//! Everything here follows `docs/team-relay.md`: an event is identified by the
//! SHA-256 of a fixed text layout, signed with the author's Ed25519 key, and a
//! connection proves possession of that key by signing a challenge that names
//! the host, the workspace and the relay's nonce.

use std::fmt;
use std::net::Ipv6Addr;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use ed25519_dalek::{Signature, Signer, VerifyingKey};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub use ed25519_dalek::SigningKey;

const EVENT_PREFIX: &str = "cube-event-v1";
const AUTH_PREFIX: &str = "cube-auth-v1";
const CLAIM_PREFIX: &str = "cube-claim-v1";
const INVITE_TOKEN_BYTES: usize = 32;

/// A signed event, or the redacted remains of one.
///
/// `body` is a string holding JSON; the signature covers its exact bytes.
/// A redacted event carries `redacted: true` and no `sig`.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Event {
    pub id: String,
    pub pubkey: String,
    pub created_at: u64,
    pub kind: String,
    pub ws: String,
    pub body: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sig: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub redacted: bool,
}

/// Why something could not be parsed or verified.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProtoError {
    /// A key is not 32 bytes of lower-case hex, or is not a valid Ed25519 point.
    BadKey,
    /// A field that is hashed line by line contains a line break or is malformed.
    BadField(&'static str),
    /// `id` is not the hash of the other fields.
    BadId,
    /// The event has no signature.
    MissingSignature,
    /// The signature is malformed or does not verify.
    BadSignature,
    /// The event was rewritten by the relay; there is nothing to verify.
    Redacted,
    /// The invite link is not one this version accepts.
    BadLink(&'static str),
}

impl fmt::Display for ProtoError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ProtoError::BadKey => write!(f, "key is not a valid Ed25519 key in lower-case hex"),
            ProtoError::BadField(name) => write!(f, "field `{name}` is malformed"),
            ProtoError::BadId => write!(f, "event id does not match its contents"),
            ProtoError::MissingSignature => write!(f, "event has no signature"),
            ProtoError::BadSignature => write!(f, "signature does not verify"),
            ProtoError::Redacted => write!(f, "event is redacted and cannot be verified"),
            ProtoError::BadLink(why) => write!(f, "invite link is not valid: {why}"),
        }
    }
}

impl std::error::Error for ProtoError {}

fn is_lower_hex(s: &str, len: usize) -> bool {
    s.len() == len && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn sha256_hex(data: &[u8]) -> String {
    hex::encode(Sha256::digest(data))
}

fn verifying_key(pubkey_hex: &str) -> Result<VerifyingKey, ProtoError> {
    if !is_lower_hex(pubkey_hex, 64) {
        return Err(ProtoError::BadKey);
    }
    let mut bytes = [0u8; 32];
    hex::decode_to_slice(pubkey_hex, &mut bytes).map_err(|_| ProtoError::BadKey)?;
    VerifyingKey::from_bytes(&bytes).map_err(|_| ProtoError::BadKey)
}

fn signature(sig_hex: &str) -> Result<Signature, ProtoError> {
    if !is_lower_hex(sig_hex, 128) {
        return Err(ProtoError::BadSignature);
    }
    let mut bytes = [0u8; 64];
    hex::decode_to_slice(sig_hex, &mut bytes).map_err(|_| ProtoError::BadSignature)?;
    Ok(Signature::from_bytes(&bytes))
}

/// `id` = SHA-256 of `cube-event-v1\n<pubkey>\n<created_at>\n<kind>\n<ws>\n<body>`, lower-case hex.
pub fn event_id(pubkey: &str, created_at: u64, kind: &str, ws: &str, body: &str) -> String {
    let mut h = Sha256::new();
    h.update(EVENT_PREFIX.as_bytes());
    h.update(b"\n");
    h.update(pubkey.as_bytes());
    h.update(b"\n");
    h.update(created_at.to_string().as_bytes());
    h.update(b"\n");
    h.update(kind.as_bytes());
    h.update(b"\n");
    h.update(ws.as_bytes());
    h.update(b"\n");
    h.update(body.as_bytes());
    hex::encode(h.finalize())
}

/// Builds an event and signs its 32 id bytes.
pub fn sign_event(key: &SigningKey, created_at: u64, kind: &str, ws: &str, body: &str) -> Event {
    let pubkey = pubkey_hex(key);
    let id = event_id(&pubkey, created_at, kind, ws, body);
    let digest: [u8; 32] = {
        let mut out = [0u8; 32];
        // `id` was produced by hex::encode two lines above.
        hex::decode_to_slice(&id, &mut out).expect("event_id returns 64 hex characters");
        out
    };
    let sig = key.sign(&digest);
    Event {
        id,
        pubkey,
        created_at,
        kind: kind.to_string(),
        ws: ws.to_string(),
        body: body.to_string(),
        sig: Some(hex::encode(sig.to_bytes())),
        redacted: false,
    }
}

/// Checks that `id` is the hash of the event's fields and that `sig` is the
/// author's signature over the id bytes.
///
/// Redacted events are an error here: callers skip them instead of verifying.
/// `kind` and `ws` must not contain a line break, because the hash separates
/// fields with one; only `body`, the last field, may.
pub fn verify_event(e: &Event) -> Result<(), ProtoError> {
    if e.redacted {
        return Err(ProtoError::Redacted);
    }
    let key = verifying_key(&e.pubkey)?;
    if e.kind.is_empty() || e.kind.contains(['\n', '\r']) {
        return Err(ProtoError::BadField("kind"));
    }
    if e.ws.is_empty() || e.ws.contains(['\n', '\r']) {
        return Err(ProtoError::BadField("ws"));
    }
    let expected = event_id(&e.pubkey, e.created_at, &e.kind, &e.ws, &e.body);
    if expected != e.id {
        return Err(ProtoError::BadId);
    }
    let sig_hex = e.sig.as_deref().ok_or(ProtoError::MissingSignature)?;
    let sig = signature(sig_hex)?;
    let mut digest = [0u8; 32];
    hex::decode_to_slice(&expected, &mut digest).map_err(|_| ProtoError::BadId)?;
    key.verify_strict(&digest, &sig).map_err(|_| ProtoError::BadSignature)
}

/// The text a member signs to authenticate: `cube-auth-v1\n<host>\n<ws>\n<nonce>`.
pub fn auth_message(host: &str, ws: &str, nonce: &str) -> String {
    format!("{AUTH_PREFIX}\n{host}\n{ws}\n{nonce}")
}

/// The text signed to claim an invite:
/// `cube-claim-v1\n<host>\n<ws>\n<nonce>\n<sha256 hex of the invite token>`.
pub fn claim_message(host: &str, ws: &str, nonce: &str, invite_token: &str) -> String {
    let token_hash = sha256_hex(invite_token.as_bytes());
    format!("{CLAIM_PREFIX}\n{host}\n{ws}\n{nonce}\n{token_hash}")
}

/// Signs the UTF-8 bytes of `message`; returns the signature in lower-case hex.
pub fn sign_text(key: &SigningKey, message: &str) -> String {
    hex::encode(key.sign(message.as_bytes()).to_bytes())
}

/// True only if `sig_hex` is `pubkey_hex`'s signature over the UTF-8 bytes of `message`.
pub fn verify_text(pubkey_hex: &str, message: &str, sig_hex: &str) -> bool {
    let (Ok(key), Ok(sig)) = (verifying_key(pubkey_hex), signature(sig_hex)) else {
        return false;
    };
    key.verify_strict(message.as_bytes(), &sig).is_ok()
}

/// A new random key from the operating system's generator.
pub fn generate_key() -> SigningKey {
    let mut seed = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut seed);
    let key = SigningKey::from_bytes(&seed);
    seed.fill(0);
    key
}

/// The 32-byte private seed in lower-case hex. Treat the result as a secret.
pub fn key_to_hex(key: &SigningKey) -> String {
    hex::encode(key.to_bytes())
}

/// Reads a private seed written by [`key_to_hex`]. Surrounding whitespace is ignored.
pub fn key_from_hex(s: &str) -> Result<SigningKey, ProtoError> {
    let s = s.trim();
    if s.len() != 64 {
        return Err(ProtoError::BadKey);
    }
    let mut seed = [0u8; 32];
    hex::decode_to_slice(s, &mut seed).map_err(|_| ProtoError::BadKey)?;
    let key = SigningKey::from_bytes(&seed);
    seed.fill(0);
    Ok(key)
}

/// The public key (the person's identity) in lower-case hex.
pub fn pubkey_hex(key: &SigningKey) -> String {
    hex::encode(key.verifying_key().to_bytes())
}

/// A parsed invite link.
#[derive(Clone, PartialEq, Eq)]
pub struct InviteLink {
    /// `ws://host/ws` or `wss://host/ws`.
    pub url: String,
    /// `host[:port]` as the client dials it; this is what gets signed.
    pub host: String,
    pub token: String,
}

impl fmt::Debug for InviteLink {
    // The token is a credential: keep it out of logs and panic messages.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("InviteLink")
            .field("url", &self.url)
            .field("host", &self.host)
            .field("token", &"<redacted>")
            .finish()
    }
}

/// Splits `host[:port]` into the host part and whether it is well formed.
fn split_host(host: &str) -> Option<&str> {
    let (name, port) = if let Some(rest) = host.strip_prefix('[') {
        let (inner, after) = rest.split_once(']')?;
        inner.parse::<Ipv6Addr>().ok()?;
        let name = &host[..inner.len() + 2];
        match after {
            "" => (name, None),
            _ => (name, Some(after.strip_prefix(':')?)),
        }
    } else {
        match host.rsplit_once(':') {
            Some((name, port)) => (name, Some(port)),
            None => (host, None),
        }
    };
    if let Some(port) = port {
        let ok = !port.is_empty()
            && port.len() <= 5
            && port.bytes().all(|b| b.is_ascii_digit())
            && matches!(port.parse::<u32>(), Ok(1..=65535));
        if !ok {
            return None;
        }
    }
    if !name.starts_with('[') {
        let ok = !name.is_empty()
            && name.len() <= 253
            && name.bytes().all(|b| matches!(b, b'a'..=b'z' | b'0'..=b'9' | b'.' | b'-'))
            && name.split('.').all(|label| {
                !label.is_empty() && !label.starts_with('-') && !label.ends_with('-')
            });
        if !ok {
            return None;
        }
    }
    Some(name)
}

fn is_loopback_name(name: &str) -> bool {
    matches!(name, "localhost" | "127.0.0.1" | "[::1]")
}

fn is_invite_token(token: &str) -> bool {
    matches!(URL_SAFE_NO_PAD.decode(token), Ok(bytes) if bytes.len() == INVITE_TOKEN_BYTES)
}

/// Parses `cube+wss://host[:port]/#invite=<token>` (or `cube+ws://…`).
///
/// `cube+ws` is accepted only for `localhost`, `127.0.0.1` and `[::1]`. The
/// link may carry nothing else: no user info, path, query or other fragment
/// parameters. The host is lower-cased; the token must be 32 bytes of
/// unpadded base64url.
pub fn parse_invite_link(link: &str) -> Result<InviteLink, ProtoError> {
    let link = link.trim();
    let (scheme, rest) = link
        .split_once("://")
        .ok_or(ProtoError::BadLink("missing scheme"))?;
    let tls = match scheme {
        "cube+wss" => true,
        "cube+ws" => false,
        _ => return Err(ProtoError::BadLink("scheme must be cube+wss or cube+ws")),
    };
    let (authority, fragment) = rest
        .split_once('#')
        .ok_or(ProtoError::BadLink("missing #invite= fragment"))?;
    let authority = authority.strip_suffix('/').unwrap_or(authority);
    let host = authority.to_ascii_lowercase();
    let name = split_host(&host).ok_or(ProtoError::BadLink("host is malformed"))?;
    if !tls && !is_loopback_name(name) {
        return Err(ProtoError::BadLink("cube+ws is only allowed for a local relay"));
    }
    let token = fragment
        .strip_prefix("invite=")
        .ok_or(ProtoError::BadLink("missing #invite= fragment"))?;
    if !is_invite_token(token) {
        return Err(ProtoError::BadLink("invite token is malformed"));
    }
    let ws_scheme = if tls { "wss" } else { "ws" };
    Ok(InviteLink {
        url: format!("{ws_scheme}://{host}/ws"),
        host,
        token: token.to_string(),
    })
}

/// Builds the link [`parse_invite_link`] reads. The token sits in the fragment
/// so it is not sent in HTTP requests or written to proxy logs.
pub fn format_invite_link(host: &str, tls: bool, token: &str) -> String {
    let scheme = if tls { "cube+wss" } else { "cube+ws" };
    format!("{scheme}://{host}/#invite={token}")
}

#[cfg(test)]
mod tests {
    use super::*;

    const WS: &str = "w_3f9a";
    const BODY: &str = r#"{"conv":"general","msg":{"id":"m1","text":"hi\nthere"}}"#;

    fn key() -> SigningKey {
        // RFC 8032, section 7.1, test 1.
        key_from_hex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60").unwrap()
    }

    fn token() -> String {
        URL_SAFE_NO_PAD.encode([7u8; 32])
    }

    #[test]
    fn rfc8032_vector() {
        let k = key();
        assert_eq!(
            pubkey_hex(&k),
            "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a"
        );
        let sig = sign_text(&k, "");
        assert_eq!(
            sig,
            "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e06522490155\
             5fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b"
        );
        assert!(verify_text(&pubkey_hex(&k), "", &sig));
    }

    #[test]
    fn event_id_is_the_documented_hash() {
        let pk = pubkey_hex(&key());
        let text = format!("cube-event-v1\n{pk}\n1794460000\nmsg.post\n{WS}\n{BODY}");
        assert_eq!(
            event_id(&pk, 1794460000, "msg.post", WS, BODY),
            hex::encode(Sha256::digest(text.as_bytes()))
        );
        // Fixed vector, so another implementation can check itself against it.
        assert_eq!(
            event_id(&pk, 1794460000, "msg.post", WS, BODY),
            EVENT_ID_VECTOR
        );
    }

    const EVENT_ID_VECTOR: &str = "f4139d440b41fd81474caed267fb80953f57fc1796f7f5959f5a9cf25e2d06e7";

    #[test]
    fn signed_event_verifies() {
        let e = sign_event(&key(), 1794460000, "msg.post", WS, BODY);
        assert_eq!(e.pubkey, pubkey_hex(&key()));
        assert_eq!(e.id.len(), 64);
        assert_eq!(e.sig.as_ref().unwrap().len(), 128);
        assert!(!e.redacted);
        assert_eq!(verify_event(&e), Ok(()));
    }

    #[test]
    fn tampering_with_any_field_is_caught() {
        let e = sign_event(&key(), 1794460000, "msg.post", WS, BODY);

        let mut t = e.clone();
        t.body.push(' ');
        assert_eq!(verify_event(&t), Err(ProtoError::BadId));

        let mut t = e.clone();
        t.kind = "msg.edit".into();
        assert_eq!(verify_event(&t), Err(ProtoError::BadId));

        let mut t = e.clone();
        t.ws = "w_other".into();
        assert_eq!(verify_event(&t), Err(ProtoError::BadId));

        let mut t = e.clone();
        t.created_at += 1;
        assert_eq!(verify_event(&t), Err(ProtoError::BadId));

        let mut t = e.clone();
        t.id = event_id(&t.pubkey, t.created_at, &t.kind, &t.ws, "{}");
        assert_eq!(verify_event(&t), Err(ProtoError::BadId));

        // Another key claiming the event: the id no longer matches.
        let other = generate_key();
        let mut t = e.clone();
        t.pubkey = pubkey_hex(&other);
        assert_eq!(verify_event(&t), Err(ProtoError::BadId));

        // ... and with the id recomputed, the signature does not match.
        t.id = event_id(&t.pubkey, t.created_at, &t.kind, &t.ws, &t.body);
        assert_eq!(verify_event(&t), Err(ProtoError::BadSignature));
    }

    #[test]
    fn bad_signatures_are_caught() {
        let e = sign_event(&key(), 1794460000, "msg.post", WS, BODY);

        let mut t = e.clone();
        let mut sig = t.sig.take().unwrap().into_bytes();
        sig[0] = if sig[0] == b'0' { b'1' } else { b'0' };
        t.sig = Some(String::from_utf8(sig).unwrap());
        assert_eq!(verify_event(&t), Err(ProtoError::BadSignature));

        let mut t = e.clone();
        t.sig = None;
        assert_eq!(verify_event(&t), Err(ProtoError::MissingSignature));

        let mut t = e.clone();
        t.sig = Some("zz".into());
        assert_eq!(verify_event(&t), Err(ProtoError::BadSignature));

        let mut t = e.clone();
        t.sig = Some(t.sig.unwrap().to_uppercase());
        assert_eq!(verify_event(&t), Err(ProtoError::BadSignature));

        // A valid signature by the same key over something else.
        let mut t = e.clone();
        t.sig = Some(sign_text(&key(), "something else"));
        assert_eq!(verify_event(&t), Err(ProtoError::BadSignature));
    }

    #[test]
    fn malformed_fields_are_refused() {
        let e = sign_event(&key(), 1794460000, "msg.post", WS, BODY);

        let mut t = e.clone();
        t.pubkey = t.pubkey.to_uppercase();
        assert_eq!(verify_event(&t), Err(ProtoError::BadKey));

        let mut t = e.clone();
        t.pubkey = "abcd".into();
        assert_eq!(verify_event(&t), Err(ProtoError::BadKey));

        let mut t = e.clone();
        t.redacted = true;
        assert_eq!(verify_event(&t), Err(ProtoError::Redacted));

        // A line break in `kind` could move text between fields without
        // changing the hash input, so it is refused outright.
        let split = sign_event(&key(), 1, "msg.post\nw_a", "w_b", "{}");
        assert_eq!(verify_event(&split), Err(ProtoError::BadField("kind")));
        let split = sign_event(&key(), 1, "msg.post", "w_a\nw_b", "{}");
        assert_eq!(verify_event(&split), Err(ProtoError::BadField("ws")));
    }

    #[test]
    fn event_json_shape() {
        let e = sign_event(&key(), 1794460000, "msg.post", WS, BODY);
        let v: serde_json::Value = serde_json::to_value(&e).unwrap();
        let obj = v.as_object().unwrap();
        assert!(obj.contains_key("sig"));
        assert!(!obj.contains_key("redacted"));
        assert!(obj["body"].is_string());

        let back: Event = serde_json::from_value(v).unwrap();
        assert_eq!(verify_event(&back), Ok(()));

        let redacted = Event { sig: None, redacted: true, body: r#"{"conv":"c","id":"m","gone":true}"#.into(), ..e };
        let v = serde_json::to_value(&redacted).unwrap();
        let obj = v.as_object().unwrap();
        assert!(!obj.contains_key("sig"));
        assert_eq!(obj["redacted"], serde_json::Value::Bool(true));

        let parsed: Event = serde_json::from_str(
            r#"{"id":"a","pubkey":"b","created_at":1,"kind":"k","ws":"w","body":"{}"}"#,
        )
        .unwrap();
        assert!(parsed.sig.is_none());
        assert!(!parsed.redacted);
    }

    #[test]
    fn challenge_messages() {
        assert_eq!(
            auth_message("relay.example.com", WS, "aabb"),
            "cube-auth-v1\nrelay.example.com\nw_3f9a\naabb"
        );
        let t = "tok";
        assert_eq!(
            claim_message("relay.example.com", WS, "aabb", t),
            format!(
                "cube-claim-v1\nrelay.example.com\nw_3f9a\naabb\n{}",
                hex::encode(Sha256::digest(t.as_bytes()))
            )
        );
        // The token itself never appears in what is signed.
        assert!(!claim_message("h", WS, "n", "super-secret-token").contains("super-secret-token"));
    }

    #[test]
    fn text_signatures() {
        let k = generate_key();
        let pk = pubkey_hex(&k);
        let msg = auth_message("relay.example.com", WS, "00ff");
        let sig = sign_text(&k, &msg);
        assert!(verify_text(&pk, &msg, &sig));

        // Another host, workspace or nonce: the answer cannot be replayed.
        assert!(!verify_text(&pk, &auth_message("evil.example.com", WS, "00ff"), &sig));
        assert!(!verify_text(&pk, &auth_message("relay.example.com", "w_x", "00ff"), &sig));
        assert!(!verify_text(&pk, &auth_message("relay.example.com", WS, "00fe"), &sig));
        // An auth answer is not a claim answer.
        assert!(!verify_text(&pk, &claim_message("relay.example.com", WS, "00ff", "t"), &sig));

        let other = pubkey_hex(&generate_key());
        assert!(!verify_text(&other, &msg, &sig));
        assert!(!verify_text(&pk, &msg, "00"));
        assert!(!verify_text(&pk, &msg, &sig.to_uppercase()));
        assert!(!verify_text("not-a-key", &msg, &sig));
        assert!(!verify_text(&pk.to_uppercase(), &msg, &sig));
    }

    #[test]
    fn key_hex_round_trip() {
        let k = generate_key();
        let hex = key_to_hex(&k);
        assert_eq!(hex.len(), 64);
        let back = key_from_hex(&format!("{hex}\n")).unwrap();
        assert_eq!(pubkey_hex(&back), pubkey_hex(&k));
        assert_ne!(pubkey_hex(&generate_key()), pubkey_hex(&k));

        assert_eq!(key_from_hex("").err(), Some(ProtoError::BadKey));
        assert_eq!(key_from_hex("abcd").err(), Some(ProtoError::BadKey));
        assert_eq!(key_from_hex(&"g".repeat(64)).err(), Some(ProtoError::BadKey));
    }

    #[test]
    fn invite_link_round_trip() {
        let t = token();
        let link = format_invite_link("relay.example.com", true, &t);
        assert_eq!(link, format!("cube+wss://relay.example.com/#invite={t}"));
        let parsed = parse_invite_link(&link).unwrap();
        assert_eq!(parsed.url, "wss://relay.example.com/ws");
        assert_eq!(parsed.host, "relay.example.com");
        assert_eq!(parsed.token, t);

        let parsed = parse_invite_link(&format_invite_link("relay.example.com:8443", true, &t)).unwrap();
        assert_eq!(parsed.url, "wss://relay.example.com:8443/ws");
        assert_eq!(parsed.host, "relay.example.com:8443");

        for host in ["localhost:8484", "127.0.0.1:8484", "[::1]:8484", "localhost", "[::1]"] {
            let parsed = parse_invite_link(&format_invite_link(host, false, &t)).unwrap();
            assert_eq!(parsed.url, format!("ws://{host}/ws"));
            assert_eq!(parsed.host, host);
        }

        // The host is case-insensitive; what gets signed is the lower-case form.
        let parsed = parse_invite_link(&format!("cube+wss://Relay.Example.COM/#invite={t}")).unwrap();
        assert_eq!(parsed.host, "relay.example.com");

        // The slash before the fragment is optional.
        assert!(parse_invite_link(&format!("cube+wss://relay.example.com#invite={t}")).is_ok());
    }

    #[test]
    fn invite_link_refusals() {
        let t = token();
        let bad = |link: String| assert!(parse_invite_link(&link).is_err(), "accepted {link}");

        // Plain ws only for a local relay.
        bad(format!("cube+ws://relay.example.com/#invite={t}"));
        bad(format!("cube+ws://192.168.0.10:8484/#invite={t}"));
        bad(format!("cube+ws://localhost.example.com/#invite={t}"));
        bad(format!("cube+ws://127.0.0.1.example.com/#invite={t}"));
        bad(format!("cube+ws://[::2]/#invite={t}"));

        // Other schemes.
        bad(format!("wss://relay.example.com/#invite={t}"));
        bad(format!("https://relay.example.com/#invite={t}"));
        bad(format!("cube+http://relay.example.com/#invite={t}"));
        bad(format!("relay.example.com/#invite={t}"));

        // Anything that could point the connection somewhere else.
        bad(format!("cube+wss://user@relay.example.com/#invite={t}"));
        bad(format!("cube+wss://relay.example.com@evil.example.com/#invite={t}"));
        bad(format!("cube+wss://relay.example.com/path#invite={t}"));
        bad(format!("cube+wss://relay.example.com/?x=1#invite={t}"));
        bad(format!("cube+wss://relay.example.com//#invite={t}"));
        bad(format!("cube+wss:///#invite={t}"));
        bad(format!("cube+wss://relay example.com/#invite={t}"));
        bad(format!("cube+wss://relay.example.com:0/#invite={t}"));
        bad(format!("cube+wss://relay.example.com:99999/#invite={t}"));
        bad(format!("cube+wss://relay.example.com:/#invite={t}"));
        bad(format!("cube+wss://relay..example.com/#invite={t}"));
        bad(format!("cube+wss://[::1/#invite={t}"));
        bad(format!("cube+wss://[nope]/#invite={t}"));

        // Token problems.
        bad("cube+wss://relay.example.com/".to_string());
        bad("cube+wss://relay.example.com/#invite=".to_string());
        bad("cube+wss://relay.example.com/#invite=short".to_string());
        bad(format!("cube+wss://relay.example.com/#token={t}"));
        bad(format!("cube+wss://relay.example.com/#invite={t}&x=1"));
        bad(format!("cube+wss://relay.example.com/#invite={t}="));
        bad(format!(
            "cube+wss://relay.example.com/#invite={}",
            base64::engine::general_purpose::STANDARD.encode([0xfbu8; 32])
        ));
    }

    #[test]
    fn invite_link_debug_hides_the_token() {
        let t = token();
        let parsed = parse_invite_link(&format_invite_link("relay.example.com", true, &t)).unwrap();
        assert!(!format!("{parsed:?}").contains(&t));
    }
}
