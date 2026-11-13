//! How much of the person's plan is left, asked of the agent programs themselves.
//!
//! Cube never touches a program's credentials: it starts the program, asks it the one question
//! over its own protocol, and stops it. The program answers from its own sign-in. What comes
//! back is handed to the app as it is; the app reads it (src/agents/usage.ts).

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

/// How long a program gets to answer before it is given up on.
const PATIENCE: Duration = Duration::from_secs(12);

fn start(program: &str, args: &[&str]) -> Result<(Child, ChildStdin, mpsc::Receiver<Value>), String> {
    let mut cmd = Command::new(program);
    cmd.args(args)
        // Nothing is worked on: the folder only has to exist and be Cube's own.
        .current_dir(crate::root())
        .env("PATH", crate::shell_path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let mut child = cmd.spawn().map_err(|e| format!("Could not start {program}: {e}"))?;
    let stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Ok(v) = serde_json::from_str::<Value>(&line) {
                if tx.send(v).is_err() {
                    break;
                }
            }
        }
    });
    Ok((child, stdin, rx))
}

fn say(pipe: &mut ChildStdin, line: &Value) -> Result<(), String> {
    pipe.write_all(format!("{line}\n").as_bytes()).and_then(|_| pipe.flush()).map_err(|e| e.to_string())
}

/// The next line the program writes that `wanted` accepts, or an error when it takes too long.
fn wait(rx: &mpsc::Receiver<Value>, until: Instant, wanted: impl Fn(&Value) -> bool) -> Result<Value, String> {
    loop {
        let left = until.checked_duration_since(Instant::now()).ok_or("The program did not answer in time.")?;
        match rx.recv_timeout(left) {
            Ok(v) if wanted(&v) => return Ok(v),
            Ok(_) => {}
            Err(mpsc::RecvTimeoutError::Timeout) => return Err("The program did not answer in time.".into()),
            Err(mpsc::RecvTimeoutError::Disconnected) => return Err("The program stopped before it answered.".into()),
        }
    }
}

fn stop(mut child: Child) {
    let _ = child.kill();
    let _ = child.wait();
}

/// Codex: its app-server answers `account/rateLimits/read` without a conversation being open.
fn codex() -> Result<Value, String> {
    let (child, mut pipe, rx) = start("codex", &["app-server"])?;
    let until = Instant::now() + PATIENCE;
    let asked = (|| {
        say(&mut pipe, &json!({ "id": 1, "method": "initialize", "params": { "clientInfo": { "name": "cube", "title": "Cube", "version": env!("CARGO_PKG_VERSION") } } }))?;
        wait(&rx, until, |v| v["id"] == 1)?;
        say(&mut pipe, &json!({ "method": "initialized" }))?;
        say(&mut pipe, &json!({ "id": 2, "method": "account/rateLimits/read" }))?;
        let answer = wait(&rx, until, |v| v["id"] == 2)?;
        if let Some(message) = answer["error"]["message"].as_str() {
            return Err(message.to_string());
        }
        Ok(answer["result"].clone())
    })();
    stop(child);
    asked
}

/// Claude Code: asked for its usage as a control request, with nothing for the model to do.
/// `skip_behaviors` keeps it to the plan's limits: it does not read past conversations for this.
fn claude() -> Result<Value, String> {
    let (child, mut pipe, rx) = start("claude", &["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"])?;
    let until = Instant::now() + PATIENCE;
    let asked = (|| {
        say(&mut pipe, &json!({ "type": "control_request", "request_id": "cube-usage", "request": { "subtype": "get_usage", "skip_behaviors": true } }))?;
        let answer = wait(&rx, until, |v| v["type"] == "control_response" && v["response"]["request_id"] == "cube-usage")?;
        if answer["response"]["subtype"] == "error" {
            return Err(answer["response"]["error"].as_str().unwrap_or("Claude Code could not say.").to_string());
        }
        Ok(answer["response"]["response"].clone())
    })();
    stop(child);
    asked
}

/// What a program says about the plan it is signed in with, as the program worded it.
#[tauri::command]
pub async fn usage_read(program: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || match program.as_str() {
        "codex" => codex(),
        "claude" => claude(),
        other => Err(format!("{other} does not report its usage.")),
    })
    .await
    .map_err(|e| e.to_string())?
}
