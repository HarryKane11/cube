//! Files: where their bytes are kept, and the tickets that let a member send
//! or fetch them.
//!
//! A file is stored once under the SHA-256 of its content, in `blobs/` next
//! to the database. The bytes travel over plain HTTP requests on the relay's
//! listener, not over the WebSocket. Such a request cannot prove who sent it
//! the way a connection does, so it carries a ticket: a random string the
//! relay handed to a member over their authenticated connection, good for one
//! request, for one hash, for a short time.
//!
//! Files are stored as they arrive: not encrypted, and never looked into.

use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use axum::body::Body;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use futures_util::StreamExt;
use rand::RngCore;
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;

use crate::db::sha256_hex;

/// What an unfinished upload is called while it is being written.
const TEMP_PREFIX: &str = ".tmp-";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Op {
    Put,
    Get,
}

impl Op {
    pub fn as_str(self) -> &'static str {
        match self {
            Op::Put => "put",
            Op::Get => "get",
        }
    }
}

/// What a ticket allows: one request by `op` for `sha`, on behalf of `pubkey`.
pub struct Ticket {
    pub pubkey: String,
    pub op: Op,
    pub sha: String,
    /// The channel it was asked for; a download is checked against it again.
    pub conv: String,
    /// For an upload, the exact number of bytes that must arrive.
    pub size: u64,
    expires: Instant,
}

/// The tickets that are out, in memory only: a restart cancels them all.
/// They are kept by the SHA-256 of the ticket, never by the ticket itself.
#[derive(Default)]
pub struct Tickets {
    live: HashMap<String, Ticket>,
}

impl Tickets {
    fn sweep(&mut self, now: Instant) {
        self.live.retain(|_, ticket| ticket.expires > now);
    }

    /// How many tickets `pubkey` holds that could still be used.
    pub fn held_by(&mut self, pubkey: &str, now: Instant) -> usize {
        self.sweep(now);
        self.live.values().filter(|ticket| ticket.pubkey == pubkey).count()
    }

    /// Makes a ticket (32 random bytes, base64url) and returns it. This is the
    /// only time it exists in the clear on the relay.
    pub fn issue(&mut self, pubkey: &str, op: Op, conv: &str, sha: &str, size: u64, ttl: Duration, now: Instant) -> String {
        self.sweep(now);
        let mut raw = [0u8; 32];
        rand::rngs::OsRng.fill_bytes(&mut raw);
        let token = URL_SAFE_NO_PAD.encode(raw);
        raw.fill(0);
        let ticket = Ticket {
            pubkey: pubkey.to_string(),
            op,
            sha: sha.to_string(),
            conv: conv.to_string(),
            size,
            expires: now + ttl,
        };
        self.live.insert(sha256_hex(token.as_bytes()), ticket);
        token
    }

    /// Uses a ticket up. It is gone whatever the outcome, so presenting it
    /// for the wrong hash or the wrong direction spends it too; `None` unless
    /// it exists, has not expired and was issued for exactly this request.
    pub fn redeem(&mut self, token: &str, op: Op, sha: &str, now: Instant) -> Option<Ticket> {
        let ticket = self.live.remove(&sha256_hex(token.as_bytes()))?;
        (ticket.expires > now && ticket.op == op && ticket.sha == sha).then_some(ticket)
    }

    /// Cancels the tickets of someone who was removed from the team.
    pub fn drop_member(&mut self, pubkey: &str) {
        self.live.retain(|_, ticket| ticket.pubkey != pubkey);
    }
}

/// Why an upload was not taken.
pub enum ReceiveError {
    /// More bytes came than the ticket was for.
    TooLong,
    /// The request ended, or broke, before all the bytes had come.
    Incomplete,
    /// The bytes do not hash to the name they were sent under.
    Mismatch,
    Io(io::Error),
}

impl From<io::Error> for ReceiveError {
    fn from(e: io::Error) -> Self {
        ReceiveError::Io(e)
    }
}

/// An upload that arrived whole and verified, still under its temporary
/// name. Dropping it deletes the file, so one that is not kept (refused,
/// timed out, connection gone) leaves nothing behind.
pub struct Upload {
    temp: Option<PathBuf>,
}

impl Drop for Upload {
    fn drop(&mut self) {
        if let Some(temp) = self.temp.take() {
            let _ = std::fs::remove_file(temp);
        }
    }
}

/// The directory the files are kept in.
pub struct Store {
    dir: PathBuf,
}

impl Store {
    /// Makes the directory if it is missing, for its owner only, and removes
    /// what uploads cut short by an earlier stop left behind. An existing
    /// directory is left as its owner set it.
    pub fn open(dir: &Path) -> io::Result<Store> {
        let mut builder = std::fs::DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(dir)?;
        for entry in std::fs::read_dir(dir)? {
            let entry = entry?;
            if entry.file_name().to_string_lossy().starts_with(TEMP_PREFIX) {
                let _ = std::fs::remove_file(entry.path());
            }
        }
        Ok(Store { dir: dir.to_path_buf() })
    }

    /// Where the file with this hash is, or would be. `sha` must have been
    /// checked to be 64 hex characters: it becomes a file name.
    pub fn path(&self, sha: &str) -> PathBuf {
        self.dir.join(sha)
    }

    /// Whether the file is on disk with the size the database has for it.
    pub fn has(&self, sha: &str, size: u64) -> bool {
        std::fs::metadata(self.path(sha)).is_ok_and(|meta| meta.is_file() && meta.len() == size)
    }

    /// Writes a request body to a temporary file, stopping as soon as it is
    /// longer than `size`, and checks that it is exactly `size` bytes that
    /// hash to `sha`. The file is created readable by its owner only.
    pub async fn receive(&self, body: Body, size: u64, sha: &str) -> Result<Upload, ReceiveError> {
        let mut name = [0u8; 16];
        rand::rngs::OsRng.fill_bytes(&mut name);
        let temp = self.dir.join(format!("{TEMP_PREFIX}{}", hex::encode(name)));
        let mut options = tokio::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.mode(0o600);
        let mut file = options.open(&temp).await?;
        let upload = Upload { temp: Some(temp) };

        let mut hasher = Sha256::new();
        let mut received = 0u64;
        let mut chunks = body.into_data_stream();
        while let Some(chunk) = chunks.next().await {
            let chunk = chunk.map_err(|_| ReceiveError::Incomplete)?;
            received = received.saturating_add(chunk.len() as u64);
            if received > size {
                return Err(ReceiveError::TooLong);
            }
            hasher.update(&chunk);
            file.write_all(&chunk).await?;
        }
        if received != size {
            return Err(ReceiveError::Incomplete);
        }
        if hex::encode(hasher.finalize()) != sha {
            return Err(ReceiveError::Mismatch);
        }
        // On disk before it is given its name: a file that has its name is whole.
        file.sync_all().await?;
        Ok(upload)
    }

    /// Gives a verified upload its name. A file already there has the same
    /// content and is replaced by it.
    pub fn keep(&self, mut upload: Upload, sha: &str) -> io::Result<()> {
        let Some(temp) = upload.temp.as_ref() else {
            return Ok(());
        };
        std::fs::rename(temp, self.path(sha))?;
        upload.temp = None;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SHA: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const OTHER: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const TTL: Duration = Duration::from_secs(60);

    #[test]
    fn a_ticket_is_long_random_and_works_once() {
        let mut tickets = Tickets::default();
        let t0 = Instant::now();
        let first = tickets.issue("ann", Op::Put, "general", SHA, 5, TTL, t0);
        let second = tickets.issue("ann", Op::Put, "general", SHA, 5, TTL, t0);
        assert_ne!(first, second);
        // 32 bytes as base64url: more than 128 bits, and safe in a header.
        assert_eq!(URL_SAFE_NO_PAD.decode(&first).unwrap().len(), 32);
        assert!(first.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'));
        // The store does not hold the ticket itself.
        assert!(!tickets.live.contains_key(&first));

        let used = tickets.redeem(&first, Op::Put, SHA, t0).unwrap();
        assert_eq!((used.pubkey.as_str(), used.conv.as_str(), used.size), ("ann", "general", 5));
        assert!(tickets.redeem(&first, Op::Put, SHA, t0).is_none());
        assert!(tickets.redeem("made-up", Op::Put, SHA, t0).is_none());
        assert!(tickets.redeem(&second, Op::Put, SHA, t0).is_some());
    }

    #[test]
    fn a_ticket_is_for_one_direction_one_hash_and_a_short_time() {
        let mut tickets = Tickets::default();
        let t0 = Instant::now();
        // Each wrong use spends the ticket: the right one after it fails too.
        let wrong_op = tickets.issue("ann", Op::Put, "general", SHA, 5, TTL, t0);
        assert!(tickets.redeem(&wrong_op, Op::Get, SHA, t0).is_none());
        assert!(tickets.redeem(&wrong_op, Op::Put, SHA, t0).is_none());
        let wrong_sha = tickets.issue("ann", Op::Get, "general", SHA, 5, TTL, t0);
        assert!(tickets.redeem(&wrong_sha, Op::Get, OTHER, t0).is_none());
        assert!(tickets.redeem(&wrong_sha, Op::Get, SHA, t0).is_none());

        let late = tickets.issue("ann", Op::Get, "general", SHA, 5, TTL, t0);
        assert!(tickets.redeem(&late, Op::Get, SHA, t0 + TTL).is_none());
        let in_time = tickets.issue("ann", Op::Get, "general", SHA, 5, TTL, t0);
        assert!(tickets.redeem(&in_time, Op::Get, SHA, t0 + TTL - Duration::from_millis(1)).is_some());
    }

    #[test]
    fn expired_tickets_are_swept_and_a_removed_member_loses_theirs() {
        let mut tickets = Tickets::default();
        let t0 = Instant::now();
        for _ in 0..3 {
            tickets.issue("ann", Op::Get, "general", SHA, 5, TTL, t0);
        }
        let bea = tickets.issue("bea", Op::Get, "general", SHA, 5, TTL, t0 + Duration::from_secs(30));
        assert_eq!(tickets.held_by("ann", t0), 3);
        assert_eq!(tickets.held_by("bea", t0), 1);
        // Ann's have run out; nothing of them is kept.
        assert_eq!(tickets.held_by("ann", t0 + TTL), 0);
        assert_eq!(tickets.live.len(), 1);

        tickets.drop_member("bea");
        assert!(tickets.live.is_empty());
        assert!(tickets.redeem(&bea, Op::Get, SHA, t0 + TTL).is_none());
    }

    #[tokio::test]
    async fn an_upload_is_checked_and_leaves_nothing_behind_unless_kept() {
        let dir = tempfile::tempdir().unwrap();
        let blobs = dir.path().join("blobs");
        let store = Store::open(&blobs).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&blobs).unwrap().permissions().mode() & 0o777, 0o700);
        }
        let entries = || std::fs::read_dir(&blobs).unwrap().count();
        let content = b"hello, file";
        let sha = sha256_hex(content);
        let size = content.len() as u64;

        assert!(matches!(store.receive(Body::from(&content[..]), size, OTHER).await, Err(ReceiveError::Mismatch)));
        assert!(matches!(store.receive(Body::from(&content[..]), size - 1, &sha).await, Err(ReceiveError::TooLong)));
        assert!(matches!(store.receive(Body::from(&content[..]), size + 1, &sha).await, Err(ReceiveError::Incomplete)));
        assert_eq!(entries(), 0);

        // Verified but dropped: gone. Kept: there under its hash, for its owner only.
        drop(store.receive(Body::from(&content[..]), size, &sha).await.ok().unwrap());
        assert_eq!(entries(), 0);
        let upload = store.receive(Body::from(&content[..]), size, &sha).await.ok().unwrap();
        assert!(!store.has(&sha, size));
        store.keep(upload, &sha).unwrap();
        assert!(store.has(&sha, size) && !store.has(&sha, size + 1));
        assert_eq!(std::fs::read(store.path(&sha)).unwrap(), content);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(store.path(&sha)).unwrap().permissions().mode() & 0o777, 0o600);
        }
        assert_eq!(entries(), 1);

        // What an upload cut short by a stop left behind is cleared on the next start.
        std::fs::write(blobs.join(".tmp-0123"), b"half").unwrap();
        let store = Store::open(&blobs).unwrap();
        assert_eq!(entries(), 1);
        assert!(store.has(&sha, size));
    }
}
