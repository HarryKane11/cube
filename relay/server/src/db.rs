//! Storage: one SQLite file in WAL mode.
//!
//! Every row carries the workspace id and every statement below is
//! parameterised and filters on it. All rules that decide whether something is
//! allowed run inside the same transaction as the change they allow.
//!
//! Who may read a channel is decided here and nowhere else: a channel is
//! public, or the member is in `conv_members`. Every read that leaves the
//! relay (`sync_for`, `head_for`, `audience`) applies that rule in SQL.

use std::collections::HashSet;
use std::fmt;
use std::path::Path;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use cube_proto::Event;
use rand::RngCore;
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::Serialize;
use sha2::{Digest, Sha256};
use tracing::info;

pub const MAX_IDENT_BYTES: usize = 128;
pub const MAX_CONV_NAME_CHARS: usize = 200;
pub const MAX_MEMBER_NAME_CHARS: usize = 64;
pub const MAX_INVITE_USES: u64 = 100;
pub const MAX_INVITE_DAYS: u64 = 30;
pub const DEFAULT_INVITE_DAYS: u64 = 7;
/// `created_by` of an invite made with `cube-relay owner-invite`.
pub const CREATED_BY_CLI: &str = "cli";

/// The schema this relay reads and writes, kept in `PRAGMA user_version`.
/// Version 1 had no per-channel access; its files were never stamped, so a
/// file that has tables and says 0 is a version 1 file.
pub const SCHEMA_VERSION: i64 = 2;

/// Version 2, as a new database is created.
const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS workspace (
    ws              TEXT PRIMARY KEY,
    created_at      INTEGER NOT NULL,
    member_invites  INTEGER NOT NULL DEFAULT 1
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
    conv        TEXT,
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
    conv        TEXT,
    target      TEXT,
    PRIMARY KEY (ws, seq),
    UNIQUE (ws, id)
);
CREATE INDEX IF NOT EXISTS events_by_msg ON events (ws, msg_id) WHERE msg_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS events_by_conv ON events (ws, conv, seq);
CREATE TABLE IF NOT EXISTS convs (
    ws          TEXT NOT NULL,
    conv        TEXT NOT NULL,
    creator     TEXT NOT NULL,
    archived    INTEGER NOT NULL DEFAULT 0,
    private     INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (ws, conv)
);
CREATE TABLE IF NOT EXISTS conv_members (
    ws          TEXT NOT NULL,
    conv        TEXT NOT NULL,
    pubkey      TEXT NOT NULL,
    added_by    TEXT NOT NULL,
    added_at    INTEGER NOT NULL,
    PRIMARY KEY (ws, conv, pubkey)
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

/// Version 1 to 2, before the channel of each event is filled in.
const MIGRATE_1_TO_2: &str = "
ALTER TABLE workspace ADD COLUMN member_invites INTEGER NOT NULL DEFAULT 1;
ALTER TABLE convs ADD COLUMN private INTEGER NOT NULL DEFAULT 0;
ALTER TABLE invites ADD COLUMN conv TEXT;
ALTER TABLE events ADD COLUMN conv TEXT;
ALTER TABLE events ADD COLUMN target TEXT;
CREATE TABLE conv_members (
    ws          TEXT NOT NULL,
    conv        TEXT NOT NULL,
    pubkey      TEXT NOT NULL,
    added_by    TEXT NOT NULL,
    added_at    INTEGER NOT NULL,
    PRIMARY KEY (ws, conv, pubkey)
);
";

/// True when the member bound to `?2` may read the channel of event row `e`:
/// the event is of a kind that has no channel, the channel is public, or the
/// member is in it. Anything else is readable by nobody: a channel with no
/// `convs` row, and a row of a channel kind that names no channel (which only
/// a relay older than this schema could have written).
const ROW_READABLE: &str = "((e.conv IS NULL AND e.kind IN ('agent.put', 'agent.drop'))
    OR EXISTS (SELECT 1 FROM convs c WHERE c.ws = e.ws AND c.conv = e.conv AND c.private = 0)
    OR EXISTS (SELECT 1 FROM conv_members m WHERE m.ws = e.ws AND m.conv = e.conv AND m.pubkey = ?2))";

/// What a member is served: what they may read, and the event that removed
/// them from a channel, so their app learns that it happened.
const ROW_VISIBLE: &str = "((e.conv IS NULL AND e.kind IN ('agent.put', 'agent.drop'))
    OR EXISTS (SELECT 1 FROM convs c WHERE c.ws = e.ws AND c.conv = e.conv AND c.private = 0)
    OR EXISTS (SELECT 1 FROM conv_members m WHERE m.ws = e.ws AND m.conv = e.conv AND m.pubkey = ?2)
    OR (e.kind = 'conv.remove' AND e.target = ?2))";

const EVENT_COLUMNS: &str = "e.seq, e.id, e.pubkey, e.created_at, e.kind, e.body, e.sig, e.redacted";

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
    /// The channel the claimer is put in, if any. Left out for a viewer who
    /// may not read that channel.
    pub conv: Option<String>,
}

/// One row of a channel's member list.
#[derive(Clone, Debug, Serialize)]
pub struct ConvMember {
    pub pubkey: String,
    pub added_by: String,
    pub added_at: u64,
}

/// A channel's member list, as shown to someone who may read the channel.
pub struct ConvMembers {
    pub private: bool,
    pub members: Vec<ConvMember>,
}

/// One answer to `sync`.
pub struct SyncPage {
    pub events: Vec<SeqEvent>,
    /// Whether more rows the member may see remain after this page.
    pub more: bool,
    /// What to pass as `after` next: the last seq of this page, or the
    /// member's visible head when the page is empty.
    pub next: u64,
}

/// The members an accepted event is passed on to.
pub enum Audience {
    Everyone,
    Only(HashSet<String>),
}

/// Which rows a page of events is taken from.
enum Scope<'a> {
    /// Everything `reader` is served.
    Reader(&'a str),
    /// One channel, if `reader` may read it.
    ReaderConv(&'a str, &'a str),
    /// Every row, whoever may read it. Tests only: nothing a member is sent
    /// may come from here.
    #[cfg(test)]
    All,
}

/// Why the database could not be opened.
#[derive(Debug)]
pub enum OpenError {
    Sqlite(rusqlite::Error),
    /// The file holds a schema this relay cannot serve; the text says why.
    Schema(String),
}

impl From<rusqlite::Error> for OpenError {
    fn from(e: rusqlite::Error) -> Self {
        OpenError::Sqlite(e)
    }
}

impl fmt::Display for OpenError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            OpenError::Sqlite(e) => write!(f, "database error: {e}"),
            OpenError::Schema(why) => f.write_str(why),
        }
    }
}

impl std::error::Error for OpenError {}

/// What an invite grants: a role, how often and how long it can be claimed,
/// and optionally a channel the claimer is put in.
#[derive(Clone, Copy)]
pub struct InviteTerms<'a> {
    pub role: Role,
    pub uses: u64,
    pub days: u64,
    pub conv: Option<&'a str>,
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

/// The one answer for a channel that does not exist and for a private channel
/// the caller is not in, so the two cannot be told apart.
fn no_conv<T>() -> OpResult<T> {
    refuse("no_conv", "the channel does not exist")
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
pub fn valid_ident(s: &str) -> bool {
    !s.is_empty() && s.len() <= MAX_IDENT_BYTES && !s.chars().any(char::is_control)
}

/// A public key as members are named: 32 bytes of lower-case hex.
pub fn is_pubkey(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
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

/// The kinds that are about a person's own cube and belong to no channel.
/// `ROW_READABLE` and `ROW_VISIBLE` name the same two.
fn without_channel(kind: &str) -> bool {
    matches!(kind, "agent.put" | "agent.drop")
}

/// An optional true/false field; `Err` when it is present and something else.
fn bool_field(obj: &serde_json::Map<String, serde_json::Value>, key: &str) -> Result<Option<bool>, ()> {
    match obj.get(key) {
        None => Ok(None),
        Some(serde_json::Value::Bool(b)) => Ok(Some(*b)),
        Some(_) => Err(()),
    }
}

pub struct Db {
    conn: Connection,
    ws: String,
}

impl Db {
    /// Opens (or creates) the database. A new file is created readable by its
    /// owner only, and a workspace id is made on first start.
    ///
    /// A version 1 file is brought to version 2 here, in the same transaction
    /// that reads the workspace id: either all of it happens or the file is
    /// left as it was and the error says why.
    pub fn open(path: &Path, now: u64) -> Result<Db, OpenError> {
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
        let version: i64 = tx.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        let has_tables: bool = tx.query_row(
            "SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'workspace')",
            [],
            |r| r.get(0),
        )?;
        match (version, has_tables) {
            (0, false) => {
                tx.execute_batch(SCHEMA)?;
                tx.pragma_update(None, "user_version", SCHEMA_VERSION)?;
            }
            (0 | 1, true) => {
                let rows = migrate_1_to_2(&tx, now).map_err(|e| {
                    OpenError::Schema(format!(
                        "cannot bring {} from schema version 1 to {SCHEMA_VERSION}; the file was left unchanged: {e}",
                        path.display()
                    ))
                })?;
                info!(events = rows, "database migrated from schema version 1 to {SCHEMA_VERSION}");
            }
            (SCHEMA_VERSION, true) => {}
            (version, _) => {
                return Err(OpenError::Schema(format!(
                    "{} has schema version {version}, and this relay reads version {SCHEMA_VERSION}; \
                     it was written by another version of cube-relay or is not a relay database",
                    path.display()
                )))
            }
        }
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

    /// The highest sequence number `reader` is served, 0 when there is none.
    /// Sequence numbers of channels they are not in are not counted, so the
    /// number says nothing about those.
    pub fn head_for(&self, reader: &str) -> rusqlite::Result<u64> {
        let mut stmt = self.conn.prepare_cached(&format!(
            "SELECT e.seq FROM events e WHERE e.ws = ?1 AND {ROW_VISIBLE} ORDER BY e.seq DESC LIMIT 1"
        ))?;
        let head: Option<i64> = stmt.query_row(params![self.ws, reader], |r| r.get(0)).optional()?;
        Ok(head.map_or(0, to_u64))
    }

    /// Whether plain members may make invites to channels they are in.
    pub fn member_invites(&self) -> rusqlite::Result<bool> {
        self.conn.query_row(
            "SELECT member_invites FROM workspace WHERE ws = ?1",
            params![self.ws],
            |r| r.get(0),
        )
    }

    /// Turns member invites on or off. Only the owner may. Turning them off
    /// also cancels the invites plain members have outstanding.
    pub fn set_member_invites(&mut self, caller: &str, on: bool) -> OpResult<()> {
        let tx = self.conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if role_in(&tx, &self.ws, caller)? != Some(Role::Owner) {
            return refuse("forbidden", "only the owner changes settings");
        }
        tx.execute(
            "UPDATE workspace SET member_invites = ?2 WHERE ws = ?1",
            params![self.ws, on],
        )?;
        if !on {
            tx.execute(
                "DELETE FROM invites WHERE ws = ?1 AND created_by IN
                   (SELECT pubkey FROM members WHERE ws = ?1 AND role = 'member')",
                params![self.ws],
            )?;
        }
        tx.commit()?;
        Ok(())
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

    /// Makes an invite and stores only the SHA-256 of its token. Nothing is
    /// checked about `created_by`; requests from members go through
    /// [`Db::create_invite_as`].
    pub fn create_invite(
        &mut self,
        role: Role,
        uses: u64,
        days: u64,
        created_by: &str,
        now: u64,
    ) -> rusqlite::Result<NewInvite> {
        let tx = self.conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let terms = InviteTerms { role, uses, days, conv: None };
        let invite = insert_invite(&tx, &self.ws, terms, created_by, now)?;
        tx.commit()?;
        Ok(invite)
    }

    /// Makes an invite for `caller` if their role allows it.
    ///
    /// The owner makes any invite and an admin makes member invites, each
    /// optionally for a channel they can read: whoever claims it is put in
    /// that channel. A plain member may only make a member invite for a
    /// channel they can read, and only while the workspace allows it.
    pub fn create_invite_as(&mut self, caller: &str, terms: InviteTerms<'_>, now: u64) -> OpResult<NewInvite> {
        let InviteTerms { role, conv, .. } = terms;
        const FORBIDDEN: OpError =
            OpError::Refused { code: "forbidden", message: "not allowed to make this invite" };
        let tx = self.conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let Some(caller_role) = role_in(&tx, &self.ws, caller)? else {
            return refuse("not_member", "not a member");
        };
        let readable = match conv {
            Some(conv) => readable_conv(&tx, &self.ws, conv, caller)?.is_some(),
            None => false,
        };
        match caller_role {
            Role::Owner | Role::Admin => {
                if role == Role::Owner || (caller_role == Role::Admin && role != Role::Member) {
                    return Err(FORBIDDEN);
                }
                if conv.is_some() && !readable {
                    return no_conv();
                }
            }
            Role::Member => {
                let allowed: bool = tx.query_row(
                    "SELECT member_invites FROM workspace WHERE ws = ?1",
                    params![self.ws],
                    |r| r.get(0),
                )?;
                // One answer for every reason, so it does not say whether the channel exists.
                if !allowed || role != Role::Member || !readable {
                    return Err(FORBIDDEN);
                }
            }
        }
        let invite = insert_invite(&tx, &self.ws, terms, caller, now)?;
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
        let terms = InviteTerms { role: Role::Owner, uses: 1, days, conv: None };
        let invite = insert_invite(&tx, &self.ws, terms, CREATED_BY_CLI, now)?;
        tx.commit()?;
        Ok(invite)
    }

    /// The invites `caller` may see that can still be claimed: all of them
    /// for the owner and admins, their own for a member. Never returns a token
    /// or its hash, and names an invite's channel only to someone who may
    /// read that channel.
    pub fn list_invites_for(&mut self, caller: &str, now: u64) -> OpResult<Vec<InviteInfo>> {
        let tx = self.conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let Some(role) = role_in(&tx, &self.ws, caller)? else {
            return refuse("not_member", "not a member");
        };
        tx.execute(
            "DELETE FROM invites WHERE ws = ?1 AND (expires_at <= ?2 OR uses_left <= 0)",
            params![self.ws, to_i64(now)],
        )?;
        let invites = {
            let mut stmt = tx.prepare_cached(
                "SELECT i.id, i.role, i.uses_left, i.expires_at, i.created_by,
                        CASE WHEN EXISTS (SELECT 1 FROM convs c
                                          WHERE c.ws = i.ws AND c.conv = i.conv AND c.private = 0)
                               OR EXISTS (SELECT 1 FROM conv_members m
                                          WHERE m.ws = i.ws AND m.conv = i.conv AND m.pubkey = ?2)
                             THEN i.conv END
                 FROM invites i
                 WHERE i.ws = ?1 AND (?3 OR i.created_by = ?2) ORDER BY i.created_at, i.id",
            )?;
            let rows = stmt.query_map(params![self.ws, caller, role.is_staff()], |r| {
                let role: String = r.get(1)?;
                Ok(InviteInfo {
                    id: r.get(0)?,
                    role: Role::parse(&role).unwrap_or(Role::Member),
                    uses_left: to_u64(r.get(2)?),
                    expires_at: to_u64(r.get(3)?),
                    created_by: r.get(4)?,
                    conv: r.get(5)?,
                })
            })?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        tx.commit()?;
        Ok(invites)
    }

    /// Revokes an invite. The owner revokes any, an admin those that grant
    /// `member`, a member only the ones they made.
    pub fn revoke_invite(&mut self, caller: &str, id: &str) -> OpResult<()> {
        let tx = self.conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let Some(caller_role) = role_in(&tx, &self.ws, caller)? else {
            return refuse("forbidden", "only members manage invites");
        };
        let found: Option<(String, String)> = tx
            .query_row(
                "SELECT role, created_by FROM invites WHERE ws = ?1 AND id = ?2",
                params![self.ws, id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let Some((granted, created_by)) = found else {
            return refuse("not_found", "no such invite");
        };
        match caller_role {
            Role::Owner => {}
            Role::Admin if granted == "member" => {}
            Role::Admin => return refuse("forbidden", "only the owner can revoke this invite"),
            Role::Member if created_by == caller => {}
            Role::Member => return refuse("forbidden", "members revoke only the invites they made"),
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
        type InviteRow = (String, String, i64, i64, Option<String>, String);
        let invite: Option<InviteRow> = tx
            .query_row(
                "SELECT id, role, uses_left, expires_at, conv, created_by FROM invites
                 WHERE ws = ?1 AND token_hash = ?2",
                params![self.ws, token_hash],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
            )
            .optional()?;
        let Some((invite_id, role, uses_left, expires_at, invite_conv, invited_by)) = invite else {
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
            (role, None) => {
                insert_member(&tx, &self.ws, pubkey, name, role, now)?;
                // An invite to a channel puts the newcomer in it, unless the
                // channel was archived since the invite was made.
                if let Some(conv) = invite_conv.as_deref() {
                    if conv_in(&tx, &self.ws, conv)?.is_some_and(|c| !c.archived) {
                        add_to_conv(&tx, &self.ws, conv, pubkey, &invited_by, now)?;
                    }
                }
            }
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
    /// can remove members only. Invites the removed member made stop working,
    /// and they are taken out of every channel's member list, so coming back
    /// with a new invite does not bring private channels back.
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
            "DELETE FROM conv_members WHERE ws = ?1 AND pubkey = ?2",
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
            // What they could invite to as an admin is more than a member may, so
            // the invites they made go.
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
        let about_agent = without_channel(&event.kind);
        let conv = match str_field(obj, "conv").filter(|c| valid_ident(c)) {
            Some(conv) => conv,
            None if about_agent => "",
            None => return refuse("bad_body", "body.conv must be a short string"),
        };

        // The message whose earlier versions this event replaces, if any.
        let mut msg_id: Option<&str> = None;
        let mut redact_earlier = false;
        // The member a `conv.add` or `conv.remove` names.
        let mut target: Option<&str> = None;

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
                let Ok(archived) = bool_field(obj, "archived") else {
                    return refuse("bad_body", "body.archived must be true or false");
                };
                let Ok(private) = bool_field(obj, "private") else {
                    return refuse("bad_body", "body.private must be true or false");
                };
                match conv_in(&tx, &ws, conv)? {
                    None => {
                        tx.execute(
                            "INSERT INTO convs (ws, conv, creator, archived, private) VALUES (?1, ?2, ?3, ?4, ?5)",
                            params![ws, conv, event.pubkey, archived.unwrap_or(false), private.unwrap_or(false)],
                        )?;
                        add_to_conv(&tx, &ws, conv, &event.pubkey, &event.pubkey, now)?;
                    }
                    Some(found) => {
                        // An owner or admin who is not in a private channel is told
                        // what anyone else outside it is told.
                        if found.private && !in_conv(&tx, &ws, conv, &event.pubkey)? {
                            return no_conv();
                        }
                        if found.creator != event.pubkey && !role.is_staff() {
                            return refuse("forbidden", "only the channel's creator or an admin can change it");
                        }
                        if private.is_some_and(|p| p != found.private) {
                            return refuse("visibility_fixed", "a channel stays public or private as it was created");
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
                let Some(found) = readable_conv(&tx, &ws, conv, &event.pubkey)? else {
                    return no_conv();
                };
                if found.archived {
                    return refuse("archived", "the channel is archived");
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
                // Before anything is said about the message: whether it exists
                // is not for someone who cannot read the channel.
                let Some(found) = readable_conv(&tx, &ws, conv, &event.pubkey)? else {
                    return no_conv();
                };
                let Some((author, posted_in, deleted)) = message_for(&tx, &ws, id, &event.pubkey)? else {
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
                if found.archived {
                    return refuse("archived", "the channel is archived");
                }
                msg_id = Some(id);
                redact_earlier = true;
            }
            "msg.delete" => {
                let Some(id) = str_field(obj, "id").filter(|id| valid_ident(id)) else {
                    return refuse("bad_body", "body.id must be a short string");
                };
                if readable_conv(&tx, &ws, conv, &event.pubkey)?.is_none() {
                    return no_conv();
                }
                let Some((author, posted_in, deleted)) = message_for(&tx, &ws, id, &event.pubkey)? else {
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
            // Anyone who can read a channel can bring a teammate into it. For a
            // public channel this only records who is in it; everyone reads it anyway.
            "conv.add" => {
                let Some(member) = str_field(obj, "member").filter(|m| is_pubkey(m)) else {
                    return refuse("bad_body", "body.member must be a public key");
                };
                if readable_conv(&tx, &ws, conv, &event.pubkey)?.is_none() {
                    return no_conv();
                }
                if role_in(&tx, &ws, member)?.is_none() {
                    return refuse("not_found", "no such member");
                }
                // Someone already in stays as they were added.
                add_to_conv(&tx, &ws, conv, member, &event.pubkey, now)?;
                target = Some(member);
            }
            "conv.remove" => {
                let Some(member) = str_field(obj, "member").filter(|m| is_pubkey(m)) else {
                    return refuse("bad_body", "body.member must be a public key");
                };
                let Some(found) = readable_conv(&tx, &ws, conv, &event.pubkey)? else {
                    return no_conv();
                };
                if member != event.pubkey {
                    if found.creator != event.pubkey && !role.is_staff() {
                        return refuse(
                            "forbidden",
                            "only the channel's creator or an admin can remove someone else from it",
                        );
                    }
                    if member == found.creator {
                        return refuse("forbidden", "the channel's creator can only leave by themselves");
                    }
                }
                let removed = tx.execute(
                    "DELETE FROM conv_members WHERE ws = ?1 AND conv = ?2 AND pubkey = ?3",
                    params![ws, conv, member],
                )?;
                if removed == 0 {
                    return refuse("not_found", "not in this channel");
                }
                // An invite they made to this channel would let someone in after they are out.
                tx.execute(
                    "DELETE FROM invites WHERE ws = ?1 AND conv = ?2 AND created_by = ?3",
                    params![ws, conv, member],
                )?;
                target = Some(member);
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
        // Events about a person's own cube belong to no channel and go to everyone.
        let conv_column = (!about_agent).then_some(conv);
        tx.execute(
            "INSERT INTO events (ws, seq, id, pubkey, created_at, kind, body, sig, redacted, msg_id, conv, target)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, ?9, ?10, ?11)",
            params![
                ws,
                seq,
                event.id,
                event.pubkey,
                to_i64(event.created_at),
                event.kind,
                event.body,
                event.sig,
                msg_id,
                conv_column,
                target
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

    /// The members an accepted event is passed on to, read after the event
    /// was applied: everyone for an event without a channel or in a public
    /// one; otherwise the channel's members as they now are (so someone just
    /// added gets the event that added them), and for `conv.remove` the member
    /// who was removed.
    pub fn audience(&self, seq: u64) -> rusqlite::Result<Audience> {
        let row: Option<(Option<String>, String, Option<String>)> = self
            .conn
            .query_row(
                "SELECT conv, kind, target FROM events WHERE ws = ?1 AND seq = ?2",
                params![self.ws, to_i64(seq)],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        let Some((conv, kind, target)) = row else {
            return Ok(Audience::Only(HashSet::new()));
        };
        let Some(conv) = conv else {
            return Ok(if without_channel(&kind) { Audience::Everyone } else { Audience::Only(HashSet::new()) });
        };
        match conv_in(&self.conn, &self.ws, &conv)? {
            Some(found) if !found.private => return Ok(Audience::Everyone),
            _ => {}
        }
        let mut stmt = self
            .conn
            .prepare_cached("SELECT pubkey FROM conv_members WHERE ws = ?1 AND conv = ?2")?;
        let rows = stmt.query_map(params![self.ws, conv], |r| r.get::<_, String>(0))?;
        let mut members = rows.collect::<rusqlite::Result<HashSet<String>>>()?;
        if let (true, Some(target)) = (kind == "conv.remove", target) {
            members.insert(target);
        }
        Ok(Audience::Only(members))
    }

    /// Who is in a channel, for someone who may read it. For a public channel
    /// the list is its creator and whoever was added, not who can read it.
    pub fn conv_members(&self, caller: &str, conv: &str) -> OpResult<ConvMembers> {
        let Some(found) = readable_conv(&self.conn, &self.ws, conv, caller)? else {
            return no_conv();
        };
        let mut stmt = self.conn.prepare_cached(
            "SELECT pubkey, added_by, added_at FROM conv_members
             WHERE ws = ?1 AND conv = ?2 ORDER BY added_at, rowid",
        )?;
        let rows = stmt.query_map(params![self.ws, conv], |r| {
            Ok(ConvMember { pubkey: r.get(0)?, added_by: r.get(1)?, added_at: to_u64(r.get(2)?) })
        })?;
        let members = rows.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(ConvMembers { private: found.private, members })
    }

    /// One page of what `reader` is served after `after`, oldest first: at
    /// most `limit` events, cut short once the bodies add up to `max_bytes`
    /// (always at least one).
    ///
    /// Without `conv`: every event they may read, and the `conv.remove` events
    /// that took them out of a channel. With `conv`: that channel only, and
    /// nothing at all if they may not read it.
    ///
    /// Rows are left out by the query, before its limit, so a long run of
    /// events in channels the reader is not in costs them no empty pages.
    pub fn sync_for(
        &self,
        reader: &str,
        after: u64,
        conv: Option<&str>,
        limit: usize,
        max_bytes: usize,
    ) -> rusqlite::Result<SyncPage> {
        let scope = match conv {
            Some(conv) => Scope::ReaderConv(reader, conv),
            None => Scope::Reader(reader),
        };
        let (events, more) = self.events_after(scope, after, limit, max_bytes)?;
        let next = match events.last() {
            Some(last) => last.seq,
            None => self.head_for(reader)?,
        };
        Ok(SyncPage { events, more, next })
    }

    fn events_after(
        &self,
        scope: Scope<'_>,
        after: u64,
        limit: usize,
        max_bytes: usize,
    ) -> rusqlite::Result<(Vec<SeqEvent>, bool)> {
        let fetch = i64::try_from(limit).unwrap_or(i64::MAX).saturating_add(1);
        let after = to_i64(after);
        // In every form `?1` is the workspace and `?2` the reader.
        let mut stmt;
        let mut rows = match scope {
            Scope::Reader(reader) => {
                stmt = self.conn.prepare_cached(&format!(
                    "SELECT {EVENT_COLUMNS} FROM events e
                     WHERE e.ws = ?1 AND e.seq > ?3 AND {ROW_VISIBLE} ORDER BY e.seq LIMIT ?4"
                ))?;
                stmt.query(params![self.ws, reader, after, fetch])?
            }
            Scope::ReaderConv(reader, conv) => {
                stmt = self.conn.prepare_cached(&format!(
                    "SELECT {EVENT_COLUMNS} FROM events e
                     WHERE e.ws = ?1 AND e.conv = ?5 AND e.seq > ?3 AND {ROW_READABLE}
                     ORDER BY e.seq LIMIT ?4"
                ))?;
                stmt.query(params![self.ws, reader, after, fetch, conv])?
            }
            #[cfg(test)]
            Scope::All => {
                stmt = self.conn.prepare_cached(&format!(
                    "SELECT {EVENT_COLUMNS} FROM events e
                     WHERE e.ws = ?1 AND e.seq > ?2 ORDER BY e.seq LIMIT ?3"
                ))?;
                stmt.query(params![self.ws, after, fetch])?
            }
        };
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

/// Brings a version 1 database to version 2 inside the caller's transaction
/// and returns how many event rows it went through.
///
/// Every channel that exists becomes a public one with its creator as its
/// first member, and every event row is given the channel its body names. A
/// row that should name a channel and does not stops the migration: stored
/// with no channel it would be served to everyone.
fn migrate_1_to_2(tx: &Transaction<'_>, now: u64) -> Result<usize, OpenError> {
    tx.execute_batch(MIGRATE_1_TO_2)?;

    let mut seen = 0usize;
    let mut last_rowid = 0i64;
    loop {
        let batch: Vec<(i64, i64, String, String)> = {
            let mut stmt = tx.prepare_cached(
                "SELECT rowid, seq, kind, body FROM events WHERE rowid > ?1 ORDER BY rowid LIMIT 500",
            )?;
            let rows = stmt.query_map(params![last_rowid], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?;
            rows.collect::<rusqlite::Result<_>>()?
        };
        if batch.is_empty() {
            break;
        }
        for (rowid, seq, kind, body) in &batch {
            last_rowid = *rowid;
            seen += 1;
            if without_channel(kind) {
                continue;
            }
            let parsed: Option<serde_json::Value> = serde_json::from_str(body).ok();
            let conv = parsed
                .as_ref()
                .and_then(serde_json::Value::as_object)
                .and_then(|obj| str_field(obj, "conv"))
                .filter(|conv| valid_ident(conv));
            let Some(conv) = conv else {
                return Err(OpenError::Schema(format!(
                    "event {seq} ({kind}) has a body that does not name its channel"
                )));
            };
            tx.execute("UPDATE events SET conv = ?1 WHERE rowid = ?2", params![conv, rowid])?;
        }
    }
    tx.execute_batch("CREATE INDEX events_by_conv ON events (ws, conv, seq);")?;

    // The creator of each channel, if still a member, is its first member,
    // dated by the channel's first event.
    tx.execute(
        "INSERT INTO conv_members (ws, conv, pubkey, added_by, added_at)
         SELECT c.ws, c.conv, c.creator, c.creator,
                COALESCE((SELECT e.created_at FROM events e
                          WHERE e.ws = c.ws AND e.conv = c.conv ORDER BY e.seq LIMIT 1), ?1)
         FROM convs c
         WHERE EXISTS (SELECT 1 FROM members m WHERE m.ws = c.ws AND m.pubkey = c.creator)",
        params![to_i64(now)],
    )?;
    tx.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    Ok(seen)
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

/// A channel as the rules need it.
struct ConvRow {
    creator: String,
    archived: bool,
    private: bool,
}

fn conv_in(conn: &Connection, ws: &str, conv: &str) -> rusqlite::Result<Option<ConvRow>> {
    conn.query_row(
        "SELECT creator, archived, private FROM convs WHERE ws = ?1 AND conv = ?2",
        params![ws, conv],
        |r| Ok(ConvRow { creator: r.get(0)?, archived: r.get(1)?, private: r.get(2)? }),
    )
    .optional()
}

/// Whether `pubkey` is in the channel's member list.
fn in_conv(conn: &Connection, ws: &str, conv: &str, pubkey: &str) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM conv_members WHERE ws = ?1 AND conv = ?2 AND pubkey = ?3)",
        params![ws, conv, pubkey],
        |r| r.get(0),
    )
}

/// The channel, if it exists and `reader` may read it: it is public, or they
/// are in it. A private channel they are not in comes back exactly like one
/// that does not exist, whatever their role.
fn readable_conv(conn: &Connection, ws: &str, conv: &str, reader: &str) -> rusqlite::Result<Option<ConvRow>> {
    match conv_in(conn, ws, conv)? {
        Some(found) if !found.private || in_conv(conn, ws, conv, reader)? => Ok(Some(found)),
        _ => Ok(None),
    }
}

/// Puts a member in a channel; someone already in it is left as they were.
fn add_to_conv(
    conn: &Connection,
    ws: &str,
    conv: &str,
    pubkey: &str,
    added_by: &str,
    now: u64,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT OR IGNORE INTO conv_members (ws, conv, pubkey, added_by, added_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![ws, conv, pubkey, added_by, to_i64(now)],
    )?;
    Ok(())
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

/// Like [`message_in`], but a message in a private channel `reader` is not in
/// comes back as if it did not exist.
fn message_for(
    conn: &Connection,
    ws: &str,
    id: &str,
    reader: &str,
) -> rusqlite::Result<Option<(String, String, bool)>> {
    let Some(found) = message_in(conn, ws, id)? else {
        return Ok(None);
    };
    if readable_conv(conn, ws, &found.1, reader)?.is_none() {
        return Ok(None);
    }
    Ok(Some(found))
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
    terms: InviteTerms<'_>,
    created_by: &str,
    now: u64,
) -> rusqlite::Result<NewInvite> {
    let InviteTerms { role, uses, days, conv } = terms;
    let mut raw = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut raw);
    let token = URL_SAFE_NO_PAD.encode(raw);
    raw.fill(0);
    let id = random_hex(8);
    let expires_at = now.saturating_add(days.min(MAX_INVITE_DAYS).saturating_mul(86_400));
    tx.execute(
        "INSERT INTO invites (ws, id, token_hash, role, uses_left, expires_at, created_by, created_at, conv)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            ws,
            id,
            sha256_hex(token.as_bytes()),
            role.as_str(),
            to_i64(uses.clamp(1, MAX_INVITE_USES)),
            to_i64(expires_at),
            created_by,
            to_i64(now),
            conv
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

    /// What the tests look at without being a member: the whole log and every
    /// invite. The relay itself has no such reads.
    impl Db {
        fn head(&self) -> rusqlite::Result<u64> {
            let head: i64 = self.conn.query_row(
                "SELECT COALESCE(MAX(seq), 0) FROM events WHERE ws = ?1",
                params![self.ws],
                |r| r.get(0),
            )?;
            Ok(to_u64(head))
        }

        fn sync(&self, after: u64, limit: usize, max_bytes: usize) -> rusqlite::Result<(Vec<SeqEvent>, bool)> {
            self.events_after(Scope::All, after, limit, max_bytes)
        }

        fn list_invites(&mut self, now: u64) -> rusqlite::Result<Vec<InviteInfo>> {
            self.conn.execute(
                "DELETE FROM invites WHERE ws = ?1 AND (expires_at <= ?2 OR uses_left <= 0)",
                params![self.ws, to_i64(now)],
            )?;
            let mut stmt = self.conn.prepare(
                "SELECT id, role, uses_left, expires_at, created_by, conv FROM invites
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
                    conv: r.get(5)?,
                })
            })?;
            rows.collect()
        }
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
        // A channel that does not exist is answered before the message is looked at.
        assert_eq!(code(publish(&mut f.db, &bob, "msg.edit", j(serde_json::json!({"conv":"other","id":"m1","msg":{"text":"v2"}})))), "no_conv");
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
        assert_eq!(code(publish(&mut f.db, &owner, "msg.delete", j(serde_json::json!({"conv":"x","id":"m1"})))), "no_conv");
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

    // ---- per-channel access ----------------------------------------------------------

    fn pk(key: &SigningKey) -> String {
        pubkey_hex(key)
    }

    fn post(db: &mut Db, key: &SigningKey, conv: &str, id: &str) -> OpResult<Published> {
        publish(db, key, "msg.post", serde_json::json!({"conv": conv, "msg": {"id": id, "text": "x"}}))
    }

    fn seqs(page: &SyncPage) -> Vec<u64> {
        page.events.iter().map(|e| e.seq).collect()
    }

    #[test]
    fn a_private_channel_does_not_exist_for_those_outside_it() {
        let mut f = fixture();
        let owner = join(&mut f.db, Role::Owner, "Owner");
        let ann = join(&mut f.db, Role::Member, "Ann");
        let bob = join(&mut f.db, Role::Member, "Bob");
        let json = |v: serde_json::Value| v;

        publish(&mut f.db, &ann, "conv.put", json(serde_json::json!({"conv":"pub","name":"Public"}))).unwrap();
        publish(&mut f.db, &ann, "conv.put", json(serde_json::json!({"conv":"p","name":"Private","private":true}))).unwrap();
        post(&mut f.db, &ann, "p", "m1").unwrap();
        post(&mut f.db, &bob, "pub", "b1").unwrap();

        // The same answer for an owner, a member, and a channel nobody made.
        for outsider in [&owner, &bob] {
            for conv in ["p", "nowhere"] {
                assert_eq!(code(post(&mut f.db, outsider, conv, "m9")), "no_conv");
                // With an id that exists and one that does not: the message is not looked at.
                for id in ["m1", "nope"] {
                    let edit = serde_json::json!({"conv": conv, "id": id, "msg": {"text": "y"}});
                    assert_eq!(code(publish(&mut f.db, outsider, "msg.edit", edit)), "no_conv");
                    let delete = serde_json::json!({"conv": conv, "id": id});
                    assert_eq!(code(publish(&mut f.db, outsider, "msg.delete", delete)), "no_conv");
                }
                let add = serde_json::json!({"conv": conv, "member": pk(outsider)});
                assert_eq!(code(publish(&mut f.db, outsider, "conv.add", add.clone())), "no_conv");
                assert_eq!(code(publish(&mut f.db, outsider, "conv.remove", add)), "no_conv");
            }
            let rename = serde_json::json!({"conv": "p", "name": "Mine now", "archived": true});
            assert_eq!(code(publish(&mut f.db, outsider, "conv.put", rename)), "no_conv");
            assert!(matches!(f.db.conv_members(&pk(outsider), "p"), Err(OpError::Refused { code: "no_conv", .. })));
            assert!(matches!(f.db.conv_members(&pk(outsider), "nowhere"), Err(OpError::Refused { code: "no_conv", .. })));
        }

        // Through a channel they can read, a message in the private one is "not found",
        // as one that was never posted is; only its id stays taken.
        for id in ["m1", "nope"] {
            let edit = serde_json::json!({"conv": "pub", "id": id, "msg": {"text": "y"}});
            assert_eq!(code(publish(&mut f.db, &bob, "msg.edit", edit)), "not_found");
            let delete = serde_json::json!({"conv": "pub", "id": id});
            assert_eq!(code(publish(&mut f.db, &owner, "msg.delete", delete)), "not_found");
        }
        assert_eq!(code(post(&mut f.db, &bob, "pub", "m1")), "duplicate_msg");
        // Between two channels the signer can read, the old answer stands.
        let edit = serde_json::json!({"conv": "p", "id": "b1", "msg": {"text": "y"}});
        assert_eq!(code(publish(&mut f.db, &ann, "msg.edit", edit)), "forbidden");
        publish(&mut f.db, &ann, "conv.add", serde_json::json!({"conv": "p", "member": pk(&bob)})).unwrap();
        let edit = serde_json::json!({"conv": "p", "id": "b1", "msg": {"text": "y"}});
        assert_eq!(code(publish(&mut f.db, &bob, "msg.edit", edit)), "wrong_conv");

        // Visibility is set once.
        for (conv, private) in [("p", false), ("pub", true)] {
            let body = serde_json::json!({"conv": conv, "name": "Same", "private": private});
            assert_eq!(code(publish(&mut f.db, &ann, "conv.put", body)), "visibility_fixed");
        }
        let body = serde_json::json!({"conv": "p", "name": "Same", "private": "yes"});
        assert_eq!(code(publish(&mut f.db, &ann, "conv.put", body)), "bad_body");
        // Saying nothing, or what it already is, changes nothing.
        publish(&mut f.db, &ann, "conv.put", serde_json::json!({"conv": "p", "name": "Renamed"})).unwrap();
        publish(&mut f.db, &ann, "conv.put", serde_json::json!({"conv": "p", "name": "Renamed", "private": true})).unwrap();
        assert!(f.db.conv_members(&pk(&ann), "p").unwrap().private);
        assert!(!f.db.conv_members(&pk(&bob), "pub").unwrap().private);
    }

    #[test]
    fn adding_and_removing_channel_members() {
        let mut f = fixture();
        let owner = join(&mut f.db, Role::Owner, "Owner");
        let ann = join(&mut f.db, Role::Member, "Ann");
        let bob = join(&mut f.db, Role::Member, "Bob");
        let cy = join(&mut f.db, Role::Member, "Cy");
        let stranger = generate_key();
        let member = |conv: &str, key: &SigningKey| serde_json::json!({"conv": conv, "member": pk(key)});
        let listed = |db: &Db, reader: &SigningKey| -> Vec<(String, String)> {
            let found = db.conv_members(&pk(reader), "p").unwrap();
            found.members.into_iter().map(|m| (m.pubkey, m.added_by)).collect()
        };

        publish(&mut f.db, &ann, "conv.put", serde_json::json!({"conv":"p","name":"P","private":true})).unwrap();
        // The creator is the first member, of a public channel too.
        assert_eq!(listed(&f.db, &ann), vec![(pk(&ann), pk(&ann))]);
        publish(&mut f.db, &ann, "conv.put", serde_json::json!({"conv":"pub","name":"Public"})).unwrap();
        assert_eq!(f.db.conv_members(&pk(&bob), "pub").unwrap().members[0].pubkey, pk(&ann));

        for bad in [serde_json::json!({"conv": "p"}), serde_json::json!({"conv": "p", "member": "bob"}), serde_json::json!({"conv": "p", "member": 5})] {
            assert_eq!(code(publish(&mut f.db, &ann, "conv.add", bad.clone())), "bad_body");
            assert_eq!(code(publish(&mut f.db, &ann, "conv.remove", bad)), "bad_body");
        }
        assert_eq!(code(publish(&mut f.db, &ann, "conv.add", member("p", &stranger))), "not_found");

        publish(&mut f.db, &ann, "conv.add", member("p", &bob)).unwrap();
        // Any member of the channel adds; adding again is accepted and changes nothing.
        publish(&mut f.db, &bob, "conv.add", member("p", &cy)).unwrap();
        publish(&mut f.db, &cy, "conv.add", member("p", &bob)).unwrap();
        assert_eq!(
            listed(&f.db, &cy),
            vec![(pk(&ann), pk(&ann)), (pk(&bob), pk(&ann)), (pk(&cy), pk(&bob))]
        );
        post(&mut f.db, &cy, "p", "c1").unwrap();

        // A member takes out only themselves; the creator is not taken out by anyone else.
        assert_eq!(code(publish(&mut f.db, &bob, "conv.remove", member("p", &cy))), "forbidden");
        assert_eq!(code(publish(&mut f.db, &bob, "conv.remove", member("p", &ann))), "forbidden");
        assert_eq!(code(publish(&mut f.db, &ann, "conv.remove", member("p", &owner))), "not_found");
        // The owner is outside the channel and so has no say in it...
        assert_eq!(code(publish(&mut f.db, &owner, "conv.remove", member("p", &cy))), "no_conv");
        // ...until someone brings them in.
        publish(&mut f.db, &ann, "conv.add", member("p", &owner)).unwrap();
        assert_eq!(code(publish(&mut f.db, &owner, "conv.remove", member("p", &ann))), "forbidden");
        publish(&mut f.db, &owner, "conv.remove", member("p", &cy)).unwrap();
        assert_eq!(code(post(&mut f.db, &cy, "p", "c2")), "no_conv");
        // (Signed a second later: the same body in the same second is the same event,
        // and would be answered as a retry of the removal above.)
        let again = sign_event(&owner, NOW + 1, "conv.remove", f.db.ws(), &member("p", &cy).to_string());
        assert_eq!(code(f.db.publish(&again, NOW, 600)), "not_found");

        // Leaving, also for the creator, who is then outside like anyone else.
        publish(&mut f.db, &bob, "conv.remove", member("p", &bob)).unwrap();
        publish(&mut f.db, &ann, "conv.remove", member("p", &ann)).unwrap();
        assert_eq!(code(publish(&mut f.db, &ann, "conv.put", serde_json::json!({"conv":"p","name":"Back?"}))), "no_conv");
        assert_eq!(listed(&f.db, &owner), vec![(pk(&owner), pk(&ann))]);

        // Removing someone from the team takes them out of every channel.
        publish(&mut f.db, &owner, "conv.add", member("p", &bob)).unwrap();
        f.db.remove_member(&pk(&owner), &pk(&bob)).unwrap();
        assert_eq!(listed(&f.db, &owner), vec![(pk(&owner), pk(&ann))]);
    }

    #[test]
    fn reads_are_filtered_by_channel() {
        let mut f = fixture();
        let ann = join(&mut f.db, Role::Member, "Ann");
        let bob = join(&mut f.db, Role::Member, "Bob");
        let owner = join(&mut f.db, Role::Owner, "Owner");
        let (a, b, o) = (pk(&ann), pk(&bob), pk(&owner));
        let member = |conv: &str, key: &SigningKey| serde_json::json!({"conv": conv, "member": pk(key)});

        publish(&mut f.db, &ann, "conv.put", serde_json::json!({"conv":"pub","name":"Public"})).unwrap(); // 1
        publish(&mut f.db, &ann, "conv.put", serde_json::json!({"conv":"p","name":"P","private":true})).unwrap(); // 2
        post(&mut f.db, &ann, "p", "m1").unwrap(); // 3
        post(&mut f.db, &bob, "pub", "m2").unwrap(); // 4
        let offer = serde_json::json!({"conv": "p", "agent": {"id": "sub", "name": "Legal"}});
        publish(&mut f.db, &ann, "agent.put", offer).unwrap(); // 5: no channel, whatever its body says
        post(&mut f.db, &ann, "p", "m3").unwrap(); // 6

        let all = |db: &Db, reader: &str| seqs(&db.sync_for(reader, 0, None, 200, usize::MAX).unwrap());
        let of_p = |db: &Db, reader: &str| seqs(&db.sync_for(reader, 0, Some("p"), 200, usize::MAX).unwrap());
        assert_eq!(all(&f.db, &a), vec![1, 2, 3, 4, 5, 6]);
        assert_eq!(all(&f.db, &b), vec![1, 4, 5]);
        assert_eq!(all(&f.db, &o), vec![1, 4, 5]);
        assert_eq!(f.db.head_for(&a).unwrap(), 6);
        assert_eq!(f.db.head_for(&b).unwrap(), 5);
        assert_eq!(f.db.head_for("nobody").unwrap(), 5);
        assert_eq!(of_p(&f.db, &a), vec![2, 3, 6]);
        assert!(of_p(&f.db, &b).is_empty());
        assert_eq!(seqs(&f.db.sync_for(&b, 0, Some("pub"), 200, usize::MAX).unwrap()), vec![1, 4]);

        // `next` is the last seq of a page, or the reader's own head when it is empty.
        let page = f.db.sync_for(&b, 0, None, 2, usize::MAX).unwrap();
        assert_eq!((seqs(&page), page.more, page.next), (vec![1, 4], true, 4));
        let page = f.db.sync_for(&b, 4, None, 2, usize::MAX).unwrap();
        assert_eq!((seqs(&page), page.more, page.next), (vec![5], false, 5));
        let page = f.db.sync_for(&b, 5, None, 2, usize::MAX).unwrap();
        assert_eq!((seqs(&page), page.more, page.next), (vec![], false, 5));
        let page = f.db.sync_for(&b, 0, Some("p"), 2, usize::MAX).unwrap();
        assert_eq!((seqs(&page), page.more, page.next), (vec![], false, 5));
        let page = f.db.sync_for(&b, 900, None, 2, usize::MAX).unwrap();
        assert_eq!((seqs(&page), page.more, page.next), (vec![], false, 5));

        // Who an event is passed on to.
        let only = |db: &Db, seq: u64| match db.audience(seq).unwrap() {
            Audience::Everyone => panic!("event {seq} goes to everyone"),
            Audience::Only(members) => {
                let mut members: Vec<String> = members.into_iter().collect();
                members.sort();
                members
            }
        };
        let sorted = |mut keys: Vec<String>| {
            keys.sort();
            keys
        };
        for seq in [1, 4, 5] {
            assert!(matches!(f.db.audience(seq).unwrap(), Audience::Everyone), "{seq}");
        }
        assert_eq!(only(&f.db, 3), vec![a.clone()]);
        assert!(only(&f.db, 99).is_empty());

        // Added: Bob gets the event that added him, and from then on the whole channel.
        let added = publish(&mut f.db, &ann, "conv.add", member("p", &bob)).unwrap().seq; // 7
        assert_eq!(only(&f.db, added), sorted(vec![a.clone(), b.clone()]));
        assert_eq!(of_p(&f.db, &b), vec![2, 3, 6, 7]);
        assert_eq!(all(&f.db, &b), vec![1, 2, 3, 4, 5, 6, 7]);
        assert_eq!(all(&f.db, &o), vec![1, 4, 5]);

        // Removed: he gets that one event, live and in sync, and nothing after it.
        let removed = publish(&mut f.db, &ann, "conv.remove", member("p", &bob)).unwrap().seq; // 8
        assert_eq!(only(&f.db, removed), sorted(vec![a.clone(), b.clone()]));
        let later = post(&mut f.db, &ann, "p", "m4").unwrap().seq; // 9
        assert_eq!(only(&f.db, later), vec![a.clone()]);
        assert_eq!(all(&f.db, &b), vec![1, 4, 5, 8]);
        assert_eq!(f.db.head_for(&b).unwrap(), 8);
        assert!(of_p(&f.db, &b).is_empty());
        assert_eq!(all(&f.db, &o), vec![1, 4, 5]);
        assert_eq!(f.db.head_for(&o).unwrap(), 5);
        assert_eq!(f.db.head().unwrap(), 9);

        // A row that should name a channel and does not is served to nobody,
        // rather than to everyone like an event that has none.
        f.db.conn.execute("UPDATE events SET conv = NULL WHERE seq = 3", []).unwrap();
        assert_eq!(all(&f.db, &a), vec![1, 2, 4, 5, 6, 7, 8, 9]);
        assert_eq!(all(&f.db, &o), vec![1, 4, 5]);
        assert!(only(&f.db, 3).is_empty());
    }

    #[test]
    fn a_long_run_of_private_events_costs_an_outsider_no_pages() {
        let mut f = fixture();
        let ann = join(&mut f.db, Role::Member, "Ann");
        let bob = join(&mut f.db, Role::Member, "Bob");
        publish(&mut f.db, &ann, "conv.put", serde_json::json!({"conv":"pub","name":"Public"})).unwrap();
        publish(&mut f.db, &ann, "conv.put", serde_json::json!({"conv":"p","name":"P","private":true})).unwrap();
        for i in 0..50 {
            post(&mut f.db, &ann, "p", &format!("p{i}")).unwrap();
            if i % 10 == 9 {
                post(&mut f.db, &ann, "pub", &format!("pub{i}")).unwrap();
            }
        }
        for i in 0..30 {
            post(&mut f.db, &ann, "p", &format!("tail{i}")).unwrap();
        }
        assert_eq!(f.db.head().unwrap(), 87);

        // Pages of four: Bob walks his six events in two pages, none of them empty.
        let mut after = 0;
        let mut seen = Vec::new();
        let mut pages = 0;
        loop {
            let page = f.db.sync_for(&pk(&bob), after, None, 4, usize::MAX).unwrap();
            pages += 1;
            assert!(!page.events.is_empty() || !page.more);
            assert!(page.next > after, "the position did not move");
            after = page.next;
            seen.extend(seqs(&page));
            if !page.more {
                break;
            }
        }
        assert_eq!(seen, vec![1, 13, 24, 35, 46, 57]);
        assert_eq!(pages, 2);
        assert_eq!(f.db.head_for(&pk(&bob)).unwrap(), 57);
        // Asking again from there: an empty page that says so, though 30 rows follow.
        let page = f.db.sync_for(&pk(&bob), after, None, 4, usize::MAX).unwrap();
        assert_eq!((page.events.len(), page.more, page.next), (0, false, 57));
        // Ann, who is in the channel, gets every row.
        let page = f.db.sync_for(&pk(&ann), 0, None, 200, usize::MAX).unwrap();
        assert_eq!((page.events.len(), page.more, page.next), (87, false, 87));
    }

    #[test]
    fn invites_to_a_channel() {
        let mut f = fixture();
        let owner = join(&mut f.db, Role::Owner, "Owner");
        let admin = join(&mut f.db, Role::Admin, "Admin");
        let ann = join(&mut f.db, Role::Member, "Ann");
        let bob = join(&mut f.db, Role::Member, "Bob");
        let (o, ad, a, b) = (pk(&owner), pk(&admin), pk(&ann), pk(&bob));
        let terms = |role: Role, conv: Option<&'static str>| InviteTerms { role, uses: 1, days: 7, conv };
        let refused = |r: OpResult<NewInvite>| match r {
            Err(OpError::Refused { code, .. }) => code,
            Ok(_) => panic!("the invite was made"),
            Err(e) => panic!("{e}"),
        };
        let in_p = |db: &Db, reader: &str| -> Vec<String> {
            db.conv_members(reader, "p").unwrap().members.into_iter().map(|m| m.pubkey).collect()
        };

        publish(&mut f.db, &ann, "conv.put", serde_json::json!({"conv":"p","name":"P","private":true})).unwrap();
        publish(&mut f.db, &bob, "conv.put", serde_json::json!({"conv":"pub","name":"Public"})).unwrap();
        post(&mut f.db, &ann, "p", "m1").unwrap();
        assert!(f.db.member_invites().unwrap());

        // A member invites only to a channel they can read, and only as a member.
        assert_eq!(refused(f.db.create_invite_as(&a, terms(Role::Member, None), NOW)), "forbidden");
        assert_eq!(refused(f.db.create_invite_as(&a, terms(Role::Admin, Some("p")), NOW)), "forbidden");
        assert_eq!(refused(f.db.create_invite_as(&b, terms(Role::Member, Some("p")), NOW)), "forbidden");
        assert_eq!(refused(f.db.create_invite_as(&b, terms(Role::Member, Some("nowhere")), NOW)), "forbidden");
        assert_eq!(refused(f.db.create_invite_as("stranger", terms(Role::Member, Some("pub")), NOW)), "not_member");
        let to_p = f.db.create_invite_as(&a, terms(Role::Member, Some("p")), NOW).unwrap();
        let to_pub = f.db.create_invite_as(&b, terms(Role::Member, Some("pub")), NOW).unwrap();

        // The owner and admins as before, and for a channel only if they can read it.
        assert_eq!(refused(f.db.create_invite_as(&ad, terms(Role::Admin, None), NOW)), "forbidden");
        assert_eq!(refused(f.db.create_invite_as(&o, terms(Role::Owner, None), NOW)), "forbidden");
        assert_eq!(refused(f.db.create_invite_as(&o, terms(Role::Member, Some("p")), NOW)), "no_conv");
        assert_eq!(refused(f.db.create_invite_as(&ad, terms(Role::Member, Some("nowhere")), NOW)), "no_conv");
        let plain = f.db.create_invite_as(&ad, terms(Role::Member, None), NOW).unwrap();
        f.db.create_invite_as(&o, terms(Role::Admin, Some("pub")), NOW).unwrap();

        // Listing: a member sees their own; the owner sees all, but not the name of a
        // channel they cannot read.
        let mine = f.db.list_invites_for(&a, NOW).unwrap();
        assert_eq!(mine.len(), 1);
        assert_eq!((mine[0].id.as_str(), mine[0].conv.as_deref()), (to_p.id.as_str(), Some("p")));
        let all = f.db.list_invites_for(&o, NOW).unwrap();
        assert_eq!(all.len(), 4);
        let conv_of = |id: &str| all.iter().find(|i| i.id == id).unwrap().conv.clone();
        assert_eq!(conv_of(&to_p.id), None);
        assert_eq!(conv_of(&to_pub.id), Some("pub".to_string()));
        assert_eq!(conv_of(&plain.id), None);

        // Revoking: a member only their own.
        assert!(matches!(f.db.revoke_invite(&b, &to_p.id), Err(OpError::Refused { code: "forbidden", .. })));
        assert!(matches!(f.db.revoke_invite(&b, &plain.id), Err(OpError::Refused { code: "forbidden", .. })));
        assert!(matches!(f.db.revoke_invite(&b, "nope"), Err(OpError::Refused { code: "not_found", .. })));
        f.db.revoke_invite(&b, &to_pub.id).unwrap();

        // Whoever claims it is in the channel, put there by the invite's maker,
        // and reads it from the start.
        let cy = generate_key();
        f.db.claim(&sha256_hex(to_p.token.as_bytes()), &pk(&cy), "Cy", NOW + 5).unwrap();
        assert_eq!(in_p(&f.db, &pk(&cy)), vec![a.clone(), pk(&cy)]);
        let row = f.db.conv_members(&a, "p").unwrap().members.pop().unwrap();
        assert_eq!((row.added_by, row.added_at), (a.clone(), NOW + 5));
        assert_eq!(seqs(&f.db.sync_for(&pk(&cy), 0, Some("p"), 200, usize::MAX).unwrap()), vec![1, 3]);

        // An archived channel takes nobody in; the invite still makes a member.
        let late = f.db.create_invite_as(&a, terms(Role::Member, Some("p")), NOW).unwrap();
        publish(&mut f.db, &ann, "conv.put", serde_json::json!({"conv":"p","name":"P","archived":true})).unwrap();
        let di = generate_key();
        f.db.claim(&sha256_hex(late.token.as_bytes()), &pk(&di), "Di", NOW).unwrap();
        assert_eq!(in_p(&f.db, &a), vec![a.clone(), pk(&cy)]);
        publish(&mut f.db, &ann, "conv.put", serde_json::json!({"conv":"p","name":"P","archived":false})).unwrap();

        // Leaving a channel cancels the invites one made to it.
        let by_cy = f.db.create_invite_as(&pk(&cy), terms(Role::Member, Some("p")), NOW).unwrap();
        publish(&mut f.db, &cy, "conv.remove", serde_json::json!({"conv": "p", "member": pk(&cy)})).unwrap();
        assert!(f.db.claim(&sha256_hex(by_cy.token.as_bytes()), &pk(&generate_key()), "Ed", NOW).is_err());

        // Only the owner turns member invites off, which also cancels the ones members made.
        let outstanding = f.db.create_invite_as(&a, terms(Role::Member, Some("p")), NOW).unwrap();
        assert!(matches!(f.db.set_member_invites(&ad, false), Err(OpError::Refused { code: "forbidden", .. })));
        assert!(matches!(f.db.set_member_invites(&a, false), Err(OpError::Refused { code: "forbidden", .. })));
        f.db.set_member_invites(&o, false).unwrap();
        assert!(!f.db.member_invites().unwrap());
        assert_eq!(refused(f.db.create_invite_as(&a, terms(Role::Member, Some("p")), NOW)), "forbidden");
        assert!(f.db.claim(&sha256_hex(outstanding.token.as_bytes()), &pk(&generate_key()), "Ed", NOW).is_err());
        // What the admin made is untouched.
        assert!(f.db.claim(&sha256_hex(plain.token.as_bytes()), &pk(&generate_key()), "Ed", NOW).is_ok());
        f.db.set_member_invites(&o, true).unwrap();
        assert!(f.db.create_invite_as(&a, terms(Role::Member, Some("p")), NOW).is_ok());
    }

    // ---- migration -------------------------------------------------------------------

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

    /// A version 1 file: Ann (owner) and Bob, two channels (one made by someone
    /// who has since been removed), a post, a redacted post with the edit that
    /// replaced it, and a sub-agent offer.
    fn v1_file(path: &Path, ann: &SigningKey, bob: &SigningKey, gone: &SigningKey) -> Vec<Event> {
        let conn = Connection::open(path).unwrap();
        conn.execute_batch(SCHEMA_V1).unwrap();
        conn.execute("INSERT INTO workspace VALUES (?1, ?2)", params![V1_WS, 1000]).unwrap();
        for (key, name, role) in [(ann, "Ann", "owner"), (bob, "Bob", "member")] {
            conn.execute("INSERT INTO members VALUES (?1, ?2, ?3, ?4, 1000)", params![V1_WS, pk(key), name, role])
                .unwrap();
        }
        conn.execute("INSERT INTO convs VALUES (?1, 'general', ?2, 0)", params![V1_WS, pk(ann)]).unwrap();
        conn.execute("INSERT INTO convs VALUES (?1, 'old', ?2, 1)", params![V1_WS, pk(gone)]).unwrap();
        conn.execute(
            "INSERT INTO invites VALUES (?1, 'inv1', 'hash', 'member', 1, ?2, ?3, 1000)",
            params![V1_WS, to_i64(NOW + 86_400), pk(ann)],
        )
        .unwrap();
        conn.execute("INSERT INTO messages VALUES (?1, 'm1', ?2, 'general', 0)", params![V1_WS, pk(bob)]).unwrap();
        conn.execute("INSERT INTO messages VALUES (?1, 'm2', ?2, 'general', 0)", params![V1_WS, pk(bob)]).unwrap();

        let events = vec![
            sign_event(ann, 2000, "conv.put", V1_WS, r#"{"conv":"general","name":"General"}"#),
            sign_event(gone, 2001, "conv.put", V1_WS, r#"{"conv":"old","name":"Old","archived":true}"#),
            sign_event(bob, 2002, "msg.post", V1_WS, r#"{"conv":"general","msg":{"id":"m1","text":"hello"}}"#),
            sign_event(bob, 2003, "msg.post", V1_WS, r#"{"conv":"general","msg":{"id":"m2","text":"draft"}}"#),
            sign_event(bob, 2004, "msg.edit", V1_WS, r#"{"conv":"general","id":"m2","msg":{"id":"m2","text":"final"}}"#),
            sign_event(ann, 2005, "agent.put", V1_WS, r#"{"agent":{"id":"sub","name":"Legal"}}"#),
        ];
        for (i, event) in events.iter().enumerate() {
            let seq = i as i64 + 1;
            // Seq 4 is the post an edit replaced: rewritten as version 1 did it.
            let (body, sig, redacted) = if seq == 4 {
                (r#"{"conv":"general","id":"m2","gone":true}"#.to_string(), None, true)
            } else {
                (event.body.clone(), event.sig.clone(), false)
            };
            let msg_id = match seq {
                3 => Some("m1"),
                4 | 5 => Some("m2"),
                _ => None,
            };
            conn.execute(
                "INSERT INTO events VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![V1_WS, seq, event.id, event.pubkey, to_i64(event.created_at), event.kind, body, sig, redacted, msg_id],
            )
            .unwrap();
        }
        events
    }

    fn user_version(path: &Path) -> i64 {
        let conn = Connection::open(path).unwrap();
        conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap()
    }

    fn columns(path: &Path, table: &str) -> Vec<String> {
        let conn = Connection::open(path).unwrap();
        let mut stmt = conn.prepare("SELECT name FROM pragma_table_info(?1)").unwrap();
        let rows = stmt.query_map(params![table], |r| r.get(0)).unwrap();
        rows.collect::<rusqlite::Result<_>>().unwrap()
    }

    #[test]
    fn a_new_database_is_created_at_the_current_version() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("relay.db");
        drop(Db::open(&path, NOW).unwrap());
        assert_eq!(user_version(&path), SCHEMA_VERSION);
        assert!(columns(&path, "events").contains(&"target".to_string()));
        // Opening it again changes nothing.
        drop(Db::open(&path, NOW).unwrap());
        assert_eq!(user_version(&path), SCHEMA_VERSION);
    }

    #[test]
    fn a_version_1_database_is_migrated_and_stays_readable() {
        // Version 1 never stamped its files; one that says 1 is treated the same.
        for stamped in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("relay.db");
            let (ann, bob, gone) = (generate_key(), generate_key(), generate_key());
            let events = v1_file(&path, &ann, &bob, &gone);
            if stamped {
                Connection::open(&path).unwrap().pragma_update(None, "user_version", 1).unwrap();
            }

            let mut db = Db::open(&path, NOW).unwrap();
            assert_eq!(db.ws(), V1_WS);
            assert_eq!(user_version(&path), SCHEMA_VERSION);
            assert!(db.member_invites().unwrap());

            // Everything is still there, in order, for every member, and still verifies.
            for reader in [&ann, &bob] {
                let page = db.sync_for(&pk(reader), 0, None, 200, usize::MAX).unwrap();
                assert_eq!(seqs(&page), vec![1, 2, 3, 4, 5, 6]);
                assert_eq!((page.more, page.next), (false, 6));
                for (served, original) in page.events.iter().zip(&events) {
                    assert_eq!(served.event.id, original.id);
                    if served.seq == 4 {
                        assert!(served.event.redacted && served.event.sig.is_none());
                    } else {
                        assert_eq!(cube_proto::verify_event(&served.event), Ok(()));
                    }
                }
                assert_eq!(db.head_for(&pk(reader)).unwrap(), 6);
                // By channel too: the redacted row kept its channel, the offer has none.
                let general = db.sync_for(&pk(reader), 0, Some("general"), 200, usize::MAX).unwrap();
                assert_eq!(seqs(&general), vec![1, 3, 4, 5]);
            }
            let stored: Vec<(i64, Option<String>, Option<String>)> = {
                let mut stmt = db.conn.prepare("SELECT seq, conv, target FROM events ORDER BY seq").unwrap();
                let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap();
                rows.collect::<rusqlite::Result<_>>().unwrap()
            };
            let convs: Vec<Option<&str>> = stored.iter().map(|r| r.1.as_deref()).collect();
            assert_eq!(convs, vec![Some("general"), Some("old"), Some("general"), Some("general"), Some("general"), None]);
            assert!(stored.iter().all(|r| r.2.is_none()));

            // Both channels are public; each has its creator as a member if they are still on the team.
            let general = db.conv_members(&pk(&bob), "general").unwrap();
            assert!(!general.private);
            assert_eq!(general.members.len(), 1);
            assert_eq!((general.members[0].pubkey.clone(), general.members[0].added_at), (pk(&ann), 2000));
            let old = db.conv_members(&pk(&bob), "old").unwrap();
            assert!(!old.private && old.members.is_empty());
            for seq in 1..=6 {
                assert!(matches!(db.audience(seq).unwrap(), Audience::Everyone));
            }

            // The invite survived, and the log goes on where it stopped.
            let invites = db.list_invites(NOW).unwrap();
            assert_eq!((invites.len(), invites[0].conv.clone()), (1, None));
            let event = sign_event(&bob, NOW, "msg.post", V1_WS, r#"{"conv":"general","msg":{"id":"m3","text":"after"}}"#);
            assert_eq!(db.publish(&event, NOW, 600).unwrap(), Published { seq: 7, fresh: true });
            let event = sign_event(&bob, NOW, "msg.delete", V1_WS, r#"{"conv":"general","id":"m1"}"#);
            assert_eq!(db.publish(&event, NOW, 600).unwrap().seq, 8);
        }
    }

    #[test]
    fn a_version_1_row_that_names_no_channel_stops_the_migration() {
        for bad_body in ["not json", r#"{"msg":{"id":"m1","text":"hello"}}"#, r#"{"conv":7}"#, r#"["general"]"#] {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("relay.db");
            let (ann, bob, gone) = (generate_key(), generate_key(), generate_key());
            v1_file(&path, &ann, &bob, &gone);
            Connection::open(&path)
                .unwrap()
                .execute("UPDATE events SET body = ?1 WHERE seq = 3", params![bad_body])
                .unwrap();
            let before = columns(&path, "events");

            let error = match Db::open(&path, NOW) {
                Ok(_) => panic!("the migration went through with body {bad_body}"),
                Err(e) => e.to_string(),
            };
            assert!(error.contains("event 3 (msg.post)"), "{error}");
            assert!(error.contains("left unchanged"), "{error}");

            // Nothing of the migration stayed: no new column, table or version.
            assert_eq!(user_version(&path), 0);
            assert_eq!(columns(&path, "events"), before);
            assert!(!columns(&path, "convs").contains(&"private".to_string()));
            assert!(columns(&path, "conv_members").is_empty());
            // And it fails the same way the next time.
            assert!(Db::open(&path, NOW).is_err());
        }
    }

    #[test]
    fn a_database_from_a_later_version_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("relay.db");
        drop(Db::open(&path, NOW).unwrap());
        Connection::open(&path).unwrap().pragma_update(None, "user_version", SCHEMA_VERSION + 1).unwrap();
        let error = match Db::open(&path, NOW) {
            Ok(_) => panic!("opened a database from a later version"),
            Err(e) => e.to_string(),
        };
        assert!(error.contains("schema version 3"), "{error}");
    }
}
