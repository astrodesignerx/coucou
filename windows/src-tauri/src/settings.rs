// Preferences, stored as plain JSON in settings.json under platform::config_dir().
// No secret ever lands here — API keys live in the OS keychain (see secrets.rs).

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub sound_enabled: bool,
    pub sound_volume: f64,
    pub auto_close_interval: f64,
    pub absence_interval: f64,
    pub active_integrations: Vec<String>,
    /// "primary" = the main display, "cursor" = whichever display the mouse is on.
    pub screen: String,
    pub autostart: bool,
    pub hooks_installed: bool,
    /// Claude model used by the chat. Changeable in the settings window.
    /// Defaulted explicitly so a settings.json written by an older build still loads.
    #[serde(default = "default_model")]
    pub model: String,
    /// Chat provider: "opencode-go", "opencode-agent" or "anthropic".
    #[serde(default = "default_chat_provider")]
    pub chat_provider: String,
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

impl Default for Settings {
    fn default() -> Self {
        Self {
            sound_enabled: true,
            sound_volume: 0.12,
            auto_close_interval: 15.0,
            absence_interval: 180.0,
            active_integrations: vec![
                "integration_resend".into(),
                "integration_n8n".into(),
                "integration_vercel".into(),
                "integration_github".into(),
            ],
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
        }
    }
}

pub use crate::platform::{config_dir, local_dir};

pub fn hook_exe_path() -> PathBuf {
    local_dir().join("bin").join(crate::platform::HOOK_EXE)
}

fn settings_path() -> PathBuf {
    config_dir().join("settings.json")
}

pub fn load() -> Settings {
    let mut settings: Settings = match std::fs::read(settings_path()) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
        Err(_) => Settings::default(),
    };
    // Hand-edited or older tools data is validated, never trusted as-is.
    settings.tools = crate::choom::tools::sanitize_data(settings.tools);
    settings.jev_mode = crate::choom::jev::normalize_mode(&settings.jev_mode);
    settings.jev_threshold = crate::choom::jev::clamp_threshold(settings.jev_threshold);
    settings.jev_deadline_ms = crate::choom::jev::clamp_deadline_ms(settings.jev_deadline_ms);
    settings.voice_backend = crate::choom::voice::normalize_backend(&settings.voice_backend);
    settings.voice_model = crate::choom::voice::normalize_model(&settings.voice_model);
    settings
}

pub fn save(settings: &Settings) -> std::io::Result<()> {
    let dir = config_dir();
    crate::platform::ensure_private_dir(&dir)?;
    let json = serde_json::to_vec_pretty(settings)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    std::fs::write(settings_path(), json)
}

#[cfg(test)]
mod tests {
    use super::Settings;

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
}
