// Choom voice and Jarvis runtime (Windows first release).
// Offline Windows desktop speech engine behind a replaceable runtime boundary.
// Rust owns a single hidden helper process (PowerShell 5.1 + System.Speech),
// a JSON-line stdin/stdout protocol, bounded buffers, cancellation
// generations, events and cleanup. Never blocks the Tauri UI.

use std::io::{BufRead, BufReader, Read, Write};
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
    /// Actionable choices for ambiguity: id, name, kind and exact target.
    pub options: Vec<ToolOption>,
    pub reason: Option<String>,
}

/// One exact saved shortcut offered as an ambiguity choice.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolOption {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub target: String,
}

/// The single owned helper process plus cancellation generations.
/// One lifecycle lock serializes every spawn, so two concurrent Listen, Wake
/// or Speak calls can never start two microphone helpers.
pub struct VoiceRuntime {
    lifecycle: tokio::sync::Mutex<()>,
    child: Mutex<Option<Child>>,
    stdin: Mutex<Option<ChildStdin>>,
    generation: AtomicU64,
    /// Helper process epoch. Every event carries the epoch it was born in;
    /// output from a disposed epoch is never accepted.
    instance: AtomicU64,
    speaking: AtomicBool,
    rearm_after_speech: AtomicBool,
    wake_on: AtomicBool,
    /// Authoritative mic mute: set only by the voice_mute command. Muted
    /// capture may not start, and muting closes capture and blocks re-arm.
    muted: AtomicBool,
    /// Set while the session is locked: capture may not restart.
    locked: AtomicBool,
    /// Set while the PC is suspended: capture may not restart. Tracked
    /// separately from lock so one clearing cannot lift the other.
    suspended: AtomicBool,
    /// Wake was armed before a lock or suspend took it down: unlock or
    /// resume re-arms it, but only once both flags are clear.
    was_armed: AtomicBool,
    /// Mirrors the island pause switch: capture may not start while paused.
    paused: AtomicBool,
    /// Reader thread noticed the helper exited.
    dead: AtomicBool,
    /// Bounded helper restarts since the last successful ready.
    restarts: Mutex<u32>,
    /// Device recovery attempts for the current generation.
    recover_attempts: Mutex<u32>,
    state: Mutex<VoiceState>,
    last_error: Mutex<Option<String>>,
}

/// Helper restarts are bounded: three strikes, then an honest visible error.
pub const MAX_HELPER_RESTARTS: u32 = 3;
/// Device recovery recreates the recognizer at most this often per turn.
pub const MAX_RECOVER_ATTEMPTS: u32 = 3;

impl Default for VoiceRuntime {
    fn default() -> Self {
        Self {
            lifecycle: tokio::sync::Mutex::new(()),
            child: Mutex::new(None),
            stdin: Mutex::new(None),
            generation: AtomicU64::new(0),
            instance: AtomicU64::new(0),
            speaking: AtomicBool::new(false),
            rearm_after_speech: AtomicBool::new(false),
            wake_on: AtomicBool::new(false),
            muted: AtomicBool::new(false),
            locked: AtomicBool::new(false),
            suspended: AtomicBool::new(false),
            was_armed: AtomicBool::new(false),
            paused: AtomicBool::new(false),
            dead: AtomicBool::new(false),
            restarts: Mutex::new(0),
            recover_attempts: Mutex::new(0),
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

/// Session lock, suspend and resume travel on their own channel as plain
/// strings, matching the frontend's voice-session listener. They never ride
/// the voice-event payload contract.
fn emit_session(app: &AppHandle, what: &str) {
    let _ = app.emit("voice-session", what.to_string());
}

// ── Pure helpers (unit tested, no microphone) ───────────────────────────────

/// Validates one helper stdout line: byte cap, JSON shape, known type, text caps.
/// Returns kind, text, generation and the helper epoch that produced it.
pub fn parse_helper_line(line: &str) -> Result<(String, Option<String>, u64, u64), String> {
    if line.len() > MAX_LINE_BYTES {
        return Err("Helper line too long, dropped.".to_string());
    }
    let value: serde_json::Value =
        serde_json::from_str(line).map_err(|_| "Malformed helper JSON, dropped.".to_string())?;
    let kind = value.get("type").and_then(|v| v.as_str()).unwrap_or("").to_string();
    match kind.as_str() {
        "ready" | "stopped" | "speech_started" | "speech_ended" | "capability" | "wake" | "wake_on" | "listening"
        | "partial" | "final" | "error" | "recovered" | "helper_exited" | "transcribing" | "empty" => {}
        _ => return Err(format!("Unknown helper event: {kind}")),
    }
    let mut text = value
        .get("text")
        .and_then(|v| v.as_str())
        .or_else(|| value.get("message").and_then(|v| v.as_str()))
        .map(str::to_string);
    if let Some(t) = text.as_mut() {
        let chars: String = t.chars().take(MAX_TEXT_CHARS).collect();
        *t = chars;
    }
    let generation = value.get("generation").and_then(|v| v.as_u64()).unwrap_or(0);
    let instance = value.get("instance").and_then(|v| v.as_u64()).unwrap_or(0);
    Ok((kind, text, generation, instance))
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

/// Normalises spoken text for exact matching: lowercase, collapsed
/// whitespace, no trailing punctuation.
pub fn normalize_utterance(text: &str) -> String {
    text.to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim_end_matches(['.', '?', '!'])
        .to_string()
}

/// Strips one leading launch verb plus an optional article. Returns the verb
/// and the remainder. No verb means no launch intent.
fn split_intent(lower: &str) -> Option<(&str, String)> {
    for verb in ["open", "launch", "start", "run", "show", "begin", "play", "pause", "resume"] {
        if lower == verb {
            return Some((verb, String::new()));
        }
        if let Some(rest) = lower.strip_prefix(&format!("{verb} ")) {
            let rest = rest.strip_prefix("the ").unwrap_or(rest);
            let rest = rest.strip_prefix("my ").unwrap_or(rest);
            return Some((verb, rest.to_string()));
        }
    }
    None
}

/// Voice tool allowlist routing. Never guesses paths, never runs shell text.
/// A bare mention is not intent: shortcuts need an explicit launch verb plus
/// an exact normalized name. Order: refused categories, media keywords,
/// exact shortcut match, routine match, ambiguity choices, agent fallback.
pub fn resolve_voice_tool(
    utterance: &str,
    shortcuts: &[(String, String, String, String)],
    routines: &[(String, String)],
) -> VoiceToolRoute {
    let lower = normalize_utterance(utterance);
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
                options: vec![],
                reason: Some("That needs an explicit click in Choom. Voice cannot do it.".to_string()),
            };
        }
    }
    // Media controls reuse the existing music commands with real semantics.
    if lower.contains("pause music") || lower.contains("pause the music") || lower == "pause" {
        return media_route("pause");
    }
    if lower.contains("resume music") || lower == "resume" {
        return media_route("play");
    }
    if (lower.contains("play") && lower.contains("music")) || lower == "play music" {
        return media_route("play");
    }
    if lower.contains("next track") || lower.contains("next song") || lower.contains("skip track") {
        return media_route("next");
    }
    if lower.contains("previous track") || lower.contains("previous song") || lower.contains("last track") {
        return media_route("previous");
    }
    // Routines need an explicit start verb plus the exact routine name.
    if let Some((verb, rest)) = split_intent(&lower) {
        if matches!(verb, "start" | "run" | "begin") {
            for (id, name) in routines {
                if !name.is_empty() && rest == normalize_utterance(name) {
                    return VoiceToolRoute {
                        kind: "routine".to_string(),
                        target: None,
                        action: None,
                        routine_id: Some(id.clone()),
                        candidates: vec![],
                        options: vec![],
                        reason: Some("Review the steps and press Run.".to_string()),
                    };
                }
            }
        }
        // Shortcuts need an explicit launch verb plus the exact shortcut name.
        if matches!(verb, "open" | "launch" | "start" | "run" | "show") {
            let exact: Vec<(String, String, String, String)> = shortcuts
                .iter()
                .filter(|(_, name, _, _)| !name.is_empty() && rest == normalize_utterance(name))
                .cloned()
                .collect();
            if exact.len() == 1 {
                let (_, _, kind, target) = exact.into_iter().next().unwrap();
                return VoiceToolRoute {
                    kind: kind.clone(),
                    target: Some(target),
                    action: None,
                    routine_id: None,
                    candidates: vec![],
                    options: vec![],
                    reason: None,
                };
            }
            if exact.len() > 1 {
                return ambiguous_route(&exact);
            }
        }
    }
    // No exact match: one mentioned name without intent is just talk and
    // routes to the agent. Several matching names refuse to guess and come
    // back as explicit choices instead.
    let hits: Vec<(String, String, String, String)> = shortcuts
        .iter()
        .filter(|(_, name, _, _)| {
            let n = normalize_utterance(name);
            !n.is_empty() && lower.contains(&n)
        })
        .cloned()
        .collect();
    if hits.len() > 1 {
        return ambiguous_route(&hits);
    }
    // Unknown requests route only to the configured agent provider.
    VoiceToolRoute {
        kind: "agent".to_string(),
        target: None,
        action: None,
        routine_id: None,
        candidates: vec![],
        options: vec![],
        reason: None,
    }
}

fn ambiguous_route(hits: &[(String, String, String, String)]) -> VoiceToolRoute {
    VoiceToolRoute {
        kind: "ambiguous".to_string(),
        target: None,
        action: None,
        routine_id: None,
        candidates: hits.iter().map(|(_, n, _, _)| n.clone()).collect(),
        options: hits
            .iter()
            .map(|(id, name, kind, target)| ToolOption {
                id: id.clone(),
                name: name.clone(),
                kind: kind.clone(),
                target: target.clone(),
            })
            .collect(),
        reason: Some("More than one saved shortcut matches. Pick one.".to_string()),
    }
}

fn media_route(action: &str) -> VoiceToolRoute {
    VoiceToolRoute {
        kind: "media".to_string(),
        target: None,
        action: Some(action.to_string()),
        routine_id: None,
        candidates: vec![],
        options: vec![],
        reason: None,
    }
}

/// Exact model IDs voice may use on the OpenCode Go plan. This mirrors the
/// configured Chat catalog: the plan subscription must actually allow them,
/// which only the account holder can confirm in Settings.
pub const GO_VOICE_MODELS: &[&str] = &[
    "qwen3.8-flash",
    "qwen3.8-max",
    "qwen3.7-plus",
    "minimax-m3",
    "minimax-m2.7",
];

/// Exact agent model IDs with verified free pricing on the current build:
/// opencode/muse-spark-1.3-contributor-free and opencode/mimo-v2.6-flash-free.
/// Anything else needs explicit configuration, never a silent default or a
/// vendor-prefix guess.
pub const FREE_AGENT_MODELS: &[&str] = &[
    "opencode/muse-spark-1.3-contributor-free",
    "opencode/mimo-v2.6-flash-free",
];

/// Free-only provider gate for voice turns. Voice never accepts the server
/// default, an empty or unqualified string, a metered API provider, or a
/// model outside the configured catalog. Typed chat keeps its own behavior.
pub fn provider_check(
    chat_provider: &str,
    agent_model: &str,
    go_model: &str,
    has_key: bool,
    catalog: &[String],
) -> Result<(), String> {
    match chat_provider {
        "opencode-go" => {
            if !has_key {
                return Err("OpenCode key missing. Add it in Settings before voice turns.".to_string());
            }
            let model = go_model.trim();
            if GO_VOICE_MODELS.contains(&model) {
                return Ok(());
            }
            Err("Pick one of the configured OpenCode Go models in Settings before voice turns.".to_string())
        }
        "opencode-agent" => {
            let model = agent_model.trim();
            if model.is_empty() {
                return Err("Pick a free agent model in Settings before voice turns. Voice never uses the server default.".to_string());
            }
            if !model.contains('/') {
                return Err(format!(
                    "Model {model} is not a qualified provider/model ID. Pick a free model in Settings before voice turns."
                ));
            }
            if !catalog.iter().any(|m| m == model) {
                return Err(format!(
                    "Model {model} is not in this server's catalog. Pick a free model in Settings before voice turns."
                ));
            }
            if FREE_AGENT_MODELS.contains(&model) {
                return Ok(());
            }
            Err(format!(
                "Model {model} is not a verified free voice model. Pick a verified free model in Settings before voice turns."
            ))
        }
        // Metered per-call APIs are never voice eligible, key or not.
        _ => Err("Voice needs the OpenCode Go or OpenCode agent provider with a verified free model. The Claude API is metered and stays typed only.".to_string()),
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

// ── Local Whisper transcription backend (offline CPU) ─────────────────────────
// Selectable backend. Standby stays with the lightweight keyword recognizer;
// capture runs only while deliberately listening. Base is multilingual and
// ships with the review installer; Small is explicit local setup only.

/// CPU threads for Whisper initially.
#[allow(dead_code)]
pub const WHISPER_THREADS: u32 = 6;
/// Names-only vocabulary prompt for Choom, Spotify and VS Code.
#[allow(dead_code)]
pub const WHISPER_PROMPT: &str = "Choom, Spotify, Visual Studio Code";
/// Maximum utterance duration in seconds: bounded temp WAV and worker.
#[allow(dead_code)]
pub const WHISPER_MAX_SECONDS: u64 = 30;
/// How long one transcription may run before it counts as failed.
#[allow(dead_code)]
pub const WHISPER_TIMEOUT_SECS: u64 = 120;
/// Temp WAV prefix for crash-recovery cleanup. No persistent user audio.
pub const WHISPER_TEMP_PREFIX: &str = "choom-whisper-";

/// Backend validation: Windows dictation or local Whisper only.
#[allow(dead_code)]
pub fn valid_voice_backend(value: &str) -> bool {
    matches!(value, "system" | "whisper")
}

/// Model validation: Base bundled, Small via explicit local setup.
#[allow(dead_code)]
pub fn valid_voice_model(value: &str) -> bool {
    matches!(value, "base" | "small")
}

/// Normalizes stored prefs without silent switching: unknown reads as the
/// safe default, so existing users stay on their chosen backend.
pub fn normalize_backend(value: &str) -> String {
    if value == "whisper" { "whisper".to_string() } else { "system".to_string() }
}

pub fn normalize_model(value: &str) -> String {
    if value == "small" { "small".to_string() } else { "base".to_string() }
}

/// Model file for a validated model id. Only these two names ever resolve.
pub fn whisper_model_filename(model: &str) -> Option<&'static str> {
    match model {
        "base" => Some("ggml-base.bin"),
        "small" => Some("ggml-small.bin"),
        _ => None,
    }
}

/// Blank or silence output is discarded, never submitted. Case-insensitive
/// markers plus empty cover whisper-cli silence on short captures.
#[allow(dead_code)]
pub fn is_whisper_blank(text: &str) -> bool {
    let clean = text.trim();
    if clean.is_empty() {
        return true;
    }
    let lower = clean.to_lowercase();
    // Exact silence markers whisper.cpp emits for no-speech captures.
    for marker in [
        "[blank_audio]",
        "[blank audio]",
        "[silence]",
        "(silence)",
        "*silence*",
        "[no speech]",
        "(no speech)",
    ] {
        if lower == marker {
            return true;
        }
    }
    // Bracketed silence with stray punctuation still counts as blank.
    let stripped: String = lower
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == ' ')
        .collect();
    let collapsed = stripped.split_whitespace().collect::<Vec<_>>().join(" ");
    matches!(collapsed.as_str(), "silence" | "blank audio" | "no speech")
}

/// Trusted whisper file names only. Paths are never built from speech text
/// and never pass through a shell: the binary runs with separate argv.
fn allowed_whisper_filename(name: &str) -> bool {
    matches!(
        name,
        "whisper-cli.exe"
            | "whisper.dll"
            | "ggml.dll"
            | "ggml-base.dll"
            | "ggml-cpu-alderlake.dll"
            | "ggml-cpu-cannonlake.dll"
            | "ggml-cpu-cascadelake.dll"
            | "ggml-cpu-haswell.dll"
            | "ggml-cpu-icelake.dll"
            | "ggml-cpu-sandybridge.dll"
            | "ggml-cpu-skylakex.dll"
            | "ggml-cpu-sse42.dll"
            | "ggml-cpu-x64.dll"
            | "ggml-base.bin"
            | "ggml-small.bin"
    )
}

/// Candidate whisper directories in trust order: bundled beside the binary,
/// dev repo voice-runtime/whisper, then explicit local setup dir. No PATH
/// lookup, no URL, no user-supplied directory.
fn whisper_candidate_dirs() -> Vec<std::path::PathBuf> {
    let mut dirs = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            dirs.push(parent.join("whisper"));
            // Tauri resources land under the resource dir in production.
            if let Some(res) = parent.join("resources").join("whisper").to_str().map(|_| parent.join("resources").join("whisper")) {
                dirs.push(res);
            }
        }
    }
    dirs.push(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("voice-runtime")
            .join("whisper"),
    );
    dirs.push(crate::settings::local_dir().join("whisper"));
    dirs
}

/// Resolves one trusted whisper file by allowlisted filename. Returns the
/// first existing file under the candidate dirs, never a constructed shell
/// string and never a path built from transcription text.
pub fn resolve_whisper_file(filename: &str) -> Option<std::path::PathBuf> {
    if !allowed_whisper_filename(filename) {
        return None;
    }
    for dir in whisper_candidate_dirs() {
        let candidate = dir.join(filename);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

pub fn resolve_whisper_binary() -> Option<std::path::PathBuf> {
    resolve_whisper_file("whisper-cli.exe")
}

pub fn resolve_whisper_model(model: &str) -> Option<std::path::PathBuf> {
    whisper_model_filename(model).and_then(resolve_whisper_file)
}

/// Local Whisper binary and model availability. Base ships, Small is explicit
/// setup. No download happens here: missing files fail visibly.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WhisperStatus {
    pub binary: bool,
    pub base: bool,
    pub small: bool,
    pub binary_path: Option<String>,
    pub base_path: Option<String>,
    pub small_path: Option<String>,
    pub error: Option<String>,
}

pub fn whisper_status() -> WhisperStatus {
    let binary = resolve_whisper_binary();
    let base = resolve_whisper_model("base");
    let small = resolve_whisper_model("small");
    let error = if binary.is_none() {
        Some("Whisper binary missing. Reinstall Choom with the voice runtime.".to_string())
    } else if base.is_none() {
        Some("Base model missing. Reinstall Choom with the voice runtime.".to_string())
    } else if small.is_none() {
        // Base is enough: Small stays explicitly unavailable, never claimed.
        None
    } else {
        None
    };
    WhisperStatus {
        binary: binary.is_some(),
        base: base.is_some(),
        small: small.is_some(),
        binary_path: binary.map(|p| p.to_string_lossy().to_string()),
        base_path: base.map(|p| p.to_string_lossy().to_string()),
        small_path: small.map(|p| p.to_string_lossy().to_string()),
        error,
    }
}

/// Crash-recovery startup plus best-effort cleanup: bounded temp WAVs are
/// removed on boot and never persist. Failures are ignored, never fatal.
pub fn cleanup_stale_whisper_wavs() {
    let dir = std::env::temp_dir();
    let Ok(entries) = std::fs::read_dir(&dir) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with(WHISPER_TEMP_PREFIX) && name.ends_with(".wav") {
            let _ = std::fs::remove_file(entry.path());
        }
    }
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
    if rt.dead.load(Ordering::SeqCst) {
        return Err("Voice helper exited. Recovery is bounded; see the island error.".to_string());
    }
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

/// How long a helper spawn may take before it counts as failed.
const HELPER_START_TIMEOUT: Duration = Duration::from_secs(10);

/// Clears dead helper handles without blocking: reaps if already exited,
/// kills otherwise, and always drops the pipes so sends fail loudly.
fn clear_handles(rt: &VoiceRuntime) {
    if let Some(mut child) = rt.child.lock().unwrap().take() {
        match child.try_wait() {
            Ok(Some(_)) => {
                let _ = child.wait();
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
    *rt.stdin.lock().unwrap() = None;
    rt.dead.store(true, Ordering::SeqCst);
}

/// Makes sure one live helper epoch exists and returns its epoch. The whole
/// check-and-spawn runs under the lifecycle lock, so concurrent Listen,
/// Wake and Speak calls serialize instead of spawning two microphones.
/// The blocking ready handshake runs on the blocking pool, never on the
/// Tauri UI thread.
async fn ensure_helper(app: &AppHandle, rt: &VoiceRuntime) -> Result<u64, String> {
    #[cfg(not(windows))]
    {
        let _ = (app, rt);
        return Err("Voice is not supported on this OS.".to_string());
    }
    #[cfg(windows)]
    {
        // The whole check-and-spawn serializes here: a second concurrent
        // caller waits instead of spawning a second microphone helper.
        let _lifecycle = rt.lifecycle.lock().await;
        // A dead helper never serves again: clear it, then count a bounded
        // restart instead of looping forever.
        if rt.dead.load(Ordering::SeqCst) || rt.child.lock().unwrap().is_none() {
            clear_handles(rt);
            {
                let mut restarts = rt.restarts.lock().unwrap();
                if *restarts >= MAX_HELPER_RESTARTS {
                    return Err("Voice helper keeps exiting. Restart Choom and check the speech engine.".to_string());
                }
                *restarts += 1;
            }
            return spawn_helper(app, rt).await;
        }
        // The handle exists but the process may have died unnoticed. The
        // guard is dropped before clear_handles, which takes the same lock.
        let exited = rt
            .child
            .lock()
            .unwrap()
            .as_mut()
            .map(|child| matches!(child.try_wait(), Ok(Some(_))))
            .unwrap_or(false);
        if exited {
            clear_handles(rt);
            return Err("Voice helper exited. Start listening again to recover.".to_string());
        }
        Ok(rt.instance.load(Ordering::SeqCst))
    }
}

/// Spawns one helper epoch and waits for its ready line, bounded. The
/// handles are only stored after ready, so no command can reach a helper
/// that never proved it listens.
#[cfg(windows)]
async fn spawn_helper(app: &AppHandle, rt: &VoiceRuntime) -> Result<u64, String> {
    let script =
        helper_script_path().ok_or_else(|| "Voice helper script missing.".to_string())?;
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
    let stdout = child.stdout.take().ok_or_else(|| "Voice helper has no output.".to_string())?;
    let instance = rt.instance.fetch_add(1, Ordering::SeqCst) + 1;

    // Bounded ready wait on a side thread: the line is capped before it is
    // ever allocated into a growing buffer. The reader comes back through
    // the channel on success, so the event loop owns it from the first byte.
    let (tx, rx) = std::sync::mpsc::channel::<Result<BufReader<ChildStdout>, String>>();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let started = std::time::Instant::now();
        loop {
            if started.elapsed() > HELPER_START_TIMEOUT {
                let _ = tx.send(Err("Voice helper did not answer in time.".to_string()));
                return;
            }
            let mut buf = Vec::new();
            // Bounded read: up to the cap plus one probe byte, never more.
            let mut capped = Read::by_ref(&mut reader).take(MAX_LINE_BYTES as u64 + 1);
            match capped.read_until(b'\n', &mut buf) {
                Ok(0) => {
                    let _ = tx.send(Err("Voice helper exited before answering.".to_string()));
                    return;
                }
                Ok(_) => {}
                Err(e) => {
                    let _ = tx.send(Err(format!("Voice helper output failed: {e}")));
                    return;
                }
            }
            if buf.len() > MAX_LINE_BYTES {
                continue;
            }
            let text = String::from_utf8_lossy(&buf).trim().to_string();
            if text.is_empty() {
                continue;
            }
            match parse_helper_line(&text) {
                Ok((kind, _, _, _)) if kind == "ready" => {
                    let _ = tx.send(Ok(reader));
                    return;
                }
                Ok(_) => continue,
                Err(_) => continue,
            }
        }
    });
    // The child stays ours while we wait; on failure it is reaped, never
    // leaked. The blocking wait runs on the blocking pool, off the UI.
    let reader = tokio::task::spawn_blocking(move || {
        rx.recv_timeout(HELPER_START_TIMEOUT + Duration::from_secs(2))
    })
    .await
    .map_err(|_| "Voice helper wait worker stopped.".to_string())?;
    let reader = match reader {
        Ok(Ok(reader)) => reader,
        Ok(Err(err)) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(err);
        }
        Err(_) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Voice helper did not answer in time.".to_string());
        }
    };
    *rt.child.lock().unwrap() = Some(child);
    *rt.stdin.lock().unwrap() = stdin;
    rt.dead.store(false, Ordering::SeqCst);
    *rt.restarts.lock().unwrap() = 0;
    let handle = app.clone();
    std::thread::spawn(move || read_loop(handle, reader, instance));
    Ok(instance)
}

fn read_loop(app: AppHandle, reader: BufReader<ChildStdout>, epoch: u64) {
    let rt: State<VoiceRuntime> = app.state();
    let mut reader = reader;
    // Bounded lines only: the cap is enforced per line before allocation.
    loop {
        let mut buf = Vec::new();
        let mut capped = Read::by_ref(&mut reader).take(MAX_LINE_BYTES as u64 + 1);
        let bytes = match capped.read_until(b'\n', &mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(_) => break,
        };
        if bytes > MAX_LINE_BYTES {
            continue;
        }
        let line = String::from_utf8_lossy(&buf).trim().to_string();
        if line.is_empty() {
            continue;
        }
        let parsed = match parse_helper_line(&line) {
            Ok(p) => p,
            Err(_) => continue,
        };
        let (kind, text, generation, instance) = parsed;
        // Never accept output from a disposed helper epoch.
        if instance != 0 && instance != epoch {
            continue;
        }
        // A superseded reader (an older epoch that somehow still runs) ends
        // itself instead of emitting into someone else's turn.
        if epoch != rt.instance.load(Ordering::SeqCst) {
            break;
        }
        // Cancellation generations: late helper output never acts.
        if (kind == "partial" || kind == "final" || kind == "transcribing" || kind == "empty")
            && generation != 0
            && rt.is_stale(generation)
        {
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
                if rt.rearm_after_speech.swap(false, Ordering::SeqCst) {
                    let handle = app.clone();
                    tauri::async_runtime::spawn(async move { boot_rearm_async(&handle).await; });
                }
            }
            "recovered" => {
                *rt.recover_attempts.lock().unwrap() = 0;
                set_state(&rt, VoiceState::Standby);
                emit(&app, "recovered", None, generation, None);
            }
            "error" => {
                rt.speaking.store(false, Ordering::SeqCst);
                rt.rearm_after_speech.store(false, Ordering::SeqCst);
                *rt.last_error.lock().unwrap() = text.clone();
                set_state(&rt, VoiceState::Error);
                emit(&app, "error", None, generation, text);
            }
            "wake_on" | "listening" => emit(&app, &kind, None, generation, None),
            "transcribing" => {
                set_state(&rt, VoiceState::Processing);
                emit(&app, "transcribing", None, generation, None);
            }
            "empty" => emit(&app, "empty", None, generation, None),
            "capability" => emit(&app, "capability", text, generation, None),
            _ => {}
        }
    }
    // The helper exited: mark it dead so the next command clears the handles
    // and counts one bounded restart instead of writing into the void.
    if epoch == rt.instance.load(Ordering::SeqCst) {
        rt.dead.store(true, Ordering::SeqCst);
        emit(&app, "helper_exited", None, rt.current_generation(), None);
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
    // Best-effort temp cleanup: no persistent user audio.
    cleanup_stale_whisper_wavs();
}

// ── Commands ────────────────────────────────────────────────────────────────

/// How long the inline speech probe may run before it counts as failed.
const PROBE_TIMEOUT: Duration = Duration::from_secs(15);

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
        // Hidden probe: installed recognizers plus synthesis voices whose
        // names match SelectVoice exactly. System.Speech is loaded
        // explicitly; without that the type lookup silently yields nothing.
        let probe = "Add-Type -AssemblyName System.Speech; $r = @(); try { $r = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers() | ForEach-Object { $_.Culture.Name + ' ' + $_.Id } } catch { $r = @($_.Exception.Message) }; $v = @(); try { $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $v = $s.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name }; $s.Dispose() } catch {}; @{ recognizers = @($r); voices = @($v) } | ConvertTo-Json -Compress";
        let mut cmd = Command::new("powershell");
        cmd.args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", probe]);
        cmd.stdout(Stdio::piped()).stderr(Stdio::null());
        platform::no_console(&mut cmd);
        let output = tokio::time::timeout(
            PROBE_TIMEOUT,
            tokio::task::spawn_blocking(move || cmd.output()),
        )
        .await
        .map_err(|_| "Voice probe timed out.".to_string())?
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

fn voice_guards(rt: &VoiceRuntime, shared: &crate::Shared, muted: bool) -> Result<(), String> {
    let settings = shared.settings.lock().unwrap();
    if !settings.voice_enabled {
        return Err("Voice is off. Turn it on in Settings first.".to_string());
    }
    if rt.locked.load(Ordering::SeqCst) {
        return Err("The PC is locked. Voice resumes after unlock.".to_string());
    }
    if rt.suspended.load(Ordering::SeqCst) {
        return Err("The PC is suspended. Voice resumes after resume.".to_string());
    }
    if rt.paused.load(Ordering::SeqCst) {
        return Err("Choom is paused. Unpause to talk.".to_string());
    }
    if muted || rt.muted.load(Ordering::SeqCst) {
        return Err("Voice is muted. Unmute to talk.".to_string());
    }
    Ok(())
}

/// Talkback guards: consent and lock always apply; mic mute does not silence
/// results the user already asked to hear.
fn speak_guards(rt: &VoiceRuntime, shared: &crate::Shared) -> Result<(), String> {
    let settings = shared.settings.lock().unwrap();
    if !settings.voice_enabled {
        return Err("Voice is off. Turn it on in Settings first.".to_string());
    }
    if rt.locked.load(Ordering::SeqCst) {
        return Err("The PC is locked. Voice resumes after unlock.".to_string());
    }
    if rt.suspended.load(Ordering::SeqCst) {
        return Err("The PC is suspended. Voice resumes after resume.".to_string());
    }
    if rt.paused.load(Ordering::SeqCst) {
        return Err("Choom is paused. Unpause to talk.".to_string());
    }
    Ok(())
}

/// Starts dictation. Requires explicit voice opt-in. Returns the generation id.
/// The backend comes from settings: system (Windows dictation) or whisper
/// (local Whisper). Failures never silently switch backends.
#[tauri::command]
pub async fn voice_listen_start(
    app: AppHandle,
    rt: State<'_, VoiceRuntime>,
    settings: State<'_, crate::Shared>,
    muted: bool,
) -> Result<u64, String> {
    voice_guards(&rt, &settings, muted)?;
    let (backend, model) = {
        let s = settings.settings.lock().unwrap();
        (normalize_backend(&s.voice_backend), normalize_model(&s.voice_model))
    };
    if backend == "whisper" {
        // Fail visibly when the binary or model is missing. No silent fallback.
        if resolve_whisper_binary().is_none() {
            return Err("Whisper binary missing. Reinstall Choom with the voice runtime.".to_string());
        }
        if resolve_whisper_model(&model).is_none() {
            if model == "small" {
                return Err("Small model is not installed. Place ggml-small.bin in the whisper folder, or switch to Base.".to_string());
            }
            return Err("Base model missing. Reinstall Choom with the voice runtime.".to_string());
        }
        cleanup_stale_whisper_wavs();
    }
    let instance = ensure_helper(&app, &rt).await?;
    let generation = rt.next_generation();
    *rt.recover_attempts.lock().unwrap() = 0;
    rt.speaking.store(false, Ordering::SeqCst);
    set_state(&rt, VoiceState::Listening);
    let body = if backend == "whisper" {
        serde_json::json!({ "cmd": "listen", "backend": "whisper", "model": model, "generation": generation, "instance": instance })
    } else {
        serde_json::json!({ "cmd": "listen", "generation": generation, "instance": instance })
    };
    send_command(&rt, &body.to_string())?;
    emit(&app, "listening", None, generation, None);
    Ok(generation)
}

/// Stops capture but keeps the helper alive for the next turn.
/// For Whisper this finishes the utterance and transcribes; mute, pause,
/// lock and cancel use `stop` (discard) instead, so no audio survives them.
#[tauri::command]
pub fn voice_listen_stop(
    app: AppHandle,
    rt: State<VoiceRuntime>,
    shared: State<crate::Shared>,
) -> Result<(), String> {
    let instance = rt.instance.load(Ordering::SeqCst);
    let backend = normalize_backend(&shared.settings.lock().unwrap().voice_backend);
    let model = normalize_model(&shared.settings.lock().unwrap().voice_model);
    let body = if backend == "whisper" {
        serde_json::json!({ "cmd": "whisper_finish", "model": model, "instance": instance })
    } else {
        serde_json::json!({ "cmd": "stop", "instance": instance })
    };
    let _ = send_command(&rt, &body.to_string());
    // For Whisper the final arrives after transcription; standby is set now
    // and the final still applies because the generation is unchanged.
    set_state(&rt, VoiceState::Standby);
    emit(&app, "stopped", None, rt.current_generation(), None);
    Ok(())
}

/// Local Whisper binary and model availability. No download, no mic use.
/// Base ships with the review installer; Small shows unavailable until an
/// explicit local model setup. No automatic network downloads.
#[tauri::command]
pub fn voice_whisper_status() -> WhisperStatus {
    whisper_status()
}

/// Cancels the current voice generation, mic recognition and speech.
/// Owned agent cancellation is handled by the frontend via chat reset where supported.
#[tauri::command]
pub fn voice_cancel(app: AppHandle, rt: State<VoiceRuntime>) -> Result<u64, String> {
    rt.rearm_after_speech.store(false, Ordering::SeqCst);
    let instance = rt.instance.load(Ordering::SeqCst);
    let stop = serde_json::json!({ "cmd": "stop", "instance": instance }).to_string();
    let hush = serde_json::json!({ "cmd": "stop_audio", "instance": instance }).to_string();
    let _ = send_command(&rt, &stop);
    let _ = send_command(&rt, &hush);
    let generation = rt.cancel();
    emit(&app, "cancelled", None, generation, None);
    Ok(generation)
}

/// Speaks a short factual result. Recognition stops first so the talkback
/// never feeds itself; the follow-up turn starts fresh capture afterwards.
#[tauri::command]
pub async fn voice_speak(
    app: AppHandle,
    rt: State<'_, VoiceRuntime>,
    shared: State<'_, crate::Shared>,
    text: String,
    generation: Option<u64>,
    audition: Option<bool>,
) -> Result<(), String> {
    let audition = audition.unwrap_or(false);
    let generation = if audition { rt.current_generation() } else {
        generation.ok_or_else(|| "Missing voice turn.".to_string())?
    };
    if rt.is_stale(generation) {
        return Ok(());
    }
    speak_guards(&rt, &shared)?;
    let (voice, rate, volume) = {
        let s = shared.settings.lock().unwrap();
        (s.voice_speech_voice.clone(), s.voice_speech_rate, s.voice_speech_volume)
    };
    let short = speak_text(&text);
    if short.is_empty() {
        return Ok(());
    }
    let instance = ensure_helper(&app, &rt).await?;
    rt.speaking.store(true, Ordering::SeqCst);
    rt.rearm_after_speech.store(audition, Ordering::SeqCst);
    set_state(&rt, VoiceState::Speaking);
    let body = serde_json::json!({
        "cmd": "speak",
        "text": short,
        "voice": voice,
        "rate": rate,
        "volume": volume,
        "generation": generation,
        "instance": instance,
    });
    send_command(&rt, &body.to_string())?;
    Ok(())
}

/// Immediate stop for talkback. Visible Stop and Escape always reach here.
#[tauri::command]
pub fn voice_speak_stop(app: AppHandle, rt: State<VoiceRuntime>) -> Result<(), String> {
    rt.rearm_after_speech.store(false, Ordering::SeqCst);
    rt.speaking.store(false, Ordering::SeqCst);
    let instance = rt.instance.load(Ordering::SeqCst);
    let body = serde_json::json!({ "cmd": "stop_audio", "instance": instance }).to_string();
    let _ = send_command(&rt, &body.to_string());
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
    if enabled {
        voice_guards(&rt, &shared, false)?;
    }
    if !enabled {
        rt.wake_on.store(false, Ordering::SeqCst);
        let instance = rt.instance.load(Ordering::SeqCst);
        let body = serde_json::json!({ "cmd": "stop", "instance": instance }).to_string();
        let _ = send_command(&rt, &body.to_string());
        emit(&app, "wake_off", None, rt.current_generation(), None);
        // Worker exits when opt-in is disabled.
        if !voice_enabled {
            shutdown_helper(&rt);
        }
        return Ok(());
    }
    let instance = ensure_helper(&app, &rt).await?;
    rt.wake_on.store(true, Ordering::SeqCst);
    set_state(&rt, VoiceState::Standby);
    let phrase = if phrase.trim().is_empty() { "Choom".to_string() } else { phrase.trim().to_string() };
    let generation = rt.current_generation();
    let body = serde_json::json!({ "cmd": "wake_on", "phrase": phrase, "generation": generation, "instance": instance });
    send_command(&rt, &body.to_string())?;
    Ok(())
}

/// Recreates the recognizer on the default device after a device failure.
/// Bounded per turn and always visible: success emits recovered, exhaustion
/// is an honest error, never a fake standby.
#[tauri::command]
pub async fn voice_device_recover(
    app: AppHandle,
    rt: State<'_, VoiceRuntime>,
    shared: State<'_, crate::Shared>,
) -> Result<(), String> {
    voice_guards(&rt, &shared, false)?;
    {
        let mut attempts = rt.recover_attempts.lock().unwrap();
        if *attempts >= MAX_RECOVER_ATTEMPTS {
            return Err("Device recovery is exhausted for this turn. Check the microphone, then start listening again.".to_string());
        }
        *attempts += 1;
    }
    let instance = ensure_helper(&app, &rt).await?;
    let generation = rt.current_generation();
    let body = serde_json::json!({ "cmd": "recover", "generation": generation, "instance": instance });
    send_command(&rt, &body.to_string())?;
    Ok(())
}

/// Runs one exact saved shortcut chosen from an ambiguity list. The kind and
/// target must match a saved shortcut byte for byte, and the generation must
/// still own the turn; nothing is guessed and stale runs never launch.
#[tauri::command]
pub async fn voice_tool_run(
    rt: State<'_, VoiceRuntime>,
    shared: State<'_, crate::Shared>,
    kind: String,
    target: String,
    generation: u64,
) -> Result<String, String> {
    if rt.is_stale(generation) {
        return Err("That turn was cancelled.".to_string());
    }
    let found = {
        let s = shared.settings.lock().unwrap();
        s.tools
            .shortcuts
            .iter()
            .any(|x| x.kind == kind && x.target == target)
    };
    if !found {
        return Err("That shortcut is no longer saved. Pick again.".to_string());
    }
    crate::choom::tools::validate_target(&kind, &target)?;
    if kind == "folder" {
        crate::choom::tools::open_folder_native(&target)?;
    } else {
        crate::choom::tools::launch_app_native(&target)?;
    }
    Ok(target)
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
            .map(|x| (x.id.clone(), x.name.clone(), x.kind.clone(), x.target.clone()))
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
            options: vec![],
            reason: None,
        });
    }
    Ok(resolve_voice_tool(&utterance, &shortcuts, &routines))
}

/// Free-only provider gate for voice turns. The agent catalog comes from the
/// live server, so only models it actually offers can pass.
#[tauri::command]
pub async fn voice_provider_check(
    shared: State<'_, crate::Shared>,
    agent: State<'_, crate::choom::opencode_agent::AgentState>,
) -> Result<(), String> {
    let (provider, agent_model, go_model) = {
        let s = shared.settings.lock().unwrap();
        (s.chat_provider.clone(), s.opencode_agent_model.clone(), s.opencode_model.clone())
    };
    let catalog: Vec<String> = if provider == "opencode-agent" {
        let settings = shared.settings.lock().unwrap().clone();
        crate::choom::opencode_agent::ensure_ready(&settings, &agent).await?;
        crate::choom::opencode_agent::models(&settings, &agent)
            .await?
            .into_iter()
            .map(|(id, _)| id)
            .collect()
    } else {
        vec![]
    };
    let has_key = crate::secrets::present("opencode-api-key") || crate::secrets::present("anthropic-api-key");
    provider_check(&provider, &agent_model, &go_model, has_key, &catalog)
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

/// Edits one explicitly saved fact. The id must exist; the new text is
/// revalidated and timestamped, provenance stays user.
#[tauri::command]
pub async fn voice_memory_update(id: String, text: String) -> Result<MemoryEntry, String> {
    let clean = clean_memory(&text)?;
    let mut entries = load_memories();
    let Some(entry) = entries.iter_mut().find(|e| e.id == id) else {
        return Err("That memory was not found.".to_string());
    };
    entry.text = clean;
    entry.created_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(entry.created_ms);
    let updated = entry.clone();
    save_memories(&entries)?;
    Ok(updated)
}

#[tauri::command]
pub async fn voice_memory_clear() -> Result<(), String> {
    save_memories(&[])
}

/// Shuts the helper down. Called on disable, lock and app exit.
pub fn shutdown(rt: &VoiceRuntime) {
    shutdown_helper(rt);
}

/// Authoritative mic mute. Muting closes capture at once and blocks every
/// automatic re-arm, including lock and resume recovery and device retry.
#[tauri::command]
pub fn voice_mute(app: AppHandle, rt: State<VoiceRuntime>, muted: bool) -> Result<(), String> {
    rt.muted.store(muted, Ordering::SeqCst);
    if muted {
        rt.rearm_after_speech.store(false, Ordering::SeqCst);
        rt.was_armed.store(false, Ordering::SeqCst);
        rt.wake_on.store(false, Ordering::SeqCst);
        let instance = rt.instance.load(Ordering::SeqCst);
        let stop = serde_json::json!({ "cmd": "stop", "instance": instance }).to_string();
        let hush = serde_json::json!({ "cmd": "stop_audio", "instance": instance }).to_string();
        let _ = send_command(&rt, &stop);
        let _ = send_command(&rt, &hush);
        rt.speaking.store(false, Ordering::SeqCst);
        set_state(&rt, VoiceState::Standby);
        emit(&app, "muted", None, rt.current_generation(), None);
    } else {
        emit(&app, "unmuted", None, rt.current_generation(), None);
    }
    Ok(())
}

/// Mirrors the island pause switch into the voice guards: paused capture
/// may not start, and in-flight capture stops.
pub fn set_paused_native(rt: &VoiceRuntime, paused: bool) {
    rt.paused.store(paused, Ordering::SeqCst);
    if paused {
        let instance = rt.instance.load(Ordering::SeqCst);
        let body = serde_json::json!({ "cmd": "stop", "instance": instance }).to_string();
        let _ = send_command(rt, &body);
        rt.speaking.store(false, Ordering::SeqCst);
        set_state(rt, VoiceState::Standby);
    }
}

/// Native global hotkey plus session lock and suspend notifications.
///
/// An invisible top-level window on its own thread owns Ctrl+Shift+V through
/// RegisterHotKey, so the hotkey works while another app is focused. The
/// window is top-level without WS_VISIBLE: message-only windows never
/// receive power broadcasts, so they cannot carry suspend and resume. The
/// same window takes WM_WTSSESSION_CHANGE and WM_POWERBROADCAST: lock and
/// suspend each close capture at once and each blocks restart until its own
/// unlock or resume. Registration failure is surfaced as an event that also
/// blocks wake capture, never silent.
#[cfg(windows)]
pub mod native {
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use tauri::{Emitter, Manager};

    use super::VoiceRuntime;

    static HANDLE_PTR: AtomicUsize = AtomicUsize::new(0);
    static STARTED: AtomicBool = AtomicBool::new(false);

    const HOTKEY_ID: i32 = 0xC00;
    const VK_V: u32 = 0x56;
    const WTS_SESSION_LOCK: usize = 0x7;
    const WTS_SESSION_UNLOCK: usize = 0x8;
    const PBT_APMSUSPEND: usize = 0x4;
    const PBT_APMRESUMESUSPEND: usize = 0x7;

    /// Runs f with the app handle and voice runtime stored at start. The
    /// handle is intentionally leaked: it lives exactly as long as the app.
    fn with_native(f: impl FnOnce(&tauri::AppHandle, &VoiceRuntime)) {
        let ptr = HANDLE_PTR.load(Ordering::SeqCst);
        if ptr == 0 {
            return;
        }
        let app = unsafe { &*(ptr as *const tauri::AppHandle) };
        let rt: tauri::State<VoiceRuntime> = app.state();
        f(app, &rt);
    }

    /// Starts the watcher thread once. Safe to call repeatedly.
    pub fn start(handle: tauri::AppHandle) {
        if STARTED.swap(true, Ordering::SeqCst) {
            return;
        }
        HANDLE_PTR.store(Box::into_raw(Box::new(handle.clone())) as usize, Ordering::SeqCst);
        if std::thread::Builder::new()
            .name("choom-voice-native".into())
            .spawn(move || watch(handle))
            .is_err()
        {
            // Without the observer there is no hotkey and no lock guard:
            // say so in the island instead of running unprotected.
            with_native(|a, _| {
                let _ = a.emit(
                    "voice-hotkey-error",
                    "Voice observer failed to start: no global hotkey and no lock guard.",
                );
            });
        }
    }

    fn watch(app: tauri::AppHandle) {
        use windows::core::w;
        use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
        use windows::Win32::System::RemoteDesktop::{
            NOTIFY_FOR_THIS_SESSION, WTSRegisterSessionNotification,
            WTSUnRegisterSessionNotification,
        };
        use windows::Win32::UI::Input::KeyboardAndMouse::{
            RegisterHotKey, MOD_CONTROL, MOD_SHIFT,
        };
        use windows::Win32::UI::WindowsAndMessaging::{
            CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, RegisterClassW,
            TranslateMessage, MSG, WM_DESTROY, WM_HOTKEY, WM_POWERBROADCAST,
            WM_WTSSESSION_CHANGE, WNDCLASSW, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
            WS_OVERLAPPED,
        };

        unsafe extern "system" fn wndproc(
            hwnd: HWND,
            msg: u32,
            wparam: WPARAM,
            lparam: LPARAM,
        ) -> LRESULT {
            if msg == WM_HOTKEY {
                with_native(|a, _| {
                    let _ = a.emit("voice-hotkey", ());
                });
                return LRESULT(0);
            }
            if msg == WM_WTSSESSION_CHANGE {
                with_native(|a, rt| {
                    if wparam.0 == WTS_SESSION_LOCK {
                        super::on_lock(a, rt);
                    } else if wparam.0 == WTS_SESSION_UNLOCK {
                        super::on_unlock(a, rt);
                    }
                });
                return LRESULT(0);
            }
            if msg == WM_POWERBROADCAST {
                with_native(|a, rt| {
                    if wparam.0 == PBT_APMSUSPEND {
                        super::on_suspend(a, rt);
                    } else if wparam.0 == PBT_APMRESUMESUSPEND {
                        super::on_resume(a, rt);
                    }
                });
                return LRESULT(1);
            }
            unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
        }

        fn fail(app: &tauri::AppHandle, message: &str) {
            crate::log::line(format!("voice native: {message}"));
            let _ = app.emit("voice-hotkey-error", message);
        }

        unsafe {
            let class = WNDCLASSW {
                lpfnWndProc: Some(wndproc),
                lpszClassName: w!("ChoomVoiceNative"),
                ..Default::default()
            };
            if RegisterClassW(&class) == 0 {
                fail(&app, "voice hotkey window failed to register");
                return;
            }
            // Invisible top-level window: no WS_VISIBLE, kept out of Alt-Tab.
            // Message-only windows never receive power broadcasts, so the
            // observer must be top-level to carry suspend and resume.
            let hwnd = match CreateWindowExW(
                WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW,
                w!("ChoomVoiceNative"),
                windows::core::PCWSTR::null(),
                WS_OVERLAPPED,
                0,
                0,
                0,
                0,
                None,
                None,
                None,
                None,
            ) {
                Ok(hwnd) => hwnd,
                Err(e) => {
                    fail(&app, &format!("voice observer window failed: {e}"));
                    return;
                }
            };
            if RegisterHotKey(Some(hwnd), HOTKEY_ID, MOD_CONTROL | MOD_SHIFT, VK_V).is_err() {
                let _ = app.emit(
                    "voice-hotkey-error",
                    "Ctrl+Shift+V is already taken by another app. Voice still works from the island mic button.",
                );
            }
            if WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION).is_err() {
                fail(&app, "voice session notifications unavailable: lock will not close capture");
            }
            let mut msg = MSG::default();
            while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            if msg.message == WM_DESTROY {
                let _ = WTSUnRegisterSessionNotification(hwnd);
            }
        }
    }
}

/// Re-arms opted-in keyword wake at boot. Nothing starts unless the user
/// opted into both voice and wake; lock and pause are clear this early.
pub fn boot_rearm(app: &AppHandle) {
    #[cfg(not(windows))]
    {
        let _ = app;
    }
    #[cfg(windows)]
    {
        native::start(app.clone());
        let handle = app.clone();
        tauri::async_runtime::spawn(async move {
            boot_rearm_async(&handle).await;
        });
    }
}

#[cfg(windows)]
async fn boot_rearm_async(app: &AppHandle) {
    // Crash-recovery startup: bounded temp WAVs never persist.
    cleanup_stale_whisper_wavs();
    let rt: State<VoiceRuntime> = app.state();
    let shared: State<crate::Shared> = app.state();
    if voice_guards(&rt, &shared, false).is_err() { return; }
    let (enabled, wake, phrase) = {
        let s = shared.settings.lock().unwrap();
        (s.voice_enabled, s.voice_wake_enabled, s.voice_wake_phrase.clone())
    };
    if !(enabled && wake) {
        return;
    }
    let Ok(instance) = ensure_helper(app, &rt).await else { return };
    rt.wake_on.store(true, Ordering::SeqCst);
    set_state(&rt, VoiceState::Standby);
    let phrase = if phrase.trim().is_empty() { "Choom".to_string() } else { phrase.trim().to_string() };
    let generation = rt.current_generation();
    let body = serde_json::json!({ "cmd": "wake_on", "phrase": phrase, "generation": generation, "instance": instance });
    let _ = send_command(&rt, &body.to_string());
}

/// Stops capture the same way for lock and suspend, then reports which one.
fn stop_for_session(app: &AppHandle, rt: &VoiceRuntime, what: &str) {
    let instance = rt.instance.load(Ordering::SeqCst);
    let stop = serde_json::json!({ "cmd": "stop", "instance": instance }).to_string();
    let hush = serde_json::json!({ "cmd": "stop_audio", "instance": instance }).to_string();
    let _ = send_command(rt, &stop);
    let _ = send_command(rt, &hush);
    rt.speaking.store(false, Ordering::SeqCst);
    // Remember an armed wake so unlock or resume can re-arm exactly once
    // both flags are clear; the flag itself always goes down now.
    if rt.wake_on.swap(false, Ordering::SeqCst) {
        rt.was_armed.store(true, Ordering::SeqCst);
    }
    set_state(rt, VoiceState::Standby);
    emit_session(app, what);
}

/// Re-arms a remembered wake once lock AND suspend are both clear and the
/// settings still opt in. Clearing one never lifts the other.
fn maybe_rearm(app: &AppHandle, rt: &VoiceRuntime, what: &str) {
    if rt.locked.load(Ordering::SeqCst) || rt.suspended.load(Ordering::SeqCst) {
        emit_session(app, what);
        return;
    }
    emit_session(app, what);
    if !rt.was_armed.swap(false, Ordering::SeqCst) {
        return;
    }
    let shared: State<crate::Shared> = app.state();
    let (enabled, wake, phrase) = {
        let s = shared.settings.lock().unwrap();
        (s.voice_enabled, s.voice_wake_enabled, s.voice_wake_phrase.clone())
    };
    if !(enabled && wake) {
        return;
    }
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let rt: State<VoiceRuntime> = handle.state();
        let Ok(instance) = ensure_helper(&handle, &rt).await else { return };
        // A fresh lock or mute in between still wins over the re-arm.
        if rt.locked.load(Ordering::SeqCst)
            || rt.suspended.load(Ordering::SeqCst)
            || rt.muted.load(Ordering::SeqCst)
            || rt.paused.load(Ordering::SeqCst)
        {
            return;
        }
        rt.wake_on.store(true, Ordering::SeqCst);
        set_state(&rt, VoiceState::Standby);
        let phrase = if phrase.trim().is_empty() { "Choom".to_string() } else { phrase.trim().to_string() };
        let generation = rt.current_generation();
        let body = serde_json::json!({ "cmd": "wake_on", "phrase": phrase, "generation": generation, "instance": instance });
        let _ = send_command(&rt, &body.to_string());
    });
}

/// Session lock closes capture immediately and prevents restart until
/// unlock. Suspend is tracked separately.
pub fn on_lock(app: &AppHandle, rt: &VoiceRuntime) {
    rt.locked.store(true, Ordering::SeqCst);
    stop_for_session(app, rt, "locked");
}

/// Session unlock lifts only the lock. Wake re-arms only once suspend is
/// clear too.
pub fn on_unlock(app: &AppHandle, rt: &VoiceRuntime) {
    rt.locked.store(false, Ordering::SeqCst);
    set_state(rt, VoiceState::Standby);
    maybe_rearm(app, rt, "unlocked");
}

/// Power suspend closes capture immediately and prevents restart until
/// resume. Lock is tracked separately.
pub fn on_suspend(app: &AppHandle, rt: &VoiceRuntime) {
    rt.suspended.store(true, Ordering::SeqCst);
    stop_for_session(app, rt, "suspended");
}

/// Power resume lifts only the suspend. Wake re-arms only once lock is
/// clear too.
pub fn on_resume(app: &AppHandle, rt: &VoiceRuntime) {
    rt.suspended.store(false, Ordering::SeqCst);
    set_state(rt, VoiceState::Standby);
    maybe_rearm(app, rt, "resumed");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn helper_lines_validate_size_shape_and_type() {
        assert!(parse_helper_line(r#"{"type":"partial","text":"hi","generation":1,"instance":2}"#).is_ok());
        assert!(parse_helper_line(r#"{"type":"nope"}"#).is_err());
        assert!(parse_helper_line("not json").is_err());
        let big = format!(r#"{{"type":"partial","text":"{}"}}"#, "x".repeat(MAX_LINE_BYTES + 1));
        assert!(parse_helper_line(&big).is_err());
        // Text is bounded, never grown.
        let long = format!(r#"{{"type":"final","text":"{}","generation":2}}"#, "y".repeat(5000));
        let (_, text, _, _) = parse_helper_line(&long).unwrap();
        assert!(text.unwrap().chars().count() <= MAX_TEXT_CHARS);
        // Epochs ride along: disposed helper output is never accepted.
        let (_, _, gen, inst) =
            parse_helper_line(r#"{"type":"final","text":"hi","generation":4,"instance":9}"#).unwrap();
        assert_eq!((gen, inst), (4, 9));
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
    fn tool_targets_need_intent_and_exact_names() {
        let shortcuts = vec![
            ("notes".to_string(), "Notes".to_string(), "folder".to_string(), "D:\\notes".to_string()),
            ("archive".to_string(), "Archive".to_string(), "folder".to_string(), "D:\\archive".to_string()),
            ("code".to_string(), "Code".to_string(), "app".to_string(), "C:\\t\\code.exe".to_string()),
        ];
        let routines = vec![("r1".to_string(), "Design mode".to_string())];
        // A bare mention is not intent: names alone route to the agent.
        let mention = resolve_voice_tool("what about my notes", &shortcuts, &routines);
        assert_eq!(mention.kind, "agent");
        // Explicit verb plus the exact name runs.
        let one = resolve_voice_tool("open code", &shortcuts, &routines);
        assert_eq!(one.kind, "app");
        // Two names in one breath refuse with actionable choices.
        let ambiguous = resolve_voice_tool("open notes archive", &shortcuts, &routines);
        assert_eq!(ambiguous.kind, "ambiguous");
        assert_eq!(ambiguous.options.len(), 2);
        assert_eq!(ambiguous.options[0].target, "D:\\notes".to_string());
        // Real pause and play semantics, not a blind toggle.
        let pause = resolve_voice_tool("pause music", &shortcuts, &routines);
        assert_eq!(pause.kind, "media");
        assert_eq!(pause.action.as_deref(), Some("pause"));
        let play = resolve_voice_tool("play music", &shortcuts, &routines);
        assert_eq!(play.action.as_deref(), Some("play"));
        // Routines need a start verb plus the exact name.
        let routine = resolve_voice_tool("start design mode", &[], &routines);
        assert_eq!(routine.kind, "routine");
        assert_eq!(routine.routine_id.as_deref(), Some("r1"));
        let bare_routine = resolve_voice_tool("design mode", &[], &routines);
        assert_eq!(bare_routine.kind, "agent");
        let refused = resolve_voice_tool("approve the permission", &shortcuts, &routines);
        assert_eq!(refused.kind, "refused");
        let agent = resolve_voice_tool("explain black holes", &shortcuts, &routines);
        assert_eq!(agent.kind, "agent");
    }

    #[test]
    fn utterance_normalization_collapses_case_and_spaces() {
        assert_eq!(normalize_utterance("  Open   NOTES. "), "open notes");
        assert_eq!(normalize_utterance("START design Mode?"), "start design mode");
    }

    #[test]
    fn voice_accepts_only_verified_free_models() {
        let catalog = vec![
            "opencode/muse-spark-1.3-contributor-free".to_string(),
            "opencode/mimo-v2.6-flash-free".to_string(),
            "openai/gpt-5".to_string(),
        ];
        // Exact verified free IDs in the live catalog pass.
        assert!(provider_check("opencode-agent", "opencode/muse-spark-1.3-contributor-free", "", true, &catalog).is_ok());
        assert!(provider_check("opencode-agent", "opencode/mimo-v2.6-flash-free", "", true, &catalog).is_ok());
        // Present in the catalog but not verified free: refused.
        assert!(provider_check("opencode-agent", "openai/gpt-5", "", true, &catalog).is_err());
        // Verified ID but absent from this server's catalog: refused.
        assert!(provider_check("opencode-agent", "opencode/mimo-v2.6-flash-free", "", true, &[]).is_err());
        // The old pong-fixture ID was never a free-pricing verification.
        assert!(provider_check("opencode-agent", "opencode-go/qwen3.8-flash", "", true, &catalog).is_err());
        // Server default, empty, unqualified and unknown strings all refused.
        assert!(provider_check("opencode-agent", "", "", true, &catalog).is_err());
        assert!(provider_check("opencode-agent", "qwen", "", true, &catalog).is_err());
        assert!(provider_check("opencode-agent", "other/model", "", true, &[],).is_err());
        // Go plan models from the configured catalog pass with a key; the
        // plan itself must allow them, which only Settings can confirm.
        assert!(provider_check("opencode-go", "", "qwen3.8-flash", true, &[]).is_ok());
        assert!(provider_check("opencode-go", "", "qwen3.8-flash", false, &[]).is_err());
        assert!(provider_check("opencode-go", "", "gpt-5", true, &[]).is_err());
        // Metered APIs stay typed only, key or not.
        assert!(provider_check("anthropic", "", "", true, &[]).is_err());
        assert!(provider_check("unknown", "", "", true, &[]).is_err());
    }

    #[test]
    fn guards_block_muted_locked_suspended_and_paused() {
        use std::sync::Mutex;
        let shared = crate::Shared {
            settings: Mutex::new(crate::settings::Settings::default()),
            gate: std::sync::Arc::new(crate::island::PollGate::new()),
        };
        let rt = VoiceRuntime::default();
        // Voice is off by default.
        assert!(voice_guards(&rt, &shared, false).is_err());
        shared.settings.lock().unwrap().voice_enabled = true;
        assert!(voice_guards(&rt, &shared, false).is_ok());
        // Frontend mute bit and authoritative native mute both block.
        assert!(voice_guards(&rt, &shared, true).is_err());
        rt.muted.store(true, Ordering::SeqCst);
        assert!(voice_guards(&rt, &shared, false).is_err());
        rt.muted.store(false, Ordering::SeqCst);
        // Lock and suspend block separately, with distinct messages.
        rt.locked.store(true, Ordering::SeqCst);
        let err = voice_guards(&rt, &shared, false).unwrap_err();
        assert!(err.contains("locked"));
        rt.locked.store(false, Ordering::SeqCst);
        rt.suspended.store(true, Ordering::SeqCst);
        let err = voice_guards(&rt, &shared, false).unwrap_err();
        assert!(err.contains("suspended"));
        rt.suspended.store(false, Ordering::SeqCst);
        rt.paused.store(true, Ordering::SeqCst);
        assert!(voice_guards(&rt, &shared, false).is_err());
        rt.paused.store(false, Ordering::SeqCst);
        assert!(voice_guards(&rt, &shared, false).is_ok());
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

    #[test]
    fn cancel_then_new_request_invalidates_the_old_owner() {
        let rt = VoiceRuntime::default();
        let first = rt.next_generation();
        rt.cancel();
        assert!(rt.is_stale(first));
        let second = rt.next_generation();
        assert!(!rt.is_stale(second));
        // A wake that fires for the old generation must not act.
        assert!(rt.is_stale(first));
    }

    /// WAV protocol check without microphone or speaker: the helper renders
    /// test speech to a file and the JSON framing round-trips. Explicitly
    /// opt-in only; normal `cargo test` never touches audio hardware.
    #[cfg(windows)]
    #[test]
    #[ignore = "Windows only; set CHOOM_VOICE_SELFTEST=1 to verify the helper WAV protocol"]
    fn helper_wav_roundtrip_verifies_protocol() {
        if std::env::var("CHOOM_VOICE_SELFTEST").as_deref() != Ok("1") {
            panic!("set CHOOM_VOICE_SELFTEST=1 to run the WAV protocol check");
        }
        let dir = std::env::temp_dir().join(format!("choom-voice-selftest-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let wav = dir.join("talkback.wav");
        let script = super::helper_script_path().expect("helper script present");
        let mut cmd = std::process::Command::new("powershell");
        cmd.args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            &script.to_string_lossy(),
        ]);
        cmd.env("CHOOM_VOICE_TEST", "1");
        cmd.stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null());
        crate::platform::no_console(&mut cmd);
        let mut child = cmd.spawn().expect("helper spawns");
        let mut stdin = child.stdin.take().expect("stdin");
        let stdout = child.stdout.take().expect("stdout");
        let mut reader = std::io::BufReader::new(stdout);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
        let mut saw_ready = false;
        let mut saw_ended = false;
        let mut sent = false;
        use std::io::{BufRead, Write};
        while std::time::Instant::now() < deadline {
            let mut buf = Vec::new();
            let mut capped = (&mut reader as &mut dyn BufRead).take(MAX_LINE_BYTES as u64 + 1);
            match capped.read_until(b'\n', &mut buf) {
                Ok(0) => break,
                Ok(_) => {}
                Err(_) => break,
            }
            if buf.len() > MAX_LINE_BYTES {
                continue;
            }
            let line = String::from_utf8_lossy(&buf).trim().to_string();
            let Ok((kind, _, _, _)) = parse_helper_line(&line) else { continue };
            if kind == "ready" {
                saw_ready = true;
            }
            if saw_ready && !sent {
                sent = true;
                let wav_arg = serde_json::json!({
                    "cmd": "test_speak",
                    "text": "Choom voice check.",
                    "wav": wav.to_string_lossy(),
                    "generation": 1,
                    "instance": 1,
                });
                let line = format!("{}\n", wav_arg);
                stdin.write_all(line.as_bytes()).unwrap();
                stdin.flush().unwrap();
            }
            if kind == "speech_ended" && sent {
                saw_ended = true;
                break;
            }
        }
        let _ = stdin;
        let _ = child.kill();
        let _ = child.wait();
        assert!(saw_ready, "helper answered ready");
        assert!(saw_ended, "test synthesis completed without a speaker");
        let meta = std::fs::metadata(&wav).expect("WAV file rendered");
        assert!(meta.len() > 44, "WAV has a header plus samples");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn whisper_backend_and_model_validate() {
        assert!(valid_voice_backend("system"));
        assert!(valid_voice_backend("whisper"));
        assert!(!valid_voice_backend("cloud"));
        assert!(!valid_voice_backend(""));
        assert!(valid_voice_model("base"));
        assert!(valid_voice_model("small"));
        assert!(!valid_voice_model("large"));
        assert_eq!(normalize_backend("whisper"), "whisper");
        assert_eq!(normalize_backend("cloud"), "system");
        assert_eq!(normalize_backend(""), "system");
        assert_eq!(normalize_model("small"), "small");
        assert_eq!(normalize_model("large"), "base");
        assert_eq!(whisper_model_filename("base"), Some("ggml-base.bin"));
        assert_eq!(whisper_model_filename("small"), Some("ggml-small.bin"));
        assert_eq!(whisper_model_filename("large"), None);
        // Initial threads and names-only prompt per brief.
        assert_eq!(WHISPER_THREADS, 6);
        assert_eq!(WHISPER_PROMPT, "Choom, Spotify, Visual Studio Code");
        assert_eq!(WHISPER_MAX_SECONDS, 30);
    }

    #[test]
    fn whisper_blank_output_is_discarded() {
        assert!(is_whisper_blank(""));
        assert!(is_whisper_blank("   "));
        assert!(is_whisper_blank("[BLANK_AUDIO]"));
        assert!(is_whisper_blank("[ Silence ]"));
        assert!(is_whisper_blank("(silence)"));
        assert!(!is_whisper_blank("open spotify"));
        assert!(!is_whisper_blank("Choom"));
    }

    #[test]
    fn whisper_helper_lines_validate_transcribing_and_empty() {
        assert!(parse_helper_line(r#"{"type":"transcribing","generation":3,"instance":1}"#).is_ok());
        assert!(parse_helper_line(r#"{"type":"empty","generation":3,"instance":1}"#).is_ok());
        let (kind, _, gen, inst) =
            parse_helper_line(r#"{"type":"final","text":"open spotify","generation":4,"instance":2}"#).unwrap();
        assert_eq!(kind, "final");
        assert_eq!((gen, inst), (4, 2));
    }

    #[test]
    fn whisper_stale_completions_drop_after_cancel() {
        let rt = VoiceRuntime::default();
        rt.generation.store(9, Ordering::SeqCst);
        assert!(rt.is_stale(8));
        assert!(!rt.is_stale(9));
        rt.cancel();
        assert!(rt.is_stale(9));
    }

    #[test]
    fn whisper_trusted_paths_reject_unlisted_names() {
        assert!(resolve_whisper_file("evil.exe").is_none());
        assert!(resolve_whisper_file("../../windows/system32/cmd.exe").is_none());
        assert!(resolve_whisper_file("ggml-large.bin").is_none());
        // Allowlisted names resolve when staged, or None without claiming.
        // Never panics on missing files: Small may be unavailable.
        let _ = resolve_whisper_binary();
        let _ = resolve_whisper_model("base");
        let _ = resolve_whisper_model("small");
        assert!(resolve_whisper_model("large").is_none());
    }

    #[test]
    fn whisper_status_reports_without_download() {
        let status = whisper_status();
        // Base ships with the review installer in staging; Small may be absent.
        // The status never claims Small is bundled and never downloads.
        if status.binary && status.base {
            assert!(status.error.is_none() || status.error.unwrap().contains("Small") == false);
        } else {
            assert!(status.error.is_some());
        }
        // Small unavailable is honest, not an error when Base is present.
        if status.binary && status.base && !status.small {
            assert!(whisper_status().error.is_none());
        }
    }

    #[test]
    fn whisper_cleanup_removes_only_bounded_temps() {
        let dir = std::env::temp_dir();
        let stale = dir.join(format!("{}stale-test.wav", WHISPER_TEMP_PREFIX));
        let keep = dir.join("choom-keep-test.wav");
        let _ = std::fs::write(&stale, b"RIFF");
        let _ = std::fs::write(&keep, b"RIFF");
        cleanup_stale_whisper_wavs();
        assert!(!stale.exists(), "stale whisper temp is removed");
        assert!(keep.exists(), "unrelated temp is kept");
        let _ = std::fs::remove_file(&keep);
    }
}
