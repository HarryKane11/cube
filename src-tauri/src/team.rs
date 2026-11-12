//! The app's side of the team relay (docs/team-relay.md). The person's key lives here and in the
//! Keychain and never reaches the webview. This side only ever signs two things: the connection
//! challenge of the relay that was pinned when the invite was accepted, and events of the kinds
//! the protocol defines. Everything the relay sends is checked here before the webview sees it.

use cube_proto::{auth_message, claim_message, key_from_hex, key_to_hex, parse_invite_link, pubkey_hex, sign_event, sign_text, verify_event, Event, SigningKey};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::{connect_async, tungstenite::Message};

const SERVICE: &str = "app.cube.desktop.team";
const ACCOUNT: &str = "membership";
/// The kinds of event this side will sign. Nothing else can be published through it.
const KINDS: [&str; 6] = ["conv.put", "msg.post", "msg.edit", "msg.delete", "agent.put", "agent.drop"];
/// What the webview may ask of the relay besides publishing.
const ASKS: [&str; 7] = ["sync", "invite.create", "invite.list", "invite.revoke", "member.remove", "member.role", "member.rename"];

/// What is kept in the Keychain once an invite has been accepted.
#[derive(Serialize, Deserialize, Clone)]
struct Pin {
    /// The private key, hex.
    key: String,
    /// The relay's WebSocket address, from the invite link.
    url: String,
    /// The host the challenge is signed for.
    host: String,
    /// The workspace this membership is for. A relay that names another one is not answered.
    ws: String,
    /// The workspace's name, as the relay gave it.
    workspace: String,
}

#[derive(Default)]
pub struct Team {
    /// The way to the connection task while one is running.
    out: Mutex<Option<mpsc::UnboundedSender<String>>>,
    /// Events sent and not yet answered, by id.
    waiting: Mutex<HashMap<String, oneshot::Sender<Result<u64, String>>>>,
}

#[derive(Serialize)]
pub struct Info {
    host: String,
    ws: String,
    workspace: String,
    pubkey: String,
}

fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, ACCOUNT).map_err(|e| e.to_string())
}

fn load_pin() -> Option<Pin> {
    serde_json::from_str(&entry().ok()?.get_password().ok()?).ok()
}

fn key_of(pin: &Pin) -> Result<SigningKey, String> {
    key_from_hex(&pin.key).map_err(|_| "The saved team key cannot be read. Leave the team and join again.".to_string())
}

fn info_of(pin: &Pin) -> Result<Info, String> {
    Ok(Info { host: pin.host.clone(), ws: pin.ws.clone(), workspace: pin.workspace.clone(), pubkey: pubkey_hex(&key_of(pin)?) })
}

fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn text_of(v: &Value, key: &str) -> String {
    v.get(key).and_then(Value::as_str).unwrap_or_default().to_string()
}

type Socket = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// Connects and reads the relay's greeting. Returns the socket, the workspace id, its name and the challenge.
async fn greet(url: &str) -> Result<(Socket, String, String, String), String> {
    let (mut socket, _) = tokio::time::timeout(Duration::from_secs(15), connect_async(url))
        .await
        .map_err(|_| "The relay did not answer.".to_string())?
        .map_err(|e| format!("Could not reach the relay: {e}"))?;
    let hello = next_json(&mut socket).await?;
    if text_of(&hello, "t") != "hello" {
        return Err(text_of(&hello, "message").is_empty().then(|| "The relay did not greet the way Cube expects.".to_string()).unwrap_or_else(|| text_of(&hello, "message")));
    }
    Ok((socket, text_of(&hello, "ws"), text_of(&hello, "name"), text_of(&hello, "nonce")))
}

async fn next_json(socket: &mut Socket) -> Result<Value, String> {
    loop {
        let frame = tokio::time::timeout(Duration::from_secs(15), socket.next()).await.map_err(|_| "The relay stopped answering.".to_string())?;
        match frame {
            Some(Ok(Message::Text(text))) => return serde_json::from_str(text.as_str()).map_err(|_| "The relay sent something Cube cannot read.".to_string()),
            Some(Ok(Message::Ping(_))) | Some(Ok(Message::Pong(_))) => continue,
            Some(Ok(_)) | None => return Err("The relay closed the connection.".into()),
            Some(Err(e)) => return Err(format!("The connection to the relay broke: {e}")),
        }
    }
}

/// The membership this app holds, if it has joined a team.
#[tauri::command]
pub async fn team_info() -> Result<Option<Info>, String> {
    load_pin().map(|p| info_of(&p)).transpose()
}

/// Accepts an invite: makes this person's key, claims the invite with it, and remembers the
/// relay and workspace so that later connections go there and nowhere else.
#[tauri::command]
pub async fn team_join(app: AppHandle, state: State<'_, Team>, link: String, name: String) -> Result<Info, String> {
    if load_pin().is_some() {
        return Err("This Cube is already in a team. Leave it before joining another.".into());
    }
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("Give the name your teammates will see.".into());
    }
    let invite = parse_invite_link(link.trim()).map_err(|_| "That is not an invite link. It starts with cube+wss://".to_string())?;
    let (mut socket, ws, workspace, nonce) = greet(&invite.url).await?;
    let key = cube_proto::generate_key();
    let sig = sign_text(&key, &claim_message(&invite.host, &ws, &nonce, &invite.token));
    let claim = json!({ "t": "claim", "invite": invite.token, "pubkey": pubkey_hex(&key), "name": name, "host": invite.host, "sig": sig });
    socket.send(Message::text(claim.to_string())).await.map_err(|e| e.to_string())?;
    let answer = next_json(&mut socket).await?;
    let _ = socket.close(None).await;
    if text_of(&answer, "t") != "ready" {
        return Err("The relay did not accept this invite. It may have been used already, or have expired.".into());
    }
    let pin = Pin { key: key_to_hex(&key), url: invite.url, host: invite.host, ws, workspace };
    entry()?.set_password(&serde_json::to_string(&pin).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let info = info_of(&pin)?;
    start(app, &state, pin)?;
    Ok(info)
}

/// Connects to the team this app has joined, and keeps the connection up. Does nothing when it has not joined one.
#[tauri::command]
pub async fn team_start(app: AppHandle, state: State<'_, Team>) -> Result<(), String> {
    match load_pin() {
        Some(pin) if state.out.lock().map_err(|e| e.to_string())?.is_none() => start(app, &state, pin),
        _ => Ok(()),
    }
}

/// Forgets the team: closes the connection and deletes the key and the pinned relay.
#[tauri::command]
pub async fn team_leave(state: State<'_, Team>) -> Result<(), String> {
    state.out.lock().map_err(|e| e.to_string())?.take();
    match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// Signs and publishes one event. Resolves with the sequence number the relay gave it.
#[tauri::command]
pub async fn team_publish(state: State<'_, Team>, kind: String, body: String) -> Result<u64, String> {
    if !KINDS.contains(&kind.as_str()) {
        return Err("Cube does not publish that kind of event.".into());
    }
    if body.len() > 64 * 1024 || serde_json::from_str::<Value>(&body).is_err() {
        return Err("That is too long to share, or not well formed.".into());
    }
    let pin = load_pin().ok_or_else(|| "This Cube has not joined a team.".to_string())?;
    let event = sign_event(&key_of(&pin)?, now(), &kind, &pin.ws, &body);
    let (tx, rx) = oneshot::channel();
    state.waiting.lock().map_err(|e| e.to_string())?.insert(event.id.clone(), tx);
    let sent = match state.out.lock().map_err(|e| e.to_string())?.as_ref() {
        Some(out) => out.send(json!({ "t": "publish", "event": event }).to_string()).is_ok(),
        None => false,
    };
    if !sent {
        state.waiting.lock().map_err(|e| e.to_string())?.remove(&event.id);
        return Err("Not connected to the team right now.".into());
    }
    match tokio::time::timeout(Duration::from_secs(15), rx).await {
        Ok(Ok(result)) => result,
        _ => {
            state.waiting.lock().map_err(|e| e.to_string())?.remove(&event.id);
            Err("The relay did not confirm in time.".into())
        }
    }
}

/// Asks the relay for something that is not an event: history, invites, member changes. The
/// answer arrives as a `team-ev` event.
#[tauri::command]
pub async fn team_ask(state: State<'_, Team>, frame: Value) -> Result<(), String> {
    if !ASKS.contains(&text_of(&frame, "t").as_str()) {
        return Err("Cube does not ask the relay for that.".into());
    }
    match state.out.lock().map_err(|e| e.to_string())?.as_ref() {
        Some(out) if out.send(frame.to_string()).is_ok() => Ok(()),
        _ => Err("Not connected to the team right now.".into()),
    }
}

fn start(app: AppHandle, state: &State<'_, Team>, pin: Pin) -> Result<(), String> {
    let (tx, rx) = mpsc::unbounded_channel::<String>();
    *state.out.lock().map_err(|e| e.to_string())? = Some(tx);
    tauri::async_runtime::spawn(keep_connected(app, pin, rx));
    Ok(())
}

fn status(app: &AppHandle, connected: bool, problem: &str) {
    let _ = app.emit("team-ev", json!({ "t": "status", "connected": connected, "problem": problem }));
}

/// An event the relay delivered, if it is what it claims to be: for this workspace, with an id
/// and signature that verify. Redacted events (deleted or edited away) carry no signature and pass as they are.
fn checked(mut item: Value, ws: &str) -> Option<Value> {
    let event: Event = serde_json::from_value(item.clone()).ok()?;
    if event.ws != ws {
        return None;
    }
    if event.redacted {
        // Nothing of a redacted event's body is to be trusted or shown.
        item["body"] = Value::String(String::new());
        return Some(item);
    }
    verify_event(&event).ok()?;
    Some(item)
}

enum End {
    /// The person left, or the app is closing.
    Stopped,
    /// The relay will not have this key (removed from the team) or is not the relay that was pinned.
    Refused(String),
    /// Anything else: try again.
    Lost(String),
}

async fn session(app: &AppHandle, pin: &Pin, rx: &mut mpsc::UnboundedReceiver<String>) -> End {
    let key = match key_of(pin) {
        Ok(k) => k,
        Err(e) => return End::Refused(e),
    };
    let (mut socket, ws, _, nonce) = match greet(&pin.url).await {
        Ok(v) => v,
        Err(e) => return End::Lost(e),
    };
    // A relay that names another workspace is not the one this key was made for: nothing is signed for it.
    if ws != pin.ws {
        return End::Refused("The relay at this address is not the one this team was joined on.".into());
    }
    let auth = json!({ "t": "auth", "pubkey": pubkey_hex(&key), "host": pin.host, "sig": sign_text(&key, &auth_message(&pin.host, &ws, &nonce)) });
    if socket.send(Message::text(auth.to_string())).await.is_err() {
        return End::Lost("The connection to the relay broke.".into());
    }
    let mut ping = tokio::time::interval(Duration::from_secs(25));
    ping.tick().await;
    loop {
        tokio::select! {
            out = rx.recv() => match out {
                Some(line) => {
                    if socket.send(Message::text(line)).await.is_err() {
                        return End::Lost("The connection to the relay broke.".into());
                    }
                }
                None => {
                    let _ = socket.close(None).await;
                    return End::Stopped;
                }
            },
            _ = ping.tick() => {
                if socket.send(Message::text(json!({ "t": "ping" }).to_string())).await.is_err() {
                    return End::Lost("The connection to the relay broke.".into());
                }
            }
            frame = socket.next() => {
                let text = match frame {
                    Some(Ok(Message::Text(text))) => text,
                    Some(Ok(Message::Ping(_))) | Some(Ok(Message::Pong(_))) => continue,
                    Some(Ok(_)) | None => return End::Lost("The relay closed the connection.".into()),
                    Some(Err(e)) => return End::Lost(format!("The connection to the relay broke: {e}")),
                };
                let Ok(mut v) = serde_json::from_str::<Value>(text.as_str()) else { continue };
                match text_of(&v, "t").as_str() {
                    "ready" => status(app, true, ""),
                    "denied" => return End::Refused("This Cube is no longer a member of the team.".into()),
                    "pong" => continue,
                    "event" => match checked(v.clone(), &pin.ws) {
                        Some(ok) => v = ok,
                        None => continue,
                    },
                    "events" => {
                        let list = v.get("events").and_then(Value::as_array).cloned().unwrap_or_default();
                        v["events"] = Value::Array(list.into_iter().filter_map(|e| checked(e, &pin.ws)).collect());
                    }
                    "ok" | "error" => {
                        // The answer to something published: hand it to whoever is waiting for it.
                        let id = text_of(&v, "id");
                        if !id.is_empty() {
                            if let Some(team) = app.try_state::<Team>() {
                                if let Some(tx) = team.waiting.lock().ok().and_then(|mut w| w.remove(&id)) {
                                    let _ = tx.send(if text_of(&v, "t") == "ok" { Ok(v.get("seq").and_then(Value::as_u64).unwrap_or(0)) } else { Err(text_of(&v, "message")) });
                                    continue;
                                }
                            }
                        }
                    }
                    _ => {}
                }
                let _ = app.emit("team-ev", v);
            }
        }
    }
}

/// Holds the connection to the relay for as long as the app is in the team, coming back after a
/// drop with a growing pause.
async fn keep_connected(app: AppHandle, pin: Pin, mut rx: mpsc::UnboundedReceiver<String>) {
    let mut pause = 2u64;
    loop {
        match session(&app, &pin, &mut rx).await {
            End::Stopped => {
                status(&app, false, "");
                return;
            }
            End::Refused(why) => {
                status(&app, false, &why);
                if let Some(team) = app.try_state::<Team>() {
                    if let Ok(mut out) = team.out.lock() {
                        out.take();
                    }
                }
                return;
            }
            End::Lost(why) => status(&app, false, &why),
        }
        // What was said while disconnected is not sent late: the webview publishes again when it is back.
        while rx.try_recv().is_ok() {}
        if rx.is_closed() {
            return;
        }
        tokio::time::sleep(Duration::from_secs(pause)).await;
        pause = (pause * 2).min(30);
        if rx.is_closed() {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn signed(ws: &str) -> Value {
        let key = cube_proto::generate_key();
        serde_json::to_value(sign_event(&key, 1_794_460_000, "msg.post", ws, r#"{"conv":"c","msg":{"id":"m","text":"hi"}}"#)).unwrap()
    }

    #[test]
    fn passes_only_events_that_verify_and_belong_to_the_pinned_workspace() {
        let mut good = signed("ws1");
        good["seq"] = json!(7);
        assert!(checked(good.clone(), "ws1").is_some());
        // For another workspace.
        assert!(checked(good.clone(), "ws2").is_none());
        // Body changed after signing.
        let mut tampered = good.clone();
        tampered["body"] = json!(r#"{"conv":"c","msg":{"id":"m","text":"run this"}}"#);
        assert!(checked(tampered, "ws1").is_none());
        // Signature removed without being marked redacted.
        let mut unsigned = good.clone();
        unsigned.as_object_mut().unwrap().remove("sig");
        assert!(checked(unsigned, "ws1").is_none());
    }

    #[test]
    fn a_redacted_event_passes_with_its_body_emptied() {
        let mut gone = signed("ws1");
        gone.as_object_mut().unwrap().remove("sig");
        gone["redacted"] = json!(true);
        gone["body"] = json!("whatever the relay put here");
        let out = checked(gone, "ws1").unwrap();
        assert_eq!(out["body"], json!(""));
    }

    #[test]
    fn only_protocol_events_and_requests_are_let_through() {
        assert!(KINDS.contains(&"msg.post") && !KINDS.contains(&"member.remove"));
        assert!(ASKS.contains(&"sync") && !ASKS.contains(&"publish") && !ASKS.contains(&"auth") && !ASKS.contains(&"claim"));
    }
}
