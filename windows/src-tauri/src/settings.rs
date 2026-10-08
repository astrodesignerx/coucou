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
    match std::fs::read(settings_path()) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
        Err(_) => Settings::default(),
    }
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
}
