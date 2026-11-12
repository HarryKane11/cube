//! Slack, so that the team can be called from where people already talk: mention the Cube bot (or
//! write to it directly) and a cube answers in that thread.
//!
//! The connection is Slack's Socket Mode: the app dials out to Slack over a WebSocket, so nothing
//! on this computer has to be reachable from the internet. The two tokens of the person's own
//! Slack app are kept in the Keychain and used only here; the webview never sees them.

use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::oneshot;
use tokio_tungstenite::{connect_async, tungstenite::Message};

const SERVICE: &str = "app.cube.desktop.slack";
/// How often the connection is tried, and how long it may stay silent before it counts as dead.
const BEAT: Duration = Duration::from_secs(20);
const SILENCE: Duration = Duration::from_secs(50);
const API: &str = "https://slack.com/api";

#[derive(Default)]
pub struct Slack {
    /// The way to stop the connection while it is up.
    stop: Mutex<Option<oneshot::Sender<()>>>,
}

fn entry(which: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, which).map_err(|e| e.to_string())
}

fn token(which: &str) -> Option<String> {
    entry(which).ok()?.get_password().ok()
}

/// A token as Slack issues them: the expected prefix, no spaces, a sane length.
fn valid(token: &str, prefix: &str) -> bool {
    token.starts_with(prefix) && token.len() >= 20 && token.len() <= 400 && token.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn text_of(v: &Value, key: &str) -> String {
    v.get(key).and_then(Value::as_str).unwrap_or_default().to_string()
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder().timeout(Duration::from_secs(20)).redirect(reqwest::redirect::Policy::none()).user_agent("Cube").build().map_err(|e| e.to_string())
}

/// One call to Slack's Web API with a token. Slack answers 200 with `ok: false` when it refuses.
async fn call(method: &str, token: &str, body: Option<Value>, query: &[(&str, &str)]) -> Result<Value, String> {
    let url = reqwest::Url::parse_with_params(&format!("{API}/{method}"), query).map_err(|e| e.to_string())?;
    let mut req = client()?.post(url).bearer_auth(token);
    if let Some(body) = body {
        req = req.header("Content-Type", "application/json; charset=utf-8").body(body.to_string());
    }
    let res = req.send().await.map_err(|e| format!("Could not reach Slack: {}", e.without_url()))?;
    let text = res.text().await.map_err(|e| e.without_url().to_string())?;
    let v: Value = serde_json::from_str(&text).map_err(|_| "Slack answered with something Cube cannot read.".to_string())?;
    if v.get("ok").and_then(Value::as_bool) == Some(true) {
        Ok(v)
    } else {
        Err(refusal(&v))
    }
}

/// Why Slack said no, in words the person can act on.
fn refusal(v: &Value) -> String {
    match text_of(v, "error").as_str() {
        "invalid_auth" | "not_authed" | "token_revoked" | "account_inactive" => "Slack does not accept this token. Check it in Settings.".to_string(),
        "missing_scope" => format!("The Slack app is missing a permission ({}). Install it again from the manifest in Settings.", text_of(v, "needed")),
        "not_in_channel" | "channel_not_found" => "The Cube bot is not in that Slack channel.".to_string(),
        other => format!("Slack refused: {other}"),
    }
}

/// A call whose arguments Slack wants as a form, not as JSON.
async fn call_form(method: &str, token: &str, form: &[(&str, &str)]) -> Result<Value, String> {
    let res = client()?.post(format!("{API}/{method}")).bearer_auth(token).form(form).send().await.map_err(|e| format!("Could not reach Slack: {}", e.without_url()))?;
    let text = res.text().await.map_err(|e| e.without_url().to_string())?;
    let v: Value = serde_json::from_str(&text).map_err(|_| "Slack answered with something Cube cannot read.".to_string())?;
    if v.get("ok").and_then(Value::as_bool) == Some(true) {
        Ok(v)
    } else {
        Err(refusal(&v))
    }
}

/// Saves the two tokens of the person's Slack app: the bot token and the app-level token.
#[tauri::command]
pub async fn slack_set(bot: String, app: String) -> Result<(), String> {
    let (bot, app) = (bot.trim(), app.trim());
    if !valid(bot, "xoxb-") {
        return Err("The bot token starts with xoxb-. It is under OAuth & Permissions in your Slack app.".into());
    }
    if !valid(app, "xapp-") {
        return Err("The app-level token starts with xapp-. It is under Basic Information in your Slack app.".into());
    }
    // Tried once before it is kept, so a wrong token is caught here and not later.
    call("auth.test", bot, None, &[]).await?;
    entry("bot")?.set_password(bot).map_err(|e| e.to_string())?;
    entry("app")?.set_password(app).map_err(|e| e.to_string())
}

/// Whether Slack tokens are saved. The tokens themselves never go to the webview.
#[tauri::command]
pub async fn slack_configured() -> Result<bool, String> {
    Ok(token("bot").is_some() && token("app").is_some())
}

/// Forgets the tokens and closes the connection.
#[tauri::command]
pub async fn slack_clear(state: State<'_, Slack>) -> Result<(), String> {
    state.stop.lock().map_err(|e| e.to_string())?.take();
    for which in ["bot", "app"] {
        match entry(which)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(())
}

/// Connects to Slack when tokens are saved, and stays connected. Does nothing otherwise.
#[tauri::command]
pub async fn slack_start(app: AppHandle, state: State<'_, Slack>) -> Result<(), String> {
    let (Some(bot), Some(app_token)) = (token("bot"), token("app")) else { return Ok(()) };
    let mut stop = state.stop.lock().map_err(|e| e.to_string())?;
    if stop.is_some() {
        return Ok(());
    }
    let (tx, rx) = oneshot::channel();
    *stop = Some(tx);
    tauri::async_runtime::spawn(keep_connected(app, bot, app_token, rx));
    Ok(())
}

/// A Slack channel id and a message timestamp, as Slack writes them. Anything else is refused.
fn ids_ok(channel: &str, ts: &str) -> bool {
    let id = !channel.is_empty() && channel.len() <= 24 && channel.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit());
    let stamp = !ts.is_empty() && ts.len() <= 24 && ts.chars().all(|c| c.is_ascii_digit() || c == '.');
    id && stamp
}

/// Posts a reply into a Slack thread. Returns the new message's timestamp.
#[tauri::command]
pub async fn slack_post(channel: String, thread_ts: String, text: String) -> Result<String, String> {
    if !ids_ok(&channel, &thread_ts) {
        return Err("That is not a Slack thread.".into());
    }
    let bot = token("bot").ok_or_else(|| "Slack is not connected.".to_string())?;
    // Slack takes about 40,000 characters; a reply that long is cut rather than refused.
    let text: String = text.chars().take(38_000).collect();
    let v = call("chat.postMessage", &bot, Some(json!({ "channel": channel, "thread_ts": thread_ts, "text": text, "unfurl_links": false, "unfurl_media": false })), &[]).await?;
    Ok(text_of(&v, "ts"))
}

/// Puts a picture a cube made into a Slack thread. Only a picture inside ~/CubeSpaces goes: the
/// path is checked here, and so is that the file really is one.
#[tauri::command]
pub async fn slack_upload(channel: String, thread_ts: String, path: String, title: String) -> Result<(), String> {
    if !ids_ok(&channel, &thread_ts) {
        return Err("That is not a Slack thread.".into());
    }
    let file = crate::inside_root(std::path::Path::new(&path))?;
    let bytes = std::fs::read(&file).map_err(|e| e.to_string())?;
    if bytes.is_empty() || bytes.len() as u64 > crate::picture::MAX_BYTES || crate::picture::image_kind(&bytes).is_none() {
        return Err("Only pictures up to 20 MB are sent to Slack.".into());
    }
    let name = file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "picture.png".into());
    let title: String = title.chars().filter(|c| !c.is_control()).take(120).collect();
    let bot = token("bot").ok_or_else(|| "Slack is not connected.".to_string())?;

    // Slack takes a file in three steps: ask where to put it, put it there, then say where it belongs.
    let ticket = call_form("files.getUploadURLExternal", &bot, &[("filename", name.as_str()), ("length", &bytes.len().to_string())]).await?;
    let (upload_url, file_id) = (text_of(&ticket, "upload_url"), text_of(&ticket, "file_id"));
    let host_ok = reqwest::Url::parse(&upload_url).ok().is_some_and(|u| u.scheme() == "https" && u.host_str().is_some_and(|h| h == "slack.com" || h.ends_with(".slack.com")));
    if !host_ok || file_id.is_empty() {
        return Err("Slack gave an address Cube does not trust.".into());
    }
    let sender = reqwest::Client::builder().timeout(Duration::from_secs(120)).redirect(reqwest::redirect::Policy::none()).user_agent("Cube").build().map_err(|e| e.to_string())?;
    let put = sender.post(upload_url).header("Content-Type", "application/octet-stream").body(bytes).send().await.map_err(|e| format!("Could not reach Slack: {}", e.without_url()))?;
    if !put.status().is_success() {
        return Err(format!("Slack did not take the picture ({}).", put.status().as_u16()));
    }
    let title = if title.trim().is_empty() { name } else { title };
    call("files.completeUploadExternal", &bot, Some(json!({ "files": [{ "id": file_id, "title": title }], "channel_id": channel, "thread_ts": thread_ts })), &[]).await?;
    Ok(())
}

/// The permissions the person's Slack app was installed with, so Cube can say which ones are
/// missing instead of failing later. Slack reports them in a header of every answer.
#[tauri::command]
pub async fn slack_scopes() -> Result<Vec<String>, String> {
    let bot = token("bot").ok_or_else(|| "Slack is not connected.".to_string())?;
    let res = client()?.post(format!("{API}/auth.test")).bearer_auth(&bot).send().await.map_err(|e| format!("Could not reach Slack: {}", e.without_url()))?;
    let scopes = res.headers().get("x-oauth-scopes").and_then(|v| v.to_str().ok()).unwrap_or_default().to_string();
    Ok(scopes.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty() && s.len() <= 60).collect())
}

/// The name a Slack member goes by.
#[tauri::command]
pub async fn slack_user(user: String) -> Result<String, String> {
    if user.is_empty() || user.len() > 24 || !user.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit()) {
        return Err("That is not a Slack member.".into());
    }
    let bot = token("bot").ok_or_else(|| "Slack is not connected.".to_string())?;
    let v = call("users.info", &bot, None, &[("user", &user)]).await?;
    let profile = v.get("user").and_then(|u| u.get("profile")).cloned().unwrap_or(Value::Null);
    let name = [text_of(&profile, "display_name"), text_of(&profile, "real_name")].into_iter().find(|n| !n.is_empty());
    Ok(name.unwrap_or(user))
}

#[derive(Serialize, Clone)]
struct Incoming {
    t: &'static str,
    channel: String,
    user: String,
    text: String,
    ts: String,
    /// The thread the message is in, when it is in one.
    thread_ts: String,
    /// A direct message to the bot, as opposed to a mention in a channel.
    dm: bool,
    /// The message calls the team: a mention of the bot or a direct message. False for a reply
    /// in a channel thread that does not mention it, which counts only if the team is in that thread.
    called: bool,
    /// The bot's own member id, so the mention of it can be taken out of the text.
    bot: String,
}

/// A message for the team out of a Socket Mode event, or nothing: only mentions of the bot and
/// direct messages to it, written by a person (never by a bot, never an edit or a join notice).
fn incoming(event: &Value, bot_user: &str) -> Option<Incoming> {
    let kind = text_of(event, "type");
    let dm = kind == "message" && text_of(event, "channel_type") == "im";
    let (text, ts, thread_ts) = (text_of(event, "text"), text_of(event, "ts"), text_of(event, "thread_ts"));
    // A reply inside a channel thread. One that mentions the bot also arrives as a mention, and is taken from there.
    let reply = kind == "message" && !dm && !thread_ts.is_empty() && thread_ts != ts && !text.contains(&format!("<@{bot_user}>"));
    // Channel messages outside a thread never leave this function: the bot is not their audience.
    if kind != "app_mention" && !dm && !reply {
        return None;
    }
    let user = text_of(event, "user");
    if user.is_empty() || user == bot_user || event.get("bot_id").is_some() || event.get("subtype").is_some() {
        return None;
    }
    let channel = text_of(event, "channel");
    if !ids_ok(&channel, &ts) || (!thread_ts.is_empty() && !ids_ok(&channel, &thread_ts)) {
        return None;
    }
    Some(Incoming { t: "message", channel, user, text, ts, thread_ts, dm, called: !reply, bot: bot_user.to_string() })
}

fn status(app: &AppHandle, connected: bool, team: &str, problem: &str) {
    let _ = app.emit("slack-ev", json!({ "t": "status", "connected": connected, "team": team, "problem": problem }));
}

enum End {
    Stopped,
    /// The tokens are refused: trying again will not help.
    Refused(String),
    Lost(String),
}

async fn session(app: &AppHandle, bot: &str, app_token: &str, stop: &mut oneshot::Receiver<()>, seen: &mut VecDeque<String>) -> End {
    let who = match call("auth.test", bot, None, &[]).await {
        Ok(v) => v,
        Err(e) if e.starts_with("Slack does not accept") => return End::Refused(e),
        Err(e) => return End::Lost(e),
    };
    let (bot_user, team) = (text_of(&who, "user_id"), text_of(&who, "team"));
    let opened = match call("apps.connections.open", app_token, None, &[]).await {
        Ok(v) => v,
        Err(e) if e.starts_with("Slack does not accept") => return End::Refused("Slack does not accept the app-level token. Check it in Settings.".into()),
        Err(e) => return End::Lost(e),
    };
    let url = text_of(&opened, "url");
    // The socket address comes from Slack over TLS; it is still checked to be Slack's.
    let host_ok = reqwest::Url::parse(&url).ok().is_some_and(|u| u.scheme() == "wss" && u.host_str().is_some_and(|h| h == "slack.com" || h.ends_with(".slack.com")));
    if !host_ok {
        return End::Lost("Slack gave an address Cube does not trust.".into());
    }
    let mut socket = match tokio::time::timeout(Duration::from_secs(20), connect_async(url.as_str())).await {
        Ok(Ok((s, _))) => s,
        _ => return End::Lost("Could not open the connection to Slack.".into()),
    };
    // A connection can die without a word: the Mac sleeps, the network changes, and nothing ever
    // arrives again while the socket still looks open. So the line is tried every so often, and
    // one that stays silent is given up and dialed again.
    let mut beat = tokio::time::interval(BEAT);
    beat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut heard = Instant::now();
    loop {
        tokio::select! {
            _ = &mut *stop => {
                let _ = socket.close(None).await;
                return End::Stopped;
            }
            _ = beat.tick() => {
                if heard.elapsed() > SILENCE || socket.send(Message::Ping(Vec::new().into())).await.is_err() {
                    return End::Lost(String::new());
                }
            }
            frame = socket.next() => {
                heard = Instant::now();
                let text = match frame {
                    Some(Ok(Message::Text(t))) => t,
                    Some(Ok(Message::Ping(p))) => { let _ = socket.send(Message::Pong(p)).await; continue; }
                    Some(Ok(Message::Pong(_))) => continue,
                    Some(Ok(_)) | None => return End::Lost("Slack closed the connection.".into()),
                    Some(Err(e)) => return End::Lost(format!("The connection to Slack broke: {e}")),
                };
                let Ok(v) = serde_json::from_str::<Value>(text.as_str()) else { continue };
                match text_of(&v, "type").as_str() {
                    "hello" => status(app, true, &team, ""),
                    // Slack asks for a fresh connection every few hours.
                    "disconnect" => return End::Lost(String::new()),
                    _ => {}
                }
                let envelope = text_of(&v, "envelope_id");
                if envelope.is_empty() {
                    continue;
                }
                // Every envelope is acknowledged at once, or Slack sends it again.
                if socket.send(Message::text(json!({ "envelope_id": envelope }).to_string())).await.is_err() {
                    return End::Lost("The connection to Slack broke.".into());
                }
                let Some(event) = v.get("payload").and_then(|p| p.get("event")) else { continue };
                if let Some(msg) = incoming(event, &bot_user) {
                    // The same message can arrive twice (a retry, or a mention that is also a direct message).
                    let key = format!("{}:{}", msg.channel, msg.ts);
                    if seen.contains(&key) {
                        continue;
                    }
                    seen.push_back(key);
                    if seen.len() > 500 {
                        seen.pop_front();
                    }
                    let _ = app.emit("slack-ev", msg);
                }
            }
        }
    }
}

async fn keep_connected(app: AppHandle, bot: String, app_token: String, mut stop: oneshot::Receiver<()>) {
    let mut seen: VecDeque<String> = VecDeque::new();
    let mut pause = 2u64;
    loop {
        match session(&app, &bot, &app_token, &mut stop, &mut seen).await {
            End::Stopped => return status(&app, false, "", ""),
            End::Refused(why) => return status(&app, false, "", &why),
            End::Lost(why) => {
                // A refresh Slack asked for is not a problem worth showing.
                if why.is_empty() { pause = 1; } else { status(&app, false, "", &why); }
            }
        }
        tokio::select! {
            _ = &mut stop => return status(&app, false, "", ""),
            _ = tokio::time::sleep(Duration::from_secs(pause)) => {}
        }
        pause = (pause * 2).clamp(2, 30);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_must_look_like_slack_tokens() {
        assert!(valid("xoxb-1234567890-abcdefABCDEF123456", "xoxb-"));
        assert!(!valid("xapp-1-A0-123-abcdefabcdefabcdef", "xoxb-"));
        assert!(!valid("xoxb-short", "xoxb-"));
        assert!(!valid("xoxb-1234567890 abcdefABCDEF123456", "xoxb-"));
    }

    #[test]
    fn takes_mentions_and_direct_messages_written_by_people() {
        let mention = json!({ "type": "app_mention", "user": "U1", "text": "<@UBOT> hi", "ts": "1794460000.000100", "channel": "C123", "thread_ts": "1794450000.000001" });
        let got = incoming(&mention, "UBOT").unwrap();
        assert_eq!((got.channel.as_str(), got.user.as_str(), got.thread_ts.as_str(), got.dm), ("C123", "U1", "1794450000.000001", false));
        let dm = json!({ "type": "message", "channel_type": "im", "user": "U1", "text": "hi", "ts": "1794460000.000200", "channel": "D123" });
        assert!(incoming(&dm, "UBOT").unwrap().dm);
    }

    #[test]
    fn ignores_what_is_not_a_request_to_the_team() {
        // An ordinary channel message that does not mention the bot.
        assert!(incoming(&json!({ "type": "message", "channel_type": "channel", "user": "U1", "text": "hi", "ts": "1.1", "channel": "C1" }), "UBOT").is_none());
        // The bot's own message, another bot's, an edit, and a malformed channel id.
        assert!(incoming(&json!({ "type": "message", "channel_type": "im", "user": "UBOT", "text": "hi", "ts": "1.1", "channel": "D1" }), "UBOT").is_none());
        assert!(incoming(&json!({ "type": "app_mention", "user": "U2", "bot_id": "B1", "text": "hi", "ts": "1.1", "channel": "C1" }), "UBOT").is_none());
        assert!(incoming(&json!({ "type": "message", "channel_type": "im", "subtype": "message_changed", "user": "U1", "ts": "1.1", "channel": "D1" }), "UBOT").is_none());
        assert!(incoming(&json!({ "type": "app_mention", "user": "U1", "text": "hi", "ts": "1.1", "channel": "../x" }), "UBOT").is_none());
    }

    #[test]
    fn takes_replies_in_a_thread_without_a_mention_and_marks_them() {
        let reply = json!({ "type": "message", "channel_type": "channel", "user": "U1", "text": "and in English?", "ts": "1794460000.000300", "channel": "C123", "thread_ts": "1794450000.000001" });
        let got = incoming(&reply, "UBOT").unwrap();
        assert_eq!((got.thread_ts.as_str(), got.called, got.dm), ("1794450000.000001", false, false));
        // In a private channel too.
        let private = json!({ "type": "message", "channel_type": "group", "user": "U1", "text": "ok", "ts": "1794460000.000400", "channel": "G123", "thread_ts": "1794450000.000001" });
        assert!(!incoming(&private, "UBOT").unwrap().called);
        // A mention and a direct message call the team.
        let mention = json!({ "type": "app_mention", "user": "U1", "text": "<@UBOT> hi", "ts": "1794460000.000100", "channel": "C123" });
        assert!(incoming(&mention, "UBOT").unwrap().called);
        // A reply that mentions the bot arrives as a mention as well: the message copy is dropped.
        let both = json!({ "type": "message", "channel_type": "channel", "user": "U1", "text": "<@UBOT> again", "ts": "1794460000.000500", "channel": "C123", "thread_ts": "1794450000.000001" });
        assert!(incoming(&both, "UBOT").is_none());
        // The message that starts a thread is its own thread_ts: still an ordinary channel message.
        let root = json!({ "type": "message", "channel_type": "channel", "user": "U1", "text": "hi", "ts": "1794450000.000001", "channel": "C123", "thread_ts": "1794450000.000001" });
        assert!(incoming(&root, "UBOT").is_none());
        // A thread id that is not one.
        let bad = json!({ "type": "message", "channel_type": "channel", "user": "U1", "text": "hi", "ts": "1794460000.000600", "channel": "C123", "thread_ts": "x" });
        assert!(incoming(&bad, "UBOT").is_none());
    }

    #[test]
    fn only_slack_ids_reach_the_api() {
        assert!(ids_ok("C0123ABCD", "1794460000.000100"));
        assert!(!ids_ok("c0123", "1794460000.000100"));
        assert!(!ids_ok("C0123", "now"));
        assert!(!ids_ok("", ""));
    }
}
