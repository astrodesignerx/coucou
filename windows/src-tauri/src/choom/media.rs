// Now playing: the panel Windows shows for the volume keys, as a Music pill
// and a player card. Any app that reports a media session - Spotify, browsers,
// the built-in Media Player - shows up here, with no login and no web API.
//
// One dedicated thread owns the WinRT session manager and its events. It emits
// a `now-playing` event only when something other than plain playback progress
// changed, and it applies the card's controls. Nothing polls: with no media
// session the thread sits in a channel wait.
//
// The API: manager.GetCurrentSession() -> session.TryGetMediaPropertiesAsync()
// (title, artist, album, thumbnail), GetPlaybackInfo() (status),
// GetTimelineProperties() (position, end; 100 ns ticks) and
// SourceAppUserModelId(). Events: CurrentSessionChanged on the manager,
// MediaPropertiesChanged / PlaybackInfoChanged / TimelinePropertiesChanged on
// the session. Controls: TryTogglePlayPauseAsync, TrySkipNextAsync,
// TrySkipPreviousAsync, TryChangePlaybackPositionAsync(ticks).

use serde::Serialize;
use tauri::AppHandle;

/// The Tauri event the island listens to.
#[cfg_attr(not(windows), allow(dead_code))]
pub const EVENT: &str = "now-playing";
/// Timeline events fire often; never emit more than once per this window.
pub const DEBOUNCE_MS: u64 = 250;
/// A position move this large is a seek, not playback progress.
pub const SEEK_MS: i64 = 1500;
/// Artwork larger than this is skipped: a truncated image would not render.
#[cfg_attr(not(windows), allow(dead_code))]
pub const MAX_ART_BYTES: u64 = 512 * 1024;
/// A thumbnail stream that has not opened by then is given up on.
#[cfg_attr(not(windows), allow(dead_code))]
pub const ART_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);
/// One retry after a failed session subscription.
#[cfg_attr(not(windows), allow(dead_code))]
pub const SUBSCRIBE_RETRY: std::time::Duration = std::time::Duration::from_secs(2);

/// What the island shows for one snapshot of the active media session.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NowPlaying {
    pub active: bool,
    pub playing: bool,
    pub title: String,
    pub artist: String,
    pub album: String,
    /// The source app's display name, e.g. "Spotify".
    pub app: String,
    /// A data URL, or None when the track has no artwork.
    pub art: Option<String>,
    pub position_ms: u64,
    pub duration_ms: u64,
    /// When the position above was read; the card anchors its progress here.
    pub updated_at_ms: u64,
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

/// 100 ns ticks to milliseconds.
pub fn ticks_to_ms(ticks: i64) -> u64 {
    (ticks.max(0) as u64) / 10_000
}

/// A Windows DateTime (100 ns ticks since 1601) as unix milliseconds, never
/// later than `now_ms`: a bogus or clock-skewed value falls back to now.
pub fn timeline_updated_ms(universal_ticks: i64, now_ms: u64) -> u64 {
    const UNIX_EPOCH_TICKS: i64 = 116_444_736_000_000_000;
    let ms = universal_ticks.saturating_sub(UNIX_EPOCH_TICKS) / 10_000;
    if ms <= 0 {
        now_ms
    } else {
        (ms as u64).min(now_ms)
    }
}

/// Whether the island should be told about `next`, given the last emitted
/// snapshot and how long ago that was. Plain playback progress is not news;
/// a track change, a play/pause flip or a seek is.
pub fn should_emit(previous: Option<&NowPlaying>, next: &NowPlaying, elapsed_ms: u64) -> bool {
    let Some(previous) = previous else { return true };
    if elapsed_ms < DEBOUNCE_MS {
        return false;
    }
    if previous.active != next.active
        || previous.title != next.title
        || previous.artist != next.artist
        || previous.app != next.app
        || previous.playing != next.playing
        || previous.duration_ms != next.duration_ms
        || previous.art != next.art
    {
        return true;
    }
    // Plain progress is not a seek: the position is where the clock says it
    // should be by now. Anything further off than SEEK_MS is a seek.
    let played = if previous.playing {
        next.updated_at_ms.saturating_sub(previous.updated_at_ms)
    } else {
        0
    };
    let expected = previous.position_ms.saturating_add(played);
    (next.position_ms as i64 - expected as i64).abs() >= SEEK_MS
}

/// The name the card shows for a session's SourceAppUserModelId: the app's
/// file stem or package name, title-cased, with the well-known ones named.
pub fn app_label(aumid: &str) -> String {
    const KNOWN: &[(&str, &str)] = &[
        ("Spotify.exe", "Spotify"),
        ("SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify", "Spotify"),
        ("chrome.exe", "Chrome"),
        ("msedge.exe", "Edge"),
        ("firefox.exe", "Firefox"),
        ("Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic", "Media Player"),
    ];
    for (id, label) in KNOWN {
        if aumid.eq_ignore_ascii_case(id) {
            return label.to_string();
        }
    }
    // The file stem, or the part before "_" for a package AUMID.
    let base = aumid.split('_').next().unwrap_or(aumid);
    let base = base.rsplit(['\\', '/']).next().unwrap_or(base);
    let base = base
        .strip_suffix(".exe")
        .or_else(|| base.strip_suffix(".EXE"))
        .unwrap_or(base);
    let mut label = String::new();
    for word in base.replace('.', " ").split_whitespace() {
        if !label.is_empty() {
            label.push(' ');
        }
        let mut chars = word.chars();
        if let Some(first) = chars.next() {
            label.extend(first.to_uppercase());
            label.push_str(chars.as_str());
        }
    }
    if label.is_empty() {
        "Unknown".to_string()
    } else {
        label
    }
}

/// How the playing app is brought forward, resolved from the session's
/// source identifier on the backend. The frontend never supplies this: the
/// command takes no arguments, so track titles and artist names are never
/// treated as something to run or open.
#[derive(Debug, Clone, PartialEq)]
pub enum AppLaunch {
    /// A packaged app (`FamilyName_xxx!AppId`): activated through the
    /// `shell:AppsFolder` entry Windows keeps for it.
    Packaged(String),
    /// A desktop app given by its full launcher path.
    ExePath(std::path::PathBuf),
    /// A desktop app given by its file name, resolved against `%PATH%`.
    ExeName(String),
}

/// Longer than this is not an identifier we act on.
const MAX_AUMID_LEN: usize = 256;

/// Splits a session source identifier into a safe launch plan, or `None` when
/// it is empty, malformed, or simply not something we open. Package names and
/// file stems use `[A-Za-z0-9._-]`; wildcards, quotes, pipes and control codes
/// refuse the whole value rather than being cleaned up.
pub fn resolve_app_launch(aumid: &str) -> Option<AppLaunch> {
    let id = aumid.trim();
    if id.is_empty() || id.len() > MAX_AUMID_LEN {
        return None;
    }
    if id.chars().any(|c| c.is_control()) {
        return None;
    }
    if id.contains('!') {
        let mut parts = id.splitn(2, '!');
        let (family, app) = (parts.next()?, parts.next()?);
        let ok = |s: &str| {
            !s.is_empty()
                && s.chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        };
        if !ok(family) || !ok(app) {
            return None;
        }
        return Some(AppLaunch::Packaged(id.to_string()));
    }
    if !id.to_ascii_lowercase().ends_with(".exe") {
        return None;
    }
    if id.contains(['*', '?', '<', '>', '|', '"']) {
        return None;
    }
    let path = std::path::Path::new(id);
    if path.is_absolute() {
        // A drive or host alone is not a launcher: a file name is required.
        // Parent escapes and remote shares never resolve to a local launcher.
        if path.file_name().is_none() || id.contains("..") || id.starts_with("\\\\") {
            return None;
        }
        return Some(AppLaunch::ExePath(path.to_path_buf()));
    }
    // A bare file name only: no directories, no drive, no remote share.
    if !id.contains(['\\', '/', ':'])
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | ' '))
    {
        return Some(AppLaunch::ExeName(id.to_string()));
    }
    None
}

/// Standard base64 with padding. One data URL is the only use, so it lives
/// here instead of pulling in a dependency.
#[cfg_attr(not(windows), allow(dead_code))]
fn base64(data: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let bytes = [
            chunk[0],
            chunk.get(1).copied().unwrap_or(0),
            chunk.get(2).copied().unwrap_or(0),
        ];
        let n = ((bytes[0] as u32) << 16) | ((bytes[1] as u32) << 8) | bytes[2] as u32;
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            TABLE[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

// ── Commands and startup ──────────────────────────────────────────────────────

/// Spawns the watcher thread. On other platforms this is a no-op.
pub fn start(app: AppHandle) {
    #[cfg(windows)]
    {
        windows_impl::start(app);
    }
    #[cfg(not(windows))]
    {
        let _ = app;
    }
}

/// The last snapshot the watcher read: first paint never waits on WinRT.
#[tauri::command]
pub fn media_snapshot(app: AppHandle) -> NowPlaying {
    #[cfg(windows)]
    {
        windows_impl::snapshot(&app)
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        NowPlaying::default()
    }
}

/// Brings the app behind the current media session forward. The source
/// identifier is read from the live session here, never from the frontend:
/// titles and artist names can never become a command or a URL. Packaged apps
/// activate through their `shell:AppsFolder` entry; desktop apps relaunch
/// from their own launcher path, which brings a running single-instance
/// player forward instead of doubling it. No session, an unknown identifier
/// or a failed spawn is a quiet `false`, never an error carrying metadata.
#[tauri::command]
pub async fn open_playing_app(app: AppHandle) -> bool {
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(move || windows_impl::open_playing_app(&app))
            .await
            .unwrap_or(false)
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        false
    }
}
/// Previous / next / play-pause / seek, applied on the watcher thread.
#[tauri::command]
pub fn media_control(
    app: AppHandle,
    action: String,
    position_ms: Option<u64>,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        windows_impl::control(&app, &action, position_ms)
    }
    #[cfg(not(windows))]
    {
        let _ = (app, action, position_ms);
        Err("Media control is only available on Windows.".to_string())
    }
}

// ── Windows watcher ───────────────────────────────────────────────────────────

#[cfg(windows)]
mod windows_impl {
    use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
    use std::sync::Mutex;
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

    use tauri::{AppHandle, Emitter, Manager};
    use windows::Foundation::TypedEventHandler;
    use windows::Media::Control::{
        CurrentSessionChangedEventArgs, GlobalSystemMediaTransportControlsSession,
        GlobalSystemMediaTransportControlsSessionManager as SessionManager,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus,
        MediaPropertiesChangedEventArgs, PlaybackInfoChangedEventArgs,
        TimelinePropertiesChangedEventArgs,
    };
    use windows::Storage::Streams::{
        DataReader, IRandomAccessStreamReference, IRandomAccessStreamWithContentType,
    };
    use windows::Win32::System::WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED};
    use windows_future::{AsyncOperationCompletedHandler, IAsyncOperation};

    use super::{
        app_label, base64, resolve_app_launch, should_emit, ticks_to_ms, timeline_updated_ms,
        AppLaunch, NowPlaying, ART_TIMEOUT, DEBOUNCE_MS, EVENT, MAX_ART_BYTES, SUBSCRIBE_RETRY,
    };

    /// What the watcher thread receives: an event from Windows woke us, the
    /// island wants a control applied, or a helper thread finished a thumbnail.
    enum Message {
        Wake,
        CurrentSessionChanged,
        Control {
            action: String,
            position_ms: Option<u64>,
        },
        /// Artwork for one track key, or None when it has none.
        Art {
            key: String,
            art: Option<String>,
        },
    }

    /// What the commands can reach. The watcher keeps `last` fresh.
    struct MediaState {
        tx: Mutex<Sender<Message>>,
        last: Mutex<NowPlaying>,
    }

    pub(super) fn start(app: AppHandle) {
        let (tx, rx) = mpsc::channel::<Message>();
        app.manage(MediaState {
            tx: Mutex::new(tx.clone()),
            last: Mutex::new(NowPlaying::default()),
        });
        if let Err(err) = std::thread::Builder::new()
            .name("choom-media".into())
            .spawn(move || watch(app, rx, tx))
        {
            crate::log::line(format!("media watcher failed to start: {err}"));
        }
    }

    pub(super) fn snapshot(app: &AppHandle) -> NowPlaying {
        match app.try_state::<MediaState>() {
            Some(state) => state.last.lock().unwrap().clone(),
            None => NowPlaying::default(),
        }
    }

    pub(super) fn control(
        app: &AppHandle,
        action: &str,
        position_ms: Option<u64>,
    ) -> Result<(), String> {
        let Some(state) = app.try_state::<MediaState>() else {
            return Err("The media watcher isn't running.".to_string());
        };
        let sent = state.tx.lock().unwrap().send(Message::Control {
            action: action.to_string(),
            position_ms,
        });
        sent.map_err(|_| "The media watcher isn't running.".to_string())
    }

    /// The app behind the current session, brought forward. The identifier
    /// comes from the live session, never from the frontend, and travels to
    /// the OS as one argument, never through a shell.
    pub(super) fn open_playing_app(_app: &AppHandle) -> bool {
        if unsafe { RoInitialize(RO_INIT_MULTITHREADED) }.is_err() { return false; }
        struct Apartment;
        impl Drop for Apartment {
            fn drop(&mut self) { unsafe { RoUninitialize(); } }
        }
        let _apartment = Apartment;
        let manager = match SessionManager::RequestAsync().and_then(|op| op.get()) {
            Ok(manager) => manager,
            Err(_) => return false,
        };
        let session = match manager.GetCurrentSession() {
            Ok(session) => session,
            Err(_) => return false,
        };
        let aumid = session
            .SourceAppUserModelId()
            .map(|id| id.to_string_lossy())
            .unwrap_or_default();
        launch_aumid(&aumid)
    }

    /// Bring an existing desktop player forward even when it is not on PATH.
    fn focus_desktop_player(exe_name: &str) -> bool {
        use windows::core::{BOOL, PWSTR};
        use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM};
        use windows::Win32::System::Threading::{OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION};
        use windows::Win32::UI::WindowsAndMessaging::{EnumWindows, GetWindowThreadProcessId, IsWindowVisible, SetForegroundWindow, ShowWindow, SW_RESTORE};
        struct Search { name: String, focused: bool }
        unsafe extern "system" fn visit(hwnd: HWND, param: LPARAM) -> BOOL {
            let search = unsafe { &mut *(param.0 as *mut Search) };
            if !unsafe { IsWindowVisible(hwnd) }.as_bool() { return BOOL(1); }
            let mut pid = 0;
            unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)); }
            let Ok(process) = (unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }) else { return BOOL(1); };
            let mut buffer = [0u16; 1024];
            let mut length = buffer.len() as u32;
            let result = unsafe { QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, PWSTR(buffer.as_mut_ptr()), &mut length) };
            let _ = unsafe { CloseHandle(process) };
            if result.is_err() { return BOOL(1); }
            let path = String::from_utf16_lossy(&buffer[..length as usize]);
            let name = path.rsplit(['\\', '/']).next().unwrap_or(&path);
            if !name.eq_ignore_ascii_case(&search.name) { return BOOL(1); }
            let _ = unsafe { ShowWindow(hwnd, SW_RESTORE) };
            search.focused = unsafe { SetForegroundWindow(hwnd) }.as_bool();
            BOOL(if search.focused { 0 } else { 1 })
        }
        let mut search = Search { name: exe_name.to_string(), focused: false };
        let _ = unsafe { EnumWindows(Some(visit), LPARAM((&mut search as *mut Search) as isize)) };
        search.focused
    }

    fn launch_aumid(aumid: &str) -> bool {
        match resolve_app_launch(aumid) {
            Some(AppLaunch::Packaged(id)) => {
                // Explorer hosts shell:AppsFolder activation for packaged apps.
                let mut cmd = std::process::Command::new("explorer.exe");
                crate::platform::no_console(&mut cmd);
                cmd.arg(format!("shell:AppsFolder\\{id}")).spawn().is_ok()
            }
            Some(AppLaunch::ExePath(path)) => {
                if let Some(name) = path.file_name().and_then(|name| name.to_str()) {
                    if focus_desktop_player(name) { return true; }
                }
                // Only an existing file goes further: the identifier named it.
                if !path.is_file() {
                    return false;
                }
                let mut cmd = std::process::Command::new(&path);
                crate::platform::no_console(&mut cmd);
                cmd.spawn().is_ok()
            }
            Some(AppLaunch::ExeName(name)) => {
                if focus_desktop_player(&name) { return true; }
                let stem = name
                    .strip_suffix(".exe")
                    .or_else(|| name.strip_suffix(".EXE"))
                    .unwrap_or(&name);
                match crate::platform::find_on_path(stem) {
                    Some(resolved) => {
                        let mut cmd = std::process::Command::new(&resolved);
                        crate::platform::no_console(&mut cmd);
                        cmd.spawn().is_ok()
                    }
                    None => false,
                }
            }
            None => false,
        }
    }

    /// The one loop: wait for a wake-up, then, at most every DEBOUNCE_MS, read
    /// a snapshot and emit it when it is news. Commands are applied inline so
    /// WinRT is only ever touched from this thread.
    fn watch(app: AppHandle, rx: Receiver<Message>, tx: Sender<Message>) {
        if let Err(err) = unsafe { RoInitialize(RO_INIT_MULTITHREADED) } {
            crate::log::line(format!("media: WinRT init failed: {err}"));
            return;
        }
        let manager = match SessionManager::RequestAsync().and_then(|op| op.get()) {
            Ok(manager) => manager,
            Err(err) => {
                crate::log::line(format!("media: no session manager: {err}"));
                return;
            }
        };

        let manager_handler: TypedEventHandler<SessionManager, CurrentSessionChangedEventArgs> =
            TypedEventHandler::new({
                let tx = tx.clone();
                move |_sender, _args| {
                    let _ = tx.send(Message::CurrentSessionChanged);
                    Ok(())
                }
            });
        // The token stays in scope for the life of the loop.
        let _manager_token = match manager.CurrentSessionChanged(&manager_handler) {
            Ok(token) => token,
            Err(err) => {
                crate::log::line(format!("media: could not watch sessions: {err}"));
                return;
            }
        };

        let mut subscription: Option<Subscription> = None;
        // One pending retry after a failed subscribe; a real session change is
        // the other way back, so this can never turn into a poll.
        let mut retry_at: Option<Instant> = None;
        if !subscribe(&manager, &tx, &mut subscription) {
            retry_at = Some(Instant::now() + SUBSCRIBE_RETRY);
        }

        let mut art_cache = ArtCache::default();
        let mut last_emitted: Option<NowPlaying> = None;
        let mut last_emit_at: Option<Instant> = None;
        let mut dirty = true;
        // A user action through media_control always shows up, even when it
        // moved the position by less than a seek.
        let mut force = false;

        loop {
            let now = Instant::now();
            let since_emit = last_emit_at
                .map(|at| now.duration_since(at))
                .unwrap_or(Duration::MAX);

            if dirty && since_emit >= Duration::from_millis(DEBOUNCE_MS) {
                dirty = false;
                let snapshot = read_snapshot(&manager, &mut art_cache, &tx);
                if let Some(state) = app.try_state::<MediaState>() {
                    *state.last.lock().unwrap() = snapshot.clone();
                }
                let elapsed_ms = since_emit.as_millis().min(u64::MAX as u128) as u64;
                if force || should_emit(last_emitted.as_ref(), &snapshot, elapsed_ms) {
                    force = false;
                    last_emitted = Some(snapshot.clone());
                    last_emit_at = Some(Instant::now());
                    let _ = app.emit_to(crate::island::WINDOW_LABEL, EVENT, &snapshot);
                }
                continue;
            }

            // Nothing new: sleep until the debounce window ends, until the
            // subscribe retry is due, or until the next event arrives.
            let mut timeout = if dirty {
                Duration::from_millis(DEBOUNCE_MS).saturating_sub(since_emit)
            } else {
                Duration::from_secs(3600)
            };
            if let Some(at) = retry_at {
                timeout = timeout.min(at.saturating_duration_since(Instant::now()));
            }
            match rx.recv_timeout(timeout) {
                Ok(Message::Wake) => dirty = true,
                Ok(Message::CurrentSessionChanged) => {
                    if subscribe(&manager, &tx, &mut subscription) {
                        retry_at = None;
                    } else {
                        retry_at = Some(Instant::now() + SUBSCRIBE_RETRY);
                    }
                    dirty = true;
                }
                Ok(Message::Art { key, art }) => {
                    if art_cache.accept(&key, art) {
                        dirty = true;
                    }
                }
                Ok(Message::Control {
                    action,
                    position_ms,
                }) => {
                    // A session that appeared while there was none is picked
                    // up here too, without waiting for the retry.
                    if subscription.is_none() && subscribe(&manager, &tx, &mut subscription) {
                        retry_at = None;
                    }
                    match apply_control(&manager, &action, position_ms) {
                        Ok(()) => force = true,
                        Err(err) => crate::log::line(format!("media control: {err}")),
                    }
                    dirty = true;
                }
                Err(RecvTimeoutError::Timeout) => {
                    // The one retry: if this fails too, the next session
                    // change is the way back.
                    if let Some(at) = retry_at {
                        if Instant::now() >= at {
                            retry_at = None;
                            if subscribe(&manager, &tx, &mut subscription) {
                                dirty = true;
                            }
                        }
                    }
                }
                Err(RecvTimeoutError::Disconnected) => return,
            }
        }
    }

    /// One session's live event subscriptions. Dropping it unsubscribes.
    struct Subscription {
        session: GlobalSystemMediaTransportControlsSession,
        tokens: [i64; 3],
    }

    impl Drop for Subscription {
        fn drop(&mut self) {
            let _ = self.session.RemoveMediaPropertiesChanged(self.tokens[0]);
            let _ = self.session.RemovePlaybackInfoChanged(self.tokens[1]);
            let _ = self.session.RemoveTimelinePropertiesChanged(self.tokens[2]);
        }
    }

    /// Follows the current session for as long as it lives. Windows raises
    /// CurrentSessionChanged on every track change within an app too, so this
    /// runs whenever the session object may have changed; the old handlers are
    /// removed with the old session. Returns false when there is no session or
    /// a registration failed; whatever did register is removed again first.
    fn subscribe(
        manager: &SessionManager,
        tx: &Sender<Message>,
        slot: &mut Option<Subscription>,
    ) -> bool {
        if let Some(previous) = slot.take() {
            drop(previous);
        }
        let Ok(session) = manager.GetCurrentSession() else {
            return false;
        };
        let media: TypedEventHandler<GlobalSystemMediaTransportControlsSession, MediaPropertiesChangedEventArgs> =
            TypedEventHandler::new({
                let tx = tx.clone();
                move |_sender, _args| {
                    let _ = tx.send(Message::Wake);
                    Ok(())
                }
            });
        let playback: TypedEventHandler<GlobalSystemMediaTransportControlsSession, PlaybackInfoChangedEventArgs> =
            TypedEventHandler::new({
                let tx = tx.clone();
                move |_sender, _args| {
                    let _ = tx.send(Message::Wake);
                    Ok(())
                }
            });
        let timeline: TypedEventHandler<GlobalSystemMediaTransportControlsSession, TimelinePropertiesChangedEventArgs> =
            TypedEventHandler::new({
                let tx = tx.clone();
                move |_sender, _args| {
                    let _ = tx.send(Message::Wake);
                    Ok(())
                }
            });
        let (media, playback, timeline) = (
            session.MediaPropertiesChanged(&media),
            session.PlaybackInfoChanged(&playback),
            session.TimelinePropertiesChanged(&timeline),
        );
        if let (Ok(a), Ok(b), Ok(c)) = (media.as_ref(), playback.as_ref(), timeline.as_ref()) {
            *slot = Some(Subscription {
                session,
                tokens: [*a, *b, *c],
            });
            return true;
        }
        // A half-registered session would double-fire after the next attempt.
        if let Ok(token) = media {
            let _ = session.RemoveMediaPropertiesChanged(token);
        }
        if let Ok(token) = playback {
            let _ = session.RemovePlaybackInfoChanged(token);
        }
        if let Ok(token) = timeline {
            let _ = session.RemoveTimelinePropertiesChanged(token);
        }
        false
    }

    /// The whole current state of whatever plays right now. A new track's
    /// thumbnail is fetched off-thread, so this loop never waits on an app.
    fn read_snapshot(
        manager: &SessionManager,
        art: &mut ArtCache,
        tx: &Sender<Message>,
    ) -> NowPlaying {
        let mut out = NowPlaying::default();
        let Ok(session) = manager.GetCurrentSession() else {
            out.updated_at_ms = now_ms();
            return out;
        };
        out.active = true;

        let aumid = session
            .SourceAppUserModelId()
            .map(|id| id.to_string_lossy())
            .unwrap_or_default();
        out.app = app_label(&aumid);

        if let Ok(properties) = session.TryGetMediaPropertiesAsync().and_then(|op| op.get()) {
            out.title = properties.Title().map(|s| s.to_string_lossy()).unwrap_or_default();
            out.artist = properties.Artist().map(|s| s.to_string_lossy()).unwrap_or_default();
            out.album = properties
                .AlbumTitle()
                .map(|s| s.to_string_lossy())
                .unwrap_or_default();
            if let Ok(thumbnail) = properties.Thumbnail() {
                let key = format!("{aumid}|{}|{}", out.title, out.artist);
                out.art = art.art_for(&key, &thumbnail, tx);
            }
        }

        if let Ok(info) = session.GetPlaybackInfo() {
            if let Ok(status) = info.PlaybackStatus() {
                out.playing = status == GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing;
            }
        }
        // The position is only valid as of LastUpdatedTime; the island anchors
        // its clock there, so a paused session keeps its real, frozen position.
        let mut updated_ticks: Option<i64> = None;
        if let Ok(timeline) = session.GetTimelineProperties() {
            if let Ok(position) = timeline.Position() {
                out.position_ms = ticks_to_ms(position.Duration);
            }
            if let Ok(end) = timeline.EndTime() {
                out.duration_ms = ticks_to_ms(end.Duration);
            }
            updated_ticks = timeline.LastUpdatedTime().ok().map(|time| time.UniversalTime);
        }
        let read_at = now_ms();
        out.updated_at_ms = updated_ticks
            .map(|ticks| timeline_updated_ms(ticks, read_at))
            .unwrap_or(read_at);
        out
    }

    /// Starts a control operation and does not wait for the app to answer: a
    /// hanging app must never freeze the watcher (or the next button press).
    fn apply_control(
        manager: &SessionManager,
        action: &str,
        position_ms: Option<u64>,
    ) -> Result<(), String> {
        let session = manager
            .GetCurrentSession()
            .map_err(|err| format!("no media session: {err}"))?;
        match action {
            "toggle" => session.TryTogglePlayPauseAsync(),
            "next" => session.TrySkipNextAsync(),
            "previous" => session.TrySkipPreviousAsync(),
            "seek" => {
                let position_ms =
                    position_ms.ok_or_else(|| "seek needs a position".to_string())?;
                session.TryChangePlaybackPositionAsync(position_ms as i64 * 10_000)
            }
            other => return Err(format!("unknown media action: {other}")),
        }
        .map(|_operation| ())
        .map_err(|err| err.to_string())
    }

    /// Last track's artwork. Each track key is read once on a helper thread;
    /// until the result lands, the card shows the placeholder.
    #[derive(Default)]
    struct ArtCache {
        last: Option<(String, Option<String>)>,
        pending: Option<String>,
    }

    impl ArtCache {
        fn art_for(
            &mut self,
            key: &str,
            thumbnail: &IRandomAccessStreamReference,
            tx: &Sender<Message>,
        ) -> Option<String> {
            if let Some((cached, art)) = &self.last {
                if cached == key {
                    return art.clone();
                }
            }
            if self.pending.as_deref() != Some(key) {
                if let Ok(operation) = thumbnail.OpenReadAsync() {
                    self.pending = Some(key.to_string());
                    let key = key.to_string();
                    let tx = tx.clone();
                    let spawned = std::thread::Builder::new()
                        .name("choom-art".into())
                        .spawn(move || art_worker(tx, key, operation));
                    if spawned.is_err() {
                        self.pending = None;
                    }
                }
            }
            None
        }

        /// A finished read lands only if it is still the one that was asked
        /// for; the watcher then re-reads and emits a second time, with art.
        fn accept(&mut self, key: &str, art: Option<String>) -> bool {
            if self.pending.as_deref() != Some(key) {
                return false;
            }
            self.pending = None;
            self.last = Some((key.to_string(), art));
            true
        }
    }

    /// Opens the stream on its own short-lived thread, in its own apartment.
    fn art_worker(
        tx: Sender<Message>,
        key: String,
        operation: IAsyncOperation<IRandomAccessStreamWithContentType>,
    ) {
        if let Err(err) = unsafe { RoInitialize(RO_INIT_MULTITHREADED) } {
            crate::log::line(format!("media art: WinRT init failed: {err}"));
            return;
        }
        let art = read_art(operation);
        let _ = tx.send(Message::Art { key, art });
    }

    /// The thumbnail as a data URL: its own content type, or JPEG when the
    /// stream doesn't name one. The open is capped, so an app that never
    /// answers cannot hold the thread for long either.
    fn read_art(operation: IAsyncOperation<IRandomAccessStreamWithContentType>) -> Option<String> {
        let (tx, rx) = mpsc::channel::<()>();
        operation
            .SetCompleted(&AsyncOperationCompletedHandler::new(move |_op, _status| {
                let _ = tx.send(());
                Ok(())
            }))
            .ok()?;
        if rx.recv_timeout(ART_TIMEOUT).is_err() {
            return None;
        }
        let stream = operation.GetResults().ok()?;
        let size = stream.Size().ok()?;
        if size == 0 || size > MAX_ART_BYTES {
            return None;
        }
        let content_type = match stream.ContentType() {
            Ok(value) if !value.is_empty() => value.to_string_lossy(),
            _ => "image/jpeg".to_string(),
        };
        let input = stream.GetInputStreamAt(0).ok()?;
        let reader = DataReader::CreateDataReader(&input).ok()?;
        let loaded = reader.LoadAsync(size as u32).ok()?.get().ok()?;
        let mut bytes = vec![0u8; loaded as usize];
        reader.ReadBytes(&mut bytes).ok()?;
        Some(format!("data:{content_type};base64,{}", base64(&bytes)))
    }

    fn now_ms() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis().min(u64::MAX as u128) as u64)
            .unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::{
        app_label, base64, resolve_app_launch, should_emit, ticks_to_ms, timeline_updated_ms,
        AppLaunch, NowPlaying,
    };

    /// A playing track whose position was last updated at `updated_at_ms`.
    fn track_at(position_ms: u64, updated_at_ms: u64) -> NowPlaying {
        NowPlaying {
            active: true,
            playing: true,
            title: "Nightcall".into(),
            artist: "Kavinsky".into(),
            album: "OutRun".into(),
            app: "Spotify".into(),
            art: None,
            position_ms,
            duration_ms: 200_000,
            updated_at_ms,
        }
    }

    fn playing_at(position_ms: u64) -> NowPlaying {
        track_at(position_ms, 1_000_000)
    }

    #[test]
    fn app_label_names_the_known_apps() {
        assert_eq!(app_label("Spotify.exe"), "Spotify");
        assert_eq!(app_label("SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify"), "Spotify");
        assert_eq!(app_label("chrome.exe"), "Chrome");
        assert_eq!(app_label("msedge.exe"), "Edge");
        assert_eq!(app_label("firefox.exe"), "Firefox");
        assert_eq!(
            app_label("Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic"),
            "Media Player"
        );
    }

    #[test]
    fn app_label_falls_back_to_the_stem() {
        assert_eq!(app_label("VLC.exe"), "VLC");
        assert_eq!(app_label("Brave.exe"), "Brave");
        assert_eq!(app_label("C:\\Programs\\MusicBee.exe"), "MusicBee");
        assert_eq!(
            app_label("Microsoft.Windows.Photos_8wekyb3d8bbwe!App"),
            "Microsoft Windows Photos"
        );
        assert_eq!(app_label(""), "Unknown");
    }

    #[test]
    fn debounce_drops_changes_inside_the_window() {
        let previous = playing_at(1_000);
        let mut next = playing_at(1_200);
        next.title = "Another".into();
        assert!(!should_emit(Some(&previous), &next, 100));
        assert!(should_emit(Some(&previous), &next, 300));
    }

    #[test]
    fn debounce_ignores_plain_playback_progress() {
        // 10 s of playing later, the clock explains the whole move.
        let previous = track_at(1_000, 1_000_000);
        let next = track_at(11_000, 1_010_000);
        assert!(!should_emit(Some(&previous), &next, 800));

        // A paused session keeps its clock still.
        let mut paused = track_at(5_000, 1_000_000);
        paused.playing = false;
        let mut still_paused = paused.clone();
        still_paused.position_ms = 5_100;
        still_paused.updated_at_ms = 1_600_000;
        assert!(!should_emit(Some(&paused), &still_paused, 800));
    }

    #[test]
    fn debounce_emits_on_a_seek() {
        // The clock says 10 s passed; the position moved 29 s: a jump.
        let previous = track_at(1_000, 1_000_000);
        assert!(should_emit(Some(&previous), &track_at(30_000, 1_010_000), 300));
        // Backwards too.
        let previous = track_at(30_000, 1_000_000);
        assert!(should_emit(Some(&previous), &track_at(10_000, 1_010_000), 300));
        // A sub-threshold move the clock still explains is no seek; the
        // control's force flag is what gets that one out.
        assert!(!should_emit(
            Some(&track_at(1_000, 1_000_000)),
            &track_at(11_200, 1_010_000),
            300
        ));
    }

    #[test]
    fn timeline_clock_clamps_to_now() {
        const EPOCH: i64 = 116_444_736_000_000_000;
        assert_eq!(timeline_updated_ms(EPOCH + 10_000_000, 10_000), 1_000);
        // The epoch itself, a never-set value and garbage all fall back.
        assert_eq!(timeline_updated_ms(EPOCH, 500), 500);
        assert_eq!(timeline_updated_ms(0, 500), 500);
        assert_eq!(timeline_updated_ms(i64::MIN, 42), 42);
        // A future stamp is clamped to now.
        assert_eq!(timeline_updated_ms(EPOCH + 10_000_000 * 2_000, 1_000), 1_000);
    }

    #[test]
    fn debounce_emits_on_real_state_changes() {
        let previous = playing_at(1_000);
        let mut paused = playing_at(1_100);
        paused.playing = false;
        assert!(should_emit(Some(&previous), &paused, 300));

        let mut other_artist = playing_at(1_100);
        other_artist.artist = "Someone else".into();
        assert!(should_emit(Some(&previous), &other_artist, 300));

        let mut ended = playing_at(1_100);
        ended.active = false;
        ended.title.clear();
        assert!(should_emit(Some(&previous), &ended, 300));

        // The first snapshot always goes out.
        assert!(should_emit(None, &previous, 0));
    }

    #[test]
    fn app_launch_resolves_the_safe_sources() {
        assert_eq!(
            resolve_app_launch("Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic"),
            Some(AppLaunch::Packaged(
                "Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic".to_string()
            ))
        );
        assert!(matches!(
            resolve_app_launch("SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify"),
            Some(AppLaunch::Packaged(_))
        ));
        assert!(matches!(
            resolve_app_launch("C:\\Program Files\\VideoLAN\\vlc.exe"),
            Some(AppLaunch::ExePath(_))
        ));
        assert!(matches!(
            resolve_app_launch("VLC.exe"),
            Some(AppLaunch::ExeName(_))
        ));
    }

    #[test]
    fn app_launch_refuses_anything_untrusted() {
        // Track metadata is never a launch plan, and neither is anything that
        // could smuggle shell syntax or a second identifier along.
        for bad in [
            "",
            "   ",
            "Love Me The Same",
            "Astrality",
            "no-extension",
            "half!packaged!",
            "!no-family",
            "no-app!",
            "has space!bad app",
            "quoted\".exe",
            "wild*.exe",
            "pipe|.exe",
            "C:\\Music\\..\\evil.exe",
            "..\\evil.exe",
            "\\\\remote\\share\\evil.exe",
            "https://example.com/track",
            &"a".repeat(300),
            "a\u{0}.exe",
        ] {
            assert_eq!(resolve_app_launch(bad), None, "{bad:?} must be refused");
        }
    }

    #[test]
    fn ticks_become_milliseconds() {
        assert_eq!(ticks_to_ms(0), 0);
        assert_eq!(ticks_to_ms(10_000), 1);
        assert_eq!(ticks_to_ms(200_000_000), 20_000);
        assert_eq!(ticks_to_ms(-5), 0);
    }

    #[test]
    fn base64_pads_correctly() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foob"), "Zm9vYg==");
        assert_eq!(base64(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
    }
}
