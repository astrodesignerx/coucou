// Laya is the local, offline decision worker for Choom. It replaces the cloud
// Jev call with one privately owned Python process: the adapter starts a
// single child, waits for a real warm-up inference, then admits one bounded
// request at a time over a strict JSON line protocol on stdin and stdout.
//
// Nothing leaves the machine. There is no HTTP server, no download, no cloud
// fallback and no credential in the worker or in its manifest. The worker
// only ever picks one of five fixed route labels, so it cannot produce an
// executable command, a path, a note body, a capability id or a permission
// decision.
//
// The ownership rules this file keeps:
//   * one child and one inference in flight, serialized by one admission lock;
//   * Stop, cancel and timeout kill the child and wait for it before any new
//     worker may be admitted, so a late answer never lands in a newer turn;
//   * no lock is ever held across the blocking read, the inference or the
//     process wait, so a cancellation is never stuck behind a worker;
//   * the shared voice generation is checked before dispatch and again after
//     the response, and request ids and generations must match exactly;
//   * stdout and stderr are bounded, the JSON is strict, and no error string
//     or local receipt ever carries the request text.
//
// Readiness is never inferred from the presence of files. Only a worker that
// has answered its real warm-up inference reports ready, and a runtime the
// user has not pointed at in Settings stays missing.

use std::ffi::OsString;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Condvar, Mutex, Once};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;
use tauri::State;

use crate::choom::voice::{FlowFence, VoiceRuntime};

/// The worker source file. Resolved beside the binary, then the audited repo
/// copy, then a staged copy in the owned local data directory.
pub const WORKER_FILE: &str = "choom-laya.py";
/// The only five labels the worker may return. Nothing else is ever accepted.
pub const LAYA_LABELS: &[&str] =
    &["answer", "options", "clarify", "supported_local", "unknown"];
/// The online engine: the hosted Jev classifier. The default, so every
/// settings file written before Local Laya existed keeps behaving exactly as
/// it did.
pub const ENGINE_JEV: &str = "jev";
/// The local engine: this offline worker. It has no cloud mode, so selecting
/// it removes every automatic remote call from the voice decision path.
pub const ENGINE_LAYA: &str = "laya";
/// The neutral probe text the readiness check warms the model with. It names
/// no target, performs no action and is never recorded as a user decision.
pub const LAYA_PROBE_TEXT: &str = "engine check";
/// Provisional abstention threshold, deliberately separate from the Jev
/// threshold: local selection probabilities are not calibrated against the
/// cloud model, so the default stays conservative and means clarify, never a
/// guess and never a silent fallback.
pub const LAYA_THRESHOLD_DEFAULT: f64 = 0.85;
pub const LAYA_THRESHOLD_MIN: f64 = 0.75;
pub const LAYA_THRESHOLD_MAX: f64 = 0.95;
/// Startup deadline. The measured local model load is about 11 seconds, so
/// this is generous on purpose: a cold or busy CPU must not report a failure
/// where the worker was about to answer.
pub const LAYA_STARTUP_TIMEOUT_MS: u64 = 120_000;
/// One decision deadline, separate from the startup deadline.
pub const LAYA_DECISION_TIMEOUT_MS: u64 = 10_000;
/// Idle unload: an unused worker is torn down, so it never holds its working
/// set for the rest of the session.
pub const LAYA_IDLE_UNLOAD_MS: u64 = 30_000;
/// Request text cap, matching the worker.
pub const LAYA_MAX_TEXT_CHARS: usize = 500;
/// Protocol line cap. Anything longer is refused, never grown.
pub const LAYA_MAX_LINE_BYTES: usize = 32768;
/// stderr tail kept in memory for diagnostics. Never logged, never surfaced.
pub const LAYA_MAX_STDERR_BYTES: usize = 2048;
/// Bounded local receipt history: route label, confidence and latency only.
pub const LAYA_MAX_HISTORY: usize = 20;
/// The five probabilities must sum to one.
pub const LAYA_SUM_TOLERANCE: f64 = 0.01;
/// The reported selected probability must agree with the distribution.
pub const LAYA_AGREE_TOLERANCE: f64 = 0.01;
/// Consecutive non-JSON stdout lines tolerated before the stream is refused.
pub const LAYA_MAX_JUNK_LINES: u32 = 32;
/// Queued stdout lines the reader may hold. Bounded on purpose: a flooded
/// worker can make the reader block, never make it allocate.
pub const LAYA_READER_QUEUE: usize = 8;
/// Queued request lines the writer may hold, so a request that the worker has
/// not taken yet still fits inside the deadline.
pub const LAYA_WRITE_QUEUE: usize = 2;
/// Bounded manifest size, checked before the worker ever reads it.
pub const LAYA_MAX_MANIFEST_BYTES: u64 = 1024 * 1024;
/// Bounded length for every explicit local path.
pub const LAYA_MAX_PATH_CHARS: usize = 512;

// Fixed failure reasons. Every caller-visible reason is one of these strings,
// so no request text, no worker output and no path can leak through an error.
const REASON_DISABLED: &str = "disabled";
const REASON_INVALID_REQUEST: &str = "invalid-request";
const REASON_MISSING_RUNTIME: &str = "missing-runtime";
const REASON_MISSING_MODEL: &str = "missing-model";
const REASON_MISSING_MANIFEST: &str = "missing-manifest";
const REASON_MISSING_WORKER: &str = "missing-worker";
const REASON_STARTUP_TIMEOUT: &str = "startup-timeout";
const REASON_STARTUP_FAILED: &str = "startup-failed";
const REASON_DECISION_TIMEOUT: &str = "decision-timeout";
const REASON_WORKER_EXITED: &str = "worker-exited";
const REASON_PROTOCOL: &str = "invalid-response";
const REASON_OVERSIZED: &str = "oversized-response";
const REASON_WRONG_ID: &str = "unknown-request-id";
const REASON_STALE_GENERATION: &str = "stale-generation";
const REASON_WORKER_REFUSED: &str = "worker-refused";
const REASON_CANCELLED: &str = "cancelled";
const REASON_STOPPING: &str = "stopping";
const REASON_ABSTAIN: &str = "abstain";
const REASON_LOW_CONFIDENCE: &str = "low-confidence";

/// Honest one-line explanations for the fixed reasons. None of them can carry
/// request text, worker output or a filesystem path.
pub fn reason_message(reason: &str) -> &'static str {
    match reason {
        REASON_DISABLED => "Local Laya is off. Turn it on in Settings.",
        REASON_INVALID_REQUEST => "Say what you want in a few words.",
        REASON_MISSING_RUNTIME => "No local Laya runtime. Set the interpreter path in Settings.",
        REASON_MISSING_MODEL => "No local Laya model folder. Set the model path in Settings.",
        REASON_MISSING_MANIFEST => {
            "No local Laya model manifest. Set the manifest path in Settings."
        }
        REASON_MISSING_WORKER => "The Laya worker script is missing from this install.",
        REASON_STARTUP_TIMEOUT => "Local Laya took too long to load on this machine.",
        REASON_STARTUP_FAILED => "Local Laya could not load the local model.",
        REASON_DECISION_TIMEOUT => "Local Laya did not answer in time.",
        REASON_WORKER_EXITED => "The local Laya worker stopped.",
        REASON_PROTOCOL => "Local Laya answered something this app cannot trust.",
        REASON_OVERSIZED => "Local Laya answered more than this app accepts.",
        REASON_WRONG_ID => "Local Laya answered a different request.",
        REASON_STALE_GENERATION | REASON_CANCELLED => "That turn was cancelled.",
        REASON_WORKER_REFUSED => "Local Laya could not classify that request.",
        REASON_STOPPING => "Local Laya is stopping. Try again.",
        REASON_ABSTAIN => "Local Laya was not sure.",
        REASON_LOW_CONFIDENCE => "Local Laya was not confident enough.",
        _ => "Local Laya is not available.",
    }
}

/// Deadlines and the idle unload window. Tests build a shorter timing; the app
/// always uses the default.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LayaTiming {
    pub startup: Duration,
    pub decision: Duration,
    pub idle: Duration,
}

impl Default for LayaTiming {
    fn default() -> Self {
        Self {
            startup: Duration::from_millis(LAYA_STARTUP_TIMEOUT_MS),
            decision: Duration::from_millis(LAYA_DECISION_TIMEOUT_MS),
            idle: Duration::from_millis(LAYA_IDLE_UNLOAD_MS),
        }
    }
}

/// A bounded failure reason. Never carries request text, worker output or a
/// path, so it is always safe to show, record or log.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LayaFailure {
    pub reason: &'static str,
}

impl LayaFailure {
    fn new(reason: &'static str) -> Self {
        Self { reason }
    }
}

/// Runtime readiness, as the settings card shows it. Never optimistic.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LayaState {
    /// Nothing is configured, or the configured paths do not exist.
    Missing,
    /// Paths are valid but no worker has proved itself with a warm-up yet.
    Loading,
    /// A worker finished its real warm-up inference and owns the runtime.
    Ready,
    /// The last start or the last inference failed.
    Error,
}

/// Availability snapshot for the settings card. Paths are metadata only and
/// are never presented as readiness.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LayaStatus {
    pub enabled: bool,
    pub state: LayaState,
    pub ready: bool,
    pub detail: String,
    pub labels: Vec<String>,
    pub runtime_path: Option<String>,
    pub model_path: Option<String>,
    pub manifest_path: Option<String>,
    pub worker_path: Option<String>,
    pub load_ms: Option<u64>,
    pub startup_timeout_ms: u64,
    pub decision_timeout_ms: u64,
    pub idle_unload_ms: u64,
    pub threshold: f64,
    pub last_reason: Option<String>,
}

/// Bounded decision outcome. The shape matches the cloud outcome so the
/// island can render either engine with the same honesty about confidence.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LayaOutcome {
    pub route: String,
    pub confidence: f64,
    pub latency_ms: u64,
    pub fallback_reason: Option<String>,
    /// Always "local": Laya has no cloud mode and no fallback mode.
    pub mode: String,
    /// Always None: this engine ranks no candidate and executes nothing.
    pub candidate_id: Option<String>,
}

/// Sanitized local receipt. No request text, no hidden reasoning.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LayaReceipt {
    pub route: String,
    pub confidence: f64,
    pub latency_ms: u64,
    pub fallback_reason: Option<String>,
    pub at_ms: u64,
}

/// One validated worker decision. `probabilities` is aligned with LAYA_LABELS,
/// in order.
#[derive(Debug, Clone, PartialEq)]
pub struct LayaDecision {
    pub label: String,
    pub confidence: f64,
    pub probabilities: Vec<f64>,
}

/// The explicit local paths of one setup, already validated.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LayaPaths {
    pub python: PathBuf,
    pub worker: PathBuf,
    pub model: PathBuf,
    pub manifest: PathBuf,
}

impl LayaPaths {
    /// The resolved identity of this setup: what a running worker is actually
    /// serving. Two requests may share one worker only when these match, so a
    /// changed interpreter, model, manifest or worker script retires the old
    /// worker instead of answering from it.
    pub fn identity(&self) -> LayaIdentity {
        LayaIdentity {
            python: resolve_identity(&self.python),
            worker: resolve_identity(&self.worker),
            model: resolve_identity(&self.model),
            manifest: resolve_identity(&self.manifest),
            assets: [
                self.python.clone(), self.worker.clone(), self.manifest.clone(),
                self.model.join("model.safetensors"),
                self.model.join("encoder/config.json"),
                self.model.join("rl_agent_config.json"),
                self.model.join("tokenizer/tokenizer.json"),
                self.model.join("tokenizer/tokenizer_config.json"),
            ].iter().map(|path| asset_stamp(path)).collect(),
        }
    }
}

/// The resolved identity a worker is bound to for its whole life.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LayaIdentity {
    pub python: PathBuf,
    pub worker: PathBuf,
    pub model: PathBuf,
    pub manifest: PathBuf,
    assets: Vec<Option<(u64, Option<std::time::SystemTime>)>>,
}

fn asset_stamp(path: &Path) -> Option<(u64, Option<std::time::SystemTime>)> {
    std::fs::metadata(path).ok().map(|metadata| (metadata.len(), metadata.modified().ok()))
}

/// Resolves a validated path for identity comparison. Symlinks, junctions and
/// case are normalized here, so two spellings of one setup compare equal and
/// two different setups never do. A path that will not resolve keeps its
/// validated form: comparing the literal path beats refusing to compare.
fn resolve_identity(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// The one child the adapter owns, with its three pipes.
struct Spawned {
    child: Child,
    stdin: ChildStdin,
    stdout: ChildStdout,
    stderr: ChildStderr,
}

/// How one worker process is started. The app uses the offline Python worker;
/// the synthetic fixture tests substitute a child that speaks the same line
/// protocol, so every deadline, cancel, read and parse rule below is exercised
/// by the real process path.
type Spawner = Arc<dyn Fn(&LayaPaths) -> Result<Spawned, LayaFailure> + Send + Sync>;

pub fn clamp_threshold(value: f64) -> f64 {
    if !value.is_finite() {
        return LAYA_THRESHOLD_DEFAULT;
    }
    value.clamp(LAYA_THRESHOLD_MIN, LAYA_THRESHOLD_MAX)
}

/// Engine selection from a hand-edited or older settings file. Anything that is
/// not exactly the local selector reads as the online engine, so a corrupt
/// value can never start a local worker behind the user's back.
pub fn normalize_engine(engine: &str) -> &'static str {
    if engine.trim().eq_ignore_ascii_case(ENGINE_LAYA) {
        ENGINE_LAYA
    } else {
        ENGINE_JEV
    }
}

/// Whether Local Laya is the selected engine. The single source of truth for
/// every place that must not reach the network.
pub fn local_engine_selected(engine: &str) -> bool {
    normalize_engine(engine) == ENGINE_LAYA
}

/// Compact request validation: empty is refused, long input is truncated for
/// the worker line only. The trimmed text never reaches an error or a log.
pub fn validate_request(request: &str) -> Result<String, LayaFailure> {
    let trimmed = request.trim();
    if trimmed.is_empty() {
        return Err(LayaFailure::new(REASON_INVALID_REQUEST));
    }
    Ok(trimmed.chars().take(LAYA_MAX_TEXT_CHARS).collect())
}

/// One bounded request line, newline terminated exactly as the worker frames
/// it. serde escapes the text, so a request can never inject a protocol field,
/// and the line stays one line whatever the user said.
pub fn build_request_line(request_id: u64, generation: u64, text: &str) -> String {
    let mut line = serde_json::json!({
        "cmd": "decide",
        "id": request_id,
        "generation": generation,
        "text": text,
    })
    .to_string();
    line.push('\n');
    line
}

/// The exact argv the worker is started with. A pure function, so the shape is
/// asserted without a process: the script and both paths are separate entries
/// and never part of a shell string.
pub fn worker_argv(paths: &LayaPaths) -> Vec<OsString> {
    vec![
        OsString::from("-u"),
        paths.worker.as_os_str().to_owned(),
        OsString::from("--model"),
        paths.model.as_os_str().to_owned(),
        OsString::from("--manifest"),
        paths.manifest.as_os_str().to_owned(),
    ]
}

/// The worker source, resolved like the voice helper: beside the binary in a
/// build, the audited repo copy in development, then a staged copy in the
/// owned local data directory. Never a PATH lookup, never a URL.
fn worker_source_path() -> Option<PathBuf> {
    if let Ok(exe) = std::env::current_exe() {
        let next = exe.parent().map(|p| p.join(WORKER_FILE));
        if let Some(p) = next {
            if p.is_file() {
                return Some(p);
            }
        }
    }
    let dev = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("voice-runtime")
        .join(WORKER_FILE);
    if dev.is_file() {
        return Some(dev);
    }
    let staged = crate::settings::local_dir().join(WORKER_FILE);
    if staged.is_file() {
        return Some(staged);
    }
    None
}

/// A bounded, absolute explicit path. Relative input is refused: the adapter
/// never resolves a path against a working directory it does not control.
fn bounded_abs(value: &str, reason: &'static str) -> Result<PathBuf, LayaFailure> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.chars().count() > LAYA_MAX_PATH_CHARS || trimmed.contains('\0') {
        return Err(LayaFailure::new(reason));
    }
    let path = PathBuf::from(trimmed);
    if !path.is_absolute() {
        return Err(LayaFailure::new(reason));
    }
    Ok(path)
}

/// The interpreter must be a real Python file with a real name, so an
/// arbitrary executable can never be launched as the worker.
fn interpreter_name_ok(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    if cfg!(windows) {
        lower == "python.exe"
    } else {
        lower == "python" || lower == "python3"
    }
}

/// Validates the three explicit local paths plus the worker source. Nothing is
/// downloaded, searched on PATH or guessed: every path is one the user named.
pub fn validate_paths(runtime: &str, model: &str, manifest: &str) -> Result<LayaPaths, LayaFailure> {
    let python = bounded_abs(runtime, REASON_MISSING_RUNTIME)?;
    let named_ok = python
        .file_name()
        .map(|name| interpreter_name_ok(&name.to_string_lossy()))
        .unwrap_or(false);
    if !python.is_file() || !named_ok {
        return Err(LayaFailure::new(REASON_MISSING_RUNTIME));
    }
    let model = bounded_abs(model, REASON_MISSING_MODEL)?;
    if !model.is_dir() {
        return Err(LayaFailure::new(REASON_MISSING_MODEL));
    }
    let manifest = bounded_abs(manifest, REASON_MISSING_MANIFEST)?;
    let bytes = std::fs::metadata(&manifest).map(|m| m.len()).unwrap_or(u64::MAX);
    if !manifest.is_file() || bytes > LAYA_MAX_MANIFEST_BYTES {
        return Err(LayaFailure::new(REASON_MISSING_MANIFEST));
    }
    let worker = worker_source_path().ok_or_else(|| LayaFailure::new(REASON_MISSING_WORKER))?;
    Ok(LayaPaths { python, worker, model, manifest })
}

/// Parses one worker decision line. Enforces the whole bounded contract:
/// strict JSON, the exact request id and generation, one of the five labels, a
/// complete finite five-label distribution in range, normalization, agreement
/// between the reported selected probability and that distribution, and no
/// candidate. The entropy-derived confidence score the model reports is never
/// accepted as a probability.
pub fn parse_decision(
    line: &str,
    request_id: u64,
    generation: u64,
) -> Result<LayaDecision, LayaFailure> {
    if line.len() > LAYA_MAX_LINE_BYTES {
        return Err(LayaFailure::new(REASON_OVERSIZED));
    }
    let value: Value = serde_json::from_str(line).map_err(|_| LayaFailure::new(REASON_PROTOCOL))?;
    if !value.is_object() {
        return Err(LayaFailure::new(REASON_PROTOCOL));
    }
    // Identity first: a line that answers another request or another
    // generation is a protocol violation whatever else it carries.
    match value.get("id").and_then(Value::as_u64) {
        Some(id) if id == request_id => {}
        _ => return Err(LayaFailure::new(REASON_WRONG_ID)),
    }
    match value.get("generation").and_then(Value::as_u64) {
        Some(echoed) if echoed == generation => {}
        _ => return Err(LayaFailure::new(REASON_STALE_GENERATION)),
    }
    match value.get("ok").and_then(Value::as_bool) {
        Some(true) => {}
        Some(false) => return Err(LayaFailure::new(REASON_WORKER_REFUSED)),
        None => return Err(LayaFailure::new(REASON_PROTOCOL)),
    }
    let label = value
        .get("label")
        .and_then(Value::as_str)
        .ok_or_else(|| LayaFailure::new(REASON_PROTOCOL))?;
    if !LAYA_LABELS.contains(&label) {
        return Err(LayaFailure::new(REASON_PROTOCOL));
    }
    // This engine ranks no candidate, so a returned target is a contract break.
    if !value.get("candidateId").map_or(true, Value::is_null) {
        return Err(LayaFailure::new(REASON_PROTOCOL));
    }
    let map = value
        .get("probabilities")
        .and_then(Value::as_object)
        .ok_or_else(|| LayaFailure::new(REASON_PROTOCOL))?;
    if map.len() != LAYA_LABELS.len() {
        return Err(LayaFailure::new(REASON_PROTOCOL));
    }
    if map.keys().any(|key| !LAYA_LABELS.contains(&key.as_str())) {
        return Err(LayaFailure::new(REASON_PROTOCOL));
    }
    let mut probabilities = Vec::with_capacity(LAYA_LABELS.len());
    let mut sum = 0.0;
    for name in LAYA_LABELS {
        let p = map
            .get(*name)
            .and_then(Value::as_f64)
            .ok_or_else(|| LayaFailure::new(REASON_PROTOCOL))?;
        // A non-finite or out-of-range probability is refused, never clamped
        // into a decision.
        if !p.is_finite() || !(0.0..=1.0).contains(&p) {
            return Err(LayaFailure::new(REASON_PROTOCOL));
        }
        sum += p;
        probabilities.push(p);
    }
    if (sum - 1.0).abs() > LAYA_SUM_TOLERANCE {
        return Err(LayaFailure::new(REASON_PROTOCOL));
    }
    let selected = value
        .get("selected_probability")
        .and_then(Value::as_f64)
        .ok_or_else(|| LayaFailure::new(REASON_PROTOCOL))?;
    if !selected.is_finite() || !(0.0..=1.0).contains(&selected) {
        return Err(LayaFailure::new(REASON_PROTOCOL));
    }
    let index = LAYA_LABELS.iter().position(|name| *name == label).unwrap_or(0);
    if (selected - probabilities[index]).abs() > LAYA_AGREE_TOLERANCE {
        return Err(LayaFailure::new(REASON_PROTOCOL));
    }
    Ok(LayaDecision { label: label.to_string(), confidence: selected, probabilities })
}

/// What one startup line means to the adapter.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StartupLine {
    /// The worker finished its real warm-up inference. A load time that is not
    /// a sane number is ignored, never trusted.
    Ready(u64),
    /// Not a startup answer.
    Ignored,
}

/// Strict startup parsing. Readiness is only ever the explicit ready event,
/// never the mere absence of an error.
fn parse_startup_line(line: &str) -> Result<StartupLine, LayaFailure> {
    if line.len() > LAYA_MAX_LINE_BYTES {
        return Err(LayaFailure::new(REASON_OVERSIZED));
    }
    let value: Value = match serde_json::from_str(line) {
        Ok(value) => value,
        Err(_) => return Ok(StartupLine::Ignored),
    };
    if !value.is_object() {
        return Ok(StartupLine::Ignored);
    }
    match (value.get("ok").and_then(Value::as_bool), value.get("event").and_then(Value::as_str)) {
        (Some(true), Some("ready")) => {
            let load_ms = match value.get("load_seconds").and_then(Value::as_f64) {
                Some(seconds) if seconds.is_finite() && (0.0..=600.0).contains(&seconds) => {
                    (seconds * 1000.0) as u64
                }
                _ => 0,
            };
            Ok(StartupLine::Ready(load_ms))
        }
        (Some(false), Some("error")) => Err(LayaFailure::new(REASON_STARTUP_FAILED)),
        // A worker that announces its own exit did not become ready.
        (Some(true), Some("exiting")) => Err(LayaFailure::new(REASON_WORKER_EXITED)),
        _ => Ok(StartupLine::Ignored),
    }
}

/// One message from the worker reader thread.
enum ReaderMsg {
    Line(String),
    /// A line longer than the cap. The stream is poisoned from here: the
    /// reader drops every later byte instead of growing.
    Oversized,
    /// Bytes that are not valid UTF-8. Never repaired with replacement
    /// characters: a line the adapter cannot read exactly is a hard failure,
    /// and the stream is poisoned from here.
    Malformed,
    /// stdout ended, so the worker is gone.
    Closed,
    Failed,
}

/// One owned worker process.
///
/// The child handle lives in its own lock and is the only thing a kill ever
/// touches, so cancellation never waits behind a blocked write or a blocked
/// read. The pipes are reached through bounded queues owned by dedicated
/// threads, so a wedged pipe bounds the queue instead of blocking a caller.
/// Output only ever arrives through the reader queue this session owns, so a
/// disposed worker can never feed a replacement one.
struct LayaSession {
    /// What this worker was started for. It never changes, so a reconfigured
    /// request can compare against it and retire the worker instead of
    /// answering from the wrong interpreter or model.
    identity: LayaIdentity,
    child: Mutex<Option<Child>>,
    writer: Mutex<Option<mpsc::SyncSender<Vec<u8>>>>,
    rx: Mutex<Option<mpsc::Receiver<ReaderMsg>>>,
    load_ms: AtomicU64,
    last_used: Mutex<Instant>,
}

impl LayaSession {
    /// Whether the child is still running. try_wait only reaps a process that
    /// has already exited, so this never blocks.
    fn alive(&self) -> bool {
        let mut guard = self.child.lock().unwrap();
        match guard.as_mut() {
            Some(child) => !matches!(child.try_wait(), Ok(Some(_))),
            None => false,
        }
    }

    fn idle_for(&self) -> Duration {
        self.last_used.lock().unwrap().elapsed()
    }

    #[cfg(test)]
    /// Queues one raw line, for the test that wedges a write on purpose.
    fn queue_line(&self, bytes: Vec<u8>, budget: Duration) -> bool {
        let guard = self.writer.lock().unwrap();
        match guard.as_ref() {
            Some(writer) => send_bounded(writer, bytes, Instant::now() + budget).is_ok(),
            None => false,
        }
    }
}

/// Reads stdout line by line under one hard cap and delivers through a bounded
/// queue. The reader thread owns the pipe for its whole life, so every deadline
/// below is a real deadline instead of a guess made between lines, and a
/// flooding worker can only make this thread block, never grow its heap.
fn spawn_reader(stdout: ChildStdout, tx: mpsc::SyncSender<ReaderMsg>) {
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut poisoned = false;
        loop {
            let mut buf = Vec::new();
            let read = {
                let mut capped = Read::by_ref(&mut reader).take(LAYA_MAX_LINE_BYTES as u64 + 1);
                capped.read_until(b'\n', &mut buf)
            };
            match read {
                Ok(0) => {
                    let _ = tx.send(ReaderMsg::Closed);
                    return;
                }
                Ok(_) => {}
                Err(_) => {
                    let _ = tx.send(ReaderMsg::Failed);
                    return;
                }
            }
            // Past a poisoned stream the framing is already lost: keep
            // draining in bounded chunks and drop every byte.
            if poisoned {
                continue;
            }
            if buf.len() > LAYA_MAX_LINE_BYTES {
                poisoned = true;
                if tx.send(ReaderMsg::Oversized).is_err() {
                    return;
                }
                continue;
            }
            // Strict UTF-8: a corrupted line is refused, never repaired with
            // replacement characters that could hide what the worker said.
            let line = match String::from_utf8(buf) {
                Ok(line) => line,
                Err(_) => {
                    poisoned = true;
                    if tx.send(ReaderMsg::Malformed).is_err() {
                        return;
                    }
                    continue;
                }
            };
            let line = line.trim().to_string();
            if line.is_empty() {
                continue;
            }
            if tx.send(ReaderMsg::Line(line)).is_err() {
                return;
            }
        }
    });
}

/// Hands one line to the bounded write queue, inside a hard deadline.
///
/// A worker that has stopped reading fills the queue instead of blocking a
/// caller: the request is refused at the deadline and the wedged worker is torn
/// down with it. A writer that is gone means the worker went with it.
fn send_bounded(
    writer: &mpsc::SyncSender<Vec<u8>>,
    line: Vec<u8>,
    deadline: Instant,
) -> Result<(), LayaFailure> {
    let mut bytes = line;
    loop {
        match writer.try_send(bytes) {
            Ok(()) => return Ok(()),
            Err(mpsc::TrySendError::Disconnected(_)) => {
                return Err(LayaFailure::new(REASON_WORKER_EXITED))
            }
            Err(mpsc::TrySendError::Full(line)) => {
                if Instant::now() >= deadline {
                    return Err(LayaFailure::new(REASON_DECISION_TIMEOUT));
                }
                // Short sleep instead of a spin: the queue is only ever full
                // when the worker has stopped reading, which is rare.
                std::thread::sleep(Duration::from_millis(1));
                bytes = line;
            }
        }
    }
}

/// Owns the request pipe. The decision path only ever hands a line to a
/// bounded queue, so a worker that has stopped reading can never block a
/// caller or a cancellation: the queue fills, the deadline ends.
fn spawn_writer(stdin: ChildStdin) -> mpsc::SyncSender<Vec<u8>> {
    let (tx, rx) = mpsc::sync_channel::<Vec<u8>>(LAYA_WRITE_QUEUE);
    std::thread::Builder::new()
        .name("coucou-laya-write".to_string())
        .spawn(move || {
            let mut stdin = stdin;
            while let Ok(line) = rx.recv() {
                if stdin.write_all(&line).and_then(|_| stdin.flush()).is_err() {
                    // The worker is gone or wedged. Stop writing; the decision
                    // waiting on a reply sees the closed pipe.
                    return;
                }
            }
        })
        .ok();
    tx
}

/// Drains stderr into a bounded tail kept in memory. It is never logged and
/// never surfaced, so a worker traceback can neither grow nor leak.
fn spawn_stderr_drain(stderr: ChildStderr, tail: Arc<Mutex<Vec<u8>>>) {
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stderr);
        let mut chunk = [0u8; 512];
        loop {
            let read = {
                let mut capped = Read::by_ref(&mut reader).take(LAYA_MAX_STDERR_BYTES as u64 + 1);
                capped.read(&mut chunk)
            };
            let count = match read {
                Ok(0) | Err(_) => return,
                Ok(count) => count,
            };
            let mut tail = tail.lock().unwrap();
            if tail.len() < LAYA_MAX_STDERR_BYTES {
                let room = LAYA_MAX_STDERR_BYTES - tail.len();
                tail.extend_from_slice(&chunk[..count.min(room)]);
            }
        }
    });
}

/// Kills the worker and reaps it.
///
/// The child handle is the only thing a kill touches, and it is taken first:
/// a blocked write owns the request pipe, not this lock, so a cancellation is
/// never queued behind one. The process dies before any pipe is released, so
/// a blocked write fails at once, and a blocked reader ends at its next EOF.
/// Always called outside every runtime lock, so the old child is gone before a
/// new one may be admitted.
fn kill_and_wait(session: Arc<LayaSession>) {
    let child = session.child.lock().unwrap().take();
    if let Some(mut child) = child {
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// What the state lock guards. Every field is copied out in one short critical
/// section: no blocking read, no inference and no process wait happens here.
struct Inner {
    session: Option<Arc<LayaSession>>,
    state: LayaState,
    reason: Option<&'static str>,
    /// Bumped by every cancel. A session from an older epoch is never reused
    /// and never stored back.
    epoch: u64,
    /// Owned reap operations in flight. A worker is only admitted while this is
    /// zero, so a second Python process can never appear while any owned kill
    /// and wait is still running. A counter, not a flag: two cancellations may
    /// overlap, and the last one out must not open the door for the first.
    reaping: usize,
    busy: bool,
    closed: bool,
    receipts: Vec<LayaReceipt>,
}

struct LayaInner {
    state: Mutex<Inner>,
    idle: Condvar,
    /// Signalled when the last owned reap finishes. Separate from the idle
    /// condvar so a teardown never wakes, or is waited on by, the idle timer.
    reaped: Condvar,
    timing: LayaTiming,
    /// How one worker process is started, owned here so a decision can move to
    /// the blocking pool without borrowing the managed state.
    spawn: Spawner,
    next_request_id: AtomicU64,
    idle_started: Once,
    #[cfg(test)]
    /// Test-only gate that holds every owned reap open, so teardown ordering
    /// can be observed without racing a timer.
    reap_gate: Mutex<Option<Arc<ReapGate>>>,
}

/// Test-only gate: an owned reap waits here before it kills anything, so a
/// test can hold a teardown open, watch what the runtime does meanwhile, and
/// then let the process really exit.
#[cfg(test)]
struct ReapGate {
    open: Mutex<bool>,
    changed: Condvar,
    entered: AtomicU64,
}

#[cfg(test)]
impl ReapGate {
    fn new() -> Arc<Self> {
        Arc::new(Self { open: Mutex::new(false), changed: Condvar::new(), entered: AtomicU64::new(0) })
    }

    fn hold(&self) {
        let mut open = self.open.lock().unwrap();
        while !*open {
            open = self.changed.wait(open).unwrap();
        }
    }

    fn open_all(&self) {
        let mut open = self.open.lock().unwrap();
        *open = true;
        self.changed.notify_all();
    }

    fn entered(&self) -> u64 {
        self.entered.load(Ordering::SeqCst)
    }
}

impl LayaInner {
    fn new(timing: LayaTiming, spawn: Spawner) -> Self {
        Self {
            state: Mutex::new(Inner {
                session: None,
                state: LayaState::Missing,
                reason: None,
                epoch: 0,
                reaping: 0,
                busy: false,
                closed: false,
                receipts: Vec::new(),
            }),
            idle: Condvar::new(),
            reaped: Condvar::new(),
            timing,
            spawn,
            next_request_id: AtomicU64::new(1),
            idle_started: Once::new(),
            #[cfg(test)]
            reap_gate: Mutex::new(None),
        }
    }

    /// Kills and reaps one owned worker inside the teardown admission.
    ///
    /// From the moment the reap starts until the process has really gone, no
    /// second worker may be admitted: a cancel, a discard and an idle unload
    /// all pass through here, so two of them at once still leave the door shut.
    /// The kill and the wait happen outside every lock.
    fn reap(&self, session: Arc<LayaSession>) {
        self.state.lock().unwrap().reaping += 1;
        #[cfg(test)]
        self.wait_reap_gate();
        self.reap_reserved(session);
    }

    /// Completes a teardown whose admission was reserved before removing its slot.
    fn reap_reserved(&self, session: Arc<LayaSession>) {
        kill_and_wait(session);
        {
            let mut guard = self.state.lock().unwrap();
            guard.reaping = guard.reaping.saturating_sub(1);
        }
        self.reaped.notify_all();
    }

    /// Test-only: holds inside an owned reap until the gate is opened.
    #[cfg(test)]
    fn wait_reap_gate(&self) {
        let gate = self.reap_gate.lock().unwrap().clone();
        if let Some(gate) = gate {
            gate.entered.fetch_add(1, Ordering::SeqCst);
            gate.hold();
        }
    }

    /// Takes the state lock only while no owned reap is in flight, so the check
    /// and whatever the caller does next happen with nothing on its way out.
    /// The wait is bounded: a reap that outlives the budget is a visible
    /// failure, never a silent overlap and never a hang.
    fn lock_quiet(&self, deadline: Instant) -> Option<std::sync::MutexGuard<'_, Inner>> {
        let mut guard = self.state.lock().unwrap();
        while guard.reaping > 0 {
            let now = Instant::now();
            if now >= deadline {
                return None;
            }
            let (waited, _) = self.reaped.wait_timeout(guard, deadline - now).unwrap();
            guard = waited;
        }
        Some(guard)
    }

    /// Opens one admission and returns the epoch it runs under.
    fn begin(&self) -> Result<u64, LayaFailure> {
        let mut guard = self
            .lock_quiet(Instant::now() + self.timing.startup)
            .ok_or_else(|| LayaFailure::new(REASON_STOPPING))?;
        if guard.closed {
            return Err(LayaFailure::new(REASON_STOPPING));
        }
        guard.busy = true;
        Ok(guard.epoch)
    }

    fn end(&self) {
        self.state.lock().unwrap().busy = false;
        self.idle.notify_all();
    }

    fn fail(&self, reason: &'static str) {
        {
            let mut guard = self.state.lock().unwrap();
            guard.state = LayaState::Error;
            guard.reason = Some(reason);
        }
        self.idle.notify_all();
    }

    fn record(&self, outcome: &LayaOutcome) {
        let mut guard = self.state.lock().unwrap();
        guard.receipts.push(LayaReceipt {
            route: outcome.route.clone(),
            confidence: outcome.confidence,
            latency_ms: outcome.latency_ms,
            fallback_reason: outcome.fallback_reason.clone(),
            at_ms: now_ms(),
        });
        while guard.receipts.len() > LAYA_MAX_HISTORY {
            guard.receipts.remove(0);
        }
    }

    /// A readiness check warms the real worker through the real path but never
    /// leaves a decision receipt behind: the probe is not a user request, so
    /// the bounded history stays a history of what the user actually asked.
    fn record_if(&self, record: bool, outcome: &LayaOutcome) {
        if record {
            self.record(outcome);
        }
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// The managed Laya runtime: one admission lock, one owned child, one idle
/// unload. The typed commands never touch the process directly.
pub struct LayaRuntime {
    inner: Arc<LayaInner>,
    admission: tokio::sync::Mutex<()>,
}

impl Default for LayaRuntime {
    fn default() -> Self {
        Self::new(LayaTiming::default())
    }
}

impl LayaRuntime {
    pub fn new(timing: LayaTiming) -> Self {
        Self {
            inner: Arc::new(LayaInner::new(timing, Arc::new(spawn_worker))),
            admission: tokio::sync::Mutex::new(()),
        }
    }

    /// The production start path is spawn_worker: one private Python child of
    /// the explicitly configured interpreter, with no shell and with the
    /// offline flags set before any import. The synthetic fixture tests
    /// substitute a child that speaks the same line protocol.
    #[cfg(test)]
    fn with_spawner(timing: LayaTiming, spawn: Spawner) -> Self {
        Self {
            inner: Arc::new(LayaInner::new(timing, spawn)),
            admission: tokio::sync::Mutex::new(()),
        }
    }

    /// Marks the runtime closed, stops the idle watcher and tears the worker
    /// down. Safe to call from app exit: the wait is bounded because the child
    /// is killed first.
    pub fn teardown(&self) {
        // Consume the idle watcher gate even if it never started, so no
        // worker may appear after this point.
        self.inner.idle_started.call_once(|| {});
        {
            let mut guard = self.inner.state.lock().unwrap();
            guard.closed = true;
        }
        self.inner.idle.notify_all();
        self.stop_owned();
    }

    /// Cancels whatever the worker is doing right now: the child is killed and
    /// reaped before this returns, and no new worker may be admitted until
    /// every owned reap in flight has finished. Moving the shared voice
    /// generation on is the caller's job; this only tears the owned process
    /// down. Two cancels may overlap safely: neither can leave the door open
    /// while the other is still killing a process.
    pub fn cancel_owned(&self) {
        {
            let mut guard = self.inner.state.lock().unwrap();
            // Invalidate the current session before it is released, so a
            // decision sitting between its read and its answer discards it.
            guard.epoch += 1;
        }
        self.stop_owned();
    }

    /// Steals the worker out of the slot and reaps it inside the teardown
    /// admission. The locks taken here are all short: no read and no wait
    /// happens under one, and the slot stays closed to new workers until the
    /// process has really gone.
    fn stop_owned(&self) {
        let session = {
            let mut guard = self.inner.state.lock().unwrap();
            let session = guard.session.take();
            if session.is_some() {
                guard.reaping += 1;
            }
            if !guard.closed {
                guard.state = LayaState::Missing;
                guard.reason = None;
            }
            session
        };
        if let Some(session) = session {
            #[cfg(test)]
            self.inner.wait_reap_gate();
            self.inner.reap_reserved(session);
        }
        self.inner.idle.notify_all();
    }

    /// Readiness snapshot for the settings card. Honest about what is proven:
    /// ready means a worker completed its real warm-up, never that files exist.
    pub fn status_now(
        &self,
        enabled: bool,
        runtime: &str,
        model: &str,
        manifest: &str,
        threshold: f64,
    ) -> LayaStatus {
        let paths = validate_paths(runtime, model, manifest);
        let wanted = paths.as_ref().ok().map(|p| p.identity());
        let guard = self.inner.state.lock().unwrap();
        // A worker only speaks for the setup it was started for: a reconfigured
        // card must never read the old worker's warmth as its own readiness.
        let matches = match (&wanted, &guard.session) {
            (Some(wanted), Some(session)) => &session.identity == wanted,
            _ => false,
        };
        let live = guard.session.as_ref().map(|s| s.alive()).unwrap_or(false);
        let warm = guard.state == LayaState::Ready && matches;
        let (state, reason, load_ms) = if !enabled {
            (LayaState::Missing, Some(REASON_DISABLED), None)
        } else if let Err(failure) = &paths {
            (LayaState::Missing, Some(failure.reason), None)
        } else if warm && live {
            // Ready means a worker finished its warm-up and is still alive.
            // A child that is still loading stays loading.
            (
                LayaState::Ready,
                None,
                guard.session.as_ref().map(|s| s.load_ms.load(Ordering::SeqCst)),
            )
        } else if guard.state == LayaState::Error {
            (LayaState::Error, guard.reason, None)
        } else {
            // Paths are valid but nothing has warmed up yet, or the last worker
            // was unloaded. Loading is the honest word here.
            (LayaState::Loading, None, None)
        };
        let detail = match state {
            LayaState::Ready => "Local Laya is loaded and warm.".to_string(),
            LayaState::Loading => {
                "Local Laya is set up. The first request loads the model locally.".to_string()
            }
            LayaState::Missing => reason
                .map(|r| reason_message(r).to_string())
                .unwrap_or_else(|| reason_message(REASON_MISSING_RUNTIME).to_string()),
            LayaState::Error => reason
                .map(|r| reason_message(r).to_string())
                .unwrap_or_else(|| reason_message(REASON_STARTUP_FAILED).to_string()),
        };
        LayaStatus {
            enabled,
            state,
            ready: state == LayaState::Ready && enabled,
            detail,
            labels: LAYA_LABELS.iter().map(|label| label.to_string()).collect(),
            runtime_path: paths.as_ref().ok().map(|p| p.python.to_string_lossy().to_string()),
            model_path: paths.as_ref().ok().map(|p| p.model.to_string_lossy().to_string()),
            manifest_path: paths.as_ref().ok().map(|p| p.manifest.to_string_lossy().to_string()),
            worker_path: paths.as_ref().ok().map(|p| p.worker.to_string_lossy().to_string()),
            load_ms,
            startup_timeout_ms: self.inner.timing.startup.as_millis() as u64,
            decision_timeout_ms: self.inner.timing.decision.as_millis() as u64,
            idle_unload_ms: self.inner.timing.idle.as_millis() as u64,
            threshold: clamp_threshold(threshold),
            last_reason: reason.map(|r| r.to_string()),
        }
    }

    pub fn history(&self) -> Vec<LayaReceipt> {
        self.inner.state.lock().unwrap().receipts.clone()
    }

    #[cfg(test)]
    /// The worker the runtime currently owns, so a test can wedge a pipe on
    /// purpose and prove that a cancellation never waits behind it.
    fn current_session(&self) -> Option<Arc<LayaSession>> {
        self.inner.state.lock().unwrap().session.clone()
    }

    #[cfg(test)]
    /// Holds every owned reap open until the returned gate is opened, so
    /// teardown ordering is observed rather than raced.
    fn with_reap_gate(&self) -> Arc<ReapGate> {
        let gate = ReapGate::new();
        *self.inner.reap_gate.lock().unwrap() = Some(gate.clone());
        gate
    }

    #[cfg(test)]
    /// How many owned reaps are running right now.
    fn reaping(&self) -> usize {
        self.inner.state.lock().unwrap().reaping
    }

    pub fn clear_history(&self) {
        self.inner.state.lock().unwrap().receipts.clear();
    }

    /// The whole native decision path, minus the Tauri plumbing. The caller
    /// holds the admission lock, so at most one of these runs at a time and at
    /// most one child exists.
    #[cfg(test)]
    pub fn decide_now(
        &self,
        fence: &FlowFence,
        generation: u64,
        request: &str,
        enabled: bool,
        paths: &LayaPaths,
        threshold: f64,
    ) -> LayaOutcome {
        self.inner.decide_now(fence, generation, request, enabled, paths, threshold, true)
    }
}

/// The decision machinery, on the shared inner value rather than on the
/// managed handle: the blocking pool needs owned access to it, and the
/// admission lock that serializes this work stays with the managed handle.
///
/// The shared voice generation is checked before dispatch and again after the
/// response: a turn cancelled while the model was thinking never records a
/// receipt and never returns a route.
impl LayaInner {
    pub fn decide_now(
        self: &Arc<Self>,
        fence: &FlowFence,
        generation: u64,
        request: &str,
        enabled: bool,
        paths: &LayaPaths,
        threshold: f64,
        record: bool,
    ) -> LayaOutcome {
        let started = Instant::now();
        if !enabled {
            let outcome = abstain_outcome(REASON_DISABLED, started.elapsed().as_millis() as u64);
            self.record_if(record, &outcome);
            return outcome;
        }
        // A turn that is already stale never starts a worker at all.
        if fence.stale(generation) {
            return cancelled_outcome();
        }
        let epoch = match self.begin() {
            Ok(epoch) => epoch,
            Err(failure) => {
                let outcome =
                    abstain_outcome(failure.reason, started.elapsed().as_millis() as u64);
                self.record_if(record, &outcome);
                return outcome;
            }
        };
        let result = self.infer(fence, generation, request, paths, epoch);
        self.end();
        let outcome = match result {
            Ok(decision) => {
                if fence.stale(generation) {
                    return cancelled_outcome();
                }
                let latency = started.elapsed().as_millis() as u64;
                let threshold = clamp_threshold(threshold);
                if decision.label == "unknown" {
                    let mut outcome = abstain_outcome(REASON_ABSTAIN, latency);
                    outcome.confidence = decision.confidence;
                    outcome
                } else if decision.confidence < threshold {
                    // Under the conservative threshold means clarify, never a
                    // guess and never a saved-target resolution.
                    let mut outcome = abstain_outcome(REASON_LOW_CONFIDENCE, latency);
                    outcome.confidence = decision.confidence;
                    outcome
                } else {
                    LayaOutcome {
                        route: decision.label,
                        confidence: decision.confidence,
                        latency_ms: latency,
                        fallback_reason: None,
                        mode: "local".to_string(),
                        candidate_id: None,
                    }
                }
            }
            Err(failure) => {
                if failure.reason == REASON_CANCELLED {
                    return cancelled_outcome();
                }
                abstain_outcome(failure.reason, started.elapsed().as_millis() as u64)
            }
        };
        if fence.stale(generation) {
            return cancelled_outcome();
        }
        self.record_if(record, &outcome);
        outcome
    }

    /// The explicit readiness check: a real warm-up through the real worker
    /// with a neutral bounded probe, so Ready is always backed by a finished
    /// local inference. It performs no action, downloads nothing, never
    /// records a decision receipt and returns the outcome only so the caller
    /// can discard it.
    pub fn check_now(
        self: &Arc<Self>,
        fence: &FlowFence,
        generation: u64,
        enabled: bool,
        paths: &LayaPaths,
        threshold: f64,
    ) -> LayaOutcome {
        self.decide_now(fence, generation, LAYA_PROBE_TEXT, enabled, paths, threshold, false)
    }

    /// One admission: reuse a live warm worker, or start one and wait for its
    /// real warm-up. Then one bounded request and one bounded read.
    fn infer(
        self: &Arc<Self>,
        fence: &FlowFence,
        generation: u64,
        request: &str,
        paths: &LayaPaths,
        epoch: u64,
    ) -> Result<LayaDecision, LayaFailure> {
        let session = self.acquire(paths, epoch)?;
        // A cancel that landed while the worker was warming owns the teardown,
        // and a warm-up that finished after that cancel must never answer.
        if self.state.lock().unwrap().epoch != epoch {
            self.reap(session);
            return Err(LayaFailure::new(REASON_CANCELLED));
        }
        self.idle_started.call_once(|| self.spawn_idle_watcher(self.clone()));
        let request_id = self.next_request_id.fetch_add(1, Ordering::SeqCst);
        let line = build_request_line(request_id, generation, request);
        // The fence is rechecked immediately before the write, so a Stop that
        // landed after the frontend's own check still refuses the dispatch.
        if fence.stale(generation) {
            self.release(&session, epoch);
            return Err(LayaFailure::new(REASON_CANCELLED));
        }
        // One deadline covers the whole exchange: the request only has to reach
        // the bounded write queue inside it, and the reply only has to arrive
        // inside what is left.
        let deadline = Instant::now() + self.timing.decision;
        let written = {
            let guard = session.writer.lock().unwrap();
            match guard.as_ref() {
                Some(writer) => send_bounded(writer, line.into_bytes(), deadline),
                None => Err(LayaFailure::new(REASON_WORKER_EXITED)),
            }
        };
        if let Err(failure) = written {
            // A worker that will not take the request is wedged: it is torn
            // down with the request, never left holding a half-sent line.
            self.discard(&session, epoch, failure.reason);
            return Err(failure);
        }
        let result = self.read_decision(&session, request_id, generation, deadline);
        *session.last_used.lock().unwrap() = Instant::now();
        match result {
            Ok(decision) => {
                if self.state.lock().unwrap().epoch != epoch {
                    // Cancelled while the model was thinking: the answer is
                    // discarded, and the worker is torn down with it.
                    self.reap(session);
                    return Err(LayaFailure::new(REASON_CANCELLED));
                }
                self.release(&session, epoch);
                Ok(decision)
            }
            Err(failure) => {
                // Every protocol failure kills the worker: a desynced stream
                // is never reused, and the kill plus the wait happen before
                // any new admission.
                self.discard(&session, epoch, failure.reason);
                Err(failure)
            }
        }
    }

    /// Reuses a live warm worker, or starts one. The old child is killed and
    /// reaped before a new one is started, so there is never a second worker.
    ///
    /// A worker is reused only when it was started for this exact setup: a
    /// changed interpreter, worker script, model or manifest retires it, so the
    /// matching configuration is warmed before anything can be called ready or
    /// answered.
    fn acquire(&self, paths: &LayaPaths, epoch: u64) -> Result<Arc<LayaSession>, LayaFailure> {
        let wanted = paths.identity();
        let stale = {
            let mut guard = self.state.lock().unwrap();
            match guard.session.clone() {
                None => None,
                Some(session) => {
                    let current = guard.epoch == epoch;
                    let warm = session.idle_for() < self.timing.idle;
                    // Only a worker that proved itself may be reused. One that
                    // is still loading is left to the admission that owns it.
                    let ready = guard.state == LayaState::Ready;
                    let matches = session.identity == wanted;
                    let reuse = current && warm && ready && matches && session.alive();
                    if !reuse {
                        guard.session = None;
                        guard.reaping += 1;
                    }
                    if reuse {
                        return Ok(session);
                    }
                    Some(session)
                }
            }
        };
        if let Some(old) = stale {
            #[cfg(test)]
            self.wait_reap_gate();
            self.reap_reserved(old);
        }
        {
            // A reap from a cancel, a discard or an idle unload may still be
            // running: no second worker starts beside one that is on its way
            // out, and the wait for it is part of this admission.
            let mut guard = self
                .lock_quiet(Instant::now() + self.timing.startup)
                .ok_or_else(|| LayaFailure::new(REASON_STOPPING))?;
            if guard.closed {
                return Err(LayaFailure::new(REASON_STOPPING));
            }
            guard.state = LayaState::Loading;
            guard.reason = None;
        }
        self.idle.notify_all();
        self.start(paths, epoch)
    }

    /// Starts one child, publishes it, then waits for its ready line.
    ///
    /// Ownership is published before the wait, never after it: a cancel that
    /// lands while the model is still loading has to reach the process that is
    /// loading, not find an empty slot and leave it behind. Readiness still
    /// means the worker finished its real warm-up inference, so a child being
    /// warmed is loading and never ready.
    fn start(&self, paths: &LayaPaths, epoch: u64) -> Result<Arc<LayaSession>, LayaFailure> {
        let spawned = match (self.spawn)(paths) {
            Ok(spawned) => spawned,
            Err(failure) => {
                self.fail(failure.reason);
                return Err(failure);
            }
        };
        let tail = Arc::new(Mutex::new(Vec::new()));
        spawn_stderr_drain(spawned.stderr, tail);
        let (tx, rx) = mpsc::sync_channel::<ReaderMsg>(LAYA_READER_QUEUE);
        spawn_reader(spawned.stdout, tx);
        let writer = spawn_writer(spawned.stdin);
        let session = Arc::new(LayaSession {
            identity: paths.identity(),
            child: Mutex::new(Some(spawned.child)),
            writer: Mutex::new(Some(writer)),
            rx: Mutex::new(Some(rx)),
            load_ms: AtomicU64::new(0),
            last_used: Mutex::new(Instant::now()),
        });
        self.publish(session.clone(), epoch)?;
        match await_ready(&session, self.timing.startup) {
            Ok(load_ms) => {
                session.load_ms.store(load_ms, Ordering::SeqCst);
                self.mark_ready(&session, epoch);
                Ok(session)
            }
            Err(failure) => {
                // A cancel that reached this child owns the teardown, so the
                // pending request is cancelled rather than reported as a load
                // failure the user would have to read.
                let cancelled = self.state.lock().unwrap().epoch != epoch;
                if !cancelled {
                    self.fail(failure.reason);
                }
                self.discard(&session, epoch, failure.reason);
                Err(if cancelled { LayaFailure::new(REASON_CANCELLED) } else { failure })
            }
        }
    }

    /// Puts a freshly spawned child in the slot so a cancel can reach it
    /// before it has finished loading. It never claims readiness.
    fn publish(&self, session: Arc<LayaSession>, epoch: u64) -> Result<(), LayaFailure> {
        {
            let mut guard = self.state.lock().unwrap();
            if guard.epoch != epoch || guard.closed {
                drop(guard);
                self.reap(session);
                return Err(LayaFailure::new(REASON_CANCELLED));
            }
            guard.session = Some(session);
        }
        self.idle.notify_all();
        Ok(())
    }

    /// Records that the warm worker proved itself. A session that a cancel
    /// already took is left alone: its teardown belongs to that cancel.
    fn mark_ready(&self, session: &Arc<LayaSession>, epoch: u64) {
        {
            let mut guard = self.state.lock().unwrap();
            let still_ours = guard.epoch == epoch
                && !guard.closed
                && guard
                    .session
                    .as_ref()
                    .map(|current| Arc::ptr_eq(current, session))
                    .unwrap_or(false);
            if !still_ours {
                return;
            }
            guard.state = LayaState::Ready;
            guard.reason = None;
        }
        self.idle.notify_all();
    }

    /// Reads one answer under a hard deadline. Lines that are not JSON are
    /// skipped a bounded number of times; a JSON line that answers another
    /// request or another generation is a hard failure, never a wait.
    fn read_decision(
        &self,
        session: &LayaSession,
        request_id: u64,
        generation: u64,
        deadline: Instant,
    ) -> Result<LayaDecision, LayaFailure> {
        let rx = session.rx.lock().unwrap().take();
        match rx {
            None => Err(LayaFailure::new(REASON_WORKER_EXITED)),
            Some(rx) => {
                let mut junk = 0;
                let outcome = loop {
                    let now = Instant::now();
                    if now >= deadline {
                        break Err(LayaFailure::new(REASON_DECISION_TIMEOUT));
                    }
                    match rx.recv_timeout(deadline - now) {
                        Err(_) => break Err(LayaFailure::new(REASON_DECISION_TIMEOUT)),
                        Ok(ReaderMsg::Closed) | Ok(ReaderMsg::Failed) => {
                            break Err(LayaFailure::new(REASON_WORKER_EXITED))
                        }
                        Ok(ReaderMsg::Oversized) => break Err(LayaFailure::new(REASON_OVERSIZED)),
                        Ok(ReaderMsg::Malformed) => break Err(LayaFailure::new(REASON_PROTOCOL)),
                        Ok(ReaderMsg::Line(line)) => {
                            // A line that is not JSON at all is noise and is
                            // skipped a bounded number of times. A line that
                            // claims to be JSON is parsed strictly, so a
                            // malformed answer fails fast instead of waiting.
                            if !line.starts_with('{') {
                                junk += 1;
                                if junk > LAYA_MAX_JUNK_LINES {
                                    break Err(LayaFailure::new(REASON_PROTOCOL));
                                }
                                continue;
                            }
                            break parse_decision(&line, request_id, generation);
                        }
                    }
                };
                // Put the reader back, so the next request reads the same
                // stream, and never under any other lock.
                *session.rx.lock().unwrap() = Some(rx);
                outcome
            }
        }
    }

    /// Keeps a healthy session as the current one.
    fn release(&self, session: &Arc<LayaSession>, epoch: u64) {
        let mut guard = self.state.lock().unwrap();
        if guard.epoch != epoch || guard.closed {
            drop(guard);
            self.reap(session.clone());
            return;
        }
        if !session.alive() {
            guard.session = None;
            guard.state = LayaState::Error;
            guard.reason = Some(REASON_WORKER_EXITED);
        }
        drop(guard);
        self.idle.notify_all();
    }

    /// Kills and reaps a session that can no longer be trusted, so the next
    /// admission never finds a live worker it did not start. The slot is closed
    /// first and the reap holds the teardown admission, so a cancel landing on
    /// the same worker cannot clear the door while this one is still exiting.
    fn discard(&self, session: &Arc<LayaSession>, epoch: u64, reason: &'static str) {
        {
            let mut guard = self.state.lock().unwrap();
            guard.reaping += 1;
            if guard.session.as_ref().map(|current| Arc::ptr_eq(current, session)).unwrap_or(false) {
                guard.session = None;
            }
            if guard.epoch == epoch && !guard.closed {
                guard.state = LayaState::Error;
                guard.reason = Some(reason);
            }
        }
        self.idle.notify_all();
        #[cfg(test)]
        self.wait_reap_gate();
        self.reap_reserved(session.clone());
    }

    /// One idle watcher for the runtime. It sleeps on a condition variable
    /// while a worker is in use and unloads one that has been idle past the
    /// window, so an unused model never holds its working set.
    fn spawn_idle_watcher(&self, me: Arc<LayaInner>) {
        let inner = me;
        let window = self.timing.idle;
        let _ = std::thread::Builder::new()
            .name("coucou-laya-idle".to_string())
            .spawn(move || loop {
                let session = {
                    let mut guard = inner.state.lock().unwrap();
                    if guard.closed {
                        return;
                    }
                    let Some(session) = guard.session.clone() else {
                        let _guard = inner.idle.wait(guard).unwrap();
                        continue;
                    };
                    if guard.busy || guard.reaping > 0 {
                        let _guard = inner.idle.wait(guard).unwrap();
                        continue;
                    }
                    if session.idle_for() < window {
                        let left = window.saturating_sub(session.idle_for());
                        let _ = inner.idle.wait_timeout(guard, left).unwrap();
                        continue;
                    }
                    guard.reaping += 1;
                    guard.session = None;
                    guard.state = LayaState::Missing;
                    guard.reason = None;
                    session
                };
                #[cfg(test)]
                inner.wait_reap_gate();
                inner.reap_reserved(session);
                inner.idle.notify_all();
            });
    }
}

fn abstain_outcome(reason: &'static str, latency_ms: u64) -> LayaOutcome {
    LayaOutcome {
        route: "unknown".to_string(),
        confidence: 0.0,
        latency_ms,
        fallback_reason: Some(reason.to_string()),
        mode: "local".to_string(),
        candidate_id: None,
    }
}

/// A cancelled turn never gets a route: the typed command maps this to the
/// same honest Stop message the queue reports.
fn cancelled_outcome() -> LayaOutcome {
    LayaOutcome {
        route: "cancelled".to_string(),
        confidence: 0.0,
        latency_ms: 0,
        fallback_reason: Some(REASON_CANCELLED.to_string()),
        mode: "local".to_string(),
        candidate_id: None,
    }
}

/// Starts the one owned worker. No shell is involved: the interpreter, the
/// script and both paths are separate argv entries, so nothing inside a path
/// can ever be read as syntax. The offline flags are set on the child as well
/// as inside the worker, before any import.
fn spawn_worker(paths: &LayaPaths) -> Result<Spawned, LayaFailure> {
    let mut cmd = Command::new(&paths.python);
    cmd.args(worker_argv(paths))
        .env("HF_HUB_DISABLE_TELEMETRY", "1")
        .env("HF_HUB_OFFLINE", "1")
        .env("TRANSFORMERS_OFFLINE", "1")
        .env("OMP_WAIT_POLICY", "PASSIVE")
        .env("KMP_BLOCKTIME", "0")
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::platform::no_console(&mut cmd);
    let mut child = cmd.spawn().map_err(|_| LayaFailure::new(REASON_STARTUP_FAILED))?;
    let stdin = child.stdin.take().ok_or_else(|| LayaFailure::new(REASON_STARTUP_FAILED))?;
    let stdout = child.stdout.take().ok_or_else(|| LayaFailure::new(REASON_STARTUP_FAILED))?;
    let stderr = child.stderr.take().ok_or_else(|| LayaFailure::new(REASON_STARTUP_FAILED))?;
    Ok(Spawned { child, stdin, stdout, stderr })
}

/// Waits for the ready line under the startup deadline. A worker that never
/// answers fails honestly instead of hanging the caller.
fn await_ready(session: &LayaSession, startup: Duration) -> Result<u64, LayaFailure> {
    let started = Instant::now();
    let deadline = started + startup;
    let rx = session.rx.lock().unwrap().take();
    let Some(rx) = rx else {
        return Err(LayaFailure::new(REASON_WORKER_EXITED));
    };
    let mut junk = 0;
    let result = loop {
        let now = Instant::now();
        if now >= deadline {
            break Err(LayaFailure::new(REASON_STARTUP_TIMEOUT));
        }
        match rx.recv_timeout(deadline - now) {
            Err(_) => break Err(LayaFailure::new(REASON_STARTUP_TIMEOUT)),
            Ok(ReaderMsg::Closed) | Ok(ReaderMsg::Failed) => {
                break Err(LayaFailure::new(REASON_STARTUP_FAILED))
            }
            Ok(ReaderMsg::Oversized) => break Err(LayaFailure::new(REASON_OVERSIZED)),
            Ok(ReaderMsg::Malformed) => break Err(LayaFailure::new(REASON_PROTOCOL)),
            Ok(ReaderMsg::Line(line)) => match parse_startup_line(&line) {
                Ok(StartupLine::Ready(load_ms)) => break Ok(load_ms),
                Ok(StartupLine::Ignored) => {
                    junk += 1;
                    if junk > LAYA_MAX_JUNK_LINES {
                        break Err(LayaFailure::new(REASON_PROTOCOL));
                    }
                }
                Err(failure) => break Err(failure),
            },
        }
    };
    *session.rx.lock().unwrap() = Some(rx);
    result.map(|load_ms| load_ms.max(started.elapsed().as_millis() as u64))
}

// ── Owned worker teardown ─────────────────────────────────────────────────────

/// App exit hook: the owned worker is killed and reaped, so leaving Choom
/// never leaves a Python process behind. The wait is bounded because the
/// child is killed first, and it runs off the UI thread's critical path.
pub fn shutdown(rt: &LayaRuntime) {
    rt.teardown();
}

// ── Typed commands ────────────────────────────────────────────────────────────

/// Honest availability, paths and deadlines. Never starts a worker and never
/// claims a staged runtime is ready.
#[tauri::command]
pub fn laya_status(rt: State<'_, LayaRuntime>, shared: State<'_, crate::Shared>) -> LayaStatus {
    let (enabled, runtime, model, manifest, threshold) = laya_settings(&shared);
    rt.status_now(enabled, &runtime, &model, &manifest, threshold)
}

fn laya_settings(shared: &State<'_, crate::Shared>) -> (bool, String, String, String, f64) {
    let s = shared.settings.lock().unwrap();
    // The engine selector decides, never the legacy mirror, so there is exactly
    // one place a turn can find out which engine owns the decision.
    (
        local_engine_selected(&s.decision_engine),
        s.laya_runtime_path.clone(),
        s.laya_model_path.clone(),
        s.laya_manifest_path.clone(),
        s.laya_threshold,
    )
}

/// One local decision. The whole exchange runs off the UI thread under one
/// admission lock, and the shared voice generation is checked before dispatch
/// and again after the response.
#[tauri::command]
pub async fn laya_decide(
    rt: State<'_, LayaRuntime>,
    voice: State<'_, VoiceRuntime>,
    fence: State<'_, FlowFence>,
    shared: State<'_, crate::Shared>,
    request: String,
    generation: Option<u64>,
) -> Result<LayaOutcome, String> {
    let (enabled, runtime, model, manifest, threshold) = laya_settings(&shared);
    // An explicitly supplied generation is always checked, gen 0 included.
    if let Some(gen) = generation {
        if voice.is_stale(gen) {
            return Err(reason_message(REASON_CANCELLED).to_string());
        }
    }
    let text = validate_request(&request).map_err(|f| reason_message(f.reason).to_string())?;
    let paths = validate_paths(&runtime, &model, &manifest)
        .map_err(|f| reason_message(f.reason).to_string())?;
    let generation = generation.unwrap_or_else(|| voice.current_generation());
    let fence_inner = fence.0.clone();
    let inner = rt.inner.clone();
    // The admission lock parks other callers instead of tying up a worker
    // thread, so exactly one inference is ever in flight.
    let _admission = rt.admission.lock().await;
    let outcome = tokio::task::spawn_blocking(move || {
        let fence = FlowFence(fence_inner);
        inner.decide_now(&fence, generation, &text, enabled, &paths, threshold, true)
    })
    .await
    .map_err(|_| "The local Laya worker stopped unexpectedly.".to_string())?;
    if outcome.route == "cancelled" {
        return Err(reason_message(REASON_CANCELLED).to_string());
    }
    Ok(outcome)
}

/// Warms the local model with a neutral bounded probe and answers with the
/// honest readiness that warm-up earned. It takes no request text, starts no
/// action, downloads nothing and never touches the network, so it can be run
/// from Settings without changing any answer.
#[tauri::command]
pub async fn laya_check(
    rt: State<'_, LayaRuntime>,
    voice: State<'_, VoiceRuntime>,
    fence: State<'_, FlowFence>,
    shared: State<'_, crate::Shared>,
) -> Result<LayaStatus, String> {
    let (enabled, runtime, model, manifest, threshold) = laya_settings(&shared);
    // A missing or tampered setup is reported through the same honest status
    // the card already renders, never as a command failure, and no worker is
    // started for a setup that failed validation.
    let Ok(paths) = validate_paths(&runtime, &model, &manifest) else {
        return Ok(rt.status_now(enabled, &runtime, &model, &manifest, threshold));
    };
    let generation = voice.current_generation();
    let fence_inner = fence.0.clone();
    let inner = rt.inner.clone();
    let _admission = rt.admission.lock().await;
    let _ = tokio::task::spawn_blocking(move || {
        let fence = FlowFence(fence_inner);
        inner.check_now(&fence, generation, enabled, &paths, threshold)
    })
    .await;
    // The status is read after the warm-up, so a worker that finished loading
    // here reads as Ready and a worker that failed reads as Error.
    Ok(rt.status_now(enabled, &runtime, &model, &manifest, threshold))
}

/// Stops the owned worker now: the child is killed and reaped before this
/// returns, and the shared voice generation moves on, so an in-flight turn can
/// never come back with a late answer.
#[tauri::command]
pub fn laya_cancel(rt: State<'_, LayaRuntime>, voice: State<'_, VoiceRuntime>) -> Result<u64, String> {
    let generation = voice.next_generation();
    rt.cancel_owned();
    Ok(generation)
}

/// Sanitized local receipts: route label, confidence, latency and reason.
#[tauri::command]
pub fn laya_history(rt: State<'_, LayaRuntime>) -> Vec<LayaReceipt> {
    rt.history()
}

#[tauri::command]
pub fn laya_clear_history(rt: State<'_, LayaRuntime>) {
    rt.clear_history();
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE_ENV: &str = "COUCOU_LAYA_FIXTURE";
    const FIXTURE_MARKER_ENV: &str = "COUCOU_LAYA_MARKER";
    const FIXTURE_TEST: &str = "laya::tests::fixture_worker";
    /// Every fixture child appends one line to its own marker file, so a test
    /// can prove how many workers the adapter really launched. Tests run in
    /// parallel, so the name carries a unique tag.
    static FIXTURE_TAG: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

    /// Fixture files live under the ignored build directory, never in the
    /// repository and never outside this project.
    fn fixture_dir() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("target").join("laya-test-fixtures")
    }

    /// Short deadlines: a fixture answers in milliseconds, so the production
    /// 120 second startup would only make the tests slow, not stricter.
    fn test_timing() -> LayaTiming {
        LayaTiming {
            startup: Duration::from_millis(6_000),
            decision: Duration::from_millis(2_000),
            idle: Duration::from_millis(600),
        }
    }

    fn fence() -> FlowFence {
        FlowFence::default()
    }

    /// Explicit paths that pass the production validation without any Python
    /// install: an empty file named python.exe, a model folder and a manifest.
    fn staged_paths() -> LayaPaths {
        staged_paths_in("set")
    }

    /// One named setup, in its own folder so two setups are two different
    /// resolved identities: an interpreter, a model folder and a manifest, and
    /// the same worker source the production validator resolves, so the tests
    /// compare identities the way the runtime does.
    fn staged_paths_in(name: &str) -> LayaPaths {
        let dir = fixture_dir().join(format!("{name}-{}-{}", std::process::id(), next_tag()));
        std::fs::create_dir_all(dir.join("model")).unwrap();
        let python = dir.join(if cfg!(windows) { "python.exe" } else { "python" });
        std::fs::write(&python, b"").unwrap();
        std::fs::write(dir.join("model-manifest.json"), b"{}").unwrap();
        LayaPaths {
            python,
            worker: worker_source_path().unwrap_or_else(|| PathBuf::from(WORKER_FILE)),
            model: dir.join("model"),
            manifest: dir.join("model-manifest.json"),
        }
    }

    fn settings_strings(paths: &LayaPaths) -> (String, String, String) {
        (
            paths.python.to_string_lossy().to_string(),
            paths.model.to_string_lossy().to_string(),
            paths.manifest.to_string_lossy().to_string(),
        )
    }

    fn next_tag() -> usize {
        FIXTURE_TAG.fetch_add(1, Ordering::SeqCst)
    }

    /// Where a fixture child records that it started. One file per setup, so a
    /// test can prove that a reconfigured request really launched another
    /// worker instead of reusing the old one.
    fn marker_for(mode: &str, paths: &LayaPaths, tag: usize) -> PathBuf {
        let set = paths
            .python
            .parent()
            .and_then(|dir| dir.file_name())
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| "set".to_string());
        fixture_dir().join(format!("marker-{mode}-{set}-{}-{tag}", std::process::id()))
    }

    /// A fixture child is this same test binary, told through its environment
    /// to run exactly the fixture test and speak the worker protocol. Every
    /// deadline, cancel, read, parse and teardown rule is therefore exercised
    /// through real pipes and a real process, with no Python anywhere.
    fn fixture_runtime(mode: &str, timing: LayaTiming) -> (LayaRuntime, LayaPaths, PathBuf) {
        fixture_runtime_for(mode, timing, staged_paths(), next_tag())
    }

    fn fixture_runtime_for(
        mode: &str,
        timing: LayaTiming,
        paths: LayaPaths,
        tag: usize,
    ) -> (LayaRuntime, LayaPaths, PathBuf) {
        let marker = marker_for(mode, &paths, tag);
        let _ = std::fs::remove_file(&marker);
        let mode = mode.to_string();
        let spawner: Spawner = Arc::new(move |asked: &LayaPaths| {
            // The child records itself in the marker of the setup it was
            // started for, so a reconfiguration is visible in the counts.
            let marker = marker_for(&mode, asked, tag);
            let mut cmd = Command::new(std::env::current_exe().unwrap());
            // A substring filter, so the same command works whether the module
            // sits at the crate root or under choom.
            cmd.arg(FIXTURE_TEST)
                .arg("--nocapture")
                .env(FIXTURE_ENV, &mode)
                .env(FIXTURE_MARKER_ENV, marker)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            let mut child = cmd.spawn().map_err(|_| LayaFailure::new(REASON_STARTUP_FAILED))?;
            let stdin = child.stdin.take().ok_or_else(|| LayaFailure::new(REASON_STARTUP_FAILED))?;
            let stdout = child.stdout.take().ok_or_else(|| LayaFailure::new(REASON_STARTUP_FAILED))?;
            let stderr = child.stderr.take().ok_or_else(|| LayaFailure::new(REASON_STARTUP_FAILED))?;
            Ok(Spawned { child, stdin, stdout, stderr })
        });
        (LayaRuntime::with_spawner(timing, spawner), paths, marker)
    }

    /// Waits, bounded, for a condition the test is synchronising on. Returns
    /// false when it never came true, so a failing assertion never hangs.
    fn wait_until(budget: Duration, mut ready: impl FnMut() -> bool) -> bool {
        let deadline = Instant::now() + budget;
        loop {
            if ready() {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    fn marker_lines(marker: &Path) -> usize {
        std::fs::read_to_string(marker)
            .map(|text| text.lines().filter(|line| !line.trim().is_empty()).count())
            .unwrap_or(0)
    }

    fn status_of(rt: &LayaRuntime, paths: &LayaPaths, enabled: bool) -> LayaStatus {
        let (python, model, manifest) = settings_strings(paths);
        rt.status_now(enabled, &python, &model, &manifest, LAYA_THRESHOLD_DEFAULT)
    }

    // ── Pure contract ────────────────────────────────────────────────────────

    fn valid_line(id: u64, generation: u64) -> String {
        format!(
            "{{\"ok\":true,\"id\":{id},\"generation\":{generation},\"label\":\"answer\",\
             \"selected_probability\":0.7,\"probabilities\":{{\"answer\":0.7,\"options\":0.1,\
             \"clarify\":0.1,\"supported_local\":0.05,\"unknown\":0.05}}}}"
        )
    }

    #[test]
    fn a_valid_decision_line_parses_to_the_fixed_contract() {
        let decision = parse_decision(&valid_line(7, 3), 7, 3).unwrap();
        assert_eq!(decision.label, "answer");
        assert!((decision.confidence - 0.7).abs() < 1e-9);
        assert_eq!(decision.probabilities.len(), LAYA_LABELS.len());
        assert!((decision.probabilities.iter().sum::<f64>() - 1.0).abs() < 1e-9);
    }

    #[test]
    fn the_label_set_is_exactly_the_five_route_labels() {
        assert_eq!(
            LAYA_LABELS,
            &["answer", "options", "clarify", "supported_local", "unknown"]
        );
        // Even a perfectly confident local route names no target.
        let decision = parse_decision(
            r#"{"ok":true,"id":1,"generation":1,"label":"supported_local","selected_probability":1.0,
                "probabilities":{"answer":0.0,"options":0.0,"clarify":0.0,"supported_local":1.0,"unknown":0.0}}"#,
            1,
            1,
        )
        .unwrap();
        assert_eq!(decision.label, "supported_local");
        assert!(decision.probabilities[3] > 0.9);
    }

    #[test]
    fn malformed_and_out_of_range_output_is_refused() {
        let refused = [
            "not json",
            "[]",
            r#"{"ok":true,"generation":1,"label":"answer","selected_probability":1.0,"probabilities":{}}"#,
            r#"{"ok":true,"id":1,"generation":1,"label":"launch","selected_probability":1.0,
                "probabilities":{"answer":1.0,"options":0.0,"clarify":0.0,"supported_local":0.0,"unknown":0.0}}"#,
            r#"{"ok":true,"id":1,"generation":1,"label":"answer","selected_probability":1.0,
                "probabilities":{"answer":1.0,"options":0.0,"clarify":0.0,"supported_local":0.0}}"#,
            r#"{"ok":true,"id":1,"generation":1,"label":"answer","selected_probability":0.9,
                "probabilities":{"answer":0.9,"options":0.0,"clarify":0.0,"supported_local":0.0,"unknown":0.0,"launch":0.0}}"#,
            r#"{"ok":true,"id":1,"generation":1,"label":"answer","selected_probability":0.6,
                "probabilities":{"answer":0.6,"options":0.1,"clarify":0.0,"supported_local":0.0,"unknown":0.0}}"#,
            r#"{"ok":true,"id":1,"generation":1,"label":"answer","selected_probability":1e999,
                "probabilities":{"answer":1e999,"options":0.0,"clarify":0.0,"supported_local":0.0,"unknown":0.0}}"#,
            r#"{"ok":true,"id":1,"generation":1,"label":"answer","selected_probability":null,
                "probabilities":{"answer":null,"options":0.0,"clarify":0.0,"supported_local":0.0,"unknown":0.0}}"#,
            r#"{"ok":true,"id":1,"generation":1,"label":"answer","selected_probability":0.99,
                "probabilities":{"answer":0.4,"options":0.3,"clarify":0.2,"supported_local":0.1,"unknown":0.0}}"#,
            r#"{"ok":true,"id":1,"generation":1,"label":"answer","selected_probability":1.0,
                "candidateId":"terminal","probabilities":{"answer":1.0,"options":0.0,"clarify":0.0,"supported_local":0.0,"unknown":0.0}}"#,
            r#"{"ok":false,"id":1,"generation":1,"error":"inference failed"}"#,
        ];
        for line in refused {
            assert!(parse_decision(line, 1, 1).is_err(), "this line must be refused: {line}");
        }
    }

    #[test]
    fn a_line_for_another_request_or_generation_is_refused() {
        assert_eq!(parse_decision(&valid_line(8, 3), 7, 3).unwrap_err().reason, REASON_WRONG_ID);
        assert_eq!(parse_decision(&valid_line(7, 4), 7, 3).unwrap_err().reason, REASON_STALE_GENERATION);
        // An oversized line is refused before it is parsed.
        let huge = format!("{{\"ok\":true,\"pad\":\"{}\"}}", "x".repeat(LAYA_MAX_LINE_BYTES));
        assert_eq!(parse_decision(&huge, 1, 1).unwrap_err().reason, REASON_OVERSIZED);
    }

    #[test]
    fn readiness_is_only_the_explicit_ready_event() {
        assert_eq!(
            parse_startup_line(r#"{"ok":true,"event":"ready","load_seconds":11.2}"#).unwrap(),
            StartupLine::Ready(11_200)
        );
        // A load time that is not a sane number is ignored, never trusted.
        assert_eq!(
            parse_startup_line(r#"{"ok":true,"event":"ready","load_seconds":"soon"}"#).unwrap(),
            StartupLine::Ready(0)
        );
        assert_eq!(parse_startup_line("noise").unwrap(), StartupLine::Ignored);
        assert!(parse_startup_line(r#"{"ok":false,"event":"error","message":"x"}"#).is_err());
        assert_eq!(
            parse_startup_line(r#"{"ok":true,"event":"exiting"}"#).unwrap_err().reason,
            REASON_WORKER_EXITED
        );
    }

    #[test]
    fn the_request_line_is_bounded_and_injection_safe() {
        let line = build_request_line(42, 9, "open \"cmd\" && rm -rf / \n end");
        // Exactly one newline, at the end: the worker reads by line, so a
        // request without it would never be read at all.
        assert!(line.ends_with('\n'));
        assert_eq!(line.matches('\n').count(), 1);
        let value: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(value["cmd"], serde_json::json!("decide"));
        assert_eq!(value["id"], serde_json::json!(42));
        assert_eq!(value["generation"], serde_json::json!(9));
        // The text stays one field: it can never inject a protocol field.
        assert_eq!(value.as_object().unwrap().len(), 4);
        let long = "x".repeat(LAYA_MAX_TEXT_CHARS * 2);
        assert_eq!(validate_request(&long).unwrap().chars().count(), LAYA_MAX_TEXT_CHARS);
        assert!(validate_request("   ").is_err());
        assert!(build_request_line(1, 1, &long).len() <= LAYA_MAX_LINE_BYTES);
    }

    #[test]
    fn the_worker_argv_is_separate_entries_and_never_a_shell_string() {
        let paths = LayaPaths {
            python: PathBuf::from("C:/laya/venv/Scripts/python.exe"),
            worker: PathBuf::from("C:/app/choom-laya.py"),
            model: PathBuf::from("C:/laya/model"),
            manifest: PathBuf::from("C:/laya/model-manifest.json"),
        };
        let argv: Vec<String> = worker_argv(&paths)
            .iter()
            .map(|a| a.to_string_lossy().to_string())
            .collect();
        assert_eq!(
            argv,
            vec![
                "-u",
                "C:/app/choom-laya.py",
                "--model",
                "C:/laya/model",
                "--manifest",
                "C:/laya/model-manifest.json",
            ]
        );
        // No network flag, no shell, no download: the worker is told exactly
        // which local files to use and nothing else.
        assert!(!argv.iter().any(|a| a.contains("http")));
    }

    #[test]
    fn explicit_paths_are_validated_before_anything_starts() {
        let paths = staged_paths();
        let (python, model, manifest) = settings_strings(&paths);
        assert!(validate_paths(&python, &model, &manifest).is_ok());
        // Empty, relative and missing input is refused, never guessed.
        assert!(validate_paths("", &model, &manifest).is_err());
        assert!(validate_paths("python.exe", &model, &manifest).is_err());
        assert!(validate_paths(&python, "", &manifest).is_err());
        assert!(validate_paths(&python, &model, "").is_err());
        let elsewhere = fixture_dir().join("elsewhere");
        std::fs::create_dir_all(&elsewhere).unwrap();
        assert!(validate_paths(
            &elsewhere.join("model").to_string_lossy(),
            &model,
            &manifest
        )
        .is_err());
        // An interpreter whose name is not Python is never launched.
        let impostor = fixture_dir().join("run-me.exe");
        std::fs::write(&impostor, b"").unwrap();
        assert!(validate_paths(&impostor.to_string_lossy(), &model, &manifest).is_err());
        // A bounded manifest, and a bounded path length.
        let big = fixture_dir().join("big-manifest.json");
        std::fs::write(&big, vec![0u8; (LAYA_MAX_MANIFEST_BYTES + 1) as usize]).unwrap();
        assert!(validate_paths(&python, &model, &big.to_string_lossy()).is_err());
        let absurd = "C:/".to_string() + &"a".repeat(LAYA_MAX_PATH_CHARS);
        assert!(validate_paths(&absurd, &model, &manifest).is_err());
    }

    #[test]
    fn status_is_honest_when_nothing_is_configured() {
        // The production runtime, so the published deadlines are the real ones.
        let rt = LayaRuntime::default();
        let status = rt.status_now(true, "", "", "", LAYA_THRESHOLD_DEFAULT);
        assert_eq!(status.state, LayaState::Missing);
        assert!(!status.ready);
        assert_eq!(status.last_reason.as_deref(), Some(REASON_MISSING_RUNTIME));
        assert!(!status.detail.is_empty());
        // The fixed five labels are published whatever the setup is.
        assert_eq!(status.labels, LAYA_LABELS.to_vec());
        assert_eq!(status.startup_timeout_ms, LAYA_STARTUP_TIMEOUT_MS);
        assert_eq!(status.decision_timeout_ms, LAYA_DECISION_TIMEOUT_MS);
        assert_eq!(status.idle_unload_ms, LAYA_IDLE_UNLOAD_MS);
    }

    #[test]
    fn status_is_honest_when_paths_exist_but_nothing_is_warm() {
        let rt = LayaRuntime::new(test_timing());
        let paths = staged_paths();
        let status = status_of(&rt, &paths, true);
        // Files exist, so the honest word is loading, never ready.
        assert_eq!(status.state, LayaState::Loading);
        assert!(!status.ready);
        assert!(status.worker_path.is_some());
        let off = status_of(&rt, &paths, false);
        assert_eq!(off.state, LayaState::Missing);
        assert_eq!(off.last_reason.as_deref(), Some(REASON_DISABLED));
    }

    #[test]
    fn threshold_clamps_stay_inside_the_laya_bounds() {
        assert_eq!(clamp_threshold(f64::NAN), LAYA_THRESHOLD_DEFAULT);
        assert_eq!(clamp_threshold(0.1), LAYA_THRESHOLD_MIN);
        assert_eq!(clamp_threshold(0.99), LAYA_THRESHOLD_MAX);
        assert_eq!(clamp_threshold(0.8), 0.8);
        // The Laya floor is its own and never borrowed from the cloud engine.
        assert!(LAYA_THRESHOLD_DEFAULT >= crate::choom::jev::JEV_THRESHOLD_DEFAULT);
    }

    // ── Synthetic fixture processes ───────────────────────────────────────────

    #[test]
    fn fixture_process_answers_one_warm_decision() {
        let (rt, paths, marker) = fixture_runtime("valid", test_timing());
        let outcome = rt.decide_now(&fence(), 0, "what is a folder", true, &paths, LAYA_THRESHOLD_DEFAULT);
        assert_eq!(outcome.route, "answer", "reason {:?}", outcome.fallback_reason);
        assert!((outcome.confidence - 0.92).abs() < 1e-9);
        assert_eq!(outcome.mode, "local");
        // This engine ranks no candidate and executes nothing.
        assert!(outcome.candidate_id.is_none());
        assert!(outcome.fallback_reason.is_none());
        assert_eq!(marker_lines(&marker), 1);
        // The receipt is sanitized: no request text anywhere.
        let history = rt.history();
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].route, "answer");
        assert!(!serde_json::to_string(&history).unwrap().contains("folder"));
        assert!(!serde_json::to_string(&outcome).unwrap().contains("folder"));
    }

    #[test]
    fn readiness_needs_the_real_warm_up() {
        let (rt, paths, _marker) = fixture_runtime("valid", test_timing());
        let before = status_of(&rt, &paths, true);
        assert_eq!(before.state, LayaState::Loading);
        assert!(!before.ready);
        assert!(before.load_ms.is_none());
        let outcome = rt.decide_now(&fence(), 0, "what is a folder", true, &paths, LAYA_THRESHOLD_DEFAULT);
        assert_eq!(outcome.route, "answer");
        let after = status_of(&rt, &paths, true);
        assert_eq!(after.state, LayaState::Ready);
        assert!(after.ready);
    }

    #[test]
    fn fixture_malformed_output_never_decides() {
        let cases = [
            ("unknown-label", REASON_PROTOCOL),
            ("unnormalized", REASON_PROTOCOL),
            ("disagreement", REASON_PROTOCOL),
            ("non-finite", REASON_PROTOCOL),
            ("candidate", REASON_PROTOCOL),
            ("wrong-id", REASON_WRONG_ID),
            ("stale-generation", REASON_STALE_GENERATION),
            ("worker-refused", REASON_WORKER_REFUSED),
            ("junk", REASON_PROTOCOL),
            ("oversized", REASON_OVERSIZED),
        ];
        for (mode, expected) in cases {
            let (rt, paths, _marker) = fixture_runtime(mode, test_timing());
            let outcome = rt.decide_now(&fence(), 0, "what is a folder", true, &paths, LAYA_THRESHOLD_DEFAULT);
            assert_eq!(outcome.route, "unknown", "mode {mode} must not decide");
            assert_eq!(outcome.fallback_reason.as_deref(), Some(expected), "mode {mode} reason");
            // Every refusal tears the worker down: a desynced stream is never
            // reused and the status stays honest.
            assert_ne!(status_of(&rt, &paths, true).state, LayaState::Ready, "mode {mode} stays ready");
        }
    }

    #[test]
    fn fixture_timeout_is_a_real_deadline_and_takes_the_worker_with_it() {
        let mut timing = test_timing();
        timing.decision = Duration::from_millis(300);
        let (rt, paths, _marker) = fixture_runtime("hang", timing);
        let started = Instant::now();
        let outcome = rt.decide_now(&fence(), 0, "what is a folder", true, &paths, LAYA_THRESHOLD_DEFAULT);
        assert_eq!(outcome.route, "unknown");
        assert_eq!(outcome.fallback_reason.as_deref(), Some(REASON_DECISION_TIMEOUT));
        assert!(started.elapsed() < Duration::from_secs(3));
        assert_ne!(status_of(&rt, &paths, true).state, LayaState::Ready);
    }

    #[test]
    fn the_startup_deadline_is_honoured() {
        let mut timing = test_timing();
        timing.startup = Duration::from_millis(400);
        let (rt, paths, _marker) = fixture_runtime("no-ready", timing);
        let started = Instant::now();
        let outcome = rt.decide_now(&fence(), 0, "what is a folder", true, &paths, LAYA_THRESHOLD_DEFAULT);
        assert_eq!(outcome.fallback_reason.as_deref(), Some(REASON_STARTUP_TIMEOUT));
        assert!(started.elapsed() < Duration::from_secs(3));
        let status = status_of(&rt, &paths, true);
        assert_eq!(status.state, LayaState::Error);
        assert_eq!(status.last_reason.as_deref(), Some(REASON_STARTUP_TIMEOUT));
    }

    #[test]
    fn cancel_tears_the_worker_down_and_the_next_call_readmits() {
        let (rt, paths, marker) = fixture_runtime("valid", test_timing());
        let outcome = rt.decide_now(&fence(), 0, "what is a folder", true, &paths, LAYA_THRESHOLD_DEFAULT);
        assert_eq!(outcome.route, "answer");
        assert_eq!(status_of(&rt, &paths, true).state, LayaState::Ready);
        rt.cancel_owned();
        assert_ne!(status_of(&rt, &paths, true).state, LayaState::Ready);
        // Readmission happens only after the previous kill and wait finished,
        // so exactly one worker ran at a time.
        let again = rt.decide_now(&fence(), 0, "and again", true, &paths, LAYA_THRESHOLD_DEFAULT);
        assert_eq!(again.route, "answer");
        assert_eq!(marker_lines(&marker), 2);
    }

    #[test]
    fn a_cancelled_turn_never_acts() {
        let (rt, paths, marker) = fixture_runtime("valid", test_timing());
        let fence = fence();
        fence.0.fetch_add(1, Ordering::SeqCst);
        let outcome = rt.decide_now(&fence, 0, "what is a folder", true, &paths, LAYA_THRESHOLD_DEFAULT);
        assert_eq!(outcome.route, "cancelled");
        assert!(rt.history().is_empty());
        // Refused before dispatch: no worker was ever started for that turn.
        assert_eq!(marker_lines(&marker), 0);
    }

    #[test]
    fn two_concurrent_decides_share_one_worker() {
        let (rt, paths, marker) = fixture_runtime("valid", test_timing());
        let shared = Arc::new(rt);
        let fence = fence();
        let fence = Arc::new(fence);
        let handles: Vec<_> = (0..2)
            .map(|_| {
                let runtime = shared.clone();
                let fence = fence.clone();
                let paths = paths.clone();
                std::thread::spawn(move || {
                    let executor =
                        tokio::runtime::Builder::new_current_thread().build().unwrap();
                    executor.block_on(async move {
                        let _admission = runtime.admission.lock().await;
                        runtime.decide_now(
                            &fence,
                            0,
                            "what is a folder",
                            true,
                            &paths,
                            LAYA_THRESHOLD_DEFAULT,
                        )
                    })
                })
            })
            .collect();
        let outcomes: Vec<LayaOutcome> = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect();
        assert_eq!(outcomes.len(), 2);
        for outcome in outcomes {
            assert_eq!(outcome.route, "answer");
        }
        // One admission and one child: the second caller waited its turn.
        assert_eq!(marker_lines(&marker), 1);
        assert_eq!(shared.history().len(), 2);
    }

    #[test]
    fn the_idle_window_unloads_the_worker() {
        let mut timing = test_timing();
        timing.idle = Duration::from_millis(200);
        let (rt, paths, _marker) = fixture_runtime("valid", timing);
        let outcome = rt.decide_now(&fence(), 0, "what is a folder", true, &paths, LAYA_THRESHOLD_DEFAULT);
        assert_eq!(outcome.route, "answer");
        assert_eq!(status_of(&rt, &paths, true).state, LayaState::Ready);
        std::thread::sleep(Duration::from_millis(1200));
        // An unused worker is torn down instead of holding its working set.
        assert_ne!(status_of(&rt, &paths, true).state, LayaState::Ready);
    }

    #[test]
    fn a_worker_that_exits_is_not_reused() {
        let (rt, paths, marker) = fixture_runtime("exit-after-answer", test_timing());
        let outcome = rt.decide_now(&fence(), 0, "what is a folder", true, &paths, LAYA_THRESHOLD_DEFAULT);
        assert_eq!(outcome.route, "answer", "reason {:?}", outcome.fallback_reason);
        // The fixture leaves right after answering: the dead child is never
        // handed out again, so the next request starts a fresh worker.
        std::thread::sleep(Duration::from_millis(300));
        let again = rt.decide_now(&fence(), 0, "what is a folder", true, &paths, LAYA_THRESHOLD_DEFAULT);
        assert_eq!(again.route, "answer", "reason {:?}", again.fallback_reason);
        // The dead child was never handed out again: a fresh worker answered.
        assert_eq!(marker_lines(&marker), 2);
    }

    #[test]
    fn low_confidence_clarifies_and_never_guesses() {
        let (rt, paths, _marker) = fixture_runtime("low-confidence", test_timing());
        let outcome = rt.decide_now(&fence(), 0, "do the thing", true, &paths, LAYA_THRESHOLD_DEFAULT);
        assert_eq!(outcome.route, "unknown");
        assert_eq!(outcome.fallback_reason.as_deref(), Some(REASON_LOW_CONFIDENCE));
        assert!((outcome.confidence - 0.30).abs() < 1e-9);
        // A stricter threshold keeps even a clear answer out of action.
        let (rt, paths, _marker) = fixture_runtime("abstain", test_timing());
        let outcome = rt.decide_now(&fence(), 0, "do the thing", true, &paths, 0.99);
        assert_eq!(outcome.route, "unknown");
        assert_eq!(outcome.fallback_reason.as_deref(), Some(REASON_LOW_CONFIDENCE));
    }

    #[test]
    fn disabled_laya_starts_nothing() {
        let (rt, paths, marker) = fixture_runtime("valid", test_timing());
        let outcome = rt.decide_now(&fence(), 0, "what is a folder", false, &paths, LAYA_THRESHOLD_DEFAULT);
        assert_eq!(outcome.route, "unknown");
        assert_eq!(outcome.fallback_reason.as_deref(), Some(REASON_DISABLED));
        assert_eq!(marker_lines(&marker), 0);
    }

    #[test]
    fn the_engine_selector_defaults_to_online_and_refuses_unknown_values() {
        // Every settings file written before Local Laya existed has no engine
        // field at all, so the selector must read as the online engine.
        assert_eq!(ENGINE_JEV, "jev");
        assert_eq!(ENGINE_LAYA, "laya");
        assert!(!local_engine_selected(""));
        assert!(!local_engine_selected("jev"));
        assert!(!local_engine_selected("JEVENT"));
        // A corrupt or future value must never start a local worker.
        assert_eq!(normalize_engine(""), ENGINE_JEV);
        assert_eq!(normalize_engine("cloud"), ENGINE_JEV);
        assert_eq!(normalize_engine("laya2"), ENGINE_JEV);
        assert_eq!(normalize_engine("true"), ENGINE_JEV);
        assert_eq!(normalize_engine("jev"), ENGINE_JEV);
        assert_eq!(normalize_engine("  laya  "), ENGINE_LAYA);
        assert_eq!(normalize_engine("LAYA"), ENGINE_LAYA);
        assert!(local_engine_selected("laya"));
        assert!(local_engine_selected(" Laya "));
    }

    #[test]
    fn the_readiness_check_warms_the_model_and_records_no_decision() {
        let (rt, paths, marker) = fixture_runtime("valid", test_timing());
        // Before the check nothing has warmed up, so the honest state is
        // loading and never ready just because the files exist.
        let (runtime, model, manifest) = settings_strings(&paths);
        let before = rt.status_now(true, &runtime, &model, &manifest, LAYA_THRESHOLD_DEFAULT);
        assert_eq!(before.state, LayaState::Loading);
        assert!(!before.ready);
        let outcome = rt.inner.check_now(&fence(), 0, true, &paths, LAYA_THRESHOLD_DEFAULT);
        assert_eq!(outcome.route, "answer", "the probe is answered by a real inference");
        // The warm-up earns Ready, and it is backed by a worker that ran.
        let after = rt.status_now(true, &runtime, &model, &manifest, LAYA_THRESHOLD_DEFAULT);
        assert_eq!(after.state, LayaState::Ready);
        assert!(after.ready);
        assert!(after.load_ms.is_some());
        // A probe is not a user request, so it leaves no decision receipt.
        assert!(rt.history().is_empty(), "the check must not fake a decision");
        assert_eq!(marker_lines(&marker), 1);
    }

    #[test]
    fn the_readiness_check_of_a_missing_runtime_starts_nothing() {
        let (rt, _paths, _marker) = fixture_runtime("valid", test_timing());
        // No paths at all: the card reads the honest missing state, and no
        // worker is started for a setup that failed validation.
        let status = rt.status_now(true, "", "", "", LAYA_THRESHOLD_DEFAULT);
        assert_eq!(status.state, LayaState::Missing);
        assert!(!status.ready);
        assert_eq!(status.last_reason.as_deref(), Some(REASON_MISSING_RUNTIME));
        assert!(!status.detail.contains('\n'));
    }

    #[test]
    fn shutdown_tears_the_worker_down_and_readmits_nothing() {
        let (rt, paths, marker) = fixture_runtime("valid", test_timing());
        let outcome = rt.decide_now(&fence(), 0, "what is a folder", true, &paths, LAYA_THRESHOLD_DEFAULT);
        assert_eq!(outcome.route, "answer");
        rt.teardown();
        let outcome = rt.decide_now(&fence(), 0, "and again", true, &paths, LAYA_THRESHOLD_DEFAULT);
        assert_eq!(outcome.route, "unknown");
        assert_eq!(outcome.fallback_reason.as_deref(), Some(REASON_STOPPING));
        assert_eq!(marker_lines(&marker), 1);
    }

    #[test]
    fn a_cancel_during_warmup_reaches_the_loading_child() {
        let mut timing = test_timing();
        timing.startup = Duration::from_millis(5_000);
        let (rt, paths, marker) = fixture_runtime("no-ready", timing);
        let shared = Arc::new(rt);
        let fence = fence();
        let decision = {
            let shared = shared.clone();
            let fence = fence.clone();
            let paths = paths.clone();
            std::thread::spawn(move || {
                let executor = tokio::runtime::Builder::new_current_thread().build().unwrap();
                executor.block_on(async move {
                    let _admission = shared.admission.lock().await;
                    shared.inner.decide_now(&fence, 0, "what is a folder", true, &paths, LAYA_THRESHOLD_DEFAULT, true)
                })
            })
        };
        // The child is published while it loads, so a cancel during the warm-up
        // has something to kill: wait for the slot to hold it and for the
        // child to have really started.
        let mut owned = None;
        for _ in 0..200 {
            owned = shared.current_session();
            if owned.is_some() && marker_lines(&marker) == 1 {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(owned.is_some(), "a loading worker must be owned while it loads");
        assert_eq!(marker_lines(&marker), 1, "the loading child must really run");
        let started = Instant::now();
        shared.cancel_owned();
        let elapsed = started.elapsed();
        // Killed and reaped promptly, never held behind the loading worker.
        assert!(elapsed < Duration::from_secs(2), "cancel took {elapsed:?}");
        assert!(!shared.current_session().is_some(), "the slot must be empty");
        let outcome = decision.join().unwrap();
        // The pending request is cancelled, not reported as a load failure.
        assert_eq!(outcome.route, "cancelled");
        assert!(shared.history().is_empty());
        assert_eq!(marker_lines(&marker), 1);
        shared.teardown();
    }

    #[test]
    fn a_flood_is_refused_without_waiting_or_growing() {
        let mut timing = test_timing();
        timing.decision = Duration::from_millis(2_000);
        let (rt, paths, _marker) = fixture_runtime("flood", timing);
        let started = Instant::now();
        let outcome = rt.decide_now(&fence(), 0, "what is a folder", true, &paths, LAYA_THRESHOLD_DEFAULT);
        let elapsed = started.elapsed();
        assert_eq!(outcome.route, "unknown");
        // Endless noise ends at the bounded junk count, never at the deadline.
        assert_eq!(outcome.fallback_reason.as_deref(), Some(REASON_PROTOCOL));
        assert!(elapsed < timing.decision, "the flood ran to the deadline: {elapsed:?}");
        // The flooding worker is torn down with it.
        assert_ne!(status_of(&rt, &paths, true).state, LayaState::Ready);
    }

    #[test]
    fn bytes_that_are_not_utf8_are_refused_never_repaired() {
        let (rt, paths, _marker) = fixture_runtime("malformed-utf8", test_timing());
        let outcome = rt.decide_now(&fence(), 0, "what is a folder", true, &paths, LAYA_THRESHOLD_DEFAULT);
        assert_eq!(outcome.route, "unknown");
        assert_eq!(outcome.fallback_reason.as_deref(), Some(REASON_PROTOCOL));
        assert_ne!(status_of(&rt, &paths, true).state, LayaState::Ready);
    }

    #[test]
    fn a_cancel_is_never_queued_behind_a_blocked_write() {
        let (rt, paths, _marker) = fixture_runtime("answers-then-stops-reading", test_timing());
        let outcome = rt.decide_now(&fence(), 0, "what is a folder", true, &paths, LAYA_THRESHOLD_DEFAULT);
        assert_eq!(outcome.route, "answer");
        let session = rt.current_session().expect("a worker to wedge");
        // Wedge the request pipe for real: the worker answered once and will
        // never read again, so queued lines fill the pipe and the writer thread
        // blocks inside its own write, holding nothing the kill path needs.
        let mut wedged = false;
        for _ in 0..64 {
            if !session.queue_line(vec![b'x'; 4096], Duration::from_millis(150)) {
                wedged = true;
                break;
            }
        }
        assert!(wedged, "the request pipe should have filled");
        let started = Instant::now();
        rt.cancel_owned();
        let elapsed = started.elapsed();
        assert!(elapsed < Duration::from_secs(2), "cancel waited {elapsed:?} behind the write");
        assert!(!session.alive(), "the worker must be gone after the cancel");
        drop(session);
        rt.teardown();
    }

    #[test]
    fn a_changed_setup_retires_the_old_worker_before_it_is_reused() {
        let tag = next_tag();
        let (rt, first, marker_first) =
            fixture_runtime_for("valid", test_timing(), staged_paths_in("set-a"), tag);
        let outcome = rt.decide_now(&fence(), 0, "what is a folder", true, &first, LAYA_THRESHOLD_DEFAULT);
        assert_eq!(outcome.route, "answer", "reason {:?}", outcome.fallback_reason);
        assert_eq!(status_of(&rt, &first, true).state, LayaState::Ready);

        // A reconfigured card must never read the old worker's warmth as its
        // own readiness.
        let second = staged_paths_in("set-b");
        let swapped = status_of(&rt, &second, true);
        assert!(!swapped.ready, "an old worker may not report ready for a new setup");
        assert_ne!(swapped.state, LayaState::Ready);

        // The request for the new setup retires the old worker and warms its
        // own: one worker per configuration, never shared across them.
        let outcome = rt.decide_now(&fence(), 0, "what is a folder", true, &second, LAYA_THRESHOLD_DEFAULT);
        assert_eq!(outcome.route, "answer", "reason {:?}", outcome.fallback_reason);
        assert_eq!(status_of(&rt, &second, true).state, LayaState::Ready);
        assert_eq!(marker_lines(&marker_first), 1);
        assert_eq!(marker_lines(&marker_for("valid", &second, tag)), 1);
        // Going back to the first setup warms it again rather than trusting
        // the second worker's warmth.
        let back = rt.decide_now(&fence(), 0, "what is a folder", true, &first, LAYA_THRESHOLD_DEFAULT);
        assert_eq!(back.route, "answer");
        assert_eq!(marker_lines(&marker_first), 2);
        rt.teardown();
    }

    #[test]
    fn replacing_assets_in_place_invalidates_a_warm_worker() {
        let (rt, paths, marker) = fixture_runtime("valid", test_timing());
        let weights = paths.model.join("model.safetensors");
        std::fs::write(&weights, b"first").unwrap();
        assert_eq!(rt.decide_now(&fence(), 0, "what is a folder", true, &paths, LAYA_THRESHOLD_DEFAULT).route, "answer");
        let old = rt.current_session().unwrap();
        std::fs::write(&weights, b"replacement weights").unwrap();
        assert_ne!(status_of(&rt, &paths, true).state, LayaState::Ready);
        assert_eq!(rt.decide_now(&fence(), 0, "what is a folder", true, &paths, LAYA_THRESHOLD_DEFAULT).route, "answer");
        assert!(!old.alive(), "the replaced setup must retire its prior child");
        assert_eq!(marker_lines(&marker), 2);
        rt.teardown();
    }

    #[test]
    fn replacing_worker_or_manifest_changes_its_identity() {
        let mut paths = staged_paths();
        paths.worker = paths.manifest.with_file_name("worker.py");
        std::fs::write(&paths.worker, b"first").unwrap();
        let first = paths.identity();
        std::fs::write(&paths.worker, b"replacement script").unwrap();
        assert_ne!(first, paths.identity());
        let second = paths.identity();
        std::fs::write(&paths.manifest, b"replacement manifest").unwrap();
        assert_ne!(second, paths.identity());
    }

    #[test]
    fn the_worker_identity_is_the_resolved_setup() {
        let first = staged_paths_in("identity-a");
        let second = staged_paths_in("identity-b");
        assert_ne!(first.identity(), second.identity());
        // Two spellings of one setup resolve to one identity.
        let spelled = LayaPaths {
            python: first.python.clone(),
            worker: first.worker.clone(),
            model: first.model.join("..").join("model"),
            manifest: first.manifest.clone(),
        };
        assert_eq!(first.identity(), spelled.identity());
        assert_eq!(first.identity(), first.identity());
    }

    #[test]
    fn two_concurrent_cancels_keep_the_door_shut_until_the_reap_is_done() {
        let (rt, paths, marker) = fixture_runtime("valid", test_timing());
        let rt = Arc::new(rt);
        let outcome = rt.decide_now(&fence(), 0, "what is a folder", true, &paths, LAYA_THRESHOLD_DEFAULT);
        assert_eq!(outcome.route, "answer");
        let gate = rt.with_reap_gate();
        let session = rt.current_session().expect("a worker to cancel");

        // The first cancel takes the worker and is held inside its reap.
        let first = {
            let rt = rt.clone();
            std::thread::spawn(move || rt.cancel_owned())
        };
        assert!(wait_until(Duration::from_secs(2), || gate.entered() >= 1), "the reap never opened");
        assert_eq!(rt.reaping(), 1);
        // Ownership is retained until the process really goes.
        assert!(session.alive(), "the worker must not be dropped before its reap");

        // The second cancel finds an empty slot and must return without
        // opening the door while the first reap is still running.
        let second = {
            let rt = rt.clone();
            std::thread::spawn(move || rt.cancel_owned())
        };
        assert!(second.join().is_ok(), "a second cancel must not block");
        assert_eq!(rt.reaping(), 1, "a cancel with no slot must not clear the reap");

        // A request arriving now may not start a worker beside the one on its
        // way out.
        let pending = {
            let rt = rt.clone();
            let paths = paths.clone();
            std::thread::spawn(move || {
                rt.decide_now(&FlowFence::default(), 0, "what is a folder", true, &paths, LAYA_THRESHOLD_DEFAULT)
            })
        };
        std::thread::sleep(Duration::from_millis(200));
        assert!(!pending.is_finished(), "a request waited for nothing and admitted anyway");
        assert_eq!(marker_lines(&marker), 1, "no second worker may start beside a reap");

        gate.open_all();
        first.join().unwrap();
        let outcome = pending.join().unwrap();
        assert_eq!(outcome.route, "answer", "reason {:?}", outcome.fallback_reason);
        assert_eq!(rt.reaping(), 0);
        // Exactly one new worker, started only after the old one was gone.
        assert_eq!(marker_lines(&marker), 2);
        rt.teardown();
    }

    #[test]
    fn a_cancel_during_a_discard_cannot_open_the_door() {
        // The flood worker is discarded on the protocol failure, which is the
        // one reap this test holds open.
        let (rt, paths, marker) = fixture_runtime("flood", test_timing());
        let rt = Arc::new(rt);
        let gate = rt.with_reap_gate();
        let discard = {
            let rt = rt.clone();
            let paths = paths.clone();
            std::thread::spawn(move || {
                rt.decide_now(&FlowFence::default(), 0, "what is a folder", true, &paths, LAYA_THRESHOLD_DEFAULT)
            })
        };
        assert!(wait_until(Duration::from_secs(2), || gate.entered() >= 1), "the discard never opened");
        // The discard has closed the slot but still owns the reap.
        assert!(rt.current_session().is_none());
        assert_eq!(rt.reaping(), 1);

        // A cancel arriving into that window finds no slot and must leave the
        // admission shut until the owned reap finishes.
        rt.cancel_owned();
        assert_eq!(rt.reaping(), 1, "a cancel must not clear a reap it does not own");

        let pending = {
            let rt = rt.clone();
            let paths = paths.clone();
            std::thread::spawn(move || {
                rt.decide_now(&FlowFence::default(), 0, "what is a folder", true, &paths, LAYA_THRESHOLD_DEFAULT)
            })
        };
        std::thread::sleep(Duration::from_millis(200));
        assert!(!pending.is_finished());
        gate.open_all();
        let outcome = discard.join().unwrap();
        assert_eq!(outcome.fallback_reason.as_deref(), Some(REASON_PROTOCOL));
        let outcome = pending.join().unwrap();
        // The flood is refused again, but only after the reap finished, and no
        // second worker ever ran beside the one on its way out.
        assert_eq!(outcome.fallback_reason.as_deref(), Some(REASON_PROTOCOL));
        assert_eq!(rt.reaping(), 0);
        assert!(marker_lines(&marker) >= 1);
        rt.teardown();
    }

    #[test]
    fn an_idle_unload_holds_the_next_request_until_the_worker_is_gone() {
        let mut timing = test_timing();
        timing.idle = Duration::from_millis(150);
        let (rt, paths, marker) = fixture_runtime("valid", timing);
        let rt = Arc::new(rt);
        let outcome = rt.decide_now(&fence(), 0, "what is a folder", true, &paths, LAYA_THRESHOLD_DEFAULT);
        assert_eq!(outcome.route, "answer");
        let gate = rt.with_reap_gate();
        // Let the idle window pass: the watcher takes its reap and is held.
        assert!(wait_until(Duration::from_secs(3), || gate.entered() >= 1), "the idle unload never opened");
        assert_eq!(rt.reaping(), 1);

        let pending = {
            let rt = rt.clone();
            let paths = paths.clone();
            std::thread::spawn(move || {
                rt.decide_now(&FlowFence::default(), 0, "what is a folder", true, &paths, LAYA_THRESHOLD_DEFAULT)
            })
        };
        std::thread::sleep(Duration::from_millis(200));
        assert!(!pending.is_finished(), "the request started a worker beside the idle reap");
        assert_eq!(marker_lines(&marker), 1);
        gate.open_all();
        let outcome = pending.join().unwrap();
        assert_eq!(outcome.route, "answer", "reason {:?}", outcome.fallback_reason);
        assert_eq!(marker_lines(&marker), 2);
        rt.teardown();
    }

    #[test]
    fn the_history_is_bounded() {
        let (rt, paths, _marker) = fixture_runtime("valid", test_timing());
        for _ in 0..(LAYA_MAX_HISTORY + 5) {
            rt.decide_now(&fence(), 0, "what is a folder", true, &paths, LAYA_THRESHOLD_DEFAULT);
        }
        assert_eq!(rt.history().len(), LAYA_MAX_HISTORY);
        rt.clear_history();
        assert!(rt.history().is_empty());
    }

    /// The live staged adapter test. It is ignored on purpose: it loads a real
    /// local model, so it is never part of the default suite. Run it
    /// explicitly with:
    ///
    ///   cd windows
    ///   cargo test -p coucou --lib laya::tests::live_staged_inference -- --ignored --nocapture
    ///
    /// It uses the production spawner and the production deadlines, so it
    /// measures the real path rather than a shortcut. The staged runtime
    /// defaults to the one in the handoff and can be pointed elsewhere with
    /// COUCOU_LAYA_RUNTIME. A missing staged runtime is a failure here, not a
    /// quiet pass: this test exists to prove a real local inference, so nothing
    /// to prove means the proof did not happen.
    #[test]
    #[ignore = "loads the real staged local model, run it explicitly"]
    fn live_staged_inference() {
        let staged = std::env::var("COUCOU_LAYA_RUNTIME").unwrap_or_else(|_| {
            "C:/Users/ether/Documents/Coucou/.scratch/laya-runtime".to_string()
        });
        let (python, model, manifest) = (
            format!("{staged}/venv/Scripts/python.exe"),
            format!("{staged}/model"),
            format!("{staged}/model-manifest.json"),
        );
        let paths = validate_paths(&python, &model, &manifest).unwrap_or_else(|failure| {
            panic!(
                "the staged local runtime must be present to run this test ({}): {staged}",
                failure.reason
            )
        });
        let rt = LayaRuntime::new(LayaTiming {
            startup: Duration::from_millis(LAYA_STARTUP_TIMEOUT_MS),
            decision: Duration::from_millis(LAYA_DECISION_TIMEOUT_MS),
            idle: Duration::from_millis(LAYA_IDLE_UNLOAD_MS),
        });
        let started = Instant::now();
        let outcome = rt.decide_now(&fence(), 0, "what is a computer folder is", true, &paths, LAYA_THRESHOLD_DEFAULT);
        let total = started.elapsed();
        let status = status_of(&rt, &paths, true);
        eprintln!(
            "live staged: worker load {:>6} ms, adapter total {:>6} ms \
             (startup budget {} ms, decision budget {} ms), route {}, confidence {:.3}",
            status.load_ms.unwrap_or(0),
            total.as_millis(),
            LAYA_STARTUP_TIMEOUT_MS,
            LAYA_DECISION_TIMEOUT_MS,
            outcome.route,
            outcome.confidence
        );
        assert!(LAYA_LABELS.contains(&outcome.route.as_str()));
        assert!(outcome.candidate_id.is_none());
        // The worker load and its warm-up ran inside the startup budget, and
        // the inference itself inside the production decision deadline: a
        // request that missed either is a failure, not a decision.
        assert_ne!(outcome.fallback_reason.as_deref(), Some(REASON_DECISION_TIMEOUT));
        assert_ne!(outcome.fallback_reason.as_deref(), Some(REASON_STARTUP_TIMEOUT));
        assert_eq!(status.state, LayaState::Ready);
        rt.teardown();
        // One real inference proves the load path and the protocol. It proves
        // nothing at all about accuracy.
    }

    /// The synthetic worker process. Every fixture mode speaks the real line
    /// protocol over real pipes. libtest prints its own harness lines around
    /// it, which are not JSON, so the adapter skips them.
    #[test]
    fn fixture_worker() {
        let Ok(mode) = std::env::var(FIXTURE_ENV) else {
            return;
        };
        if let Ok(marker) = std::env::var(FIXTURE_MARKER_ENV) {
            if let Ok(mut file) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(marker)
            {
                let _ = writeln!(file, "started");
            }
        }
        // libtest writes an unterminated "test <name> ... " line before the
        // body runs. One bare newline closes it, so the protocol keeps its
        // framing and the adapter sees that leftover text as the non-JSON
        // noise it already skips.
        {
            let mut out = std::io::stdout();
            let _ = out.write_all(b"\n");
            let _ = out.flush();
        }
        let mut stdin = std::io::stdin().lock();
        let mut line = String::new();
        if mode == "no-ready" {
            // Startup never completes: the adapter must hit its own deadline,
            // and a cancel during this wait must still reach this process.
            loop {
                line.clear();
                if stdin.read_line(&mut line).unwrap_or(0) == 0 {
                    std::thread::sleep(Duration::from_secs(60));
                    return;
                }
            }
        }
        emit(r#"{"ok":true,"event":"ready","load_seconds":0.01,"labels":["answer"]}"#);
        loop {
            line.clear();
            match stdin.read_line(&mut line) {
                Ok(0) | Err(_) => return,
                Ok(_) => {}
            }
            let trimmed = line.trim().to_string();
            if trimmed.is_empty() {
                continue;
            }
            let value: Value = serde_json::from_str(&trimmed).unwrap_or(Value::Null);
            let id = value.get("id").and_then(Value::as_u64).unwrap_or(0);
            let generation = value.get("generation").and_then(Value::as_u64).unwrap_or(0);
            if value.get("cmd").and_then(Value::as_str) == Some("exit") {
                emit(r#"{"ok":true,"event":"exiting"}"#);
                return;
            }
            let distribution = "{\"answer\":0.92,\"options\":0.03,\"clarify\":0.02,\"supported_local\":0.02,\"unknown\":0.01}";
            let answer = match mode.as_str() {
                "valid" | "answers-then-stops-reading" => format!(
                    "{{\"ok\":true,\"id\":{id},\"generation\":{generation},\"label\":\"answer\",\
                     \"selected_probability\":0.92,\"probabilities\":{distribution}}}"
                ),
                "abstain" => format!(
                    "{{\"ok\":true,\"id\":{id},\"generation\":{generation},\"label\":\"clarify\",\
                     \"selected_probability\":0.9,\"probabilities\":{{\"answer\":0.0,\"options\":0.0,\
                     \"clarify\":0.9,\"supported_local\":0.0,\"unknown\":0.1}}}}"
                ),
                "low-confidence" => format!(
                    "{{\"ok\":true,\"id\":{id},\"generation\":{generation},\"label\":\"supported_local\",\
                     \"selected_probability\":0.3,\"probabilities\":{{\"answer\":0.25,\"options\":0.05,\
                     \"clarify\":0.2,\"supported_local\":0.3,\"unknown\":0.2}}}}"
                ),
                "unknown-label" => format!(
                    "{{\"ok\":true,\"id\":{id},\"generation\":{generation},\"label\":\"launch\",\
                     \"selected_probability\":1.0,\"probabilities\":{{\"answer\":1.0,\"options\":0.0,\
                     \"clarify\":0.0,\"supported_local\":0.0,\"unknown\":0.0}}}}"
                ),
                "unnormalized" => format!(
                    "{{\"ok\":true,\"id\":{id},\"generation\":{generation},\"label\":\"answer\",\
                     \"selected_probability\":0.6,\"probabilities\":{{\"answer\":0.6,\"options\":0.1,\
                     \"clarify\":0.0,\"supported_local\":0.0,\"unknown\":0.0}}}}"
                ),
                "disagreement" => format!(
                    "{{\"ok\":true,\"id\":{id},\"generation\":{generation},\"label\":\"answer\",\
                     \"selected_probability\":0.99,\"probabilities\":{{\"answer\":0.4,\"options\":0.3,\
                     \"clarify\":0.2,\"supported_local\":0.1,\"unknown\":0.0}}}}"
                ),
                "non-finite" => format!(
                    "{{\"ok\":true,\"id\":{id},\"generation\":{generation},\"label\":\"answer\",\
                     \"selected_probability\":1e999,\"probabilities\":{{\"answer\":1e999,\"options\":0.0,\
                     \"clarify\":0.0,\"supported_local\":0.0,\"unknown\":0.0}}}}"
                ),
                "candidate" => format!(
                    "{{\"ok\":true,\"id\":{id},\"generation\":{generation},\"label\":\"supported_local\",\
                     \"candidateId\":\"terminal\",\"selected_probability\":1.0,\
                     \"probabilities\":{{\"answer\":0.0,\"options\":0.0,\"clarify\":0.0,\
                     \"supported_local\":1.0,\"unknown\":0.0}}}}"
                ),
                "wrong-id" => format!(
                    "{{\"ok\":true,\"id\":{},\"generation\":{generation},\"label\":\"answer\",\
                     \"selected_probability\":0.7,\"probabilities\":{distribution}}}",
                    id.wrapping_add(1000)
                ),
                "stale-generation" => format!(
                    "{{\"ok\":true,\"id\":{id},\"generation\":{},\"label\":\"answer\",\
                     \"selected_probability\":0.7,\"probabilities\":{distribution}}}",
                    generation.wrapping_add(1000)
                ),
                "worker-refused" => format!(
                    r#"{{"ok":false,"id":{id},"generation":{generation},"error":"inference failed"}}"#
                ),
                "junk" => {
                    emit("this is not json");
                    emit("{\"broken\":");
                    return;
                }
                "oversized" => {
                    emit(&"y".repeat(LAYA_MAX_LINE_BYTES + 64));
                    return;
                }
                "malformed-utf8" => {
                    // Bytes that are not valid UTF-8 at all: the adapter must
                    // refuse the line, never repair it into something else.
                    emit_bytes(&[0xff, 0xfe, 0x80, b'\n']);
                    return;
                }
                "flood" => {
                    // Endless noise, as fast as the pipe allows. A flood can
                    // only fill the bounded queue and the pipe: it can never
                    // make the reader grow its heap.
                    loop {
                        emit("flooded stdout line that is not json");
                    }
                }
                "never-reads" => {
                    // Ready, then never reads a request at all.
                    loop {
                        std::thread::sleep(Duration::from_millis(50));
                    }
                }
                "hang" => loop {
                    std::thread::sleep(Duration::from_millis(100));
                },
                "exit-after-answer" => {
                    emit(&format!(
                        "{{\"ok\":true,\"id\":{id},\"generation\":{generation},\"label\":\"answer\",\
                         \"selected_probability\":0.92,\"probabilities\":{distribution}}}"
                    ));
                    return;
                }
                _ => return,
            };
            emit(&answer);
            if mode == "exit-after-answer" {
                return;
            }
            if mode == "answers-then-stops-reading" {
                // Answered once, then never reads a request again: the request
                // pipe fills and the writer thread wedges.
                loop {
                    std::thread::sleep(Duration::from_millis(50));
                }
            }
        }
    }

    /// Writes one protocol line straight to the real stdout, bypassing the
    /// libtest print capture, so the parent sees exactly this.
    fn emit(line: &str) {
        let mut out = std::io::stdout();
        let _ = out.write_all(line.as_bytes());
        let _ = out.write_all(b"\n");
        let _ = out.flush();
    }

    /// Writes raw bytes on one line, including bytes that are not valid UTF-8.
    fn emit_bytes(bytes: &[u8]) {
        let mut out = std::io::stdout();
        let _ = out.write_all(bytes);
        let _ = out.flush();
    }
}
