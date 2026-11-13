//! Cube desktop backend.
//!
//! Starts local agent CLIs (Codex, Claude Code, Hermes) as child processes, streams their output
//! to the window line by line, and lists/reads the files they produce inside the CubeSpaces folder.
//! It also reports what each CLI already has set up (skills, MCP servers, plugins), by name only.

use std::{
    collections::HashMap,
    fs,
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{Arc, Mutex, OnceLock},
    thread,
    time::{Duration, UNIX_EPOCH},
};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

mod browser;
mod drive;
mod knowledge;
mod sessions;
mod usage;
mod workspace;
mod picture;
mod remote;
mod slack;
mod team;
mod update;

/// Running agent processes, keyed by run id.
#[derive(Default)]
struct Runs(Mutex<HashMap<String, Arc<Mutex<Child>>>>);

/// Open input pipes of the runs that take answers while they work, keyed by run id.
#[derive(Default)]
struct Inputs(Mutex<HashMap<String, ChildStdin>>);

#[derive(Clone, Serialize)]
struct AgentEvent {
    run_id: String,
    /// "stdout", "stderr" or "exit".
    stream: String,
    line: String,
    code: Option<i32>,
}

#[derive(Serialize)]
struct FileEntry {
    path: String,
    rel: String,
    size: u64,
    mtime: u64,
}

fn home() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| ".".into()))
}

/// Everything Cube reads or writes lives under ~/CubeSpaces. Not ~/Cube: macOS file names are
/// case-insensitive, so that could collide with a folder named `cube`.
pub(crate) fn root() -> PathBuf {
    home().join("CubeSpaces")
}

/// A desktop app does not inherit the terminal PATH, so ask the login shell once.
pub(crate) fn shell_path() -> &'static str {
    static PATH: OnceLock<String> = OnceLock::new();
    PATH.get_or_init(|| {
        let mut parts: Vec<String> = Vec::new();
        let marker = "__CUBE_PATH__";
        if let Ok(out) = Command::new("/bin/zsh")
            .args(["-ilc", "echo __CUBE_PATH__$PATH"])
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
        {
            let text = String::from_utf8_lossy(&out.stdout);
            if let Some(i) = text.rfind(marker) {
                let line = text[i + marker.len()..].lines().next().unwrap_or("").trim();
                if !line.is_empty() {
                    parts.push(line.to_string());
                }
            }
        }
        if let Ok(p) = std::env::var("PATH") {
            parts.push(p);
        }
        parts.push(format!("{}/.local/bin", home().display()));
        parts.push("/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin".into());
        parts.join(":")
    })
}

/// Resolves a path and refuses anything outside the places Cube may work in: ~/CubeSpaces, and
/// the folders the person opened as workspaces (workspace.rs).
pub(crate) fn inside_root(p: &Path) -> Result<PathBuf, String> {
    let real = p.canonicalize().map_err(|e| e.to_string())?;
    let base = root().canonicalize().map_err(|e| e.to_string())?;
    if real.starts_with(&base) || workspace::holds(&real) {
        Ok(real)
    } else {
        Err("That path is outside the CubeSpaces folder and the folders you opened as workspaces.".into())
    }
}

fn pump<R: Read + Send + 'static>(
    app: AppHandle,
    run_id: String,
    stream: &'static str,
    reader: R,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let mut reader = BufReader::new(reader);
        let mut buf: Vec<u8> = Vec::new();
        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let line = String::from_utf8_lossy(&buf)
                        .trim_end_matches(['\n', '\r'])
                        .to_string();
                    let _ = app.emit(
                        "agent-event",
                        AgentEvent { run_id: run_id.clone(), stream: stream.into(), line, code: None },
                    );
                }
            }
        }
    })
}

#[tauri::command]
async fn agent_start(
    app: AppHandle,
    runs: State<'_, Runs>,
    run_id: String,
    program: String,
    args: Vec<String>,
    cwd: String,
    input: Option<String>,
) -> Result<(), String> {
    let dir = inside_root(Path::new(&cwd))?;
    let mut cmd = Command::new(&program);
    cmd.args(&args)
        .current_dir(&dir)
        .env("PATH", shell_path())
        // With `input`, the run reads its request from stdin and the pipe stays open for answers
        // (see agent_write) until agent_end_input closes it.
        .stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // Own process group, so stopping a run also stops whatever the agent spawned.
        cmd.process_group(0);
    }
    let mut child = cmd.spawn().map_err(|e| format!("Could not start {program}: {e}"))?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;
    if let (Some(text), Some(mut pipe)) = (input, child.stdin.take()) {
        pipe.write_all(text.as_bytes()).and_then(|_| pipe.flush()).map_err(|e| e.to_string())?;
        app.state::<Inputs>().0.lock().unwrap().insert(run_id.clone(), pipe);
    }
    let child = Arc::new(Mutex::new(child));
    runs.0.lock().unwrap().insert(run_id.clone(), child.clone());

    let out = pump(app.clone(), run_id.clone(), "stdout", stdout);
    let err = pump(app.clone(), run_id.clone(), "stderr", stderr);
    thread::spawn(move || {
        let _ = out.join();
        let _ = err.join();
        let code = loop {
            let mut guard = child.lock().unwrap();
            match guard.try_wait() {
                Ok(Some(status)) => break status.code(),
                Ok(None) => {}
                Err(_) => break None,
            }
            drop(guard);
            thread::sleep(Duration::from_millis(40));
        };
        app.state::<Runs>().0.lock().unwrap().remove(&run_id);
        app.state::<Inputs>().0.lock().unwrap().remove(&run_id);
        let _ = app.emit(
            "agent-event",
            AgentEvent { run_id, stream: "exit".into(), line: String::new(), code },
        );
    });
    Ok(())
}

#[tauri::command]
async fn agent_stop(runs: State<'_, Runs>, run_id: String) -> Result<(), String> {
    let child = runs.0.lock().unwrap().get(&run_id).cloned();
    if let Some(child) = child {
        let mut guard = child.lock().unwrap();
        #[cfg(unix)]
        {
            let _ = Command::new("kill").args(["-TERM", &format!("-{}", guard.id())]).status();
        }
        let _ = guard.kill();
    }
    Ok(())
}

/// Sends one line to a running agent, for example the answer to a permission request.
#[tauri::command]
async fn agent_write(inputs: State<'_, Inputs>, run_id: String, line: String) -> Result<(), String> {
    let mut map = inputs.0.lock().unwrap();
    let pipe = map.get_mut(&run_id).ok_or("That agent is no longer running.")?;
    pipe.write_all(line.as_bytes())
        .and_then(|_| pipe.write_all(b"\n"))
        .and_then(|_| pipe.flush())
        .map_err(|e| e.to_string())
}

/// Closes a run's input, which tells the agent there is nothing more to read so it can exit.
#[tauri::command]
async fn agent_end_input(inputs: State<'_, Inputs>, run_id: String) -> Result<(), String> {
    inputs.0.lock().unwrap().remove(&run_id);
    Ok(())
}

/// Writes a line from the window to the app's stderr, so front-end errors can be read from a terminal.
#[tauri::command]
fn log_line(line: String) {
    eprintln!("[cube] {line}");
}

/// Reports which agent programs are installed, by looking for them on the login shell's PATH.
#[tauri::command]
async fn detect_engines() -> Result<Vec<String>, String> {
    let dirs: Vec<PathBuf> = shell_path().split(':').filter(|d| !d.is_empty()).map(PathBuf::from).collect();
    Ok(["claude", "codex", "hermes"]
        .into_iter()
        .filter(|name| dirs.iter().any(|d| d.join(name).is_file()))
        .map(String::from)
        .collect())
}

/// Browsers with a window of their own that a cube drives from the command line, as far as they
/// are installed. Only the names listed here are looked for.
#[tauri::command]
async fn tools_found() -> Result<Vec<String>, String> {
    let dirs: Vec<PathBuf> = shell_path().split(':').filter(|d| !d.is_empty()).map(PathBuf::from).collect();
    Ok(["aside"]
        .into_iter()
        .filter(|name| dirs.iter().any(|d| d.join(name).is_file()))
        .map(String::from)
        .collect())
}

/// Creates ~/CubeSpaces/<name> if needed and returns its path.
#[tauri::command]
async fn ensure_space(name: String) -> Result<String, String> {
    let safe: String =
        name.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').collect();
    if safe.is_empty() {
        return Err("A space needs a name made of letters, digits, - or _.".into());
    }
    let dir = root().join(safe);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().into_owned())
}

fn walk(base: &Path, dir: &Path, depth: usize, out: &mut Vec<FileEntry>) {
    if depth > 6 || out.len() >= 2000 {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        // Hidden files, build folders, and the lock files Office leaves beside an open document.
        if name.starts_with('.') || name.starts_with("~$") || matches!(name.as_str(), "node_modules" | "target" | "__pycache__") {
            continue;
        }
        let path = entry.path();
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_dir() {
            walk(base, &path, depth + 1, out);
        } else if meta.is_file() {
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            out.push(FileEntry {
                rel: path.strip_prefix(base).unwrap_or(&path).to_string_lossy().into_owned(),
                path: path.to_string_lossy().into_owned(),
                size: meta.len(),
                mtime,
            });
        }
    }
}

#[tauri::command]
async fn list_files(dir: String) -> Result<Vec<FileEntry>, String> {
    let base = inside_root(Path::new(&dir))?;
    let mut out = Vec::new();
    walk(&base, &base, 0, &mut out);
    Ok(out)
}

#[tauri::command]
async fn read_text(path: String, max_bytes: Option<u64>) -> Result<String, String> {
    let real = inside_root(Path::new(&path))?;
    let file = fs::File::open(&real).map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    file.take(max_bytes.unwrap_or(400_000)).read_to_end(&mut buf).map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

/// Saves text the person edited on the Stage. The file must sit inside ~/CubeSpaces; its folder
/// must already exist, so a path cannot be used to climb out before the file is there.
#[tauri::command]
async fn write_text(path: String, content: String) -> Result<u64, String> {
    let target = PathBuf::from(&path);
    let name = target.file_name().ok_or("That is not a file path.")?.to_owned();
    let dir = inside_root(target.parent().ok_or("That is not a file path.")?)?;
    let file = dir.join(name);
    // An existing file may be a link pointing elsewhere: resolve it and check again.
    let file = if file.exists() { inside_root(&file)? } else { file };
    fs::write(&file, content.as_bytes()).map_err(|e| e.to_string())?;
    let mtime = fs::metadata(&file)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Ok(mtime)
}

/// A path given relative to a conversation folder: plain names only, so it cannot climb out.
fn safe_rel(rel: &str) -> Result<PathBuf, String> {
    let path = Path::new(rel);
    let plain = !rel.trim().is_empty()
        && path.components().all(|c| matches!(c, std::path::Component::Normal(_)))
        && !path.components().any(|c| c.as_os_str().to_string_lossy().starts_with('.'));
    if plain {
        Ok(path.to_path_buf())
    } else {
        Err("Use a plain name like notes.md or src/app.py.".into())
    }
}

/// Makes the folders a new file needs, then checks the result still sits inside ~/CubeSpaces.
fn parent_inside(base: &Path, rel: &Path) -> Result<PathBuf, String> {
    let target = base.join(rel);
    let parent = target.parent().ok_or("That is not a file path.")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let parent = inside_root(parent)?;
    Ok(parent.join(target.file_name().ok_or("That is not a file path.")?))
}

/// Moves a file to the macOS Trash, so a delete can be taken back from the Finder.
pub(crate) fn to_trash(file: &Path) -> Result<(), String> {
    let name = file.file_name().ok_or("That is not a file path.")?.to_string_lossy().into_owned();
    let trash = home().join(".Trash");
    let mut dest = trash.join(&name);
    let mut n = 1;
    while dest.exists() {
        n += 1;
        dest = trash.join(format!("{name} {n}"));
    }
    fs::rename(file, &dest).map_err(|e| format!("Could not move {name} to the Trash: {e}"))
}

#[tauri::command]
async fn create_file(dir: String, rel: String) -> Result<String, String> {
    let base = inside_root(Path::new(&dir))?;
    let file = parent_inside(&base, &safe_rel(&rel)?)?;
    if file.exists() {
        return Err("A file with that name already exists.".into());
    }
    fs::write(&file, b"").map_err(|e| e.to_string())?;
    Ok(file.to_string_lossy().into_owned())
}

#[tauri::command]
async fn rename_path(dir: String, from: String, to: String) -> Result<(), String> {
    let base = inside_root(Path::new(&dir))?;
    let source = inside_root(&base.join(safe_rel(&from)?))?;
    let dest = parent_inside(&base, &safe_rel(&to)?)?;
    if dest.exists() {
        return Err("A file with that name already exists.".into());
    }
    fs::rename(&source, &dest).map_err(|e| e.to_string())
}

#[tauri::command]
async fn trash_path(dir: String, rel: String) -> Result<(), String> {
    let base = inside_root(Path::new(&dir))?;
    let target = inside_root(&base.join(safe_rel(&rel)?))?;
    // A workspace is the person's own folder, with more in it than Cube made: a file in it can go
    // to the Trash, the folder itself never.
    if workspace::roots().iter().any(|r| r.starts_with(&target)) {
        return Err("That is a folder you opened as a workspace. Cube does not move it to the Trash.".into());
    }
    to_trash(&target)
}

#[derive(Serialize)]
struct Hit {
    rel: String,
    line: u32,
    col: u32,
    text: String,
}

/// Finds a piece of text in every text file of a conversation folder. Lower-case queries match
/// any case; a query with a capital letter matches exactly.
#[tauri::command]
async fn search_text(dir: String, query: String) -> Result<Vec<Hit>, String> {
    let base = inside_root(Path::new(&dir))?;
    let mut hits = Vec::new();
    if query.trim().is_empty() {
        return Ok(hits);
    }
    let exact = query.chars().any(|c| c.is_uppercase());
    let needle = if exact { query.clone() } else { query.to_lowercase() };
    let mut files = Vec::new();
    walk(&base, &base, 0, &mut files);
    files.sort_by(|a, b| a.rel.cmp(&b.rel));
    for f in files {
        if f.size > 1_000_000 {
            continue;
        }
        let Ok(bytes) = fs::read(&f.path) else { continue };
        // A zero byte near the start means this is not text.
        if bytes.iter().take(2000).any(|b| *b == 0) {
            continue;
        }
        let text = String::from_utf8_lossy(&bytes);
        for (i, line) in text.lines().enumerate() {
            let found = if exact { line.find(&needle) } else { line.to_lowercase().find(&needle) };
            let Some(at) = found else { continue };
            // `at` counts bytes; the editor counts characters. Lower-casing can shift bytes, so
            // fall back to the start of the line when the offset no longer lands on a character.
            let col = line.get(..at).map(|pre| pre.chars().count()).unwrap_or(0) as u32 + 1;
            hits.push(Hit { rel: f.rel.clone(), line: i as u32 + 1, col, text: clip(line, 180) });
            if hits.len() >= 400 {
                return Ok(hits);
            }
        }
    }
    Ok(hits)
}

// ---- Checkpoints: copies of a conversation folder, so the person can put it back ----

#[derive(Serialize, serde::Deserialize)]
struct Manifest {
    /// Every file that was in the folder, and whether a copy of it was kept.
    files: Vec<(String, bool)>,
}

fn plain_name(name: &str) -> Result<String, String> {
    let safe: String = name.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').collect();
    if safe.is_empty() || safe != name {
        Err("That name is not valid.".into())
    } else {
        Ok(safe)
    }
}

fn checkpoint_dir(conv: &str) -> Result<PathBuf, String> {
    Ok(root().join(".checkpoints").join(plain_name(conv)?))
}

/// Copies the conversation folder as it is now. Very large files are listed but not copied, and
/// only the newest 20 checkpoints of a conversation are kept.
#[tauri::command]
async fn checkpoint_save(conv: String, id: String) -> Result<u32, String> {
    let src = inside_root(&root().join(plain_name(&conv)?))?;
    let all = checkpoint_dir(&conv)?;
    let dst = all.join(plain_name(&id)?);
    fs::create_dir_all(dst.join("files")).map_err(|e| e.to_string())?;
    let mut files = Vec::new();
    walk(&src, &src, 0, &mut files);
    let mut manifest = Manifest { files: Vec::new() };
    let mut total: u64 = 0;
    let mut copied = 0;
    for f in files {
        let keep = f.size <= 20_000_000 && total + f.size <= 200_000_000;
        if keep {
            let to = dst.join("files").join(&f.rel);
            if let Some(parent) = to.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            fs::copy(&f.path, &to).map_err(|e| e.to_string())?;
            total += f.size;
            copied += 1;
        }
        manifest.files.push((f.rel, keep));
    }
    fs::write(dst.join("manifest.json"), serde_json::to_vec(&manifest).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;

    let mut old: Vec<(std::time::SystemTime, PathBuf)> = fs::read_dir(&all)
        .map_err(|e| e.to_string())?
        .flatten()
        .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path())))
        .collect();
    old.sort_by(|a, b| b.0.cmp(&a.0));
    for (_, path) in old.into_iter().skip(20) {
        let _ = fs::remove_dir_all(path);
    }
    Ok(copied)
}

/// Puts the conversation folder back to a checkpoint: saved files are copied back, and files
/// that did not exist then go to the Trash. Files too large to have been copied are left alone.
#[tauri::command]
async fn checkpoint_restore(conv: String, id: String) -> Result<u32, String> {
    let dst = inside_root(&root().join(plain_name(&conv)?))?;
    let from = checkpoint_dir(&conv)?.join(plain_name(&id)?);
    let manifest: Manifest = serde_json::from_slice(&fs::read(from.join("manifest.json")).map_err(|_| "That checkpoint is gone.")?)
        .map_err(|e| e.to_string())?;
    let known: std::collections::HashSet<&str> = manifest.files.iter().map(|(rel, _)| rel.as_str()).collect();
    let mut now = Vec::new();
    walk(&dst, &dst, 0, &mut now);
    let mut touched = 0;
    for f in &now {
        if !known.contains(f.rel.as_str()) {
            to_trash(Path::new(&f.path))?;
            touched += 1;
        }
    }
    for (rel, kept) in &manifest.files {
        if !kept {
            continue;
        }
        let source = from.join("files").join(rel);
        let target = dst.join(rel);
        // Skip files that are already the same, so their modified time does not change for nothing.
        if fs::read(&source).ok() == fs::read(&target).ok() {
            continue;
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::copy(&source, &target).map_err(|e| e.to_string())?;
        touched += 1;
    }
    Ok(touched)
}

// ---- Terminal: a real shell in the conversation folder, for the person ----

struct Term {
    master: Box<dyn portable_pty::MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
}

#[derive(Default)]
struct Terms(Mutex<HashMap<String, Term>>);

#[derive(Clone, Serialize)]
struct TermEvent {
    id: String,
    data: String,
    /// True once the shell has exited.
    ended: bool,
}

/// Starts the person's login shell in a conversation folder. Opening one that is already
/// running does nothing, so the panel can be closed and reopened without losing the session.
#[tauri::command]
async fn term_open(app: AppHandle, terms: State<'_, Terms>, id: String, cwd: String, cols: u16, rows: u16) -> Result<(), String> {
    if terms.0.lock().unwrap().contains_key(&id) {
        return Ok(());
    }
    let dir = inside_root(Path::new(&cwd))?;
    let size = portable_pty::PtySize { rows: rows.max(2), cols: cols.max(2), pixel_width: 0, pixel_height: 0 };
    let pair = portable_pty::native_pty_system().openpty(size).map_err(|e| e.to_string())?;
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let mut cmd = portable_pty::CommandBuilder::new(shell);
    cmd.arg("-l");
    cmd.cwd(&dir);
    cmd.env("TERM", "xterm-256color");
    cmd.env("PATH", shell_path());
    // An app started from the Finder has no locale; without one, non-English text breaks.
    if std::env::var("LANG").is_err() {
        cmd.env("LANG", "en_US.UTF-8");
    }
    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    terms.0.lock().unwrap().insert(id.clone(), Term { master: pair.master, writer, child });

    thread::spawn(move || {
        let mut buf = [0u8; 8192];
        // Bytes of a character cut in half by a read, kept for the next one.
        let mut carry: Vec<u8> = Vec::new();
        loop {
            let n = match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            carry.extend_from_slice(&buf[..n]);
            let good = match std::str::from_utf8(&carry) {
                Ok(_) => carry.len(),
                Err(e) if e.error_len().is_none() => e.valid_up_to(),
                Err(_) => carry.len(),
            };
            let data = String::from_utf8_lossy(&carry[..good]).into_owned();
            carry.drain(..good);
            let _ = app.emit("term-data", TermEvent { id: id.clone(), data, ended: false });
        }
        app.state::<Terms>().0.lock().unwrap().remove(&id);
        let _ = app.emit("term-data", TermEvent { id, data: String::new(), ended: true });
    });
    Ok(())
}

#[tauri::command]
async fn term_write(terms: State<'_, Terms>, id: String, data: String) -> Result<(), String> {
    let mut map = terms.0.lock().unwrap();
    let term = map.get_mut(&id).ok_or("That terminal has ended.")?;
    term.writer.write_all(data.as_bytes()).and_then(|_| term.writer.flush()).map_err(|e| e.to_string())
}

#[tauri::command]
async fn term_resize(terms: State<'_, Terms>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    if let Some(term) = terms.0.lock().unwrap().get(&id) {
        let size = portable_pty::PtySize { rows: rows.max(2), cols: cols.max(2), pixel_width: 0, pixel_height: 0 };
        term.master.resize(size).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn term_close(terms: State<'_, Terms>, id: String) -> Result<(), String> {
    if let Some(mut term) = terms.0.lock().unwrap().remove(&id) {
        let _ = term.child.kill();
    }
    Ok(())
}

#[derive(Serialize, Default)]
struct HarnessItem {
    name: String,
    about: String,
}

/// What an agent program already has set up on this computer. Names and descriptions only:
/// commands, URLs, tokens and environment values in those settings are never read out.
#[derive(Serialize, Default)]
struct Harness {
    model: String,
    effort: String,
    skills: Vec<HarnessItem>,
    mcp: Vec<HarnessItem>,
    plugins: Vec<HarnessItem>,
}

fn clip(text: &str, max: usize) -> String {
    let t = text.trim().trim_matches(|c| c == '"' || c == '\'').trim();
    if t.chars().count() <= max {
        t.to_string()
    } else {
        format!("{}…", t.chars().take(max - 1).collect::<String>())
    }
}

/// The `description:` of a SKILL.md, from its front matter.
fn skill_about(file: &Path) -> String {
    let Ok(f) = fs::File::open(file) else { return String::new() };
    // Read as bytes: cutting at a fixed size can split a character, which a string read rejects.
    let mut bytes = Vec::new();
    let _ = f.take(6000).read_to_end(&mut bytes);
    let head = String::from_utf8_lossy(&bytes);
    let mut lines = head.lines();
    while let Some(line) = lines.next() {
        let Some(rest) = line.strip_prefix("description:") else { continue };
        let rest = rest.trim();
        if rest.is_empty() || rest.starts_with('>') || rest.starts_with('|') {
            // A folded value: the text starts on the next line.
            return clip(lines.next().unwrap_or(""), 160);
        }
        return clip(rest, 160);
    }
    String::new()
}

/// Folders that hold a SKILL.md, up to three levels down (Hermes groups skills by topic).
fn skills_in(dir: &Path, depth: usize, out: &mut Vec<HarnessItem>) {
    if depth > 3 || out.len() >= 400 {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let path = entry.path();
        // fs::metadata follows links: skills are often linked in from elsewhere.
        if name.starts_with('.') || !fs::metadata(&path).map(|m| m.is_dir()).unwrap_or(false) {
            continue;
        }
        let file = path.join("SKILL.md");
        if file.is_file() {
            out.push(HarnessItem { name, about: skill_about(&file) });
        } else {
            skills_in(&path, depth + 1, out);
        }
    }
}

fn read_json(path: PathBuf) -> serde_json::Value {
    fs::read_to_string(path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

fn claude_harness() -> Harness {
    let mut h = Harness::default();
    let dir = home().join(".claude");
    skills_in(&dir.join("skills"), 0, &mut h.skills);
    let settings = read_json(dir.join("settings.json"));
    h.model = settings["model"].as_str().unwrap_or("").to_string();
    if let Some(servers) = read_json(home().join(".claude.json"))["mcpServers"].as_object() {
        for (name, cfg) in servers {
            let about = if cfg.get("url").is_some() { "remote" } else { "runs on this computer" };
            h.mcp.push(HarnessItem { name: name.clone(), about: about.into() });
        }
    }
    if let Some(plugins) = read_json(dir.join("plugins/installed_plugins.json"))["plugins"].as_object() {
        for id in plugins.keys() {
            let (name, market) = id.split_once('@').unwrap_or((id.as_str(), ""));
            let on = settings["enabledPlugins"][id.as_str()].as_bool().unwrap_or(false);
            let about = format!("{market}{}", if on { "" } else { " · turned off" });
            h.plugins.push(HarnessItem { name: name.into(), about: about.trim_start_matches(" · ").into() });
        }
    }
    h
}

fn codex_harness() -> Harness {
    let mut h = Harness::default();
    let dir = home().join(".codex");
    skills_in(&dir.join("skills"), 0, &mut h.skills);
    let text = fs::read_to_string(dir.join("config.toml")).unwrap_or_default();
    // Which list the section being read belongs to: 1 = MCP servers, 2 = plugins.
    let mut list = 0;
    let mut top = true;
    for raw in text.lines() {
        let line = raw.trim();
        if let Some(section) = line.strip_prefix('[') {
            top = false;
            list = 0;
            let section = section.trim_end_matches(']');
            if let Some(name) = section.strip_prefix("mcp_servers.") {
                if !name.contains('.') {
                    h.mcp.push(HarnessItem { name: name.trim_matches('"').into(), about: String::new() });
                    list = 1;
                }
            } else if let Some(name) = section.strip_prefix("plugins.") {
                let id = name.trim_matches('"');
                let (name, market) = id.split_once('@').unwrap_or((id, ""));
                h.plugins.push(HarnessItem { name: name.into(), about: market.into() });
                list = 2;
            }
            continue;
        }
        let Some((key, value)) = line.split_once('=') else { continue };
        let (key, value) = (key.trim(), value.trim());
        if top && key == "model" {
            h.model = clip(value, 60);
        } else if top && key == "model_reasoning_effort" {
            h.effort = clip(value, 20);
        } else if key == "enabled" && value == "false" {
            let items = if list == 1 { Some(&mut h.mcp) } else if list == 2 { Some(&mut h.plugins) } else { None };
            if let Some(last) = items.and_then(|v| v.last_mut()) {
                last.about = format!("{} · turned off", last.about).trim_start_matches(" · ").to_string();
            }
        }
    }
    h
}

fn hermes_harness() -> Harness {
    let mut h = Harness::default();
    let dir = home().join(".hermes");
    skills_in(&dir.join("skills"), 0, &mut h.skills);
    if let Ok(entries) = fs::read_dir(dir.join("plugins")) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !name.starts_with('.') && entry.path().is_dir() {
                h.plugins.push(HarnessItem { name, about: String::new() });
            }
        }
    }
    // Only two blocks of config.yaml are read: `model:` for its default, `mcp_servers:` for names.
    let text = fs::read_to_string(dir.join("config.yaml")).unwrap_or_default();
    let mut block = "";
    for line in text.lines() {
        if !line.starts_with(' ') && !line.starts_with('#') && line.contains(':') {
            block = line.split(':').next().unwrap_or("");
            continue;
        }
        let Some(inner) = line.strip_prefix("  ") else { continue };
        if inner.starts_with(' ') || inner.starts_with('#') {
            continue;
        }
        let Some((key, value)) = inner.split_once(':') else { continue };
        if block == "model" && key == "default" {
            h.model = clip(value, 60);
        } else if block == "mcp_servers" {
            h.mcp.push(HarnessItem { name: key.trim().into(), about: String::new() });
        }
    }
    h
}

/// Lists the skills, MCP servers and plugins an agent program has on this computer.
#[tauri::command]
async fn harness(engine: String) -> Result<Harness, String> {
    let mut h = match engine.as_str() {
        "claude" => claude_harness(),
        "codex" => codex_harness(),
        "hermes" => hermes_harness(),
        _ => return Err(format!("Unknown agent program: {engine}")),
    };
    for list in [&mut h.skills, &mut h.mcp, &mut h.plugins] {
        list.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    }
    Ok(h)
}

/// Saves bytes inside a conversation folder: a file the person attached, or an image they edited.
/// `data` is base64. Without `replace`, a taken name gets a number added instead of being overwritten.
/// Returns the path relative to the conversation folder.
#[tauri::command]
async fn write_bytes(dir: String, rel: String, data: String, replace: bool) -> Result<String, String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.as_bytes())
        .map_err(|e| e.to_string())?;
    if bytes.len() > 50_000_000 {
        return Err("That file is larger than 50 MB.".into());
    }
    let base = inside_root(Path::new(&dir))?;
    let mut file = parent_inside(&base, &safe_rel(&rel)?)?;
    if file.exists() {
        if replace {
            file = inside_root(&file)?;
        } else {
            let stem = file.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
            let ext = file.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
            let folder = file.parent().ok_or("That is not a file path.")?.to_path_buf();
            let mut n = 2;
            while file.exists() {
                file = folder.join(format!("{stem}-{n}{ext}"));
                n += 1;
            }
        }
    }
    fs::write(&file, bytes).map_err(|e| e.to_string())?;
    Ok(file.strip_prefix(&base).unwrap_or(&file).to_string_lossy().into_owned())
}

/// Reads a whole file inside ~/CubeSpaces as base64, for the image editor.
#[tauri::command]
async fn read_bytes(path: String) -> Result<String, String> {
    use base64::Engine;
    let real = inside_root(Path::new(&path))?;
    if fs::metadata(&real).map_err(|e| e.to_string())?.len() > 40_000_000 {
        return Err("That file is larger than 40 MB.".into());
    }
    let bytes = fs::read(&real).map_err(|e| e.to_string())?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

/// The JSON files in ~/CubeSpaces/.agents, each describing a program of the person's own that can
/// power a role. Returned as (file name, content); the window checks what is in them.
#[tauri::command]
async fn custom_agents() -> Result<Vec<(String, String)>, String> {
    let dir = root().join(".agents");
    let Ok(entries) = fs::read_dir(&dir) else { return Ok(Vec::new()) };
    let mut out: Vec<(String, String)> = entries
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
        .filter(|e| e.metadata().map(|m| m.is_file() && m.len() < 64_000).unwrap_or(false))
        .filter_map(|e| Some((e.file_name().to_string_lossy().into_owned(), fs::read_to_string(e.path()).ok()?)))
        .collect();
    out.sort();
    out.truncate(40);
    Ok(out)
}

/// Runs a converter without showing anything, and gives up on it after `secs`.
fn run_quiet(cmd: &mut Command, secs: u64) -> bool {
    let Ok(mut child) = cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn() else {
        return false;
    };
    let started = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) if started.elapsed() > Duration::from_secs(secs) => {
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
            Ok(None) => thread::sleep(Duration::from_millis(40)),
            Err(_) => return false,
        }
    }
}

/// What a converter left in a preview folder: Quick Look's own page first, then ours, then a PDF.
fn preview_in(dir: &Path) -> Option<PathBuf> {
    let entries: Vec<PathBuf> = fs::read_dir(dir).ok()?.flatten().map(|e| e.path()).collect();
    if let Some(bundle) = entries.iter().find(|p| p.extension().is_some_and(|x| x == "qlpreview")) {
        // Quick Look names its main file Preview: a page for most documents, sometimes a PDF or a picture.
        if let Some(page) = ["Preview.html", "Preview.pdf", "Preview.png", "Preview.jpg"].iter().map(|n| bundle.join(n)).find(|p| p.is_file()) {
            return Some(page);
        }
    }
    let page = dir.join("page.html");
    if page.is_file() {
        return Some(page);
    }
    entries.into_iter().find(|p| p.is_file() && p.extension().is_some_and(|x| x == "pdf"))
}

/// LibreOffice, when the person has it: it reads formats the system does not (OpenDocument sheets and slides, HWP and more).
fn office() -> Option<PathBuf> {
    [PathBuf::from("/Applications"), home().join("Applications")]
        .into_iter()
        .map(|apps| apps.join("LibreOffice.app/Contents/MacOS/soffice"))
        .find(|p| p.is_file())
}

/// The file as a plain page, if it is text. Reads at most 2 MB of it.
fn text_page(file: &Path) -> Option<String> {
    use std::io::Read;
    let mut bytes = Vec::new();
    fs::File::open(file).ok()?.take(2_000_000).read_to_end(&mut bytes).ok()?;
    if bytes.is_empty() || bytes.iter().take(8192).any(|b| *b == 0) {
        return None;
    }
    let text = String::from_utf8_lossy(&bytes);
    // Mostly undecodable bytes: not text, even without a zero byte.
    if text.chars().filter(|c| *c == '\u{fffd}').count() * 20 > text.chars().count() {
        return None;
    }
    let safe = text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;");
    Some(format!("<!doctype html><meta charset=\"utf-8\"><pre style=\"margin:0;padding:20px;font:13px/1.55 ui-monospace,Menlo,monospace;white-space:pre-wrap;word-break:break-word\">{safe}</pre>"))
}

/// Turns a document the Stage cannot draw itself into something it can show: a page or a PDF.
/// Tries, in order, the system's Quick Look (Word, Excel, PowerPoint, Pages, Numbers, Keynote),
/// the system's text converter (RTF, OpenDocument text), LibreOffice when it is installed
/// (OpenDocument sheets and slides, HWP and other office formats), and last the file as plain
/// text. The result is kept under ~/CubeSpaces/.preview until the file changes.
/// Returns the path of what to show.
#[tauri::command]
async fn quick_look(path: String) -> Result<String, String> {
    use std::hash::{Hash, Hasher};
    let file = inside_root(Path::new(&path))?;
    let meta = fs::metadata(&file).map_err(|e| e.to_string())?;
    if meta.len() > 200_000_000 {
        return Err("That file is larger than 200 MB.".into());
    }
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    file.hash(&mut hasher);
    meta.len().hash(&mut hasher);
    meta.modified().ok().hash(&mut hasher);
    let cache = root().join(".preview");
    let out = cache.join(format!("{:016x}", hasher.finish()));
    let shown = |p: PathBuf| p.to_string_lossy().into_owned();
    if let Some(page) = preview_in(&out) {
        return Ok(shown(page));
    }

    // Keep the cache small: the oldest previews go once there are more than forty.
    if let Ok(entries) = fs::read_dir(&cache) {
        let mut dirs: Vec<(std::time::SystemTime, PathBuf)> = entries
            .flatten()
            .filter(|e| !e.file_name().to_string_lossy().starts_with('.'))
            .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path())))
            .collect();
        dirs.sort();
        let extra = dirs.len().saturating_sub(40);
        for (_, dir) in dirs.into_iter().take(extra) {
            let _ = fs::remove_dir_all(dir);
        }
    }
    fs::create_dir_all(&out).map_err(|e| e.to_string())?;
    let ext = file.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();

    // Quick Look only for the formats it is known to draw: asked about anything else it can
    // stall, or quit with a crash report the person then has to dismiss.
    if ["doc", "docx", "docm", "xls", "xlsx", "xlsm", "ppt", "pptx", "pptm", "ppsx", "pages", "numbers", "key"].contains(&ext.as_str()) {
        run_quiet(Command::new("/usr/bin/qlmanage").args(["-p", "-o"]).arg(&out).arg(&file), 30);
        if let Some(page) = preview_in(&out) {
            return Ok(shown(page));
        }
    }
    if ["rtf", "rtfd", "doc", "docx", "odt", "wordml", "webarchive"].contains(&ext.as_str()) {
        run_quiet(Command::new("/usr/bin/textutil").args(["-convert", "html", "-output"]).arg(out.join("page.html")).arg(&file), 30);
        if let Some(page) = preview_in(&out) {
            return Ok(shown(page));
        }
    }
    const OFFICE: [&str; 30] = [
        "doc", "docx", "docm", "dotx", "odt", "fodt", "rtf", "hwp", "hwpx", "wpd", "wps", "xls", "xlsx", "xlsm", "xlsb", "xltx", "ods", "fods",
        "ppt", "pptx", "pptm", "ppsx", "pps", "potx", "odp", "fodp", "odg", "vsd", "vsdx", "pub",
    ];
    if OFFICE.contains(&ext.as_str()) {
        if let Some(soffice) = office() {
            // Its own settings folder, so it never collides with a LibreOffice the person has open.
            let profile = format!("-env:UserInstallation=file://{}", cache.join(".office").to_string_lossy().replace(' ', "%20"));
            run_quiet(Command::new(soffice).arg(profile).args(["--headless", "--convert-to", "pdf", "--outdir"]).arg(&out).arg(&file), 90);
            if let Some(page) = preview_in(&out) {
                return Ok(shown(page));
            }
        }
    }
    if let Some(page) = text_page(&file) {
        if fs::write(out.join("page.html"), page).is_ok() {
            return Ok(shown(out.join("page.html")));
        }
    }
    let _ = fs::remove_dir_all(&out);
    Err("This kind of file has no preview on this Mac.".into())
}

const KEY_SERVICE: &str = "app.cube.desktop.model-keys";
const PROVIDERS: [&str; 3] = ["anthropic", "openai", "openrouter"];

fn key_entry(provider: &str) -> Result<keyring::Entry, String> {
    if !PROVIDERS.contains(&provider) {
        return Err("That is not a provider Cube knows.".into());
    }
    keyring::Entry::new(KEY_SERVICE, provider).map_err(|e| e.to_string())
}

/// Saves a model provider's API key in the macOS Keychain. Keys are never written anywhere else.
#[tauri::command]
async fn key_set(provider: String, key: String) -> Result<(), String> {
    let key = key.trim();
    if key.is_empty() {
        return Err("The key is empty.".into());
    }
    key_entry(&provider)?.set_password(key).map_err(|e| e.to_string())
}

/// Reads a key back for one request to its provider.
#[tauri::command]
async fn key_get(provider: String) -> Result<String, String> {
    key_entry(&provider)?
        .get_password()
        .map_err(|_| "No key is saved for that provider. Add one in Settings.".to_string())
}

#[tauri::command]
async fn key_delete(provider: String) -> Result<(), String> {
    match key_entry(&provider)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// The providers a key is saved for.
#[tauri::command]
async fn key_list() -> Result<Vec<String>, String> {
    Ok(PROVIDERS
        .iter()
        .filter(|p| key_entry(p).is_ok_and(|e| e.get_password().is_ok()))
        .map(|p| p.to_string())
        .collect())
}

#[derive(Serialize)]
struct CommandOutput {
    /// What the command printed, both streams together, cut to the last part when very long.
    output: String,
    /// None when the command was stopped for running too long.
    code: Option<i32>,
}

/// Runs one shell command in a conversation folder for the built-in agent and waits for it,
/// up to `timeout` seconds.
#[tauri::command]
async fn run_command(dir: String, command: String, timeout: Option<u64>) -> Result<CommandOutput, String> {
    let base = inside_root(Path::new(&dir))?;
    let mut cmd = Command::new("/bin/zsh");
    cmd.args(["-lc", &format!("{{ {command}\n}} 2>&1")])
        .current_dir(&base)
        .env("PATH", shell_path())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let mut out = child.stdout.take().ok_or("no stdout")?;
    let reader = thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = out.read_to_end(&mut buf);
        buf
    });
    let limit = Duration::from_secs(timeout.unwrap_or(120).clamp(1, 900));
    let started = std::time::Instant::now();
    let code = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.code(),
            Ok(None) if started.elapsed() > limit => {
                #[cfg(unix)]
                {
                    let _ = Command::new("kill").args(["-TERM", &format!("-{}", child.id())]).status();
                }
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
            Ok(None) => thread::sleep(Duration::from_millis(40)),
            Err(e) => return Err(e.to_string()),
        }
    };
    let bytes = reader.join().unwrap_or_default();
    let text = String::from_utf8_lossy(&bytes);
    const KEEP: usize = 30_000;
    let output = if text.len() > KEEP {
        let mut at = text.len() - KEEP;
        while !text.is_char_boundary(at) {
            at += 1;
        }
        format!("[earlier output left out]\n{}", &text[at..])
    } else {
        text.into_owned()
    };
    Ok(CommandOutput { output, code })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // One TLS provider for the whole app, chosen before anything connects.
    let _ = rustls::crypto::ring::default_provider().install_default();
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        // An invite link opened from a browser or a mail (`cube://<relay host>/#invite=…`) reaches the window through this.
        .plugin(tauri_plugin_deep_link::init())
        // Checks the release page for a newer Cube and installs it; see update.rs.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Runs::default())
        .manage(Inputs::default())
        .manage(Terms::default())
        .manage(browser::Browser::default())
        .manage(remote::Remote::default())
        .manage(team::Team::default())
        .manage(drive::Drive::default())
        .manage(slack::Slack::default())
        .manage(update::Updates::default())
        .setup(|app| {
            // Files in the workspaces opened before can be shown in the app again.
            workspace::restore(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            workspace::workspace_pick,
            workspace::workspace_list,
            workspace::workspace_remove,
            tools_found,
            sessions::sessions_list,
            sessions::session_read,
            usage::usage_read,
            agent_start,
            agent_stop,
            agent_write,
            agent_end_input,
            detect_engines,
            log_line,
            ensure_space,
            list_files,
            read_text,
            write_text,
            create_file,
            rename_path,
            trash_path,
            search_text,
            checkpoint_save,
            checkpoint_restore,
            term_open,
            term_write,
            term_resize,
            term_close,
            harness,
            write_bytes,
            read_bytes,
            custom_agents,
            quick_look,
            key_set,
            key_get,
            key_delete,
            key_list,
            run_command,
            browser::browser_start,
            browser::browser_tabs,
            browser::browser_new,
            browser::browser_close_tab,
            browser::browser_view,
            browser::browser_send,
            browser::windows_list,
            browser::file_icons,
            knowledge::knowledge_dir,
            knowledge::library_program,
            knowledge::library_read,
            knowledge::knowledge_list,
            knowledge::knowledge_import,
            knowledge::knowledge_export,
            knowledge::knowledge_remove,
            slack::slack_set,
            slack::slack_configured,
            slack::slack_clear,
            slack::slack_start,
            slack::slack_post,
            slack::slack_user,
            slack::slack_emoji,
            slack::slack_emoji_image,
            slack::slack_upload,
            slack::slack_scopes,
            picture::draw_picture,
            team::team_info,
            team::team_join,
            team::team_start,
            team::team_leave,
            team::team_publish,
            team::team_ask,
            team::team_request,
            drive::drive_scan,
            drive::drive_put,
            drive::drive_drop,
            drive::drive_get,
            drive::drive_merge,
            drive::drive_trash,
            remote::remote_card,
            remote::remote_secret_set,
            remote::remote_secret_has,
            remote::remote_secret_delete,
            remote::remote_call,
            remote::remote_stop,
            browser::window_shot,
            update::update_info,
            update::update_check,
            update::update_install
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| {
            // The browser Cube started must not outlive it.
            if let tauri::RunEvent::Exit = event {
                browser::stop(app);
            }
        });
}
