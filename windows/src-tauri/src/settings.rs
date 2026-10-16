// Preferences, stored as plain JSON in settings.json under platform::config_dir().
// No secret ever lands here — API keys live in the OS keychain (see secrets.rs).

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, PoisonError};

/// A field the file lacks takes its value from `Default`, so a settings.json
/// written by an older build still loads, whatever has been added since.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub sound_enabled: bool,
    pub sound_volume: f64,
    pub auto_close_interval: f64,
    /// Hovering the island opens it all the way, and it folds again shortly
    /// after the pointer leaves (the Mac's "Open on hover"). Off by default.
    pub open_on_hover: bool,
    pub absence_interval: f64,
    pub active_integrations: Vec<String>,
    /// The always-on workspace pill (src/core/pills.ts checks it is one).
    pub main_pill: String,
    /// "primary" = the main display, "cursor" = whichever display the mouse is on.
    pub screen: String,
    pub autostart: bool,
    pub hooks_installed: bool,
    /// Claude model used by the chat. Changeable in the settings window.
    pub model: String,
    /// Show the Claude plan pill (5 h and weekly limits) in the island's header.
    /// Off until the user turns it on, so the header stays as it shipped.
    pub show_plan_in_notch: bool,
    /// Coucou's status line relay is the one in Claude Code's settings.json.
    /// Like `hooks_installed`, the real state wins at launch over what was stored.
    pub plan_relay_installed: bool,
    /// Show the Codex plan pill (5 h / weekly limits from `codex app-server`).
    /// Off by default; nothing is installed for it.
    pub show_codex_plan_in_notch: bool,
    /// Who the chat talks to: Choom's "opencode-agent" (default) or
    /// "opencode-go", "anthropic", a cloud provider of openai_compat.rs
    /// ("openai", "google", "openrouter"), or a model server of local_chat.rs
    /// ("ollama", "lmstudio", "custom"). Picked in the chat view.
    #[serde(default = "default_chat_provider")]
    pub chat_provider: String,
    /// The model picked for each provider other than Anthropic (whose model is
    /// `model`), by provider id.
    pub chat_models: BTreeMap<String, String>,
    /// Addresses of the model servers once connected; empty means not connected.
    pub ollama_url: String,
    pub lmstudio_url: String,
    /// Any other OpenAI-compatible server; its key, if any, is in the keychain.
    pub custom_url: String,
    /// Global shortcuts the user changed, by action id; the others keep their
    /// default (see shortcuts.rs).
    pub shortcuts: crate::shortcuts::Bindings,
    /// Mochi's outfit, picked in the wardrobe: "auto" (dresses for the
    /// season), "none" or an outfit id — the Mac's raw values. The island reads
    /// anything it doesn't know as "auto", so the value is stored as it comes.
    pub mochi_outfit: String,
    /// A colour of the user's own for a pill's Mochi, by pill ID ("#RRGGBB"),
    /// picked in Settings → Active pills. Empty means the catalog's colours.
    /// Kept as it comes, like `mochi_outfit`: src/core/pill-colors.ts reads
    /// whatever is not a colour as "no choice".
    pub pill_colors: BTreeMap<String, String>,
    /// Interface language: "" follows the system, else one of i18n::LANGUAGES
    /// ("fr", "pt-BR", "zh-Hans"…). Kept as it comes, like `mochi_outfit`: a
    /// code this build doesn't know reads as "".
    pub language: String,
    /// Mochi on the desktop: whether he lives there, and his spot. Owned by
    /// the Rust side (desktop.rs) — what a webview sends back is ignored.
    pub desktop_mochi: DesktopMochiPref,
    /// The phone link (phone_link/) is on: a TLS server for the Android app on
    /// the local network. Off until the user turns it on in Settings → Phone;
    /// owned by the Rust side, so what a webview sends back is ignored.
    pub phone_link: bool,
    /// The phone may chat through this computer's API keys (phone_link/chat.rs).
    /// Off until the user turns it on in Settings → Android phone; owned by the
    /// Rust side like `phone_link`, so what a webview sends back is ignored.
    pub phone_chat: bool,
    /// Which models the phone may use, as "provider/model". Empty allows none.
    /// Also owned by the Rust side (phone_link::set_chat_models cleans it).
    pub phone_chat_models: Vec<String>,
    /// The phone may see session details (steps, last line, project folder name, colour). Off until the
    /// user turns it on in Settings → Android phone; owned by the Rust side like `phone_link`.
    pub phone_details: bool,
    /// Let the phone answer the questions Claude Code asks (cap `answers`). Off by default; owned by Rust like the other phone switches.
    pub phone_answers: bool,
    /// Show the files an agent changed on the phone, and their diffs on request (cap `diffs`). Off by default; owned by Rust like the other phone switches.
    pub phone_diffs: bool,
    /// Show the Claude and Codex plan usage on the phone (cap `usage`). Off by default; owned by Rust like the other phone switches.
    pub phone_usage: bool,
    /// The service pills whose cards the phone may see, by pill id (cap `services`). None by default; owned by Rust like the other phone switches.
    pub phone_services: Vec<String>,
    /// Reach the phone through the user's own relay when it is not on this network (phone_link/relay_client.rs).
    /// Off by default; owned by Rust like the other phone switches. The access key, the room and the pairing key live
    /// in the OS keystore, never here.
    pub phone_relay: bool,
    /// The relay's address (`wss://…`), empty until the user enters it. Not a secret. Owned by Rust.
    pub phone_relay_url: String,
    // ── Choom ──
    /// OpenCode Go model used by the chat when the provider is OpenCode Go.
    #[serde(default = "default_opencode_model")]
    pub opencode_model: String,
    /// OpenCode server the agent provider talks to.
    #[serde(default = "default_opencode_server_url")]
    pub opencode_server_url: String,
    /// Whether Choom may start its own `opencode serve` for the agent provider.
    #[serde(default = "default_true")]
    pub opencode_autostart: bool,
    /// "providerID/modelID" for agent turns; empty means OpenCode's default.
    #[serde(default)]
    pub opencode_agent_model: String,
    /// OpenCode executable for the agent provider; empty picks OpenChamber's
    /// bundled v2 when present, else the `opencode` on PATH.
    #[serde(default)]
    pub opencode_binary: String,
    /// Whether the island shows a Music pill for whatever is playing.
    #[serde(default = "default_true")]
    pub now_playing: bool,
    /// Whether the island peeks the song when a track starts.
    #[serde(default = "default_true")]
    pub song_peek: bool,
    /// Whether the music Choom wears its moods while playing.
    #[serde(default = "default_true")]
    pub music_moods: bool,
    /// Width of the invisible wake strip, in logical px (120-600).
    #[serde(default = "default_wake_strip_width")]
    pub wake_strip_width: f64,
    /// How long the cursor must rest on the wake strip before it wakes, in ms.
    #[serde(default = "default_wake_dwell_ms")]
    pub wake_dwell_ms: f64,
    /// Keep the island hidden while a full-screen app is up.
    #[serde(default = "default_true")]
    pub wake_quiet_fullscreen: bool,
    /// Whether the island shows the System utilities card with the job radar.
    #[serde(default = "default_true")]
    pub job_radar: bool,
    /// Whether total CPU and memory are sampled while the island is visible.
    #[serde(default = "default_true")]
    pub pc_vitals: bool,
    /// Whether sustained high CPU or memory may surface one calm warning.
    #[serde(default = "default_true")]
    pub vitals_warnings: bool,
    /// Whether battery state is watched through native power notifications.
    #[serde(default = "default_true")]
    pub battery_monitor: bool,
    /// Whether low battery may surface one calm warning per level.
    #[serde(default = "default_true")]
    pub battery_warnings: bool,
    /// Compact local tools (colour pocket, command bar, routines). Missing in
    /// older files, which read as empty; invalid entries are dropped on load.
    #[serde(default)]
    pub tools: crate::choom::tools::ToolsData,
    /// Voice opt-in. Off by default; persisted as a user choice.
    #[serde(default)]
    pub voice_enabled: bool,
    /// Keyword wake opt-in. Off by default, separate from voice.
    #[serde(default)]
    pub voice_wake_enabled: bool,
    /// Wake phrase for local grammar detection.
    #[serde(default = "default_wake_phrase")]
    pub voice_wake_phrase: String,
    /// End-of-turn silence before a completed utterance submits (ms).
    #[serde(default = "default_endpoint_ms")]
    pub voice_endpoint_ms: u64,
    /// Follow-up window after a turn (ms).
    #[serde(default = "default_followup_ms")]
    pub voice_followup_ms: u64,
    /// Local speech voice name. Empty means the system default.
    #[serde(default)]
    pub voice_speech_voice: String,
    /// Speech rate (-10 to 10).
    #[serde(default)]
    pub voice_speech_rate: i32,
    /// Speech volume (0 to 100).
    #[serde(default = "default_speech_volume")]
    pub voice_speech_volume: u32,
    /// Transcript deck mode pin: auto, a, b or c.
    #[serde(default = "default_voice_mode")]
    pub voice_mode: String,
    /// Transcription backend: "system" (Windows dictation) or "whisper"
    /// (local Whisper). Missing in older files, which read as system so
    /// existing users stay on their chosen backend until explicit selection.
    #[serde(default = "default_voice_backend")]
    pub voice_backend: String,
    /// Whisper model: "base" (bundled, multilingual) or "small" (explicit
    /// local setup, may be unavailable). Default is Base for the new backend.
    #[serde(default = "default_voice_model")]
    pub voice_model: String,
    /// Explicit opt-in local memory. Off by default.
    #[serde(default)]
    pub voice_memory_enabled: bool,
    /// Endpointed utterances submit on their own. Off means manual Send only.
    /// On by default; typing in the edit field always stops one endpoint.
    #[serde(default = "default_true")]
    pub voice_auto_submit: bool,
    /// Jev routing opt-in. Off by default, so no network call happens until
    /// the user explicitly enables it and has a credential.
    #[serde(default)]
    pub jev_enabled: bool,
    /// Jev routing mode: off, shadow or assisted. Older files read as shadow,
    /// but the network stays off until jev_enabled is explicitly on.
    #[serde(default = "default_jev_mode")]
    pub jev_mode: String,
    /// Abstention threshold for the classifier (0.75 to 0.95).
    #[serde(default = "default_jev_threshold")]
    pub jev_threshold: f64,
    /// Bounded classifier deadline in ms (500 to 8000).
    #[serde(default = "default_jev_deadline_ms")]
    pub jev_deadline_ms: u64,
    /// Which engine classifies a voice request: "jev" (online) or "laya"
    /// (local). Missing in every older file, so those read as jev and every
    /// existing Jev mode and default behaves exactly as before.
    #[serde(default = "default_decision_engine")]
    pub decision_engine: String,
    /// Mirror of decision_engine == "laya", kept so a file written by an
    /// earlier build still loads. normalize_laya makes the two agree, so the
    /// single selector is always decision_engine.
    #[serde(default)]
    pub laya_enabled: bool,
    /// Explicit local Laya interpreter path. Never a PATH lookup and never
    /// downloaded: the user names the interpreter of an already staged
    /// offline runtime.
    #[serde(default)]
    pub laya_runtime_path: String,
    /// Explicit local Laya model directory.
    #[serde(default)]
    pub laya_model_path: String,
    /// Explicit local Laya model manifest file, which the worker verifies
    /// (sizes and SHA-256) before it loads anything.
    #[serde(default)]
    pub laya_manifest_path: String,
    /// Provisional abstention threshold for Laya (0.75 to 0.95). Separate from
    /// the Jev threshold on purpose: the two engines are not calibrated
    /// against each other.
    #[serde(default = "default_laya_threshold")]
    pub laya_threshold: f64,
    /// Windows notification access opt-in. Off by default: the listener is
    /// only ever requested from an explicit settings click.
    #[serde(default)]
    pub notifications_enabled: bool,
    /// App identities (package family name or display name, case-insensitive)
    /// allowed to take over the pill. Empty by default: no VIP apps.
    #[serde(default)]
    pub notifications_vip_apps: Vec<String>,
    /// Hide notification text in the island and the settings list. Off by
    /// default; bodies then read as "Private notification".
    #[serde(default)]
    pub notifications_private: bool,
    /// Flow opt-in. Off by default: no typed action grammar or native note or
    /// browser work happens until the user explicitly turns Flow on.
    #[serde(default)]
    pub flow_enabled: bool,
    /// User-selected notes folder for Flow notes. Empty until picked.
    #[serde(default)]
    pub flow_notes_folder: String,
    /// Configured browser executable for Flow link and search dispatch. Empty
    /// uses the OS default handler.
    #[serde(default)]
    pub flow_browser: String,
    /// Search engine template. Must hold a {q} placeholder.
    #[serde(default = "default_flow_search_engine")]
    pub flow_search_engine: String,
    /// Configured editor that opens an owned Flow note. Empty keeps note.open
    /// unavailable instead of guessing a handler.
    #[serde(default)]
    pub flow_editor: String,
}

fn default_flow_search_engine() -> String {
    "https://duckduckgo.com/?q={q}".to_string()
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DesktopMochiPref {
    /// He was on the desktop when the app quit: he flies back out at launch.
    pub on_desktop: bool,
    /// Top-left corner of his window where the user last left him.
    pub spot: Option<DesktopSpot>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DesktopSpot {
    pub x: f64,
    pub y: f64,
    /// What x and y are measured in (`DesktopMode::space`).
    pub space: String,
}

fn default_model() -> String {
    crate::claude::DEFAULT_MODEL.to_string()
}

fn default_chat_provider() -> String {
    "opencode-agent".to_string()
}

fn default_opencode_model() -> String {
    crate::choom::opencode_chat::DEFAULT_MODEL.to_string()
}

fn default_opencode_server_url() -> String {
    "http://127.0.0.1:4747".to_string()
}

fn default_wake_strip_width() -> f64 {
    crate::island::STRIP_W
}

fn default_wake_dwell_ms() -> f64 {
    150.0
}

fn default_true() -> bool {
    true
}

fn default_wake_phrase() -> String {
    "Choom".to_string()
}

fn default_endpoint_ms() -> u64 {
    900
}

fn default_followup_ms() -> u64 {
    8000
}

fn default_speech_volume() -> u32 {
    100
}

fn default_voice_mode() -> String {
    "auto".to_string()
}

fn default_voice_backend() -> String {
    "system".to_string()
}

fn default_voice_model() -> String {
    "base".to_string()
}

fn default_jev_mode() -> String {
    "shadow".to_string()
}

fn default_jev_threshold() -> f64 {
    0.75
}

fn default_jev_deadline_ms() -> u64 {
    2500
}

fn default_laya_threshold() -> f64 {
    crate::choom::laya::LAYA_THRESHOLD_DEFAULT
}

fn default_decision_engine() -> String {
    crate::choom::laya::ENGINE_JEV.to_string()
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            sound_enabled: true,
            sound_volume: 0.12,
            auto_close_interval: 15.0,
            open_on_hover: false,
            absence_interval: 180.0,
            active_integrations: vec![
                "integration_resend".into(),
                "integration_n8n".into(),
                "integration_vercel".into(),
                "integration_github".into(),
            ],
            main_pill: "integration_claude".into(),
            screen: "primary".into(),
            autostart: false,
            hooks_installed: false,
            model: default_model(),
            chat_provider: default_chat_provider(),
            opencode_model: default_opencode_model(),
            opencode_server_url: default_opencode_server_url(),
            opencode_autostart: true,
            opencode_agent_model: String::new(),
            opencode_binary: String::new(),
            now_playing: true,
            song_peek: true,
            music_moods: true,
            wake_strip_width: default_wake_strip_width(),
            wake_dwell_ms: default_wake_dwell_ms(),
            wake_quiet_fullscreen: true,
            job_radar: true,
            pc_vitals: true,
            vitals_warnings: true,
            battery_monitor: true,
            battery_warnings: true,
            tools: crate::choom::tools::ToolsData::default(),
            voice_enabled: false,
            voice_wake_enabled: false,
            voice_wake_phrase: default_wake_phrase(),
            voice_endpoint_ms: default_endpoint_ms(),
            voice_followup_ms: default_followup_ms(),
            voice_speech_voice: String::new(),
            voice_speech_rate: 0,
            voice_speech_volume: default_speech_volume(),
            voice_mode: default_voice_mode(),
            voice_backend: default_voice_backend(),
            voice_model: default_voice_model(),
            voice_memory_enabled: false,
            voice_auto_submit: true,
            jev_enabled: false,
            jev_mode: default_jev_mode(),
            jev_threshold: default_jev_threshold(),
            jev_deadline_ms: default_jev_deadline_ms(),
            decision_engine: default_decision_engine(),
            laya_enabled: false,
            laya_runtime_path: String::new(),
            laya_model_path: String::new(),
            laya_manifest_path: String::new(),
            laya_threshold: default_laya_threshold(),
            notifications_enabled: false,
            notifications_vip_apps: Vec::new(),
            notifications_private: false,
            show_plan_in_notch: false,
            plan_relay_installed: false,
            show_codex_plan_in_notch: false,
            chat_models: BTreeMap::new(),
            ollama_url: String::new(),
            lmstudio_url: String::new(),
            custom_url: String::new(),
            shortcuts: Default::default(),
            // Choom: no outfit until the user picks one (upstream: "auto", seasonal).
            mochi_outfit: "none".into(),
            pill_colors: BTreeMap::new(),
            language: String::new(),
            desktop_mochi: DesktopMochiPref::default(),
            phone_link: false,
            phone_chat: false,
            phone_chat_models: Vec::new(),
            phone_details: false,
            phone_answers: false,
            phone_diffs: false,
            phone_usage: false,
            phone_services: Vec::new(),
            phone_relay: false,
            phone_relay_url: String::new(),
            flow_enabled: false,
            flow_notes_folder: String::new(),
            flow_browser: String::new(),
            flow_search_engine: default_flow_search_engine(),
            flow_editor: String::new(),
        }
    }
}

pub use crate::platform::{config_dir, local_dir};

/// Laya values from a hand-edited file are trimmed and the threshold is
/// bounded, never trusted as-is. The engine selector is the one source of
/// truth: an unknown value falls back to the online Jev engine, so a corrupt
/// or future file can never silently turn on a local worker. Called by load(),
/// and by the tests that prove the bounds survive a hostile file.
pub fn normalize_laya(settings: &mut Settings) {
    settings.decision_engine =
        crate::choom::laya::normalize_engine(&settings.decision_engine).to_string();
    settings.laya_enabled = settings.decision_engine == crate::choom::laya::ENGINE_LAYA;
    settings.laya_runtime_path = settings.laya_runtime_path.trim().to_string();
    settings.laya_model_path = settings.laya_model_path.trim().to_string();
    settings.laya_manifest_path = settings.laya_manifest_path.trim().to_string();
    settings.laya_threshold = crate::choom::laya::clamp_threshold(settings.laya_threshold);
}

pub fn hook_exe_path() -> PathBuf {
    local_dir().join("bin").join(crate::platform::HOOK_EXE)
}

fn settings_path() -> PathBuf {
    config_dir().join("settings.json")
}

pub fn load() -> Settings {
    // Upstream's loader keeps a corrupt file aside instead of silently using
    // the defaults; Choom's own fields are then checked like any hand edit.
    let mut settings = load_from(&settings_path());
    // Hand-edited or older tools data is validated, never trusted as-is.
    settings.tools = crate::choom::tools::sanitize_data(settings.tools);
    settings.jev_mode = crate::choom::jev::normalize_mode(&settings.jev_mode);
    settings.jev_threshold = crate::choom::jev::clamp_threshold(settings.jev_threshold);
    settings.jev_deadline_ms = crate::choom::jev::clamp_deadline_ms(settings.jev_deadline_ms);
    normalize_laya(&mut settings);
    settings.voice_backend = crate::choom::voice::normalize_backend(&settings.voice_backend);
    settings.voice_model = crate::choom::voice::normalize_model(&settings.voice_model);
    settings.notifications_vip_apps = sanitize_vip_apps(settings.notifications_vip_apps);
    // Flow settings from a hand-edited file are trimmed, never trusted as-is.
    settings.flow_notes_folder = settings.flow_notes_folder.trim().to_string();
    settings.flow_browser = settings.flow_browser.trim().to_string();
    settings.flow_editor = settings.flow_editor.trim().to_string();
    if !settings.flow_search_engine.contains("{q}") {
        settings.flow_search_engine = default_flow_search_engine();
    }
    settings
}

/// VIP app identifiers from a hand-edited settings.json are trimmed,
/// de-duplicated case-insensitively and bounded, never trusted as-is.
pub fn sanitize_vip_apps(apps: Vec<String>) -> Vec<String> {
    const MAX_VIP: usize = 24;
    const MAX_LEN: usize = 80;
    let mut out: Vec<String> = Vec::new();
    for raw in apps {
        let app = raw.trim();
        if app.is_empty() || app.chars().count() > MAX_LEN {
            continue;
        }
        let lower = app.to_lowercase();
        if out.iter().any(|kept: &String| kept.to_lowercase() == lower) {
            continue;
        }
        if out.len() >= MAX_VIP {
            break;
        }
        out.push(app.to_string());
    }
    out
}

pub fn save(settings: &Settings) -> std::io::Result<()> {
    let dir = config_dir();
    crate::platform::ensure_private_dir(&dir)?;
    save_to(&settings_path(), settings)
}

/// How many copies `set_aside` can make within one second before it gives up.
const MAX_COPIES_PER_SECOND: u32 = 100;

/// settings.json files that are there but whose contents never made it into
/// memory: they could not be read, or could not be used and could not be copied
/// aside either. What is in memory for them is the defaults, so the next save
/// must not quietly replace them — see `keep_what_was_not_loaded`.
static NOT_LOADED: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());

fn not_loaded() -> MutexGuard<'static, Vec<PathBuf>> {
    NOT_LOADED.lock().unwrap_or_else(PoisonError::into_inner)
}

/// One line in coucou.log. Tests must never write to the real one.
fn note(message: String) {
    #[cfg(not(test))]
    crate::log::line(message);
    #[cfg(test)]
    eprintln!("{message}");
}

/// The settings held in the bytes of a settings.json, or `None` when there is
/// nothing usable in them. Split from `load_from` so it can be tested without a
/// file.
fn parse(bytes: &[u8]) -> Option<Settings> {
    // PowerShell 5 and Notepad write a UTF-8 BOM, and serde_json refuses it.
    let text = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    if text.iter().all(u8::is_ascii_whitespace) {
        return Some(Settings::default());
    }
    let Value::Object(fields) = serde_json::from_slice(text).ok()? else {
        return None;
    };
    let whole = serde_json::from_value(Value::Object(fields.clone()));
    Some(whole.unwrap_or_else(|_| salvage(fields)))
}

/// Settings from the fields of a settings.json that does not load as a whole.
/// Each field is taken on its own: one that is not the kind of value expected
/// falls back to its default instead of costing every other setting.
fn salvage(fields: Map<String, Value>) -> Settings {
    let Ok(Value::Object(mut kept)) = serde_json::to_value(Settings::default()) else {
        return Settings::default();
    };
    for (key, value) in fields {
        let mut candidate = kept.clone();
        candidate.insert(key.clone(), value);
        if serde_json::from_value::<Settings>(Value::Object(candidate.clone())).is_ok() {
            kept = candidate;
        } else {
            note(unusable_field(&key));
        }
    }
    serde_json::from_value(Value::Object(kept)).unwrap_or_default()
}

/// The log line for a field `salvage` had to drop. The name comes straight from
/// the file, so it is written escaped: a line break in it must not be able to
/// start what looks like another line of coucou.log.
fn unusable_field(key: &str) -> String {
    format!("settings.json: {key:?} is not usable — its default is used instead")
}

/// `load`, for the file at `path`: tests point it at a temporary directory.
///
/// Only a file that is not there means "start from the defaults" with nothing
/// more to do. One that cannot be read, or cannot be used, also gives the
/// defaults, but it still holds what the user had: it is kept, not written over.
fn load_from(path: &Path) -> Settings {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == ErrorKind::NotFound => return Settings::default(),
        Err(err) => {
            note(format!("can't read {}: {err} — using the defaults", path.display()));
            protect(path);
            return Settings::default();
        }
    };
    parse(&bytes).unwrap_or_else(|| {
        match set_aside(path, "corrupt", &bytes) {
            Ok(copy) => note(format!(
                "{} is not usable — kept as {}, using the defaults",
                path.display(),
                copy.display()
            )),
            Err(err) => {
                note(format!("{} is not usable and could not be copied: {err}", path.display()));
                protect(path);
            }
        }
        Settings::default()
    })
}

/// Marks `path` as holding something the next save must not write over.
fn protect(path: &Path) {
    let mut pending = not_loaded();
    if !pending.iter().any(|p| p == path) {
        pending.push(path.to_path_buf());
    }
}

/// Before the first save over a file `load_from` could not load: copies it
/// aside if it can be read by now, and refuses the save if it still cannot.
fn keep_what_was_not_loaded(path: &Path) -> std::io::Result<()> {
    let mut pending = not_loaded();
    let Some(index) = pending.iter().position(|p| p == path) else {
        return Ok(());
    };
    match std::fs::read(path) {
        Ok(bytes) => {
            let copy = set_aside(path, "unread", &bytes)?;
            note(format!("{} was never loaded — kept as {}", path.display(), copy.display()));
        }
        // Gone since: nothing is left to protect.
        Err(err) if err.kind() == ErrorKind::NotFound => {}
        Err(err) => {
            return Err(std::io::Error::new(
                err.kind(),
                format!("{} still can't be read, so it is left as it is: {err}", path.display()),
            ));
        }
    }
    pending.swap_remove(index);
    Ok(())
}

/// Keeps `bytes`, the contents of `path`, in a file beside it named after it
/// with `.<kind>-YYYYMMDD-HHMMSS` appended. Contents an earlier copy of that
/// kind already holds are not copied again: a file nobody repairs would
/// otherwise leave one more copy behind at every launch.
fn set_aside(path: &Path, kind: &str, bytes: &[u8]) -> std::io::Result<PathBuf> {
    if let Some(copy) = same_copy(path, kind, bytes) {
        return Ok(copy);
    }
    let t = crate::platform::local_time();
    let stamp = format!(
        "{:04}{:02}{:02}-{:02}{:02}{:02}",
        t.year, t.month, t.day, t.hour, t.minute, t.second
    );
    set_aside_as(path, kind, &stamp, bytes, write_whole)
}

/// The copy of `path` of this `kind` that already holds exactly `bytes`.
fn same_copy(path: &Path, kind: &str, bytes: &[u8]) -> Option<PathBuf> {
    let prefix = format!("{}.{kind}-", path.file_name()?.to_string_lossy());
    std::fs::read_dir(path.parent()?)
        .ok()?
        .filter_map(Result::ok)
        .filter(|entry| entry.file_name().to_string_lossy().starts_with(&prefix))
        .filter(|entry| entry.metadata().is_ok_and(|m| m.len() == bytes.len() as u64))
        .map(|entry| entry.path())
        .find(|copy| std::fs::read(copy).is_ok_and(|held| held == bytes))
}

/// `set_aside` for a given time stamp, writing through `write`. `-1`, `-2`… are
/// appended while the name is taken, so a copy that is already there is never
/// written over; and a copy that could not be written whole is removed, never
/// left looking like a faithful one.
fn set_aside_as(
    path: &Path,
    kind: &str,
    stamp: &str,
    bytes: &[u8],
    write: fn(&mut std::fs::File, &[u8]) -> std::io::Result<()>,
) -> std::io::Result<PathBuf> {
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    let base = format!("{name}.{kind}-{stamp}");
    for attempt in 0..MAX_COPIES_PER_SECOND {
        let copy = match attempt {
            0 => path.with_file_name(&base),
            n => path.with_file_name(format!("{base}-{n}")),
        };
        match std::fs::OpenOptions::new().write(true).create_new(true).open(&copy) {
            Ok(mut file) => {
                let written = write(&mut file, bytes);
                drop(file);
                if written.is_err() {
                    let _ = std::fs::remove_file(&copy);
                }
                return written.map(|()| copy);
            }
            Err(err) if err.kind() == ErrorKind::AlreadyExists => continue,
            Err(err) => return Err(err),
        }
    }
    Err(std::io::Error::new(ErrorKind::AlreadyExists, format!("too many copies named {base}")))
}

/// Writes `bytes` to `file` and waits until they are on the disk.
fn write_whole(file: &mut std::fs::File, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    file.write_all(bytes)?;
    file.sync_all()
}

/// `save`, for the file at `path`, whose directory already exists.
fn save_to(path: &Path, settings: &Settings) -> std::io::Result<()> {
    keep_what_was_not_loaded(path)?;
    let json = serde_json::to_vec_pretty(settings)
        .map_err(|e| std::io::Error::new(ErrorKind::InvalidData, e))?;

    // A dotfiles setup can make settings.json a symlink: write to the file it
    // points at, so the link survives the rename below.
    #[cfg(unix)]
    let resolved = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    #[cfg(unix)]
    let path = resolved.as_path();

    // Write beside the target and rename over it: a crash, a full disk or a
    // power cut leaves the previous settings.json intact rather than half a file.
    let temp = path.with_extension(format!("json.coucou-{}", std::process::id()));
    let written = std::fs::File::create(&temp)
        .and_then(|mut file| write_whole(&mut file, &json))
        .and_then(|()| std::fs::rename(&temp, path));
    if written.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    written
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    /// A settings.json in which no value is the default one.
    // Two #: the colours in it are written "#RRGGBB".
    const CUSTOM: &str = r##"{
  "soundEnabled": false,
  "soundVolume": 0.5,
  "autoCloseInterval": 30.0,
  "openOnHover": true,
  "absenceInterval": 60.0,
  "activeIntegrations": ["integration_notion"],
  "mainPill": "agent_cursor",
  "screen": "cursor",
  "autostart": true,
  "hooksInstalled": true,
  "model": "some-model",
  "showPlanInNotch": true,
  "planRelayInstalled": true,
  "showCodexPlanInNotch": true,
  "chatProvider": "ollama",
  "chatModels": { "ollama": "llama3.2", "openai": "gpt-x" },
  "ollamaUrl": "http://127.0.0.1:11434",
  "lmstudioUrl": "http://127.0.0.1:1234",
  "customUrl": "https://llm.example.com",
  "shortcuts": { "openChat": { "keys": "Ctrl+Shift+K", "enabled": false } },
  "mochiOutfit": "witchHat",
  "pillColors": { "integration_claude": "#2DD4BF" },
  "language": "pt-BR",
  "desktopMochi": { "onDesktop": true, "spot": { "x": 1500.5, "y": -300.0, "space": "screen" } },
  "phoneLink": true,
  "phoneChat": true,
  "phoneChatModels": ["openai/gpt-x"],
  "phoneDetails": true,
  "phoneAnswers": true,
  "phoneDiffs": true,
  "phoneUsage": true,
  "phoneServices": ["integration_stripe"],
  "phoneRelay": true,
  "phoneRelayUrl": "wss://relay.example.workers.dev",
  "opencodeModel": "minimax-m3",
  "opencodeServerUrl": "http://127.0.0.1:4999",
  "opencodeAutostart": false,
  "opencodeAgentModel": "opencode-go/qwen3.8-flash",
  "opencodeBinary": "C:\\tools\\opencode.exe",
  "nowPlaying": false,
  "songPeek": false,
  "musicMoods": false,
  "wakeStripWidth": 360.0,
  "wakeDwellMs": 300.0,
  "wakeQuietFullscreen": false,
  "jobRadar": false,
  "pcVitals": false,
  "vitalsWarnings": false,
  "batteryMonitor": false,
  "batteryWarnings": false,
  "tools": { "version": 1, "colours": [], "shortcuts": [], "routines": [] },
  "voiceEnabled": true,
  "voiceWakeEnabled": true,
  "voiceWakePhrase": "Hey Choom",
  "voiceEndpointMs": 1200,
  "voiceFollowupMs": 5000,
  "voiceSpeechVoice": "Zira",
  "voiceSpeechRate": 2,
  "voiceSpeechVolume": 80,
  "voiceMode": "b",
  "voiceBackend": "whisper",
  "voiceModel": "small",
  "voiceMemoryEnabled": true,
  "voiceAutoSubmit": false,
  "jevEnabled": true,
  "jevMode": "assisted",
  "jevThreshold": 0.8,
  "jevDeadlineMs": 4000,
  "notificationsEnabled": true,
  "notificationsVipApps": ["WhatsApp"],
  "notificationsPrivate": true,
  "flowEnabled": true,
  "flowNotesFolder": "C:/Notes",
  "flowBrowser": "",
  "flowSearchEngine": "https://duckduckgo.com/?q={q}",
  "flowEditor": "",
  "decisionEngine": "jev",
  "layaEnabled": false,
  "layaRuntimePath": "",
  "layaModelPath": "",
  "layaManifestPath": "",
  "layaThreshold": 0.85
}"##;

    fn custom() -> Value {
        serde_json::from_str(CUSTOM).unwrap()
    }

    /// `CUSTOM` with one key replaced, or removed when `value` is `None`.
    fn custom_with(key: &str, value: Option<Value>) -> Vec<u8> {
        let mut object = custom().as_object().unwrap().clone();
        match value {
            Some(value) => object.insert(key.to_string(), value),
            None => object.remove(key),
        };
        serde_json::to_vec(&object).unwrap()
    }

    /// Settings compare through their JSON: the struct has no `PartialEq`.
    fn shown(settings: &Settings) -> Value {
        serde_json::to_value(settings).unwrap()
    }

    fn defaults() -> Value {
        shown(&Settings::default())
    }

    /// A fresh directory of our own, and the settings.json it will hold.
    fn scratch(name: &str) -> (PathBuf, PathBuf) {
        let dir = std::env::temp_dir()
            .join(format!("coucou-settings-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("settings.json");
        (dir, file)
    }

    fn names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        names.sort();
        names
    }

    /// What was set aside under `settings.json.<kind>-…`.
    fn kept(dir: &Path, kind: &str) -> Vec<Vec<u8>> {
        let prefix = format!("settings.json.{kind}-");
        names(dir)
            .iter()
            .filter(|name| name.starts_with(&prefix))
            .map(|name| std::fs::read(dir.join(name)).unwrap())
            .collect()
    }

    // ── Reading ───────────────────────────────────────────────────────────────

    #[test]
    fn a_missing_file_is_the_defaults_and_is_not_created() {
        let (dir, file) = scratch("missing");
        assert_eq!(shown(&load_from(&file)), defaults());
        assert!(names(&dir).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_empty_file_is_the_defaults_and_nothing_is_set_aside() {
        let (dir, file) = scratch("empty");
        for nothing in [&b""[..], &b" \r\n\t "[..]] {
            std::fs::write(&file, nothing).unwrap();
            assert_eq!(shown(&load_from(&file)), defaults());
        }
        assert_eq!(names(&dir), ["settings.json"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn unknown_fields_are_ignored_and_the_known_ones_kept() {
        let bytes = custom_with("somethingFromALaterVersion", Some(json!({ "a": [1, 2] })));
        assert_eq!(shown(&parse(&bytes).unwrap()), custom());
    }

    #[test]
    fn a_file_from_before_the_model_setting_keeps_everything_else() {
        let loaded = shown(&parse(&custom_with("model", None)).unwrap());
        let mut expected = custom();
        expected["model"] = json!(crate::claude::DEFAULT_MODEL);
        assert_eq!(loaded, expected);
    }

    #[test]
    fn a_file_from_before_the_wardrobe_leaves_choom_undressed() {
        let loaded = parse(&custom_with("mochiOutfit", None)).unwrap();
        assert_eq!(loaded.mochi_outfit, "none");
        assert_eq!(loaded.model, "some-model");
        assert!(!loaded.sound_enabled);
    }

    #[test]
    fn a_file_from_before_the_desktop_mochi_keeps_him_in_the_island() {
        let loaded = parse(&custom_with("desktopMochi", None)).unwrap();
        assert_eq!(loaded.desktop_mochi, DesktopMochiPref::default());
        assert!(!loaded.desktop_mochi.on_desktop);
        assert_eq!(loaded.mochi_outfit, "witchHat");
    }

    #[test]
    fn a_file_from_before_the_phone_link_keeps_it_off() {
        // The link opens a port on the local network: it is never on by default,
        // and an older file must not be read as consent.
        assert!(!Settings::default().phone_link);
        let loaded = parse(&custom_with("phoneLink", None)).unwrap();
        assert!(!loaded.phone_link);
        assert_eq!(loaded.mochi_outfit, "witchHat");
        assert!(parse(&custom_with("phoneLink", Some(serde_json::json!(true)))).unwrap().phone_link);

        // A value of the wrong type does not switch it on either, and costs nothing else.
        let (dir, file) = scratch("phone-link");
        std::fs::write(&file, custom_with("phoneLink", Some(serde_json::json!("yes")))).unwrap();
        let odd = load_from(&file);
        assert!(!odd.phone_link);
        assert_eq!(odd.mochi_outfit, "witchHat");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_file_from_before_phone_chat_keeps_it_off_and_empty() {
        // Chat spends the user's API credit: never on by default, and an older file is not consent.
        let d = Settings::default();
        assert!(!d.phone_chat);
        assert!(d.phone_chat_models.is_empty());
        let loaded = parse(&custom_with("phoneChat", None)).unwrap();
        assert!(!loaded.phone_chat);
        assert!(parse(&custom_with("phoneChat", Some(serde_json::json!(true)))).unwrap().phone_chat);
        let odd = parse(&custom_with("phoneChat", Some(serde_json::json!("yes")))).unwrap();
        assert!(!odd.phone_chat, "a wrong type does not switch it on");
        assert_eq!(odd.mochi_outfit, "witchHat");
        let models = parse(&custom_with("phoneChatModels", Some(serde_json::json!(["openai/gpt-x"])))).unwrap();
        assert_eq!(models.phone_chat_models, vec!["openai/gpt-x".to_string()]);
        let bad = parse(&custom_with("phoneChatModels", Some(serde_json::json!("openai/gpt-x")))).unwrap();
        assert!(bad.phone_chat_models.is_empty());
    }

    #[test]
    fn a_file_from_before_phone_answers_keeps_it_off() {
        // Answering for the agent from the phone is never on by default; an older file is not consent.
        assert!(!Settings::default().phone_answers);
        assert!(!parse(&custom_with("phoneAnswers", None)).unwrap().phone_answers);
        assert!(parse(&custom_with("phoneAnswers", Some(serde_json::json!(true)))).unwrap().phone_answers);
        assert!(!parse(&custom_with("phoneAnswers", Some(serde_json::json!("yes")))).unwrap().phone_answers, "a wrong type does not switch it on");
    }

    #[test]
    fn a_file_from_before_phone_diffs_keeps_it_off() {
        // Showing what an agent changed on the phone is never on by default; an older file is not consent.
        assert!(!Settings::default().phone_diffs);
        assert!(!parse(&custom_with("phoneDiffs", None)).unwrap().phone_diffs);
        assert!(parse(&custom_with("phoneDiffs", Some(serde_json::json!(true)))).unwrap().phone_diffs);
        assert!(!parse(&custom_with("phoneDiffs", Some(serde_json::json!("yes")))).unwrap().phone_diffs, "a wrong type does not switch it on");
    }

    #[test]
    fn a_file_from_before_phone_usage_keeps_it_off() {
        assert!(!Settings::default().phone_usage);
        assert!(!parse(&custom_with("phoneUsage", None)).unwrap().phone_usage);
        assert!(parse(&custom_with("phoneUsage", Some(serde_json::json!(true)))).unwrap().phone_usage);
        assert!(!parse(&custom_with("phoneUsage", Some(serde_json::json!("yes")))).unwrap().phone_usage, "a wrong type does not switch it on");
    }

    #[test]
    fn a_file_from_before_the_relay_keeps_it_off_and_empty() {
        assert!(!Settings::default().phone_relay);
        assert!(Settings::default().phone_relay_url.is_empty());
        let old = parse(&custom_with("phoneRelay", None)).unwrap();
        assert!(!old.phone_relay);
        assert!(parse(&custom_with("phoneRelay", Some(serde_json::json!(true)))).unwrap().phone_relay);
        assert!(!parse(&custom_with("phoneRelay", Some(serde_json::json!("yes")))).unwrap().phone_relay, "a wrong type does not switch it on");
        assert!(parse(&custom_with("phoneRelayUrl", Some(serde_json::json!(5)))).unwrap().phone_relay_url.is_empty());
    }

    #[test]
    fn a_file_from_before_phone_services_shows_none() {
        // Showing a service on the phone is never on by default; an older file is not consent.
        assert!(Settings::default().phone_services.is_empty());
        assert!(parse(&custom_with("phoneServices", None)).unwrap().phone_services.is_empty());
        assert_eq!(parse(&custom_with("phoneServices", Some(serde_json::json!(["integration_stripe"])))).unwrap().phone_services, vec!["integration_stripe".to_string()]);
        assert!(parse(&custom_with("phoneServices", Some(serde_json::json!("integration_stripe")))).unwrap().phone_services.is_empty(), "a wrong type shows none");
    }

    #[test]
    fn a_file_from_before_phone_details_keeps_them_off() {
        // Details can include commands and folder names: never on by default, an older file is not consent.
        assert!(!Settings::default().phone_details);
        assert!(!parse(&custom_with("phoneDetails", None)).unwrap().phone_details);
        assert!(parse(&custom_with("phoneDetails", Some(serde_json::json!(true)))).unwrap().phone_details);
        let odd = parse(&custom_with("phoneDetails", Some(serde_json::json!("yes")))).unwrap();
        assert!(!odd.phone_details, "a wrong type does not switch it on");
        assert_eq!(odd.mochi_outfit, "witchHat");
    }

    #[test]
    fn a_half_written_desktop_spot_costs_only_the_spot() {
        let loaded = parse(&custom_with(
            "desktopMochi",
            Some(json!({ "onDesktop": true, "spot": { "x": "left" } })),
        ))
        .unwrap();
        // The whole field falls back, and nothing else does.
        assert_eq!(loaded.desktop_mochi, DesktopMochiPref::default());
        assert_eq!(loaded.model, "some-model");

        let loaded = parse(&custom_with("desktopMochi", Some(json!({ "onDesktop": true })))).unwrap();
        assert!(loaded.desktop_mochi.on_desktop);
        assert_eq!(loaded.desktop_mochi.spot, None);
    }

    #[test]
    fn a_file_from_before_the_colours_paints_every_pill_as_the_catalog_says() {
        let loaded = parse(&custom_with("pillColors", None)).unwrap();
        assert!(loaded.pill_colors.is_empty());
        assert_eq!(loaded.mochi_outfit, "witchHat");
    }

    #[test]
    fn pill_colours_are_kept_as_written_and_cost_nothing_else_when_unusable() {
        // A pill a newer build added keeps its colour through a save by this one.
        let loaded = parse(&custom_with("pillColors", Some(json!({ "agent_new": "#abcdef" })))).unwrap();
        assert_eq!(loaded.pill_colors.get("agent_new").map(String::as_str), Some("#abcdef"));
        // Not a map of strings: the colours fall back, and nothing else does.
        let loaded = parse(&custom_with("pillColors", Some(json!(["#2DD4BF"])))).unwrap();
        assert!(loaded.pill_colors.is_empty());
        assert_eq!(loaded.model, "some-model");
    }

    #[test]
    fn an_outfit_this_build_does_not_know_is_kept_as_written() {
        // A newer build may add outfits: the island shows "auto" for it, but
        // the choice must survive a save made by this one.
        let loaded = parse(&custom_with("mochiOutfit", Some(json!("topHat")))).unwrap();
        assert_eq!(loaded.mochi_outfit, "topHat");
        // The language too: "" (follow the system) when absent, as it comes otherwise.
        assert_eq!(parse(&custom_with("language", None)).unwrap().language, "");
        assert_eq!(parse(&custom_with("language", Some(json!("xx")))).unwrap().language, "xx");
    }

    #[test]
    fn a_missing_field_takes_its_default_and_the_rest_are_kept() {
        for key in custom().as_object().unwrap().keys() {
            let loaded = parse(&custom_with(key, None))
                .unwrap_or_else(|| panic!("a file without {key} was thrown away"));
            let mut expected = custom();
            expected[key] = defaults()[key].clone();
            assert_eq!(shown(&loaded), expected, "without {key}");
        }
    }

    #[test]
    fn a_field_of_the_wrong_type_takes_its_default_and_the_rest_are_kept() {
        for (key, wrong) in [
            ("soundVolume", json!("loud")),
            ("soundEnabled", json!(1)),
            ("activeIntegrations", json!("integration_n8n")),
            ("mainPill", json!(["agent_cursor"])),
            ("screen", Value::Null),
            ("shortcuts", json!("Ctrl+Alt+A")),
        ] {
            let loaded = parse(&custom_with(key, Some(wrong)))
                .unwrap_or_else(|| panic!("a file with a bad {key} was thrown away"));
            let mut expected = custom();
            expected[key] = defaults()[key].clone();
            assert_eq!(shown(&loaded), expected, "bad {key}");
        }
    }

    #[test]
    fn a_utf8_bom_is_not_corruption() {
        // What PowerShell 5's `Set-Content -Encoding utf8` and Notepad write.
        let (dir, file) = scratch("bom");
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice(CUSTOM.as_bytes());
        std::fs::write(&file, &bytes).unwrap();
        assert_eq!(shown(&load_from(&file)), custom());
        assert_eq!(names(&dir), ["settings.json"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_unusable_file_is_the_defaults_and_is_set_aside_byte_for_byte() {
        for (name, bad) in [
            ("invalid", &b"{ \"soundVolume\": 0.5, \xff oops"[..]),
            ("not-an-object", &b"[1, 2, 3]"[..]),
        ] {
            let (dir, file) = scratch(name);
            std::fs::write(&file, bad).unwrap();
            assert_eq!(shown(&load_from(&file)), defaults());
            assert_eq!(kept(&dir, "corrupt"), [bad.to_vec()], "{name}");
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    #[test]
    fn a_second_unusable_file_never_replaces_the_copy_of_the_first() {
        // Both within the same second: the names must still differ.
        let (dir, file) = scratch("twice");
        let (first, second) = (&b"{ first"[..], &b"{ second"[..]);
        std::fs::write(&file, first).unwrap();
        load_from(&file);
        std::fs::write(&file, second).unwrap();
        load_from(&file);
        let mut copies = kept(&dir, "corrupt");
        copies.sort();
        assert_eq!(copies, [first.to_vec(), second.to_vec()]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn something_that_is_not_a_readable_file_is_the_defaults_and_is_left_alone() {
        // A directory in the file's place: a read error that is not "not found".
        let (dir, file) = scratch("unreadable");
        std::fs::create_dir(&file).unwrap();
        assert_eq!(shown(&load_from(&file)), defaults());
        assert_eq!(names(&dir), ["settings.json"]);
        assert!(file.is_dir());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Opens `path` the way a process that shares nothing does: nobody else can
    /// read or write it until the handle is dropped.
    #[cfg(windows)]
    fn locked(path: &Path) -> std::fs::File {
        use std::os::windows::fs::OpenOptionsExt;
        std::fs::OpenOptions::new().read(true).share_mode(0).open(path).unwrap()
    }

    #[cfg(windows)]
    #[test]
    fn a_file_that_could_not_be_read_is_set_aside_before_it_is_saved_over() {
        let (dir, file) = scratch("locked-then-free");
        std::fs::write(&file, CUSTOM).unwrap();
        let lock = locked(&file);
        let loaded = load_from(&file);
        assert_eq!(shown(&loaded), defaults());
        drop(lock);

        save_to(&file, &loaded).unwrap();
        assert_eq!(kept(&dir, "unread"), [CUSTOM.as_bytes().to_vec()]);
        assert_eq!(shown(&load_from(&file)), defaults());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(windows)]
    #[test]
    fn a_file_that_still_cannot_be_read_is_not_saved_over() {
        let (dir, file) = scratch("locked");
        std::fs::write(&file, CUSTOM).unwrap();
        let lock = locked(&file);
        let loaded = load_from(&file);
        assert!(save_to(&file, &loaded).is_err());
        drop(lock);
        assert_eq!(std::fs::read(&file).unwrap(), CUSTOM.as_bytes());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn what_could_not_be_read_is_never_saved_over_unseen() {
        // The same as the two locked-file tests above, on every platform: a
        // directory in the file's place cannot be read either.
        let (dir, file) = scratch("unread");
        std::fs::create_dir(&file).unwrap();
        let loaded = load_from(&file);

        // Still unreadable: the save is refused and nothing is touched.
        assert!(save_to(&file, &loaded).is_err());
        assert!(file.is_dir());
        assert_eq!(names(&dir), ["settings.json"]);

        // Readable by now: kept aside first, and only then saved over.
        std::fs::remove_dir(&file).unwrap();
        std::fs::write(&file, CUSTOM).unwrap();
        save_to(&file, &loaded).unwrap();
        assert_eq!(kept(&dir, "unread"), [CUSTOM.as_bytes().to_vec()]);
        assert_eq!(shown(&load_from(&file)), defaults());
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ── Copies set aside ──────────────────────────────────────────────────────

    #[test]
    fn an_unusable_file_is_set_aside_once_however_often_it_is_loaded() {
        let (dir, file) = scratch("once");
        std::fs::write(&file, b"{ broken").unwrap();
        for _ in 0..3 {
            load_from(&file);
        }
        assert_eq!(kept(&dir, "corrupt"), [b"{ broken".to_vec()]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn copies_made_within_the_same_second_are_numbered_and_none_is_written_over() {
        let (dir, file) = scratch("numbered");
        let stamp = "20260102-030405";
        let contents = [&b"one"[..], &b"two"[..], &b"three"[..]];
        let copies: Vec<PathBuf> = contents
            .iter()
            .map(|bytes| set_aside_as(&file, "corrupt", stamp, bytes, write_whole).unwrap())
            .collect();

        let named = |suffix: &str| dir.join(format!("settings.json.corrupt-{stamp}{suffix}"));
        assert_eq!(copies, [named(""), named("-1"), named("-2")]);
        for (copy, bytes) in copies.iter().zip(contents) {
            assert_eq!(std::fs::read(copy).unwrap(), bytes);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_copy_that_could_not_be_written_whole_is_removed() {
        fn half_then_fail(file: &mut std::fs::File, bytes: &[u8]) -> std::io::Result<()> {
            use std::io::Write;
            file.write_all(&bytes[..bytes.len() / 2])?;
            Err(std::io::Error::other("the disk is full"))
        }
        let (dir, file) = scratch("half");
        let copy = set_aside_as(&file, "corrupt", "20260102-030405", b"all of it", half_then_fail);
        assert!(copy.is_err());
        assert!(names(&dir).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_field_name_cannot_start_a_line_of_its_own_in_the_log() {
        let forged = "volume\r\n2026-01-02 03:04:05 hook id=1 answered allow";
        let line = unusable_field(forged);
        assert!(!line.contains(['\r', '\n']));
        assert!(line.contains(r"volume\r\n2026-01-02"));
    }

    // ── Writing ───────────────────────────────────────────────────────────────

    /// A dotfiles setup keeps the real file elsewhere and links to it.
    #[cfg(unix)]
    #[test]
    fn a_save_through_a_symlink_keeps_the_link_and_writes_its_target() {
        let (dir, file) = scratch("symlink");
        let real = dir.join("dotfiles-settings.json");
        std::fs::write(&real, CUSTOM).unwrap();
        std::os::unix::fs::symlink(&real, &file).unwrap();

        save_to(&file, &Settings::default()).unwrap();
        assert!(std::fs::symlink_metadata(&file).unwrap().file_type().is_symlink());
        assert_eq!(shown(&parse(&std::fs::read(&real).unwrap()).unwrap()), defaults());
        assert_eq!(names(&dir), ["dotfiles-settings.json", "settings.json"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn every_field_survives_a_save_and_a_load() {
        let (dir, file) = scratch("round-trip");
        let settings: Settings = serde_json::from_str(CUSTOM).unwrap();
        save_to(&file, &settings).unwrap();
        assert_eq!(shown(&load_from(&file)), custom());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_file_holds_the_camel_case_keys_the_front_end_uses() {
        let (dir, file) = scratch("keys");
        save_to(&file, &Settings::default()).unwrap();
        let written: Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
        let keys: Vec<&str> = written.as_object().unwrap().keys().map(String::as_str).collect();
        assert_eq!(
            keys,
            [
                "soundEnabled",
                "soundVolume",
                "autoCloseInterval",
                "openOnHover",
                "absenceInterval",
                "activeIntegrations",
                "mainPill",
                "screen",
                "autostart",
                "hooksInstalled",
                "model",
                "showPlanInNotch",
                "planRelayInstalled",
                "showCodexPlanInNotch",
                "chatProvider",
                "chatModels",
                "ollamaUrl",
                "lmstudioUrl",
                "customUrl",
                "shortcuts",
                "mochiOutfit",
                "pillColors",
                "language",
                "desktopMochi",
                "phoneLink",
                "phoneChat",
                "phoneChatModels",
                "phoneDetails",
                "phoneAnswers",
                "phoneDiffs",
                "phoneUsage",
                "phoneServices",
                "phoneRelay",
                "phoneRelayUrl",
                "opencodeModel",
                "opencodeServerUrl",
                "opencodeAutostart",
                "opencodeAgentModel",
                "opencodeBinary",
                "nowPlaying",
                "songPeek",
                "musicMoods",
                "wakeStripWidth",
                "wakeDwellMs",
                "wakeQuietFullscreen",
                "jobRadar",
                "pcVitals",
                "vitalsWarnings",
                "batteryMonitor",
                "batteryWarnings",
                "tools",
                "voiceEnabled",
                "voiceWakeEnabled",
                "voiceWakePhrase",
                "voiceEndpointMs",
                "voiceFollowupMs",
                "voiceSpeechVoice",
                "voiceSpeechRate",
                "voiceSpeechVolume",
                "voiceMode",
                "voiceBackend",
                "voiceModel",
                "voiceMemoryEnabled",
                "voiceAutoSubmit",
                "jevEnabled",
                "jevMode",
                "jevThreshold",
                "jevDeadlineMs",
                "decisionEngine",
                "layaEnabled",
                "layaRuntimePath",
                "layaModelPath",
                "layaManifestPath",
                "layaThreshold",
                "notificationsEnabled",
                "notificationsVipApps",
                "notificationsPrivate",
                "flowEnabled",
                "flowNotesFolder",
                "flowBrowser",
                "flowSearchEngine",
                "flowEditor",
            ]
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_save_replaces_the_file_that_was_there() {
        let (dir, file) = scratch("replace");
        std::fs::write(&file, CUSTOM).unwrap();
        save_to(&file, &Settings::default()).unwrap();
        assert_eq!(shown(&load_from(&file)), defaults());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_save_leaves_nothing_but_settings_json_behind() {
        let (dir, file) = scratch("tidy");
        save_to(&file, &Settings::default()).unwrap();
        save_to(&file, &Settings::default()).unwrap();
        assert_eq!(names(&dir), ["settings.json"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_temporary_file_that_cannot_be_written_leaves_the_original_alone() {
        // The new contents go to a file beside the target first. With a
        // directory squatting on that name, the write cannot even start.
        let (dir, file) = scratch("blocked");
        std::fs::write(&file, CUSTOM).unwrap();
        let temp = dir.join(format!("settings.json.coucou-{}", std::process::id()));
        std::fs::create_dir(&temp).unwrap();

        assert!(save_to(&file, &Settings::default()).is_err());
        assert_eq!(std::fs::read(&file).unwrap(), CUSTOM.as_bytes());
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod choom_tests {
    use super::Settings;

    #[test]
    fn flow_and_laya_stay_off_for_older_settings_files() {
        let settings: Settings = serde_json::from_str("{}").unwrap();
        assert!(!settings.flow_enabled);
        assert!(!settings.laya_enabled);
        assert_eq!(settings.decision_engine, "jev");
        assert!(settings.laya_runtime_path.is_empty());
        assert!(settings.laya_model_path.is_empty());
        assert!(settings.laya_manifest_path.is_empty());
    }

    #[test]
    fn music_focus_settings_default_on() {
        let settings = Settings::default();
        assert!(settings.song_peek);
        assert!(settings.music_moods);
    }

    #[test]
    fn missing_music_keys_stay_on_for_older_settings_files() {
        let settings: Settings = serde_json::from_value(serde_json::json!({
            "soundEnabled": true,
            "soundVolume": 0.12,
            "autoCloseInterval": 15.0,
            "absenceInterval": 180.0,
            "activeIntegrations": [],
            "screen": "primary",
            "autostart": false,
            "hooksInstalled": false,
        }))
        .unwrap();
        assert!(settings.song_peek);
        assert!(settings.music_moods);
    }

    #[test]
    fn music_focus_settings_round_trip_off() {
        let mut settings = Settings::default();
        settings.song_peek = false;
        settings.music_moods = false;
        let back: Settings =
            serde_json::from_value(serde_json::to_value(&settings).unwrap()).unwrap();
        assert!(!back.song_peek);
        assert!(!back.music_moods);
    }

    #[test]
    fn quick_additions_default_on_for_older_settings_files() {
        let settings: Settings = serde_json::from_value(serde_json::json!({
            "soundEnabled": true,
            "soundVolume": 0.12,
            "autoCloseInterval": 15.0,
            "absenceInterval": 180.0,
            "activeIntegrations": [],
            "screen": "primary",
            "autostart": false,
            "hooksInstalled": false,
        }))
        .unwrap();
        assert!(settings.job_radar);
        assert!(settings.pc_vitals);
        assert!(settings.vitals_warnings);
        assert!(settings.battery_monitor);
        assert!(settings.battery_warnings);
    }

    #[test]
    fn quick_additions_round_trip_off() {
        let mut settings = Settings::default();
        settings.job_radar = false;
        settings.pc_vitals = false;
        settings.vitals_warnings = false;
        settings.battery_monitor = false;
        settings.battery_warnings = false;
        let back: Settings =
            serde_json::from_value(serde_json::to_value(&settings).unwrap()).unwrap();
        assert!(!back.job_radar);
        assert!(!back.pc_vitals);
        assert!(!back.vitals_warnings);
        assert!(!back.battery_monitor);
        assert!(!back.battery_warnings);
    }

    #[test]
    fn tools_default_empty_for_older_settings_files() {
        let settings: Settings = serde_json::from_value(serde_json::json!({
            "soundEnabled": true,
            "soundVolume": 0.12,
            "autoCloseInterval": 15.0,
            "absenceInterval": 180.0,
            "activeIntegrations": [],
            "screen": "primary",
            "autostart": false,
            "hooksInstalled": false,
        }))
        .unwrap();
        assert_eq!(settings.tools, crate::choom::tools::ToolsData::default());
    }

    #[test]
    fn tools_round_trip_and_known_keys_survive() {
        let mut settings = Settings::default();
        settings.tools = crate::choom::tools::sanitize_value(serde_json::json!({
            "version": 1,
            "colours": ["#1ED760", "nope"],
            "shortcuts": [],
            "routines": [],
            "whateverComesNext": true,
        }));
        assert_eq!(settings.tools.colours, vec!["#1ED760".to_string()]);
        let back: Settings =
            serde_json::from_value(serde_json::to_value(&settings).unwrap()).unwrap();
        assert_eq!(back.tools.colours, vec!["#1ED760".to_string()]);
        assert!(back.job_radar);
    }

    #[test]
    fn voice_defaults_off_for_older_settings_files() {
        let settings: Settings = serde_json::from_value(serde_json::json!({
            "soundEnabled": true,
            "soundVolume": 0.12,
            "autoCloseInterval": 15.0,
            "absenceInterval": 180.0,
            "activeIntegrations": [],
            "screen": "primary",
            "autostart": false,
            "hooksInstalled": false,
        }))
        .unwrap();
        assert!(!settings.voice_enabled);
        assert!(!settings.voice_wake_enabled);
        assert!(!settings.voice_memory_enabled);
        assert_eq!(settings.voice_wake_phrase, "Choom");
        assert_eq!(settings.voice_mode, "auto");
        // Existing users stay on Windows dictation until explicit selection.
        assert_eq!(settings.voice_backend, "system");
        assert_eq!(settings.voice_model, "base");
    }

    #[test]
    fn voice_backend_normalizes_unknown_values() {
        let mut value = serde_json::to_value(Settings::default()).unwrap();
        value.as_object_mut().unwrap().extend(
            serde_json::json!({ "voiceBackend": "cloud", "voiceModel": "large" })
                .as_object().unwrap().clone(),
        );
        let mut settings: Settings = serde_json::from_value(value).unwrap();
        settings.voice_backend = crate::choom::voice::normalize_backend(&settings.voice_backend);
        settings.voice_model = crate::choom::voice::normalize_model(&settings.voice_model);
        assert_eq!(settings.voice_backend, "system");
        assert_eq!(settings.voice_model, "base");
    }

    #[test]
    fn jev_defaults_to_shadow_but_network_stays_off() {
        let settings: Settings = serde_json::from_value(serde_json::json!({
            "soundEnabled": true,
            "soundVolume": 0.12,
            "autoCloseInterval": 15.0,
            "absenceInterval": 180.0,
            "activeIntegrations": [],
            "screen": "primary",
            "autostart": false,
            "hooksInstalled": false,
        }))
        .unwrap();
        assert_eq!(settings.jev_mode, "shadow");
        assert!(!settings.jev_enabled);
        assert_eq!(settings.jev_threshold, 0.75);
        assert_eq!(settings.jev_deadline_ms, 2500);
    }

    #[test]
    fn jev_bounds_clamp_on_load() {
        let mut settings_value = serde_json::to_value(Settings::default()).unwrap();
        let overrides = serde_json::json!({
            "jevEnabled": true,
            "jevMode": "turbo",
            "jevThreshold": 9.9,
            "jevDeadlineMs": 99999,
        });
        settings_value.as_object_mut().unwrap().extend(overrides.as_object().unwrap().clone());
        let settings: Settings = serde_json::from_value(settings_value).unwrap();
        let mut fixed = settings;
        fixed.jev_mode = crate::choom::jev::normalize_mode(&fixed.jev_mode);
        fixed.jev_threshold = crate::choom::jev::clamp_threshold(fixed.jev_threshold);
        fixed.jev_deadline_ms = crate::choom::jev::clamp_deadline_ms(fixed.jev_deadline_ms);
        assert_eq!(fixed.jev_mode, "shadow");
        assert_eq!(fixed.jev_threshold, 0.95);
        assert_eq!(fixed.jev_deadline_ms, 8000);
        // Below the approved confidence minimum never survives.
        let mut low_value = serde_json::to_value(Settings::default()).unwrap();
        let overrides = serde_json::json!({
            "jevEnabled": true,
            "jevMode": "assisted",
            "jevThreshold": 0.5,
            "jevDeadlineMs": 100,
        });
        low_value.as_object_mut().unwrap().extend(overrides.as_object().unwrap().clone());
        let low: Settings = serde_json::from_value(low_value).unwrap();
        assert_eq!(crate::choom::jev::clamp_threshold(low.jev_threshold), 0.75);
        assert_eq!(crate::choom::jev::clamp_deadline_ms(low.jev_deadline_ms), 500);
    }

    #[test]
    fn laya_is_off_and_paths_are_empty_by_default() {
        let settings: Settings = serde_json::from_value(serde_json::json!({
            "soundEnabled": true,
            "soundVolume": 0.12,
            "autoCloseInterval": 15.0,
            "absenceInterval": 180.0,
            "activeIntegrations": [],
            "screen": "primary",
            "autostart": false,
            "hooksInstalled": false,
        }))
        .unwrap();
        // An older settings file must never start a worker on its own.
        assert!(!settings.laya_enabled);
        assert_eq!(settings.decision_engine, "jev");
        assert!(settings.laya_runtime_path.is_empty());
        assert!(settings.laya_model_path.is_empty());
        assert!(settings.laya_manifest_path.is_empty());
        assert_eq!(settings.laya_threshold, crate::choom::laya::LAYA_THRESHOLD_DEFAULT);
    }

    #[test]
    fn the_engine_selector_survives_an_unknown_value_as_online() {
        // Backward compatibility is the point: a file with no selector at all,
        // and a file with a value this build does not know, both read as the
        // online engine, so Jev mode and defaults behave exactly as before.
        assert_eq!(Settings::default().decision_engine, "jev");
        let mut settings = Settings::default();
        settings.decision_engine = "  cloud  ".to_string();
        settings.laya_enabled = true;
        super::normalize_laya(&mut settings);
        assert_eq!(settings.decision_engine, "jev");
        // The mirror always follows the selector, so there is one truth.
        assert!(!settings.laya_enabled);
        settings.decision_engine = "LAYA".to_string();
        super::normalize_laya(&mut settings);
        assert_eq!(settings.decision_engine, "laya");
        assert!(settings.laya_enabled);
    }

    #[test]
    fn laya_bounds_clamp_on_load() {
        let mut settings_value = serde_json::to_value(Settings::default()).unwrap();
        let overrides = serde_json::json!({
            "layaEnabled": true,
            "layaRuntimePath": "  C:/laya/venv/Scripts/python.exe  ",
            "layaModelPath": "  C:/laya/model  ",
            "layaManifestPath": "  C:/laya/model-manifest.json  ",
            "layaThreshold": 0.2,
        });
        settings_value.as_object_mut().unwrap().extend(overrides.as_object().unwrap().clone());
        let settings: Settings = serde_json::from_value(settings_value).unwrap();
        let mut fixed = settings;
        // Loading trims every path and bounds the threshold, so a hand-edited
        // file cannot smuggle a padded path or a wild threshold through.
        super::normalize_laya(&mut fixed);
        assert_eq!(fixed.laya_runtime_path, "C:/laya/venv/Scripts/python.exe");
        assert_eq!(fixed.laya_model_path, "C:/laya/model");
        assert_eq!(fixed.laya_manifest_path, "C:/laya/model-manifest.json");
        // The Laya floor is its own: never borrowed from the Jev value.
        assert_eq!(fixed.laya_threshold, 0.75);
        let high = crate::choom::laya::clamp_threshold(9.9);
        assert_eq!(high, 0.95);
        assert_eq!(crate::choom::laya::clamp_threshold(f64::NAN), crate::choom::laya::LAYA_THRESHOLD_DEFAULT);
    }

    #[test]
    fn notifications_default_off_for_older_settings_files() {
        let settings: Settings = serde_json::from_value(serde_json::json!({
            "soundEnabled": true,
            "soundVolume": 0.12,
            "autoCloseInterval": 15.0,
            "absenceInterval": 180.0,
            "activeIntegrations": [],
            "screen": "primary",
            "autostart": false,
            "hooksInstalled": false,
        }))
        .unwrap();
        assert!(!settings.notifications_enabled);
        assert!(settings.notifications_vip_apps.is_empty());
        assert!(!settings.notifications_private);
    }

    #[test]
    fn notifications_settings_round_trip() {
        let mut settings = Settings::default();
        settings.notifications_enabled = true;
        settings.notifications_private = true;
        settings.notifications_vip_apps = vec!["Spotify.exe".into(), "Windows Terminal".into()];
        let value = serde_json::to_value(&settings).unwrap();
        // Serde stores what it is given; trimming and de-duplication belong to
        // sanitize_vip_apps on load, not to serialization.
        assert_eq!(
            value["notificationsVipApps"],
            serde_json::json!(["Spotify.exe", "Windows Terminal"])
        );
        let back: Settings = serde_json::from_value(value).unwrap();
        assert!(back.notifications_enabled);
        assert!(back.notifications_private);
        assert_eq!(
            back.notifications_vip_apps,
            vec!["Spotify.exe".to_string(), "Windows Terminal".to_string()]
        );
    }

    #[test]
    fn vip_apps_are_trimmed_deduped_and_bounded() {
        let apps = super::sanitize_vip_apps(vec![
            "  Spotify  ".into(),
            "spotify".into(),
            "".into(),
            "   ".into(),
            "Slack".into(),
        ]);
        assert_eq!(apps, vec!["Spotify".to_string(), "Slack".to_string()]);
        let many: Vec<String> = (0..64).map(|i| format!("app-{i}")).collect();
        assert_eq!(super::sanitize_vip_apps(many).len(), 24);
        let long = "x".repeat(81);
        assert!(super::sanitize_vip_apps(vec![long]).is_empty());
    }
}
