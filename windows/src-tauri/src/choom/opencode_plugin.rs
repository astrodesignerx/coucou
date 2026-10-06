// OpenCode plugin installation.
//
// One small JS file at ~/.config/opencode/plugins/choom.js reports OpenCode
// sessions to the Coucou relay, which gives them an "opencode" pill. Like the
// Claude Code hooks, writing it only ever happens after an explicit click in
// Settings, and Choom touches this one file and nothing else: opencode.jsonc
// and any other plugin stay as they are.

use std::path::PathBuf;

use serde::Serialize;

use crate::platform;

/// The plugin source, embedded in the binary so install never needs a download.
const PLUGIN_JS: &str = include_str!("../../../choom-opencode/choom.js");

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginStatus {
    pub installed: bool,
    /// The file is there but differs from the copy this build ships.
    pub outdated: bool,
    pub path: String,
}

/// `~/.config/opencode/plugins/choom.js`.
pub fn plugin_path() -> PathBuf {
    platform::home_dir()
        .join(".config")
        .join("opencode")
        .join("plugins")
        .join("choom.js")
}

/// Installed and outdated from what is on disk. Split out as a pure function
/// so both decisions can be tested without a home directory: when the file
/// cannot be read it still exists, and Install is the way to put it right.
fn classify(exists: bool, contents: Option<&str>) -> (bool, bool) {
    match (exists, contents) {
        (true, Some(text)) => (true, text != PLUGIN_JS),
        (true, None) => (true, true),
        (false, _) => (false, false),
    }
}

pub fn status() -> PluginStatus {
    let path = plugin_path();
    let contents = std::fs::read_to_string(&path).ok();
    let (installed, outdated) = classify(path.exists(), contents.as_deref());
    PluginStatus {
        installed,
        outdated,
        path: path.to_string_lossy().to_string(),
    }
}

pub fn install() -> Result<String, String> {
    let path = plugin_path();
    let dir = path.parent().ok_or("the plugin path has no folder")?;
    std::fs::create_dir_all(dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    std::fs::write(&path, PLUGIN_JS)
        .map_err(|e| format!("could not write {}: {e}", path.display()))?;
    Ok(path.to_string_lossy().to_string())
}

pub fn remove() -> Result<(), String> {
    let path = plugin_path();
    match std::fs::remove_file(&path) {
        // Already gone is the state the caller wanted.
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        other => other.map_err(|e| format!("could not remove {}: {e}", path.display())),
    }
}

#[cfg(test)]
mod tests {
    use super::{classify, PLUGIN_JS};

    #[test]
    fn plugin_status_follows_the_file_that_is_there() {
        // Nothing on disk: not installed, and nothing to update.
        assert_eq!(classify(false, None), (false, false));
        assert_eq!(classify(false, Some("whatever")), (false, false));

        // The file matches the copy this build ships.
        assert_eq!(classify(true, Some(PLUGIN_JS)), (true, false));

        // It differs (an older install), or cannot be read: update available.
        assert_eq!(classify(true, Some("// an older plugin")), (true, true));
        assert_eq!(classify(true, None), (true, true));
    }
}
