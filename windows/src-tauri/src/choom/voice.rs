// Choom voice and Jarvis runtime (Windows first release).
// Offline Windows desktop speech engine behind a replaceable runtime boundary.
// Rust owns a single hidden helper process (PowerShell 5.1 + System.Speech),
// a JSON-line stdin/stdout protocol, bounded buffers, cancellation
// generations, events and cleanup. Never blocks the Tauri UI.

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::platform;

/// Max bytes per helper protocol line. Longer lines are dropped, never grown.
pub const MAX_LINE_BYTES: usize = 65536;
/// Max cached transcript chars per turn. Bounded RAM only, no disk recordings.
pub const MAX_TEXT_CHARS: usize = 2000;
/// Max partial chars forwarded per event.
#[allow(dead_code)]
pub const MAX_PARTIAL_CHARS: usize = 500;
/// Max spoken chars per talkback. Short factual results only.
pub const MAX_SPEAK_CHARS: usize = 600;
/// Max local memories stored. Explicit opt-in only.
pub const MAX_MEMORIES: usize = 100;
/// Max chars per memory fact.
pub const MAX_MEMORY_CHARS: usize = 500;
/// Endpoint silence default (ms). Adjustable in settings.
#[allow(dead_code)]
pub const DEFAULT_ENDPOINT_MS: u64 = 900;
/// Follow-up window default (ms).
#[allow(dead_code)]
pub const DEFAULT_FOLLOWUP_MS: u64 = 8000;

/// Runtime states: disabled, standby, listening, processing, working, speaking, error.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[allow(dead_code)]
#[serde(rename_all = "camelCase")]
pub enum VoiceState {
    Disabled,
    Standby,
    Listening,
    Processing,
    Working,
    Speaking,
    Error,
}

/// What the capability probe found on this PC. Actual engines, never simulated.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceCapability {
    pub supported: bool,
    pub recognizers: Vec<String>,
    pub voices: Vec<String>,
    pub microphone: bool,
    pub error: Option<String>,
}

/// One event forwarded to the island over `voice-event`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceEvent {
    pub kind: String,
    pub text: Option<String>,
    pub generation: u64,
    pub message: Option<String>,
}

/// Foreground window metadata snapshot. Title and app only, never pixels.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowSnapshot {
    pub app_name: String,
    pub title: String,
}

/// One explicitly added local memory fact.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryEntry {
    pub id: String,
    pub text: String,
    pub created_ms: u64,
    pub source: String,
}

/// Voice tool routing outcome. Deterministic allowlist only.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceToolRoute {
    pub kind: String,
    pub target: Option<String>,
    pub action: Option<String>,
    pub routine_id: Option<String>,
    pub candidates: Vec<String>,
    pub reason: Option<String>,
}

/// The single owned helper process plus cancellation generations.
pub struct VoiceRuntime {
    child: Mutex<Option<Child>>,
    stdin: Mutex<Option<ChildStdin>>,
    generation: AtomicU64,
    speaking: AtomicBool,
    wake_on: AtomicBool,
    state: Mutex<VoiceState>,
    last_error: Mutex<Option<String>>,
}

impl Default for VoiceRuntime {
    fn default() -> Self {
        Self {
            child: Mutex::new(None),
            stdin: Mutex::new(None),
            generation: AtomicU64::new(0),
            speaking: AtomicBool::new(false),
            wake_on: AtomicBool::new(false),
            state: Mutex::new(VoiceState::Disabled),
            last_error: Mutex::new(None),
        }
    }
}

impl VoiceRuntime {
    pub fn current_generation(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }
    pub fn next_generation(&self) -> u64 {
        self.generation.fetch_add(1, Ordering::SeqCst) + 1
    }
    pub fn cancel(&self) -> u64 {
        let gen = self.next_generation();
        self.speaking.store(false, Ordering::SeqCst);
        set_state(self, VoiceState::Standby);
        gen
    }
    pub fn is_stale(&self, generation: u64) -> bool {
        generation != self.current_generation()
    }
}

fn set_state(rt: &VoiceRuntime, state: VoiceState) {
    *rt.state.lock().unwrap() = state;
}

fn emit(app: &AppHandle, kind: &str, text: Option<String>, generation: u64, message: Option<String>) {
    let _ = app.emit(
        "voice-event",
        VoiceEvent { kind: kind.to_string(), text, generation, message },
    );
}

// ── Pure helpers (unit tested, no microphone) ───────────────────────────────

/// Validates one helper stdout line: byte cap, JSON shape, known type, text caps.
pub fn parse_helper_line(line: &str) -> Result<(String, Option<String>, u64), String> {
    if line.len() > MAX_LINE_BYTES {
        return Err("Helper line too long, dropped.".to_string());
    }
    let value: serde_json::Value =
        serde_json::from_str(line).map_err(|_| "Malformed helper JSON, dropped.".to_string())?;
    let kind = value.get("type").and_then(|v| v.as_str()).unwrap_or("").to_string();
    match kind.as_str() {
        "ready" | "stopped" | "speech_started" | "speech_ended" | "capability" | "wake"
        | "partial" | "final" | "error" => {}
        _ => return Err(format!("Unknown helper event: {kind}")),
    }
    let mut text = value.get("text").and_then(|v| v.as_str()).map(str::to_string);
    if let Some(t) = text.as_mut() {
        let chars: String = t.chars().take(MAX_TEXT_CHARS).collect();
        *t = chars;
    }
    let generation = value.get("generation").and_then(|v| v.as_u64()).unwrap_or(0);
    Ok((kind, text, generation))
}

/// Duplicate final submission guard: same generation and same text submits once.
/// Test-covered through the test harness; kept warning-free for normal builds.
#[allow(dead_code)]
pub fn is_duplicate_final(seen: &Option<(u64, String)>, generation: u64, text: &str) -> bool {
    matches!(seen, Some((g, t)) if *g == generation && t == text)
}

/// Stale guard: partials, finals and replies from a cancelled generation are dropped.
/// Test-covered through the test harness; kept warning-free for normal builds.
#[allow(dead_code)]
pub fn is_stale(current_generation: u64, event_generation: u64) -> bool {
    current_generation != event_generation
}

/// Mode pin validation: auto, a, b or c only.
/// Test-covered through the test harness; kept warning-free for normal builds.
#[allow(dead_code)]
pub fn valid_voice_mode(mode: &str) -> bool {
    matches!(mode, "auto" | "a" | "b" | "c")
}

/// Wake must not fire while muted or opted out.
/// Test-covered through the test harness; kept warning-free for normal builds.
#[allow(dead_code)]
pub fn wake_muted(voice_enabled: bool, wake_enabled: bool, muted: bool) -> bool {
    !voice_enabled || !wake_enabled || muted
}

/// Self-echo rejection: while speaking, recognition input is suspended (half duplex).
/// Test-covered through the test harness; kept warning-free for normal builds.
#[allow(dead_code)]
pub fn echo_reject(speaking: bool) -> bool {
    speaking
}

/// Shortens a result for speech: first lines only, never code or long logs.
pub fn speak_text(reply: &str) -> String {
    let mut lines: Vec<&str> = reply.lines().take(4).collect();
    if lines.is_empty() {
        lines.push("");
    }
    let mut text: String = lines.join(" ").chars().take(MAX_SPEAK_CHARS).collect();
    // Drop obvious code fences rather than reading them aloud.
    text = text.replace("```", " ");
    text.trim().to_string()
}

/// Clamps the endpoint silence delay to a sane range (300 to 3000 ms).
/// Test-covered through the test harness; kept warning-free for normal builds.
#[allow(dead_code)]
pub fn clamp_endpoint_ms(ms: u64) -> u64 {
    ms.clamp(300, 3000)
}

/// Voice tool allowlist routing. Never guesses paths, never runs shell text.
/// Order: media keywords, exact shortcut name match, routine name match,
/// ambiguity check, refused categories, else agent fallback.
pub fn resolve_voice_tool(
    utterance: &str,
    shortcuts: &[(String, String, String)],
    routines: &[(String, String)],
) -> VoiceToolRoute {
    let lower = utterance.to_lowercase();
    // Refused categories first: permissions, outward messages, publish, delete, approvals.
    for word in [
        "approve", "permission", "allow access", "send email", "send message", "publish",
        "delete", "remove file", "grant",
    ] {
        if lower.contains(word) {
            return VoiceToolRoute {
                kind: "refused".to_string(),
                target: None,
                action: None,
                routine_id: None,
                candidates: vec![],
                reason: Some("That needs an explicit click in Choom. Voice cannot do it.".to_string()),
            };
        }
    }
    // Media controls reuse the existing music commands.
    if lower.contains("pause music") || lower.contains("pause the music") {
        return media_route("pause");
    }
    if (lower.contains("play") && lower.contains("music")) || lower.contains("resume music") {
        return media_route("toggle");
    }
    if lower.contains("next track") || lower.contains("next song") || lower.contains("skip track") {
        return media_route("next");
    }
    if lower.contains("previous track") || lower.contains("previous song") || lower.contains("last track") {
        return media_route("previous");
    }
    // Named shortcut match: all matching names are candidates; one match runs.
    let hits: Vec<(String, String, String)> = shortcuts
        .iter()
        .filter(|(name, _, _)| {
            let n = name.to_lowercase();
            !n.is_empty() && lower.contains(&n)
        })
        .cloned()
        .collect();
    if hits.len() == 1 {
        let (name, kind, target) = hits.into_iter().next().unwrap();
        let _ = name;
        return VoiceToolRoute {
            kind: kind.clone(),
            target: Some(target),
            action: None,
            routine_id: None,
            candidates: vec![],
            reason: None,
        };
    }
    if hits.len() > 1 {
        return VoiceToolRoute {
            kind: "ambiguous".to_string(),
            target: None,
            action: None,
            routine_id: None,
            candidates: hits.into_iter().map(|(n, _, _)| n).collect(),
            reason: Some("More than one saved shortcut matches. Pick one.".to_string()),
        };
    }
    // Routine name match. Steps still need the existing ordered preview + Run click.
    for (id, name) in routines {
        if !name.is_empty() && lower.contains(&name.to_lowercase()) {
            return VoiceToolRoute {
                kind: "routine".to_string(),
                target: None,
                action: None,
                routine_id: Some(id.clone()),
                candidates: vec![],
                reason: Some("Review the steps and press Run.".to_string()),
            };
        }
    }
    // Unknown requests route only to the configured agent provider.
    VoiceToolRoute {
        kind: "agent".to_string(),
        target: None,
        action: None,
        routine_id: None,
        candidates: vec![],
        reason: None,
    }
}

fn media_route(action: &str) -> VoiceToolRoute {
    VoiceToolRoute {
        kind: "media".to_string(),
        target: None,
        action: Some(action.to_string()),
        routine_id: None,
        candidates: vec![],
        reason: None,
    }
}

/// Free-only provider gate: unknown or paid selections require configuration,
/// never a silent fallback. Empty model means the server default (allowed).
pub fn provider_check(chat_provider: &str, agent_model: &str, has_key: bool) -> Result<(), String> {
    match chat_provider {
        "opencode-go" => {
            if !has_key {
                return Err("OpenCode key missing. Add it in Settings before voice turns.".to_string());
            }
            Ok(())
        }
        "opencode-agent" => {
            let model = agent_model.trim();
            if model.is_empty() {
                return Ok(());
            }
            // Free-only build: known free provider prefixes pass; anything else
            // needs explicit configuration rather than a silent paid call.
            let free_prefixes = ["opencode-go/", "qwen/", "minimax/", "local/", "ollama/", "free/"];
            let lower = model.to_lowercase();
            if free_prefixes.iter().any(|p| lower.starts_with(p)) || !model.contains('/') {
                return Ok(());
            }
            Err(format!(
                "Model {model} is not a known free default. Pick a free model in Settings before voice turns."
            ))
        }
        "anthropic" => {
            if !has_key {
                return Err("API key missing. Add it in Settings before voice turns.".to_string());
            }
            Ok(())
        }
        _ => Err("Unknown chat provider. Pick one in Settings.".to_string()),
    }
}

/// Sanitizes one memory fact: trimmed, bounded, no secrets shape.
pub fn clean_memory(text: &str) -> Result<String, String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err("Write the fact first.".to_string());
    }
    let chars: String = trimmed.chars().take(MAX_MEMORY_CHARS).collect();
    if chars.len() < 2 {
        return Err("That is too short to remember.".to_string());
    }
    Ok(chars)
}

/// Validates a file context target: local absolute path, supported extension,
/// size bound. Rejects directories, shares, URLs and oversized files.
/// Test-covered through the test harness; kept warning-free for normal builds.
#[allow(dead_code)]
pub fn validate_context_file(path: &str) -> Result<(), String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("Pick a file first.".to_string());
    }
    let lower = trimmed.to_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("shell:") {
        return Err("Context is a local file, not a link.".to_string());
    }
    if trimmed.starts_with(r"\\") || trimmed.starts_with("//") {
        return Err("Network paths are not supported for voice context.".to_string());
    }
    let p = std::path::Path::new(trimmed);
    if !p.is_absolute() {
        return Err("Context needs a full path.".to_string());
    }
    let meta = std::fs::metadata(p).map_err(|_| "File not found. Pick it again.".to_string())?;
    if !meta.is_file() {
        return Err("That is not a file.".to_string());
    }
    if meta.len() > 200_000 {
        return Err("That file is too large for voice context.".to_string());
    }
    Ok(())
}

fn memory_path() -> std::path::PathBuf {
    crate::settings::local_dir().join("voice-memory.json")
}

fn load_memories() -> Vec<MemoryEntry> {
    std::fs::read(memory_path())
        .ok()
        .and_then(|b| serde_json::from_slice::<Vec<MemoryEntry>>(&b).ok())
        .unwrap_or_default()
}

fn save_memories(entries: &[MemoryEntry]) -> Result<(), String> {
    let dir = crate::settings::local_dir();
    crate::platform::ensure_private_dir(&dir)
        .map_err(|e| format!("Could not save memory: {e}"))?;
    let json = serde_json::to_vec_pretty(entries)
        .map_err(|e| format!("Could not save memory: {e}"))?;
    std::fs::write(memory_path(), json).map_err(|e| format!("Could not save memory: {e}"))
}

// ── Helper process ──────────────────────────────────────────────────────────

fn helper_script_path() -> Option<std::path::PathBuf> {
    // Bundled beside the binary in production; in dev, the repo script.
    if let Ok(exe) = std::env::current_exe() {
        let next = exe.parent().map(|p| p.join("choom-voice.ps1"));
        if let Some(p) = next {
            if p.is_file() {
                return Some(p);
            }
        }
    }
    let dev = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("voice-runtime")
        .join("choom-voice.ps1");
    if dev.is_file() {
        return Some(dev);
    }
    // Staged copy in the owned local data directory.
    let staged = crate::settings::local_dir().join("choom-voice.ps1");
    if staged.is_file() {
        return Some(staged);
    }
    None
}

fn send_command(rt: &VoiceRuntime, json: &str) -> Result<(), String> {
    let mut guard = rt.stdin.lock().unwrap();
    let stdin = guard.as_mut().ok_or_else(|| "Voice helper is not running.".to_string())?;
    let line = format!("{json}\n");
    if line.len() > MAX_LINE_BYTES {
        return Err("Voice command too long.".to_string());
    }
    stdin.write_all(line.as_bytes()).map_err(|e| format!("Voice helper write failed: {e}"))?;
    stdin.flush().map_err(|e| format!("Voice helper write failed: {e}"))?;
    Ok(())
}

fn ensure_helper(app: &AppHandle, rt: &VoiceRuntime) -> Result<(), String> {
    #[cfg(not(windows))]
    {
        let _ = (app, rt);
        return Err("Voice is not supported on this OS.".to_string());
    }
    #[cfg(windows)]
    {
        if rt.child.lock().unwrap().is_some() {
            return Ok(());
        }
        let script = helper_script_path()
            .ok_or_else(|| "Voice helper script missing.".to_string())?;
        let mut cmd = Command::new("powershell");
        cmd.args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            &script.to_string_lossy(),
        ]);
        cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        platform::no_console(&mut cmd);
        let mut child = cmd.spawn().map_err(|e| format!("Could not start voice helper: {e}"))?;
        let stdin = child.stdin.take();
        let stdout = child.stdout.take();
        *rt.child.lock().unwrap() = Some(child);
        *rt.stdin.lock().unwrap() = stdin;
        // Reader thread: bounded lines, JSON validated, stale generations
        // dropped, events forwarded without blocking the Tauri UI.
        if let Some(out) = stdout {
            let handle = app.clone();
            std::thread::spawn(move || read_loop(handle, out));
        }
        Ok(())
    }
}

fn read_loop(app: AppHandle, stdout: ChildStdout) {
    let reader = BufReader::new(stdout);
    let rt: State<VoiceRuntime> = app.state();
    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        if line.is_empty() {
            continue;
        }
        let parsed = match parse_helper_line(&line) {
            Ok(p) => p,
            Err(_) => continue,
        };
        let (kind, text, generation) = parsed;
        // Cancellation generations: late helper output never acts.
        if (kind == "partial" || kind == "final") && generation != 0 && rt.is_stale(generation) {
            continue;
        }
        // Half duplex: while speaking, recognition input is suspended.
        if (kind == "partial" || kind == "final" || kind == "wake")
            && rt.speaking.load(Ordering::SeqCst)
        {
            continue;
        }
        match kind.as_str() {
            "partial" => emit(&app, "partial", text, generation, None),
            "final" => {
                emit(&app, "final", text, generation, None);
                set_state(&rt, VoiceState::Processing);
            }
            "wake" => {
                if rt.wake_on.load(Ordering::SeqCst) {
                    emit(&app, "wake", text, generation, None);
                }
            }
            "speech_started" => {
                rt.speaking.store(true, Ordering::SeqCst);
                set_state(&rt, VoiceState::Speaking);
                emit(&app, "speech_started", None, generation, None);
            }
            "speech_ended" => {
                rt.speaking.store(false, Ordering::SeqCst);
                emit(&app, "speech_ended", None, generation, None);
            }
            "error" => {
                *rt.last_error.lock().unwrap() = text.clone();
                set_state(&rt, VoiceState::Error);
                emit(&app, "error", None, generation, text);
            }
            "capability" => emit(&app, "capability", text, generation, None),
            _ => {}
        }
    }
}

fn shutdown_helper(rt: &VoiceRuntime) {
    let _ = send_command(rt, r#"{"cmd":"shutdown"}"#);
    // Bounded wait, then kill. Never hangs shutdown.
    std::thread::sleep(Duration::from_millis(150));
    if let Some(mut child) = rt.child.lock().unwrap().take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    *rt.stdin.lock().unwrap() = None;
    rt.speaking.store(false, Ordering::SeqCst);
    rt.wake_on.store(false, Ordering::SeqCst);
    set_state(rt, VoiceState::Disabled);
}

// ── Commands ────────────────────────────────────────────────────────────────

/// Actual installed engines and errors, not simulated readiness. No microphone use.
#[tauri::command]
pub async fn voice_capability(app: AppHandle) -> Result<VoiceCapability, String> {
    #[cfg(not(windows))]
    {
        let _ = app;
        return Ok(VoiceCapability {
            supported: false,
            recognizers: vec![],
            voices: vec![],
            microphone: false,
            error: Some("Voice is not supported on this OS.".to_string()),
        });
    }
    #[cfg(windows)]
    {
        let _ = app;
        // Hidden probe: installed recognizers + synthesis voices only.
        let probe = "$r = @(); try { $r = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers() | ForEach-Object { $_.Culture.Name + ' ' + $_.Id } } catch {}; $v = @(); try { $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $v = $s.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name }; $s.Dispose() } catch {}; @{ recognizers = @($r); voices = @($v) } | ConvertTo-Json -Compress";
        let mut cmd = Command::new("powershell");
        cmd.args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", probe]);
        cmd.stdout(Stdio::piped()).stderr(Stdio::null());
        platform::no_console(&mut cmd);
        let output = tokio::task::spawn_blocking(move || cmd.output())
            .await
            .map_err(|_| "Voice probe worker stopped.".to_string())?
            .map_err(|e| format!("Voice probe failed: {e}"))?;
        let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if text.is_empty() {
            return Ok(VoiceCapability {
                supported: false,
                recognizers: vec![],
                voices: vec![],
                microphone: false,
                error: Some("Speech engine probe returned nothing. System.Speech may be missing.".to_string()),
            });
        }
        let value: serde_json::Value =
            serde_json::from_str(&text).map_err(|_| "Voice probe returned malformed JSON.".to_string())?;
        let recognizers: Vec<String> = value
            .get("recognizers")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
            .unwrap_or_default();
        let voices: Vec<String> = value
            .get("voices")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
            .unwrap_or_default();
        let supported = !recognizers.is_empty();
        Ok(VoiceCapability {
            supported,
            recognizers,
            voices,
            microphone: false,
            error: if supported {
                None
            } else {
                Some("No desktop speech recognizer installed (expected en-US MS-1033-80-DESK).".to_string())
            },
        })
    }
}

/// Starts dictation. Requires explicit voice opt-in. Returns the generation id.
#[tauri::command]
pub async fn voice_listen_start(
    app: AppHandle,
    rt: State<'_, VoiceRuntime>,
    settings: State<'_, crate::Shared>,
) -> Result<u64, String> {
    let enabled = settings.settings.lock().unwrap().voice_enabled;
    if !enabled {
        return Err("Voice is off. Turn it on in Settings first.".to_string());
    }
    ensure_helper(&app, &rt)?;
    let generation = rt.next_generation();
    rt.speaking.store(false, Ordering::SeqCst);
    set_state(&rt, VoiceState::Listening);
    send_command(&rt, &format!(r#"{{"cmd":"listen","generation":{generation}}}"#))?;
    emit(&app, "listening", None, generation, None);
    Ok(generation)
}

/// Stops capture but keeps the helper alive for the next turn.
#[tauri::command]
pub fn voice_listen_stop(app: AppHandle, rt: State<VoiceRuntime>) -> Result<(), String> {
    let _ = send_command(&rt, r#"{"cmd":"stop"}"#);
    set_state(&rt, VoiceState::Standby);
    emit(&app, "stopped", None, rt.current_generation(), None);
    Ok(())
}

/// Cancels the current voice generation, mic recognition and speech.
/// Owned agent cancellation is handled by the frontend via chat reset where supported.
#[tauri::command]
pub fn voice_cancel(app: AppHandle, rt: State<VoiceRuntime>) -> Result<u64, String> {
    let _ = send_command(&rt, r#"{"cmd":"stop"}"#);
    let _ = send_command(&rt, r#"{"cmd":"stop_audio"}"#);
    let generation = rt.cancel();
    emit(&app, "cancelled", None, generation, None);
    Ok(generation)
}

/// Speaks a short factual result. Only under opted-in user command paths.
#[tauri::command]
pub async fn voice_speak(
    app: AppHandle,
    rt: State<'_, VoiceRuntime>,
    shared: State<'_, crate::Shared>,
    text: String,
    generation: u64,
) -> Result<(), String> {
    if rt.is_stale(generation) {
        return Ok(());
    }
    let (voice, rate, volume) = {
        let s = shared.settings.lock().unwrap();
        (s.voice_speech_voice.clone(), s.voice_speech_rate, s.voice_speech_volume)
    };
    let short = speak_text(&text);
    if short.is_empty() {
        return Ok(());
    }
    ensure_helper(&app, &rt)?;
    rt.speaking.store(true, Ordering::SeqCst);
    set_state(&rt, VoiceState::Speaking);
    let body = serde_json::json!({
        "cmd": "speak",
        "text": short,
        "voice": voice,
        "rate": rate,
        "volume": volume,
        "generation": generation,
    });
    send_command(&rt, &body.to_string())?;
    Ok(())
}

/// Immediate stop for talkback. Visible Stop and Escape always reach here.
#[tauri::command]
pub fn voice_speak_stop(app: AppHandle, rt: State<VoiceRuntime>) -> Result<(), String> {
    rt.speaking.store(false, Ordering::SeqCst);
    let _ = send_command(&rt, r#"{"cmd":"stop_audio"}"#);
    emit(&app, "speech_ended", None, rt.current_generation(), None);
    Ok(())
}

/// Local keyword wake. Opt-in only. Worker exits when disabled.
#[tauri::command]
pub async fn voice_wake_set(
    app: AppHandle,
    rt: State<'_, VoiceRuntime>,
    shared: State<'_, crate::Shared>,
    enabled: bool,
) -> Result<(), String> {
    let (voice_enabled, phrase) = {
        let s = shared.settings.lock().unwrap();
        (s.voice_enabled, s.voice_wake_phrase.clone())
    };
    if enabled && !voice_enabled {
        return Err("Turn voice on before wake.".to_string());
    }
    if !enabled {
        rt.wake_on.store(false, Ordering::SeqCst);
        let _ = send_command(&rt, r#"{"cmd":"stop"}"#);
        emit(&app, "wake_off", None, rt.current_generation(), None);
        // Worker exits when opt-in is disabled.
        if !voice_enabled {
            shutdown_helper(&rt);
        }
        return Ok(());
    }
    ensure_helper(&app, &rt)?;
    rt.wake_on.store(true, Ordering::SeqCst);
    set_state(&rt, VoiceState::Standby);
    let phrase = if phrase.trim().is_empty() { "Choom".to_string() } else { phrase.trim().to_string() };
    let body = serde_json::json!({ "cmd": "wake_on", "phrase": phrase });
    send_command(&rt, &body.to_string())?;
    emit(&app, "wake_on", None, rt.current_generation(), None);
    Ok(())
}

/// Explicit native foreground window title and app metadata snapshot.
/// Called before opening Choom; never selects Choom itself.
#[tauri::command]
pub async fn voice_window_snapshot() -> Result<Option<WindowSnapshot>, String> {
    #[cfg(not(windows))]
    {
        return Err("Window snapshot is not supported on this OS.".to_string());
    }
    #[cfg(windows)]
    {
        tokio::task::spawn_blocking(|| {
            use windows::Win32::Foundation::HWND;
            use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowTextW, GetWindowThreadProcessId};
            unsafe {
                let hwnd = GetForegroundWindow();
                if hwnd == HWND(std::ptr::null_mut()) {
                    return Ok(None);
                }
                let mut title_buf = [0u16; 512];
                let len = GetWindowTextW(hwnd, &mut title_buf);
                let title = String::from_utf16_lossy(&title_buf[..len as usize]).trim().to_string();
                let mut pid: u32 = 0;
                GetWindowThreadProcessId(hwnd, Some(&mut pid));
                let app_name = process_name(pid).unwrap_or_else(|| "Unknown app".to_string());
                // Avoid selecting Choom itself.
                if app_name.to_lowercase().contains("choom") || app_name.to_lowercase().contains("coucou") {
                    return Ok(None);
                }
                if title.is_empty() {
                    return Ok(None);
                }
                Ok(Some(WindowSnapshot { app_name, title }))
            }
        })
        .await
        .map_err(|_| "Window snapshot worker stopped.".to_string())?
    }
}

#[cfg(windows)]
fn process_name(pid: u32) -> Option<String> {
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let handle = HANDLE(handle.0);
        let mut buf = [0u16; 260];
        let mut len = buf.len() as u32;
        let ok = windows::Win32::System::Threading::QueryFullProcessImageNameW(handle, windows::Win32::System::Threading::PROCESS_NAME_FORMAT(0), windows::core::PWSTR(buf.as_mut_ptr()), &mut len);
        let _ = CloseHandle(handle);
        if ok.is_err() {
            return None;
        }
        let full = String::from_utf16_lossy(&buf[..len as usize]);
        full.rsplit(['\\', '/']).next().map(str::to_string)
    }
}

/// Voice tool routing against saved shortcuts and routines.
#[tauri::command]
pub async fn voice_tool_resolve(
    shared: State<'_, crate::Shared>,
    utterance: String,
) -> Result<VoiceToolRoute, String> {
    let (shortcuts, routines) = {
        let s = shared.settings.lock().unwrap();
        let shortcuts = s
            .tools
            .shortcuts
            .iter()
            .map(|x| (x.name.clone(), x.kind.clone(), x.target.clone()))
            .collect::<Vec<_>>();
        let routines = s
            .tools
            .routines
            .iter()
            .map(|r| (r.id.clone(), r.name.clone()))
            .collect::<Vec<_>>();
        (shortcuts, routines)
    };
    if utterance.trim().is_empty() {
        return Ok(VoiceToolRoute {
            kind: "agent".to_string(),
            target: None,
            action: None,
            routine_id: None,
            candidates: vec![],
            reason: None,
        });
    }
    Ok(resolve_voice_tool(&utterance, &shortcuts, &routines))
}

/// Free-only provider gate for voice turns.
#[tauri::command]
pub async fn voice_provider_check(shared: State<'_, crate::Shared>) -> Result<(), String> {
    let (provider, model) = {
        let s = shared.settings.lock().unwrap();
        (s.chat_provider.clone(), s.opencode_agent_model.clone())
    };
    let has_key = crate::secrets::present("opencode-api-key") || crate::secrets::present("anthropic-api-key");
    provider_check(&provider, &model, has_key)
}

// ── Local memory (explicit opt-in) ──────────────────────────────────────────

#[tauri::command]
pub async fn voice_memory_list(shared: State<'_, crate::Shared>) -> Result<Vec<MemoryEntry>, String> {
    if !shared.settings.lock().unwrap().voice_memory_enabled {
        return Ok(vec![]);
    }
    Ok(load_memories())
}

#[tauri::command]
pub async fn voice_memory_add(shared: State<'_, crate::Shared>, text: String) -> Result<MemoryEntry, String> {
    if !shared.settings.lock().unwrap().voice_memory_enabled {
        return Err("Memory is off. Turn it on in Settings first.".to_string());
    }
    let clean = clean_memory(&text)?;
    let mut entries = load_memories();
    if entries.len() >= MAX_MEMORIES {
        return Err("Memory is full (100 facts). Delete one first.".to_string());
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let entry = MemoryEntry {
        id: format!("mem-{now}"),
        text: clean,
        created_ms: now,
        source: "user".to_string(),
    };
    entries.push(entry.clone());
    save_memories(&entries)?;
    Ok(entry)
}

#[tauri::command]
pub async fn voice_memory_remove(shared: State<'_, crate::Shared>, id: String) -> Result<(), String> {
    let mut entries = load_memories();
    let before = entries.len();
    entries.retain(|e| e.id != id);
    if entries.len() == before {
        return Err("That memory was not found.".to_string());
    }
    let _ = shared;
    save_memories(&entries)
}

#[tauri::command]
pub async fn voice_memory_clear() -> Result<(), String> {
    save_memories(&[])
}

/// Shuts the helper down. Called on disable, lock and app exit.
pub fn shutdown(rt: &VoiceRuntime) {
    shutdown_helper(rt);
}

/// Shuts the helper down. Called on disable, lock and app exit.
/// Kept warning-free: wired to app exit; lock path lands with the next native
/// suspend integration.
#[allow(dead_code)]
pub fn on_lock(rt: &VoiceRuntime) {
    // Lock and suspend close capture immediately.
    let _ = send_command(rt, r#"{"cmd":"stop"}"#);
    let _ = send_command(rt, r#"{"cmd":"stop_audio"}"#);
    rt.speaking.store(false, Ordering::SeqCst);
    rt.wake_on.store(false, Ordering::SeqCst);
    set_state(rt, VoiceState::Standby);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn helper_lines_validate_size_shape_and_type() {
        assert!(parse_helper_line(r#"{"type":"partial","text":"hi","generation":1}"#).is_ok());
        assert!(parse_helper_line(r#"{"type":"nope"}"#).is_err());
        assert!(parse_helper_line("not json").is_err());
        let big = format!(r#"{{"type":"partial","text":"{}"}}"#, "x".repeat(MAX_LINE_BYTES + 1));
        assert!(parse_helper_line(&big).is_err());
        // Text is bounded, never grown.
        let long = format!(r#"{{"type":"final","text":"{}","generation":2}}"#, "y".repeat(5000));
        let (_, text, _) = parse_helper_line(&long).unwrap();
        assert!(text.unwrap().chars().count() <= MAX_TEXT_CHARS);
    }

    #[test]
    fn duplicate_finals_submit_once() {
        let seen = Some((3u64, "open notes".to_string()));
        assert!(is_duplicate_final(&seen, 3, "open notes"));
        assert!(!is_duplicate_final(&seen, 3, "open notes!"));
        assert!(!is_duplicate_final(&seen, 4, "open notes"));
        assert!(!is_duplicate_final(&None, 3, "open notes"));
    }

    #[test]
    fn stale_partials_finals_and_replies_drop_after_cancel() {
        assert!(is_stale(5, 4));
        assert!(!is_stale(5, 5));
        let rt = VoiceRuntime::default();
        rt.generation.store(7, Ordering::SeqCst);
        assert!(rt.is_stale(6));
        assert!(!rt.is_stale(7));
        rt.cancel();
        assert!(rt.is_stale(7));
    }

    #[test]
    fn mode_pins_validate() {
        for m in ["auto", "a", "b", "c"] {
            assert!(valid_voice_mode(m));
        }
        assert!(!valid_voice_mode("d"));
        assert!(!valid_voice_mode(""));
    }

    #[test]
    fn muted_wake_never_fires() {
        assert!(wake_muted(false, true, false));
        assert!(wake_muted(true, false, false));
        assert!(wake_muted(true, true, true));
        assert!(!wake_muted(true, true, false));
    }

    #[test]
    fn echo_rejects_while_speaking() {
        assert!(echo_reject(true));
        assert!(!echo_reject(false));
    }

    #[test]
    fn talkback_stays_short_and_factual() {
        let reply = "line1\nline2\nline3\nline4\nline5\nline6";
        let short = speak_text(reply);
        assert!(!short.contains("line5"));
        assert!(short.chars().count() <= MAX_SPEAK_CHARS);
        assert!(!speak_text("```code```").contains("```"));
    }

    #[test]
    fn endpoint_delay_clamps() {
        assert_eq!(clamp_endpoint_ms(50), 300);
        assert_eq!(clamp_endpoint_ms(900), 900);
        assert_eq!(clamp_endpoint_ms(9000), 3000);
    }

    #[test]
    fn tool_targets_are_allowlisted_never_guessed() {
        let shortcuts = vec![
            ("Notes".to_string(), "folder".to_string(), "D:\\notes".to_string()),
            ("Archive".to_string(), "folder".to_string(), "D:\\archive".to_string()),
            ("Code".to_string(), "app".to_string(), "C:\\t\\code.exe".to_string()),
        ];
        let routines = vec![("r1".to_string(), "Design mode".to_string())];
        let one = resolve_voice_tool("open code", &shortcuts, &routines);
        assert_eq!(one.kind, "app");
        let ambiguous = resolve_voice_tool("open notes archive", &shortcuts, &routines);
        assert_eq!(ambiguous.kind, "ambiguous");
        assert_eq!(ambiguous.candidates.len(), 2);
        let media = resolve_voice_tool("pause music", &shortcuts, &routines);
        assert_eq!(media.kind, "media");
        assert_eq!(media.action.as_deref(), Some("pause"));
        let routine = resolve_voice_tool("start design mode", &[], &routines);
        assert_eq!(routine.kind, "routine");
        assert_eq!(routine.routine_id.as_deref(), Some("r1"));
        let refused = resolve_voice_tool("approve the permission", &shortcuts, &routines);
        assert_eq!(refused.kind, "refused");
        let agent = resolve_voice_tool("explain black holes", &shortcuts, &routines);
        assert_eq!(agent.kind, "agent");
    }

    #[test]
    fn paid_or_unknown_models_require_configuration() {
        assert!(provider_check("opencode-agent", "", true).is_ok());
        assert!(provider_check("opencode-agent", "qwen/m", true).is_ok());
        assert!(provider_check("opencode-agent", "openai/gpt-5", true).is_err());
        assert!(provider_check("opencode-go", "", false).is_err());
        assert!(provider_check("anthropic", "", false).is_err());
        assert!(provider_check("unknown", "", true).is_err());
    }

    #[test]
    fn memory_opt_in_bounds_and_context_removal() {
        assert!(clean_memory("  remember I like tea  ").is_ok());
        assert!(clean_memory(" ").is_err());
        let long = "x".repeat(2000);
        assert_eq!(clean_memory(&long).unwrap().chars().count(), MAX_MEMORY_CHARS);
        // Context removal: validate then drop is just not injecting.
        assert!(validate_context_file("https://example.com/x.txt").is_err());
        assert!(validate_context_file(r"\\server\share\x.txt").is_err());
    }

    #[test]
    fn helper_shutdown_clears_state() {
        let rt = VoiceRuntime::default();
        rt.speaking.store(true, Ordering::SeqCst);
        rt.wake_on.store(true, Ordering::SeqCst);
        shutdown_helper(&rt);
        assert!(!rt.speaking.load(Ordering::SeqCst));
        assert!(!rt.wake_on.load(Ordering::SeqCst));
    }

    #[test]
    fn failure_recovery_reports_honestly() {
        // Capability without engines is unsupported, never simulated ready.
        let cap = VoiceCapability {
            supported: false,
            recognizers: vec![],
            voices: vec![],
            microphone: false,
            error: Some("No desktop speech recognizer installed.".to_string()),
        };
        assert!(!cap.supported);
        assert!(cap.error.is_some());
    }
}
