//! coucou-hook — the relay Claude Code runs on every hook event.
//!
//! Reads the hook JSON on stdin, adds a little terminal context, and hands it to
//! Coucou over the named pipe `\\.\pipe\coucou-<sid>` (Windows) or the Unix
//! socket `$XDG_RUNTIME_DIR/coucou.sock` (Linux).
//!
//! Hard rule (docs/CLAUDE.md): **never block Claude Code.**
//! * If the pipe does not exist — Coucou is closed — we exit 0 immediately with
//!   nothing on stdout, and the session carries on untouched.
//! * Every step runs under a deadline enforced by the main thread, so a pipe that
//!   accepts the connection and then stops reading cannot wedge the session
//!   either: we abandon the worker and exit.
//! * Only `PermissionRequest` waits for an answer, because approving from the
//!   island is the whole point. No answer means empty stdout, and Claude Code
//!   asks in the terminal exactly as if Coucou were not installed.
//!
//! Usage: `coucou-hook <EventName>` (the name is also read from the JSON).

use std::io::{Read, Write};
use std::sync::mpsc;
use std::time::Duration;

/// Budget for getting a pipe connection. Beyond this Claude Code wins, always.
const CONNECT_TIMEOUT: Duration = Duration::from_millis(300);
/// Whole-run budget for an event nobody waits on: connect and write, no more.
const FIRE_AND_FORGET_BUDGET: Duration = Duration::from_secs(2);
/// How long a permission prompt may stay on screen before the terminal takes over.
const DECISION_BUDGET: Duration = Duration::from_secs(110);

/// Fields that are pointless to forward and can be enormous (a whole file read,
/// a full command output). The island never shows them. Codex adds its own
/// output carriers next to Claude Code's; only explicit failure booleans
/// derived from them are forwarded (see `codex_tool_failed`).
const DROPPED_FIELDS: &[&str] = &[
    "tool_response",
    "tool_output",
    "output",
    "transcript",
    "transcript_path",
];
/// Longest string forwarded for any single field; the island truncates to far
/// less than this anyway.
const MAX_FIELD_LEN: usize = 2_000;

#[cfg(windows)]
mod win;
#[cfg(windows)]
use win::connect;

#[cfg(target_os = "linux")]
mod unix;
#[cfg(target_os = "linux")]
use unix::connect;

fn main() {
    let Some((payload, event)) = read_event() else { std::process::exit(0) };

    let waits_for_answer = event == "PermissionRequest";
    let budget = if waits_for_answer { DECISION_BUDGET } else { FIRE_AND_FORGET_BUDGET };

    // The worker owns every blocking call. If it overruns the budget we simply
    // stop listening and exit: the process dying takes the pipe handle with it.
    // (No catch_unwind here — the release profile is panic = "abort", so it would
    // be dead code. `talk` is written to have nothing to panic on instead.)
    let (tx, rx) = mpsc::channel::<Option<String>>();
    std::thread::spawn(move || {
        let _ = tx.send(talk(&payload, waits_for_answer));
    });

    if let Ok(Some(decision)) = rx.recv_timeout(budget) {
        if let Some(json) = decision_json(&decision) {
            let mut out = std::io::stdout();
            let _ = writeln!(out, "{json}");
            let _ = out.flush();
        }
    }
    // Nothing printed: Claude Code asks in the terminal, as if we were not here.
    std::process::exit(0);
}

/// The documented PermissionRequest output. Anything we do not recognise prints
/// nothing at all rather than guessing — silence is the safe answer.
/// See https://code.claude.com/docs/en/hooks
fn decision_json(decision: &str) -> Option<String> {
    let behavior = match decision.trim() {
        // "always" still answers a plain allow; remembering it is the island's
        // business, not Claude Code's.
        "allow" | "always" => r#"{"behavior":"allow"}"#.to_string(),
        "deny" => r#"{"behavior":"deny","message":"Denied from Choom"}"#.to_string(),
        _ => return None,
    };
    Some(format!(
        r#"{{"hookSpecificOutput":{{"hookEventName":"PermissionRequest","decision":{behavior}}}}}"#
    ))
}

/// Whether a Codex PostToolUse payload carries an explicit supported failure
/// indicator. Only structured booleans count: a nonzero `exit_code`, an
/// explicit `success: false` / `ok: false`, or a `status` / `outcome` of
/// `failed` / `error`. Raw output text is never parsed, and a failed tool is
/// never confused with a failed turn: this flag only marks the step, the turn
/// outcome is never inferred here.
fn codex_tool_failed(map: &serde_json::Map<String, serde_json::Value>) -> bool {
    let Some(resp) = map.get("tool_response").or_else(|| map.get("tool_output")) else {
        return false;
    };
    if let Some(code) = resp.get("exit_code").and_then(|v| v.as_i64()) {
        if code != 0 {
            return true;
        }
    }
    for key in ["success", "ok"] {
        if resp.get(key) == Some(&serde_json::Value::Bool(false)) {
            return true;
        }
    }
    for key in ["status", "outcome"] {
        if let Some(s) = resp.get(key).and_then(|v| v.as_str()) {
            let lower = s.to_ascii_lowercase();
            if lower == "failed" || lower == "error" {
                return true;
            }
        }
    }
    false
}

/// Supported Codex lifecycle events. Anything else is forwarded untouched and
/// ignored by the island, never turned into state.
fn is_codex_supported_event(event: &str) -> bool {
    matches!(
        event,
        "SessionStart"
            | "SessionEnd"
            | "UserPromptSubmit"
            | "PreToolUse"
            | "PostToolUse"
            | "PermissionRequest"
            | "Stop"
            | "Interrupt"
    )
}

/// Reads stdin and returns the payload to forward plus the event name.
fn read_event() -> Option<(String, String)> {
    let mut raw = Vec::new();
    if std::io::stdin().read_to_end(&mut raw).is_err() || raw.is_empty() {
        return None;
    }
    // Some shells hand us a UTF-8 BOM; serde_json would choke on it.
    if raw.starts_with(&[0xEF, 0xBB, 0xBF]) {
        raw.drain(..3);
    }

    let mut payload = serde_json::from_slice::<serde_json::Value>(&raw).ok()?;
    let map = payload.as_object_mut()?;

    // Parse argv: "coucou-hook.exe [--agent <name>] [<EventName>]"
    // --agent tags the payload with coucou_agent so the app routes to the right pill.
    // Absent or invalid names are validated and discarded by the app, not here.
    let mut agent = String::new();
    let mut arg_event = String::new();
    {
        let mut it = std::env::args().skip(1);
        while let Some(arg) = it.next() {
            if arg == "--agent" {
                agent = it.next().unwrap_or_default();
            } else if arg_event.is_empty() {
                arg_event = arg;
            }
        }
    }
    // Which agent this hook was installed for. Absent means Claude Code,
    // so existing hook commands keep working unchanged.
    if !agent.is_empty() {
        map.insert("coucou_agent".into(), serde_json::Value::String(agent));
    }
    let event = map
        .get("hook_event_name")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .filter(|s| !s.is_empty())
        .unwrap_or(arg_event);
    map.insert("hook_event_name".into(), serde_json::Value::String(event.clone()));

    // Codex failure signal without the raw output: a failed tool marks the
    // step, never the turn. Unsupported Codex events are still forwarded; the
    // island ignores them rather than inventing state.
    let agent_is_codex = map
        .get("coucou_agent")
        .and_then(|v| v.as_str())
        .is_some_and(|a| a == "codex");
    let _codex_supported = if agent_is_codex {
        is_codex_supported_event(&event)
    } else {
        true
    };
    let tool_failed = event == "PostToolUse" && codex_tool_failed(map);

    for field in DROPPED_FIELDS {
        map.remove(*field);
    }
    if tool_failed {
        map.insert(
            "coucou_tool_failed".into(),
            serde_json::Value::Bool(true),
        );
    }

    let cwd_missing = map
        .get("cwd")
        .and_then(|v| v.as_str())
        .map(str::is_empty)
        .unwrap_or(true);
    if cwd_missing {
        if let Ok(cwd) = std::env::current_dir() {
            map.insert(
                "cwd".into(),
                serde_json::Value::String(cwd.to_string_lossy().to_string()),
            );
        }
    }

    // Which terminal the session runs in. Unlike macOS, Coucou here accepts
    // events from every terminal, so this is context only — never a filter.
    for (key, var) in [
        ("term_program", "TERM_PROGRAM"),
        ("wt_session", "WT_SESSION"),
        ("term_session_id", "TERM_SESSION_ID"),
        ("vscode_pid", "VSCODE_PID"),
        ("session_pid", "CLAUDE_CODE_SSE_PORT"),
    ] {
        if !map.contains_key(key) {
            let value = std::env::var(var).unwrap_or_default();
            map.insert(key.into(), serde_json::Value::String(value));
        }
    }

    truncate_strings(&mut payload);

    let mut line = payload.to_string();
    line.push('\n');
    Some((line, event))
}

/// Caps every string in the payload. A single Write can carry a whole file.
fn truncate_strings(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::String(s) => {
            if s.len() > MAX_FIELD_LEN {
                // Cut on a char boundary; a lone byte index can split UTF-8.
                let mut end = MAX_FIELD_LEN;
                while end > 0 && !s.is_char_boundary(end) {
                    end -= 1;
                }
                s.truncate(end);
                s.push('…');
            }
        }
        serde_json::Value::Array(items) => items.iter_mut().for_each(truncate_strings),
        serde_json::Value::Object(map) => map.values_mut().for_each(truncate_strings),
        _ => {}
    }
}

/// Connect, send, and — for a permission request — wait for the island's word.
fn talk(payload: &str, waits_for_answer: bool) -> Option<String> {
    let mut pipe = connect()?;

    if pipe.write_all(payload.as_bytes()).is_err() {
        return None;
    }
    let _ = pipe.flush();

    if !waits_for_answer {
        return None;
    }

    let mut buf = Vec::new();
    let mut chunk = [0u8; 1024];
    loop {
        match pipe.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if buf.contains(&b'\n') {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    let answer = String::from_utf8_lossy(&buf).trim().to_string();
    (!answer.is_empty()).then_some(answer)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decision_json_matches_the_documented_shape() {
        assert_eq!(
            decision_json("allow").unwrap(),
            r#"{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}"#
        );
        assert_eq!(
            decision_json("deny").unwrap(),
            r#"{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Denied from Choom"}}}"#
        );
        // "always" is an island concept; Claude Code just gets an allow.
        assert!(decision_json("always").unwrap().contains(r#""behavior":"allow""#));
    }

    #[test]
    fn anything_unrecognised_prints_nothing() {
        assert!(decision_json("").is_none());
        assert!(decision_json("maybe").is_none());
        // The shape the app used to send must not be mistaken for a decision.
        assert!(decision_json(r#"{"permissionDecision":"allow"}"#).is_none());
    }

    #[test]
    fn long_strings_are_cut_on_a_char_boundary() {
        let mut v = serde_json::json!({ "tool_input": { "content": "é".repeat(4000) } });
        truncate_strings(&mut v);
        let s = v["tool_input"]["content"].as_str().unwrap();
        assert!(s.len() <= MAX_FIELD_LEN + 4);
        assert!(s.ends_with('…'));
    }

    #[test]
    fn codex_permission_decision_matches_the_official_shape() {
        // Verified reference: hookSpecificOutput.decision.behavior allow/deny,
        // empty output defers to Codex.
        assert!(decision_json("allow").unwrap().contains(r#""hookEventName":"PermissionRequest""#));
        assert!(decision_json("deny").unwrap().contains(r#""behavior":"deny""#));
        assert!(decision_json("").is_none());
    }

    #[test]
    fn codex_supported_events_are_exactly_the_official_set() {
        for e in [
            "SessionStart",
            "SessionEnd",
            "UserPromptSubmit",
            "PreToolUse",
            "PostToolUse",
            "PermissionRequest",
            "Stop",
            "Interrupt",
        ] {
            assert!(is_codex_supported_event(e), "{e} must be supported");
        }
        for e in ["PostToolUseFailure", "StopFailure", "Notification", "SubagentStart", "Bogus"] {
            assert!(!is_codex_supported_event(e), "{e} must not fabricate state");
        }
    }

    #[test]
    fn codex_failure_flag_needs_an_explicit_indicator() {
        let failed_exit = serde_json::json!({ "tool_response": { "exit_code": 1 } });
        assert!(codex_tool_failed(failed_exit.as_object().unwrap()));
        let failed_bool = serde_json::json!({ "tool_response": { "success": false } });
        assert!(codex_tool_failed(failed_bool.as_object().unwrap()));
        let failed_status = serde_json::json!({ "tool_output": { "status": "failed" } });
        assert!(codex_tool_failed(failed_status.as_object().unwrap()));
        // Raw text output never counts; a zero exit is success.
        let text = serde_json::json!({ "tool_response": { "text": "error: something broke" } });
        assert!(!codex_tool_failed(text.as_object().unwrap()));
        let ok = serde_json::json!({ "tool_response": { "exit_code": 0 } });
        assert!(!codex_tool_failed(ok.as_object().unwrap()));
        let none = serde_json::json!({ "hook_event_name": "PostToolUse" });
        assert!(!codex_tool_failed(none.as_object().unwrap()));
    }

    #[test]
    fn codex_output_fields_are_dropped_before_forwarding() {
        for f in ["tool_response", "tool_output", "output", "transcript", "transcript_path"] {
            assert!(DROPPED_FIELDS.contains(&f), "{f} must not be forwarded");
        }
        // Permission deadlines: fire-and-forget 2 s, decision 110 s (under the
        // 120 s hook timeout); Interrupt stays under its 3 s cap because only
        // PermissionRequest waits at all.
        assert_eq!(FIRE_AND_FORGET_BUDGET, Duration::from_secs(2));
        assert_eq!(DECISION_BUDGET, Duration::from_secs(110));
    }
}
