//! Updates from inside the app: Cube asks its release page whether there is a newer version,
//! downloads it, checks that it was signed with Cube's update key, replaces itself and restarts.
//!
//! Where to ask and which key to trust are in `tauri.conf.json` (`plugins.updater`), built into
//! the app. The webview only gets to say "check" and "install": it never names an address or a
//! file, so a page inside Cube cannot point the update somewhere else.
//!
//! Only a release build updates itself. A debug build is one somebody made from source, and
//! replacing it with the published release would throw their own build away.

use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_updater::{Update, UpdaterExt};

/// The update the last check found, kept so that installing it does not have to ask again.
#[derive(Default)]
pub struct Updates(Mutex<Option<Update>>);

/// Whether this build updates itself.
const ENABLED: bool = !cfg!(debug_assertions);

#[derive(Serialize)]
pub struct AppVersion {
    version: String,
    /// False for a build made from source, which is updated by building again.
    updates: bool,
}

#[derive(Serialize)]
pub struct Found {
    version: String,
    notes: String,
}

/// How much of the download has arrived. `total` is 0 when the server did not say.
#[derive(Clone, Serialize)]
struct Progress {
    done: u64,
    total: u64,
}

/// Why an update did not work, in words the person can act on.
fn explain(e: tauri_plugin_updater::Error) -> String {
    use tauri_plugin_updater::Error;
    match e {
        Error::Reqwest(_) | Error::Network(_) => "Could not reach the update server. Check the connection and try again.".into(),
        Error::ReleaseNotFound => "There is no published release to update to yet.".into(),
        Error::TargetNotFound(_) | Error::TargetsNotFound(_) => "The latest release has no build for this Mac.".into(),
        Error::Minisign(_) | Error::SignatureUtf8(_) | Error::Base64(_) | Error::SignedVersionMismatch { .. } | Error::MissingSignedVersion => {
            "The update was not signed by Cube, so it was not installed.".into()
        }
        Error::AuthenticationFailed => "Cube was not allowed to replace itself in this folder, so the update was not installed.".into(),
        other => format!("The update did not work: {other}"),
    }
}

/// This copy's version, and whether it updates itself.
#[tauri::command]
pub fn update_info(app: AppHandle) -> AppVersion {
    AppVersion { version: app.package_info().version.to_string(), updates: ENABLED }
}

/// Asks the release page for a newer version. Nothing is downloaded yet.
#[tauri::command]
pub async fn update_check(app: AppHandle, state: State<'_, Updates>) -> Result<Option<Found>, String> {
    if !ENABLED {
        return Ok(None);
    }
    let found = app.updater().map_err(explain)?.check().await.map_err(explain)?;
    let told = found.as_ref().map(|u| Found { version: u.version.clone(), notes: u.body.clone().unwrap_or_default() });
    *state.0.lock().unwrap() = found;
    Ok(told)
}

/// Downloads the update the last check found, checks its signature, puts it in place of this
/// app and restarts into it. Reports the download as `update-progress` events on the way.
#[tauri::command]
pub async fn update_install(app: AppHandle, state: State<'_, Updates>) -> Result<(), String> {
    if !ENABLED {
        return Err("This copy of Cube was built from source, so it does not update itself.".into());
    }
    let kept = state.0.lock().unwrap().clone();
    let update = match kept {
        Some(update) => update,
        None => app.updater().map_err(explain)?.check().await.map_err(explain)?.ok_or("Cube is already up to date.")?,
    };
    let mut done: u64 = 0;
    let progress = app.clone();
    update
        .download_and_install(
            |chunk, total| {
                done += chunk as u64;
                let _ = progress.emit("update-progress", Progress { done, total: total.unwrap_or(0) });
            },
            || {},
        )
        .await
        .map_err(explain)?;
    // The new version is in place. Leave the way every exit does, so the browser Cube started
    // is closed, and come back as the new version.
    app.state::<Updates>().0.lock().unwrap().take();
    app.request_restart();
    Ok(())
}
