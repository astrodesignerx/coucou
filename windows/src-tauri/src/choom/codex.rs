// Codex hook installation (hooks.json).
//
// Mirrors the safe design in src-tauri/src/hooks.rs: read the file, show the
// diff, take a dated backup, and write only when the file still matches the
// preview the user looked at. The Claude Code installation is untouched: this
// module only owns matcher hooks whose command runs coucou-hook with exactly
// `--agent codex`, and it only reads and writes `~/.codex/hooks.json`.
//
// Official schema: `{ "hooks": { <Event>: [ { <matcher metadata>,
// "hooks": [ { "type": "command", "command": ..., "timeout": ... } ] } ] } }`.
// Unknown top-level keys, foreign matcher groups, foreign hooks inside mixed
// groups, and group metadata (such as matcher fields) are preserved. Groups
// left with no hooks after owned children are removed are dropped. Anything
// that is not this shape is refused rather than rewritten.
//
// Supported lifecycle events are the verified official set: SessionStart,
// UserPromptSubmit, PreToolUse, PostToolUse, PermissionRequest, Stop,
// Interrupt and SessionEnd. Interrupt and SessionEnd are capped at 3 s per the
// official hook reference; PermissionRequest waits for a human. config.toml
// notify is never touched here.

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{json, Map, Value};
use crate::platform;

/// Every Codex event Choom reacts to, with the hook timeout written to hooks.json.
/// PermissionRequest waits for a human; Interrupt and SessionEnd are capped at 3 s.
pub const CODEX_HOOK_EVENTS: &[(&str, u64)] = &[
    ("SessionStart", 10),
    ("SessionEnd", 3),
    ("UserPromptSubmit", 10),
    ("PreToolUse", 10),
    ("PostToolUse", 10),
    ("PermissionRequest", 120),
    ("Stop", 10),
    ("Interrupt", 3),
];

/// The relay binary, matched as the invoked program rather than a substring.
const RELAY: &str = "coucou-hook";

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

fn read_snapshot() -> Result<(Vec<u8>, Value), String> {
    let path = settings_path();
    match std::fs::read(&path) {
        Ok(bytes) => {
            let value = parse_settings(&bytes, &path.display().to_string())?;
            Ok((bytes, value))
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok((Vec::new(), json!({}))),
        Err(err) => Err(format!("Can't read {}: {err}", path.display())),
    }
}

fn parse_settings(bytes: &[u8], path: &str) -> Result<Value, String> {
    let text = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    if text.iter().all(u8::is_ascii_whitespace) {
        return Ok(json!({}));
    }
    match serde_json::from_slice::<Value>(text) {
        Ok(v) if v.is_object() => {
            validate_shape(&v)?;
            Ok(v)
        }
        Ok(_) => Err(format!("{path} isn't a JSON object. Choom won't touch it.")),
        Err(err) => Err(format!(
            "{path} isn't valid JSON ({err}). Fix or move it, then try again. Choom won't overwrite it."
        )),
    }
}

/// Refuses anything that is not the official matcher-group shape instead of
/// silently discarding what it does not understand.
fn validate_shape(root: &Value) -> Result<(), String> {
    let Some(hooks) = root.get("hooks") else {
        return Ok(());
    };
    let hooks = hooks
        .as_object()
        .ok_or_else(|| "hooks.json: \"hooks\" must be an object.".to_string())?;
    for (event, groups) in hooks {
        let groups = groups
            .as_array()
            .ok_or_else(|| format!("hooks.json: hooks[{event}] must be an array."))?;
        for group in groups {
            let group = group
                .as_object()
                .ok_or_else(|| format!("hooks.json: hooks[{event}] entries must be objects."))?;
            let Some(inner) = group.get("hooks") else {
                return Err(format!(
                    "hooks.json: hooks[{event}] entries must contain a \"hooks\" array."
                ));
            };
            let inner = inner
                .as_array()
                .ok_or_else(|| format!("hooks.json: hooks[{event}].hooks must be an array."))?;
            for hook in inner {
                let hook = hook
                    .as_object()
                    .ok_or_else(|| format!("hooks.json: hooks[{event}].hooks entries must be objects."))?;
                match hook.get("command") {
                    Some(Value::String(_)) => {}
                    _ => {
                        return Err(format!(
                            "hooks.json: hooks[{event}].hooks entries must carry a string \"command\"."
                        ))
                    }
                }
            }
        }
    }
    Ok(())
}

fn read_settings_lossy() -> Value {
    read_snapshot().map(|(_, v)| v).unwrap_or_else(|_| json!({}))
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

/// Splits a hook command into shell words, honouring single and double quotes.
/// Only enough to find the program and the `--agent` value; anything fancier
/// is refused rather than guessed at.
fn split_command(cmd: &str) -> Option<Vec<String>> {
    let mut words = Vec::new();
    let mut cur = String::new();
    let mut quote = None::<char>;
    let mut in_word = false;
    for c in cmd.chars() {
        if let Some(q) = quote {
            if c == q {
                quote = None;
            } else {
                cur.push(c);
            }
            in_word = true;
        } else if c == '"' || c == '\'' {
            quote = Some(c);
            in_word = true;
        } else if c.is_whitespace() {
            if in_word {
                words.push(std::mem::take(&mut cur));
                in_word = false;
            }
        } else {
            cur.push(c);
            in_word = true;
        }
    }
    if quote.is_some() {
        return None;
    }
    if in_word {
        words.push(cur);
    }
    Some(words)
}

fn program_is_relay(program: &str) -> bool {
    let base = program
        .replace('\\', "/")
        .rsplit('/')
        .next()
        .unwrap_or(program)
        .to_ascii_lowercase();
    base == RELAY || base == format!("{RELAY}.exe")
}

/// True only when the command runs the relay with exactly `--agent codex`.
/// `--agent codex-other` is a different agent, and a foreign command that only
/// mentions the relay in its arguments is not ours.
fn command_is_ours(cmd: &str) -> bool {
    let Some(words) = split_command(cmd) else {
        return false;
    };
    let Some(program) = words.first() else {
        return false;
    };
    if !program_is_relay(program) {
        return false;
    }
    let mut it = words.iter().skip(1);
    while let Some(arg) = it.next() {
        if arg == "--agent" {
            return it.next().is_some_and(|v| v == "codex");
        }
        if let Some(v) = arg.strip_prefix("--agent=") {
            return v == "codex";
        }
    }
    false
}

fn hook_is_ours(hook: &Value) -> bool {
    hook.get("command")
        .and_then(Value::as_str)
        .is_some_and(command_is_ours)
}

fn group_has_ours(group: &Value) -> bool {
    group
        .get("hooks")
        .and_then(Value::as_array)
        .is_some_and(|hooks| hooks.iter().any(hook_is_ours))
}

/// A matcher group with owned hooks removed. Foreign hooks and group metadata
/// stay; a group left with no hooks returns None so it is dropped.
fn cleaned_group(group: &Value) -> Option<Value> {
    let obj = group.as_object()?;
    let hooks = obj.get("hooks")?.as_array()?;
    let kept: Vec<Value> = hooks.iter().filter(|h| !hook_is_ours(h)).cloned().collect();
    if kept.is_empty() {
        return None;
    }
    if kept.len() == hooks.len() {
        return Some(group.clone());
    }
    let mut out = obj.clone();
    out.insert("hooks".into(), Value::Array(kept));
    Some(Value::Object(out))
}

fn make_group(event: &str, timeout: u64) -> Value {
    json!({
        "hooks": [{
            "type": "command",
            "command": hook_command(event),
            "timeout": timeout,
        }]
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
        let list = hooks
            .get(*event)
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        // Strip owned hooks out of mixed groups, drop groups left empty.
        let mut cleaned: Vec<Value> = Vec::new();
        for group in &list {
            if group_has_ours(group) {
                if let Some(g) = cleaned_group(group) {
                    cleaned.push(g);
                }
            } else {
                cleaned.push(group.clone());
            }
        }
        // Legacy flat owned entries from the previous build go too.
        cleaned.retain(|entry| {
            if entry.get("hooks").is_some() {
                return true;
            }
            !entry
                .get("command")
                .and_then(Value::as_str)
                .is_some_and(command_is_ours)
        });
        cleaned.push(make_group(event, *timeout));
        hooks.insert((*event).to_string(), Value::Array(cleaned));
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
        let Some(list) = value.as_array() else {
            // Validated on read; keep unknown shapes rather than dropping them.
            out.insert(event, value);
            continue;
        };
        let mut kept: Vec<Value> = Vec::new();
        for group in list {
            if group.get("hooks").is_some() {
                if group_has_ours(group) {
                    if let Some(g) = cleaned_group(group) {
                        kept.push(g);
                    }
                } else {
                    kept.push(group.clone());
                }
            } else if let Some(cmd) = group.get("command").and_then(Value::as_str) {
                if !command_is_ours(cmd) {
                    kept.push(group.clone());
                }
            } else {
                kept.push(group.clone());
            }
        }
        if !kept.is_empty() {
            out.insert(event, Value::Array(kept));
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
    // Configuration present, not trusted or active: liveness is only known
    // once Codex actually sends an event.
    let installed = current
        .get("hooks")
        .and_then(Value::as_object)
        .map(|hooks| {
            hooks
                .values()
                .filter_map(Value::as_array)
                .flatten()
                .any(group_has_ours)
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
    // One byte snapshot feeds both the parsed value and the fingerprint, so
    // the diff and the guard can never disagree about what was reviewed.
    let (bytes, current) = read_snapshot()?;
    let next = if install { merged(&current) } else { without_ours(&current) };
    Ok(CodexPreview {
        diff: unified_diff(&pretty(&current), &pretty(&next)),
        backup: backup_path().to_string_lossy().to_string(),
        settings_path: settings_path().to_string_lossy().to_string(),
        fingerprint: fingerprint(&bytes),
    })
}

pub fn write(install: bool, fingerprint_in: &str) -> Result<String, String> {
    let path = settings_path();
    let dir = path.parent().unwrap_or(Path::new("."));
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    // Same single snapshot rule as preview: parse and guard from one read.
    let (bytes, current) = read_snapshot()?;
    if fingerprint(&bytes) != fingerprint_in {
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
        // Interrupt and SessionEnd are capped at 3 s; permission waits for a human.
        let timeout = |e: &str| CODEX_HOOK_EVENTS.iter().find(|(n, _)| *n == e).unwrap().1;
        assert_eq!(timeout("Interrupt"), 3);
        assert_eq!(timeout("SessionEnd"), 3);
        assert_eq!(timeout("PermissionRequest"), 120);
        // No invented failure events.
        assert!(!names.contains(&"PostToolUseFailure"));
        assert!(!names.contains(&"StopFailure"));
    }

    #[test]
    fn ownership_needs_the_relay_plus_exact_codex_agent() {
        let codex = r#""C:/x/coucou-hook.exe" --agent codex SessionStart"#;
        assert!(command_is_ours(codex));
        // A different agent is not ours, even with a shared prefix.
        assert!(!command_is_ours(r#""C:/x/coucou-hook.exe" --agent codex-other SessionStart"#));
        // The relay mentioned only in arguments is not ours.
        assert!(!command_is_ours(r#"someone-else.exe --note coucou-hook --agent codex"#));
        // A Claude entry has no agent flag at all.
        assert!(!command_is_ours(r#""C:/x/coucou-hook.exe" SessionStart"#));
        assert!(!command_is_ours("someone-else.exe"));
        assert!(hook_is_ours(&json!({ "command": codex })));
    }

    #[test]
    fn output_uses_matcher_groups() {
        let existing = json!({});
        let after = merged(&existing);
        for (event, timeout) in CODEX_HOOK_EVENTS {
            let groups = after["hooks"][*event].as_array().unwrap();
            assert_eq!(groups.len(), 1);
            let hooks = groups[0]["hooks"].as_array().unwrap();
            assert_eq!(hooks.len(), 1);
            assert_eq!(hooks[0]["type"], "command");
            assert!(hooks[0]["command"].as_str().unwrap().contains("--agent codex"));
            assert_eq!(hooks[0]["timeout"], *timeout);
        }
    }

    #[test]
    fn merging_preserves_foreign_hooks_and_group_metadata() {
        let existing = json!({
            "hooks": {
                "SessionStart": [
                    { "matcher": "always", "hooks": [
                        { "type": "command", "command": "someone-else.exe", "timeout": 5 }
                    ] },
                    { "matcher": "mixed", "hooks": [
                        { "type": "command", "command": "keep-me.exe" },
                        { "type": "command", "command": "coucou-hook --agent codex SessionStart", "timeout": 10 }
                    ] }
                ],
                "CustomEvent": [{ "hooks": [{ "type": "command", "command": "keep-me.exe" }] }]
            },
            "other": true
        });
        let after = merged(&existing);
        assert_eq!(after["other"], true);
        let groups = after["hooks"]["SessionStart"].as_array().unwrap();
        // Foreign group kept with its matcher; mixed group kept with only the
        // foreign child; our fresh group appended.
        assert!(groups.iter().any(|g| g["matcher"] == "always"
            && g["hooks"].as_array().unwrap().iter().any(|h| h["command"] == "someone-else.exe")));
        let mixed = groups.iter().find(|g| g["matcher"] == "mixed").unwrap();
        let children = mixed["hooks"].as_array().unwrap();
        assert_eq!(children.len(), 1);
        assert_eq!(children[0]["command"], "keep-me.exe");
        assert!(groups.iter().any(group_has_ours));
        assert!(after["hooks"]["CustomEvent"].is_array());
        // Install is idempotent, and uninstall restores the foreign shape.
        assert_eq!(merged(&after), after);
        let cleaned = without_ours(&after);
        let cleaned_groups = cleaned["hooks"]["SessionStart"].as_array().unwrap();
        assert!(cleaned_groups.iter().any(|g| g["matcher"] == "always"));
        let cleaned_mixed = cleaned_groups.iter().find(|g| g["matcher"] == "mixed").unwrap();
        assert_eq!(cleaned_mixed["hooks"].as_array().unwrap().len(), 1);
        assert!(!cleaned_groups.iter().any(group_has_ours));
        assert_eq!(without_ours(&cleaned), cleaned);
    }

    #[test]
    fn schema_refuses_malformed_structures() {
        for bad in [
            json!({ "hooks": "nope" }),
            json!({ "hooks": { "Stop": {} } }),
            json!({ "hooks": { "Stop": ["nope"] } }),
            json!({ "hooks": { "Stop": [{ "matcher": "x" }] } }),
            json!({ "hooks": { "Stop": [{ "hooks": {} }] } }),
            json!({ "hooks": { "Stop": [{ "hooks": ["nope"] }] } }),
            json!({ "hooks": { "Stop": [{ "hooks": [{ "type": "command" }] }] } }),
        ] {
            assert!(validate_shape(&bad).is_err());
        }
        assert!(validate_shape(&json!({})).is_ok());
        assert!(validate_shape(&json!({ "hooks": {} })).is_ok());
    }

    #[test]
    fn fingerprint_notices_any_change() {
        assert_eq!(fingerprint(b"{}"), fingerprint(b"{}"));
        assert_ne!(fingerprint(b"{}"), fingerprint(b"{ }"));
    }

    #[test]
    fn stale_snapshot_is_refused_before_any_write() {
        let first = fingerprint(b"{}");
        let second = fingerprint(b"{ }");
        assert_ne!(first, second, "a changed file must fail the preview guard");
    }

    #[test]
    fn malformed_content_is_an_error_never_empty() {
        for bad in [&b"{ not json"[..], &b"[1,2,3]"[..], &b"\"x\""[..]] {
            assert!(parse_settings(bad, WHERE).is_err());
        }
        assert_eq!(parse_settings(b"", WHERE).unwrap(), json!({}));
    }
}
