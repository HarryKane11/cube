//! The sessions the agent programs keep on this computer: Claude Code's (which the Claude
//! desktop app shares) and Codex's (which its app shares). Cube lists them so the person can
//! bring the context of one into a chat, and reads what was said in the one they pick.
//!
//! Everything here only reads. A session is never continued, forked or written to from here:
//! the cubes get its words as background and work in the chat's own folder.

use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::UNIX_EPOCH;

/// One session, as a line in the list.
#[derive(Serialize)]
pub struct SessionInfo {
    /// "claude" or "codex".
    program: String,
    id: String,
    title: String,
    /// The folder it works in.
    cwd: String,
    /// When it last changed, in milliseconds.
    updated: u64,
    /// The program is running it right now.
    live: bool,
    /// The record to read it from.
    path: String,
}

#[derive(Serialize)]
pub struct SessionTurn {
    /// "user" or "assistant".
    role: String,
    text: String,
}

/// What was said in a session: the words only, with no tool calls, results or hidden reasoning.
#[derive(Serialize)]
pub struct SessionText {
    /// The program's own summary of the earlier part, when it made one.
    summary: String,
    /// What the session began with.
    first: String,
    /// The latest turns that fit, oldest first.
    turns: Vec<SessionTurn>,
    /// How many turns were found in the part of the record that was read.
    total: usize,
}

/// The most of a record that is read from its end. Records grow to hundreds of megabytes.
const TAIL: u64 = 6 * 1024 * 1024;
/// The most that is read from its start, to find what it began with.
const HEAD: u64 = 256 * 1024;
/// The most text of the latest turns handed back, and of one turn.
const TURNS_BUDGET: usize = 16_000;
const TURN_LIMIT: usize = 3_000;
const MOST_LISTED: usize = 80;

fn mtime_ms(path: &Path) -> u64 {
    fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// A line of text for a title: one line, cut to what fits in a list.
fn title_of(text: &str) -> String {
    let flat: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() > 80 {
        format!("{}…", flat.chars().take(79).collect::<String>().trim_end())
    } else {
        flat
    }
}

/// Text that is not something a person or the agent said: what the program wraps in tags of its own.
fn is_wrapper(text: &str) -> bool {
    let t = text.trim_start();
    t.starts_with('<') && t.chars().take(60).any(|c| c == '>')
}

/// The words of one message: its text, without tool calls, tool results, pictures or reasoning.
fn words(content: &Value) -> String {
    match content {
        Value::String(s) => {
            if is_wrapper(s) { String::new() } else { s.trim().to_string() }
        }
        Value::Array(blocks) => blocks
            .iter()
            .filter(|b| matches!(b.get("type").and_then(Value::as_str), Some("text" | "input_text" | "output_text")))
            .filter_map(|b| b.get("text").and_then(Value::as_str))
            .filter(|t| !is_wrapper(t))
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .collect::<Vec<_>>()
            .join("\n\n"),
        _ => String::new(),
    }
}

/// One line of a record as a turn, or as the program's summary of what came before.
enum Said {
    Turn(SessionTurn),
    Summary(String),
}

fn claude_line(v: &Value) -> Option<Said> {
    let kind = v.get("type")?.as_str()?;
    if kind != "user" && kind != "assistant" {
        return None;
    }
    if v.get("isSidechain").and_then(Value::as_bool) == Some(true) || v.get("isMeta").and_then(Value::as_bool) == Some(true) {
        return None;
    }
    let text = words(v.get("message")?.get("content")?);
    if text.is_empty() {
        return None;
    }
    if v.get("isCompactSummary").and_then(Value::as_bool) == Some(true) {
        return Some(Said::Summary(text));
    }
    Some(Said::Turn(SessionTurn { role: kind.to_string(), text }))
}

fn codex_line(v: &Value) -> Option<Said> {
    if v.get("type")?.as_str()? != "response_item" {
        return None;
    }
    let p = v.get("payload")?;
    if p.get("type")?.as_str()? != "message" {
        return None;
    }
    let role = p.get("role")?.as_str()?;
    if role != "user" && role != "assistant" {
        return None;
    }
    let text = words(p.get("content")?);
    if text.is_empty() {
        return None;
    }
    Some(Said::Turn(SessionTurn { role: role.to_string(), text }))
}

/// Whole lines from the end of a file, at most `limit` bytes of it.
fn tail_lines(path: &Path, limit: u64) -> Result<Vec<String>, String> {
    let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
    let size = file.metadata().map_err(|e| e.to_string())?.len();
    let from = size.saturating_sub(limit);
    file.seek(SeekFrom::Start(from)).map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    file.take(limit).read_to_end(&mut buf).map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&buf);
    let mut lines: Vec<String> = text.lines().map(str::to_string).collect();
    // Started in the middle of the file: the first line is only the end of one.
    if from > 0 && !lines.is_empty() {
        lines.remove(0);
    }
    Ok(lines)
}

/// Whole lines from the start of a file, at most `limit` bytes of it.
fn head_lines(path: &Path, limit: u64) -> Vec<String> {
    let Ok(file) = fs::File::open(path) else { return Vec::new() };
    let mut buf = Vec::new();
    if file.take(limit).read_to_end(&mut buf).is_err() {
        return Vec::new();
    }
    let whole = (buf.len() as u64) < limit;
    let text = String::from_utf8_lossy(&buf);
    let mut lines: Vec<String> = text.lines().map(str::to_string).collect();
    // Stopped in the middle of the file: the last line is only the start of one.
    if !whole && !lines.is_empty() {
        lines.pop();
    }
    lines
}

fn first_said(path: &Path, parse: fn(&Value) -> Option<Said>) -> String {
    for line in head_lines(path, HEAD) {
        let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
        if let Some(Said::Turn(t)) = parse(&v) {
            if t.role == "user" {
                return t.text;
            }
        }
    }
    String::new()
}

/// The sessions Claude Code is running right now, from its own list of them.
fn claude_live(home: &Path) -> HashSet<String> {
    let mut live = HashSet::new();
    let Ok(dir) = fs::read_dir(home.join(".claude/sessions")) else { return live };
    for entry in dir.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Ok(text) = fs::read_to_string(&path) else { continue };
        let Ok(v) = serde_json::from_str::<Value>(&text) else { continue };
        let Some(id) = v.get("sessionId").and_then(Value::as_str) else { continue };
        // The list outlives a program that was killed: only a process that is still there counts.
        let alive = v.get("pid").and_then(Value::as_u64).is_some_and(|pid| {
            Command::new("/bin/kill").args(["-0", &pid.to_string()]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status().is_ok_and(|s| s.success())
        });
        if alive {
            live.insert(id.to_string());
        }
    }
    live
}

/// What the Claude desktop app knows about its sessions: a title and a folder, by the session's id.
fn claude_desktop(home: &Path) -> HashMap<String, (String, String)> {
    let mut known = HashMap::new();
    let root = home.join("Library/Application Support/Claude/claude-code-sessions");
    let Ok(accounts) = fs::read_dir(&root) else { return known };
    for account in accounts.flatten() {
        let Ok(orgs) = fs::read_dir(account.path()) else { continue };
        for org in orgs.flatten() {
            let Ok(files) = fs::read_dir(org.path()) else { continue };
            for file in files.flatten() {
                let path = file.path();
                if path.extension().and_then(|e| e.to_str()) != Some("json") {
                    continue;
                }
                let Ok(text) = fs::read_to_string(&path) else { continue };
                let Ok(v) = serde_json::from_str::<Value>(&text) else { continue };
                if v.get("isArchived").and_then(Value::as_bool) == Some(true) {
                    continue;
                }
                let Some(id) = v.get("cliSessionId").and_then(Value::as_str) else { continue };
                let title = v.get("title").and_then(Value::as_str).unwrap_or("").to_string();
                let cwd = v.get("cwd").and_then(Value::as_str).unwrap_or("").to_string();
                known.insert(id.to_string(), (title, cwd));
            }
        }
    }
    known
}

fn claude_sessions(home: &Path) -> Vec<SessionInfo> {
    let live = claude_live(home);
    let desktop = claude_desktop(home);
    // Every record, with when it last changed: the newest are what is listed.
    let mut found: Vec<(u64, PathBuf)> = Vec::new();
    if let Ok(projects) = fs::read_dir(home.join(".claude/projects")) {
        for project in projects.flatten() {
            let Ok(files) = fs::read_dir(project.path()) else { continue };
            for file in files.flatten() {
                let path = file.path();
                if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
                    found.push((mtime_ms(&path), path));
                }
            }
        }
    }
    found.sort_by(|a, b| b.0.cmp(&a.0));
    let mut out = Vec::new();
    for (updated, path) in found.into_iter().take(MOST_LISTED * 2) {
        if out.len() >= MOST_LISTED {
            break;
        }
        let Some(id) = path.file_stem().and_then(|s| s.to_str()).map(str::to_string) else { continue };
        let (mut title, mut cwd) = desktop.get(&id).cloned().unwrap_or_default();
        if title.is_empty() || cwd.is_empty() {
            // Not one the desktop app lists: what it began with is its name, and its folder is in the record.
            for line in head_lines(&path, HEAD) {
                let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
                if cwd.is_empty() {
                    if let Some(c) = v.get("cwd").and_then(Value::as_str) {
                        cwd = c.to_string();
                    }
                }
                if title.is_empty() {
                    if let Some(Said::Turn(t)) = claude_line(&v) {
                        if t.role == "user" {
                            title = t.text;
                        }
                    }
                }
                if !title.is_empty() && !cwd.is_empty() {
                    break;
                }
            }
        }
        // A record nobody said anything in is a session that was opened and left.
        if title.is_empty() {
            continue;
        }
        out.push(SessionInfo { program: "claude".into(), live: live.contains(&id), id, title: title_of(&title), cwd, updated, path: path.to_string_lossy().into_owned() });
    }
    out
}

fn codex_sessions(home: &Path) -> Vec<SessionInfo> {
    let db = home.join(".codex/state_5.sqlite");
    if !db.is_file() {
        return Vec::new();
    }
    // Read only, and without taking part in the locking of a database Codex has open.
    let uri = format!("file:{}?mode=ro&immutable=1", db.to_string_lossy().replace('?', "%3f").replace('#', "%23"));
    // Sessions a person had with Codex in its app or its terminal. Not the runs other programs start, and not Cube's own.
    let sql = "select id, coalesce(nullif(name, ''), title) as title, cwd, updated_at, rollout_path from threads where archived = 0 and source in ('vscode', 'cli') and coalesce(originator, '') <> 'cube' order by updated_at desc limit 80";
    let Ok(out) = Command::new("/usr/bin/sqlite3").args(["-json", &uri, sql]).stdin(Stdio::null()).stderr(Stdio::null()).output() else { return Vec::new() };
    if !out.status.success() {
        return Vec::new();
    }
    let Ok(rows) = serde_json::from_slice::<Vec<Value>>(&out.stdout) else { return Vec::new() };
    let sessions = home.join(".codex/sessions");
    let now = now_ms();
    rows.iter()
        .filter_map(|r| {
            let path = PathBuf::from(r.get("rollout_path")?.as_str()?);
            // Older records are packed away; only one that can be read as it is is offered.
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") || !path.starts_with(&sessions) || !path.is_file() {
                return None;
            }
            let title = title_of(r.get("title").and_then(Value::as_str).unwrap_or(""));
            if title.is_empty() {
                return None;
            }
            let changed = mtime_ms(&path);
            Some(SessionInfo {
                program: "codex".into(),
                id: r.get("id")?.as_str()?.to_string(),
                title,
                cwd: r.get("cwd").and_then(Value::as_str).unwrap_or("").to_string(),
                updated: r.get("updated_at").and_then(Value::as_u64).map(|s| s * 1000).unwrap_or(changed),
                // Codex keeps no list of what is running that can be read from outside: a record written to in the last two minutes is taken to be.
                live: now.saturating_sub(changed) < 120_000,
                path: path.to_string_lossy().into_owned(),
            })
        })
        .collect()
}

/// The sessions Claude Code and Codex have on this computer, the newest first.
#[tauri::command]
pub async fn sessions_list() -> Result<Vec<SessionInfo>, String> {
    let home = crate::home();
    let mut all = claude_sessions(&home);
    all.extend(codex_sessions(&home));
    all.sort_by(|a, b| b.updated.cmp(&a.updated));
    Ok(all)
}

/// The record a session is read from must be one of the two programs' own, and nothing else.
fn record(home: &Path, path: &str) -> Result<(PathBuf, &'static str), String> {
    let real = PathBuf::from(path).canonicalize().map_err(|e| e.to_string())?;
    if real.extension().and_then(|e| e.to_str()) != Some("jsonl") {
        return Err("That is not a session record.".into());
    }
    for (folder, program) in [(".claude/projects", "claude"), (".codex/sessions", "codex")] {
        if let Ok(base) = home.join(folder).canonicalize() {
            if real.starts_with(&base) {
                return Ok((real, program));
            }
        }
    }
    Err("Cube only reads the sessions of Claude Code and Codex.".into())
}

/// What was said in a session: what it began with, the program's summary if it made one, and the latest turns that fit.
#[tauri::command]
pub async fn session_read(path: String) -> Result<SessionText, String> {
    let (file, program) = record(&crate::home(), &path)?;
    let parse: fn(&Value) -> Option<Said> = if program == "claude" { claude_line } else { codex_line };
    let mut summary = String::new();
    let mut turns: Vec<SessionTurn> = Vec::new();
    for line in tail_lines(&file, TAIL)? {
        let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
        match parse(&v) {
            Some(Said::Summary(s)) => {
                // What was said before a summary is in the summary.
                summary = s;
                turns.clear();
            }
            Some(Said::Turn(t)) => turns.push(t),
            None => {}
        }
    }
    let total = turns.len();
    let mut kept: Vec<SessionTurn> = Vec::new();
    let mut size = 0usize;
    for t in turns.into_iter().rev() {
        let text: String = if t.text.chars().count() > TURN_LIMIT { format!("{}\n[…cut]", t.text.chars().take(TURN_LIMIT).collect::<String>()) } else { t.text };
        let cost = text.len();
        if !kept.is_empty() && size + cost > TURNS_BUDGET {
            break;
        }
        size += cost;
        kept.push(SessionTurn { role: t.role, text });
    }
    kept.reverse();
    let first = first_said(&file, parse);
    let first: String = if first.chars().count() > TURN_LIMIT { format!("{}\n[…cut]", first.chars().take(TURN_LIMIT).collect::<String>()) } else { first };
    let summary: String = if summary.chars().count() > 6_000 { format!("{}\n[…cut]", summary.chars().take(6_000).collect::<String>()) } else { summary };
    Ok(SessionText { summary, first, turns: kept, total })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn takes_the_words_and_leaves_tools_and_wrappers() {
        let said = words(&json!([
            { "type": "text", "text": "Here is the plan." },
            { "type": "tool_use", "name": "Bash", "input": { "command": "ls" } },
            { "type": "thinking", "thinking": "hidden" },
            { "type": "text", "text": "<system-reminder>not said by anyone</system-reminder>" },
            { "type": "text", "text": "Done." }
        ]));
        assert_eq!(said, "Here is the plan.\n\nDone.");
        assert_eq!(words(&json!("<command-name>/clear</command-name>")), "");
        assert_eq!(words(&json!("  hello  ")), "hello");
    }

    #[test]
    fn reads_a_claude_record_line() {
        let user = json!({ "type": "user", "message": { "role": "user", "content": "Fix the header" } });
        assert!(matches!(claude_line(&user), Some(Said::Turn(t)) if t.role == "user" && t.text == "Fix the header"));
        let tool = json!({ "type": "user", "message": { "role": "user", "content": [{ "type": "tool_result", "content": "ok" }] } });
        assert!(claude_line(&tool).is_none());
        let side = json!({ "type": "assistant", "isSidechain": true, "message": { "content": [{ "type": "text", "text": "sub" }] } });
        assert!(claude_line(&side).is_none());
        let sum = json!({ "type": "user", "isCompactSummary": true, "message": { "content": "Earlier: the header was rebuilt." } });
        assert!(matches!(claude_line(&sum), Some(Said::Summary(s)) if s.starts_with("Earlier")));
    }

    #[test]
    fn reads_a_codex_record_line() {
        let line = json!({ "type": "response_item", "payload": { "type": "message", "role": "assistant", "content": [{ "type": "output_text", "text": "Merged." }] } });
        assert!(matches!(codex_line(&line), Some(Said::Turn(t)) if t.role == "assistant" && t.text == "Merged."));
        let dev = json!({ "type": "response_item", "payload": { "type": "message", "role": "developer", "content": [{ "type": "input_text", "text": "rules" }] } });
        assert!(codex_line(&dev).is_none());
        let reasoning = json!({ "type": "response_item", "payload": { "type": "reasoning" } });
        assert!(codex_line(&reasoning).is_none());
    }

    #[test]
    fn cuts_a_title_to_one_line_that_fits() {
        assert_eq!(title_of("  fix\nthe   header "), "fix the header");
        assert_eq!(title_of(&"x".repeat(200)).chars().count(), 80);
    }

    /// Against the sessions really on this computer. Prints sizes and counts only, never what was said.
    /// Run by hand: `cargo test sessions::tests::reads_what_is_really_here -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn reads_what_is_really_here() {
        let home = crate::home();
        for (program, list) in [("claude", claude_sessions(&home)), ("codex", codex_sessions(&home))] {
            let live = list.iter().filter(|s| s.live).count();
            let untitled = list.iter().filter(|s| s.title.is_empty()).count();
            let no_cwd = list.iter().filter(|s| s.cwd.is_empty()).count();
            println!("{program}: {} listed, {live} running, {untitled} without a title, {no_cwd} without a folder", list.len());
            for s in list.iter().take(3) {
                let (file, kind) = record(&home, &s.path).expect("a listed session can be read");
                assert_eq!(kind, program);
                let parse: fn(&Value) -> Option<Said> = if program == "claude" { claude_line } else { codex_line };
                let lines = tail_lines(&file, TAIL).expect("the record opens");
                let turns = lines.iter().filter_map(|l| serde_json::from_str::<Value>(l).ok()).filter(|v| matches!(parse(v), Some(Said::Turn(_)))).count();
                let first = first_said(&file, parse);
                println!("  record of {} bytes: {} lines read, {turns} turns, first message of {} characters, title of {} characters", fs::metadata(&file).map(|m| m.len()).unwrap_or(0), lines.len(), first.chars().count(), s.title.chars().count());
            }
        }
    }

    #[test]
    fn only_reads_the_two_programs_records() {
        let home = std::env::temp_dir().join(format!("cube-sessions-test-{}", std::process::id()));
        let inside = home.join(".claude/projects/-p");
        fs::create_dir_all(&inside).unwrap();
        fs::write(inside.join("a.jsonl"), "{}\n").unwrap();
        fs::write(home.join("secret.jsonl"), "{}\n").unwrap();
        fs::write(inside.join("notes.md"), "x").unwrap();
        assert!(record(&home, inside.join("a.jsonl").to_str().unwrap()).is_ok());
        assert!(record(&home, home.join("secret.jsonl").to_str().unwrap()).is_err());
        assert!(record(&home, inside.join("notes.md").to_str().unwrap()).is_err());
        assert!(record(&home, inside.join("../../../secret.jsonl").to_str().unwrap()).is_err());
        let _ = fs::remove_dir_all(&home);
    }
}
