// OpenCode agent chat provider: each Choom turn is one turn on a local
// `opencode serve`, so replies can use the user's tools (web fetch, Playwright,
// agent-reach, MCP servers). Choom reuses a server that is already up, starts
// its own only when none answers, and stops only the one it started.
//
// Permission prompts surface in the island through the same Allow / Deny card
// Claude Code uses, and the answer goes straight back. A prompt nobody answers
// is left alone: OpenChamber or the TUI may pick it up.

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::claude::{Chat, ChatContext, ChatReply};
use crate::island::WINDOW_LABEL;
use crate::log;
use crate::pipe::{self, Pending};
use crate::settings::{self, Settings};

const DEFAULT_SERVER_URL: &str = "http://127.0.0.1:4096";
const DEFAULT_PORT: u16 = 4096;
const NOT_RUNNING: &str = "OpenCode isn't running. Start it with: opencode serve";
const HEALTH_TIMEOUT: Duration = Duration::from_millis(1500);
const START_TIMEOUT: Duration = Duration::from_secs(20);
const TURN_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const PERMISSION_POLL: Duration = Duration::from_millis(800);

const SYSTEM_PROMPT: &str = "You are Choom, a personal AI assistant living at the top of the user's screen. \
You may use your tools to research, browse, run commands and work with files when that helps. \
Respond in the user's language. Keep replies short unless the user asks for more detail. \
No markdown formatting (no **, no ##, no bullet dashes). Use plain text with line breaks.";

/// What agent mode remembers between turns: the OpenCode session and which chat
/// generation it belongs to, plus the pid of the server when Choom started one.
#[derive(Default)]
pub struct AgentState {
    session: Mutex<Option<(String, u64)>>,
    child_pid: Mutex<Option<u32>>,
}

#[derive(Serialize)]
pub struct AgentStatus {
    pub reachable: bool,
    pub version: Option<String>,
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

/// The port in the server URL, or OpenCode's default when it carries none.
fn server_port(url: &str) -> u16 {
    url.rsplit_once(':')
        .and_then(|(_, tail)| tail.split('/').next())
        .and_then(|port| port.parse::<u16>().ok())
        .unwrap_or(DEFAULT_PORT)
}

/// The settings URL without a trailing slash; the default when it is empty.
fn base_url(settings: &Settings) -> String {
    let url = settings.opencode_server_url.trim();
    let url = if url.is_empty() { DEFAULT_SERVER_URL } else { url };
    url.trim_end_matches('/').to_string()
}

/// The prompt body for one turn. `model` is "providerID/modelID"; an empty or
/// malformed value leaves the server's default model in place.
fn build_turn_body(text: &str, model: &str) -> Value {
    let mut body = json!({
        "parts": [{ "type": "text", "text": text }],
        "system": SYSTEM_PROMPT,
    });
    if let Some((provider_id, model_id)) = model.split_once('/') {
        body["model"] = json!({ "providerID": provider_id, "modelID": model_id });
    }
    body
}

/// One text part: the window or file context, then the ask.
fn turn_text(query: &str, context: Option<&ChatContext>) -> String {
    match context {
        Some(ChatContext::File { path, .. }) => {
            format!("The user attached a file: {path}\n\n{query}")
        }
        Some(ChatContext::Window { app_name, title, url }) => {
            let mut line = format!("Context: App: {app_name}, Window: {title}");
            if let Some(url) = url {
                line.push_str(&format!(", URL: {url}"));
            }
            format!("{line}\n\n{query}")
        }
        None => query.to_string(),
    }
}

/// The reply shown in the island: the turn's own text, never the synthetic
/// parts the server adds around tool use. "Done." when the turn produced none.
fn reply_text(parts: &[Value]) -> String {
    let text = parts
        .iter()
        .filter(|part| part.get("type").and_then(Value::as_str) == Some("text"))
        .filter(|part| part.get("synthetic").and_then(Value::as_bool) != Some(true))
        .filter_map(|part| part.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string();
    if text.is_empty() {
        "Done.".to_string()
    } else {
        text
    }
}

/// The island's PermissionRequest payload for one OpenCode permission, shaped
/// like the Claude Code one so the existing card and buttons work unchanged.
fn hook_payload(permission: &Value, cwd: &str, session_id: &str) -> Value {
    let tool = permission
        .get("permission")
        .and_then(Value::as_str)
        .unwrap_or("tool");
    let command = permission
        .get("patterns")
        .and_then(Value::as_array)
        .map(|patterns| {
            patterns
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(", ")
        })
        .unwrap_or_default();
    json!({
        "hook_event_name": "PermissionRequest",
        "coucou_agent": "opencode",
        "tool_name": tool,
        "tool_input": { "command": command },
        "cwd": cwd,
        "session_id": session_id,
    })
}

/// The message out of an OpenCode error body, or the body itself as a fallback.
fn error_detail(text: &str) -> String {
    serde_json::from_str::<Value>(text)
        .ok()
        .and_then(|value| {
            value
                .get("data")
                .and_then(|data| data.get("message"))
                .and_then(Value::as_str)
                .or_else(|| value.get("message").and_then(Value::as_str))
                .or_else(|| value.get("error").and_then(Value::as_str))
                .map(str::to_string)
        })
        .unwrap_or_else(|| text.chars().take(200).collect())
}

// ── Server ────────────────────────────────────────────────────────────────────

fn client(timeout: Duration) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|e| e.to_string())
}

/// The server version when something answers, None when it does not.
async fn health(base: &str) -> Option<String> {
    let client = client(HEALTH_TIMEOUT).ok()?;
    let response = client
        .get(format!("{base}/global/health"))
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let value: Value = response.json().await.ok()?;
    value
        .get("version")
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// Starts `opencode serve` on the URL's port, from the agent working directory.
fn spawn_server(base: &str, state: &AgentState) -> Result<(), String> {
    let dir = settings::local_dir().join("agent");
    crate::platform::ensure_private_dir(&dir)
        .map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    let port = server_port(base).to_string();

    // On Windows `opencode` is an npm shim (a .cmd file), so cmd runs it; the
    // no_console flag keeps the console window from flashing.
    #[cfg(windows)]
    let mut cmd = {
        let mut cmd = std::process::Command::new("cmd");
        cmd.args(["/C", "opencode", "serve", "--hostname", "127.0.0.1", "--port", port.as_str()]);
        cmd
    };
    #[cfg(target_os = "linux")]
    let mut cmd = {
        let mut cmd = std::process::Command::new("opencode");
        cmd.args(["serve", "--hostname", "127.0.0.1", "--port", port.as_str()]);
        cmd
    };

    cmd.current_dir(&dir)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    crate::platform::no_console(&mut cmd);
    let child = cmd
        .spawn()
        .map_err(|e| format!("Could not start OpenCode: {e}"))?;
    *state.child_pid.lock().unwrap() = Some(child.id());
    Ok(())
}

/// Makes sure a server answers, and returns its base URL.
async fn ensure_server(settings: &Settings, state: &AgentState) -> Result<String, String> {
    let base = base_url(settings);
    if health(&base).await.is_some() {
        return Ok(base);
    }
    if !settings.opencode_autostart {
        return Err(NOT_RUNNING.into());
    }
    spawn_server(&base, state)?;
    // `opencode serve` needs a moment to bind the port.
    let deadline = tokio::time::Instant::now() + START_TIMEOUT;
    loop {
        tokio::time::sleep(Duration::from_millis(500)).await;
        if health(&base).await.is_some() {
            return Ok(base);
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(NOT_RUNNING.into());
        }
    }
}

/// Stops the server Choom started, if any; never the user's own.
pub fn shutdown(state: &AgentState) {
    let pid = state.child_pid.lock().unwrap().take();
    let Some(pid) = pid else { return };
    // The tree flag matters: cmd spawns node.
    #[cfg(windows)]
    {
        let mut cmd = std::process::Command::new("taskkill");
        cmd.args(["/PID", &pid.to_string(), "/T", "/F"]);
        let _ = crate::platform::no_console(&mut cmd).spawn();
    }
    #[cfg(target_os = "linux")]
    unsafe {
        libc::kill(pid as i32, libc::SIGTERM);
    }
}

/// Whether a server answers, and its version.
pub async fn status(settings: &Settings) -> AgentStatus {
    match health(&base_url(settings)).await {
        Some(version) => AgentStatus {
            reachable: true,
            version: Some(version),
        },
        None => AgentStatus {
            reachable: false,
            version: None,
        },
    }
}

/// Every model the server's configured providers expose, as
/// (providerID/modelID, label). The label keeps the provider name so two
/// providers with the same model name stay apart.
pub async fn models(settings: &Settings) -> Result<Vec<(String, String)>, String> {
    let client = client(Duration::from_secs(5))?;
    let response = client
        .get(format!("{}/config/providers", base_url(settings)))
        .send()
        .await
        .map_err(|e| format!("Network error: {e}"))?;
    let status = response.status();
    let text = response.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("OpenCode agent {status}: {}", error_detail(&text)));
    }
    let value: Value =
        serde_json::from_str(&text).map_err(|e| format!("Bad OpenCode response: {e}"))?;
    let mut models = Vec::new();
    if let Some(providers) = value.get("providers").and_then(Value::as_array) {
        for provider in providers {
            let id = provider
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let name = provider.get("name").and_then(Value::as_str).unwrap_or(id);
            let Some(map) = provider.get("models").and_then(Value::as_object) else {
                continue;
            };
            for (model_id, model) in map {
                let label = model
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or(model_id);
                models.push((format!("{id}/{model_id}"), format!("{name} {label}")));
            }
        }
    }
    Ok(models)
}

// ── Turn ──────────────────────────────────────────────────────────────────────

/// POSTs JSON and hands back the parsed body. HTTP errors carry the server's
/// own message, which is what makes a failure obvious in the island.
async fn post_json(client: &reqwest::Client, url: &str, body: &Value) -> Result<Value, String> {
    let response = client
        .post(url)
        .json(body)
        .send()
        .await
        .map_err(|e| format!("Network error: {e}"))?;
    let status = response.status();
    let text = response.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("OpenCode agent {status}: {}", error_detail(&text)));
    }
    if text.is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_str(&text).map_err(|e| format!("Bad OpenCode response: {e}"))
}

/// Creates the server-side session the chat lives in.
async fn create_session(base: &str) -> Result<String, String> {
    let client = client(Duration::from_secs(10))?;
    let value = post_json(&client, &format!("{base}/session"), &json!({ "title": "Choom" })).await?;
    match value.get("id").and_then(Value::as_str) {
        Some(id) if id.starts_with("ses") => Ok(id.to_string()),
        _ => Err("Unexpected OpenCode response: no session id.".into()),
    }
}

/// Best effort abort, used when a reset made the turn's reply unwanted.
async fn abort(client: &reqwest::Client, base: &str, session_id: &str) {
    let _ = client
        .post(format!("{base}/session/{session_id}/abort"))
        .send()
        .await;
}

/// One chat turn against the local OpenCode server. Agent mode keeps its
/// history on the server, so nothing is pushed to `Chat`; the chat generation
/// only decides when a fresh session is needed.
pub async fn send(
    app: &AppHandle,
    chat: &Chat,
    settings: &Settings,
    query: String,
    context: Option<ChatContext>,
) -> Result<ChatReply, String> {
    let agent_state = app.state::<AgentState>();
    let base = ensure_server(settings, &agent_state).await?;
    let generation = chat.generation();

    // Same session while the same chat is up; a reset starts a new one.
    let stored = agent_state.session.lock().unwrap().clone();
    let session_id = match stored {
        Some((id, stored_generation)) if stored_generation == generation => id,
        _ => {
            let id = create_session(&base).await?;
            *agent_state.session.lock().unwrap() = Some((id.clone(), generation));
            id
        }
    };

    let text = turn_text(&query, context.as_ref());
    let body = build_turn_body(&text, settings.opencode_agent_model.trim());

    let client = client(TURN_TIMEOUT)?;
    let done = Arc::new(AtomicBool::new(false));
    let cwd = settings::local_dir().join("agent").to_string_lossy().to_string();
    tauri::async_runtime::spawn(watch_permissions(
        app.clone(),
        client.clone(),
        base.clone(),
        session_id.clone(),
        cwd,
        done.clone(),
    ));

    let result = post_json(
        &client,
        &format!("{base}/session/{session_id}/message"),
        &body,
    )
    .await;
    done.store(true, Ordering::Relaxed);

    // A settings change may have reset the chat while the call was in flight.
    if chat.generation() != generation {
        abort(&client, &base, &session_id).await;
        return Err("Chat was reset.".into());
    }

    let response = result?;
    let parts = response
        .get("parts")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    Ok(ChatReply {
        text: reply_text(&parts),
    })
}

/// While a turn is in flight, turns the server's pending permissions for that
/// session into island cards, one at a time, and posts the answer back.
async fn watch_permissions(
    app: AppHandle,
    client: reqwest::Client,
    base: String,
    session_id: String,
    cwd: String,
    done: Arc<AtomicBool>,
) {
    let mut handled: HashSet<String> = HashSet::new();
    while !done.load(Ordering::Relaxed) {
        if let Ok(response) = client
            .get(format!("{base}/permission"))
            .timeout(Duration::from_secs(5))
            .send()
            .await
        {
            if let Ok(value) = response.json::<Value>().await {
                if let Some(list) = value.as_array() {
                    for permission in list {
                        if done.load(Ordering::Relaxed) {
                            return;
                        }
                        let id = permission
                            .get("id")
                            .and_then(Value::as_str)
                            .unwrap_or_default();
                        let same_session = permission.get("sessionID").and_then(Value::as_str)
                            == Some(session_id.as_str());
                        if id.is_empty() || !same_session || !handled.insert(id.to_string()) {
                            continue;
                        }
                        answer_permission(&app, &client, &base, permission, &cwd, &session_id).await;
                    }
                }
            }
        }
        tokio::time::sleep(PERMISSION_POLL).await;
    }
}

/// Shows one card and waits for the human, exactly like pipe::handle does for
/// Claude Code. No decision means no answer at all.
async fn answer_permission(
    app: &AppHandle,
    client: &reqwest::Client,
    base: &str,
    permission: &Value,
    cwd: &str,
    session_id: &str,
) {
    let id = format!(
        "{}-{}",
        std::process::id(),
        pipe::COUNTER.fetch_add(1, Ordering::Relaxed)
    );
    let (tx, mut rx) = tokio::sync::mpsc::channel(4);
    app.state::<Pending>().0.lock().unwrap().insert(id.clone(), tx);
    let mut payload = hook_payload(permission, cwd, session_id);
    payload["request_id"] = json!(id.clone());
    log::line(format!("opencode permission id={id}"));
    let _ = app.emit_to(WINDOW_LABEL, "hook", payload);

    let decision = pipe::wait_for_decision(&id, &mut rx).await;
    app.state::<Pending>().0.lock().unwrap().remove(&id);

    let Some(decision) = decision else { return };
    let request_id = permission
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let reply = if decision == "allow" { "once" } else { "reject" };
    let body = json!({ "reply": reply });
    if let Err(err) = post_json(
        client,
        &format!("{base}/permission/{request_id}/reply"),
        &body,
    )
    .await
    {
        log::line(format!("opencode permission reply failed: {err}"));
    }
}

#[cfg(test)]
mod tests {
    use super::{build_turn_body, hook_payload, reply_text, server_port, turn_text};
    use crate::claude::ChatContext;
    use serde_json::json;

    #[test]
    fn port_comes_from_the_server_url() {
        assert_eq!(server_port("http://127.0.0.1:4096"), 4096);
        assert_eq!(server_port("http://127.0.0.1:4097/"), 4097);
        // No port in the URL: OpenCode's default.
        assert_eq!(server_port("http://127.0.0.1"), 4096);
    }

    #[test]
    fn turn_body_splits_the_model_and_omits_it_when_empty() {
        let body = build_turn_body("hi", "anthropic/claude-sonnet-4-5");
        assert_eq!(body["parts"][0]["text"], "hi");
        assert_eq!(body["model"]["providerID"], "anthropic");
        assert_eq!(body["model"]["modelID"], "claude-sonnet-4-5");
        assert!(body.get("system").is_some());

        let body = build_turn_body("hi", "");
        assert!(body.get("model").is_none());
    }

    #[test]
    fn turn_text_carries_the_context_then_the_ask() {
        let file = ChatContext::File {
            name: "notes.txt".into(),
            path: "C:\\tmp\\notes.txt".into(),
        };
        let text = turn_text("sum this up", Some(&file));
        assert!(text.contains("The user attached a file: C:\\tmp\\notes.txt"));
        assert!(text.ends_with("sum this up"));
        assert_eq!(turn_text("hello", None), "hello");
    }

    #[test]
    fn reply_text_skips_synthetic_parts_and_falls_back() {
        let parts = vec![
            json!({ "type": "text", "text": "Let me check.", "synthetic": true }),
            json!({ "type": "tool", "tool": "bash" }),
            json!({ "type": "text", "text": "Done checking." }),
        ];
        assert_eq!(reply_text(&parts), "Done checking.");
        assert_eq!(reply_text(&[]), "Done.");
        assert_eq!(reply_text(&[json!({ "type": "text", "text": "  " })]), "Done.");
    }

    #[test]
    fn hook_payload_matches_the_island_card() {
        let permission = json!({
            "id": "per_1",
            "sessionID": "ses_1",
            "permission": "bash",
            "patterns": ["git status", "git diff"],
        });
        let payload = hook_payload(&permission, "C:\\agent", "ses_1");
        assert_eq!(payload["hook_event_name"], "PermissionRequest");
        assert_eq!(payload["coucou_agent"], "opencode");
        assert_eq!(payload["tool_name"], "bash");
        assert_eq!(payload["tool_input"]["command"], "git status, git diff");
        assert_eq!(payload["cwd"], "C:\\agent");
        assert_eq!(payload["session_id"], "ses_1");
    }
}
