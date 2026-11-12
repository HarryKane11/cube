//! A channel's shared folder: this side of the relay's file store (docs/team-relay.md, "Files").
//!
//! Three things happen here: a folder is read to see what is in it, a file is sent up, and a file
//! is brought down. What comes down was written by someone else, so where it may land is decided
//! here and nowhere else: inside the one channel folder, never through a link, never onto
//! anything that is not an ordinary file, and only after its bytes match the hash that was asked
//! for. The webview names files; it never holds a ticket and cannot sign a file event itself.

use crate::team::{self, Refusal, Team};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, UNIX_EPOCH};
use tauri::State;

/// The largest file that is shared. The relay has its own limit and refuses above it.
const MAX_BYTES: u64 = 10 * 1024 * 1024;
/// Text files up to this size are merged when two people changed them at once. Larger ones are kept side by side.
const MERGE_BYTES: usize = 1024 * 1024;
const MAX_FILES: usize = 2000;
const MAX_DEPTH: usize = 6;

/// Hashes of files already read, so that looking at a folder again costs a directory listing: path → (size, modified, hash).
#[derive(Default)]
pub struct Drive {
    seen: Mutex<HashMap<PathBuf, (u64, u64, String)>>,
}

/// Why something was not done, with the relay's short code when it was the relay that refused.
#[derive(Serialize, Debug)]
pub struct Fail {
    code: String,
    message: String,
}

impl From<Refusal> for Fail {
    fn from(r: Refusal) -> Self {
        Fail { code: r.code, message: r.message }
    }
}

fn fail(code: &str, message: impl Into<String>) -> Fail {
    Fail { code: code.into(), message: message.into() }
}

fn local(message: impl Into<String>) -> Fail {
    fail("local", message)
}

/// One file in a channel folder. `skip` says why it is not shared, when it is not.
#[derive(Serialize)]
pub struct Seen {
    rel: String,
    size: u64,
    mtime: u64,
    sha: Option<String>,
    skip: Option<&'static str>,
}

/// Which cube made a version, when one did.
#[derive(Deserialize)]
pub struct By {
    agent: String,
    color: Option<String>,
}

fn by_json(by: Option<By>) -> Option<Value> {
    let by = by?;
    let agent: String = by.agent.chars().filter(|c| !c.is_control()).take(80).collect();
    if agent.trim().is_empty() {
        return None;
    }
    let color = by.color.filter(|c| c.len() == 7 && c.starts_with('#') && c[1..].chars().all(|d| d.is_ascii_hexdigit()));
    Some(match color {
        Some(color) => json!({ "agent": agent, "color": color }),
        None => json!({ "agent": agent }),
    })
}

fn hex_of(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn is_sha(s: &str) -> bool {
    s.len() == 64 && s.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f'))
}

/// Folders and files that are never part of a shared folder: hidden ones, build output, and the
/// lock files Office leaves beside an open document. The Stage's file list leaves out the same.
fn left_out(name: &str) -> bool {
    name.starts_with('.') || name.starts_with("~$") || matches!(name, "node_modules" | "target" | "__pycache__")
}

/// A name that reads like a key or a password file. Such a file stays on this computer.
fn looks_secret(name: &str) -> bool {
    let n = name.to_lowercase();
    [".pem", ".p12", ".pfx", ".jks", ".keystore"].iter().any(|e| n.ends_with(e))
        || ["id_rsa", "id_ed25519", "id_ecdsa", "id_dsa"].iter().any(|p| n.starts_with(p))
        || ["secret", "credential", "private_key", "private-key", "apikey", "api_key", "api-key"].iter().any(|w| n.contains(w))
}

/// A path as it is written in the shared folder: plain names separated by `/`, the same rule
/// the relay applies. Returns its parts.
pub fn shared_path(path: &str) -> Result<Vec<&str>, String> {
    let bad = || "That file name cannot be used in a shared folder.".to_string();
    if path.is_empty() || path.len() > 300 {
        return Err(bad());
    }
    let parts: Vec<&str> = path.split('/').collect();
    if parts.len() > 8 {
        return Err(bad());
    }
    for p in &parts {
        if p.is_empty() || left_out(p) || p.contains("..") || p.contains('\\') || p.chars().any(char::is_control) || p.ends_with(' ') || p.ends_with('.') {
            return Err(bad());
        }
    }
    Ok(parts)
}

/// The channel folder itself: a real folder directly under ~/CubeSpaces.
fn channel_dir(dir: &str) -> Result<PathBuf, String> {
    let base = crate::inside_root(Path::new(dir))?;
    let root = crate::root().canonicalize().map_err(|e| e.to_string())?;
    if base.parent() == Some(root.as_path()) && base.is_dir() {
        Ok(base)
    } else {
        Err("That is not a conversation folder.".into())
    }
}

/// A file that is already in the channel folder, to be read. A link is not followed, and a path
/// that leads out of the folder through a linked folder is refused.
fn existing(base: &Path, rel: &str) -> Result<PathBuf, String> {
    shared_path(rel)?;
    let file = base.join(rel);
    let meta = fs::symlink_metadata(&file).map_err(|_| "That file is not there any more.".to_string())?;
    if !meta.is_file() {
        return Err("That is not an ordinary file.".into());
    }
    let real = file.canonicalize().map_err(|e| e.to_string())?;
    if real.starts_with(base) {
        Ok(real)
    } else {
        Err("That file is outside the conversation folder.".into())
    }
}

/// Where a file may be written in the channel folder. Folders on the way are made one at a time,
/// and each must be a real folder: a link anywhere on the way, or in the file's own place, ends it.
fn place(base: &Path, rel: &str) -> Result<PathBuf, String> {
    let parts = shared_path(rel)?;
    let (name, folders) = parts.split_last().ok_or("That is not a file path.")?;
    let mut at = base.to_path_buf();
    for folder in folders {
        at.push(folder);
        match fs::symlink_metadata(&at) {
            Ok(meta) if meta.is_dir() => {}
            Ok(_) => return Err("A file or a link is in the way of that folder.".into()),
            Err(_) => fs::create_dir(&at).map_err(|e| e.to_string())?,
        }
    }
    if !at.canonicalize().map_err(|e| e.to_string())?.starts_with(base) {
        return Err("That path leaves the conversation folder.".into());
    }
    let target = at.join(name);
    match fs::symlink_metadata(&target) {
        Ok(meta) if !meta.is_file() => Err("Something that is not an ordinary file is in that place.".into()),
        _ => Ok(target),
    }
}

/// Writes bytes where `target` is, by way of a hidden file beside the folder's other files: the
/// file appears whole or not at all, and a link put in its place meanwhile is replaced, not followed.
fn write_whole(base: &Path, target: &Path, bytes: &[u8]) -> Result<u64, String> {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    let temp = base.join(format!(".cube-incoming-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
    let written = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)
        .and_then(|mut f| f.write_all(bytes).and_then(|_| f.sync_all()))
        .and_then(|_| fs::rename(&temp, target));
    if let Err(e) = written {
        let _ = fs::remove_file(&temp);
        return Err(e.to_string());
    }
    Ok(mtime_of(target))
}

fn mtime_of(file: &Path) -> u64 {
    fs::metadata(file).ok().and_then(|m| m.modified().ok()).and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// The hash of the file at `rel` right now, or None when there is no ordinary file there.
fn hash_at(base: &Path, rel: &str) -> Option<String> {
    let file = existing(base, rel).ok()?;
    if fs::metadata(&file).ok()?.len() > MAX_BYTES {
        return None;
    }
    fs::read(&file).ok().map(|b| hex_of(&b))
}

fn walk(base: &Path, dir: &Path, depth: usize, cache: &HashMap<PathBuf, (u64, u64, String)>, fresh: &mut HashMap<PathBuf, (u64, u64, String)>, out: &mut Vec<Seen>) {
    if depth > MAX_DEPTH || out.len() >= MAX_FILES {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if left_out(&name) {
            continue;
        }
        // The entry's own kind: a link is neither a folder nor a file here, and is passed over.
        let Ok(kind) = entry.file_type() else { continue };
        let path = entry.path();
        if kind.is_dir() {
            walk(base, &path, depth + 1, cache, fresh, out);
            continue;
        }
        if !kind.is_file() || out.len() >= MAX_FILES {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        let mtime = meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0);
        let rel = path.strip_prefix(base).unwrap_or(&path).to_string_lossy().replace(std::path::MAIN_SEPARATOR, "/");
        let size = meta.len();
        let skip = if shared_path(&rel).is_err() {
            Some("name")
        } else if looks_secret(&name) {
            Some("secret")
        } else if size > MAX_BYTES {
            Some("big")
        } else {
            None
        };
        let sha = if skip.is_some() {
            None
        } else if let Some((s, m, sha)) = cache.get(&path).filter(|(s, m, _)| *s == size && *m == mtime) {
            fresh.insert(path.clone(), (*s, *m, sha.clone()));
            Some(sha.clone())
        } else {
            let sha = fs::read(&path).ok().map(|b| hex_of(&b));
            if let Some(sha) = &sha {
                fresh.insert(path.clone(), (size, mtime, sha.clone()));
            }
            sha
        };
        out.push(Seen { rel, size, mtime, sha, skip });
    }
}

/// What is in a channel folder, each file with its hash. Files that are never shared are listed
/// with the reason, so the person can be told.
#[tauri::command]
pub async fn drive_scan(drive: State<'_, Drive>, dir: String) -> Result<Vec<Seen>, String> {
    let base = channel_dir(&dir)?;
    let cache: HashMap<PathBuf, (u64, u64, String)> = drive.seen.lock().map_err(|e| e.to_string())?.iter().filter(|(p, _)| p.starts_with(&base)).map(|(p, v)| (p.clone(), v.clone())).collect();
    let root = base.clone();
    let (out, fresh) = tauri::async_runtime::spawn_blocking(move || {
        let mut out = Vec::new();
        let mut fresh = HashMap::new();
        walk(&root, &root, 0, &cache, &mut fresh, &mut out);
        (out, fresh)
    })
    .await
    .map_err(|e| e.to_string())?;
    let mut seen = drive.seen.lock().map_err(|e| e.to_string())?;
    seen.retain(|p, _| !p.starts_with(&base));
    seen.extend(fresh);
    Ok(out)
}

fn client(secs: u64) -> Result<reqwest::Client, Fail> {
    reqwest::Client::builder().timeout(Duration::from_secs(secs)).redirect(reqwest::redirect::Policy::none()).user_agent("Cube").build().map_err(|e| local(e.to_string()))
}

/// One GET of the relay's file store with a ticket. The body is read no further than `limit`,
/// and must be exactly the bytes the hash names.
async fn http_get(url: &str, ticket: &str, sha: &str, limit: usize) -> Result<Vec<u8>, Fail> {
    let mut res = client(120)?.get(url).bearer_auth(ticket).send().await.map_err(|e| fail("offline", format!("Could not reach the relay: {}", e.without_url())))?;
    if res.status().as_u16() != 200 {
        return Err(fail("not_found", format!("The relay did not hand the file over ({}).", res.status().as_u16())));
    }
    let mut bytes: Vec<u8> = Vec::new();
    while let Some(chunk) = res.chunk().await.map_err(|e| fail("offline", e.without_url().to_string()))? {
        if bytes.len() + chunk.len() > limit {
            return Err(fail("too_big", "The relay sent more than the file is said to hold."));
        }
        bytes.extend_from_slice(&chunk);
    }
    if hex_of(&bytes) != sha {
        return Err(local("What the relay sent is not the file that was asked for."));
    }
    Ok(bytes)
}

/// One PUT to the relay's file store with a ticket.
async fn http_put(url: &str, ticket: &str, bytes: Vec<u8>) -> Result<(), Fail> {
    let res = client(120)?
        .put(url)
        .bearer_auth(ticket)
        .header("Content-Type", "application/octet-stream")
        .header("Content-Length", bytes.len())
        .body(bytes)
        .send()
        .await
        .map_err(|e| fail("offline", format!("Could not reach the relay: {}", e.without_url())))?;
    match res.status().as_u16() {
        200 | 201 => Ok(()),
        413 => Err(fail("too_big", "The relay does not take files that large.")),
        507 => Err(fail("quota", "The team's file space is full.")),
        // Too many uploads at once: the relay says to come back shortly.
        503 => Err(fail("busy", "The relay is busy. The file goes up in a moment.")),
        other => Err(local(format!("The relay did not take the file ({other})."))),
    }
}

/// Brings a version's bytes down from the relay and checks them against the hash that was asked
/// for. `limit` is the most that is read: the version's own size when it is known.
async fn fetch(team: &Team, conv: &str, sha: &str, limit: u64) -> Result<Vec<u8>, Fail> {
    if !is_sha(sha) || limit > MAX_BYTES {
        return Err(fail("too_big", "That file is too large to bring down, or is not named properly."));
    }
    let ticket = team::request(team, json!({ "t": "blob.ticket", "op": "get", "conv": conv, "sha": sha })).await?;
    let token = ticket.get("ticket").and_then(Value::as_str).ok_or_else(|| local("The relay gave no way to fetch that file."))?;
    http_get(&team::blob_url(sha).map_err(local)?, token, sha, limit as usize).await
}

/// Makes sure the relay holds these bytes, sending them when it does not.
async fn send(team: &Team, conv: &str, sha: &str, bytes: Vec<u8>) -> Result<(), Fail> {
    let ticket = team::request(team, json!({ "t": "blob.ticket", "op": "put", "conv": conv, "sha": sha, "size": bytes.len() })).await?;
    if ticket.get("have").and_then(Value::as_bool) == Some(true) {
        return Ok(());
    }
    let token = ticket.get("ticket").and_then(Value::as_str).ok_or_else(|| local("The relay gave no way to send that file."))?;
    http_put(&team::blob_url(sha).map_err(local)?, token, bytes).await
}

#[derive(Serialize)]
pub struct Put {
    sha: String,
    size: u64,
    seq: u64,
}

/// Shares the file at `rel` as the channel's file `path`: sends its bytes if the relay lacks
/// them, then says, signed, that this is the file now. `base` is what this copy started from
/// (`""` for a file believed new); the relay refuses with `stale` when someone got there first.
#[tauri::command]
pub async fn drive_put(team: State<'_, Team>, conv: String, dir: String, rel: String, path: String, base: Option<String>, by: Option<By>) -> Result<Put, Fail> {
    let folder = channel_dir(&dir).map_err(local)?;
    shared_path(&path).map_err(local)?;
    let file = existing(&folder, &rel).map_err(local)?;
    let name = file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    if looks_secret(&name) {
        return Err(fail("secret", "That file looks like a key or a password, so it stays on this computer."));
    }
    if fs::metadata(&file).map_err(|e| local(e.to_string()))?.len() > MAX_BYTES {
        return Err(fail("too_big", "Files over 10 MB are not shared."));
    }
    let bytes = fs::read(&file).map_err(|e| local(e.to_string()))?;
    let (sha, size) = (hex_of(&bytes), bytes.len() as u64);
    send(&team, &conv, &sha, bytes).await?;
    let mut body = json!({ "conv": conv, "path": path, "sha": sha, "size": size });
    if let Some(base) = base.filter(|b| b.is_empty() || is_sha(b)) {
        body["base"] = Value::String(base);
    }
    if let Some(by) = by_json(by) {
        body["by"] = by;
    }
    let seq = team::publish(&team, "file.put", &body.to_string()).await?;
    Ok(Put { sha, size, seq })
}

/// Says, signed, that the channel's file `path` is gone, after checking that it is gone here.
#[tauri::command]
pub async fn drive_drop(team: State<'_, Team>, conv: String, dir: String, rel: String, path: String, base: Option<String>, by: Option<By>) -> Result<u64, Fail> {
    let folder = channel_dir(&dir).map_err(local)?;
    shared_path(&path).map_err(local)?;
    shared_path(&rel).map_err(local)?;
    if fs::symlink_metadata(folder.join(&rel)).is_ok() {
        return Err(local("That file is still here."));
    }
    let mut body = json!({ "conv": conv, "path": path });
    if let Some(base) = base.filter(|b| is_sha(b)) {
        body["base"] = Value::String(base);
    }
    if let Some(by) = by_json(by) {
        body["by"] = by;
    }
    Ok(team::publish(&team, "file.drop", &body.to_string()).await?)
}

#[derive(Serialize)]
pub struct Got {
    /// "written" when the file is now the one asked for; "changed" when this copy was not what
    /// the caller thought (someone or something wrote to it meanwhile) and was left alone.
    state: &'static str,
    mtime: u64,
}

/// Brings a version of a channel's file down to `rel`. `expect` is the hash this copy must have
/// for it to be replaced (None: there must be no file there), so a change made here a moment ago
/// is never written over.
#[tauri::command]
pub async fn drive_get(team: State<'_, Team>, conv: String, dir: String, rel: String, sha: String, size: u64, expect: Option<String>) -> Result<Got, Fail> {
    let folder = channel_dir(&dir).map_err(local)?;
    let target = place(&folder, &rel).map_err(local)?;
    let as_expected = |folder: &Path| {
        let now = hash_at(folder, &rel);
        let there = fs::symlink_metadata(folder.join(&rel)).is_ok();
        (now.as_deref() == Some(sha.as_str()), if there { now == expect && expect.is_some() } else { expect.is_none() })
    };
    let (same, ok) = as_expected(&folder);
    if same {
        return Ok(Got { state: "written", mtime: mtime_of(&target) });
    }
    if !ok {
        return Ok(Got { state: "changed", mtime: 0 });
    }
    let bytes = fetch(&team, &conv, &sha, size).await?;
    // Looked at once more: the download took a while, and a cube may have written here since.
    if !as_expected(&folder).1 {
        return Ok(Got { state: "changed", mtime: 0 });
    }
    let target = place(&folder, &rel).map_err(local)?;
    let mtime = write_whole(&folder, &target, &bytes).map_err(local)?;
    Ok(Got { state: "written", mtime })
}

#[derive(Serialize)]
pub struct Merged {
    /// "same": both sides ended up with the same file. "merged": the two sets of changes were
    /// put together in `rel`. "copied": they could not be, so this side's file was kept beside
    /// the other under `copy`.
    outcome: &'static str,
    copy: Option<String>,
}

/// A name for the copy that is free in the folder: the wanted one, or it with a number.
fn free_name(base: &Path, wanted: &str) -> Result<String, String> {
    shared_path(wanted)?;
    let (stem, ext) = match wanted.rfind('.') {
        Some(i) if i > wanted.rfind('/').map(|s| s + 1).unwrap_or(0) => (&wanted[..i], &wanted[i..]),
        _ => (wanted, ""),
    };
    (1..200)
        .map(|n| if n == 1 { wanted.to_string() } else { format!("{stem} {n}{ext}") })
        .find(|name| fs::symlink_metadata(base.join(name)).is_err())
        .ok_or_else(|| "There are too many copies of that file.".to_string())
}

/// Both sides changed a file. Text is merged line by line from the version both started from;
/// when that cannot be done cleanly (or it is not text, or nobody knows the common start), the
/// other side's file takes the name and this side's is kept beside it, so nothing is lost.
#[tauri::command]
pub async fn drive_merge(team: State<'_, Team>, conv: String, dir: String, rel: String, base: Option<String>, sha: String, size: u64, copy: String) -> Result<Merged, Fail> {
    let folder = channel_dir(&dir).map_err(local)?;
    let file = existing(&folder, &rel).map_err(local)?;
    let ours = fs::read(&file).map_err(|e| local(e.to_string()))?;
    let ours_sha = hex_of(&ours);
    if ours_sha == sha {
        return Ok(Merged { outcome: "same", copy: None });
    }
    let theirs = fetch(&team, &conv, &sha, size).await?;
    let mut merged: Option<String> = None;
    if let (Some(base), Ok(ours), Ok(theirs)) = (base.as_deref().filter(|b| is_sha(b)), std::str::from_utf8(&ours), std::str::from_utf8(&theirs)) {
        if ours.len() <= MERGE_BYTES && theirs.len() <= MERGE_BYTES {
            // The common start is one of the file's earlier versions, which the relay still has. Its size is not known here, so any up to the merge limit is taken.
            if let Ok(start) = fetch(&team, &conv, base, MERGE_BYTES as u64).await {
                if let Ok(start) = String::from_utf8(start) {
                    merged = diffy::merge(&start, ours, theirs).ok();
                }
            }
        }
    }
    // The file here must still be what was read: a cube may be writing to it right now.
    if hash_at(&folder, &rel).as_deref() != Some(ours_sha.as_str()) {
        return Err(fail("busy", "That file is being changed right now."));
    }
    let target = place(&folder, &rel).map_err(local)?;
    if let Some(text) = merged {
        write_whole(&folder, &target, text.as_bytes()).map_err(local)?;
        return Ok(Merged { outcome: "merged", copy: None });
    }
    let name = free_name(&folder, &copy).map_err(local)?;
    let beside = place(&folder, &name).map_err(local)?;
    fs::rename(&file, &beside).map_err(|e| local(e.to_string()))?;
    write_whole(&folder, &target, &theirs).map_err(local)?;
    Ok(Merged { outcome: "copied", copy: Some(name) })
}

/// A teammate deleted a file: this copy goes to the Trash, but only if it is still the version
/// that was shared. Returns whether it was moved.
#[tauri::command]
pub async fn drive_trash(dir: String, rel: String, expect: String) -> Result<bool, String> {
    let folder = channel_dir(&dir)?;
    if hash_at(&folder, &rel).as_deref() != Some(expect.as_str()) {
        return Ok(false);
    }
    crate::to_trash(&existing(&folder, &rel)?)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("cube-drive-{}-{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    #[test]
    fn a_shared_path_is_plain_names_only() {
        for ok in ["notes.md", "src/app.py", "보고서/1분기 요약.md", "a/b/c/d/e/f/g/h.txt"] {
            assert!(shared_path(ok).is_ok(), "{ok}");
        }
        for bad in ["", "/etc/passwd", "../up.md", "a/../b.md", "a//b.md", ".env", "a/.git/config", "a\\b.md", "a\nb.md", "trailing .md ", "dot.", "node_modules/x.js", "~$open.docx", "a..b.md", "a/b/c/d/e/f/g/h/i.txt"] {
            assert!(shared_path(bad).is_err(), "{bad:?}");
        }
        assert!(shared_path(&"a".repeat(301)).is_err());
    }

    #[test]
    fn names_that_read_like_secrets_stay_home() {
        for name in ["server.pem", "id_rsa", "id_ed25519.pub", "client_secret.json", "aws-credentials.csv", "API_KEY.txt"] {
            assert!(looks_secret(name), "{name}");
        }
        for name in ["notes.md", "deck.key", "keynote.pptx", "tokens.css"] {
            assert!(!looks_secret(name), "{name}");
        }
    }

    #[test]
    fn nothing_is_written_through_a_link() {
        let base = temp("links");
        let outside = temp("links-outside");
        // A folder that is really a link to somewhere else.
        std::os::unix::fs::symlink(&outside, base.join("docs")).unwrap();
        assert!(place(&base, "docs/plan.md").is_err());
        // A file that is really a link.
        fs::write(outside.join("victim.txt"), "mine").unwrap();
        std::os::unix::fs::symlink(outside.join("victim.txt"), base.join("notes.txt")).unwrap();
        assert!(place(&base, "notes.txt").is_err());
        assert!(existing(&base, "notes.txt").is_err());
        assert!(hash_at(&base, "notes.txt").is_none());
        // A folder where the file should go.
        fs::create_dir(base.join("thing")).unwrap();
        assert!(place(&base, "thing").is_err());
        assert_eq!(fs::read_to_string(outside.join("victim.txt")).unwrap(), "mine");
    }

    #[test]
    fn a_file_lands_whole_in_folders_made_on_the_way() {
        let base = temp("write");
        let target = place(&base, "a/b/report.md").unwrap();
        write_whole(&base, &target, b"hello").unwrap();
        assert_eq!(fs::read_to_string(base.join("a/b/report.md")).unwrap(), "hello");
        assert_eq!(hash_at(&base, "a/b/report.md").unwrap(), hex_of(b"hello"));
        // Nothing of the way it got there is left behind.
        assert!(fs::read_dir(&base).unwrap().flatten().all(|e| !e.file_name().to_string_lossy().starts_with(".cube-incoming")));
        // A link put where the file goes is replaced, not followed.
        let outside = temp("write-outside");
        fs::write(outside.join("victim.txt"), "mine").unwrap();
        fs::remove_file(base.join("a/b/report.md")).unwrap();
        let target = place(&base, "a/b/report.md").unwrap();
        std::os::unix::fs::symlink(outside.join("victim.txt"), &target).unwrap();
        write_whole(&base, &target, b"theirs").unwrap();
        assert_eq!(fs::read_to_string(outside.join("victim.txt")).unwrap(), "mine");
        assert!(fs::symlink_metadata(&target).unwrap().is_file());
    }

    #[test]
    fn a_scan_passes_over_links_and_hidden_things_and_says_why_a_file_is_not_shared() {
        let base = temp("scan");
        fs::write(base.join("notes.md"), "hi").unwrap();
        fs::write(base.join(".env"), "KEY=1").unwrap();
        fs::write(base.join("deploy.pem"), "x").unwrap();
        fs::create_dir(base.join("node_modules")).unwrap();
        fs::write(base.join("node_modules/x.js"), "x").unwrap();
        std::os::unix::fs::symlink(base.join("notes.md"), base.join("link.md")).unwrap();
        let mut out = Vec::new();
        let mut fresh = HashMap::new();
        walk(&base, &base, 0, &HashMap::new(), &mut fresh, &mut out);
        out.sort_by(|a, b| a.rel.cmp(&b.rel));
        let got: Vec<(&str, Option<&str>)> = out.iter().map(|s| (s.rel.as_str(), s.skip)).collect();
        assert_eq!(got, vec![("deploy.pem", Some("secret")), ("notes.md", None)]);
        assert_eq!(out[1].sha.as_deref(), Some(hex_of(b"hi").as_str()));
        assert!(out[0].sha.is_none());
        // A second look reuses the hash instead of reading the file again.
        let mut again = Vec::new();
        let mut kept = HashMap::new();
        fs::write(base.join("notes.md"), "hi").unwrap();
        let cache: HashMap<PathBuf, (u64, u64, String)> = [(base.join("notes.md"), (2, mtime_of(&base.join("notes.md")), "cached".to_string()))].into();
        walk(&base, &base, 0, &cache, &mut kept, &mut again);
        assert!(again.iter().any(|s| s.sha.as_deref() == Some("cached")));
    }

    #[test]
    fn a_copy_gets_a_name_that_is_free() {
        let base = temp("names");
        assert_eq!(free_name(&base, "plan (Kane).md").unwrap(), "plan (Kane).md");
        fs::write(base.join("plan (Kane).md"), "x").unwrap();
        assert_eq!(free_name(&base, "plan (Kane).md").unwrap(), "plan (Kane) 2.md");
        fs::create_dir(base.join("docs.v2")).unwrap();
        assert_eq!(free_name(&base, "docs.v2/readme").unwrap(), "docs.v2/readme");
    }

    #[test]
    fn two_sets_of_changes_to_text_merge_when_they_do_not_touch() {
        let start = "title\n\none\ntwo\nthree\n";
        let ours = "title\n\none (mine)\ntwo\nthree\n";
        let theirs = "title\n\none\ntwo\nthree\nfour\n";
        assert_eq!(diffy::merge(start, ours, theirs).unwrap(), "title\n\none (mine)\ntwo\nthree\nfour\n");
        assert!(diffy::merge(start, ours, "title\n\none (theirs)\ntwo\nthree\n").is_err());
    }

    /// Against a relay that is running (skipped when `CUBE_DRIVE_BASE` is unset): the address
    /// blobs live under (`http://127.0.0.1:8497/blob`), a file the relay does not have yet with a
    /// put ticket for it, and a file that is in a channel with two get tickets for it. The
    /// tickets come from `cube-peer ticket`.
    #[tokio::test]
    async fn bytes_go_up_and_come_down_through_a_running_relay() {
        let Ok(base) = std::env::var("CUBE_DRIVE_BASE") else { return };
        let var = |name: &str| std::env::var(name).unwrap();
        let fresh = fs::read(var("CUBE_DRIVE_NEW")).unwrap();
        let url = format!("{base}/{}", hex_of(&fresh));
        http_put(&url, &var("CUBE_DRIVE_PUT"), fresh.clone()).await.unwrap();
        // A ticket works once.
        assert_eq!(http_put(&url, &var("CUBE_DRIVE_PUT"), fresh).await.unwrap_err().code, "local");
        let have = fs::read(var("CUBE_DRIVE_OLD")).unwrap();
        let sha = hex_of(&have);
        let url = format!("{base}/{sha}");
        // Nothing is read past the size that was asked for.
        assert_eq!(http_get(&url, &var("CUBE_DRIVE_GET_SHORT"), &sha, have.len() - 1).await.unwrap_err().code, "too_big");
        assert_eq!(http_get(&url, &var("CUBE_DRIVE_GET"), &sha, have.len()).await.unwrap(), have);
        assert_eq!(http_get(&url, &var("CUBE_DRIVE_GET"), &sha, have.len()).await.unwrap_err().code, "not_found");
        // And a hash the bytes do not have is refused, whatever came back.
        assert!(http_get(&format!("{base}/{}", "0".repeat(64)), "no-ticket", &"0".repeat(64), 10).await.is_err());
    }

    #[test]
    fn who_made_a_version_is_cut_to_what_the_relay_takes() {
        assert_eq!(by_json(Some(By { agent: "Builder".into(), color: Some("#0a84ff".into()) })).unwrap(), json!({ "agent": "Builder", "color": "#0a84ff" }));
        assert_eq!(by_json(Some(By { agent: "Builder".into(), color: Some("red".into()) })).unwrap(), json!({ "agent": "Builder" }));
        assert!(by_json(Some(By { agent: "  ".into(), color: None })).is_none());
        assert!(by_json(None).is_none());
    }
}
