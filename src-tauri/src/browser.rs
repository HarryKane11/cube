//! Two ways of watching a browser from the Stage.
//!
//! Cube's own browser: a Chromium started without a window, driven and watched over the Chrome
//! DevTools Protocol. The person steers it from the Stage, and agents can connect to the same
//! port, so both see one browser.
//!
//! Following a window: pictures of another app's window (Aside, ego lite, anything on screen),
//! taken with the system's own screenshot tool. That needs the Screen Recording permission.

use std::{
    fs,
    io::{Read, Write},
    net::TcpStream,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use tungstenite::Message;

#[derive(Default)]
pub struct Browser(Mutex<Inner>);

#[derive(Default)]
struct Inner {
    child: Option<Child>,
    port: u16,
    /// The tab being watched. Dropping it ends the thread that reads its frames.
    view: Option<(String, mpsc::Sender<String>)>,
}

static NEXT_ID: AtomicU64 = AtomicU64::new(1000);

#[derive(Clone, Serialize)]
struct Frame {
    target: String,
    /// A JPEG, base64.
    data: String,
    w: f64,
    h: f64,
}

#[derive(Clone, Serialize)]
struct Nav {
    target: String,
    url: String,
}

#[derive(Serialize)]
pub struct Tab {
    id: String,
    title: String,
    url: String,
}

/// `Something.app` → the program inside it.
fn app_binary(app: &Path) -> Option<PathBuf> {
    let name = app.file_stem()?.to_string_lossy().into_owned();
    let bin = app.join("Contents/MacOS").join(name);
    bin.is_file().then_some(bin)
}

/// Apps ending in `.app` directly inside folders matching `<base>/<prefix>*/<sub>*`.
fn apps_under(base: &Path, prefix: &str, deeper: bool) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(base) else { return out };
    for entry in entries.flatten() {
        if !entry.file_name().to_string_lossy().starts_with(prefix) {
            continue;
        }
        let mut dirs = vec![entry.path()];
        if deeper {
            dirs = fs::read_dir(entry.path()).map(|d| d.flatten().map(|e| e.path()).collect()).unwrap_or_default();
        }
        for dir in dirs {
            if let Ok(inner) = fs::read_dir(&dir) {
                out.extend(inner.flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "app")));
            }
        }
    }
    out.sort();
    out.reverse();
    out
}

/// A Chromium-based browser on this computer: the person's own, or one an automation tool installed.
fn find_chromium() -> Option<PathBuf> {
    let mut apps: Vec<PathBuf> = ["Google Chrome", "Chromium", "Microsoft Edge", "Brave Browser"]
        .iter()
        .map(|n| PathBuf::from(format!("/Applications/{n}.app")))
        .collect();
    let home = crate::home();
    apps.extend(apps_under(&home.join("Library/Caches/ms-playwright"), "chromium-", true));
    apps.extend(apps_under(&home.join(".agent-browser/browsers"), "chrome-", false));
    apps.iter().find_map(|a| app_binary(a))
}

/// One request to the browser's DevTools HTTP endpoint. The server keeps connections open, so the
/// body is read by its stated length instead of waiting for the connection to close.
fn http(port: u16, method: &str, path: &str) -> Result<String, String> {
    let mut s = TcpStream::connect(("127.0.0.1", port)).map_err(|e| e.to_string())?;
    s.set_read_timeout(Some(Duration::from_secs(4))).ok();
    write!(s, "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n").map_err(|e| e.to_string())?;
    let mut data: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        let split = data.windows(4).position(|w| w == b"\r\n\r\n");
        if let Some(at) = split {
            let head = String::from_utf8_lossy(&data[..at]).to_ascii_lowercase();
            let length = head.lines().find_map(|l| l.strip_prefix("content-length:")).and_then(|v| v.trim().parse::<usize>().ok());
            if let Some(length) = length {
                if data.len() >= at + 4 + length {
                    return Ok(String::from_utf8_lossy(&data[at + 4..at + 4 + length]).into_owned());
                }
            }
        }
        match s.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => data.extend_from_slice(&chunk[..n]),
            Err(e) => return Err(e.to_string()),
        }
    }
    let at = data.windows(4).position(|w| w == b"\r\n\r\n").map(|p| p + 4).unwrap_or(data.len());
    Ok(String::from_utf8_lossy(&data[at..]).into_owned())
}

/// Starts the browser if it is not running and returns the port its DevTools Protocol listens on.
#[tauri::command]
pub async fn browser_start(state: State<'_, Browser>) -> Result<u16, String> {
    let mut b = state.0.lock().unwrap();
    if let Some(child) = b.child.as_mut() {
        if matches!(child.try_wait(), Ok(None)) && b.port != 0 {
            return Ok(b.port);
        }
    }
    let bin = find_chromium().ok_or("No Chromium-based browser was found on this computer. Install Google Chrome to use the built-in browser.")?;
    let profile = crate::root().join(".browser");
    fs::create_dir_all(&profile).map_err(|e| e.to_string())?;
    let marker = profile.join("DevToolsActivePort");
    let _ = fs::remove_file(&marker);
    let child = Command::new(bin)
        .args([
            "--headless=new",
            "--remote-debugging-port=0",
            "--no-first-run",
            "--no-default-browser-check",
            "--hide-scrollbars",
            "--window-size=1280,800",
        ])
        .arg(format!("--user-data-dir={}", profile.display()))
        .arg("about:blank")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Could not start the browser: {e}"))?;
    b.child = Some(child);
    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(15) {
        if let Some(port) = fs::read_to_string(&marker).ok().and_then(|t| t.lines().next().and_then(|l| l.trim().parse::<u16>().ok())) {
            b.port = port;
            return Ok(port);
        }
        thread::sleep(Duration::from_millis(80));
    }
    Err("The browser did not start in time.".into())
}

fn port_of(state: &State<'_, Browser>) -> Result<u16, String> {
    match state.0.lock().unwrap().port {
        0 => Err("The browser is not running.".into()),
        p => Ok(p),
    }
}

#[tauri::command]
pub async fn browser_tabs(state: State<'_, Browser>) -> Result<Vec<Tab>, String> {
    let list: Value = serde_json::from_str(&http(port_of(&state)?, "GET", "/json/list")?).map_err(|e| e.to_string())?;
    Ok(list
        .as_array()
        .map(|a| {
            a.iter()
                .filter(|t| t["type"] == "page")
                .map(|t| Tab {
                    id: t["id"].as_str().unwrap_or_default().into(),
                    title: t["title"].as_str().unwrap_or_default().into(),
                    url: t["url"].as_str().unwrap_or_default().into(),
                })
                .collect()
        })
        .unwrap_or_default())
}

#[tauri::command]
pub async fn browser_new(state: State<'_, Browser>) -> Result<String, String> {
    let made: Value = serde_json::from_str(&http(port_of(&state)?, "PUT", "/json/new?about:blank")?).map_err(|e| e.to_string())?;
    made["id"].as_str().map(String::from).ok_or_else(|| "The browser did not open a tab.".into())
}

#[tauri::command]
pub async fn browser_close_tab(state: State<'_, Browser>, id: String) -> Result<(), String> {
    if !id.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err("That is not a tab id.".into());
    }
    http(port_of(&state)?, "GET", &format!("/json/close/{id}")).map(|_| ())
}

/// Reads one tab's frames and page changes and passes commands to it, until the tab closes or
/// another tab is picked.
fn watch(app: AppHandle, port: u16, target: String, rx: mpsc::Receiver<String>) -> Result<(), String> {
    let stream = TcpStream::connect(("127.0.0.1", port)).map_err(|e| e.to_string())?;
    stream.set_nodelay(true).ok();
    let url = format!("ws://127.0.0.1:{port}/devtools/page/{target}");
    let (mut ws, _) = tungstenite::client(url.as_str(), stream).map_err(|e| e.to_string())?;
    ws.get_mut().set_read_timeout(Some(Duration::from_millis(20))).ok();
    for (method, params) in [
        ("Page.enable", json!({})),
        ("Page.startScreencast", json!({ "format": "jpeg", "quality": 60, "everyNthFrame": 1 })),
    ] {
        let line = json!({ "id": NEXT_ID.fetch_add(1, Ordering::Relaxed), "method": method, "params": params }).to_string();
        ws.send(Message::text(line)).map_err(|e| e.to_string())?;
    }
    loop {
        loop {
            match rx.try_recv() {
                Ok(line) => ws.send(Message::text(line)).map_err(|e| e.to_string())?,
                Err(mpsc::TryRecvError::Empty) => break,
                Err(mpsc::TryRecvError::Disconnected) => {
                    let _ = ws.close(None);
                    return Ok(());
                }
            }
        }
        let text = match ws.read() {
            Ok(Message::Text(t)) => t.to_string(),
            Ok(Message::Close(_)) => return Ok(()),
            Ok(_) => continue,
            Err(tungstenite::Error::Io(e)) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => continue,
            Err(e) => return Err(e.to_string()),
        };
        let Ok(msg) = serde_json::from_str::<Value>(&text) else { continue };
        let params = &msg["params"];
        match msg["method"].as_str() {
            Some("Page.screencastFrame") => {
                let ack = json!({ "id": NEXT_ID.fetch_add(1, Ordering::Relaxed), "method": "Page.screencastFrameAck", "params": { "sessionId": params["sessionId"] } });
                ws.send(Message::text(ack.to_string())).map_err(|e| e.to_string())?;
                let _ = app.emit(
                    "browser-frame",
                    Frame {
                        target: target.clone(),
                        data: params["data"].as_str().unwrap_or_default().into(),
                        w: params["metadata"]["deviceWidth"].as_f64().unwrap_or(0.0),
                        h: params["metadata"]["deviceHeight"].as_f64().unwrap_or(0.0),
                    },
                );
            }
            Some("Page.frameNavigated") if params["frame"]["parentId"].is_null() => {
                let _ = app.emit("browser-nav", Nav { target: target.clone(), url: params["frame"]["url"].as_str().unwrap_or_default().into() });
            }
            _ => {}
        }
    }
}

/// Starts watching a tab. The tab watched before, if any, is let go.
#[tauri::command]
pub async fn browser_view(app: AppHandle, state: State<'_, Browser>, target: String) -> Result<(), String> {
    if !target.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err("That is not a tab id.".into());
    }
    let port = port_of(&state)?;
    let (tx, rx) = mpsc::channel::<String>();
    state.0.lock().unwrap().view = Some((target.clone(), tx));
    thread::spawn(move || {
        let ended = watch(app.clone(), port, target.clone(), rx);
        // Only say the tab is gone if it is still the one being watched.
        let state = app.state::<Browser>();
        let mut b = state.0.lock().unwrap();
        if b.view.as_ref().is_some_and(|(t, _)| *t == target) {
            b.view = None;
            let _ = app.emit("browser-closed", Nav { target, url: ended.err().unwrap_or_default() });
        }
    });
    Ok(())
}

/// Sends one DevTools Protocol command to the tab being watched: go to a page, a click, a key.
#[tauri::command]
pub async fn browser_send(state: State<'_, Browser>, method: String, params: Value) -> Result<(), String> {
    const ALLOWED: [&str; 5] = ["Page.", "Input.", "Emulation.", "Runtime.evaluate", "Target.activateTarget"];
    if !ALLOWED.iter().any(|p| method.starts_with(p)) {
        return Err("That command is not one the Stage sends.".into());
    }
    let b = state.0.lock().unwrap();
    let (_, tx) = b.view.as_ref().ok_or("No tab is open.")?;
    let line = json!({ "id": NEXT_ID.fetch_add(1, Ordering::Relaxed), "method": method, "params": params }).to_string();
    tx.send(line).map_err(|_| "That tab is closed.".to_string())
}

/// Stops the browser. Called when the app quits.
pub fn stop(app: &AppHandle) {
    let state = app.state::<Browser>();
    let mut b = state.0.lock().unwrap();
    b.view = None;
    if let Some(mut child) = b.child.take() {
        let _ = child.kill();
    }
}

#[derive(Serialize, Deserialize)]
pub struct Win {
    id: u32,
    app: String,
    w: f64,
    h: f64,
    /// The app's icon, a 72 px PNG as base64. Empty when it could not be read.
    #[serde(default)]
    icon: String,
}

const LIST_WINDOWS: &str = r#"ObjC.import('CoreGraphics');
ObjC.import('AppKit');
// An app's icon as a small PNG, base64.
function png(icon, n) {
  const rep = $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(null, n, n, 8, 4, true, false, $.NSCalibratedRGBColorSpace, 0, 0);
  const ctx = $.NSGraphicsContext.graphicsContextWithBitmapImageRep(rep);
  $.NSGraphicsContext.saveGraphicsState;
  $.NSGraphicsContext.setCurrentContext(ctx);
  icon.drawInRectFromRectOperationFraction($.NSMakeRect(0, 0, n, n), $.NSZeroRect, $.NSCompositingOperationSourceOver, 1);
  $.NSGraphicsContext.restoreGraphicsState;
  return ObjC.unwrap(rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $.NSDictionary.dictionary).base64EncodedStringWithOptions(0));
}
function run() {
  const ref = $.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, 0);
  const list = ObjC.deepUnwrap(ObjC.castRefToObject(ref));
  const icons = {};
  return JSON.stringify(list.filter(w => w.kCGWindowLayer === 0 && w.kCGWindowBounds.Width > 200 && w.kCGWindowBounds.Height > 150).map(w => {
    const pid = w.kCGWindowOwnerPID;
    if (!(pid in icons)) {
      icons[pid] = "";
      try {
        const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid);
        if (app && app.icon) icons[pid] = png(app.icon, 72);
      } catch (e) {}
    }
    return { id: w.kCGWindowNumber, app: String(w.kCGWindowOwnerName), w: w.kCGWindowBounds.Width, h: w.kCGWindowBounds.Height, icon: icons[pid] };
  }));
}"#;

/// The app windows on screen right now, front to back.
#[tauri::command]
pub async fn windows_list() -> Result<Vec<Win>, String> {
    let out = Command::new("/usr/bin/osascript")
        .args(["-l", "JavaScript", "-e", LIST_WINDOWS])
        .stdin(Stdio::null())
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    serde_json::from_slice(&out.stdout).map_err(|e| e.to_string())
}

const FILE_ICONS: &str = r#"ObjC.import('AppKit');
function png(icon, n) {
  const rep = $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(null, n, n, 8, 4, true, false, $.NSCalibratedRGBColorSpace, 0, 0);
  const ctx = $.NSGraphicsContext.graphicsContextWithBitmapImageRep(rep);
  $.NSGraphicsContext.saveGraphicsState;
  $.NSGraphicsContext.setCurrentContext(ctx);
  icon.drawInRectFromRectOperationFraction($.NSMakeRect(0, 0, n, n), $.NSZeroRect, $.NSCompositingOperationSourceOver, 1);
  $.NSGraphicsContext.restoreGraphicsState;
  return ObjC.unwrap(rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $.NSDictionary.dictionary).base64EncodedStringWithOptions(0));
}
function run(argv) {
  const ws = $.NSWorkspace.sharedWorkspace;
  const out = {};
  for (const ext of argv) out[ext] = png(ws.iconForFileType(ext), 64);
  return JSON.stringify(out);
}"#;

/// The icons this Mac shows for files of the given kinds (by extension), the same ones Finder
/// shows: Word's for a .docx when Word is installed, and so on. Small PNGs, base64, by extension.
#[tauri::command]
pub async fn file_icons(exts: Vec<String>) -> Result<std::collections::HashMap<String, String>, String> {
    let wanted: Vec<String> = exts
        .into_iter()
        .filter(|e| !e.is_empty() && e.len() <= 12 && e.chars().all(|c| c.is_ascii_alphanumeric()))
        .take(40)
        .collect();
    if wanted.is_empty() {
        return Ok(Default::default());
    }
    let out = Command::new("/usr/bin/osascript")
        .args(["-l", "JavaScript", "-e", FILE_ICONS])
        .args(&wanted)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    serde_json::from_slice(&out.stdout).map_err(|e| e.to_string())
}

/// A picture of one window as it looks right now, as a base64 JPEG no wider than 1600 px.
#[tauri::command]
pub async fn window_shot(id: u32) -> Result<String, String> {
    let file = std::env::temp_dir().join(format!("cube-follow-{}-{id}.jpg", std::process::id()));
    let taken = Command::new("/usr/sbin/screencapture")
        .args(["-x", "-o", &format!("-l{id}"), "-t", "jpg"])
        .arg(&file)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|e| e.to_string())?;
    if !taken.success() || !file.is_file() {
        return Err("Cube could not take a picture of that window. If the window is still open, allow Cube under Screen & System Audio Recording in System Settings > Privacy & Security, then quit and reopen Cube. If Cube is already switched on there, remove it from that list and allow it again: the permission belongs to the copy of Cube that asked for it, and an updated Cube counts as a new one.".into());
    }
    let _ = Command::new("/usr/bin/sips")
        .args(["-Z", "1600", "-s", "formatOptions", "60"])
        .arg(&file)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    let bytes = fs::read(&file).map_err(|e| e.to_string())?;
    let _ = fs::remove_file(&file);
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}
