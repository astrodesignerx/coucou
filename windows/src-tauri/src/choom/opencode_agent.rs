// OpenCode agent chat provider: each Choom turn is one turn on a local
// OpenCode v2 server, so replies can use the user's tools (web fetch,
// Playwright, agent-reach, MCP servers). Choom reuses a server that is already
// up, starts its own only when none answers, and stops only the one it started.
// A server Choom starts gets a random password that lives in memory only.
//
// Permission prompts surface in the island through the same Allow / Deny card
// Claude Code uses, and the answer goes straight back. A prompt nobody answers
// is left alone: OpenChamber or the TUI may pick it up.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
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

const DEFAULT_SERVER_URL: &str = "http://127.0.0.1:4747";
const DEFAULT_PORT: u16 = 4747;
const NOT_RUNNING: &str = "OpenCode isn't running. Start it with: opencode serve";
/// Basic auth user for the server when Choom started it.
const AUTH_USER: &str = "opencode";
const HEALTH_TIMEOUT: Duration = Duration::from_millis(1500);
const START_TIMEOUT: Duration = Duration::from_secs(20);
const TURN_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const PERMISSION_POLL: Duration = Duration::from_millis(800);

const SYSTEM_PROMPT: &str = "You are Choom, a personal AI assistant living at the top of the user's screen. \
You may use your tools to research, browse, run commands and work with files when that helps. \
Respond in the user's language. Keep replies short unless the user asks for more detail. \
No markdown formatting (no **, no ##, no bullet dashes). Use plain text with line breaks.";

/// What agent mode remembers between turns: the OpenCode session and which chat
/// generation it belongs to, the pid of the server when Choom started one, and
/// the password it was started with. The password never leaves this struct.
#[derive(Default)]
pub struct AgentState {
    session: Mutex<Option<(String, u64)>>,
    child_pid: Mutex<Option<u32>>,
    password: Mutex<Option<String>>,
}

#[derive(Serialize)]
pub struct AgentStatus {
    pub reachable: bool,
    pub version: Option<String>,
    /// Set when a server answered 401: the island shows this instead.
    pub error: Option<String>,
}

/// How Choom talks to the server: HTTP basic auth only when it started the
/// server itself, with the password generated at spawn time.
#[derive(Clone, Default)]
struct ServerAuth {
    password: Option<String>,
}

impl ServerAuth {
    fn apply(&self, request: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        match &self.password {
            Some(password) => request.basic_auth(AUTH_USER, Some(password)),
            None => request,
        }
    }
}

fn auth(state: &AgentState) -> ServerAuth {
    ServerAuth {
        password: state.password.lock().unwrap().clone(),
    }
}

/// What a health check found: a version, a password-protected server, or
/// nothing at all.
enum Health {
    Ok(String),
    Unauthorized,
    Down,
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

/// Choom's agent working directory: chats see this folder by default.
fn agent_dir() -> PathBuf {
    settings::local_dir().join("agent")
}

/// OpenChamber's bundled v2 server, when it is installed.
#[cfg(windows)]
fn bundled_binary() -> PathBuf {
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_default();
    base.join("Programs")
        .join("@openchamberelectron")
        .join("resources")
        .join("opencode-cli")
        .join("opencode.exe")
}

#[cfg(target_os = "linux")]
fn bundled_binary() -> PathBuf {
    PathBuf::new()
}

/// The program Choom should run for `opencode serve`: the configured binary,
/// else OpenChamber's bundled v2 when present, else the npm shim on PATH
/// (None), which on Windows only cmd can start.
fn resolve_binary(
    configured: &str,
    bundled: &Path,
    exists: impl Fn(&Path) -> bool,
) -> Option<PathBuf> {
    let configured = configured.trim();
    if !configured.is_empty() {
        return Some(PathBuf::from(configured));
    }
    if exists(bundled) {
        return Some(bundled.to_path_buf());
    }
    None
}

/// A 32-character hex password for the server Choom starts. RandomState is
/// seeded from the OS and the clock breaks up the hash output further, so no
/// new dependency is needed. The value never reaches disk or a log line.
fn spawn_password() -> String {
    use std::hash::{BuildHasher, Hasher};

    let mut out = String::with_capacity(32);
    let mut counter = 0u64;
    while out.len() < 32 {
        let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
        counter += 1;
        hasher.write_u64(counter);
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0);
        hasher.write_u64(now);
        out.push_str(&format!("{:016x}", hasher.finish()));
    }
    out.truncate(32);
    out
}

/// The v2 create-session body: title, working directory and optional model.
/// `model` is "providerID/modelID"; empty leaves the server's default in place.
fn create_session_body(dir: &str, model: &str) -> Value {
    let mut body = json!({
        "title": "Choom",
        "location": { "directory": dir },
    });
    if let Some((provider_id, model_id)) = model.split_once('/') {
        body["model"] = json!({ "id": model_id, "providerID": provider_id });
    }
    body
}

/// v2 prompts are plain text and have no system field, so a session's first
/// turn carries the Choom instructions itself, followed by a blank line.
fn prompt_text(text: &str, first_turn: bool) -> String {
    if first_turn {
        format!("{SYSTEM_PROMPT}\n\n{text}")
    } else {
        text.to_string()
    }
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

/// The turn's reply, read from the v2 message list (newest first, see
/// `order=desc`): walk to the prompt's own id, then collect the assistant text
/// messages behind it, oldest first. None when the turn produced no text and
/// did not fail.
fn reply_from_messages(messages: &[Value], prompt_id: &str) -> Result<Option<String>, String> {
    let mut parts: Vec<String> = Vec::new();
    let mut outcome: Option<bool> = None;
    for message in messages {
        if message.get("id").and_then(Value::as_str) == Some(prompt_id) {
            break;
        }
        match message.get("type").and_then(Value::as_str) {
            Some("assistant") => {
                let text = message
                    .get("content")
                    .and_then(Value::as_array)
                    .map(|items| {
                        items
                            .iter()
                            .filter(|item| {
                                item.get("type").and_then(Value::as_str) == Some("text")
                            })
                            .filter_map(|item| item.get("text").and_then(Value::as_str))
                            .collect::<Vec<_>>()
                            .join("\n")
                    })
                    .unwrap_or_default();
                let text = text.trim();
                if !text.is_empty() {
                    parts.push(text.to_string());
                }
            }
            Some("idle") => {
                if outcome.is_none() {
                    outcome =
                        Some(message.get("outcome").and_then(Value::as_str) == Some("failed"));
                }
            }
            _ => {}
        }
    }
    if parts.is_empty() {
        if outcome == Some(true) {
            return Err("OpenCode agent: the turn failed.".into());
        }
        return Ok(None);
    }
    // The walk went newest first; the reply itself reads oldest first.
    parts.reverse();
    Ok(Some(parts.join("\n").trim().to_string()))
}

/// The island's PermissionRequest payload for one v2 permission, shaped like
/// the Claude Code one so the existing card and buttons work unchanged.
fn hook_payload(permission: &Value, cwd: &str, session_id: &str) -> Value {
    let tool = permission
        .get("action")
        .and_then(Value::as_str)
        .unwrap_or("tool");
    let resources = permission
        .get("resources")
        .and_then(Value::as_array)
        .map(|resources| {
            resources
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(", ")
        })
        .unwrap_or_default();
    let command = if resources.trim().is_empty() {
        permission
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    } else {
        resources
    };
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

/// The one message that tells the user how to get past a password-protected
/// server they did not start.
fn another_server_error(base: &str) -> String {
    format!(
        "Another OpenCode server is using port {} and needs a password. Change the Server address in Settings.",
        server_port(base)
    )
}

/// The error text for a failed request; a 401 means a foreign server owns the
/// port, which only the user can fix.
fn http_error(base: &str, status: reqwest::StatusCode, text: &str) -> String {
    if status == reqwest::StatusCode::UNAUTHORIZED {
        another_server_error(base)
    } else {
        format!("OpenCode agent {status}: {}", error_detail(text))
    }
}

// ── Server ────────────────────────────────────────────────────────────────────

fn client(timeout: Duration) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|e| e.to_string())
}

async fn health(base: &str, auth: &ServerAuth) -> Health {
    let Ok(client) = client(HEALTH_TIMEOUT) else {
        return Health::Down;
    };
    let request = auth.apply(client.get(format!("{base}/api/info")));
    match request.send().await {
        Err(_) => Health::Down,
        Ok(response) => {
            if response.status() == reqwest::StatusCode::UNAUTHORIZED {
                return Health::Unauthorized;
            }
            if !response.status().is_success() {
                return Health::Down;
            }
            match response.json::<Value>().await {
                Ok(value) => match value.get("version").and_then(Value::as_str) {
                    Some(version) => Health::Ok(version.to_string()),
                    None => Health::Down,
                },
                Err(_) => Health::Down,
            }
        }
    }
}

/// Starts `opencode serve` on the URL's port, from the agent working directory,
/// with the generated password in its environment.
fn spawn_server(
    base: &str,
    settings: &Settings,
    password: &str,
    state: &AgentState,
) -> Result<(), String> {
    let dir = agent_dir();
    crate::platform::ensure_private_dir(&dir)
        .map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    let port = server_port(base).to_string();
    let binary = resolve_binary(&settings.opencode_binary, &bundled_binary(), |path| path.is_file());

    #[cfg(windows)]
    let mut cmd = match binary {
        Some(exe) => std::process::Command::new(exe),
        None => {
            // The npm shim is a .cmd file, so only cmd can start it.
            let mut cmd = std::process::Command::new("cmd");
            cmd.args(["/C", "opencode"]);
            cmd
        }
    };
    #[cfg(target_os = "linux")]
    let mut cmd = match binary {
        Some(exe) => std::process::Command::new(exe),
        None => std::process::Command::new("opencode"),
    };

    cmd.env("OPENCODE_SERVER_PASSWORD", password)
        .args(["serve", "--hostname", "127.0.0.1", "--port", port.as_str()])
        .current_dir(&dir)
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

/// Makes sure a server answers. Returns its base URL and how to authenticate.
async fn ensure_server(
    settings: &Settings,
    state: &AgentState,
) -> Result<(String, ServerAuth), String> {
    let base = base_url(settings);
    let current = auth(state);
    match health(&base, &current).await {
        Health::Ok(_) => return Ok((base, current)),
        Health::Unauthorized => return Err(another_server_error(&base)),
        Health::Down => {
            // A server Choom started earlier is gone: forget its password.
            *state.password.lock().unwrap() = None;
            *state.child_pid.lock().unwrap() = None;
        }
    }
    if !settings.opencode_autostart {
        return Err(NOT_RUNNING.into());
    }
    let password = spawn_password();
    spawn_server(&base, settings, &password, state)?;
    *state.password.lock().unwrap() = Some(password.clone());
    let fresh = ServerAuth {
        password: Some(password),
    };
    // `opencode serve` needs a moment to bind the port.
    let deadline = tokio::time::Instant::now() + START_TIMEOUT;
    loop {
        tokio::time::sleep(Duration::from_millis(500)).await;
        match health(&base, &fresh).await {
            Health::Ok(_) => return Ok((base, fresh)),
            Health::Unauthorized => return Err(another_server_error(&base)),
            Health::Down => {}
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
    // The tree flag matters: the npm shim spawns node.
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
pub async fn status(settings: &Settings, state: &AgentState) -> AgentStatus {
    let base = base_url(settings);
    match health(&base, &auth(state)).await {
        Health::Ok(version) => AgentStatus {
            reachable: true,
            version: Some(version),
            error: None,
        },
        Health::Unauthorized => AgentStatus {
            reachable: false,
            version: None,
            error: Some(another_server_error(&base)),
        },
        Health::Down => AgentStatus {
            reachable: false,
            version: None,
            error: None,
        },
    }
}

/// Every model the server offers, as (providerID/modelID, label).
pub async fn models(
    settings: &Settings,
    state: &AgentState,
) -> Result<Vec<(String, String)>, String> {
    let client = client(Duration::from_secs(5))?;
    let base = base_url(settings);
    let request = auth(state).apply(client.get(format!("{base}/api/model")));
    let value = send_json(&base, request).await?;
    let mut models = Vec::new();
    if let Some(list) = value.get("data").and_then(Value::as_array) {
        for model in list {
            let model_id = model
                .get("modelID")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let provider_id = model
                .get("providerID")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let name = model.get("name").and_then(Value::as_str).unwrap_or(model_id);
            models.push((
                format!("{provider_id}/{model_id}"),
                format!("{name} ({provider_id})"),
            ));
        }
    }
    Ok(models)
}

// ── Turn ──────────────────────────────────────────────────────────────────────

/// Sends a request and hands back the parsed body. v2 wraps payloads in
/// `data`, which callers read. HTTP errors carry the server's own message.
async fn send_json(base: &str, request: reqwest::RequestBuilder) -> Result<Value, String> {
    let response = request.send().await.map_err(|e| format!("Network error: {e}"))?;
    let status = response.status();
    let text = response.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(http_error(base, status, &text));
    }
    if text.is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_str(&text).map_err(|e| format!("Bad OpenCode response: {e}"))
}

/// Same, for the endpoints that answer 204 with no body.
async fn send_empty(base: &str, request: reqwest::RequestBuilder) -> Result<(), String> {
    let response = request.send().await.map_err(|e| format!("Network error: {e}"))?;
    let status = response.status();
    if status.is_success() {
        return Ok(());
    }
    let text = response.text().await.unwrap_or_default();
    Err(http_error(base, status, &text))
}

/// Creates the server-side session the chat lives in.
async fn create_session(
    base: &str,
    auth: &ServerAuth,
    settings: &Settings,
) -> Result<String, String> {
    let client = client(Duration::from_secs(10))?;
    let dir = agent_dir();
    let body = create_session_body(&dir.to_string_lossy(), settings.opencode_agent_model.trim());
    let request = auth.apply(client.post(format!("{base}/api/session")).json(&body));
    let value = send_json(base, request).await?;
    match value
        .get("data")
        .and_then(|data| data.get("id"))
        .and_then(Value::as_str)
    {
        Some(id) if id.starts_with("ses") => Ok(id.to_string()),
        _ => Err("Unexpected OpenCode response: no session id.".into()),
    }
}

/// Best effort interrupt, used when a reset made the turn's reply unwanted.
async fn abort(
    client: &reqwest::Client,
    base: &str,
    auth: &ServerAuth,
    session_id: &str,
) {
    let _ = auth
        .apply(client.post(format!("{base}/api/session/{session_id}/interrupt")))
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
    let (base, auth) = ensure_server(settings, &agent_state).await?;
    let generation = chat.generation();

    // Same session while the same chat is up; a reset starts a new one.
    let stored = agent_state.session.lock().unwrap().clone();
    let (session_id, first_turn) = match stored {
        Some((id, stored_generation)) if stored_generation == generation => (id, false),
        _ => {
            let id = create_session(&base, &auth, settings).await?;
            *agent_state.session.lock().unwrap() = Some((id.clone(), generation));
            (id, true)
        }
    };

    let text = prompt_text(&turn_text(&query, context.as_ref()), first_turn);
    let client = client(TURN_TIMEOUT)?;

    // v2 admits the prompt at once; the wait below blocks until the turn ends.
    let request = auth
        .apply(
            client
                .post(format!("{base}/api/session/{session_id}/prompt"))
                .json(&json!({ "text": text })),
        );
    let prompt = send_json(&base, request).await?;
    let prompt_id = prompt
        .get("data")
        .and_then(|data| data.get("id"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| "Unexpected OpenCode response: no prompt id.".to_string())?;

    // Permissions are answered while the turn runs.
    let done = Arc::new(AtomicBool::new(false));
    let cwd = agent_dir().to_string_lossy().to_string();
    tauri::async_runtime::spawn(watch_permissions(
        app.clone(),
        client.clone(),
        auth.clone(),
        base.clone(),
        session_id.clone(),
        cwd,
        done.clone(),
    ));

    let request = auth.apply(
        client.post(format!(
            "{base}/api/experimental/session/{session_id}/wait"
        )),
    );
    let waited = send_empty(&base, request).await;
    done.store(true, Ordering::Relaxed);

    // A settings change may have reset the chat while the call was in flight.
    if chat.generation() != generation {
        abort(&client, &base, &auth, &session_id).await;
        return Err("Chat was reset.".into());
    }
    waited?;

    let request = auth.apply(client.get(format!(
        "{base}/api/session/{session_id}/message?order=desc&limit=50"
    )));
    let messages = send_json(&base, request).await?;
    let list = messages
        .get("data")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let reply = reply_from_messages(&list, &prompt_id)?;
    Ok(ChatReply {
        text: reply.unwrap_or_else(|| "Done.".to_string()),
    })
}

/// While a turn is in flight, turns the server's pending permissions for that
/// session into island cards, one at a time, and posts the answer back.
async fn watch_permissions(
    app: AppHandle,
    client: reqwest::Client,
    auth: ServerAuth,
    base: String,
    session_id: String,
    cwd: String,
    done: Arc<AtomicBool>,
) {
    let mut handled: HashSet<String> = HashSet::new();
    while !done.load(Ordering::Relaxed) {
        let request = auth
            .apply(client.get(format!("{base}/api/session/{session_id}/permission")))
            .timeout(Duration::from_secs(5));
        if let Ok(response) = request.send().await {
            if let Ok(value) = response.json::<Value>().await {
                if let Some(list) = value.get("data").and_then(Value::as_array) {
                    for permission in list {
                        if done.load(Ordering::Relaxed) {
                            return;
                        }
                        let id = permission
                            .get("id")
                            .and_then(Value::as_str)
                            .unwrap_or_default();
                        if id.is_empty() || !handled.insert(id.to_string()) {
                            continue;
                        }
                        answer_permission(&app, &client, &auth, &base, permission, &cwd, &session_id)
                            .await;
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
    auth: &ServerAuth,
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
    let decision = if decision == "allow" { "once" } else { "reject" };
    let request = auth.apply(
        client
            .post(format!(
                "{base}/api/session/{session_id}/permission/{request_id}/reply"
            ))
            .json(&json!({ "decision": decision })),
    );
    if let Err(err) = send_empty(base, request).await {
        log::line(format!("opencode permission reply failed: {err}"));
    }
}

#[cfg(test)]
mod tests {
    use super::{
        create_session_body, hook_payload, reply_from_messages, resolve_binary, server_port,
        turn_text,
    };
    use crate::claude::ChatContext;
    use serde_json::{json, Value};

    /// `.scratch/v2-messages-sample.json`: one real "pong" turn.
    const MESSAGES_SAMPLE: &str = r#"{"data":[{"id":"msg_10ca22e25001qfgDUtmiTOeZ0W","time":{"created":1791213317669},"type":"idle","outcome":"succeeded"},{"id":"msg_10ca223d3001Zwzy7HaLLCYQ4P","time":{"created":1791213315073,"streamed":1791213317657,"completed":1791213317661},"type":"assistant","agent":"build","model":{"id":"qwen3.8-flash","providerID":"opencode-go","variant":"default"},"content":[{"type":"reasoning","text":"The user is asking me to reply with exactly \"pong\". Simple. Just reply with \"pong\".","state":{"signature":""},"time":{"created":1791213317162,"completed":1791213317638}},{"type":"text","text":"pong"}],"finish":"stop","rawFinish":"end_turn","cost":0.00208918,"tokens":{"input":6,"output":24,"reasoning":0,"cache":{"read":0,"write":10385}}},{"id":"msg_10ca22383001Yy2Mi8G3HhCn8j","time":{"created":1791213314996},"text":"Reply with exactly one word: pong","type":"user"}],"cursor":{"previous":"eyJpZCI6Im1zZ18xMGNhMjJlMjUwMDFxZmdEVXRtaVRPZVowVyIsIm9yZGVyIjoiZGVzYyIsImRpcmVjdGlvbiI6InByZXZpb3VzIn0","next":"eyJpZCI6Im1zZ18xMGNhMjIzODMwMDFZeTJNaThHM0hoQ244aiIsIm9yZGVyIjoiZGVzYyIsImRpcmVjdGlvbiI6Im5leHQifQ"}}"#;

    #[test]
    fn port_comes_from_the_server_url() {
        assert_eq!(server_port("http://127.0.0.1:4747"), 4747);
        assert_eq!(server_port("http://127.0.0.1:4748/"), 4748);
        // No port in the URL: OpenCode's default.
        assert_eq!(server_port("http://127.0.0.1"), 4747);
    }

    #[test]
    fn session_body_has_location_and_optional_model() {
        let body = create_session_body("C:\\agent", "openai/gpt-5");
        assert_eq!(body["title"], "Choom");
        assert_eq!(body["location"]["directory"], "C:\\agent");
        assert_eq!(body["model"]["id"], "gpt-5");
        assert_eq!(body["model"]["providerID"], "openai");

        let body = create_session_body("C:\\agent", "");
        assert!(body.get("model").is_none());
    }

    #[test]
    fn reply_comes_from_the_sample_messages() {
        let sample: Value = serde_json::from_str(MESSAGES_SAMPLE).unwrap();
        let messages = sample["data"].as_array().unwrap();
        let reply = reply_from_messages(messages, "msg_10ca22383001Yy2Mi8G3HhCn8j").unwrap();
        assert_eq!(reply.as_deref(), Some("pong"));
    }

    #[test]
    fn failed_turn_reports_the_error() {
        let messages = vec![
            json!({ "id": "msg_idle", "type": "idle", "outcome": "failed" }),
            json!({ "id": "msg_prompt", "type": "user", "text": "hi" }),
        ];
        assert_eq!(
            reply_from_messages(&messages, "msg_prompt").unwrap_err(),
            "OpenCode agent: the turn failed."
        );
        // An idle that succeeded with no text simply means no reply.
        let messages = vec![
            json!({ "id": "msg_idle", "type": "idle", "outcome": "succeeded" }),
            json!({ "id": "msg_prompt", "type": "user", "text": "hi" }),
        ];
        assert_eq!(reply_from_messages(&messages, "msg_prompt").unwrap(), None);
    }

    #[test]
    fn permission_card_matches_the_v2_request() {
        let permission = json!({
            "id": "per_1",
            "sessionID": "ses_1",
            "action": "bash",
            "resources": ["npm test", "npm run build"],
            "message": "Run commands?",
        });
        let payload = hook_payload(&permission, "C:\\agent", "ses_1");
        assert_eq!(payload["hook_event_name"], "PermissionRequest");
        assert_eq!(payload["coucou_agent"], "opencode");
        assert_eq!(payload["tool_name"], "bash");
        assert_eq!(payload["tool_input"]["command"], "npm test, npm run build");
        assert_eq!(payload["cwd"], "C:\\agent");
        assert_eq!(payload["session_id"], "ses_1");

        // No resources: the message is what the card shows.
        let bare = json!({
            "id": "per_2",
            "sessionID": "ses_1",
            "action": "edit",
            "resources": [],
            "message": "Edit these files?",
        });
        let payload = hook_payload(&bare, "C:\\agent", "ses_1");
        assert_eq!(payload["tool_name"], "edit");
        assert_eq!(payload["tool_input"]["command"], "Edit these files?");
    }

    #[test]
    fn binary_resolution_order() {
        let bundled = std::path::Path::new("bundle/opencode.exe");
        // A configured binary always wins.
        let configured = resolve_binary("tools/opencode.exe", bundled, |_| false);
        assert_eq!(
            configured.as_deref(),
            Some(std::path::Path::new("tools/opencode.exe"))
        );
        // Empty setting: the bundled v2 when it exists.
        let found = resolve_binary("", bundled, |path| path == bundled);
        assert_eq!(found.as_deref(), Some(bundled));
        // Empty setting and no bundled file: the npm shim.
        assert!(resolve_binary("", bundled, |_| false).is_none());
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
}
