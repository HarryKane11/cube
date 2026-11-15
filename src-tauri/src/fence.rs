//! The fence around a run in a conversation other people read: a channel shared with the team,
//! a direct conversation with a teammate, or the memory job for such a conversation.
//!
//! What a cube says there reaches other people, so it must not be able to see what the person
//! keeps for themselves: Cube's own memory, skills and wiki, every other conversation's folder,
//! the app's message store, the transcripts the agent programs keep of earlier sessions, their
//! own memories, and the copies of Cube's memory exported to them. That is enforced by macOS,
//! not by what the cube is told:
//!
//! - Claude Code and any other program are started inside a Seatbelt profile (`sandbox-exec`)
//!   that denies reading and writing those places, built here from paths worked out here.
//! - Codex sandboxes its own commands, and macOS does not let one sandbox be started inside
//!   another, so Codex gets the same places as a permission profile of its own. Every line Cube
//!   writes to a fenced Codex passes through `codex_line`, which puts the profile in, takes out
//!   any sandbox setting that would replace it, and keeps Codex from ever asking to run a
//!   command outside its sandbox.
//! - Hermes keeps every session and its memory in one database it must read to work at all, so
//!   it cannot be fenced and does not run in such a conversation.
//!
//! The web side only names the folders the run works in, and each must be a conversation folder
//! or an open workspace (`inside_root`). It cannot widen what is denied.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};

use crate::knowledge::MARKER;

/// Why a fenced run of Hermes is refused.
pub const HERMES_REFUSED: &str = "Hermes keeps all of its sessions and its memory in one database it has to read, so it cannot be kept away from your personal chats. It does not run in a conversation shared with other people. Pick another agent program for this role here.";

/// The name the permission profile goes by inside Codex.
const PROFILE: &str = "cube_fence";

/// What a fenced run is: the folders it works in, and whether it may change them.
#[derive(Debug, Clone)]
pub struct Fence {
    /// Resolved paths: the conversation folder, and the cube's own copy of it when it has one.
    pub dirs: Vec<PathBuf>,
    /// For Codex, which nobody is asked about: whether it may write in those folders. Other
    /// programs ask the person before they change anything, so for them this changes nothing.
    pub write: bool,
    /// Whether the run may read the team's memory (`~/CubeSpaces/.team-memory`). It holds only
    /// what the team's public channels remember, which every member reads anyway; a run that
    /// answers someone outside the team (in Slack) does not get it.
    pub team: bool,
}

/// How Claude Code names the folder it keeps a working directory's sessions in.
fn claude_project_dir(dir: &Path) -> String {
    dir.to_string_lossy().chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect()
}

/// The path as macOS resolves it when it exists, which is what Seatbelt matches against.
fn real(p: PathBuf) -> PathBuf {
    p.canonicalize().unwrap_or(p)
}

/// Folders under `dir` that Cube exported there (they carry Cube's marker file).
fn exported_in(dir: &Path) -> Vec<PathBuf> {
    fs::read_dir(dir)
        .map(|d| d.flatten().map(|e| e.path()).filter(|p| p.join(MARKER).is_file()).collect())
        .unwrap_or_default()
}

/// Every place a fenced run may neither read nor write, before the run's own folders are let
/// back in. `workspaces` are the folders open as workspaces; those the run works in stay open.
pub fn walled(home: &Path, root: &Path, workspaces: &[PathBuf], fence: &Fence) -> Vec<PathBuf> {
    let mut out = vec![root.to_path_buf()];
    for app in ["Library/Application Support/app.cube.desktop", "Library/WebKit/app.cube.desktop", "Library/WebKit/cube", "Library/Caches/app.cube.desktop"] {
        out.push(home.join(app));
    }
    out.extend(workspaces.iter().filter(|w| !fence.dirs.iter().any(|d| d.starts_with(w.as_path()))).cloned());
    // What the agent programs keep of earlier sessions, their own memories, and Cube's memory exported to them.
    for rel in [".claude/projects", ".claude/history.jsonl", ".claude/file-history", ".claude/paste-cache", ".claude/rules/cube-memory.md", ".codex/sessions", ".codex/archived_sessions", ".codex/history.jsonl", ".codex/memories", ".hermes"] {
        out.push(home.join(rel));
    }
    // Codex's databases hold the titles and state of every thread.
    if let Ok(d) = fs::read_dir(home.join(".codex")) {
        out.extend(d.flatten().map(|e| e.path()).filter(|p| p.file_name().is_some_and(|n| n.to_string_lossy().contains(".sqlite"))));
    }
    out.extend(exported_in(&home.join(".claude/skills")));
    out.extend(exported_in(&home.join(".codex/skills")));
    out.into_iter().map(real).collect()
}

/// Where a fenced run may go again inside what `walled` shut: its own folders, and Claude Code's
/// record of sessions in them, which it has to read to continue a session.
fn let_back(home: &Path, fence: &Fence) -> Vec<PathBuf> {
    let mut out = fence.dirs.clone();
    for d in &fence.dirs {
        out.push(home.join(".claude/projects").join(claude_project_dir(d)));
    }
    out
}

fn quoted(p: &Path) -> String {
    format!("\"{}\"", p.to_string_lossy().replace('\\', "\\\\").replace('"', "\\\""))
}

/// The Seatbelt profile for a fenced run. Later rules win over earlier ones, so the run's own
/// folders are opened again after everything else is shut.
pub fn seatbelt(home: &Path, root: &Path, workspaces: &[PathBuf], fence: &Fence) -> String {
    let shut: Vec<String> = walled(home, root, workspaces, fence).iter().map(|p| format!("(subpath {})", quoted(p))).collect();
    let open: Vec<String> = let_back(home, fence).iter().map(|p| format!("(subpath {})", quoted(p))).collect();
    // Programs the person put in ~/CubeSpaces/.agents have to be read to be started.
    let mut read = vec![format!("(subpath {})", quoted(&real(root.join(".agents"))))];
    if fence.team {
        read.push(format!("(subpath {})", quoted(&real(root.join(crate::knowledge::TEAM_MEMORY)))));
    }
    format!(
        "(version 1)\n(allow default)\n(deny file-read* file-write* {})\n(allow file-read* file-write* {})\n(allow file-read* {})\n",
        shut.join(" "),
        open.join(" "),
        read.join(" ")
    )
}

/// The same places as a Codex permission profile: everything readable but what is walled, and
/// the run's own folders readable, or writable when it may change them.
pub fn codex_profile(home: &Path, root: &Path, workspaces: &[PathBuf], fence: &Fence) -> Value {
    let mut fs_map = Map::new();
    fs_map.insert(":root".into(), json!("read"));
    for p in walled(home, root, workspaces, fence) {
        // Codex refuses a profile that names a path that is not there.
        if p.exists() {
            fs_map.insert(p.to_string_lossy().into_owned(), json!("none"));
        }
    }
    let team = real(root.join(crate::knowledge::TEAM_MEMORY));
    if fence.team && team.exists() {
        fs_map.insert(team.to_string_lossy().into_owned(), json!("read"));
    }
    for d in &fence.dirs {
        fs_map.insert(d.to_string_lossy().into_owned(), json!(if fence.write { "write" } else { "read" }));
    }
    Value::Object(fs_map)
}

/// The requests Cube sends Codex. A fenced Codex is sent nothing else.
const CODEX_METHODS: &[&str] = &["initialize", "initialized", "thread/start", "thread/resume", "turn/start", "account/rateLimits/read"];

/// A key that could put a sandbox, an approval policy or a permission profile of its own in
/// place of the fence.
fn overrides_fence(key: &str) -> bool {
    let k = key.to_ascii_lowercase();
    k.contains("sandbox") || k.contains("approval") || k.contains("permission")
}

/// One line on its way to a fenced Codex, made safe: a thread is always started or resumed with
/// the fence as its permission profile and with no way to ask for more, and nothing in a turn can
/// replace that. A line that is not one of Cube's own requests or answers is refused.
pub fn codex_line(line: &str, profile: &Value) -> Result<String, String> {
    let refused = || "Cube does not send that to Codex in a shared conversation.".to_string();
    let mut v: Value = serde_json::from_str(line).map_err(|_| refused())?;
    let obj = v.as_object_mut().ok_or_else(refused)?;
    let Some(method) = obj.get("method").and_then(Value::as_str).map(str::to_owned) else {
        // An answer to something Codex asked.
        return Ok(line.to_string());
    };
    if !CODEX_METHODS.contains(&method.as_str()) {
        return Err(refused());
    }
    if method == "thread/start" || method == "thread/resume" || method == "turn/start" {
        let params = obj.entry("params").or_insert_with(|| json!({}));
        let p = params.as_object_mut().ok_or_else(refused)?;
        p.retain(|k, _| !overrides_fence(k));
        if method != "turn/start" {
            // Never: Codex does not ask, so it never asks to leave its sandbox either.
            p.insert("approvalPolicy".into(), json!("never"));
            let config = p.entry("config").or_insert_with(|| json!({}));
            let c = config.as_object_mut().ok_or_else(refused)?;
            c.retain(|k, _| !overrides_fence(k) && k != "features");
            c.insert("default_permissions".into(), json!(PROFILE));
            c.insert("permissions".into(), json!({ PROFILE: { "filesystem": profile } }));
            // Codex's own memories are written from every session it has had.
            c.insert("features".into(), json!({ "memories": false }));
        }
    }
    serde_json::to_string(&v).map_err(|e| e.to_string())
}

/// The name a program is started by, without its folder.
pub fn program_name(program: &str) -> &str {
    Path::new(program).file_name().and_then(|n| n.to_str()).unwrap_or(program)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("cube-fence-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    fn put(path: &Path, text: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    /// A home with Cube's folder in it: personal memory, a private conversation, a shared one.
    fn home(name: &str) -> (PathBuf, PathBuf, Fence) {
        let home = temp(name);
        let root = home.join("CubeSpaces");
        put(&root.join(".knowledge/memory/secret.md"), "PERSONAL");
        put(&root.join("dm-builder/plan.md"), "PRIVATE CHAT");
        put(&root.join("general/notes.md"), "SHARED");
        put(&home.join(".claude/projects/-elsewhere/s.jsonl"), "OLD SESSION");
        put(&home.join(".claude/rules/cube-memory.md"), "EXPORTED");
        put(&home.join(".codex/skills/cube-memory/SKILL.md"), "EXPORTED");
        put(&home.join(".codex/skills/cube-memory").join(MARKER), "");
        put(&home.join(".codex/skills/mine/SKILL.md"), "THEIR OWN SKILL");
        put(&home.join(".codex/state_5.sqlite"), "THREADS");
        put(&root.join(".team-memory/ship-fridays.md"), "TEAM");
        let fence = Fence { dirs: vec![root.join("general")], write: true, team: true };
        (home, root, fence)
    }

    #[test]
    fn walls_off_what_the_person_keeps_and_nothing_of_the_run_itself() {
        let (home, root, fence) = home("walls");
        let walled = walled(&home, &root, &[home.join("work/site")], &fence);
        for p in [root.clone(), home.join(".claude/rules/cube-memory.md"), home.join(".codex/skills/cube-memory"), home.join(".codex/state_5.sqlite"), home.join(".hermes"), home.join("work/site")] {
            assert!(walled.contains(&p), "{} should be walled", p.display());
        }
        assert!(!walled.contains(&home.join(".codex/skills/mine")), "a skill the person wrote is theirs to use");
        // A workspace the run works in is not walled.
        let in_ws = Fence { dirs: vec![home.join("work/site")], write: true, team: false };
        assert!(!super::walled(&home, &root, &[home.join("work/site")], &in_ws).contains(&home.join("work/site")));
    }

    #[test]
    fn a_profile_lets_the_run_back_into_its_own_folder_after_the_wall() {
        let (home, root, fence) = home("profile");
        let p = seatbelt(&home, &root, &[], &fence);
        let deny = p.find("(deny").unwrap();
        let allow = p.find(&format!("(allow file-read* file-write* (subpath \"{}\")", root.join("general").display())).unwrap();
        assert!(deny < allow, "the run's own folder must come after the wall: {p}");
        assert!(p.contains(&format!("{}/.claude/projects/{}", home.display(), claude_project_dir(&root.join("general")))));
    }

    #[test]
    fn quotes_paths_so_a_folder_name_cannot_end_the_rule() {
        assert_eq!(quoted(Path::new("/a/b\"c\\d")), "\"/a/b\\\"c\\\\d\"");
    }

    /// The profile does what it says, under macOS itself.
    #[test]
    #[cfg(target_os = "macos")]
    fn macos_keeps_a_fenced_shell_out_of_personal_files() {
        let (home, root, fence) = home("macos");
        let profile = seatbelt(&home, &root, &[], &fence);
        let read = |p: &Path| Command::new("/usr/bin/sandbox-exec").args(["-p", &profile, "/bin/cat"]).arg(p).output().unwrap();
        assert_eq!(String::from_utf8_lossy(&read(&root.join("general/notes.md")).stdout), "SHARED");
        for p in [root.join(".knowledge/memory/secret.md"), root.join("dm-builder/plan.md"), home.join(".claude/projects/-elsewhere/s.jsonl"), home.join(".claude/rules/cube-memory.md")] {
            let out = read(&p);
            assert!(!out.status.success() && out.stdout.is_empty(), "{} was readable", p.display());
        }
        // The team's memory can be read, not changed; a run for someone outside the team cannot read it.
        assert_eq!(String::from_utf8_lossy(&read(&root.join(".team-memory/ship-fridays.md")).stdout), "TEAM");
        let change = Command::new("/usr/bin/sandbox-exec").args(["-p", &profile, "/bin/sh", "-c"]).arg(format!("echo x >> '{}'", root.join(".team-memory/ship-fridays.md").display())).status().unwrap();
        assert!(!change.success());
        let outsider = seatbelt(&home, &root, &[], &Fence { team: false, ..fence.clone() });
        let out = Command::new("/usr/bin/sandbox-exec").args(["-p", &outsider, "/bin/cat"]).arg(root.join(".team-memory/ship-fridays.md")).output().unwrap();
        assert!(out.stdout.is_empty());
        // Not through a link made inside the run's own folder either.
        std::os::unix::fs::symlink(root.join(".knowledge/memory/secret.md"), root.join("general/link.md")).unwrap();
        assert!(read(&root.join("general/link.md")).stdout.is_empty());
        let write = Command::new("/usr/bin/sandbox-exec").args(["-p", &profile, "/bin/sh", "-c"]).arg(format!("echo x > '{}'", root.join(".knowledge/memory/new.md").display())).status().unwrap();
        assert!(!write.success());
    }

    #[test]
    fn codex_gets_the_wall_as_its_own_profile() {
        let (home, root, fence) = home("codex");
        let p = codex_profile(&home, &root, &[], &fence);
        assert_eq!(p[":root"], "read");
        assert_eq!(p[root.to_string_lossy().as_ref()], "none");
        assert_eq!(p[root.join("general").to_string_lossy().as_ref()], "write");
        assert_eq!(p[root.join(".team-memory").to_string_lossy().as_ref()], "read");
        // A path that is not there is left out: Codex refuses a profile that names one.
        assert!(p.get(home.join(".codex/memories").to_string_lossy().as_ref()).is_none());
        let read_only = codex_profile(&home, &root, &[], &Fence { write: false, ..fence });
        assert_eq!(read_only[root.join("general").to_string_lossy().as_ref()], "read");
    }

    #[test]
    fn a_line_to_codex_cannot_take_the_fence_away() {
        let profile = json!({ ":root": "read", "/x": "none" });
        let start = codex_line(r#"{"id":2,"method":"thread/start","params":{"approvalPolicy":"untrusted","sandbox":"danger-full-access","model":null,"config":{"sandbox_workspace_write":{"network_access":true},"default_permissions":"other","features":{"memories":true}}}}"#, &profile).unwrap();
        let v: Value = serde_json::from_str(&start).unwrap();
        let p = &v["params"];
        assert!(p.get("sandbox").is_none());
        assert_eq!(p["approvalPolicy"], "never");
        assert_eq!(p["config"]["default_permissions"], PROFILE);
        assert_eq!(p["config"]["permissions"][PROFILE]["filesystem"], profile);
        assert_eq!(p["config"]["features"]["memories"], false);
        assert!(p["config"].get("sandbox_workspace_write").is_none());

        let resume = codex_line(r#"{"id":2,"method":"thread/resume","params":{"threadId":"t","sandbox":"read-only"}}"#, &profile).unwrap();
        assert!(resume.contains(PROFILE) && !resume.contains("read-only"));

        let turn = codex_line(r#"{"id":3,"method":"turn/start","params":{"threadId":"t","sandboxPolicy":{"type":"dangerFullAccess"},"approvalPolicy":"never","input":[]}}"#, &profile).unwrap();
        assert!(!turn.contains("sandboxPolicy") && !turn.contains("dangerFullAccess"));

        // Answers to what Codex asked pass as they are.
        let answer = r#"{"id":"7","result":{"decision":"decline"}}"#;
        assert_eq!(codex_line(answer, &profile).unwrap(), answer);
        // Anything else Cube never sends is refused.
        assert!(codex_line(r#"{"id":4,"method":"command/exec","params":{"command":["cat","/x"]}}"#, &profile).is_err());
        assert!(codex_line("not json", &profile).is_err());
    }
}
