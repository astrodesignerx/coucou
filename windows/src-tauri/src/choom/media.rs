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
        || previous.playing != next.playing
        || previous.duration_ms != next.duration_ms
        || previous.art != next.art
    {
        return true;
    }
    (next.position_ms as i64 - previous.position_ms as i64).abs() >= SEEK_MS
}

/// The name the card shows for a session's SourceAppUserModelId: the app's
/// file stem or package name, title-cased, with the well-known ones named.
pub fn app_label(aumid: &str) -> String {
    const KNOWN: &[(&str, &str)] = &[
        ("Spotify.exe", "Spotify"),
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
    use windows::Storage::Streams::{DataReader, IRandomAccessStreamReference};
    use windows::Win32::System::WinRT::{RoInitialize, RO_INIT_MULTITHREADED};

    use super::{
        app_label, base64, should_emit, ticks_to_ms, NowPlaying, DEBOUNCE_MS, EVENT,
        MAX_ART_BYTES,
    };

    /// What the watcher thread receives: an event from Windows woke us, or the
    /// island wants a control applied.
    enum Message {
        Wake,
        CurrentSessionChanged,
        Control {
            action: String,
            position_ms: Option<u64>,
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
        subscribe(&manager, &tx, &mut subscription);

        let mut art_cache = ArtCache::default();
        let mut last_emitted: Option<NowPlaying> = None;
        let mut last_emit_at: Option<Instant> = None;
        let mut dirty = true;

        loop {
            let now = Instant::now();
            let since_emit = last_emit_at
                .map(|at| now.duration_since(at))
                .unwrap_or(Duration::MAX);

            if dirty && since_emit >= Duration::from_millis(DEBOUNCE_MS) {
                dirty = false;
                let snapshot = read_snapshot(&manager, &mut art_cache);
                if let Some(state) = app.try_state::<MediaState>() {
                    *state.last.lock().unwrap() = snapshot.clone();
                }
                let elapsed_ms = since_emit.as_millis().min(u64::MAX as u128) as u64;
                if should_emit(last_emitted.as_ref(), &snapshot, elapsed_ms) {
                    last_emitted = Some(snapshot.clone());
                    last_emit_at = Some(Instant::now());
                    let _ = app.emit_to(crate::island::WINDOW_LABEL, EVENT, &snapshot);
                }
                continue;
            }

            // Nothing new: sleep until the debounce window ends, or until the
            // next event arrives.
            let timeout = if dirty {
                Duration::from_millis(DEBOUNCE_MS).saturating_sub(since_emit)
            } else {
                Duration::from_secs(3600)
            };
            match rx.recv_timeout(timeout) {
                Ok(Message::Wake) => dirty = true,
                Ok(Message::CurrentSessionChanged) => {
                    subscribe(&manager, &tx, &mut subscription);
                    dirty = true;
                }
                Ok(Message::Control {
                    action,
                    position_ms,
                }) => {
                    if let Err(err) = apply_control(&manager, &action, position_ms) {
                        crate::log::line(format!("media control: {err}"));
                    }
                    dirty = true;
                }
                Err(RecvTimeoutError::Timeout) => {}
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
    /// removed with the old session.
    fn subscribe(manager: &SessionManager, tx: &Sender<Message>, slot: &mut Option<Subscription>) {
        if let Some(previous) = slot.take() {
            drop(previous);
        }
        let Ok(session) = manager.GetCurrentSession() else {
            return;
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
        let (Ok(a), Ok(b), Ok(c)) = (
            session.MediaPropertiesChanged(&media),
            session.PlaybackInfoChanged(&playback),
            session.TimelinePropertiesChanged(&timeline),
        ) else {
            return;
        };
        *slot = Some(Subscription {
            session,
            tokens: [a, b, c],
        });
    }

    /// The whole current state of whatever plays right now.
    fn read_snapshot(manager: &SessionManager, art: &mut ArtCache) -> NowPlaying {
        let mut out = NowPlaying {
            updated_at_ms: now_ms(),
            ..NowPlaying::default()
        };
        let Ok(session) = manager.GetCurrentSession() else {
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
                out.art = art.art_for(&key, &thumbnail);
            }
        }

        if let Ok(info) = session.GetPlaybackInfo() {
            if let Ok(status) = info.PlaybackStatus() {
                out.playing = status == GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing;
            }
        }
        if let Ok(timeline) = session.GetTimelineProperties() {
            if let Ok(position) = timeline.Position() {
                out.position_ms = ticks_to_ms(position.Duration);
            }
            if let Ok(end) = timeline.EndTime() {
                out.duration_ms = ticks_to_ms(end.Duration);
            }
        }
        out
    }

    fn apply_control(
        manager: &SessionManager,
        action: &str,
        position_ms: Option<u64>,
    ) -> Result<(), String> {
        let session = manager
            .GetCurrentSession()
            .map_err(|err| format!("no media session: {err}"))?;
        let operation = match action {
            "toggle" => session.TryTogglePlayPauseAsync(),
            "next" => session.TrySkipNextAsync(),
            "previous" => session.TrySkipPreviousAsync(),
            "seek" => {
                let position_ms =
                    position_ms.ok_or_else(|| "seek needs a position".to_string())?;
                session.TryChangePlaybackPositionAsync(position_ms as i64 * 10_000)
            }
            other => return Err(format!("unknown media action: {other}")),
        };
        let accepted = operation
            .and_then(|op| op.get())
            .map_err(|err| err.to_string())?;
        if accepted {
            Ok(())
        } else {
            Err(format!("the app refused the {action} command"))
        }
    }

    /// Last track's artwork, read once per track key (app + title + artist).
    #[derive(Default)]
    struct ArtCache {
        last: Option<(String, Option<String>)>,
    }

    impl ArtCache {
        fn art_for(
            &mut self,
            key: &str,
            thumbnail: &IRandomAccessStreamReference,
        ) -> Option<String> {
            if let Some((cached, art)) = &self.last {
                if cached == key {
                    return art.clone();
                }
            }
            let art = read_art(thumbnail);
            self.last = Some((key.to_string(), art.clone()));
            art
        }
    }

    /// The thumbnail as a data URL: its own content type, or JPEG when the
    /// stream doesn't name one.
    fn read_art(thumbnail: &IRandomAccessStreamReference) -> Option<String> {
        let stream = thumbnail.OpenReadAsync().ok()?.get().ok()?;
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
    use super::{app_label, base64, should_emit, ticks_to_ms, NowPlaying};

    fn playing_at(position_ms: u64) -> NowPlaying {
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
            updated_at_ms: 1,
        }
    }

    #[test]
    fn app_label_names_the_known_apps() {
        assert_eq!(app_label("Spotify.exe"), "Spotify");
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
        let previous = playing_at(1_000);
        let next = playing_at(1_800); // 0.8 s later, no seek
        assert!(!should_emit(Some(&previous), &next, 800));
    }

    #[test]
    fn debounce_emits_on_a_seek() {
        let previous = playing_at(1_000);
        assert!(should_emit(Some(&previous), &playing_at(9_000), 300));
        // Backwards too.
        let previous = playing_at(9_000);
        assert!(should_emit(Some(&previous), &playing_at(1_000), 300));
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
