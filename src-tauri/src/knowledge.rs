//! What Cube knows across conversations: memory, skills and a wiki, kept as plain files under
//! ~/CubeSpaces/.knowledge so that people and agents can read them. This module is the bridge to
//! the agent programs: it brings their memories in, and writes Cube's memory and skills back out
//! in the shape each of them reads.
//!
//! Importing only reads the programs' folders. Exporting writes only files and blocks that are
//! marked as Cube's own, and leaves everything else in those folders as it was.

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

/// A file larger than this is not a memory note; it is skipped.
const MAX_NOTE: u64 = 200_000;
/// How much memory text goes into a program's instructions. The rest stays in Cube's folder.
const DIGEST_LIMIT: usize = 12_000;
const BLOCK_START: &str = "<!-- cube:memory:start -->";
const BLOCK_END: &str = "<!-- cube:memory:end -->";
/// Left inside a skill folder Cube wrote, so only those are ever replaced or removed.
const MARKER: &str = ".cube-managed";

#[derive(Serialize, Default, Debug, PartialEq)]
pub struct Imported {
    /// "claude", "codex" or "hermes".
    source: String,
    notes: usize,
}

#[derive(Serialize, Default, Debug)]
pub struct Exported {
    target: String,
    /// The file the memory was written to, or why it was not.
    memory: String,
    skills: usize,
}

/// The line that starts each note inside an imported file, so the notes can be told apart and counted.
const NOTE_MARK: &str = "<!-- note: ";
/// The most text kept from one program. More than this is not memory any more.
const MAX_IMPORT: usize = 1_500_000;

fn is_md(p: &Path) -> bool {
    p.extension().is_some_and(|e| e.eq_ignore_ascii_case("md"))
}

/// Markdown files under a folder, a few levels deep, not following links, in a steady order.
fn md_files(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    let mut entries: Vec<_> = entries.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
        let Ok(kind) = e.file_type() else { continue };
        let p = e.path();
        if kind.is_dir() && depth > 0 {
            md_files(&p, depth - 1, out);
        } else if kind.is_file() && is_md(&p) && out.len() < 3000 {
            out.push(p);
        }
    }
}

/// How much goes into one batch of imported notes: about what a small model reads and works in comfortably in one run.
const BATCH: usize = 60_000;

/// One note as it is kept in a batch, or nothing when it is empty, too large or unreadable.
fn note_text(label: &str, file: &Path) -> Option<String> {
    let small = fs::metadata(file).map(|m| m.is_file() && m.len() <= MAX_NOTE).unwrap_or(false);
    let text = small.then(|| fs::read_to_string(file).ok()).flatten()?;
    (!text.trim().is_empty()).then(|| format!("\n{NOTE_MARK}{} -->\n\n{}\n", label.replace("--", "-"), text.trim()))
}

/// Brings what each agent program remembers into `<know>/memory/imported/` as a few batch files
/// per program (`claude-01.md`, `claude-02.md`, …), replacing what an earlier import left. A few
/// files on purpose: an app that creates or deletes hundreds of files at once looks like
/// ransomware to security software, and rightly so. Batches on purpose too: the memory job works
/// one in per run and removes it, so no run has more to read than it can handle.
/// Nothing in the programs' own folders is changed.
pub fn import_into(home: &Path, know: &Path) -> Result<Vec<Imported>, String> {
    let into = know.join("memory").join("imported");
    fs::create_dir_all(&into).map_err(|e| e.to_string())?;
    let mut report = Vec::new();
    let mut save = |source: &str, title: &str, notes: Vec<String>| -> Result<(), String> {
        // What an earlier import of this program left, worked in or not, makes way for the new one.
        for old in fs::read_dir(&into).map_err(|e| e.to_string())?.flatten() {
            let name = old.file_name().to_string_lossy().into_owned();
            if old.path().is_file() && (name == format!("{source}.md") || name.starts_with(&format!("{source}-"))) {
                fs::remove_file(old.path()).map_err(|e| e.to_string())?;
            }
        }
        let mut batches: Vec<String> = Vec::new();
        let mut total = 0;
        let mut kept = 0;
        for note in &notes {
            if total + note.len() > MAX_IMPORT {
                break;
            }
            total += note.len();
            kept += 1;
            match batches.last_mut() {
                Some(last) if last.len() + note.len() <= BATCH => last.push_str(note),
                _ => batches.push(note.clone()),
            }
        }
        for (i, text) in batches.iter().enumerate() {
            fs::write(into.join(format!("{source}-{:02}.md", i + 1)), format!("# Notes brought in from {title} ({} of {})\n{text}", i + 1, batches.len())).map_err(|e| e.to_string())?;
        }
        report.push(Imported { source: source.into(), notes: kept });
        Ok(())
    };

    // Claude Code: the global instructions, and the memory folder of every project.
    let mut notes: Vec<String> = note_text("CLAUDE.md", &home.join(".claude/CLAUDE.md")).into_iter().collect();
    let mut projects: Vec<_> = fs::read_dir(home.join(".claude/projects")).map(|d| d.flatten().collect()).unwrap_or_default();
    projects.sort_by_key(|e| e.file_name());
    for project in projects {
        let mut files = Vec::new();
        md_files(&project.path().join("memory"), 1, &mut files);
        for f in files {
            // The index only lists the other files.
            if f.file_name().is_some_and(|n| n == "MEMORY.md") {
                continue;
            }
            let label = format!("{}/{}", project.file_name().to_string_lossy(), f.file_name().unwrap_or_default().to_string_lossy());
            notes.extend(note_text(&label, &f));
        }
    }
    save("claude", "Claude Code", notes)?;

    // Codex: its global instructions and its memories folder.
    let mut notes: Vec<String> = note_text("AGENTS.md", &home.join(".codex/AGENTS.md")).into_iter().collect();
    let base = home.join(".codex/memories");
    let mut files = Vec::new();
    md_files(&base, 3, &mut files);
    for f in files {
        if let Ok(rel) = f.strip_prefix(&base) {
            notes.extend(note_text(&format!("memories/{}", rel.to_string_lossy()), &f));
        }
    }
    save("codex", "Codex", notes)?;

    // Hermes: what it remembers about its work and about the person.
    let mut notes = Vec::new();
    for name in ["MEMORY.md", "USER.md"] {
        let from = [home.join(".hermes/memories").join(name), home.join(".hermes").join(name)].into_iter().find(|p| p.is_file());
        if let Some(from) = from {
            notes.extend(note_text(name, &from));
        }
    }
    save("hermes", "Hermes", notes)?;
    Ok(report)
}

/// One value from a note's front matter (`name: …`), wherever it sits between the `---` lines.
fn front(text: &str, key: &str) -> Option<String> {
    let rest = text.strip_prefix("---")?;
    let head = &rest[..rest.find("\n---")?];
    let lines: Vec<&str> = head.lines().collect();
    lines.iter().enumerate().find_map(|(i, l)| {
        let v = l.trim().strip_prefix(key)?.strip_prefix(':')?.trim();
        // A value written over several lines (`description: >`): the indented lines that follow, joined.
        if matches!(v, ">" | "|" | ">-" | "|-" | "") {
            let folded: Vec<&str> = lines[i + 1..].iter().take_while(|n| n.starts_with(' ') || n.starts_with('\t')).map(|n| n.trim()).filter(|n| !n.is_empty()).collect();
            return (!folded.is_empty() && !v.is_empty()).then(|| folded.join(" "));
        }
        let v = v.trim_matches('"').trim_matches('\'');
        (!v.is_empty()).then(|| v.to_string())
    })
}

fn body(text: &str) -> &str {
    match text.strip_prefix("---").and_then(|r| r.find("\n---").map(|i| &r[i + 4..])) {
        Some(b) => b.trim(),
        None => text.trim(),
    }
}

/// Cube's own memory as one document for an agent program to read: the notes Cube keeps (not the
/// raw imports), newest first, as much as fits.
pub fn digest(know: &Path) -> String {
    let mut notes: Vec<(std::time::SystemTime, PathBuf)> = fs::read_dir(know.join("memory"))
        .map(|d| d.flatten().map(|e| e.path()).filter(|p| p.is_file() && is_md(p) && p.file_name().is_some_and(|n| n != "MEMORY.md")).collect::<Vec<_>>())
        .unwrap_or_default()
        .into_iter()
        .filter_map(|p| Some((fs::metadata(&p).ok()?.modified().ok()?, p)))
        .collect();
    notes.sort_by(|a, b| b.0.cmp(&a.0));
    let mut out = String::from("# What Cube has learned\n\nWritten by the Cube app from its memory. Changes made here are replaced on the next export: change the memory in Cube instead.\n");
    let mut left_out = 0;
    for (_, path) in &notes {
        let Ok(text) = fs::read_to_string(path) else { continue };
        let name = front(&text, "name").unwrap_or_else(|| path.file_stem().unwrap_or_default().to_string_lossy().into_owned());
        let kind = front(&text, "type").unwrap_or_else(|| "note".into());
        let entry = format!("\n## {name} ({kind})\n\n{}\n", body(&text));
        if out.len() + entry.len() > DIGEST_LIMIT {
            left_out += 1;
            continue;
        }
        out.push_str(&entry);
    }
    if left_out > 0 {
        out.push_str(&format!("\n{left_out} more notes are in {}.\n", know.join("memory").display()));
    }
    out
}

fn count_notes(know: &Path) -> usize {
    fs::read_dir(know.join("memory"))
        .map(|d| d.flatten().filter(|e| e.path().is_file() && is_md(&e.path()) && e.file_name() != "MEMORY.md").count())
        .unwrap_or(0)
}

/// A file's text with Cube's block replaced, or added at the end. The rest is kept byte for byte.
pub fn with_block(existing: &str, inner: &str) -> String {
    let block = format!("{BLOCK_START}\n{}\n{BLOCK_END}", inner.trim());
    match (existing.find(BLOCK_START), existing.find(BLOCK_END)) {
        (Some(a), Some(b)) if b > a => format!("{}{}{}", &existing[..a], block, &existing[b + BLOCK_END.len()..]),
        _ if existing.trim().is_empty() => format!("{block}\n"),
        _ => format!("{}\n\n{block}\n", existing.trim_end()),
    }
}

fn copy_dir(from: &Path, to: &Path, budget: &mut usize) -> Result<(), String> {
    fs::create_dir_all(to).map_err(|e| e.to_string())?;
    for e in fs::read_dir(from).map_err(|e| e.to_string())?.flatten() {
        let kind = e.file_type().map_err(|e| e.to_string())?;
        let dest = to.join(e.file_name());
        if kind.is_dir() {
            copy_dir(&e.path(), &dest, budget)?;
        } else if kind.is_file() {
            if *budget == 0 {
                return Err("A skill has more files than Cube exports.".into());
            }
            *budget -= 1;
            fs::copy(e.path(), dest).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Puts Cube's skills into a program's skills folder as `cube-<name>`, replaces the ones it put
/// there before, and removes those that Cube no longer has (but for the names in `keep`). Skills
/// that are not Cube's are untouched.
fn export_skills(know: &Path, target: &Path, keep: &[&str]) -> Result<usize, String> {
    let mine: Vec<PathBuf> = fs::read_dir(know.join("skills"))
        .map(|d| d.flatten().map(|e| e.path()).filter(|p| p.join("SKILL.md").is_file()).collect())
        .unwrap_or_default();
    if mine.is_empty() && !target.is_dir() {
        return Ok(0);
    }
    fs::create_dir_all(target).map_err(|e| e.to_string())?;
    let wanted: Vec<String> = mine.iter().map(|p| format!("cube-{}", p.file_name().unwrap_or_default().to_string_lossy())).collect();
    for e in fs::read_dir(target).map_err(|e| e.to_string())?.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if e.path().join(MARKER).is_file() && !wanted.contains(&name) && !keep.contains(&name.as_str()) {
            let _ = fs::remove_dir_all(e.path());
        }
    }
    for (from, name) in mine.iter().zip(&wanted) {
        let dest = target.join(name);
        if dest.exists() {
            // Only a folder Cube wrote may be replaced.
            if !dest.join(MARKER).is_file() {
                continue;
            }
            fs::remove_dir_all(&dest).map_err(|e| e.to_string())?;
        }
        copy_dir(from, &dest, &mut 300)?;
        fs::write(dest.join(MARKER), "Written by Cube. Replaced on every export.\n").map_err(|e| e.to_string())?;
    }
    Ok(mine.len())
}

/// Writes Cube's memory and skills where each chosen program reads them.
pub fn export_from(home: &Path, know: &Path, targets: &[String]) -> Result<Vec<Exported>, String> {
    let text = digest(know);
    let has_notes = count_notes(know) > 0;
    let mut report = Vec::new();
    for target in targets {
        let done = match target.as_str() {
            // Claude Code reads every file in its rules folder at the start of a session.
            "claude" if home.join(".claude").is_dir() => {
                let file = home.join(".claude/rules/cube-memory.md");
                let memory = if has_notes {
                    fs::create_dir_all(home.join(".claude/rules")).map_err(|e| e.to_string())?;
                    fs::write(&file, &text).map_err(|e| e.to_string())?;
                    file.display().to_string()
                } else {
                    let _ = fs::remove_file(&file);
                    "No notes to export yet.".to_string()
                };
                Exported { target: target.clone(), memory, skills: export_skills(know, &home.join(".claude/skills"), &[])? }
            }
            // Codex reads AGENTS.md: Cube keeps one marked block in it and leaves the rest alone.
            "codex" if home.join(".codex").is_dir() => {
                let file = home.join(".codex/AGENTS.md");
                let memory = if has_notes {
                    let existing = fs::read_to_string(&file).unwrap_or_default();
                    fs::write(&file, with_block(&existing, &text)).map_err(|e| e.to_string())?;
                    file.display().to_string()
                } else {
                    "No notes to export yet.".to_string()
                };
                Exported { target: target.clone(), memory, skills: export_skills(know, &home.join(".codex/skills"), &[])? }
            }
            // Hermes keeps its own memory in two small files with a size limit, so Cube does not
            // write there: its memory goes in as a skill Hermes opens when it needs the context.
            "hermes" if home.join(".hermes").is_dir() => {
                let dir = home.join(".hermes/skills/cube/cube-memory");
                let memory = if has_notes {
                    if !dir.exists() || dir.join(MARKER).is_file() {
                        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
                        let skill = format!("---\nname: cube-memory\ndescription: What the Cube workspace has learned about the person, their projects and how they like work done. Read it when you need that context.\n---\n\n{text}");
                        fs::write(dir.join("SKILL.md"), skill).map_err(|e| e.to_string())?;
                        fs::write(dir.join(MARKER), "Written by Cube. Replaced on every export.\n").map_err(|e| e.to_string())?;
                        dir.join("SKILL.md").display().to_string()
                    } else {
                        "A skill named cube-memory that Cube did not write is already there.".to_string()
                    }
                } else {
                    "No notes to export yet.".to_string()
                };
                Exported { target: target.clone(), memory, skills: export_skills(know, &home.join(".hermes/skills/cube"), &["cube-memory"])? }
            }
            "claude" | "codex" | "hermes" => Exported { target: target.clone(), memory: "This program is not set up on this computer.".into(), skills: 0 },
            _ => continue,
        };
        report.push(done);
    }
    Ok(report)
}

fn know_dir() -> Result<PathBuf, String> {
    let dir = crate::root().join(".knowledge");
    for sub in ["memory", "skills", "wiki", "inbox"] {
        fs::create_dir_all(dir.join(sub)).map_err(|e| e.to_string())?;
    }
    Ok(dir)
}

/// One note, skill or wiki page, as Settings lists it.
#[derive(Serialize, Debug)]
pub struct Entry {
    /// Path inside the knowledge folder. For a skill, its folder.
    rel: String,
    /// The file to read to show it.
    path: String,
    name: String,
    description: String,
    /// For notes: user, feedback, project or reference.
    kind: String,
    source: String,
    mtime: u64,
}

#[derive(Serialize, Debug, Default)]
pub struct Listing {
    dir: String,
    memory: Vec<Entry>,
    skills: Vec<Entry>,
    wiki: Vec<Entry>,
    /// Notes brought in from other programs and not yet worked into memory.
    imported: usize,
    /// The batch files those notes are in.
    batches: Vec<String>,
    /// Files waiting in the inbox.
    inbox: Vec<String>,
    /// What a job marked for removal by overwriting it with the word DELETE.
    marked: Vec<String>,
}

fn entry_of(know: &Path, file: &Path, rel: &Path) -> Option<Entry> {
    let meta = fs::metadata(file).ok()?;
    let text = fs::read_to_string(file).ok()?;
    let stem = rel.file_stem().unwrap_or_default().to_string_lossy().into_owned();
    // A page without front matter is named by its first heading.
    let heading = body(&text).lines().find_map(|l| l.strip_prefix("# ").map(|h| h.trim().to_string()));
    let first = body(&text).lines().map(str::trim).find(|l| !l.is_empty() && !l.starts_with('#')).unwrap_or("");
    let _ = know;
    Some(Entry {
        rel: rel.to_string_lossy().into_owned(),
        path: file.to_string_lossy().into_owned(),
        name: front(&text, "name").or(heading).unwrap_or(stem),
        description: front(&text, "description").unwrap_or_else(|| first.chars().take(160).collect()),
        kind: front(&text, "type").unwrap_or_default(),
        source: front(&text, "source").unwrap_or_default(),
        mtime: meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0),
    })
}

fn is_marked(file: &Path) -> bool {
    fs::metadata(file).map(|m| m.len() <= 32).unwrap_or(false) && fs::read_to_string(file).map(|t| t.trim() == "DELETE").unwrap_or(false)
}

/// Everything in the knowledge folder, read for showing: notes, skills, wiki pages, and what is waiting.
pub fn list(know: &Path) -> Listing {
    let mut out = Listing { dir: know.to_string_lossy().into_owned(), ..Default::default() };
    let files = |dir: &Path| -> Vec<PathBuf> {
        let mut v: Vec<PathBuf> = fs::read_dir(dir).map(|d| d.flatten().map(|e| e.path()).collect()).unwrap_or_default();
        v.sort();
        v
    };
    for (sub, index) in [("memory", "MEMORY.md"), ("wiki", "")] {
        for f in files(&know.join(sub)) {
            if !f.is_file() || !is_md(&f) || f.file_name().is_some_and(|n| n == index) {
                continue;
            }
            let rel = Path::new(sub).join(f.file_name().unwrap_or_default());
            if is_marked(&f) {
                out.marked.push(rel.to_string_lossy().into_owned());
            } else if let Some(e) = entry_of(know, &f, &rel) {
                if sub == "memory" { out.memory.push(e) } else { out.wiki.push(e) }
            }
        }
    }
    for d in files(&know.join("skills")) {
        let file = d.join("SKILL.md");
        if !file.is_file() {
            continue;
        }
        let rel = Path::new("skills").join(d.file_name().unwrap_or_default());
        if is_marked(&file) {
            out.marked.push(rel.to_string_lossy().into_owned());
        } else if let Some(e) = entry_of(know, &file, &rel) {
            out.skills.push(e);
        }
    }
    // Batches of imported notes still waiting to be worked into memory, in the order they are taken.
    for f in files(&know.join("memory").join("imported")) {
        if f.is_file() && is_md(&f) {
            out.imported += fs::read_to_string(&f).map(|t| t.matches(NOTE_MARK).count()).unwrap_or(0);
            out.batches.push(format!("memory/imported/{}", f.file_name().unwrap_or_default().to_string_lossy()));
        }
    }
    out.inbox = files(&know.join("inbox")).iter().filter(|p| p.is_file()).filter_map(|p| p.file_name().map(|n| format!("inbox/{}", n.to_string_lossy()))).collect();
    // The index page first, then by name.
    out.wiki.sort_by_key(|e| (e.rel != "wiki/index.md", e.name.to_lowercase()));
    out.memory.sort_by(|a, b| b.mtime.cmp(&a.mtime));
    out
}

/// What is in the knowledge folder, for Settings.
#[tauri::command]
pub async fn knowledge_list() -> Result<Listing, String> {
    Ok(list(&know_dir()?))
}

/// One thing an agent program has: a skill or a memory note, with the file to read to show it.
#[derive(Serialize, Debug)]
pub struct LibItem {
    name: String,
    about: String,
    path: String,
}

#[derive(Serialize, Debug, Default)]
pub struct ProgramLibrary {
    skills: Vec<LibItem>,
    memory: Vec<LibItem>,
}

fn lib_item(file: &Path, fallback: String) -> Option<LibItem> {
    let text = fs::read_to_string(file).ok()?;
    let first = body(&text).lines().map(str::trim).find(|l| !l.is_empty() && !l.starts_with('#')).unwrap_or("");
    Some(LibItem {
        name: front(&text, "name").unwrap_or(fallback),
        about: front(&text, "description").unwrap_or_else(|| first.chars().take(200).collect()),
        path: file.to_string_lossy().into_owned(),
    })
}

/// Every SKILL.md under a folder, a few levels down. Folders that are links are followed, since
/// that is how skills are often installed.
fn skill_files(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    let mut entries: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
    entries.sort();
    for p in entries {
        if out.len() >= 800 || p.file_name().is_some_and(|n| n.to_string_lossy().starts_with('.')) {
            continue;
        }
        if p.join("SKILL.md").is_file() {
            out.push(p.join("SKILL.md"));
        } else if depth > 0 && p.is_dir() {
            skill_files(&p, depth - 1, out);
        }
    }
}

/// The skills and memory notes one agent program has on this computer, for looking through.
pub fn program_library(home: &Path, program: &str) -> ProgramLibrary {
    let mut out = ProgramLibrary::default();
    let (skills_dir, depth): (PathBuf, usize) = match program {
        "claude" => (home.join(".claude/skills"), 0),
        "codex" => (home.join(".codex/skills"), 1),
        "hermes" => (home.join(".hermes/skills"), 2),
        _ => return out,
    };
    let mut files = Vec::new();
    skill_files(&skills_dir, depth, &mut files);
    for f in files {
        let folder = f.parent().and_then(|d| d.file_name()).map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        if let Some(item) = lib_item(&f, folder) {
            out.skills.push(item);
        }
    }
    out.skills.sort_by_key(|i| i.name.to_lowercase());

    let mut notes: Vec<(String, PathBuf)> = Vec::new();
    match program {
        "claude" => {
            notes.push(("CLAUDE.md".into(), home.join(".claude/CLAUDE.md")));
            let mut projects: Vec<_> = fs::read_dir(home.join(".claude/projects")).map(|d| d.flatten().collect()).unwrap_or_default();
            projects.sort_by_key(|e| e.file_name());
            for project in projects {
                let mut files = Vec::new();
                md_files(&project.path().join("memory"), 1, &mut files);
                for f in files {
                    if f.file_name().is_some_and(|n| n != "MEMORY.md") {
                        notes.push((f.file_stem().unwrap_or_default().to_string_lossy().into_owned(), f));
                    }
                }
            }
        }
        "codex" => {
            notes.push(("AGENTS.md".into(), home.join(".codex/AGENTS.md")));
            let mut files = Vec::new();
            md_files(&home.join(".codex/memories"), 3, &mut files);
            notes.extend(files.into_iter().map(|f| (f.file_stem().unwrap_or_default().to_string_lossy().into_owned(), f)));
        }
        _ => {
            for name in ["MEMORY.md", "USER.md"] {
                let found = [home.join(".hermes/memories").join(name), home.join(".hermes").join(name)].into_iter().find(|p| p.is_file());
                if let Some(f) = found {
                    notes.push((name.to_string(), f));
                }
            }
            notes.push(("SOUL.md".into(), home.join(".hermes/SOUL.md")));
        }
    }
    for (name, file) in notes {
        if file.is_file() {
            if let Some(item) = lib_item(&file, name) {
                out.memory.push(item);
            }
        }
    }
    out
}

/// True for a markdown file inside one of the folders the library shows: the three programs'
/// own folders and Cube's knowledge folder. Nothing else can be read through the library.
pub fn readable(home: &Path, know: &Path, path: &Path) -> bool {
    let plain = path.is_absolute() && path.components().all(|c| !matches!(c, std::path::Component::ParentDir));
    let inside = [home.join(".claude"), home.join(".codex"), home.join(".hermes"), know.to_path_buf()].iter().any(|root| path.starts_with(root));
    plain && inside && is_md(path)
}

/// What one agent program has on this computer: its skills and what it remembers.
#[tauri::command]
pub async fn library_program(program: String) -> Result<ProgramLibrary, String> {
    Ok(program_library(&crate::home(), &program))
}

/// The text of a skill or note the library lists. Markdown files in the programs' folders only.
#[tauri::command]
pub async fn library_read(path: String) -> Result<String, String> {
    use std::io::Read;
    let file = PathBuf::from(&path);
    if !readable(&crate::home(), &know_dir()?, &file) {
        return Err("The library only opens skills and notes.".into());
    }
    let mut buf = Vec::new();
    fs::File::open(&file).map_err(|e| e.to_string())?.take(400_000).read_to_end(&mut buf).map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

/// The folder Cube's memory, skills and wiki live in. Makes it on first use.
#[tauri::command]
pub async fn knowledge_dir() -> Result<String, String> {
    Ok(know_dir()?.to_string_lossy().into_owned())
}

/// Brings in what Claude Code, Codex and Hermes remember. Reads their folders; changes nothing there.
#[tauri::command]
pub async fn knowledge_import() -> Result<Vec<Imported>, String> {
    import_into(&crate::home(), &know_dir()?)
}

/// Writes Cube's memory and skills out to the chosen programs.
#[tauri::command]
pub async fn knowledge_export(targets: Vec<String>) -> Result<Vec<Exported>, String> {
    export_from(&crate::home(), &know_dir()?, &targets)
}

/// Removes files or skill folders inside the knowledge folder (a note the person deletes, an
/// inbox file a job has read). Paths are relative to that folder and cannot leave it.
#[tauri::command]
pub async fn knowledge_remove(rels: Vec<String>) -> Result<(), String> {
    let dir = know_dir()?;
    for rel in rels {
        let path = Path::new(&rel);
        if rel.is_empty() || path.is_absolute() || path.components().any(|c| !matches!(c, std::path::Component::Normal(_))) {
            return Err("That is not a path inside the knowledge folder.".into());
        }
        let full = dir.join(path);
        if full.is_dir() {
            fs::remove_dir_all(&full).map_err(|e| e.to_string())?;
        } else if full.is_file() {
            fs::remove_file(&full).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("cube-knowledge-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn put(path: &Path, text: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    #[test]
    fn imports_from_all_three_and_changes_nothing_there() {
        let home = temp("import-home");
        let know = temp("import-know");
        put(&home.join(".claude/CLAUDE.md"), "global");
        put(&home.join(".claude/projects/-a/memory/one.md"), "---\nname: one\n---\nfact");
        put(&home.join(".claude/projects/-a/memory/MEMORY.md"), "- index");
        put(&home.join(".claude/projects/-b/memory/two.md"), "fact two");
        put(&home.join(".claude/projects/-b/notes.md"), "not memory");
        put(&home.join(".codex/AGENTS.md"), "codex rules");
        put(&home.join(".codex/memories/deep/x.md"), "codex memory");
        put(&home.join(".hermes/memories/MEMORY.md"), "a\n§\nb");
        put(&home.join(".hermes/memories/USER.md"), "user");
        let got = import_into(&home, &know).unwrap();
        assert_eq!(got, vec![
            Imported { source: "claude".into(), notes: 3 },
            Imported { source: "codex".into(), notes: 2 },
            Imported { source: "hermes".into(), notes: 2 },
        ]);
        let into = know.join("memory/imported");
        let claude = fs::read_to_string(into.join("claude-01.md")).unwrap();
        assert!(claude.starts_with("# Notes brought in from Claude Code (1 of 1)\n"));
        assert!(claude.contains("<!-- note: -a/one.md -->") && claude.contains("fact two") && !claude.contains("- index") && !claude.contains("not memory"));
        assert!(fs::read_to_string(into.join("codex-01.md")).unwrap().contains("<!-- note: memories/deep/x.md -->\n\ncodex memory"));
        assert!(fs::read_to_string(into.join("hermes-01.md")).unwrap().contains("a\n§\nb"));
        // A few files, however many notes there are.
        assert_eq!(fs::read_dir(&into).unwrap().count(), 3);
        let listing = list(&know);
        assert_eq!(listing.imported, 7);
        assert_eq!(listing.batches, vec!["memory/imported/claude-01.md", "memory/imported/codex-01.md", "memory/imported/hermes-01.md"]);
        // A second import replaces the first instead of piling up, an older single-file import included.
        fs::write(into.join("claude.md"), "left by an older version").unwrap();
        fs::remove_file(home.join(".claude/projects/-b/memory/two.md")).unwrap();
        import_into(&home, &know).unwrap();
        assert!(!fs::read_to_string(into.join("claude-01.md")).unwrap().contains("fact two"));
        assert!(!into.join("claude.md").exists());
        assert_eq!(fs::read_to_string(home.join(".claude/CLAUDE.md")).unwrap(), "global");
        // A program with nothing left to bring in leaves no file behind.
        fs::remove_dir_all(home.join(".hermes")).unwrap();
        import_into(&home, &know).unwrap();
        assert!(!into.join("hermes-01.md").exists());
    }

    #[test]
    fn splits_a_large_import_into_batches_that_keep_notes_whole() {
        let home = temp("batch-home");
        let know = temp("batch-know");
        for i in 0..5 {
            put(&home.join(format!(".claude/projects/-p/memory/n{i}.md")), &format!("note {i} {}", "x".repeat(25_000)));
        }
        let got = import_into(&home, &know).unwrap();
        assert_eq!(got[0], Imported { source: "claude".into(), notes: 5 });
        let listing = list(&know);
        assert_eq!(listing.batches.len(), 3);
        assert_eq!(listing.imported, 5);
        for b in &listing.batches {
            let text = fs::read_to_string(know.join(b)).unwrap();
            assert!(text.len() <= BATCH + 200 && text.matches(NOTE_MARK).count() >= 1);
        }
    }

    #[test]
    fn a_block_is_added_once_and_replaced_after() {
        let first = with_block("My own rules.\n", "memory v1");
        assert_eq!(first, format!("My own rules.\n\n{BLOCK_START}\nmemory v1\n{BLOCK_END}\n"));
        let second = with_block(&format!("{first}\nMore of mine.\n"), "memory v2");
        assert_eq!(second, format!("My own rules.\n\n{BLOCK_START}\nmemory v2\n{BLOCK_END}\n\nMore of mine.\n"));
        assert_eq!(with_block("", "m"), format!("{BLOCK_START}\nm\n{BLOCK_END}\n"));
    }

    #[test]
    fn exports_memory_and_skills_without_touching_what_is_not_cubes() {
        let home = temp("export-home");
        let know = temp("export-know");
        put(&know.join("memory/likes-short-replies.md"), "---\nname: likes short replies\ntype: feedback\n---\nKeep answers to a few lines.");
        put(&know.join("memory/MEMORY.md"), "- index");
        put(&know.join("memory/imported/claude-01.md"), "<!-- note: x.md -->\n\nraw import, not exported");
        put(&know.join("skills/weekly-report/SKILL.md"), "---\nname: weekly-report\ndescription: d\n---\nsteps");
        put(&know.join("skills/weekly-report/ref/template.md"), "t");
        put(&home.join(".claude/skills/their-own/SKILL.md"), "theirs");
        put(&home.join(".claude/skills/cube-old/SKILL.md"), "an old one of ours");
        put(&home.join(".claude/skills/cube-old/.cube-managed"), "");
        put(&home.join(".claude/skills/cube-weekly-report/SKILL.md"), "someone else's with our name");
        put(&home.join(".codex/AGENTS.md"), "Codex rules of mine.\n");
        fs::create_dir_all(home.join(".hermes")).unwrap();

        let got = export_from(&home, &know, &["claude".into(), "codex".into(), "hermes".into(), "nope".into()]).unwrap();
        assert_eq!(got.len(), 3);

        let rules = fs::read_to_string(home.join(".claude/rules/cube-memory.md")).unwrap();
        assert!(rules.contains("## likes short replies (feedback)") && rules.contains("Keep answers to a few lines."));
        assert!(!rules.contains("raw import"));
        assert_eq!(fs::read_to_string(home.join(".claude/skills/their-own/SKILL.md")).unwrap(), "theirs");
        assert!(!home.join(".claude/skills/cube-old").exists());
        // A folder with our name that we did not write is left alone.
        assert_eq!(fs::read_to_string(home.join(".claude/skills/cube-weekly-report/SKILL.md")).unwrap(), "someone else's with our name");

        let agents = fs::read_to_string(home.join(".codex/AGENTS.md")).unwrap();
        assert!(agents.starts_with("Codex rules of mine.\n\n<!-- cube:memory:start -->"));
        assert!(home.join(".codex/skills/cube-weekly-report/ref/template.md").is_file());
        assert!(home.join(".codex/skills/cube-weekly-report/.cube-managed").is_file());

        assert!(fs::read_to_string(home.join(".hermes/skills/cube/cube-memory/SKILL.md")).unwrap().starts_with("---\nname: cube-memory\n"));
        assert!(home.join(".hermes/skills/cube/cube-weekly-report/SKILL.md").is_file());

        // Exporting again replaces the block instead of adding a second one.
        export_from(&home, &know, &["codex".into()]).unwrap();
        assert_eq!(fs::read_to_string(home.join(".codex/AGENTS.md")).unwrap().matches(BLOCK_START).count(), 1);
    }

    #[test]
    fn lists_what_is_there_and_what_a_job_marked_for_removal() {
        let know = temp("list-know");
        put(&know.join("memory/a.md"), "---\nname: uses pnpm\ndescription: never npm\ntype: feedback\nsource: cube\n---\nUse pnpm.");
        put(&know.join("memory/gone.md"), "DELETE\n");
        put(&know.join("memory/MEMORY.md"), "- index");
        put(&know.join("memory/imported/claude-01.md"), "# Notes\n\n<!-- note: -p/x.md -->\n\nraw\n");
        put(&know.join("skills/report/SKILL.md"), "---\nname: report\ndescription: weekly report\n---\nsteps");
        put(&know.join("skills/old/SKILL.md"), "DELETE");
        put(&know.join("wiki/Projects.md"), "# Projects\n\nThe ones under way.");
        put(&know.join("wiki/index.md"), "# Index\n\n- [Projects](Projects.md)");
        put(&know.join("inbox/memory-1.md"), "new");
        let got = list(&know);
        assert_eq!(got.memory.len(), 1);
        assert_eq!((got.memory[0].name.as_str(), got.memory[0].description.as_str(), got.memory[0].kind.as_str()), ("uses pnpm", "never npm", "feedback"));
        assert_eq!(got.skills.iter().map(|e| e.rel.as_str()).collect::<Vec<_>>(), vec!["skills/report"]);
        assert_eq!(got.wiki.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(), vec!["Index", "Projects"]);
        assert_eq!(got.wiki[1].description, "The ones under way.");
        assert_eq!(got.imported, 1);
        assert_eq!(got.inbox, vec!["inbox/memory-1.md"]);
        let mut marked = got.marked.clone();
        marked.sort();
        assert_eq!(marked, vec!["memory/gone.md", "skills/old"]);
    }

    #[test]
    fn shows_a_programs_skills_and_notes_and_reads_nothing_else() {
        let home = temp("lib-home");
        let know = temp("lib-know");
        put(&home.join(".claude/skills/docs/SKILL.md"), "---\nname: docs\ndescription: Writes documents\n---\nbody");
        put(&home.join(".claude/skills/.hidden/SKILL.md"), "no");
        put(&home.join(".claude/skills/folded/SKILL.md"), "---\nname: folded\ndescription: >\n  Spread over\n  two lines.\nversion: 1\n---\nbody");
        put(&home.join(".claude/CLAUDE.md"), "Be brief.");
        put(&home.join(".claude/projects/-p/memory/likes-tests.md"), "---\nname: likes tests\n---\nAlways test.");
        put(&home.join(".claude/projects/-p/memory/MEMORY.md"), "- index");
        put(&home.join(".hermes/skills/devops/deploy/SKILL.md"), "# Deploy\n\nShips the app.");
        put(&home.join(".hermes/memories/USER.md"), "user");
        let claude = program_library(&home, "claude");
        assert_eq!(claude.skills.iter().map(|s| (s.name.as_str(), s.about.as_str())).collect::<Vec<_>>(), vec![("docs", "Writes documents"), ("folded", "Spread over two lines.")]);
        assert_eq!(claude.memory.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(), vec!["CLAUDE.md", "likes tests"]);
        let hermes = program_library(&home, "hermes");
        assert_eq!((hermes.skills[0].name.as_str(), hermes.skills[0].about.as_str()), ("deploy", "Ships the app."));
        assert_eq!(hermes.memory.len(), 1);
        assert!(program_library(&home, "nope").skills.is_empty());

        assert!(readable(&home, &know, &home.join(".claude/skills/docs/SKILL.md")));
        assert!(readable(&home, &know, &know.join("wiki/index.md")));
        // Not markdown, not inside the shown folders, or trying to climb out.
        assert!(!readable(&home, &know, &home.join(".claude/.credentials.json")));
        assert!(!readable(&home, &know, &home.join(".hermes/auth.json")));
        assert!(!readable(&home, &know, &home.join(".ssh/notes.md")));
        assert!(!readable(&home, &know, &home.join(".claude/skills/../../.ssh/x.md")));
        assert!(!readable(&home, &know, Path::new("relative.md")));
    }

    #[test]
    fn says_so_when_a_program_is_not_there_or_there_is_nothing_to_export() {
        let home = temp("empty-home");
        let know = temp("empty-know");
        let got = export_from(&home, &know, &["claude".into()]).unwrap();
        assert_eq!(got[0].memory, "This program is not set up on this computer.");
        fs::create_dir_all(home.join(".claude")).unwrap();
        let got = export_from(&home, &know, &["claude".into()]).unwrap();
        assert_eq!(got[0].memory, "No notes to export yet.");
        assert!(!home.join(".claude/rules/cube-memory.md").exists());
    }
}
