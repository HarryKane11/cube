//! Agents that run somewhere else and speak A2A. The webview decides what to say; this side does
//! the talking, so that the credential for an agent never has to enter the webview: it goes from
//! the Keychain straight into the request, and only to the address it was saved for.

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::oneshot;

const SERVICE: &str = "app.cube.desktop.remote-agents";
/// The most an agent may send back for one request.
const MAX_ANSWER: usize = 32 * 1024 * 1024;

/// Requests in flight, by run, each with the way to stop it.
#[derive(Default)]
pub struct Remote(Mutex<HashMap<String, oneshot::Sender<()>>>);

#[derive(Serialize, Deserialize)]
struct Saved {
    /// Scheme, host and port the credential may be sent to.
    origin: String,
    secret: String,
}

#[derive(Deserialize)]
pub struct Auth {
    /// "none", "bearer" or "header".
    kind: String,
    /// For "header": the header's name.
    header: Option<String>,
}

#[derive(Clone, Serialize)]
struct RemoteEv<'a> {
    run: &'a str,
    /// "data" (one object the agent sent, as JSON text), "error" or "done".
    t: &'a str,
    text: String,
}

fn is_loopback(url: &reqwest::Url) -> bool {
    match url.host_str() {
        Some(h) => h == "localhost" || h.ends_with(".localhost") || h == "127.0.0.1" || h == "[::1]" || h == "::1",
        None => false,
    }
}

/// An address Cube is willing to talk to: HTTPS anywhere, plain HTTP only on this machine, and
/// never one that carries a user name or password.
fn checked(url: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(url.trim()).map_err(|_| "That is not a valid address.".to_string())?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Addresses that carry a user name or password are refused.".into());
    }
    match url.scheme() {
        "https" => Ok(url),
        "http" if is_loopback(&url) => Ok(url),
        _ => Err("Remote agents must be reached over HTTPS.".into()),
    }
}

fn origin_of(url: &reqwest::Url) -> String {
    url.origin().ascii_serialization()
}

fn entry(id: &str) -> Result<keyring::Entry, String> {
    if id.is_empty() || id.len() > 64 || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("That is not a remote agent Cube knows.".into());
    }
    keyring::Entry::new(SERVICE, id).map_err(|e| e.to_string())
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        // A redirect could carry the credential to another host: none are followed.
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(15))
        .user_agent("Cube")
        .build()
        .map_err(|e| e.to_string())
}

/// Reads an agent's card. Nothing is sent but the request itself.
#[tauri::command]
pub async fn remote_card(url: String) -> Result<String, String> {
    let url = checked(&url)?;
    let res = client()?
        .get(url)
        .header("Accept", "application/json")
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .map_err(|e| format!("Could not reach that address: {}", e.without_url()))?;
    if !res.status().is_success() {
        return Err(format!("That address answered {} instead of an agent card.", res.status().as_u16()));
    }
    let mut body = Vec::new();
    let mut stream = res.bytes_stream();
    while let Some(chunk) = stream.next().await {
        body.extend_from_slice(&chunk.map_err(|e| e.without_url().to_string())?);
        if body.len() > 512 * 1024 {
            return Err("That is too large to be an agent card.".into());
        }
    }
    String::from_utf8(body).map_err(|_| "The card is not text.".to_string())
}

/// Saves the credential for a remote agent in the Keychain, tied to the address it is for.
#[tauri::command]
pub async fn remote_secret_set(id: String, endpoint: String, secret: String) -> Result<(), String> {
    let secret = secret.trim();
    if secret.is_empty() || secret.len() > 8192 || secret.chars().any(|c| c.is_control()) {
        return Err("That does not look like a token.".into());
    }
    let saved = Saved { origin: origin_of(&checked(&endpoint)?), secret: secret.to_string() };
    entry(&id)?.set_password(&serde_json::to_string(&saved).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

/// Whether a credential is saved for a remote agent. The credential itself never goes to the webview.
#[tauri::command]
pub async fn remote_secret_has(id: String) -> Result<bool, String> {
    match entry(&id)?.get_password() {
        Ok(_) => Ok(true),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub async fn remote_secret_delete(id: String) -> Result<(), String> {
    match entry(&id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

fn header_name(name: &str) -> Result<reqwest::header::HeaderName, String> {
    const REFUSED: [&str; 8] = ["host", "content-length", "content-type", "transfer-encoding", "cookie", "connection", "accept", "user-agent"];
    let lower = name.to_ascii_lowercase();
    if REFUSED.contains(&lower.as_str()) {
        return Err("The agent asks for its key in a header Cube will not set.".into());
    }
    reqwest::header::HeaderName::from_bytes(lower.as_bytes()).map_err(|_| "The agent names a header that is not valid.".to_string())
}

/// Sends one request to a remote agent and passes on what it answers as `remote-ev` events:
/// one "data" per object the agent sends, then "done" (or "error").
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn remote_call(
    app: AppHandle,
    state: State<'_, Remote>,
    run: String,
    id: String,
    url: String,
    content_type: String,
    headers: Vec<(String, String)>,
    auth: Auth,
    body: String,
    stream: bool,
) -> Result<(), String> {
    let url = checked(&url)?;
    let mut req = client()?.post(url.clone()).body(body);
    req = req.header("Content-Type", if content_type == "application/a2a+json" { "application/a2a+json" } else { "application/json" });
    req = req.header("Accept", if stream { "text/event-stream" } else { "application/json" });
    // From the webview only the protocol's own headers are taken.
    for (name, value) in headers {
        if name.to_ascii_lowercase().starts_with("a2a-") && value.len() <= 512 {
            req = req.header(header_name(&name)?, value);
        }
    }
    if auth.kind != "none" {
        let raw = entry(&id)?.get_password().map_err(|_| "No credential is saved for this agent. Add it in Settings.".to_string())?;
        let saved: Saved = serde_json::from_str(&raw).map_err(|_| "The saved credential cannot be read. Enter it again in Settings.".to_string())?;
        // The credential goes only where it was saved for, whatever the card says today.
        if saved.origin != origin_of(&url) {
            return Err("This agent's address changed since its credential was saved. Review the agent in Settings and enter the credential again.".into());
        }
        req = match auth.kind.as_str() {
            "bearer" => req.bearer_auth(&saved.secret),
            "header" => req.header(header_name(auth.header.as_deref().unwrap_or(""))?, &saved.secret),
            _ => return Err("Cube does not know that way of signing in.".into()),
        };
    }
    if !stream {
        req = req.timeout(Duration::from_secs(600));
    }

    let (stop, mut stopped) = oneshot::channel::<()>();
    state.0.lock().map_err(|e| e.to_string())?.insert(run.clone(), stop);

    tauri::async_runtime::spawn(async move {
        let emit = |t: &str, text: String| {
            let _ = app.emit("remote-ev", RemoteEv { run: &run, t, text });
        };
        let work = async {
            let res = req.send().await.map_err(|e| format!("Could not reach the agent: {}", e.without_url()))?;
            let status = res.status();
            if !status.is_success() {
                return Err(match status.as_u16() {
                    401 | 403 => format!("The agent refused the credential ({}). Check it in Settings.", status.as_u16()),
                    code if (300..400).contains(&code) => "The agent tried to send Cube to another address, which Cube does not follow.".to_string(),
                    code => format!("The agent answered with an error ({code})."),
                });
            }
            let mut bytes = res.bytes_stream();
            let mut buf: Vec<u8> = Vec::new();
            let mut total = 0usize;
            // For a stream: the data lines of the event being read.
            let mut data = String::new();
            while let Some(chunk) = bytes.next().await {
                let chunk = chunk.map_err(|e| format!("The connection to the agent broke: {}", e.without_url()))?;
                total += chunk.len();
                if total > MAX_ANSWER {
                    return Err("The agent sent more than Cube accepts for one answer.".to_string());
                }
                buf.extend_from_slice(&chunk);
                if !stream {
                    continue;
                }
                while let Some(end) = buf.iter().position(|b| *b == b'\n') {
                    let line: Vec<u8> = buf.drain(..=end).collect();
                    let line = String::from_utf8_lossy(&line);
                    let line = line.trim_end_matches(['\n', '\r']);
                    if line.is_empty() {
                        if !data.is_empty() {
                            emit("data", std::mem::take(&mut data));
                        }
                    } else if let Some(rest) = line.strip_prefix("data:") {
                        if !data.is_empty() {
                            data.push('\n');
                        }
                        data.push_str(rest.strip_prefix(' ').unwrap_or(rest));
                    }
                }
            }
            if stream {
                if !data.is_empty() {
                    emit("data", data);
                }
            } else {
                emit("data", String::from_utf8_lossy(&buf).into_owned());
            }
            Ok(())
        };
        tokio::select! {
            out = work => match out {
                Ok(()) => emit("done", String::new()),
                Err(message) => emit("error", message),
            },
            _ = &mut stopped => emit("done", String::new()),
        }
        if let Some(remote) = tauri::Manager::try_state::<Remote>(&app) {
            if let Ok(mut runs) = remote.0.lock() {
                runs.remove(&run);
            }
        }
    });
    Ok(())
}

/// Stops a request that is still running.
#[tauri::command]
pub async fn remote_stop(state: State<'_, Remote>, run: String) -> Result<(), String> {
    if let Some(stop) = state.0.lock().map_err(|e| e.to_string())?.remove(&run) {
        let _ = stop.send(());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_https_or_this_machine() {
        assert!(checked("https://agent.example.com/a2a").is_ok());
        assert!(checked("http://localhost:9000/rpc").is_ok());
        assert!(checked("http://127.0.0.1:9000/rpc").is_ok());
        assert!(checked("http://agent.example.com/a2a").is_err());
        assert!(checked("http://169.254.169.254/latest").is_err());
        assert!(checked("https://user:pw@agent.example.com/").is_err());
        assert!(checked("file:///etc/passwd").is_err());
        assert!(checked("not a url").is_err());
    }

    #[test]
    fn a_credential_is_tied_to_scheme_host_and_port() {
        let a = origin_of(&checked("https://agent.example.com/a2a").unwrap());
        assert_eq!(a, origin_of(&checked("https://agent.example.com/other/path").unwrap()));
        assert_ne!(a, origin_of(&checked("https://agent.example.com:8443/a2a").unwrap()));
        assert_ne!(a, origin_of(&checked("https://evil.example.com/a2a").unwrap()));
    }

    #[test]
    fn refuses_headers_that_would_change_the_request() {
        assert!(header_name("X-Api-Key").is_ok());
        assert!(header_name("Host").is_err());
        assert!(header_name("Content-Length").is_err());
        assert!(header_name("bad header").is_err());
    }

    #[test]
    fn agent_ids_are_plain() {
        assert!(entry("../other").is_err());
        assert!(entry("").is_err());
    }
}
