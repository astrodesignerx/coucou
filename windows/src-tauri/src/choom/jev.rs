// Jev decision layer for Choom: a bounded request classifier behind voice
// and typed submissions. Exact local media, saved launches, routines, wake
// and cancellation stay independent of Jev. Shadow records the proposed
// decision without altering execution. Assisted may only choose between
// answering and showing options or clarification. It never invents or
// executes a tool target, shell command, approval or provider switch.
//
// Cloud input is limited to the current explicitly submitted request plus
// compact capability labels. No screenshots, file bodies, memory, history
// or credentials leave the device. Local history keeps route label, mode,
// confidence, latency and fallback reason only.

use std::collections::HashSet;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;

use crate::choom::voice::VoiceRuntime;

/// Exact Zen endpoint and model. Never substitute another ID.
pub const JEV_ENDPOINT: &str = "https://opencode.ai/zen/v1/systemone";
pub const JEV_MODEL: &str = "jev-1.13-free";
/// Classifier labels. Nothing else is accepted from the model.
pub const JEV_LABELS: &[&str] = &["answer", "options", "clarify", "supported_local", "unknown"];
/// Default abstention threshold. Below this the outcome falls back.
pub const JEV_THRESHOLD_DEFAULT: f64 = 0.75;
/// Bounded cloud input and candidate caps.
pub const MAX_REQUEST_CHARS: usize = 500;
pub const MAX_CANDIDATES: usize = 12;
pub const MAX_CANDIDATE_LABEL_CHARS: usize = 60;
/// Bounded local receipt history.
pub const MAX_HISTORY: usize = 20;
/// Bounded deadline defaults and clamps (ms).
pub const JEV_DEADLINE_DEFAULT_MS: u64 = 2500;
pub const JEV_DEADLINE_MIN_MS: u64 = 500;
pub const JEV_DEADLINE_MAX_MS: u64 = 8000;
/// Bounded HTTP response body. Anything larger is rejected, never logged.
pub const MAX_RESPONSE_BYTES: usize = 32768;
/// Agreement tolerance between the reported confidence and the selected
/// probability. A forged confidence field never overrides the distribution.
pub const CONFIDENCE_AGREE_TOLERANCE: f64 = 0.01;
/// Probability normalization tolerance: the five probabilities must sum to 1.
pub const PROBABILITY_SUM_TOLERANCE: f64 = 0.01;

/// One eligible local capability offered to the classifier.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JevCandidate {
    pub id: String,
    pub label: String,
}

/// One distribution entry from the classifier. Kept for history shape
/// compatibility; the typed endpoint carries probabilities as a map.
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct JevDistEntry {
    pub key: String,
    pub label: String,
    pub probability: f64,
}

/// Bounded classifier outcome returned to the island.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JevOutcome {
    pub route: String,
    pub confidence: f64,
    pub latency_ms: u64,
    pub fallback_reason: Option<String>,
    pub mode: String,
    pub candidate_id: Option<String>,
}

/// Sanitized local receipt. No raw user content and no hidden reasoning.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JevReceipt {
    pub route: String,
    pub mode: String,
    pub confidence: f64,
    pub latency_ms: u64,
    pub fallback_reason: Option<String>,
    pub at_ms: u64,
}

/// Availability snapshot for the settings UI. Metadata only.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JevStatus {
    pub enabled: bool,
    pub mode: String,
    pub configured: bool,
    pub model: String,
    pub endpoint: String,
    pub threshold: f64,
    pub deadline_ms: u64,
}

#[derive(Debug, Default)]
pub struct JevState {
    history: Mutex<Vec<JevReceipt>>,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn valid_label(label: &str) -> bool {
    JEV_LABELS.contains(&label)
}

pub fn clamp_threshold(value: f64) -> f64 {
    if !value.is_finite() {
        return JEV_THRESHOLD_DEFAULT;
    }
    // Approved confidence minimum: never below 0.75.
    value.clamp(0.75, 0.95)
}

pub fn clamp_deadline_ms(value: u64) -> u64 {
    value.clamp(JEV_DEADLINE_MIN_MS, JEV_DEADLINE_MAX_MS)
}

pub fn normalize_mode(mode: &str) -> String {
    match mode {
        "off" => "off".to_string(),
        "assisted" => "assisted".to_string(),
        _ => "shadow".to_string(),
    }
}

/// Whether a network call may happen at all. Network stays off until the
/// user explicitly enables Jev, picks a non-off mode and has a credential.
pub fn jev_eligible(enabled: bool, mode: &str, has_credential: bool) -> bool {
    enabled && mode != "off" && has_credential
}

/// Compact request validation. Empty is rejected, long input is truncated
/// for the cloud body only.
pub fn validate_request(request: &str) -> Result<String, String> {
    let trimmed = request.trim();
    if trimmed.is_empty() {
        return Err("Empty request.".to_string());
    }
    Ok(trimmed.chars().take(MAX_REQUEST_CHARS).collect())
}

/// Candidate validation: bounded count, non-empty unique ids, bounded labels.
pub fn validate_candidates(candidates: &[JevCandidate]) -> Result<Vec<JevCandidate>, String> {
    if candidates.len() > MAX_CANDIDATES {
        return Err(format!("Too many candidates (max {MAX_CANDIDATES})."));
    }
    let mut seen = HashSet::new();
    let mut out = Vec::with_capacity(candidates.len());
    for c in candidates {
        let id = c.id.trim();
        if id.is_empty() || id.len() > 64 {
            return Err("Candidate id must be 1 to 64 chars.".to_string());
        }
        if !seen.insert(id.to_string()) {
            return Err("Candidate ids must be unique.".to_string());
        }
        let label: String = c.label.trim().chars().take(MAX_CANDIDATE_LABEL_CHARS).collect();
        if label.is_empty() {
            return Err("Candidate label must not be empty.".to_string());
        }
        out.push(JevCandidate { id: id.to_string(), label });
    }
    Ok(out)
}

/// Parses the typed Jev choice response at answers.intent. Jev cannot
/// generate prose or JSON on instruction, so no generative shape is accepted.
/// Enforces type choice, a known chosen label, finite confidence and
/// probabilities in 0..1, a complete set of unique known keys, probability
/// normalization, and agreement between the confidence field and the selected
/// probability. Threshold abstention maps low confidence to unknown.
pub fn parse_distribution(
    value: &Value,
    _eligible: &[JevCandidate],
    threshold: f64,
) -> Result<(String, f64, Option<String>), String> {
    let threshold = clamp_threshold(threshold);
    let intent = value
        .get("answers")
        .and_then(|a| a.get("intent"))
        .ok_or_else(|| "Classifier response missing answers.intent.".to_string())?;
    let kind = intent
        .get("type")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Classifier intent missing type.".to_string())?;
    if kind != "choice" {
        return Err("Classifier intent is not a choice.".to_string());
    }
    let choice = intent
        .get("choice")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Classifier intent missing choice.".to_string())?;
    if !valid_label(choice) {
        return Err(format!("Unknown classifier label: {choice}"));
    }
    let confidence = intent
        .get("confidence")
        .and_then(|v| v.as_f64())
        .ok_or_else(|| "Classifier intent missing confidence.".to_string())?;
    if !confidence.is_finite() || confidence < 0.0 || confidence > 1.0 {
        return Err("Classifier probability out of range.".to_string());
    }
    let probabilities = intent
        .get("probabilities")
        .and_then(|v| v.as_object())
        .ok_or_else(|| "Classifier intent missing probabilities.".to_string())?;
    if probabilities.len() != JEV_LABELS.len() {
        return Err("Classifier distribution has wrong size.".to_string());
    }
    let mut sum = 0.0;
    for label in JEV_LABELS {
        let p = probabilities
            .get(*label)
            .and_then(|v| v.as_f64())
            .ok_or_else(|| format!("Classifier probabilities missing {label}."))?;
        if !p.is_finite() || p < 0.0 || p > 1.0 {
            return Err("Classifier probability out of range.".to_string());
        }
        sum += p;
    }
    if probabilities.keys().any(|k| !JEV_LABELS.contains(&k.as_str())) {
        return Err("Classifier probabilities carry an unknown label.".to_string());
    }
    if (sum - 1.0).abs() > PROBABILITY_SUM_TOLERANCE {
        return Err("Classifier probabilities do not normalize.".to_string());
    }
    let selected = probabilities
        .get(choice)
        .and_then(|v| v.as_f64())
        .ok_or_else(|| "Classifier probabilities missing choice.".to_string())?;
    if (confidence - selected).abs() > CONFIDENCE_AGREE_TOLERANCE {
        return Err("Classifier confidence disagrees with probabilities.".to_string());
    }
    if choice == "unknown" || confidence < threshold {
        return Ok(("unknown".to_string(), confidence, None));
    }
    // No candidate inference in this integration: a supported_local route
    // returns without a target and the island shows explicit user options.
    // Candidate ranking would need a separate typed Choice over actual IDs.
    Ok((choice.to_string(), confidence, None))
}

fn fallback_outcome(mode: &str, reason: &str, latency_ms: u64) -> JevOutcome {
    JevOutcome {
        route: "unknown".to_string(),
        confidence: 0.0,
        latency_ms,
        fallback_reason: Some(reason.to_string()),
        mode: normalize_mode(mode),
        candidate_id: None,
    }
}

/// Appends one response chunk under the cumulative cap. Rejects the body
/// before it can grow past MAX_RESPONSE_BYTES.
pub fn bounded_append(buf: &mut Vec<u8>, chunk: &[u8]) -> Result<(), String> {
    if buf.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
        return Err("invalid-response".to_string());
    }
    buf.extend_from_slice(chunk);
    Ok(())
}

/// Reads the response body in chunks under one cumulative cap. An excessive
/// content length is rejected before any byte is read.
async fn read_bounded_text(mut resp: reqwest::Response) -> Result<String, String> {
    if let Some(len) = resp.content_length() {
        if len > MAX_RESPONSE_BYTES as u64 {
            return Err("invalid-response".to_string());
        }
    }
    let mut buf = Vec::new();
    loop {
        match resp.chunk().await {
            Err(_) => return Err("unavailable".to_string()),
            Ok(None) => break,
            Ok(Some(chunk)) => bounded_append(&mut buf, &chunk)?,
        }
    }
    String::from_utf8(buf).map_err(|_| "invalid-response".to_string())
}

fn record_receipt(state: &JevState, outcome: &JevOutcome) {    let mut history = state.history.lock().unwrap();
    history.push(JevReceipt {
        route: outcome.route.clone(),
        mode: outcome.mode.clone(),
        confidence: outcome.confidence,
        latency_ms: outcome.latency_ms,
        fallback_reason: outcome.fallback_reason.clone(),
        at_ms: now_ms(),
    });
    while history.len() > MAX_HISTORY {
        history.remove(0);
    }
}

/// Typed questions body. Jev answers the intent Choice; it never receives
/// a generative instruction and never returns prose or JSON on instruction.
/// State carries the bounded request plus compact eligible capability labels.
fn request_body(request: &str, candidates: &[JevCandidate]) -> Value {
    let mut labels = String::new();
    for c in candidates {
        if !labels.is_empty() {
            labels.push_str(", ");
        }
        labels.push_str(&c.label);
    }
    let state = if labels.is_empty() {
        request.to_string()
    } else {
        format!("{request}\n\nAvailable local actions: {labels}")
    };
    serde_json::json!({
        "model": JEV_MODEL,
        "state": state,
        "questions": {
            "intent": {
                "type": "choice",
                "instructions": "Choose the requested response type. Do not execute anything.",
                "criteria": {
                    "answer": "Explain information.",
                    "options": "Present choices when explicitly requested.",
                    "clarify": "Required information is missing.",
                    "supported_local": "An exact available local action is requested.",
                    "unknown": "None of these labels fit."
                }
            }
        }
    })
}

/// Bounded classifier call. Invalid, unavailable, timed-out or
/// low-confidence outcomes fall back to the existing agent path.
#[tauri::command]
pub async fn jev_decide(
    rt: State<'_, VoiceRuntime>,
    jev: State<'_, JevState>,
    shared: State<'_, crate::Shared>,
    request: String,
    candidates: Vec<JevCandidate>,
    generation: Option<u64>,
) -> Result<JevOutcome, String> {
    let started = Instant::now();
    let (enabled, mode, threshold, deadline_ms) = {
        let s = shared.settings.lock().unwrap();
        (s.jev_enabled, s.jev_mode.clone(), s.jev_threshold, s.jev_deadline_ms)
    };
    let mode = normalize_mode(&mode);
    let threshold = clamp_threshold(threshold);
    let deadline = clamp_deadline_ms(if deadline_ms == 0 { JEV_DEADLINE_DEFAULT_MS } else { deadline_ms });
    // Cancellation fence: an explicitly supplied generation is always
    // checked, including gen 0. Unfenced callers pass None instead.
    if let Some(gen) = generation {
        if rt.is_stale(gen) {
            return Err("That turn was cancelled.".to_string());
        }
    }
    let request = validate_request(&request).map_err(|e| {
        let outcome = fallback_outcome(&mode, "invalid-request", started.elapsed().as_millis() as u64);
        let _ = e;
        record_receipt(&jev, &outcome);
        outcome.fallback_reason.clone().unwrap_or_default()
    })?;
    let eligible = validate_candidates(&candidates).map_err(|_| "invalid-candidates".to_string())?;
    if !jev_eligible(enabled, &mode, crate::secrets::present("opencode-api-key")) {
        let reason = if !enabled || mode == "off" { "disabled" } else { "missing-credential" };
        let outcome = fallback_outcome(&mode, reason, started.elapsed().as_millis() as u64);
        return Ok(outcome);
    }
    let key = crate::secrets::get("opencode-api-key").ok_or_else(|| "missing-credential".to_string())?;
    let body = request_body(&request, &eligible);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(deadline))
        .build()
        .map_err(|e| e.to_string())?;
    // The whole exchange, send plus bounded body read, runs under one
    // deadline. Rejected payloads are never logged; only a sanitized reason
    // is recorded. Secrets never leave the bearer header.
    let exchange = tokio::time::timeout(
        Duration::from_millis(deadline),
        async {
            let resp = client
                .post(JEV_ENDPOINT)
                .bearer_auth(key)
                .header("content-type", "application/json")
                .json(&body)
                .send()
                .await
                .map_err(|e| {
                    if e.is_timeout() {
                        "timeout".to_string()
                    } else {
                        "unavailable".to_string()
                    }
                })?;
            if !resp.status().is_success() {
                let reason = match resp.status().as_u16() {
                    401 | 403 => "missing-credential",
                    402 => "unavailable",
                    404 => "unavailable",
                    408 => "timeout",
                    _ => "unavailable",
                };
                return Err(reason.to_string());
            }
            let text = read_bounded_text(resp).await?;
            serde_json::from_str::<Value>(&text).map_err(|_| "invalid-response".to_string())
        },
    )
    .await;
    let latency = started.elapsed().as_millis() as u64;
    let outcome = match exchange {
        Err(_) => fallback_outcome(&mode, "timeout", latency),
        Ok(Err(reason)) => fallback_outcome(&mode, &reason, latency),
        Ok(Ok(value)) => match parse_distribution(&value, &eligible, threshold) {
            Err(_) => fallback_outcome(&mode, "invalid-response", latency),
            Ok((route, confidence, candidate_id)) => {
                if route == "unknown" {
                    let explicit_abstention = value.get("answers")
                        .and_then(|a| a.get("intent"))
                        .and_then(|a| a.get("choice"))
                        .and_then(Value::as_str) == Some("unknown");
                    let mut outcome = fallback_outcome(&mode,
                        if explicit_abstention { "abstain" } else { "low-confidence" }, latency);
                    outcome.confidence = confidence;
                    outcome
                } else {
                    JevOutcome {
                        route,
                        confidence,
                        latency_ms: latency,
                        fallback_reason: None,
                        mode: mode.clone(),
                        candidate_id,
                    }
                }
            }
        },
    };
    // A stale turn that finished late never records or acts.
    if let Some(gen) = generation {
        if rt.is_stale(gen) {
            return Err("That turn was cancelled.".to_string());
        }
    }
    record_receipt(&jev, &outcome);
    Ok(outcome)
}

#[tauri::command]
pub fn jev_status(shared: State<'_, crate::Shared>) -> JevStatus {
    let s = shared.settings.lock().unwrap();
    let mode = normalize_mode(&s.jev_mode);
    JevStatus {
        enabled: s.jev_enabled,
        mode,
        configured: crate::secrets::present("opencode-api-key"),
        model: JEV_MODEL.to_string(),
        endpoint: JEV_ENDPOINT.to_string(),
        threshold: clamp_threshold(s.jev_threshold),
        deadline_ms: clamp_deadline_ms(if s.jev_deadline_ms == 0 {
            JEV_DEADLINE_DEFAULT_MS
        } else {
            s.jev_deadline_ms
        }),
    }
}

#[tauri::command]
pub fn jev_history(jev: State<'_, JevState>) -> Vec<JevReceipt> {
    jev.history.lock().unwrap().clone()
}

#[tauri::command]
pub fn jev_clear_history(jev: State<'_, JevState>) {
    jev.history.lock().unwrap().clear();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn eligible() -> Vec<JevCandidate> {
        vec![
            JevCandidate { id: "notes".to_string(), label: "Notes".to_string() },
            JevCandidate { id: "code".to_string(), label: "Code".to_string() },
        ]
    }

    fn typed(choice: &str, confidence: f64, probs: serde_json::Value) -> serde_json::Value {
        serde_json::json!({
            "answers": {
                "intent": {
                    "type": "choice",
                    "choice": choice,
                    "confidence": confidence,
                    "probabilities": probs,
                }
            }
        })
    }

    fn full_probs(answer: f64, options: f64, clarify: f64, supported_local: f64, unknown: f64) -> serde_json::Value {
        serde_json::json!({
            "answer": answer,
            "options": options,
            "clarify": clarify,
            "supported_local": supported_local,
            "unknown": unknown,
        })
    }

    #[test]
    fn live_typed_response_parses_to_answer() {
        // Sanitized shape of the verified live POST for model jev-1.13-free:
        // state "Explain what a computer folder is.", HTTP 200.
        let value = serde_json::json!({
            "answers": {
                "intent": {
                    "type": "choice",
                    "choice": "answer",
                    "confidence": 0.99,
                    "probabilities": {
                        "answer": 0.99,
                        "options": 0.01,
                        "clarify": 0.0,
                        "supported_local": 0.0,
                        "unknown": 0.0,
                    }
                }
            },
            "usage": { "input_tokens": 381, "output_tokens": 54 }
        });
        let (route, conf, cand) = parse_distribution(&value, &eligible(), 0.75).unwrap();
        assert_eq!(route, "answer");
        assert_eq!(conf, 0.99);
        assert!(cand.is_none());
    }

    #[test]
    fn request_body_uses_typed_questions_not_generative_instruction() {
        let candidates = eligible();
        let body = request_body("Explain what a computer folder is.", &candidates);
        assert_eq!(body.get("model").and_then(|v| v.as_str()), Some(JEV_MODEL));
        let state = body.get("state").and_then(|v| v.as_str()).unwrap();
        assert!(state.contains("Explain what a computer folder is."));
        assert!(state.contains("Notes"));
        assert!(body.get("instruction").is_none());
        assert!(body.get("input").is_none());
        let intent = &body["questions"]["intent"];
        assert_eq!(intent.get("type").and_then(|v| v.as_str()), Some("choice"));
        for label in JEV_LABELS {
            assert!(intent["criteria"].get(*label).is_some(), "criteria missing {label}");
        }
    }

    #[test]
    fn malformed_typed_responses_are_rejected() {
        assert!(parse_distribution(&serde_json::json!({}), &eligible(), 0.75).is_err());
        assert!(parse_distribution(
            &serde_json::json!({"answers": {}}),
            &eligible(),
            0.75
        )
        .is_err());
        // Wrong intent type: Jev answers choices, nothing else.
        let mut wrong_type = typed("answer", 0.9, full_probs(0.9, 0.1, 0.0, 0.0, 0.0));
        wrong_type["answers"]["intent"]["type"] = serde_json::json!("text");
        assert!(parse_distribution(&wrong_type, &eligible(), 0.75).is_err());
        // Missing confidence and probabilities are rejected.
        let mut no_conf = typed("answer", 0.9, full_probs(0.9, 0.1, 0.0, 0.0, 0.0));
        no_conf["answers"]["intent"].as_object_mut().unwrap().remove("confidence");
        assert!(parse_distribution(&no_conf, &eligible(), 0.75).is_err());
    }

    #[test]
    fn unknown_labels_are_rejected() {
        let value = typed("execute", 0.99, full_probs(0.0, 0.0, 0.0, 0.0, 0.0));
        assert!(parse_distribution(&value, &eligible(), 0.75).is_err());
        let mut extra = typed("answer", 0.9, full_probs(0.9, 0.1, 0.0, 0.0, 0.0));
        extra["answers"]["intent"]["probabilities"]["launch"] = serde_json::json!(0.0);
        assert!(parse_distribution(&extra, &eligible(), 0.75).is_err());
        let mut missing = typed("answer", 0.9, full_probs(0.9, 0.1, 0.0, 0.0, 0.0));
        missing["answers"]["intent"]["probabilities"]
            .as_object_mut()
            .unwrap()
            .remove("unknown");
        assert!(parse_distribution(&missing, &eligible(), 0.75).is_err());
    }

    #[test]
    fn unnormalized_probabilities_are_rejected() {
        let value = typed("answer", 0.6, full_probs(0.6, 0.1, 0.0, 0.0, 0.0));
        assert!(parse_distribution(&value, &eligible(), 0.75).is_err());
    }

    #[test]
    fn forged_confidence_is_rejected() {
        // Confidence 0.99 disagrees with the selected probability 0.4.
        let value = typed("answer", 0.99, full_probs(0.4, 0.3, 0.2, 0.1, 0.0));
        assert!(parse_distribution(&value, &eligible(), 0.75).is_err());
    }

    #[test]
    fn low_confidence_abstains_to_unknown() {
        let value = typed("answer", 0.5, full_probs(0.5, 0.3, 0.1, 0.05, 0.05));
        let (route, _, _) = parse_distribution(&value, &eligible(), 0.75).unwrap();
        assert_eq!(route, "unknown");
        let value = typed("unknown", 0.6, full_probs(0.1, 0.1, 0.1, 0.1, 0.6));
        // Below-threshold unknown choice still abstains through the same path.
        let (route, _, _) = parse_distribution(&value, &eligible(), 0.95).unwrap();
        assert_eq!(route, "unknown");
    }

    #[test]
    fn supported_local_returns_without_candidate_inference() {
        let value = typed("supported_local", 0.9, full_probs(0.05, 0.05, 0.0, 0.9, 0.0));
        let (route, conf, cand) = parse_distribution(&value, &eligible(), 0.75).unwrap();
        assert_eq!(route, "supported_local");
        assert_eq!(conf, 0.9);
        assert!(cand.is_none());
    }

    #[test]
    fn non_finite_and_out_of_range_probabilities_rejected() {
        let value = typed("answer", 1.5, full_probs(0.9, 0.1, 0.0, 0.0, 0.0));
        assert!(parse_distribution(&value, &eligible(), 0.75).is_err());
        let value = typed("answer", -0.1, full_probs(0.9, 0.1, 0.0, 0.0, 0.0));
        assert!(parse_distribution(&value, &eligible(), 0.75).is_err());
    }

    #[test]
    fn stale_generations_never_act() {
        assert!(crate::choom::voice::is_stale(7, 6));
        assert!(!crate::choom::voice::is_stale(7, 7));
        // An explicitly supplied gen 0 is checked like any other: when the
        // runtime has moved on, gen 0 is stale and never acts.
        let rt = crate::choom::voice::VoiceRuntime::default();
        rt.next_generation();
        assert!(rt.is_stale(0));
    }

    #[test]
    fn missing_credential_and_disabled_mode_are_ineligible() {
        assert!(!jev_eligible(false, "shadow", true));
        assert!(!jev_eligible(true, "off", true));
        assert!(!jev_eligible(true, "shadow", false));
        assert!(jev_eligible(true, "shadow", true));
        assert!(jev_eligible(true, "assisted", true));
    }

    #[test]
    fn request_and_candidate_bounds() {
        assert!(validate_request("   ").is_err());
        let long = "x".repeat(2000);
        assert_eq!(validate_request(&long).unwrap().chars().count(), MAX_REQUEST_CHARS);
        let dupes = vec![
            JevCandidate { id: "a".to_string(), label: "A".to_string() },
            JevCandidate { id: "a".to_string(), label: "B".to_string() },
        ];
        assert!(validate_candidates(&dupes).is_err());
        let many = (0..20)
            .map(|i| JevCandidate { id: format!("id-{i}"), label: "L".to_string() })
            .collect::<Vec<_>>();
        assert!(validate_candidates(&many).is_err());
    }

    #[test]
    fn deadline_and_threshold_clamp_to_bounds() {
        assert_eq!(clamp_deadline_ms(10), JEV_DEADLINE_MIN_MS);
        assert_eq!(clamp_deadline_ms(50_000), JEV_DEADLINE_MAX_MS);
        assert_eq!(clamp_deadline_ms(2500), 2500);
        assert_eq!(clamp_threshold(f64::NAN), JEV_THRESHOLD_DEFAULT);
        // Approved minimum: nothing below 0.75 is ever kept.
        assert_eq!(clamp_threshold(0.1), 0.75);
        assert_eq!(clamp_threshold(0.6), 0.75);
        assert_eq!(clamp_threshold(0.75), 0.75);
        assert_eq!(clamp_threshold(0.8), 0.8);
        assert_eq!(clamp_threshold(0.99), 0.95);
    }

    #[test]
    fn timeout_and_unavailable_shape_is_a_fallback_not_a_panic() {
        let outcome = fallback_outcome("shadow", "timeout", 12);
        assert_eq!(outcome.route, "unknown");
        assert_eq!(outcome.fallback_reason.as_deref(), Some("timeout"));
        let outcome = fallback_outcome("assisted", "unavailable", 12);
        assert_eq!(outcome.mode, "assisted");
    }

    #[test]
    fn oversized_response_bodies_are_rejected_by_size() {
        assert!(MAX_RESPONSE_BYTES >= 8192);
        let mut buf = Vec::new();
        assert!(bounded_append(&mut buf, &[1, 2, 3]).is_ok());
        assert_eq!(buf, vec![1, 2, 3]);
        // Exactly at the cap is accepted.
        let mut full = vec![0u8; MAX_RESPONSE_BYTES - 3];
        assert!(bounded_append(&mut full, &[1, 2, 3]).is_ok());
        assert_eq!(full.len(), MAX_RESPONSE_BYTES);
        // One byte past the cap is rejected, and the buffer is untouched.
        assert!(bounded_append(&mut full, &[4]).is_err());
        assert_eq!(full.len(), MAX_RESPONSE_BYTES);
        // A single oversized chunk is rejected without appending.
        let mut empty = Vec::new();
        assert!(bounded_append(&mut empty, &vec![0u8; MAX_RESPONSE_BYTES + 1]).is_err());
        assert!(empty.is_empty());
    }

    #[test]
    fn model_id_is_exact_and_endpoint_is_exact() {
        assert_eq!(JEV_MODEL, "jev-1.13-free");
        assert_eq!(JEV_ENDPOINT, "https://opencode.ai/zen/v1/systemone");
    }
}
