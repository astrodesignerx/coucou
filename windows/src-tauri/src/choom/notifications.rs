// Windows notifications: a read-only capability probe, an explicit opt-in
// listener lifecycle, normalized notifications and a bounded in-memory cache.
//
// Rules this module keeps:
// - Nothing is ever written to disk. No notification content leaves memory.
// - The access prompt runs only from an explicit settings click
//   (`notifications_enable`); every other entry point stays prompt-free.
// - `RequestAccessAsync` is created on the real UI thread through
//   `AppHandle::run_on_main_thread` and awaited off it, so the UI never blocks.
// - Windows notifications are never removed or acted on. Clear and dismiss
//   only touch this app's local cache.
// - Non-Windows reports `unsupported` without breaking the build.
// - Bounds everywhere: the cache and the known-key set are capped, and text is
//   clamped, so memory cannot grow with notification volume.

use std::collections::VecDeque;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::Shared;

/// Tauri events consumed by the island and the settings window.
pub const EVENT_STATUS: &str = "notifications-status";
pub const EVENT_ADDED: &str = "notification-added";
pub const EVENT_REMOVED: &str = "notification-removed";
pub const EVENT_CLEARED: &str = "notifications-cleared";
pub const EVENT_READ: &str = "notifications-read";

/// Displayed recent items. Newest first, oldest evicted.
pub const MAX_RECENT: usize = 60;
/// Keys remembered for replay suppression. Bounded so the set cannot grow
/// without limit on a long session; the platform history cap is well below it.
pub const MAX_KNOWN: usize = 500;
const MAX_TITLE: usize = 200;
const MAX_BODY: usize = 600;
const MAX_APP: usize = 80;
/// Package family names are the stable VIP identity, so they get their own
/// generous bound: long enough that no real id is ever cut, and shared by the
/// `key` and the `app_id` field so the two can never disagree. VIP matching
/// reads `app_id`, so a truncated id would match a prefix and defeat it.
const MAX_APP_ID: usize = 128;

/// What the settings window shows. The six states stay distinct so a blocked
/// setup reads differently from a denied permission or a switched-off feature.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AccessState {
    /// Not Windows: the API does not exist here.
    Unsupported,
    /// Windows would allow it, but this process has no package identity, which
    /// the listener API requires. The identity-package setup applies.
    MissingIdentity,
    /// The feature is switched off in Choom settings.
    Disabled,
    /// No decision yet: the prompt was dismissed or access was never asked.
    /// Asking again from the settings click is allowed.
    Unspecified,
    /// Windows said no. Only Windows Settings can reverse this.
    Denied,
    /// Access granted: the listener may run.
    Allowed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationsStatus {
    pub state: AccessState,
    /// True while the change listener is registered and reconciling.
    pub listening: bool,
    /// Plain-language reason or last error. Never notification content.
    pub detail: Option<String>,
}

fn status(state: AccessState, listening: bool, detail: Option<String>) -> NotificationsStatus {
    NotificationsStatus { state, listening, detail }
}

/// One notification, normalized for display. Every text field is clamped.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationItem {
    /// Stable across reconciles: package identity (when readable) plus the
    /// platform notification id. Used for dedup, dismissal and events.
    pub key: String,
    pub id: u32,
    /// App display name, clamped.
    pub app: String,
    /// Package family name when readable, otherwise empty. The stable
    /// identity VIP selection is built on.
    pub app_id: String,
    pub title: String,
    pub body: String,
    /// "message", "reminder" or "group": only what source semantics support.
    pub kind: String,
    /// Unix ms, 0 when the platform does not say.
    pub created_ms: u64,
}

/// Payload for `notification-removed`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemovedPayload {
    pub key: String,
}

// ── Pure helpers (every platform, unit tested) ───────────────────────────────

/// Clamps to `max` characters on a char boundary, with an ellipsis when cut.
pub fn clamp_chars(value: &str, max: usize) -> String {
    if max == 0 {
        return String::new();
    }
    let trimmed = value.trim();
    if trimmed.chars().count() <= max {
        return trimmed.to_string();
    }
    let mut out: String = trimmed.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

/// Key that survives re-reads of the same platform notification.
pub fn stable_key(app_id: &str, id: u32) -> String {
    if app_id.is_empty() {
        return format!("id:{id}");
    }
    format!("{}:{id}", app_id.to_lowercase())
}

/// Panel kind from source semantics only. No invented classification:
/// a reminder or alarm scenario reads as reminder, a toast group reads as
/// group, everything else is a plain message.
pub fn classify(scenario: &str, group: &str) -> &'static str {
    if scenario == "reminder" || scenario == "alarm" {
        "reminder"
    } else if !group.is_empty() {
        "group"
    } else {
        "message"
    }
}

/// Builds a clamped, keyed item from raw platform fields.
pub fn normalize(
    id: u32,
    app: String,
    app_id: String,
    title: String,
    body: String,
    scenario: &str,
    group: &str,
    created_ms: u64,
) -> NotificationItem {
    // Clamp the identity once, then build the key from that exact value, so
    // the stored id and the dedup key always refer to the same string.
    let app_id = clamp_chars(&app_id, MAX_APP_ID);
    NotificationItem {
        key: stable_key(&app_id, id),
        id,
        app: clamp_chars(&app, MAX_APP),
        app_id,
        title: clamp_chars(&title, MAX_TITLE),
        body: clamp_chars(&body, MAX_BODY),
        kind: classify(scenario, group).to_string(),
        created_ms,
    }
}

// ── Dedup and baseline reconciliation (pure, unit tested) ───────────────────

/// The bounded session memory the listener maintains.
#[derive(Debug, Default)]
pub struct SyncState {
    /// Keys ever announced this session, oldest evicted first. A key in here
    /// was already delivered once, so re-reading the platform never replays it
    /// as a new banner (baseline suppression).
    pub known: VecDeque<String>,
    /// Newest-first bounded list behind `notifications_recent` and the quiet
    /// count. Locally dismissed and cleared items leave it but their keys stay
    /// in `known`, so the platform re-reading them cannot bring them back.
    pub recent: Vec<NotificationItem>,
}

/// What one reconcile wants to tell the world.
#[derive(Debug, Default, PartialEq)]
pub struct Diff {
    /// Keys never seen before this session, newest first. These may present.
    pub added: Vec<NotificationItem>,
    /// Keys that left the platform, in arbitrary order.
    pub removed: Vec<String>,
}

/// Merges the platform's current list into the session memory.
///
/// - unknown key -> added (and remembered)
/// - known key missing from the platform -> removed
/// - known key with new text -> refreshed in the recent list, no event,
///   because a content refresh must not re-banner or move the quiet count
/// - everything else -> no change (a second identical read diffs to nothing)
/// - oversized snapshots process only the newest MAX_KNOWN identities, newest
///   first, so a repeated oversized read stays silent and fresh arrivals at
///   capacity still announce once.
pub fn reconcile(sync: &mut SyncState, mut current: Vec<NotificationItem>) -> Diff {
    current.sort_by(|a, b| {
        b.created_ms
            .cmp(&a.created_ms)
            .then_with(|| a.key.cmp(&b.key))
    });
    let full_keys: Vec<String> = current.iter().map(|i| i.key.clone()).collect();
    let window: Vec<NotificationItem> = current.into_iter().take(MAX_KNOWN).collect();
    let window_keys: Vec<String> = window.iter().map(|i| i.key.clone()).collect();

    let mut diff = Diff::default();

    // Removals: remembered keys the platform no longer reports. Compared
    // against the full list so items beyond the processing window never read
    // as removed on an oversized snapshot.
    let removed: Vec<String> = sync
        .known
        .iter()
        .filter(|k| !full_keys.contains(k))
        .cloned()
        .collect();
    if !removed.is_empty() {
        sync.known.retain(|k| !removed.contains(k));
        sync.recent.retain(|i| !removed.contains(&i.key));
        diff.removed = removed;
    }

    // Additions: window items never seen this session, newest first.
    for item in &window {
        if sync.known.iter().any(|k| k == &item.key) {
            continue;
        }
        diff.added.push(item.clone());
    }
    diff.added.sort_by(|a, b| {
        b.created_ms.cmp(&a.created_ms).then_with(|| a.key.cmp(&b.key))
    });

    // The known set is the bounded newest-first window identity. Rebuilding
    // from the window (instead of appending behind old keys) keeps the newest
    // keys suppressed after eviction, so a repeated oversized snapshot diffs
    // to nothing. Dismissed keys stay suppressed because the platform still
    // reports them inside the window; their recent entry stays gone.
    sync.known = window_keys.into_iter().collect();

    // Quiet refresh of known content, and insert fresh items into the list.
    for item in &window {
        if let Some(entry) = sync.recent.iter_mut().find(|e| e.key == item.key) {
            *entry = item.clone();
        }
    }
    for item in &diff.added {
        if !sync.recent.iter().any(|e| e.key == item.key) {
            sync.recent.push(item.clone());
        }
    }
    sync.recent.sort_by(|a, b| {
        b.created_ms
            .cmp(&a.created_ms)
            .then_with(|| a.key.cmp(&b.key))
    });
    sync.recent.truncate(MAX_RECENT);

    diff
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(id: u32, app: &str, created: u64) -> NotificationItem {
        normalize(id, app.into(), "App_1.0abcdef_x".into(), "Title".into(), "Body".into(), "", "", created)
    }

    #[test]
    fn clamp_cuts_on_char_boundaries() {
        assert_eq!(clamp_chars("  hi  ", 10), "hi");
        assert_eq!(clamp_chars("hello", 5), "hello");
        assert_eq!(clamp_chars("hello", 4), "hel…");
        // Multi-byte input must not panic or split a character.
        assert_eq!(clamp_chars("héllo", 3), "hé…");
        assert_eq!(clamp_chars("ab", 0), "");
    }

    #[test]
    fn keys_are_stable_and_case_insensitive() {
        assert_eq!(stable_key("App_1.0Abc_def", 7), stable_key("app_1.0abc_def", 7));
        assert_ne!(stable_key("app", 7), stable_key("app", 8));
        assert_eq!(stable_key("", 3), "id:3");
    }

    #[test]
    fn kind_follows_source_semantics_only() {
        assert_eq!(classify("reminder", ""), "reminder");
        assert_eq!(classify("alarm", ""), "reminder");
        assert_eq!(classify("default", "chat"), "group");
        assert_eq!(classify("default", ""), "message");
    }

    #[test]
    fn normalize_clamps_every_text_field() {
        let n = normalize(
            1,
            "A".repeat(90),
            "B".repeat(200),
            "T".repeat(300),
            "B".repeat(700),
            "",
            "",
            42,
        );
        assert_eq!(n.app.chars().count(), MAX_APP);
        assert_eq!(n.app_id.chars().count(), MAX_APP_ID);
        // The dedup key is built from the exact stored id, never a longer one.
        assert!(n.key.starts_with(&n.app_id.to_lowercase()));
        assert_eq!(n.title.chars().count(), MAX_TITLE);
        assert_eq!(n.body.chars().count(), MAX_BODY);
        assert_eq!(n.kind, "message");
        assert_eq!(n.created_ms, 42);
    }

    #[test]
    fn real_package_family_id_is_never_truncated() {
        // A genuine Windows package family name must survive intact so VIP
        // matching keys on the full identity, not a prefix.
        let id = "Microsoft.WindowsTerminal_8wekyb3d8bbwe";
        let n = normalize(9, "Windows Terminal".into(), id.into(), "T".into(), "B".into(), "", "", 7);
        assert_eq!(n.app_id, id);
        assert!(n.key.starts_with(&id.to_lowercase()));
    }

    #[test]
    fn identical_reads_diff_to_nothing() {
        let mut sync = SyncState::default();
        let first = reconcile(&mut sync, vec![item(1, "Mail", 100), item(2, "Chat", 200)]);
        assert_eq!(first.added.len(), 2);
        assert!(first.removed.is_empty());
        // Newest first.
        assert_eq!(first.added[0].id, 2);
        let second = reconcile(&mut sync, vec![item(1, "Mail", 100), item(2, "Chat", 200)]);
        assert_eq!(second, Diff::default());
    }

    #[test]
    fn removals_drop_from_known_and_recent() {
        let mut sync = SyncState::default();
        reconcile(&mut sync, vec![item(1, "Mail", 100), item(2, "Chat", 200)]);
        let diff = reconcile(&mut sync, vec![item(2, "Chat", 200)]);
        assert_eq!(diff.removed, vec![item(1, "Mail", 100).key]);
        assert_eq!(sync.recent.len(), 1);
        assert!(!sync.known.contains(&item(1, "Mail", 100).key));
    }

    #[test]
    fn content_refresh_updates_silently_without_rebannering() {
        let mut sync = SyncState::default();
        reconcile(&mut sync, vec![item(1, "Mail", 100)]);
        let mut changed = item(1, "Mail", 100);
        changed.title = "New title".into();
        let diff = reconcile(&mut sync, vec![changed.clone()]);
        assert_eq!(diff, Diff::default());
        assert_eq!(sync.recent[0].title, "New title");
    }

    #[test]
    fn local_dismiss_survives_platform_rereads() {
        let mut sync = SyncState::default();
        reconcile(&mut sync, vec![item(1, "Mail", 100)]);
        let key = item(1, "Mail", 100).key;
        // The settings window dismissed it locally: out of the list, key stays.
        sync.recent.retain(|i| i.key != key);
        let diff = reconcile(&mut sync, vec![item(1, "Mail", 100)]);
        assert_eq!(diff, Diff::default());
        assert!(sync.recent.is_empty());
    }

    #[test]
    fn cache_and_known_set_stay_bounded() {
        let mut sync = SyncState::default();
        let flood: Vec<NotificationItem> = (0..(MAX_RECENT + 30))
            .map(|i| item(i as u32, "Mail", 1000 + i as u64))
            .collect();
        reconcile(&mut sync, flood);
        assert_eq!(sync.recent.len(), MAX_RECENT);
        let huge: Vec<NotificationItem> = (0..(MAX_KNOWN + 120))
            .map(|i| item(10_000 + i as u32, "Mail", i as u64))
            .collect();
        reconcile(&mut sync, huge);
        assert_eq!(sync.known.len(), MAX_KNOWN);
    }

    #[test]
    fn oversized_reread_keeps_newest_suppressed() {
        let mut sync = SyncState::default();
        // A snapshot exactly at the known bound: a re-read must be silent.
        let at_bound: Vec<NotificationItem> = (0..MAX_KNOWN)
            .map(|i| item(50_000 + i as u32, "Mail", i as u64))
            .collect();
        reconcile(&mut sync, at_bound.clone());
        let diff = reconcile(&mut sync, at_bound);
        assert!(diff.added.is_empty(), "within-bound re-read re-announced {}", diff.added.len());
    }

    #[test]
    fn known_eviction_keeps_the_newest_ids() {
        let mut sync = SyncState::default();
        let flood: Vec<NotificationItem> = (0..(MAX_KNOWN + 120))
            .map(|i| item(100_000 + i as u32, "Mail", i as u64))
            .collect();
        let newest_key = flood.last().unwrap().key.clone();
        let oldest_key = flood.first().unwrap().key.clone();
        reconcile(&mut sync, flood);
        assert_eq!(sync.known.len(), MAX_KNOWN);
        // Eviction drops the oldest, so the freshest IDs stay suppressed and a
        // re-read never re-banners the newest notifications.
        assert!(sync.known.contains(&newest_key));
        assert!(!sync.known.contains(&oldest_key));
    }

    #[test]
    fn fresh_arrival_at_capacity_announces_once() {
        let mut sync = SyncState::default();
        let full: Vec<NotificationItem> = (0..MAX_KNOWN)
            .map(|i| item(200_000 + i as u32, "Mail", i as u64))
            .collect();
        reconcile(&mut sync, full.clone());
        assert_eq!(sync.known.len(), MAX_KNOWN);
        let fresh = item(999_999, "Mail", (MAX_KNOWN + 5000) as u64);
        // Platform history contains all500 IDs, unlike the60-row local list.
        let mut snapshot = full;
        snapshot.push(fresh.clone());
        let diff = reconcile(&mut sync, snapshot.clone());
        assert_eq!(diff.added.len(), 1);
        assert_eq!(diff.added[0].key, fresh.key);
        assert_eq!(sync.known.len(), MAX_KNOWN);
        assert!(sync.known.contains(&fresh.key));
        assert_eq!(reconcile(&mut sync, snapshot), Diff::default());
    }

    #[test]
    fn repeated_oversized_snapshot_stays_silent() {
        let mut sync = SyncState::default();
        let flood: Vec<NotificationItem> = (0..(MAX_KNOWN + 120))
            .map(|i| item(300_000 + i as u32, "Mail", i as u64))
            .collect();
        let first = reconcile(&mut sync, flood.clone());
        assert!(!first.added.is_empty());
        let second = reconcile(&mut sync, flood);
        assert_eq!(second, Diff::default());
    }

    #[test]
    fn removal_reports_once_then_stays_silent() {
        let mut sync = SyncState::default();
        reconcile(&mut sync, vec![item(1, "Mail", 100), item(2, "Chat", 200)]);
        let diff = reconcile(&mut sync, vec![item(2, "Chat", 200)]);
        assert_eq!(diff.added.len(), 0);
        assert_eq!(diff.removed.len(), 1);
        let again = reconcile(&mut sync, vec![item(2, "Chat", 200)]);
        assert_eq!(again, Diff::default());
    }

    #[test]
    fn baseline_order_is_newest_first_and_bounded() {
        let mut items: Vec<NotificationItem> = (0..(MAX_KNOWN + 40))
            .map(|i| item(400_000 + i as u32, "Mail", i as u64))
            .collect();
        items.reverse();
        let mut sync = SyncState::default();
        reconcile(&mut sync, items);
        assert_eq!(sync.known.len(), MAX_KNOWN);
        assert_eq!(sync.recent.len(), MAX_RECENT);
        let newest = item(400_000 + (MAX_KNOWN + 40 - 1) as u32, "Mail", (MAX_KNOWN + 40 - 1) as u64);
        assert!(sync.known.contains(&newest.key));
        assert_eq!(sync.recent[0].created_ms, (MAX_KNOWN + 40 - 1) as u64);
    }

    #[test]
    fn status_states_serialize_distinctly() {
        let s = status(AccessState::MissingIdentity, false, None);
        let json = serde_json::to_string(&s).unwrap();
        assert!(json.contains("\"state\":\"missingIdentity\""));
        for (state, expect) in [
            (AccessState::Unsupported, "unsupported"),
            (AccessState::Disabled, "disabled"),
            (AccessState::Unspecified, "unspecified"),
            (AccessState::Denied, "denied"),
            (AccessState::Allowed, "allowed"),
        ] {
            let json = serde_json::to_string(&status(state, true, None)).unwrap();
            assert!(json.contains(&format!("\"{expect}\"")), "{json}");
        }
    }
}

// ── Runtime: listener lifecycle and reconciling ──────────────────────────────

#[derive(Debug, Default)]
struct Inner {
    sync: SyncState,
    listening: bool,
    /// `NotificationChanged` registration token, removed on teardown.
    token: Option<i64>,
    /// Bumped on every stop: in-flight work from an older generation exits
    /// without touching state or emitting anything.
    generation: u64,
    /// A change arrived while the worker ran: reconcile once more.
    dirty: bool,
    /// A reconcile worker is on duty; extra events only set `dirty`.
    running: bool,
    /// Last native error, surfaced through `notifications_status`. Never content.
    detail: Option<String>,
}

/// Managed listener state. Cheap to lock; the fetch itself runs unlocked.
pub struct NotificationsRuntime {
    inner: Mutex<Inner>,
}

impl Default for NotificationsRuntime {
    fn default() -> Self {
        Self { inner: Mutex::new(Inner::default()) }
    }
}

fn emit_status(app: &AppHandle, value: &NotificationsStatus) {
    let _ = app.emit(EVENT_STATUS, value.clone());
}

/// Whether the opt-in is on. Single reader for every entry point.
fn enabled_flag(app: &AppHandle) -> bool {
    app.state::<Shared>().settings.lock().unwrap().notifications_enabled
}

/// Writes the opt-in flag and tells both windows, mirroring `hooks_apply`.
fn set_enabled_flag(app: &AppHandle, enabled: bool) {
    let updated = {
        let shared = app.state::<Shared>();
        let mut guard = shared.settings.lock().unwrap();
        if guard.notifications_enabled == enabled {
            return;
        }
        guard.notifications_enabled = enabled;
        guard.clone()
    };
    if let Err(err) = crate::settings::save(&updated) {
        eprintln!("[coucou] could not save notification opt-in: {err}");
    }
    let _ = app.emit("settings-changed", updated);
}

/// Registers the change listener and reads the current platform list as a
/// silent baseline: nothing that already exists announces itself.
#[cfg(not(windows))]
fn start_listener(_app: &AppHandle) -> Result<(), String> {
    Err("notification access exists on Windows only".into())
}

#[cfg(windows)]
fn start_listener(app: &AppHandle) -> Result<(), String> {
    // Keep the apartment alive through fetch and handler registration.
    let _winrt = WinrtGuard::acquire();
    if !enabled_flag(app) { return Err("notifications were disabled".into()); }
    if win::access_status()? != AccessState::Allowed {
        return Err("notification access is not granted".into());
    }
    let listener = win::current_listener()?;
    let baseline = match win::fetch(&listener) {
        Ok(items) => items,
        Err(err) => return Err(err),
    };

    let generation = {
        let state = app.state::<NotificationsRuntime>();
        let mut inner = state.inner.lock().unwrap();
        if !enabled_flag(app) { return Err("notifications were disabled".into()); }
        if inner.listening {
            return Ok(());
        }
        inner.sync = SyncState::default();
        let mut base = baseline;
        base.sort_by(|a, b| {
            b.created_ms
                .cmp(&a.created_ms)
                .then_with(|| a.key.cmp(&b.key))
        });
        for item in base.iter().take(MAX_KNOWN) {
            if !inner.sync.known.contains(&item.key) {
                inner.sync.known.push_back(item.key.clone());
            }
        }
        inner.sync.recent = base.into_iter().take(MAX_RECENT).collect();
        inner.generation += 1;
        inner.detail = None;
        inner.generation
    };

    let handler_app = app.clone();
    let token = listener
        .NotificationChanged(&windows::Foundation::TypedEventHandler::new(
            move |_sender, _args| {
                // Reconciling happens on a worker; this callback only knocks.
                schedule_reconcile(&handler_app, generation);
                Ok(())
            },
        ))
        .map_err(|err| format!("could not subscribe to notification changes: {err}"))?;
    {
        let state = app.state::<NotificationsRuntime>();
        let mut inner = state.inner.lock().unwrap();
        if inner.generation != generation {
            // Stopped while the subscription was being set up.
            drop(inner);
            let _ = listener.RemoveNotificationChanged(token);
            return Ok(());
        }
        inner.token = Some(token);
        inner.listening = true;
    }
    // A change may have landed between the baseline fetch and the handler
    // registration: reconcile once so nothing is missed and nothing replays.
    schedule_reconcile(app, generation);
    Ok(())
}

/// Unsubscribes and empties the local cache. Windows keeps everything.
fn stop_listener(app: &AppHandle) {
    let _winrt = WinrtGuard::acquire();
    let token = {
        let state = app.state::<NotificationsRuntime>();
        let mut inner = state.inner.lock().unwrap();
        let token = inner.token.take();
        inner.listening = false;
        inner.generation += 1;
        inner.dirty = false;
        inner.sync = SyncState::default();
        token
    };
    #[cfg(windows)]
    if let Some(token) = token {
        if let Ok(listener) = win::current_listener() {
            let _ = listener.RemoveNotificationChanged(token);
        }
    }
    #[cfg(not(windows))]
    let _ = token;
    let _ = app.emit(EVENT_CLEARED, ());
}

/// One coalesced reconcile worker. Events knock, this knocks back until clean.
fn schedule_reconcile(app: &AppHandle, generation: u64) {
    {
        let state = app.state::<NotificationsRuntime>();
        let mut inner = state.inner.lock().unwrap();
        if !inner.listening || inner.generation != generation {
            return;
        }
        inner.dirty = true;
        if inner.running {
            return;
        }
        inner.running = true;
    }
    let app = app.clone();
    std::thread::spawn(move || loop {
        {
            let state = app.state::<NotificationsRuntime>();
        let mut inner = state.inner.lock().unwrap();
            if !inner.listening || inner.generation != generation {
                inner.running = false;
                return;
            }
            inner.dirty = false;
        }
        reconcile_once(&app, generation);
        let state = app.state::<NotificationsRuntime>();
        let mut inner = state.inner.lock().unwrap();
        if !inner.dirty {
            inner.running = false;
            return;
        }
    });
}

/// Reads the platform once and emits the delta. Checks access first: a
/// revoked permission fails silently on Windows, so the status is the truth.
#[cfg(not(windows))]
fn reconcile_once(_app: &AppHandle, _generation: u64) {}

#[cfg(windows)]
fn reconcile_once(app: &AppHandle, generation: u64) {
    if !enabled_flag(app) { stop_listener(app); return; }
    let _winrt = WinrtGuard::acquire();
    match win::access_status() {
        Ok(AccessState::Allowed) => {}
        Ok(other) => {
            stop_listener(app);
            emit_status(app, &status(other, false, Some("Access ended; the listener stopped.".into())));
            return;
        }
        Err(err) => {
            stop_listener(app);
            emit_status(app, &status(AccessState::Unspecified, false, Some(err)));
            return;
        }
    }
    let listener = match win::current_listener() {
        Ok(listener) => listener,
        Err(err) => {
            app.state::<NotificationsRuntime>().inner.lock().unwrap().detail = Some(err);
            return;
        }
    };
    let current = match win::fetch(&listener) {
        Ok(items) => items,
        Err(err) => {
            app.state::<NotificationsRuntime>().inner.lock().unwrap().detail = Some(err);
            return;
        }
    };
    let (added, removed) = {
        let state = app.state::<NotificationsRuntime>();
        let mut inner = state.inner.lock().unwrap();
        if !inner.listening || inner.generation != generation {
            return;
        }
        let diff = reconcile(&mut inner.sync, current);
        (diff.added, diff.removed)
    };
    for item in added {
        let _ = app.emit(EVENT_ADDED, item);
    }
    for key in removed {
        let _ = app.emit(EVENT_REMOVED, RemovedPayload { key });
    }
}

// ── Probe and commands ──────────────────────────────────────────────────────

/// Setup guidance shown in place of a status when package identity is missing.
/// The concrete steps live next to it: windows/identity/README.md.
const IDENTITY_HINT: &str = "Windows only grants notification access to apps with package identity. Choom has none yet: register the identity package described in windows/identity/README.md, then restart Choom.";

/// The read-only capability probe. Never prompts, never registers anything.
fn probe(app: &AppHandle) -> NotificationsStatus {
    if !win::supported() {
        return status(AccessState::Unsupported, false, Some("Notification access exists on Windows only.".into()));
    }
    if !win::identity_present() {
        return status(AccessState::MissingIdentity, false, Some(IDENTITY_HINT.into()));
    }
    let listening = app.state::<NotificationsRuntime>().inner.lock().unwrap().listening;
    if !enabled_flag(app) {
        return status(AccessState::Disabled, false, None);
    }
    let _winrt = WinrtGuard::acquire();
    match win::access_status() {
        Ok(AccessState::Allowed) => {
            let detail = if listening {
                None
            } else {
                Some("Access is allowed but the listener is not connected. Turn notifications off and on in settings to reconnect.".into())
            };
            status(AccessState::Allowed, listening, detail)
        }
        Ok(other) => {
            if listening {
                stop_listener(app);
            }
            let detail = match other {
                AccessState::Denied => Some("Windows denied notification access. Only Windows Settings can grant it again.".into()),
                _ => Some("No access decision yet. Turn notifications off and on in settings to ask Windows again.".into()),
            };
            status(other, false, detail)
        }
        Err(err) => {
            if listening {
                stop_listener(app);
            }
            status(AccessState::Unspecified, false, Some(err))
        }
    }
}

/// Boot-time silent connect: if the user already allowed access, follow the
/// listener without ever prompting. Called once from `lib.rs` setup.
pub fn boot(app: &AppHandle) {
    if !enabled_flag(app) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let _winrt = WinrtGuard::acquire();
        let granted = win::access_status()
            .map(|state| state == AccessState::Allowed)
            .unwrap_or(false);
        if granted {
            if let Err(err) = start_listener(&app) {
                app.state::<NotificationsRuntime>().inner.lock().unwrap().detail = Some(err);
            }
        }
        emit_status(&app, &probe(&app));
    });
}

/// The read-only status for the settings window and the island.
#[tauri::command]
pub fn notifications_status(app: AppHandle) -> NotificationsStatus {
    probe(&app)
}

/// Explicit Enable from a settings click: the one place that may ask Windows
/// for access. `RequestAccessAsync` is created on the real UI thread and
/// awaited here, off it, so the island never freezes behind the prompt.
#[tauri::command]
pub async fn notifications_enable(app: AppHandle) -> NotificationsStatus {
    let result = tauri::async_runtime::spawn_blocking(move || enable_blocking(&app)).await;
    match result {
        Ok(status) => status,
        Err(err) => status(AccessState::Unspecified, false, Some(format!("access request failed: {err}"))),
    }
}

fn enable_blocking(app: &AppHandle) -> NotificationsStatus {
    let requested_generation = app.state::<NotificationsRuntime>().inner.lock().unwrap().generation;
    if !win::supported() {
        return status(AccessState::Unsupported, false, Some("Notification access exists on Windows only.".into()));
    }
    if !win::identity_present() {
        set_enabled_flag(app, false);
        let value = status(AccessState::MissingIdentity, false, Some(IDENTITY_HINT.into()));
        emit_status(app, &value);
        return value;
    }
    let requested = {
        let _winrt = WinrtGuard::acquire();
        win::request_access(app)
    };
    // Disable may occur while the explicit Windows prompt is still pending.
    // A stale answer must never turn the listener back on.
    if app.state::<NotificationsRuntime>().inner.lock().unwrap().generation != requested_generation {
        return probe(app);
    }
    let value = match requested {
        Ok(AccessState::Allowed) => {
            {
                let runtime = app.state::<NotificationsRuntime>();
                let inner = runtime.inner.lock().unwrap();
                if inner.generation != requested_generation {
                    return status(AccessState::Disabled, false, None);
                }
                set_enabled_flag(app, true);
            }
            match start_listener(app) {
                Ok(()) => status(AccessState::Allowed, true, None),
                Err(err) => status(AccessState::Allowed, false, Some(err)),
            }
        }
        Ok(other) => {
            stop_listener(app);
            set_enabled_flag(app, false);
            let detail = match other {
                AccessState::Denied => Some("Windows denied notification access. Only Windows Settings can grant it again.".into()),
                _ => Some("The Windows prompt was dismissed. Turn notifications on again to ask once more.".into()),
            };
            status(other, false, detail)
        }
        Err(err) => {
            stop_listener(app);
            set_enabled_flag(app, false);
            status(AccessState::Unspecified, false, Some(err))
        }
    };
    emit_status(app, &value);
    value
}

/// Explicit Disable from a settings click: unsubscribe, forget the local
/// cache, drop the opt-in. Windows keeps every notification.
#[tauri::command]
pub fn notifications_disable(app: AppHandle) -> NotificationsStatus {
    set_enabled_flag(&app, false);
    stop_listener(&app);
    // A pending request that held the lifecycle lock cannot restore opt-in.
    set_enabled_flag(&app, false);
    let value = if win::supported() && win::identity_present() {
        status(AccessState::Disabled, false, None)
    } else {
        probe(&app)
    };
    emit_status(&app, &value);
    value
}

/// The bounded recent list, newest first. Local only.
#[tauri::command]
pub fn notifications_recent(app: AppHandle) -> Vec<NotificationItem> {
    app.state::<NotificationsRuntime>().inner.lock().unwrap().sync.recent.clone()
}

/// Local clear: empties this app's list. Windows notifications stay put.
#[tauri::command]
pub fn notifications_clear(app: AppHandle) {
    app.state::<NotificationsRuntime>().inner.lock().unwrap().sync.recent.clear();
    let _ = app.emit(EVENT_CLEARED, ());
}

/// Local dismiss of one item: same rule, the platform copy is untouched.
#[tauri::command]
pub fn notifications_dismiss(app: AppHandle, key: String) {
    app.state::<NotificationsRuntime>().inner.lock().unwrap().sync.recent.retain(|i| i.key != key);
    let _ = app.emit(EVENT_REMOVED, RemovedPayload { key });
}

/// "The list has been read": the island may reset its quiet count.
#[tauri::command]
pub fn notifications_mark_read(app: AppHandle) {
    let _ = app.emit(EVENT_READ, ());
}

/// App exit: unsubscribe and forget the cache. Nothing outlives the app.
pub fn shutdown(app: &AppHandle) {
    stop_listener(app);
}

// ── Native side ──────────────────────────────────────────────────────────────

/// WinRT needs an initialized apartment on every calling thread. One guard
/// owns one initialization: a thread that was already initialized (the UI
/// thread) keeps its own apartment and the guard only balances what it added.
pub struct WinrtGuard {
    active: bool,
}

impl WinrtGuard {
    pub fn acquire() -> Self {
        #[cfg(windows)]
        {
            use windows::Win32::System::WinRT::{RoInitialize, RO_INIT_MULTITHREADED};
            let ok = unsafe { RoInitialize(RO_INIT_MULTITHREADED) }.is_ok();
            WinrtGuard { active: ok }
        }
        #[cfg(not(windows))]
        {
            WinrtGuard { active: false }
        }
    }
}

impl Drop for WinrtGuard {
    fn drop(&mut self) {
        #[cfg(windows)]
        if self.active {
            unsafe { windows::Win32::System::WinRT::RoUninitialize() };
        }
    }
}

#[cfg(windows)]
mod win {
    use super::{normalize, AccessState, NotificationItem, WinrtGuard};
    use tauri::AppHandle;
    use windows::core::Interface;
    use windows::Win32::Storage::Packaging::Appx::GetCurrentPackageFullName;
    use windows::UI::Notifications::Management::{
        UserNotificationListener, UserNotificationListenerAccessStatus,
    };
    use windows::UI::Notifications::{
        KnownNotificationBindings, Notification, NotificationKinds, ToastNotification,
        UserNotification,
    };

    /// `APPMODEL_ERROR_NO_PACKAGE`: the process has no package identity.
    const NO_PACKAGE: u32 = 15700;

    pub fn supported() -> bool {
        true
    }

    /// Package identity check without prompting or registering anything. The
    /// listener API needs identity; an NSIS or MSI install has none.
    pub fn identity_present() -> bool {
        let mut length: u32 = 0;
        let error = unsafe { GetCurrentPackageFullName(&mut length, None) };
        error.0 as u32 != NO_PACKAGE
    }

    pub fn current_listener() -> Result<UserNotificationListener, String> {
        let _guard = WinrtGuard::acquire();
        UserNotificationListener::Current()
            .map_err(|err| format!("notification listener unavailable: {err}"))
    }

    pub fn access_status() -> Result<AccessState, String> {
        let _guard = WinrtGuard::acquire();
        let listener = current_listener()?;
        let status = listener
            .GetAccessStatus()
            .map_err(|err| format!("could not read notification access: {err}"))?;
        Ok(if status == UserNotificationListenerAccessStatus::Allowed {
            AccessState::Allowed
        } else if status == UserNotificationListenerAccessStatus::Denied {
            AccessState::Denied
        } else {
            AccessState::Unspecified
        })
    }

    /// Reads the current toast list, normalized and clamped. A revoked access
    /// silently returns an empty list on Windows, which is why callers check
    /// `access_status` first.
    pub fn fetch(listener: &UserNotificationListener) -> Result<Vec<NotificationItem>, String> {
        let _guard = WinrtGuard::acquire();
        let operation = listener
            .GetNotificationsAsync(NotificationKinds::Toast)
            .map_err(|err| format!("could not list notifications: {err}"))?;
        let list = operation
            .get()
            .map_err(|err| format!("could not list notifications: {err}"))?;
        let mut items = Vec::new();
        for index in 0..list.Size().unwrap_or(0) {
            // One unreadable notification must never sink the rest.
            if let Ok(raw) = list.GetAt(index) {
                if let Some(item) = normalize_user_notification(&raw) {
                    items.push(item);
                }
            }
        }
        Ok(items)
    }

    /// The consent request. The operation is created on the real UI thread
    /// (Windows requires it) and awaited here, off it: `get` blocks this
    /// worker, never the island.
    pub fn request_access(app: &AppHandle) -> Result<AccessState, String> {
        let (tx, rx) = std::sync::mpsc::channel();
        app.run_on_main_thread(move || {
            let outcome = (|| {
                let _guard = WinrtGuard::acquire();
                UserNotificationListener::Current().map_err(|err| err.to_string())?
                    .RequestAccessAsync()
                    .map_err(|err| err.to_string())
            })();
            let _ = tx.send(outcome);
        })
        .map_err(|err| format!("could not reach the UI thread: {err}"))?;
        let operation = rx
            .recv()
            .map_err(|_| "the UI thread did not answer".to_string())??;
        let _guard = WinrtGuard::acquire();
        let status = operation
            .get()
            .map_err(|err| format!("access request failed: {err}"))?;
        Ok(if status == UserNotificationListenerAccessStatus::Allowed {
            AccessState::Allowed
        } else if status == UserNotificationListenerAccessStatus::Denied {
            AccessState::Denied
        } else {
            AccessState::Unspecified
        })
    }

    fn win_ticks_to_unix_ms(ticks: i64) -> u64 {
        /// 100 ns intervals between 1601-01-01 and 1970-01-01.
        const EPOCH_DELTA_100NS: i64 = 116_444_736_000_000_000;
        const MS: i64 = 10_000;
        let since_unix = ticks.saturating_sub(EPOCH_DELTA_100NS);
        if since_unix <= 0 {
            0
        } else {
            (since_unix / MS) as u64
        }
    }

    fn normalize_user_notification(raw: &UserNotification) -> Option<NotificationItem> {
        let id = raw.Id().ok()?;
        let created_ms = raw
            .CreationTime()
            .ok()
            .map(|when| win_ticks_to_unix_ms(when.UniversalTime))
            .unwrap_or(0);
        let mut app = String::new();
        let mut app_id = String::new();
        if let Ok(info) = raw.AppInfo() {
            if let Ok(display) = info.DisplayInfo() {
                if let Ok(name) = display.DisplayName() {
                    app = name.to_string();
                }
            }
            if let Ok(family) = info.PackageFamilyName() {
                app_id = family.to_string();
            }
        }
        if app.trim().is_empty() {
            app = "Unknown app".into();
        }
        let notification = raw.Notification().ok()?;
        let (title, body) = extract_text(&notification);
        let (group, scenario) = toast_meta(&notification);
        Some(normalize(id, app, app_id, title, body, &scenario, &group, created_ms))
    }

    /// Title is the first binding text element, body is the rest, as the API
    /// docs recommend. Works without touching the toast XML.
    fn extract_text(notification: &Notification) -> (String, String) {
        let binding = notification.Visual().ok().and_then(|visual| {
            let preferred = KnownNotificationBindings::ToastGeneric()
                .ok()
                .and_then(|name| visual.GetBinding(&name).ok());
            preferred.or_else(|| {
                visual.Bindings().ok().and_then(|all| {
                    (0..all.Size().unwrap_or(0)).find_map(|index| all.GetAt(index).ok())
                })
            })
        });
        let Some(binding) = binding else {
            return (String::new(), String::new());
        };
        let Ok(elements) = binding.GetTextElements() else {
            return (String::new(), String::new());
        };
        let mut title = String::new();
        let mut body = String::new();
        for index in 0..elements.Size().unwrap_or(0) {
            let Ok(element) = elements.GetAt(index) else {
                continue;
            };
            let Ok(text) = element.Text() else {
                continue;
            };
            let text = text.to_string();
            if text.trim().is_empty() {
                continue;
            }
            if title.is_empty() {
                title = text;
            } else {
                if !body.is_empty() {
                    body.push('\n');
                }
                body.push_str(&text);
            }
        }
        (title, body)
    }

    /// Group survives as a toast property. Scenario only exists in the toast
    /// XML, read from the serialized document so sender-specific namespace
    /// prefixes cannot break the sniff. Non-toast notifications read none.
    fn toast_meta(notification: &Notification) -> (String, String) {
        let mut group = String::new();
        let mut scenario = String::new();
        if let Ok(toast) = notification.cast::<ToastNotification>() {
            if let Ok(value) = toast.Group() {
                group = value.to_string();
            }
            if let Ok(document) = toast.Content() {
                if let Ok(xml) = document.GetXml() {
                    let xml = xml.to_string();
                    let quoted = ["scenario=\"reminder\"", "scenario='reminder'"]
                        .iter()
                        .any(|needle| xml.contains(needle));
                    let alarmed = ["scenario=\"alarm\"", "scenario='alarm'"]
                        .iter()
                        .any(|needle| xml.contains(needle));
                    scenario = if quoted {
                        "reminder".into()
                    } else if alarmed {
                        "alarm".into()
                    } else {
                        String::new()
                    };
                }
            }
        }
        (group, scenario)
    }
}

#[cfg(not(windows))]
mod win {
    //! Linux and the test host without Windows: everything reports unsupported
    //! and nothing breaks compilation.

    use super::{AccessState, NotificationItem};
    use tauri::AppHandle;

    pub struct Listener;

    pub fn supported() -> bool {
        false
    }

    pub fn identity_present() -> bool {
        false
    }

    pub fn current_listener() -> Result<Listener, String> {
        Err("notification access exists on Windows only".into())
    }

    pub fn access_status() -> Result<AccessState, String> {
        Err("notification access exists on Windows only".into())
    }

    pub fn fetch(_listener: &Listener) -> Result<Vec<NotificationItem>, String> {
        Err("notification access exists on Windows only".into())
    }

    pub fn request_access(_app: &AppHandle) -> Result<AccessState, String> {
        Err("notification access exists on Windows only".into())
    }
}
