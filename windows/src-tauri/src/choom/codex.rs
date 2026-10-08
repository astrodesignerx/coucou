// Codex hook installation (hooks.json).
//
// Mirrors the safe design in src-tauri/src/hooks.rs: read the file, show the
// diff, take a dated backup, and write only when the file still matches the
// preview the user looked at. The Claude Code installation is untouched: this
// module only owns entries whose command contains both `coucou-hook` and
// `--agent codex`, and it only reads and writes `~/.codex/hooks.json`.
//
// Assumption: hooks.json uses the envelope `{ "hooks": { <Event>: [ { "command",
// "timeout", "type" } ] } }`. Unknown top-level keys and foreign hook entries
// are preserved byte-for-byte through the JSON merge (pretty printed). If a
// future Codex CLI uses a different envelope, this installer still refuses
// malformed content rather than overwriting it, and the Settings panel says
// which file and shape were used.
//
// Supported lifecycle events are the verified official set: SessionStart,
// UserPromptSubmit, PreToolUse, PostToolUse, PermissionRequest, Stop,
// Interrupt and SessionEnd. Interrupt is capped at 3 s per the official hook
// reference; PermissionRequest waits for a human. config.toml notify (the
// Codex computer-use runtime) is never touched here.

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{json, Map, Value};
use crate::platform;

/// Every Codex event Choom reacts to, with the hook timeout written to hooks.json.
/// PermissionRequest waits for a human; Interrupt is capped at 3 s.
pub const CODEX_HOOK_EVENTS: &[(&str, u64)] = &[
    ("SessionStart", 10),
    ("SessionEnd", 10),
    ("UserPromptSubmit", 10),
    ("PreToolUse", 10),
    ("PostToolUse", 10),
    ("PermissionRequest", 120),
    ("Stop", 10),
    ("Interrupt", 3),
];

/// Markers that identify a Coucou Codex entry. Scoped ownership: a Claude Code
/// entry contains `coucou-hook` but never `--agent codex`, so Codex install and
/// remove never touch it even when both live in one file.
const MARKER: &str = "coucou-hook";
const CODEX_MARKER: &str = "--agent codex";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexStatus {
    pub installed: bool,
    pub settings_path: String,
    pub hook_path: String,
    pub hook_ready: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexPreview {
    pub diff: String,
    pub backup: String,
    pub settings_path: String,
    /// Identifies the bytes this diff was computed from; handed back to `write`
    /// so we only ever apply what the user actually looked at.
    pub fingerprint: String,
}

pub fn settings_path() -> PathBuf {
    crate::platform::home_dir().join(".codex").join("hooks.json")
}

fn read_settings() -> Result<Value, String> {
    let path = settings_path();
    match std::fs::read(&path) {
        Ok(bytes) => parse_settings(&bytes, &path.display().to_string()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
        Err(err) => Err(format!("Can't read {}: {err}", path.display())),
    }
}

fn parse_settings(bytes: &[u8], path: &str) -> Result<Value, String> {
    let text = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    if text.iter().all(u8::is_ascii_whitespace) {
        return Ok(json!({}));
    }
    match serde_json::from_slice::<Value>(text) {
        Ok(v) if v.is_object() => Ok(v),
        Ok(_) => Err(format!("{path} isn't a JSON object. Choom won't touch it.")),
        Err(err) => Err(format!(
            "{path} isn't valid JSON ({err}). Fix or move it, then try again. Choom won't overwrite it."
        )),
    }
}

fn read_settings_lossy() -> Value {
    read_settings().unwrap_or_else(|_| json!({}))
}

#[cfg(windows)]
fn hook_command(event: &str) -> String {
    let exe = crate::settings::hook_exe_path().to_string_lossy().replace('\\', "/");
    format!("\"{exe}\" --agent codex {event}")
}

#[cfg(unix)]
fn hook_command(event: &str) -> String {
    format!("{} --agent codex {event}", sh_quote(&crate::settings::hook_exe_path().to_string_lossy()))
}

#[cfg(unix)]
fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

fn entry_is_ours(entry: &Value) -> bool {
    // Flat shape: { "command": "...", ... }.
    if let Some(cmd) = entry.get("command").and_then(Value::as_str) {
        if cmd.contains(MARKER) && cmd.contains(CODEX_MARKER) {
            return true;
        }
    }
    // Nested Claude-like shape: { "hooks": [{ "command": "..." }] }.
    if let Some(hooks) = entry.get("hooks").and_then(Value::as_array) {
        for h in hooks {
            if let Some(cmd) = h.get("command").and_then(Value::as_str) {
                if cmd.contains(MARKER) && cmd.contains(CODEX_MARKER) {
                    return true;
                }
            }
        }
    }
    false
}

fn make_entry(event: &str, timeout: u64) -> Value {
    json!({
        "type": "command",
        "command": hook_command(event),
        "timeout": timeout,
    })
}

fn merged(existing: &Value) -> Value {
    let mut root = existing.as_object().cloned().unwrap_or_default();
    let mut hooks = root
        .get("hooks")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_else(Map::new);
    for (event, timeout) in CODEX_HOOK_EVENTS {
        let mut list = hooks
            .get(*event)
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        list.retain(|entry| !entry_is_ours(entry));
        list.push(make_entry(event, *timeout));
        hooks.insert((*event).to_string(), Value::Array(list));
    }
    root.insert("hooks".into(), Value::Object(hooks));
    Value::Object(root)
}

fn without_ours(existing: &Value) -> Value {
    let mut root = existing.as_object().cloned().unwrap_or_default();
    let Some(hooks) = root.get("hooks").and_then(Value::as_object).cloned() else {
        return Value::Object(root);
    };
    let mut out = Map::new();
    for (event, value) in hooks {
        match value.as_array() {
            Some(list) => {
                let kept: Vec<Value> =
                    list.iter().filter(|e| !entry_is_ours(e)).cloned().collect();
                if !kept.is_empty() {
                    out.insert(event, Value::Array(kept));
                }
            }
            None => {
                out.insert(event, value);
            }
        }
    }
    if out.is_empty() {
        root.remove("hooks");
    } else {
        root.insert("hooks".into(), Value::Object(out));
    }
    Value::Object(root)
}

fn pretty(v: &Value) -> String {
    serde_json::to_string_pretty(v).unwrap_or_default()
}

fn stamp() -> String {
    let t = platform::local_time();
    format!(
        "{:04}{:02}{:02}-{:02}{:02}{:02}",
        t.year, t.month, t.day, t.hour, t.minute, t.second
    )
}

fn backup_path() -> PathBuf {
    let p = settings_path();
    p.with_file_name(format!("hooks.json.bak-{}", stamp()))
}

fn fingerprint(bytes: &[u8]) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        hash ^= *b as u64;
        hash = hash.wrapping_mul(0x1000_0000_01b3);
    }
    format!("{hash:016x}")
}

fn current_fingerprint() -> String {
    match std::fs::read(settings_path()) {
        Ok(bytes) => fingerprint(&bytes),
        Err(_) => fingerprint(b""),
    }
}

fn unified_diff(before: &str, after: &str) -> String {
    let a: Vec<&str> = before.lines().collect();
    let b: Vec<&str> = after.lines().collect();
    let (n, m) = (a.len(), b.len());
    let mut lcs = vec![vec![0usize; m + 1]; n + 1];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            lcs[i][j] = if a[i] == b[j] {
                lcs[i + 1][j + 1] + 1
            } else {
                lcs[i + 1][j].max(lcs[i][j + 1])
            };
        }
    }
    let mut out: Vec<String> = Vec::new();
    let (mut i, mut j) = (0usize, 0usize);
    while i < n && j < m {
        if a[i] == b[j] {
            out.push(format!("  {}", a[i]));
            i += 1;
            j += 1;
        } else if lcs[i + 1][j] >= lcs[i][j + 1] {
            out.push(format!("- {}", a[i]));
            i += 1;
        } else {
            out.push(format!("+ {}", b[j]));
            j += 1;
        }
    }
    while i < n {
        out.push(format!("- {}", a[i]));
        i += 1;
    }
    while j < m {
        out.push(format!("+ {}", b[j]));
        j += 1;
    }
    let changed: Vec<usize> = out
        .iter()
        .enumerate()
        .filter(|(_, l)| l.starts_with('+') || l.starts_with('-'))
        .map(|(i, _)| i)
        .collect();
    if changed.is_empty() {
        return "No change.".into();
    }
    let mut keep = vec![false; out.len()];
    for idx in changed {
        let lo = idx.saturating_sub(3);
        let hi = (idx + 4).min(out.len());
        for k in lo..hi {
            keep[k] = true;
        }
    }
    let mut result = String::new();
    let mut gap = false;
    for (idx, line) in out.iter().enumerate() {
        if keep[idx] {
            result.push_str(line);
            result.push('\n');
            gap = false;
        } else if !gap {
            result.push_str("  …\n");
            gap = true;
        }
    }
    result
}

pub fn status() -> CodexStatus {
    let current = read_settings_lossy();
    let installed = current
        .get("hooks")
        .and_then(Value::as_object)
        .map(|hooks| {
            hooks
                .values()
                .filter_map(Value::as_array)
                .flatten()
                .any(entry_is_ours)
        })
        .unwrap_or(false);
    let hook_path = crate::settings::hook_exe_path();
    CodexStatus {
        installed,
        settings_path: settings_path().to_string_lossy().to_string(),
        hook_ready: hook_path.exists(),
        hook_path: hook_path.to_string_lossy().to_string(),
    }
}

pub fn preview(install: bool) -> Result<CodexPreview, String> {
    let current = read_settings()?;
    let next = if install { merged(&current) } else { without_ours(&current) };
    Ok(CodexPreview {
        diff: unified_diff(&pretty(&current), &pretty(&next)),
        backup: backup_path().to_string_lossy().to_string(),
        settings_path: settings_path().to_string_lossy().to_string(),
        fingerprint: current_fingerprint(),
    })
}

pub fn write(install: bool, fingerprint_in: &str) -> Result<String, String> {
    let path = settings_path();
    let dir = path.parent().unwrap_or(Path::new("."));
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let current = read_settings()?;
    if current_fingerprint() != fingerprint_in {
        return Err(format!(
            "{} changed since the preview. Nothing was written, review the new diff.",
            path.display()
        ));
    }
    let backup = backup_path();
    if path.exists() {
        std::fs::copy(&path, &backup).map_err(|e| format!("backup failed: {e}"))?;
    }
    let next = if install { merged(&current) } else { without_ours(&current) };
    let mut text = pretty(&next);
    text.push('\n');
    #[cfg(unix)]
    let path = std::fs::canonicalize(&path).unwrap_or(path);
    let temp = path.with_extension(format!("json.coucou-{}", std::process::id()));
    if let Err(err) = write_like(&temp, &path, text.as_bytes()) {
        let _ = std::fs::remove_file(&temp);
        return Err(format!("write failed: {err}"));
    }
    if let Err(err) = std::fs::rename(&temp, &path) {
        let _ = std::fs::remove_file(&temp);
        return Err(format!("write failed: {err}"));
    }
    Ok(backup.to_string_lossy().to_string())
}

fn write_like(temp: &Path, original: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let mut file = options.open(temp)?;
    file.write_all(bytes)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(original)
            .map(|m| m.permissions().mode() & 0o777)
            .unwrap_or(0o600);
        file.set_permissions(std::fs::Permissions::from_mode(mode))?;
    }
    #[cfg(not(unix))]
    let _ = original;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const WHERE: &str = "hooks.json";

    #[test]
    fn codex_events_match_the_supported_set() {
        let names: Vec<&str> = CODEX_HOOK_EVENTS.iter().map(|(e, _)| *e).collect();
        assert_eq!(
            names,
            vec![
                "SessionStart",
                "SessionEnd",
                "UserPromptSubmit",
                "PreToolUse",
                "PostToolUse",
                "PermissionRequest",
                "Stop",
                "Interrupt"
            ]
        );
        // Interrupt is capped at 3 s; permission waits for a human.
        let timeout = |e: &str| CODEX_HOOK_EVENTS.iter().find(|(n, _)| *n == e).unwrap().1;
        assert_eq!(timeout("Interrupt"), 3);
        assert_eq!(timeout("PermissionRequest"), 120);
        // No invented failure events.
        assert!(!names.contains(&"PostToolUseFailure"));
        assert!(!names.contains(&"StopFailure"));
    }

    #[test]
    fn scoped_ownership_ignores_claude_entries() {
        let claude = json!({ "command": "\"C:/x/coucou-hook.exe\" SessionStart", "timeout": 10 });
        let codex = json!({ "command": "\"C:/x/coucou-hook.exe\" --agent codex SessionStart", "timeout": 10 });
        let other = json!({ "command": "someone-else.exe", "timeout": 10 });
        assert!(!entry_is_ours(&claude));
        assert!(entry_is_ours(&codex));
        assert!(!entry_is_ours(&other));
        // Nested Claude-like shape with codex marker still counts.
        let nested = json!({ "hooks": [{ "type": "command", "command": "coucou-hook --agent codex Stop" }] });
        assert!(entry_is_ours(&nested));
        let nested_claude = json!({ "hooks": [{ "type": "command", "command": "coucou-hook Stop" }] });
        assert!(!entry_is_ours(&nested_claude));
    }

    #[test]
    fn merging_preserves_foreign_hooks_and_claude_entries() {
        let existing = json!({
            "hooks": {
                "SessionStart": [
                    { "command": "someone-else.exe", "timeout": 5 },
                    { "command": "coucou-hook SessionStart", "timeout": 10 }
                ],
                "CustomEvent": [{ "command": "keep-me.exe" }]
            },
            "other": true
        });
        let after = merged(&existing);
        assert_eq!(after["other"], true);
        let start = after["hooks"]["SessionStart"].as_array().unwrap();
        assert!(start.iter().any(|e| e.to_string().contains("someone-else.exe")));
        assert!(start.iter().any(|e| e.to_string().contains("coucou-hook SessionStart")));
        assert!(start.iter().any(entry_is_ours));
        assert!(after["hooks"]["CustomEvent"].is_array());
        let cleaned = without_ours(&after);
        assert_eq!(cleaned, existing);
    }

    #[test]
    fn malformed_content_is_an_error_never_empty() {
        for bad in [&b"{ not json"[..], &b"[1,2,3]"[..], &b"\"x\""[..]] {
            assert!(parse_settings(bad, WHERE).is_err());
        }
        assert_eq!(parse_settings(b"", WHERE).unwrap(), json!({}));
    }
}
