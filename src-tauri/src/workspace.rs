//! Folders of the person's own that they opened as workspaces, the way a project folder is
//! opened in Claude Code: cubes work in such a folder directly, beside whatever else is there.
//!
//! Everything else Cube touches lives under ~/CubeSpaces, and nothing outside it may be read or
//! written. A workspace is the one exception, and it is made only here: the person picks the
//! folder in the system's own folder dialog, which this file opens. The app's web side can ask
//! for the dialog and can ask to forget a folder, but it can never hand in a path to be allowed.
//!
//! Cube keeps no copies of what is in a workspace and never deletes or restores it: no
//! checkpoints, no Trash. Those work by conversation folder under ~/CubeSpaces and cannot be
//! pointed at a workspace.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Manager};

/// The folders opened so far, as resolved paths. Read from disk once.
static ROOTS: Mutex<Option<Vec<PathBuf>>> = Mutex::new(None);

#[derive(Serialize, Clone)]
pub struct Workspace {
    dir: String,
    /// The folder's own name, which is what the workspace is called.
    name: String,
    /// Whether it is a git repository: the person's way back when a cube changed something.
    git: bool,
    /// The folder is not there now (moved, deleted, a drive not plugged in).
    missing: bool,
}

/// Where the list is kept: with the app's own settings, not in a place a conversation works in.
fn list_file() -> PathBuf {
    crate::home().join("Library/Application Support/app.cube.desktop/workspaces.json")
}

fn load() -> Vec<PathBuf> {
    fs::read_to_string(list_file())
        .ok()
        .and_then(|text| serde_json::from_str::<Vec<String>>(&text).ok())
        .unwrap_or_default()
        .into_iter()
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .collect()
}

fn save(roots: &[PathBuf]) -> Result<(), String> {
    let file = list_file();
    if let Some(dir) = file.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let list: Vec<String> = roots.iter().map(|p| p.to_string_lossy().into_owned()).collect();
    fs::write(file, serde_json::to_vec_pretty(&list).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

/// The folders that are open as workspaces.
pub(crate) fn roots() -> Vec<PathBuf> {
    let mut guard = ROOTS.lock().unwrap();
    guard.get_or_insert_with(load).clone()
}

/// True when a resolved path is a workspace folder or inside one.
pub(crate) fn holds(real: &Path) -> bool {
    roots().iter().any(|r| real.starts_with(r))
}

fn describe(dir: &Path) -> Workspace {
    Workspace {
        dir: dir.to_string_lossy().into_owned(),
        name: dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| dir.to_string_lossy().into_owned()),
        git: dir.join(".git").exists(),
        missing: !dir.is_dir(),
    }
}

/// Why a folder cannot be a workspace, or None when it can. `home` and `spaces` are resolved paths.
///
/// A workspace is a folder of work: inside the person's home folder or on a drive they plugged
/// in, and never a folder so wide that opening it would hand over everything they have.
fn refusal(dir: &Path, home: &Path, spaces: &Path) -> Option<&'static str> {
    if dir == home || home.starts_with(dir) {
        return Some("That folder holds your whole home folder. Pick a folder inside it.");
    }
    if dir.starts_with(spaces) {
        return Some("That is Cube's own folder. Conversations there already have their place.");
    }
    if dir.starts_with(home.join("Library")) {
        return Some("That folder belongs to the system and the apps on this Mac. Pick a folder of your own work.");
    }
    // A folder straight under home whose name starts with a dot holds settings and keys (.ssh, .config, .claude).
    let under_home = dir.strip_prefix(home).ok();
    if under_home.and_then(|rel| rel.components().next()).is_some_and(|first| first.as_os_str().to_string_lossy().starts_with('.')) {
        return Some("That folder holds settings and keys. Pick a folder of your own work.");
    }
    let on_a_drive = dir.strip_prefix("/Volumes").ok().is_some_and(|rel| rel.components().count() >= 2);
    if under_home.is_none() && !on_a_drive {
        return Some("Pick a folder inside your home folder, or on a drive of yours.");
    }
    None
}

/// Lets pictures and other files in a workspace be shown in the app, as those under ~/CubeSpaces are.
fn show(app: &AppHandle, dir: &Path) {
    let _ = app.asset_protocol_scope().allow_directory(dir, true);
}

/// Called once when the app opens: the workspaces opened before can be shown again.
pub fn restore(app: &AppHandle) {
    for dir in roots() {
        show(app, &dir);
    }
}

/// Opens the system's folder dialog and makes the chosen folder a workspace. Nothing is chosen
/// when the person closes the dialog: that is `None`, not an error.
#[tauri::command]
pub async fn workspace_pick(app: AppHandle) -> Result<Option<Workspace>, String> {
    let picked = tauri::async_runtime::spawn_blocking(|| {
        Command::new("/usr/bin/osascript")
            .args(["-e", "POSIX path of (choose folder with prompt \"Choose a folder for your cubes to work in\")"])
            .output()
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;
    if !picked.status.success() {
        // Closing the dialog ends the script with an error of its own; that is the person changing their mind.
        return Ok(None);
    }
    let path = String::from_utf8_lossy(&picked.stdout).trim().to_string();
    if path.is_empty() {
        return Ok(None);
    }
    let dir = PathBuf::from(path).canonicalize().map_err(|e| e.to_string())?;
    if !dir.is_dir() {
        return Err("That is not a folder.".into());
    }
    let home = crate::home().canonicalize().map_err(|e| e.to_string())?;
    // Cube's own folder may not exist yet on a new Mac; then nothing can be inside it.
    let spaces = crate::root().canonicalize().unwrap_or_else(|_| crate::root());
    if let Some(why) = refusal(&dir, &home, &spaces) {
        return Err(why.into());
    }
    let mut guard = ROOTS.lock().unwrap();
    let list = guard.get_or_insert_with(load);
    if !list.contains(&dir) {
        list.push(dir.clone());
        save(list)?;
    }
    drop(guard);
    show(&app, &dir);
    Ok(Some(describe(&dir)))
}

/// The folders open as workspaces, with whether each is still there.
#[tauri::command]
pub async fn workspace_list() -> Result<Vec<Workspace>, String> {
    Ok(roots().iter().map(|d| describe(d)).collect())
}

/// Closes a workspace: Cube may no longer read or write there. The folder itself is not touched.
#[tauri::command]
pub async fn workspace_remove(dir: String) -> Result<(), String> {
    let mut guard = ROOTS.lock().unwrap();
    let list = guard.get_or_insert_with(load);
    let before = list.len();
    list.retain(|d| d.to_string_lossy() != dir);
    if list.len() != before {
        save(list)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn why(dir: &str) -> Option<&'static str> {
        refusal(Path::new(dir), Path::new("/Users/kim"), Path::new("/Users/kim/CubeSpaces"))
    }

    #[test]
    fn a_folder_of_work_can_be_a_workspace() {
        assert!(why("/Users/kim/dev/app").is_none());
        assert!(why("/Users/kim/Documents/report").is_none());
        assert!(why("/Volumes/Work/site").is_none());
    }

    #[test]
    fn folders_that_are_too_wide_or_not_the_persons_cannot() {
        for dir in ["/", "/Users", "/Users/kim", "/Users/kim/Library/Mail", "/Users/kim/.ssh", "/Users/kim/.config/gh", "/Users/kim/CubeSpaces/general", "/usr/local", "/Applications", "/Volumes", "/Volumes/Work", "/Users/lee/dev"] {
            assert!(why(dir).is_some(), "{dir} was let through");
        }
    }
}
