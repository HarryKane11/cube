//! Storage: one SQLite file in WAL mode.
//!
//! Every row carries the workspace id and every statement below is
//! parameterised and filters on it. All rules that decide whether something is
//! allowed run inside the same transaction as the change they allow.

use std::fmt;
use std::path::Path;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use cube_proto::Event;
use rand::RngCore;
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::Serialize;
use sha2::{Digest, Sha256};

pub const MAX_IDENT_BYTES: usize = 128;
pub const MAX_CONV_NAME_CHARS: usize = 200;
pub const MAX_MEMBER_NAME_CHARS: usize = 64;
pub const MAX_INVITE_USES: u64 = 100;
pub const MAX_INVITE_DAYS: u64 = 30;
pub const DEFAULT_INVITE_DAYS: u64 = 7;
/// `created_by` of an invite made with `cube-relay owner-invite`.
pub const CREATED_BY_CLI: &str = "cli";

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS workspace (
    ws          TEXT PRIMARY KEY,
    created_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS members (
    ws          TEXT NOT NULL,
    pubkey      TEXT NOT NULL,
    name        TEXT NOT NULL,
    role        TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
    joined_at   INTEGER NOT NULL,
    PRIMARY KEY (ws, pubkey)
);
CREATE UNIQUE INDEX IF NOT EXISTS members_one_owner ON members (ws) WHERE role = 'owner';
CREATE TABLE IF NOT EXISTS invites (
    ws          TEXT NOT NULL,
    id          TEXT NOT NULL,
    token_hash  TEXT NOT NULL,
    role        TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
    uses_left   INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL,
    created_by  TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    PRIMARY KEY (ws, id),
    UNIQUE (ws, token_hash)
);
CREATE TABLE IF NOT EXISTS events (
    ws          TEXT NOT NULL,
    seq         INTEGER NOT NULL,
    id          TEXT NOT NULL,
    pubkey      TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    kind        TEXT NOT NULL,
    body        TEXT NOT NULL,
    sig         TEXT,
    redacted    INTEGER NOT NULL DEFAULT 0,
    msg_id      TEXT,
    PRIMARY KEY (ws, seq),
    UNIQUE (ws, id)
);
CREATE INDEX IF NOT EXISTS events_by_msg ON events (ws, msg_id) WHERE msg_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS convs (
    ws          TEXT NOT NULL,
    conv        TEXT NOT NULL,
    creator     TEXT NOT NULL,
    archived    INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (ws, conv)
);
CREATE TABLE IF NOT EXISTS messages (
    ws          TEXT NOT NULL,
    id          TEXT NOT NULL,
    author      TEXT NOT NULL,
    conv        TEXT NOT NULL,
    deleted     INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (ws, id)
);
";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Owner,
    Admin,
    Member,
}

impl Role {
    pub fn as_str(self) -> &'static str {
        match self {
            Role::Owner => "owner",
            Role::Admin => "admin",
            Role::Member => "member",
        }
    }

    pub fn parse(s: &str) -> Option<Role> {
        match s {
            "owner" => Some(Role::Owner),
            "admin" => Some(Role::Admin),
            "member" => Some(Role::Member),
            _ => None,
        }
    }

    /// Owner or admin.
    pub fn is_staff(self) -> bool {
        matches!(self, Role::Owner | Role::Admin)
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct Member {
    pub pubkey: String,
    pub name: String,
    pub role: Role,
    pub joined_at: u64,
}

#[derive(Clone, Debug, Serialize)]
pub struct InviteInfo {
    pub id: String,
    pub role: Role,
    pub uses_left: u64,
    pub expires_at: u64,
    pub created_by: String,
}

/// A freshly made invite. `token` is shown once and never stored.
pub struct NewInvite {
    pub id: String,
    pub token: String,
    pub expires_at: u64,
}

#[derive(Debug)]
pub enum OpError {
    /// The request broke a rule; `code` and `message` go back to the client.
    Refused { code: &'static str, message: &'static str },
    /// The database failed. Logged, never sent to the client.
    Internal(rusqlite::Error),
}

impl From<rusqlite::Error> for OpError {
    fn from(e: rusqlite::Error) -> Self {
        OpError::Internal(e)
    }
}

impl fmt::Display for OpError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            OpError::Refused { code, message } => write!(f, "{code}: {message}"),
            OpError::Internal(e) => write!(f, "database error: {e}"),
        }
    }
}

impl std::error::Error for OpError {}

pub type OpResult<T> = Result<T, OpError>;

fn refuse<T>(code: &'static str, message: &'static str) -> OpResult<T> {
    Err(OpError::Refused { code, message })
}

/// The outcome of an accepted publish.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Published {
    pub seq: u64,
    /// False when the relay already had this id from the same key.
    pub fresh: bool,
}

/// An event as stored, with its sequence number.
#[derive(Clone, Debug, Serialize)]
pub struct SeqEvent {
    pub seq: u64,
    #[serde(flatten)]
    pub event: Event,
}

/// What replaces the body of a post or edit that was deleted or superseded.
#[derive(Serialize)]
struct Gone<'a> {
    conv: &'a str,
    id: &'a str,
    gone: bool,
}

pub fn sha256_hex(data: &[u8]) -> String {
    hex::encode(Sha256::digest(data))
}

fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    rand::rngs::OsRng.fill_bytes(&mut buf);
    hex::encode(buf)
}

fn to_i64(v: u64) -> i64 {
    i64::try_from(v).unwrap_or(i64::MAX)
}

fn to_u64(v: i64) -> u64 {
    u64::try_from(v).unwrap_or(0)
}

/// An identifier chosen by a client (`conv`, `msg.id`): short, no control characters.
fn valid_ident(s: &str) -> bool {
    !s.is_empty() && s.len() <= MAX_IDENT_BYTES && !s.chars().any(char::is_control)
}

/// Trims a display name and checks it; `None` if it is unusable.
pub fn clean_member_name(name: &str) -> Option<String> {
    let name = name.trim();
    let ok = !name.is_empty()
        && name.chars().count() <= MAX_MEMBER_NAME_CHARS
        && !name.chars().any(char::is_control);
    ok.then(|| name.to_string())
}

fn str_field<'a>(obj: &'a serde_json::Map<String, serde_json::Value>, key: &str) -> Option<&'a str> {
    obj.get(key).and_then(serde_json::Value::as_str)
}

pub struct Db {
    conn: Connection,
    ws: String,
}

impl Db {
    /// Opens (or creates) the database. A new file is created readable by its
    /// owner only, and a workspace id is made on first start.
    pub fn open(path: &Path, now: u64) -> rusqlite::Result<Db> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            // Create the file ourselves so it never exists with wider permissions.
            // An existing file is left as its owner set it.
            let _ = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(path);
        }
        let mut conn = Connection::open(path)?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "FULL")?;
        // Overwrite freed content with zeros, so a deleted body does not linger in free pages.
        conn.pragma_update(None, "secure_delete", "ON")?;

        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute_batch(SCHEMA)?;
        let existing: Option<String> = tx
            .query_row("SELECT ws FROM workspace ORDER BY created_at, ws LIMIT 1", [], |r| r.get(0))
            .optional()?;
        let ws = match existing {
            Some(ws) => ws,
            None => {
                let ws = random_hex(16);
                tx.execute(
                    "INSERT INTO workspace (ws, created_at) VALUES (?1, ?2)",
                    params![ws, to_i64(now)],
                )?;
                ws
            }
        };
        tx.commit()?;
        Ok(Db { conn, ws })
    }

    pub fn ws(&self) -> &str {
        &self.ws
    }

    /// The last sequence number, 0 when there are no events.
    pub fn head(&self) -> rusqlite::Result<u64> {
        let head: i64 = self.conn.query_row(
            "SELECT COALESCE(MAX(seq), 0) FROM events WHERE ws = ?1",
            params![self.ws],
            |r| r.get(0),
        )?;
        Ok(to_u64(head))
    }

    pub fn members(&self) -> rusqlite::Result<Vec<Member>> {
        let mut stmt = self.conn.prepare_cached(
            "SELECT pubkey, name, role, joined_at FROM members WHERE ws = ?1 ORDER BY joined_at, rowid",
        )?;
        let rows = stmt.query_map(params![self.ws], row_to_member)?;
        rows.collect()
    }

    pub fn member(&self, pubkey: &str) -> rusqlite::Result<Option<Member>> {
        member_in(&self.conn, &self.ws, pubkey)
    }

    // ---- invites -----------------------------------------------------------

    /// Makes an invite and stores only the SHA-256 of its token.
    pub fn create_invite(
        &mut self,
        role: Role,
        uses: u64,
        days: u64,
        created_by: &str,
        now: u64,
    ) -> rusqlite::Result<NewInvite> {
        let tx = self.conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let invite = insert_invite(&tx, &self.ws, role, uses, days, created_by, now)?;
        tx.commit()?;
        Ok(invite)
    }

    /// Makes the owner invite. Any earlier owner invite that was not claimed
    /// stops working, so at most one is outstanding.
    pub fn create_owner_invite(&mut self, days: u64, now: u64) -> rusqlite::Result<NewInvite> {
        let tx = self.conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute(
            "DELETE FROM invites WHERE ws = ?1 AND role = 'owner'",
            params![self.ws],
        )?;
        let invite = insert_invite(&tx, &self.ws, Role::Owner, 1, days, CREATED_BY_CLI, now)?;
        tx.commit()?;
        Ok(invite)
    }

    /// Invites that can still be claimed. Never returns a token or its hash.
    pub fn list_invites(&mut self, now: u64) -> rusqlite::Result<Vec<InviteInfo>> {
        let tx = self.conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute(
            "DELETE FROM invites WHERE ws = ?1 AND (expires_at <= ?2 OR uses_left <= 0)",
            params![self.ws, to_i64(now)],
        )?;
        let invites = {
            let mut stmt = tx.prepare_cached(
                "SELECT id, role, uses_left, expires_at, created_by FROM invites
                 WHERE ws = ?1 ORDER BY created_at, id",
            )?;
            let rows = stmt.query_map(params![self.ws], |r| {
                let role: String = r.get(1)?;
                Ok(InviteInfo {
                    id: r.get(0)?,
                    role: Role::parse(&role).unwrap_or(Role::Member),
                    uses_left: to_u64(r.get(2)?),
                    expires_at: to_u64(r.get(3)?),
                    created_by: r.get(4)?,
                })
            })?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        tx.commit()?;
        Ok(invites)
    }

    /// Revokes an invite. An admin may revoke only invites that grant `member`.
    pub fn revoke_invite(&mut self, caller: &str, id: &str) -> OpResult<()> {
        let tx = self.conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let caller_role = role_in(&tx, &self.ws, caller)?;
        if !caller_role.is_some_and(Role::is_staff) {
            return refuse("forbidden", "only the owner and admins manage invites");
        }
        let granted: Option<String> = tx
            .query_row(
                "SELECT role FROM invites WHERE ws = ?1 AND id = ?2",
                params![self.ws, id],
                |r| r.get(0),
            )
            .optional()?;
        let Some(granted) = granted else {
            return refuse("not_found", "no such invite");
        };
        if caller_role != Some(Role::Owner) && granted != "member" {
            return refuse("forbidden", "only the owner can revoke this invite");
        }
        tx.execute(
            "DELETE FROM invites WHERE ws = ?1 AND id = ?2",
            params![self.ws, id],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Checks the token hash, expiry and uses left, and adds the member, in one
    /// transaction. Every refusal looks the same to the caller.
    ///
    /// The owner invite makes its claimer the owner and turns an earlier owner
    /// into an admin. Any other invite is refused for a key that is already a
    /// member, without being used up.
    pub fn claim(&mut self, token_hash: &str, pubkey: &str, name: &str, now: u64) -> OpResult<Member> {
        const DENIED: OpError = OpError::Refused { code: "denied", message: "invite not valid" };
        let tx = self.conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let invite: Option<(String, String, i64, i64)> = tx
            .query_row(
                "SELECT id, role, uses_left, expires_at FROM invites WHERE ws = ?1 AND token_hash = ?2",
                params![self.ws, token_hash],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()?;
        let Some((invite_id, role, uses_left, expires_at)) = invite else {
            return Err(DENIED);
        };
        let Some(role) = Role::parse(&role) else {
            return Err(DENIED);
        };
        if expires_at <= to_i64(now) || uses_left <= 0 {
            return Err(DENIED);
        }

        let existing = role_in(&tx, &self.ws, pubkey)?;
        match (role, existing) {
            (Role::Owner, existing) => {
                // The earlier owner can no longer hand out admin invites.
                tx.execute(
                    "DELETE FROM invites WHERE ws = ?1 AND role = 'admin' AND created_by IN
                       (SELECT pubkey FROM members WHERE ws = ?1 AND role = 'owner' AND pubkey <> ?2)",
                    params![self.ws, pubkey],
                )?;
                tx.execute(
                    "UPDATE members SET role = 'admin' WHERE ws = ?1 AND role = 'owner' AND pubkey <> ?2",
                    params![self.ws, pubkey],
                )?;
                if existing.is_some() {
                    tx.execute(
                        "UPDATE members SET role = 'owner' WHERE ws = ?1 AND pubkey = ?2",
                        params![self.ws, pubkey],
                    )?;
                } else {
                    insert_member(&tx, &self.ws, pubkey, name, Role::Owner, now)?;
                }
            }
            (_, Some(_)) => return Err(DENIED),
            (role, None) => insert_member(&tx, &self.ws, pubkey, name, role, now)?,
        }

        if uses_left <= 1 {
            tx.execute(
                "DELETE FROM invites WHERE ws = ?1 AND id = ?2",
                params![self.ws, invite_id],
            )?;
        } else {
            tx.execute(
                "UPDATE invites SET uses_left = uses_left - 1 WHERE ws = ?1 AND id = ?2",
                params![self.ws, invite_id],
            )?;
        }
        let member = member_in(&tx, &self.ws, pubkey)?.ok_or(DENIED)?;
        tx.commit()?;
        Ok(member)
    }

    // ---- members -----------------------------------------------------------

    /// Removes a member. The owner can remove anyone but themselves; an admin
    /// can remove members only. Invites the removed member made stop working.
    pub fn remove_member(&mut self, caller: &str, target: &str) -> OpResult<()> {
        let tx = self.conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let caller_role = role_in(&tx, &self.ws, caller)?;
        let Some(caller_role) = caller_role.filter(|r| r.is_staff()) else {
            return refuse("forbidden", "only the owner and admins remove members");
        };
        let Some(target_role) = role_in(&tx, &self.ws, target)? else {
            return refuse("not_found", "no such member");
        };
        let allowed = match (caller_role, target_role) {
            (_, Role::Owner) => false,
            (Role::Owner, _) => true,
            (Role::Admin, Role::Member) => true,
            _ => false,
        };
        if !allowed || caller == target {
            return refuse("forbidden", "not allowed to remove this member");
        }
        tx.execute(
            "DELETE FROM invites WHERE ws = ?1 AND created_by = ?2",
            params![self.ws, target],
        )?;
        tx.execute(
            "DELETE FROM members WHERE ws = ?1 AND pubkey = ?2",
            params![self.ws, target],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Changes a role between `admin` and `member`. Only the owner may, and
    /// not for themselves: ownership moves only through the owner invite.
    pub fn set_role(&mut self, caller: &str, target: &str, role: Role) -> OpResult<()> {
        let tx = self.conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if role_in(&tx, &self.ws, caller)? != Some(Role::Owner) {
            return refuse("forbidden", "only the owner changes roles");
        }
        if role == Role::Owner {
            return refuse("forbidden", "ownership moves only through the owner invite");
        }
        match role_in(&tx, &self.ws, target)? {
            None => return refuse("not_found", "no such member"),
            Some(Role::Owner) => return refuse("forbidden", "the owner's role cannot be changed"),
            Some(_) => {}
        }
        if role == Role::Member {
            // A member cannot make invites, so the ones they made as an admin go.
            tx.execute(
                "DELETE FROM invites WHERE ws = ?1 AND created_by = ?2",
                params![self.ws, target],
            )?;
        }
        tx.execute(
            "UPDATE members SET role = ?3 WHERE ws = ?1 AND pubkey = ?2",
            params![self.ws, target, role.as_str()],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// `name` must already be cleaned with [`clean_member_name`].
    pub fn rename_member(&mut self, pubkey: &str, name: &str) -> OpResult<()> {
        let changed = self.conn.execute(
            "UPDATE members SET name = ?3 WHERE ws = ?1 AND pubkey = ?2",
            params![self.ws, pubkey, name],
        )?;
        if changed == 0 {
            return refuse("not_member", "not a member");
        }
        Ok(())
    }

    // ---- events ------------------------------------------------------------

    /// Applies the kind-specific rule and stores the event with the next
    /// sequence number, in one transaction.
    ///
    /// The caller has already checked the id, the signature, that `pubkey` is
    /// the connection's key, the workspace and the body size.
    pub fn publish(&mut self, event: &Event, now: u64, skew_secs: u64) -> OpResult<Published> {
        let ws = self.ws.clone();
        let tx = self.conn.transaction_with_behavior(TransactionBehavior::Immediate)?;

        let Some(role) = role_in(&tx, &ws, &event.pubkey)? else {
            return refuse("not_member", "not a member");
        };

        // A retry after a lost answer gets the original seq back, however late it comes.
        let known: Option<(i64, String)> = tx
            .query_row(
                "SELECT seq, pubkey FROM events WHERE ws = ?1 AND id = ?2",
                params![ws, event.id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        if let Some((seq, author)) = known {
            if author != event.pubkey {
                return refuse("duplicate", "this id was published by another key");
            }
            return Ok(Published { seq: to_u64(seq), fresh: false });
        }

        if event.created_at.abs_diff(now) > skew_secs {
            return refuse("bad_time", "created_at is too far from relay time");
        }

        let body: serde_json::Value = match serde_json::from_str(&event.body) {
            Ok(v) => v,
            Err(_) => return refuse("bad_body", "body is not JSON"),
        };
        let Some(obj) = body.as_object() else {
            return refuse("bad_body", "body must be a JSON object");
        };
        // Offers of sub-agents are about a person's own cube, not about a channel.
        let about_agent = matches!(event.kind.as_str(), "agent.put" | "agent.drop");
        let conv = match str_field(obj, "conv").filter(|c| valid_ident(c)) {
            Some(conv) => conv,
            None if about_agent => "",
            None => return refuse("bad_body", "body.conv must be a short string"),
        };

        // The message whose earlier versions this event replaces, if any.
        let mut msg_id: Option<&str> = None;
        let mut redact_earlier = false;

        match event.kind.as_str() {
            "conv.put" => {
                let name_ok = str_field(obj, "name").is_some_and(|n| {
                    !n.trim().is_empty()
                        && n.chars().count() <= MAX_CONV_NAME_CHARS
                        && !n.chars().any(char::is_control)
                });
                if !name_ok {
                    return refuse("bad_body", "body.name must be a short, non-empty string");
                }
                let archived = match obj.get("archived") {
                    None => None,
                    Some(serde_json::Value::Bool(b)) => Some(*b),
                    Some(_) => return refuse("bad_body", "body.archived must be true or false"),
                };
                match conv_in(&tx, &ws, conv)? {
                    None => {
                        tx.execute(
                            "INSERT INTO convs (ws, conv, creator, archived) VALUES (?1, ?2, ?3, ?4)",
                            params![ws, conv, event.pubkey, archived.unwrap_or(false)],
                        )?;
                    }
                    Some((creator, _)) => {
                        if creator != event.pubkey && !role.is_staff() {
                            return refuse("forbidden", "only the channel's creator or an admin can change it");
                        }
                        if let Some(archived) = archived {
                            tx.execute(
                                "UPDATE convs SET archived = ?3 WHERE ws = ?1 AND conv = ?2",
                                params![ws, conv, archived],
                            )?;
                        }
                    }
                }
            }
            "msg.post" => {
                let id = obj
                    .get("msg")
                    .and_then(serde_json::Value::as_object)
                    .and_then(|m| str_field(m, "id"))
                    .filter(|id| valid_ident(id));
                let Some(id) = id else {
                    return refuse("bad_body", "body.msg.id must be a short string");
                };
                match conv_in(&tx, &ws, conv)? {
                    None => return refuse("no_conv", "the channel does not exist"),
                    Some((_, true)) => return refuse("archived", "the channel is archived"),
                    Some((_, false)) => {}
                }
                if message_in(&tx, &ws, id)?.is_some() {
                    return refuse("duplicate_msg", "msg.id is already used in this workspace");
                }
                tx.execute(
                    "INSERT INTO messages (ws, id, author, conv, deleted) VALUES (?1, ?2, ?3, ?4, 0)",
                    params![ws, id, event.pubkey, conv],
                )?;
                msg_id = Some(id);
            }
            "msg.edit" => {
                let Some(id) = str_field(obj, "id").filter(|id| valid_ident(id)) else {
                    return refuse("bad_body", "body.id must be a short string");
                };
                let Some(msg) = obj.get("msg").and_then(serde_json::Value::as_object) else {
                    return refuse("bad_body", "body.msg must be an object");
                };
                if msg.get("id").is_some_and(|inner| inner.as_str() != Some(id)) {
                    return refuse("bad_body", "body.msg.id must equal body.id");
                }
                let Some((author, posted_in, deleted)) = message_in(&tx, &ws, id)? else {
                    return refuse("not_found", "no such message");
                };
                if author != event.pubkey {
                    return refuse("forbidden", "only the author can edit a message");
                }
                if posted_in != conv {
                    return refuse("wrong_conv", "the message was posted in another channel");
                }
                if deleted {
                    return refuse("gone", "the message was deleted");
                }
                if matches!(conv_in(&tx, &ws, conv)?, Some((_, true))) {
                    return refuse("archived", "the channel is archived");
                }
                msg_id = Some(id);
                redact_earlier = true;
            }
            "msg.delete" => {
                let Some(id) = str_field(obj, "id").filter(|id| valid_ident(id)) else {
                    return refuse("bad_body", "body.id must be a short string");
                };
                let Some((author, posted_in, deleted)) = message_in(&tx, &ws, id)? else {
                    return refuse("not_found", "no such message");
                };
                if author != event.pubkey && !role.is_staff() {
                    return refuse("forbidden", "only the author or an admin can delete a message");
                }
                if posted_in != conv {
                    return refuse("wrong_conv", "the message was posted in another channel");
                }
                if deleted {
                    return refuse("gone", "the message was already deleted");
                }
                tx.execute(
                    "UPDATE messages SET deleted = 1 WHERE ws = ?1 AND id = ?2",
                    params![ws, id],
                )?;
                msg_id = Some(id);
                redact_earlier = true;
            }
            // A member offers one of their sub-agents to the team, or takes the offer back. The
            // relay only checks the shape: an offer belongs to whoever signed it, and clients key
            // it by that key, so nobody can replace or withdraw another member's.
            "agent.put" => {
                let agent = obj.get("agent").and_then(|a| a.as_object());
                let shaped = agent.is_some_and(|a| {
                    str_field(a, "id").is_some_and(valid_ident)
                        && str_field(a, "name").is_some_and(|n| {
                            !n.trim().is_empty() && n.chars().count() <= 40 && !n.chars().any(char::is_control)
                        })
                });
                if !shaped {
                    return refuse("bad_body", "body.agent needs a short id and a name");
                }
            }
            "agent.drop" => {
                if !str_field(obj, "id").is_some_and(valid_ident) {
                    return refuse("bad_body", "body.id must be a short string");
                }
            }
            _ => return refuse("unknown_kind", "unknown event kind"),
        }

        let seq: i64 = tx.query_row(
            "SELECT COALESCE(MAX(seq), 0) + 1 FROM events WHERE ws = ?1",
            params![ws],
            |r| r.get(0),
        )?;
        tx.execute(
            "INSERT INTO events (ws, seq, id, pubkey, created_at, kind, body, sig, redacted, msg_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, ?9)",
            params![
                ws,
                seq,
                event.id,
                event.pubkey,
                to_i64(event.created_at),
                event.kind,
                event.body,
                event.sig,
                msg_id
            ],
        )?;
        if let (true, Some(id)) = (redact_earlier, msg_id) {
            // Keep id, key and seq; replace what was said, and drop the
            // signature that no longer matches.
            let gone = serde_json::to_string(&Gone { conv, id, gone: true })
                .unwrap_or_else(|_| r#"{"gone":true}"#.to_string());
            tx.execute(
                "UPDATE events SET body = ?4, sig = NULL, redacted = 1
                 WHERE ws = ?1 AND msg_id = ?2 AND seq < ?3 AND kind IN ('msg.post', 'msg.edit')",
                params![ws, id, seq, gone],
            )?;
        }
        tx.commit()?;

        if redact_earlier {
            // Move the rewrite out of the write-ahead log and into the main
            // file now, so the old text is not left on disk until some later
            // checkpoint. Failing here loses nothing, so it is not an error.
            let _ = self
                .conn
                .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()));
        }
        Ok(Published { seq: to_u64(seq), fresh: true })
    }

    /// Events after `after`, oldest first: at most `limit`, and cut short once
    /// the bodies add up to `max_bytes` (always at least one). The flag says
    /// whether more remain.
    pub fn sync(&self, after: u64, limit: usize, max_bytes: usize) -> rusqlite::Result<(Vec<SeqEvent>, bool)> {
        let mut stmt = self.conn.prepare_cached(
            "SELECT seq, id, pubkey, created_at, kind, body, sig, redacted FROM events
             WHERE ws = ?1 AND seq > ?2 ORDER BY seq LIMIT ?3",
        )?;
        let fetch = i64::try_from(limit).unwrap_or(i64::MAX).saturating_add(1);
        let mut rows = stmt.query(params![self.ws, to_i64(after), fetch])?;
        let mut events = Vec::new();
        let mut bytes = 0usize;
        let mut more = false;
        while let Some(r) = rows.next()? {
            let body: String = r.get(5)?;
            if events.len() >= limit || (!events.is_empty() && bytes + body.len() > max_bytes) {
                more = true;
                break;
            }
            bytes += body.len();
            let redacted: bool = r.get(7)?;
            events.push(SeqEvent {
                seq: to_u64(r.get(0)?),
                event: Event {
                    id: r.get(1)?,
                    pubkey: r.get(2)?,
                    created_at: to_u64(r.get(3)?),
                    kind: r.get(4)?,
                    ws: self.ws.clone(),
                    body,
                    sig: if redacted { None } else { r.get(6)? },
                    redacted,
                },
            });
        }
        Ok((events, more))
    }
}

fn row_to_member(r: &rusqlite::Row<'_>) -> rusqlite::Result<Member> {
    let role: String = r.get(2)?;
    Ok(Member {
        pubkey: r.get(0)?,
        name: r.get(1)?,
        role: Role::parse(&role).unwrap_or(Role::Member),
        joined_at: to_u64(r.get(3)?),
    })
}

fn member_in(conn: &Connection, ws: &str, pubkey: &str) -> rusqlite::Result<Option<Member>> {
    conn.query_row(
        "SELECT pubkey, name, role, joined_at FROM members WHERE ws = ?1 AND pubkey = ?2",
        params![ws, pubkey],
        row_to_member,
    )
    .optional()
}

fn role_in(conn: &Connection, ws: &str, pubkey: &str) -> rusqlite::Result<Option<Role>> {
    let role: Option<String> = conn
        .query_row(
            "SELECT role FROM members WHERE ws = ?1 AND pubkey = ?2",
            params![ws, pubkey],
            |r| r.get(0),
        )
        .optional()?;
    Ok(role.as_deref().and_then(Role::parse))
}

/// `(creator, archived)` of a channel.
fn conv_in(conn: &Connection, ws: &str, conv: &str) -> rusqlite::Result<Option<(String, bool)>> {
    conn.query_row(
        "SELECT creator, archived FROM convs WHERE ws = ?1 AND conv = ?2",
        params![ws, conv],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .optional()
}

/// `(author, conv, deleted)` of a message.
fn message_in(conn: &Connection, ws: &str, id: &str) -> rusqlite::Result<Option<(String, String, bool)>> {
    conn.query_row(
        "SELECT author, conv, deleted FROM messages WHERE ws = ?1 AND id = ?2",
        params![ws, id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )
    .optional()
}

fn insert_member(
    tx: &Transaction<'_>,
    ws: &str,
    pubkey: &str,
    name: &str,
    role: Role,
    now: u64,
) -> rusqlite::Result<()> {
    tx.execute(
        "INSERT INTO members (ws, pubkey, name, role, joined_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![ws, pubkey, name, role.as_str(), to_i64(now)],
    )?;
    Ok(())
}

fn insert_invite(
    tx: &Transaction<'_>,
    ws: &str,
    role: Role,
    uses: u64,
    days: u64,
    created_by: &str,
    now: u64,
) -> rusqlite::Result<NewInvite> {
    let mut raw = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut raw);
    let token = URL_SAFE_NO_PAD.encode(raw);
    raw.fill(0);
    let id = random_hex(8);
    let expires_at = now.saturating_add(days.min(MAX_INVITE_DAYS).saturating_mul(86_400));
    tx.execute(
        "INSERT INTO invites (ws, id, token_hash, role, uses_left, expires_at, created_by, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            ws,
            id,
            sha256_hex(token.as_bytes()),
            role.as_str(),
            to_i64(uses.clamp(1, MAX_INVITE_USES)),
            to_i64(expires_at),
            created_by,
            to_i64(now)
        ],
    )?;
    Ok(NewInvite { id, token, expires_at })
}

#[cfg(test)]
mod tests {
    use super::*;
    use cube_proto::{generate_key, pubkey_hex, sign_event, SigningKey};

    const NOW: u64 = 1_794_460_000;

    struct Fixture {
        _dir: tempfile::TempDir,
        db: Db,
    }

    fn fixture() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::open(&dir.path().join("relay.db"), NOW).unwrap();
        Fixture { _dir: dir, db }
    }

    fn join(db: &mut Db, role: Role, name: &str) -> SigningKey {
        let key = generate_key();
        let invite = match role {
            Role::Owner => db.create_owner_invite(DEFAULT_INVITE_DAYS, NOW).unwrap(),
            role => db.create_invite(role, 1, DEFAULT_INVITE_DAYS, "test", NOW).unwrap(),
        };
        db.claim(&sha256_hex(invite.token.as_bytes()), &pubkey_hex(&key), name, NOW)
            .unwrap();
        key
    }

    fn publish(db: &mut Db, key: &SigningKey, kind: &str, body: serde_json::Value) -> OpResult<Published> {
        let event = sign_event(key, NOW, kind, db.ws(), &body.to_string());
        db.publish(&event, NOW, 600)
    }

    fn code(r: OpResult<Published>) -> &'static str {
        match r {
            Err(OpError::Refused { code, .. }) => code,
            other => panic!("expected a refusal, got {other:?}"),
        }
    }

    #[test]
    fn workspace_id_is_stable_and_file_is_private() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("relay.db");
        let first = Db::open(&path, NOW).unwrap().ws().to_string();
        let second = Db::open(&path, NOW + 5).unwrap().ws().to_string();
        assert_eq!(first, second);
        assert_eq!(first.len(), 32);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
    }

    #[test]
    fn only_the_token_hash_is_stored() {
        let mut f = fixture();
        let invite = f.db.create_invite(Role::Member, 1, 7, "test", NOW).unwrap();
        let dump: Vec<String> = {
            let mut stmt = f.db.conn.prepare("SELECT id || token_hash || role || created_by FROM invites").unwrap();
            let rows = stmt.query_map([], |r| r.get(0)).unwrap();
            rows.collect::<rusqlite::Result<_>>().unwrap()
        };
        assert_eq!(dump.len(), 1);
        assert!(!dump[0].contains(&invite.token));
        assert!(dump[0].contains(&sha256_hex(invite.token.as_bytes())));
        assert_eq!(invite.expires_at, NOW + 7 * 86_400);
    }

    #[test]
    fn claim_checks_uses_and_expiry() {
        let mut f = fixture();
        let invite = f.db.create_invite(Role::Member, 2, 1, "test", NOW).unwrap();
        let hash = sha256_hex(invite.token.as_bytes());
        let a = pubkey_hex(&generate_key());
        let b = pubkey_hex(&generate_key());
        let c = pubkey_hex(&generate_key());

        assert!(f.db.claim("0000", &a, "A", NOW).is_err());
        assert_eq!(f.db.claim(&hash, &a, "A", NOW).unwrap().role, Role::Member);
        // The same key again: refused, and the second use is not spent.
        assert!(f.db.claim(&hash, &a, "A", NOW).is_err());
        assert_eq!(f.db.list_invites(NOW).unwrap()[0].uses_left, 1);
        assert!(f.db.claim(&hash, &b, "B", NOW).is_ok());
        assert!(f.db.claim(&hash, &c, "C", NOW).is_err());
        assert!(f.db.list_invites(NOW).unwrap().is_empty());

        let invite = f.db.create_invite(Role::Member, 1, 1, "test", NOW).unwrap();
        let hash = sha256_hex(invite.token.as_bytes());
        assert!(f.db.claim(&hash, &c, "C", NOW + 86_400).is_err());
        assert!(f.db.claim(&hash, &c, "C", NOW + 86_399).is_ok());
    }

    #[test]
    fn owner_invite_replaces_the_owner() {
        let mut f = fixture();
        let first = join(&mut f.db, Role::Owner, "First");
        let stale = f.db.create_owner_invite(7, NOW).unwrap();
        let fresh = f.db.create_owner_invite(7, NOW).unwrap();
        let second = pubkey_hex(&generate_key());

        // Making a new owner invite cancels the one before it.
        assert!(f.db.claim(&sha256_hex(stale.token.as_bytes()), &second, "Second", NOW).is_err());
        let admin_invite = f.db.create_invite(Role::Admin, 1, 7, &pubkey_hex(&first), NOW).unwrap();
        let m = f.db.claim(&sha256_hex(fresh.token.as_bytes()), &second, "Second", NOW).unwrap();
        assert_eq!(m.role, Role::Owner);
        assert_eq!(f.db.member(&pubkey_hex(&first)).unwrap().unwrap().role, Role::Admin);
        let owners = f.db.members().unwrap().into_iter().filter(|m| m.role == Role::Owner).count();
        assert_eq!(owners, 1);
        // The admin invite the earlier owner made went with the role.
        let third = pubkey_hex(&generate_key());
        assert!(f.db.claim(&sha256_hex(admin_invite.token.as_bytes()), &third, "Third", NOW).is_err());
    }

    #[test]
    fn member_rules() {
        let mut f = fixture();
        let owner = pubkey_hex(&join(&mut f.db, Role::Owner, "Owner"));
        let admin = pubkey_hex(&join(&mut f.db, Role::Admin, "Admin"));
        let admin2 = pubkey_hex(&join(&mut f.db, Role::Admin, "Admin2"));
        let member = pubkey_hex(&join(&mut f.db, Role::Member, "Member"));
        let member2 = pubkey_hex(&join(&mut f.db, Role::Member, "Member2"));

        assert!(f.db.remove_member(&member, &member2).is_err());
        assert!(f.db.remove_member(&admin, &owner).is_err());
        assert!(f.db.remove_member(&admin, &admin2).is_err());
        assert!(f.db.remove_member(&admin, &admin).is_err());
        assert!(f.db.remove_member(&owner, &owner).is_err());
        assert!(f.db.remove_member(&admin, "nobody").is_err());

        assert!(f.db.set_role(&admin, &member, Role::Admin).is_err());
        assert!(f.db.set_role(&owner, &owner, Role::Admin).is_err());
        assert!(f.db.set_role(&owner, &member, Role::Owner).is_err());
        assert!(f.db.set_role(&owner, &member, Role::Admin).is_ok());
        assert_eq!(f.db.member(&member).unwrap().unwrap().role, Role::Admin);

        // An invite made by someone who is then removed or demoted stops working.
        let by_admin = f.db.create_invite(Role::Member, 5, 7, &admin, NOW).unwrap();
        let by_admin2 = f.db.create_invite(Role::Member, 5, 7, &admin2, NOW).unwrap();
        assert!(f.db.remove_member(&admin, &member2).is_ok());
        assert!(f.db.remove_member(&owner, &admin).is_ok());
        assert!(f.db.set_role(&owner, &admin2, Role::Member).is_ok());
        let late = pubkey_hex(&generate_key());
        assert!(f.db.claim(&sha256_hex(by_admin.token.as_bytes()), &late, "Late", NOW).is_err());
        assert!(f.db.claim(&sha256_hex(by_admin2.token.as_bytes()), &late, "Late", NOW).is_err());
        assert!(f.db.member(&admin).unwrap().is_none());

        // Admins revoke member invites only.
        let admin_invite = f.db.create_invite(Role::Admin, 1, 7, &owner, NOW).unwrap();
        let member_invite = f.db.create_invite(Role::Member, 1, 7, &owner, NOW).unwrap();
        assert!(f.db.revoke_invite(&member, &admin_invite.id).is_err());
        assert!(f.db.revoke_invite(&admin2, &member_invite.id).is_err());
        assert!(f.db.revoke_invite(&member, &member_invite.id).is_ok());
        assert!(f.db.revoke_invite(&owner, &admin_invite.id).is_ok());
        assert!(f.db.revoke_invite(&owner, &admin_invite.id).is_err());
    }

    #[test]
    fn sub_agent_offers() {
        let mut f = fixture();
        let ann = join(&mut f.db, Role::Member, "Ann");
        let outsider = generate_key();
        let offer = serde_json::json!({"agent": {"id": "sub-legal", "name": "Legal", "brief": "Reads contracts."}});
        // A member offers a sub-agent with no channel named, and takes the offer back.
        assert!(publish(&mut f.db, &ann, "agent.put", offer.clone()).is_ok());
        assert!(publish(&mut f.db, &ann, "agent.drop", serde_json::json!({"id": "sub-legal"})).is_ok());
        // Not a member, or not shaped like an offer.
        assert_eq!(code(publish(&mut f.db, &outsider, "agent.put", offer)), "not_member");
        assert_eq!(code(publish(&mut f.db, &ann, "agent.put", serde_json::json!({"agent": {"id": "x"}}))), "bad_body");
        assert_eq!(code(publish(&mut f.db, &ann, "agent.put", serde_json::json!({"agent": {"id": "a\nb", "name": "Legal"}}))), "bad_body");
        assert_eq!(code(publish(&mut f.db, &ann, "agent.drop", serde_json::json!({}))), "bad_body");
        // Every other kind still needs its channel.
        assert_eq!(code(publish(&mut f.db, &ann, "msg.post", serde_json::json!({"msg": {"id": "m", "text": "x"}}))), "bad_body");
    }

    #[test]
    fn event_rules() {
        let mut f = fixture();
        let owner = join(&mut f.db, Role::Owner, "Owner");
        let ann = join(&mut f.db, Role::Member, "Ann");
        let bob = join(&mut f.db, Role::Member, "Bob");
        let outsider = generate_key();
        let j = |v: serde_json::Value| v;

        assert_eq!(code(publish(&mut f.db, &outsider, "conv.put", j(serde_json::json!({"conv":"c","name":"C"})))), "not_member");
        assert_eq!(code(publish(&mut f.db, &ann, "msg.post", j(serde_json::json!({"conv":"c","msg":{"id":"m1","text":"x"}})))), "no_conv");

        let first = publish(&mut f.db, &ann, "conv.put", j(serde_json::json!({"conv":"c","name":"C"}))).unwrap();
        assert_eq!(first, Published { seq: 1, fresh: true });
        assert_eq!(code(publish(&mut f.db, &bob, "conv.put", j(serde_json::json!({"conv":"c","name":"Bob's"})))), "forbidden");
        assert!(publish(&mut f.db, &owner, "conv.put", j(serde_json::json!({"conv":"c","name":"Renamed"}))).is_ok());

        assert!(publish(&mut f.db, &bob, "msg.post", j(serde_json::json!({"conv":"c","msg":{"id":"m1","text":"secret"}}))).is_ok());
        assert_eq!(code(publish(&mut f.db, &ann, "msg.post", j(serde_json::json!({"conv":"c","msg":{"id":"m1","text":"again"}})))), "duplicate_msg");
        assert_eq!(code(publish(&mut f.db, &ann, "msg.edit", j(serde_json::json!({"conv":"c","id":"m1","msg":{"text":"hijack"}})))), "forbidden");
        assert_eq!(code(publish(&mut f.db, &owner, "msg.edit", j(serde_json::json!({"conv":"c","id":"m1","msg":{"text":"hijack"}})))), "forbidden");
        assert_eq!(code(publish(&mut f.db, &bob, "msg.edit", j(serde_json::json!({"conv":"other","id":"m1","msg":{"text":"v2"}})))), "wrong_conv");
        assert_eq!(code(publish(&mut f.db, &bob, "msg.edit", j(serde_json::json!({"conv":"c","id":"m1","msg":{"id":"m2","text":"v2"}})))), "bad_body");
        assert_eq!(code(publish(&mut f.db, &bob, "msg.edit", j(serde_json::json!({"conv":"c","id":"nope","msg":{"text":"v2"}})))), "not_found");
        assert!(publish(&mut f.db, &bob, "msg.edit", j(serde_json::json!({"conv":"c","id":"m1","msg":{"id":"m1","text":"v2"}}))).is_ok());

        // The post was rewritten; the edit that replaced it was not.
        let (events, more) = f.db.sync(0, 200, usize::MAX).unwrap();
        assert!(!more);
        assert_eq!(events.iter().map(|e| e.seq).collect::<Vec<_>>(), vec![1, 2, 3, 4]);
        let post = &events[2].event;
        assert!(post.redacted && post.sig.is_none());
        assert_eq!(post.body, r#"{"conv":"c","id":"m1","gone":true}"#);
        assert!(!events[3].event.redacted);
        assert_eq!(cube_proto::verify_event(&events[3].event), Ok(()));

        assert_eq!(code(publish(&mut f.db, &ann, "msg.delete", j(serde_json::json!({"conv":"c","id":"m1"})))), "forbidden");
        assert_eq!(code(publish(&mut f.db, &owner, "msg.delete", j(serde_json::json!({"conv":"x","id":"m1"})))), "wrong_conv");
        assert!(publish(&mut f.db, &owner, "msg.delete", j(serde_json::json!({"conv":"c","id":"m1"}))).is_ok());
        assert_eq!(code(publish(&mut f.db, &bob, "msg.edit", j(serde_json::json!({"conv":"c","id":"m1","msg":{"text":"v3"}})))), "gone");
        assert_eq!(code(publish(&mut f.db, &bob, "msg.delete", j(serde_json::json!({"conv":"c","id":"m1"})))), "gone");

        let (events, _) = f.db.sync(2, 200, usize::MAX).unwrap();
        assert_eq!(events.len(), 3);
        assert!(events[0].event.redacted && events[1].event.redacted);
        assert!(!events[2].event.redacted);
        let stored: String = f.db.conn
            .query_row("SELECT group_concat(body, ' ') FROM events", [], |r| r.get(0))
            .unwrap();
        assert!(!stored.contains("secret") && !stored.contains("v2"));

        // Archiving stops posts and edits, not deletes.
        assert!(publish(&mut f.db, &ann, "msg.post", j(serde_json::json!({"conv":"c","msg":{"id":"m2","text":"keep"}}))).is_ok());
        assert!(publish(&mut f.db, &ann, "conv.put", j(serde_json::json!({"conv":"c","name":"C","archived":true}))).is_ok());
        assert_eq!(code(publish(&mut f.db, &ann, "msg.post", j(serde_json::json!({"conv":"c","msg":{"id":"m3","text":"x"}})))), "archived");
        assert_eq!(code(publish(&mut f.db, &ann, "msg.edit", j(serde_json::json!({"conv":"c","id":"m2","msg":{"text":"x"}})))), "archived");
        assert!(publish(&mut f.db, &ann, "msg.delete", j(serde_json::json!({"conv":"c","id":"m2"}))).is_ok());
        // A rename without `archived` leaves the channel archived.
        assert!(publish(&mut f.db, &ann, "conv.put", j(serde_json::json!({"conv":"c","name":"Still archived"}))).is_ok());
        assert_eq!(code(publish(&mut f.db, &ann, "msg.post", j(serde_json::json!({"conv":"c","msg":{"id":"m4","text":"x"}})))), "archived");
    }

    #[test]
    fn bad_bodies_and_times() {
        let mut f = fixture();
        let ann = join(&mut f.db, Role::Member, "Ann");
        let ws = f.db.ws().to_string();

        for (kind, body) in [
            ("conv.put", "not json"),
            ("conv.put", "[1,2]"),
            ("conv.put", r#"{"name":"C"}"#),
            ("conv.put", r#"{"conv":"","name":"C"}"#),
            ("conv.put", r#"{"conv":5,"name":"C"}"#),
            ("conv.put", r#"{"conv":"c"}"#),
            ("conv.put", r#"{"conv":"c","name":"  "}"#),
            ("conv.put", r#"{"conv":"c","name":"C","archived":"yes"}"#),
            ("msg.post", r#"{"conv":"c"}"#),
            ("msg.post", r#"{"conv":"c","msg":"text"}"#),
            ("msg.post", r#"{"conv":"c","msg":{"text":"no id"}}"#),
            ("msg.post", r#"{"conv":"c","msg":{"id":7}}"#),
            ("msg.edit", r#"{"conv":"c","id":"m"}"#),
            ("msg.delete", r#"{"conv":"c"}"#),
        ] {
            let event = sign_event(&ann, NOW, kind, &ws, body);
            assert_eq!(code(f.db.publish(&event, NOW, 600)), "bad_body", "{kind} {body}");
        }
        let long = "x".repeat(MAX_IDENT_BYTES + 1);
        let event = sign_event(&ann, NOW, "conv.put", &ws, &serde_json::json!({"conv": long, "name": "C"}).to_string());
        assert_eq!(code(f.db.publish(&event, NOW, 600)), "bad_body");

        let event = sign_event(&ann, NOW, "member.add", &ws, r#"{"conv":"c"}"#);
        assert_eq!(code(f.db.publish(&event, NOW, 600)), "unknown_kind");

        let body = r#"{"conv":"c","name":"C"}"#;
        let early = sign_event(&ann, NOW - 601, "conv.put", &ws, body);
        assert_eq!(code(f.db.publish(&early, NOW, 600)), "bad_time");
        let late = sign_event(&ann, NOW + 601, "conv.put", &ws, body);
        assert_eq!(code(f.db.publish(&late, NOW, 600)), "bad_time");
        let edge = sign_event(&ann, NOW - 600, "conv.put", &ws, body);
        assert_eq!(f.db.publish(&edge, NOW, 600).unwrap(), Published { seq: 1, fresh: true });

        // The same id again, even an hour later, is answered with the first seq.
        assert_eq!(f.db.publish(&edge, NOW + 3600, 600).unwrap(), Published { seq: 1, fresh: false });
        assert_eq!(f.db.head().unwrap(), 1);
    }

    #[test]
    fn sync_pages() {
        let mut f = fixture();
        let ann = join(&mut f.db, Role::Member, "Ann");
        publish(&mut f.db, &ann, "conv.put", serde_json::json!({"conv":"c","name":"C"})).unwrap();
        for i in 0..9 {
            publish(&mut f.db, &ann, "msg.post", serde_json::json!({"conv":"c","msg":{"id":format!("m{i}"),"text":"0123456789"}})).unwrap();
        }
        assert_eq!(f.db.head().unwrap(), 10);

        let (page, more) = f.db.sync(0, 4, usize::MAX).unwrap();
        assert_eq!(page.iter().map(|e| e.seq).collect::<Vec<_>>(), vec![1, 2, 3, 4]);
        assert!(more);
        let (page, more) = f.db.sync(8, 4, usize::MAX).unwrap();
        assert_eq!(page.iter().map(|e| e.seq).collect::<Vec<_>>(), vec![9, 10]);
        assert!(!more);
        let (page, more) = f.db.sync(6, 4, usize::MAX).unwrap();
        assert_eq!(page.len(), 4);
        assert!(!more);
        let (page, more) = f.db.sync(10, 4, usize::MAX).unwrap();
        assert!(page.is_empty() && !more);
        let (page, more) = f.db.sync(u64::MAX, 4, usize::MAX).unwrap();
        assert!(page.is_empty() && !more);

        // The byte cap cuts a page short but never returns an empty one.
        let (page, more) = f.db.sync(0, 200, 1).unwrap();
        assert_eq!(page.len(), 1);
        assert!(more);
        let (page, more) = f.db.sync(1, 200, 100).unwrap();
        assert!(page.len() > 1 && page.len() < 9, "{}", page.len());
        assert!(more);
    }
}
