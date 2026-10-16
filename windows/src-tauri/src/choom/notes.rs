// Flow local notes adapter and browser search. This is the explicit Windows
// substitute for Apple Notes: plain text or Markdown files inside one
// user-selected folder, opened in a configured editor. It never touches an
// arbitrary existing notes app, never overwrites a file, and verifies what it
// wrote by reading it back. Browser searches build an encoded URL and open it
// in a configured browser or the OS default; the receipt reports the exact URL
// dispatched and never claims a page was reached.
//
// Every Tauri command re-validates its inputs. Renderer-provided paths are
// checked with a component-based containment test, never raw directory
// equality, and rename only ever operates on a note this session created.

use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;

use crate::Shared;

/// Note titles are bounded so a spoken name stays a readable file name.
pub const MAX_NOTE_TITLE: usize = 60;
/// Note body cap: a dictated paragraph, not a document editor.
pub const MAX_NOTE_BODY: usize = 8000;
/// Query cap: long enough for a search, short enough to stay one URL.
pub const MAX_SEARCH_QUERY: usize = 500;
/// Only these note extensions may ever be written or renamed.
pub const NOTE_EXTENSIONS: &[&str] = &["md", "txt"];

/// Characters Windows refuses in a file name. A title containing any of these
/// is rejected outright rather than silently rewritten, so the user hears the
/// name they spoke back as the file that was written.
const RESERVED_CHARS: &[char] = &['<', '>', ':', '"', '/', '\\', '|', '?', '*'];

/// Device names Windows treats as streams even with an extension.
const RESERVED_NAMES: &[&str] = &[
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8",
    "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

/// A note path this session created. Rename is only ever allowed for one of
/// these, so a model returning an arbitrary path can never rename a file Flow
/// did not write itself.
#[derive(Debug, Default)]
pub struct NoteRegistry {
    created: Mutex<HashSet<String>>,
    renames: Mutex<()>,
}

impl NoteRegistry {
    /// Records a note path as owned by this session. Lowercased so Windows
    /// path casing never splits ownership across two entries.
    pub fn remember(&self, path: &str) {
        self.created.lock().unwrap().insert(normalize_key(path));
    }

    /// Retires ownership of one path. A successful rename forgets the old
    /// path, so a later unrelated file created at that path can never inherit
    /// the session's rename rights.
    pub fn forget(&self, path: &str) {
        self.created.lock().unwrap().remove(&normalize_key(path));
    }

    /// True when this session created the note, so it may be renamed.
    pub fn owns(&self, path: &str) -> bool {
        self.created.lock().unwrap().contains(&normalize_key(path))
    }
}

/// Removes a Windows extended-length verbatim prefix (`\\?\C:\...` or
/// `\\?\UNC\server\share`) so canonical and raw paths normalize identically.
fn strip_verbatim(path: &str) -> String {
    if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        // A UNC path keeps both leading separators: `\\server\share` is one
        // prefix component, while a single `\server\share` parses as a root
        // plus names and would split ownership across two keys.
        return format!(r"\\{rest}");
    }
    if let Some(rest) = path.strip_prefix(r"\\?\") {
        return rest.to_string();
    }
    path.to_string()
}

fn normalize_key(path: &str) -> String {
    // Windows canonicalize() returns an extended-length verbatim prefix. Strip
    // it so a canonical path and its raw form share one ownership key, and
    // containment never splits on a prefix the user never typed.
    let unverbatim = strip_verbatim(path);
    Path::new(&unverbatim)
        .components()
        .map(|c| c.as_os_str().to_string_lossy().to_lowercase())
        .collect::<Vec<_>>()
        .join("\\")
}

/// What a note write or rename produced. `path` is the verified location, so
/// the card can show exactly which file now holds the note.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteReceipt {
    pub title: String,
    pub path: String,
    pub bytes: u64,
    pub created_ms: u64,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Extension allow-list. Anything outside the approved note extensions is
/// refused rather than coerced, so Flow never becomes a generic file writer.
pub fn validate_note_extension(ext: &str) -> Result<String, String> {
    let clean = ext.trim().trim_start_matches('.').to_ascii_lowercase();
    if NOTE_EXTENSIONS.contains(&clean.as_str()) {
        Ok(clean)
    } else {
        Err("Notes are saved as Markdown or plain text.".to_string())
    }
}

/// Turns a spoken title into a safe file stem. Trims, bounds and rejects
/// anything Windows cannot hold. Returns None rather than guessing a name.
pub fn sanitize_note_title(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.chars().count() > MAX_NOTE_TITLE {
        return None;
    }
    if trimmed.chars().any(|c| RESERVED_CHARS.contains(&c) || c.is_control()) {
        return None;
    }
    // A trailing dot or space is dropped by Windows on save, which would make
    // the reported path a lie. Reject instead of writing a different name.
    if trimmed.ends_with('.') || trimmed.ends_with(' ') {
        return None;
    }
    let stem = trimmed.split('.').next().unwrap_or("").trim().to_lowercase();
    if RESERVED_NAMES.contains(&stem.as_str()) {
        return None;
    }
    Some(trimmed.to_string())
}

/// Component-based containment: is `candidate` inside `folder`? This compares
/// path components, so a relative traversal such as `..\..\secret.txt` or a
/// prefix that only matches on a string boundary is rejected. It does not rely
/// on raw directory equality, which a renderer-provided path could satisfy by
/// accident while still pointing elsewhere.
pub fn is_contained_in(folder: &Path, candidate: &Path) -> bool {
    let base: Vec<Component> = folder.components().collect();
    let target: Vec<Component> = candidate.components().collect();
    if base.is_empty() || target.len() <= base.len() {
        return false;
    }
    // A relative jump is never contained: `folder/../secret` shares the folder
    // prefix yet escapes it, so ParentDir is refused outright.
    if target.iter().any(|c| matches!(c, Component::ParentDir)) {
        return false;
    }
    // Every folder component must match in order; a child then has strictly
    // more components and shares the whole folder prefix.
    target.iter().zip(base.iter()).all(|(a, b)| a == b)
}

/// Resolves a renderer-provided note path to a canonical file inside the
/// notes folder, or an actionable error. Rejects traversal before resolving,
/// and compares canonical components afterwards so a junction or symlinked
/// subdirectory that points outside the folder is refused rather than trusted.
pub fn resolve_note_in_folder(folder: &Path, raw: &str) -> Result<PathBuf, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("That note has no file.".to_string());
    }
    let candidate = PathBuf::from(trimmed);
    if !candidate.is_absolute() {
        return Err("That note path needs a full path.".to_string());
    }
    // Reject a literal `..` before any resolution, so a traversal never gets a
    // chance to be normalized into something that looks contained.
    if candidate.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err("That file is not a note in your notes folder.".to_string());
    }
    // Canonicalize the folder, which the caller already verified exists.
    let base = folder
        .canonicalize()
        .map_err(|_| "Notes folder not found. Pick it again in Settings.".to_string())?;
    // Canonicalize the note when it exists; otherwise resolve its parent and
    // reattach the file name, so a not-yet-created path is still checked
    // against the real on-disk location of its directory.
    let resolved = if candidate.exists() {
        candidate
            .canonicalize()
            .map_err(|_| "That note could not be read.".to_string())?
    } else {
        let parent = candidate.parent().ok_or("That note has no folder.".to_string())?;
        let file = candidate.file_name().ok_or("That note has no file.".to_string())?;
        let real_parent = parent
            .canonicalize()
            .map_err(|_| "That note folder could not be read.".to_string())?;
        real_parent.join(file)
    };
    if resolved == base {
        return Err("That path is the notes folder, not a note.".to_string());
    }
    // Canonical components only: a junction or symlink that resolves outside
    // the folder fails this prefix match even though its raw path started
    // inside it.
    if !is_contained_in(&base, &resolved) {
        return Err("That file is not a note in your notes folder.".to_string());
    }
    Ok(resolved)
}

/// Picks the note path inside one folder. Never overwrites: an existing file
/// gets a numeric suffix so a second "meeting notes" is a new note, not a loss.
pub fn note_path_in(folder: &Path, title: &str, ext: &str) -> PathBuf {
    let base = folder.join(format!("{title}.{ext}"));
    if !base.exists() {
        return base;
    }
    for n in 2..1000 {
        let candidate = folder.join(format!("{title} ({n}).{ext}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    // A pathological folder: fall back to a timestamped name rather than
    // blocking the turn or overwriting anything.
    folder.join(format!("{title}-{}.{}", now_ms(), ext))
}

/// Note body is bounded and trimmed of a trailing newline for a clean file.
pub fn sanitize_note_body(raw: &str) -> Result<String, String> {
    let text = raw.trim_end();
    if text.chars().count() > MAX_NOTE_BODY {
        return Err("That note is too long. Keep it under 8000 characters.".to_string());
    }
    Ok(text.to_string())
}

/// Validates the user-selected notes folder: absolute, existing and a
/// directory. No folder chosen is an actionable error, never a silent default.
pub fn validate_notes_folder(folder: &str) -> Result<PathBuf, String> {
    let trimmed = folder.trim();
    if trimmed.is_empty() {
        return Err("Pick a folder for notes in Settings first.".to_string());
    }
    let path = PathBuf::from(trimmed);
    if !path.is_absolute() {
        return Err("The notes folder needs a full path.".to_string());
    }
    if !path.is_dir() {
        return Err(format!("Notes folder not found: \"{trimmed}\". Pick it again in Settings."))
    }
    Ok(path)
}

/// Writes one new note and reads it back to verify the bytes landed. The write
/// uses create_new, so an existing file is never opened or truncated.
pub fn write_note(
    folder: &Path,
    title: &str,
    body: &str,
    ext: &str,
) -> Result<NoteReceipt, String> {
    // Title, extension and body are validated here as well as at the command
    // boundary, so no caller can reach a write through a lower-level path.
    let title = sanitize_note_title(title)
        .ok_or("That note name cannot be used. Try another.")?;
    let ext = validate_note_extension(ext)?;
    let body = sanitize_note_body(body)?;
    let path = note_path_in(folder, &title, &ext);
    let contents = format!("{}\n", body);
    let bytes = contents.as_bytes();
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .and_then(|mut file| {
            std::io::Write::write_all(&mut file, bytes)?;
            std::io::Write::flush(&mut file)?;
            Ok(())
        })
        .map_err(|err| format!("Could not write the note: {err}"))?;
    // Verify by reading back: the receipt only claims what is provably on disk.
    let read_back = std::fs::read(&path)
        .map_err(|err| format!("Could not verify the note: {err}"))?;
    // Byte-for-byte comparison against the intended content, not just length.
    if read_back.as_slice() != bytes {
        return Err("The note did not save correctly. Try again.".to_string());
    }
    Ok(NoteReceipt {
        title: title.to_string(),
        path: path.to_string_lossy().to_string(),
        bytes: read_back.len() as u64,
        created_ms: now_ms(),
    })
}

/// Moves one file without ever replacing an existing destination. On Windows
/// this is MoveFileExW without MOVEFILE_REPLACE_EXISTING, which refuses
/// atomically when the destination exists, so two competing renames can never
/// both win or interleave between an exists-check and the move. Elsewhere the
/// fallback pairs an exclusive hard link with a remove, which also refuses to
/// replace a destination.
pub fn move_file_noreplace(source: &Path, destination: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        fn wide(path: &Path) -> Vec<u16> {
            path.as_os_str().encode_wide().chain(std::iter::once(0)).collect()
        }
        const MOVEFILE_WRITE_THROUGH: u32 = 0x8;
        // No MOVEFILE_REPLACE_EXISTING: the move is one atomic operation that
        // refuses a destination that exists, whenever it appeared.
        extern "system" {
            fn MoveFileExW(lp_existing: *const u16, lp_new: *const u16, flags: u32) -> i32;
        }
        let from = wide(source);
        let to = wide(destination);
        let moved = unsafe {
            MoveFileExW(from.as_ptr(), to.as_ptr(), MOVEFILE_WRITE_THROUGH)
        };
        if moved != 0 {
            return Ok(());
        }
        let err = std::io::Error::last_os_error();
        if destination.exists() {
            let name = destination.file_name().unwrap_or_default().to_string_lossy().to_string();
            return Err(format!("A note named \"{name}\" already exists. Pick another name."));
        }
        return Err(format!("Could not rename the note: {err}"));
    }
    #[cfg(not(windows))]
    {
        std::fs::hard_link(source, destination)
            .map_err(|err| format!("Could not rename the note: {err}"))?;
        std::fs::remove_file(source)
            .map_err(|err| format!("Could not remove the old note: {err}"))?;
        Ok(())
    }
}

/// Renames a note this session created, without overwriting. The source must
/// be owned by the session and inside the notes folder; the destination is
/// moved with an atomic refusal-to-replace, the moved bytes are compared
/// against a snapshot of the source before the receipt is claimed, and the
/// old path's ownership is retired.
/// The rename transaction. `pre_move` runs while the rename lock is held,
/// immediately before the move itself, so a fenced caller can recheck its
/// generation after waiting on the lock: a Stop that landed while the request
/// queued still refuses the move, and the ownership check and readback stay
/// inside the same serialized transaction.
pub fn rename_note_with(
    folder: &Path,
    current_path: &str,
    new_title: &str,
    ext: &str,
    registry: &NoteRegistry,
    pre_move: &dyn Fn() -> Result<(), String>,
) -> Result<NoteReceipt, String> {
    // Serialize ownership, move and readback together. Windows can open the
    // same source for two concurrent moves before either retires its path,
    // so correct no-replace flags alone cannot serialize the transaction:
    // the lock makes the second request see the source already retired.
    let _rename = registry.renames.lock().unwrap();
    // Title and extension are validated here as well as at the command
    // boundary, so no caller can rename through a lower-level path.
    let new_title = sanitize_note_title(new_title)
        .ok_or("That note name cannot be used. Try another.")?;
    let ext = validate_note_extension(ext)?;
    let source = resolve_note_in_folder(folder, current_path)?;
    if !source.is_file() {
        return Err("That note no longer exists.".to_string());
    }
    // Only a note this session wrote may be renamed. A model returning an
    // arbitrary path is refused here.
    if !registry.owns(&source.to_string_lossy()) {
        return Err("You can only rename a note Flow just created.".to_string());
    }
    // A rename targets the exact name the user chose. If a different note
    // already holds it, refuse with an actionable message rather than silently
    // suffixing to a name the user never asked for. Create uses note_path_in's
    // suffix; rename does not, because a rename is a deliberate naming action.
    let destination = folder.join(format!("{new_title}.{ext}"));
    if destination.exists() {
        return Err(format!("A note named \"{new_title}\" already exists. Pick another name."))
    }
    // Snapshot the source bytes before the move, so the verified receipt can
    // compare what landed against what was actually there.
    let snapshot = std::fs::read(&source)
        .map_err(|err| format!("Could not read the note before renaming: {err}"))?;
    // Fenced callers recheck here, after any lock wait, immediately before
    // the side effect.
    pre_move()?;
    move_file_noreplace(&source, &destination)?;
    let read_back = std::fs::read(&destination)
        .map_err(|err| format!("Could not verify the rename: {err}"))?;
    // Byte-for-byte comparison against the pre-rename snapshot: the receipt
    // only claims a verified rename when the moved content is proven intact.
    if read_back.as_slice() != snapshot.as_slice() {
        return Err("The renamed note did not match the original. Try again.".to_string());
    }
    // Retire the old path first: after a successful rename, a later unrelated
    // file at the old path can never inherit this session's ownership.
    registry.forget(&source.to_string_lossy());
    registry.remember(&destination.to_string_lossy());
    Ok(NoteReceipt {
        title: new_title,
        path: destination.to_string_lossy().to_string(),
        bytes: read_back.len() as u64,
        created_ms: now_ms(),
    })
}

// ── Browser search ─────────────────────────────────────────────────────────

/// Percent-encodes a query for a URL. Only unreserved characters stay bare, so
/// spaces, ampersands and quotes can never escape into the URL structure.
pub fn encode_query(query: &str) -> String {
    let mut out = String::with_capacity(query.len() * 3);
    for byte in query.as_bytes() {
        let c = *byte as char;
        let safe = c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '~');
        if safe {
            out.push(c);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// Builds a search URL from the configured engine template. The template must
/// hold a `{q}` placeholder; a missing or malformed template is an error rather
/// than a guessed endpoint.
pub fn build_search_url(engine: &str, query: &str) -> Result<String, String> {
    let clean = query.trim();
    if clean.is_empty() {
        return Err("Say what you want to search for.".to_string());
    }
    if clean.chars().count() > MAX_SEARCH_QUERY {
        return Err("That search is too long. Shorten it.".to_string());
    }
    let engine = engine.trim();
    if !(engine.starts_with("https://") || engine.starts_with("http://")) {
        return Err("The search engine must be an http or https URL.".to_string());
    }
    if !engine.contains("{q}") {
        return Err("The search engine URL needs a {q} placeholder.".to_string());
    }
    // A query can never break out of the placeholder into the URL structure.
    Ok(engine.replace("{q}", &encode_query(clean)))
}

/// Result of dispatching a URL. `url` is the exact link handed to the
/// browser; `verified` stays false because no code here can prove a page
/// loaded. The requested URL is not destination proof.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserReceipt {
    pub url: String,
    pub dispatched: bool,
    /// Always false for now: reaching a page is not observable without focus
    /// tricks this build refuses to use.
    pub verified: bool,
}

/// Opens a URL in the configured browser when one is saved and exists,
/// otherwise in the OS default. Reports the exact URL dispatched and never
/// claims the destination was reached.
pub fn open_browser_url(browser: &str, url: &str) -> Result<BrowserReceipt, String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("Only http and https links can be opened.".to_string());
    }
    let configured = browser.trim();
    if !configured.is_empty() {
        let path = PathBuf::from(configured);
        if !path.is_file() {
            return Err(format!("Configured browser not found: \"{configured}\". Update it in Settings."))
        }
        let mut cmd = std::process::Command::new(&path);
        cmd.arg(url);
        crate::platform::no_console(&mut cmd);
        return match cmd.spawn() {
            Ok(_) => Ok(BrowserReceipt { url: url.to_string(), dispatched: true, verified: false }),
            Err(err) => Err(format!("Could not open the browser: {err}")),
        };
    }
    // OS default: the platform helper owns the shell-free dispatch.
    crate::platform::open_url(url);
    Ok(BrowserReceipt { url: url.to_string(), dispatched: true, verified: false })
}

/// Opens one owned note in the configured editor. The note must exist, be
/// inside the notes folder and be owned by this session; the editor must be
/// configured and exist on disk. No guessed handler, no invented arguments,
/// and the dispatch is never destination proof.
pub fn open_owned_note(
    folder_raw: &str,
    editor_raw: &str,
    path: &str,
    registry: &NoteRegistry,
) -> Result<(), String> {
    let folder = validate_notes_folder(folder_raw)?;
    let note = resolve_note_in_folder(&folder, path)?;
    if !note.is_file() {
        return Err("That note no longer exists.".to_string());
    }
    if !registry.owns(&note.to_string_lossy()) {
        return Err("You can only open a note Flow created.".to_string());
    }
    let editor = editor_raw.trim();
    if editor.is_empty() {
        return Err("Pick a note editor in Settings first.".to_string());
    }
    let editor_path = PathBuf::from(editor);
    if !editor_path.is_file() {
        return Err(format!("Configured editor not found: \"{editor}\". Update it in Settings."));
    }
    let mut cmd = std::process::Command::new(&editor_path);
    cmd.arg(&note);
    crate::platform::no_console(&mut cmd);
    match cmd.spawn() {
        Ok(_) => Ok(()),
        Err(err) => Err(format!("Could not open the note: {err}")),
    }
}

// ── Tauri commands ─────────────────────────────────────────────────────────

/// Current Flow readiness: whether notes, browser and search engine are usable
/// right now. Truthful, never optimistic.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowStatus {
    pub ready: bool,
    pub notes_folder: String,
    pub notes_ready: bool,
    pub browser_ready: bool,
    pub search_ready: bool,
    pub detail: String,
}

#[tauri::command]
pub fn flow_status(shared: State<'_, Shared>) -> FlowStatus {
    let (folder_raw, browser, engine) = {
        let s = shared.settings.lock().unwrap();
        (s.flow_notes_folder.clone(), s.flow_browser.clone(), s.flow_search_engine.clone())
    };
    let notes_ready = validate_notes_folder(&folder_raw).is_ok();
    let search_ready = build_search_url(&engine, "probe").is_ok();
    let browser_trimmed = browser.trim();
    let browser_ready = browser_trimmed.is_empty() || Path::new(browser_trimmed).is_file();
    let detail = if !notes_ready {
        "Pick a notes folder in Settings to create notes.".to_string()
    } else if !browser_ready {
        "The configured browser is missing. Update it in Settings.".to_string()
    } else if !search_ready {
        "The search engine URL needs a {q} placeholder.".to_string()
    } else {
        "Flow is ready.".to_string()
    };
    let ready = notes_ready && browser_ready && search_ready;
    FlowStatus { ready, notes_folder: folder_raw, notes_ready, browser_ready, search_ready, detail }
}

/// Creates one note in the configured notes folder. Every input is re-validated
/// here, the folder is the user-selected one, and the note is registered as
/// owned by this session so it may later be renamed.
/// Rechecks the live voice generation inside the blocking closure, immediately
/// before the side effect. A Stop that landed after the frontend's own fence
/// still refuses the work here, honestly, before anything is written or sent.
fn fence_guard(shared: &Shared, fence: &crate::choom::voice::FlowFence, generation: u64) -> Result<(), String> {
    fence.check_enabled(shared.settings.lock().unwrap().flow_enabled, generation)
}

#[tauri::command]
pub async fn flow_note_create(
    app: tauri::AppHandle,
    shared: State<'_, Shared>,
    fence: State<'_, crate::choom::voice::FlowFence>,
    title: String,
    body: String,
    generation: u64,
) -> Result<NoteReceipt, String> {
    use tauri::Manager;
    let folder_raw = shared.settings.lock().unwrap().flow_notes_folder.clone();
    let title = sanitize_note_title(&title).ok_or("That note name cannot be used. Try another.")?;
    let body = sanitize_note_body(&body)?;
    let fence = fence.0.clone();
    tokio::task::spawn_blocking(move || {
        let registry = app.state::<NoteRegistry>();
        let folder = validate_notes_folder(&folder_raw)?;
        // The fence is rechecked immediately before the write itself.
        fence_guard(&app.state::<Shared>(), &crate::choom::voice::FlowFence(fence), generation)?;
        let receipt = write_note(&folder, &title, &body, "md")?;
        registry.remember(&receipt.path);
        Ok(receipt)
    })
    .await
    .map_err(|_| "Note worker stopped unexpectedly.".to_string())?
}

/// Renames a note this session created. Arbitrary existing files are refused:
/// the path must be owned by the session and inside the notes folder.
#[tauri::command]
pub async fn flow_note_rename(
    app: tauri::AppHandle,
    shared: State<'_, Shared>,
    fence: State<'_, crate::choom::voice::FlowFence>,
    path: String,
    new_title: String,
    generation: u64,
) -> Result<NoteReceipt, String> {
    use tauri::Manager;
    let folder_raw = shared.settings.lock().unwrap().flow_notes_folder.clone();
    let new_title =
        sanitize_note_title(&new_title).ok_or("That note name cannot be used. Try another.")?;
    let fence = fence.0.clone();
    tokio::task::spawn_blocking(move || {
        let registry = app.state::<NoteRegistry>();
        let folder = validate_notes_folder(&folder_raw)?;
        // The fence is rechecked before the transaction, and once more after
        // the rename lock is acquired, immediately before the move.
        let fence = crate::choom::voice::FlowFence(fence);
        fence_guard(&app.state::<Shared>(), &fence, generation)?;
        rename_note_with(
            &folder, &path, &new_title, "md", &registry,
            &|| fence_guard(&app.state::<Shared>(), &fence, generation),
        )
    })
    .await
    .map_err(|_| "Note worker stopped unexpectedly.".to_string())?
}

#[tauri::command]
pub async fn flow_note_open(
    app: tauri::AppHandle,
    shared: State<'_, Shared>,
    fence: State<'_, crate::choom::voice::FlowFence>,
    path: String,
    generation: u64,
) -> Result<(), String> {
    use tauri::Manager;
    let (folder_raw, editor_raw) = {
        let s = shared.settings.lock().unwrap();
        (s.flow_notes_folder.clone(), s.flow_editor.clone())
    };
    let fence = fence.0.clone();
    tokio::task::spawn_blocking(move || {
        let registry = app.state::<NoteRegistry>();
        // The fence is rechecked immediately before the editor spawn.
        fence_guard(&app.state::<Shared>(), &crate::choom::voice::FlowFence(fence), generation)?;
        open_owned_note(&folder_raw, &editor_raw, &path, &registry)
    })
    .await
    .map_err(|_| "Note worker stopped unexpectedly.".to_string())?
}

/// Runs a web search in the configured browser or the OS default. The receipt
/// carries the exact URL dispatched and stays unverified.
#[tauri::command]
pub async fn flow_browser_search(
    app: tauri::AppHandle,
    shared: State<'_, Shared>,
    fence: State<'_, crate::choom::voice::FlowFence>,
    query: String,
    generation: u64,
) -> Result<BrowserReceipt, String> {
    use tauri::Manager;
    let engine = shared.settings.lock().unwrap().flow_search_engine.clone();
    let url = build_search_url(&engine, &query)?;
    let browser = shared.settings.lock().unwrap().flow_browser.clone();
    let fence = fence.0.clone();
    tokio::task::spawn_blocking(move || {
        // The fence is rechecked immediately before the browser dispatch.
        fence_guard(&app.state::<Shared>(), &crate::choom::voice::FlowFence(fence), generation)?;
        open_browser_url(&browser, &url)
    })
    .await
    .map_err(|_| "Browser worker stopped unexpectedly.".to_string())?
}

/// Opens one http or https link in the configured browser or the OS default.
/// Receipt stays unverified: the URL is what was dispatched, not a page proof.
#[tauri::command]
pub async fn flow_browser_open(
    app: tauri::AppHandle,
    shared: State<'_, Shared>,
    fence: State<'_, crate::choom::voice::FlowFence>,
    url: String,
    generation: u64,
) -> Result<BrowserReceipt, String> {
    use tauri::Manager;
    let browser = shared.settings.lock().unwrap().flow_browser.clone();
    let fence = fence.0.clone();
    tokio::task::spawn_blocking(move || {
        // The fence is rechecked immediately before the browser dispatch.
        fence_guard(&app.state::<Shared>(), &crate::choom::voice::FlowFence(fence), generation)?;
        open_browser_url(&browser, &url)
    })
    .await
    .map_err(|_| "Browser worker stopped unexpectedly.".to_string())?
}

use tauri::State;

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_folder(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("choom-notes-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn titles_are_bounded_and_reject_reserved_shapes() {
        assert_eq!(sanitize_note_title("  meeting notes  "), Some("meeting notes".to_string()));
        assert_eq!(sanitize_note_title(&"a".repeat(61)), None);
        assert_eq!(sanitize_note_title("   "), None);
        assert_eq!(sanitize_note_title("bad/name"), None);
        assert_eq!(sanitize_note_title("bad:name"), None);
        assert_eq!(sanitize_note_title("trailing."), None);
        assert_eq!(sanitize_note_title("con"), None);
        assert_eq!(sanitize_note_title("NUL.txt"), None);
        assert_eq!(sanitize_note_title("notes.txt"), Some("notes.txt".to_string()));
        assert_eq!(sanitize_note_title("note\u{0}null"), None);
    }

    #[test]
    fn extensions_are_allow_listed() {
        assert_eq!(validate_note_extension("md"), Ok("md".to_string()));
        assert_eq!(validate_note_extension(".TXT"), Ok("txt".to_string()));
        assert!(validate_note_extension("exe").is_err());
        assert!(validate_note_extension("js").is_err());
        assert!(validate_note_extension("").is_err());
        assert!(validate_note_extension("../md").is_err());
    }

    #[test]
    fn containment_is_component_based_not_prefix_string() {
        let folder = Path::new("C:\\Notes");
        assert!(is_contained_in(folder, Path::new("C:\\Notes\\a.md")));
        assert!(is_contained_in(folder, Path::new("C:\\Notes\\sub\\a.md")));
        // A sibling that shares a string prefix is not contained.
        assert!(!is_contained_in(folder, Path::new("C:\\NotesOther\\a.md")));
        assert!(!is_contained_in(folder, Path::new("C:\\Notes")));
        assert!(!is_contained_in(folder, Path::new("C:\\Secret\\a.md")));
    }

    #[test]
    fn renderer_paths_reject_traversal_and_outside_files() {
        let folder = temp_folder("resolve");
        assert!(resolve_note_in_folder(&folder, "").is_err());
        assert!(resolve_note_in_folder(&folder, "relative.md").is_err());
        assert!(resolve_note_in_folder(&folder, &folder.to_string_lossy()).is_err());
        // Traversal stays outside even though the literal prefix starts inside.
        let traversal = folder.join("..").join("escape.md");
        assert!(resolve_note_in_folder(&folder, &traversal.to_string_lossy()).is_err());
        let outside = std::env::temp_dir().join("choom-outside.md");
        assert!(resolve_note_in_folder(&folder, &outside.to_string_lossy()).is_err());
        // A real child resolves cleanly to a canonical path inside the folder.
        let child = folder.join("note.md");
        let resolved = resolve_note_in_folder(&folder, &child.to_string_lossy()).unwrap();
        assert_eq!(resolved.file_name().unwrap(), "note.md");
        let base = folder.canonicalize().unwrap();
        assert!(is_contained_in(&base, &resolved));
        let _ = std::fs::remove_dir_all(&folder);
    }

    #[test]
    fn symlinked_subdir_escape_is_refused() {
        // A junction or symlinked subdirectory inside the folder that points
        // outside it must not be treated as contained. A plain symlink needs
        // privileges, so when that fails the test creates a junction with
        // mklink /J, which needs none. Only when neither can be created does
        // the guard go unexercised here; every other run is a real proof.
        let folder = temp_folder("junction");
        let outside = temp_folder("junction-outside");
        let link = folder.join("sub");
        #[cfg(windows)]
        {
            if std::os::windows::fs::symlink_dir(&outside, &link).is_err() {
                let made = std::process::Command::new("cmd")
                    .args(["/C", "mklink", "/J"])
                    .arg(&link)
                    .arg(&outside)
                    .status();
                if !matches!(made, Ok(status) if status.success()) {
                    let _ = std::fs::remove_dir_all(&folder);
                    let _ = std::fs::remove_dir_all(&outside);
                    return; // Neither symlink nor junction available on this host.
                }
            }
        }
        #[cfg(not(windows))]
        {
            if std::os::unix::fs::symlink(&outside, &link).is_err() {
                let _ = std::fs::remove_dir_all(&folder);
                let _ = std::fs::remove_dir_all(&outside);
                return;
            }
        }
        // The raw path starts inside the folder, but canonical resolution
        // lands outside it, so containment must refuse.
        let escape = link.join("note.md");
        assert!(resolve_note_in_folder(&folder, &escape.to_string_lossy()).is_err());
        let _ = std::fs::remove_dir_all(&folder);
        let _ = std::fs::remove_dir_all(&outside);
    }

    #[test]
    fn ownership_keys_normalize_local_and_unc_paths() {
        // Extended-length local paths collapse onto their raw form.
        assert_eq!(
            normalize_key(r"\\?\C:\Notes\Meeting.md"),
            normalize_key(r"C:\notes\meeting.md"),
        );
        // A verbatim UNC path keeps its two leading separators so it shares
        // one key with the raw UNC form instead of splitting ownership.
        assert_eq!(
            normalize_key(r"\\?\UNC\Server\Share\Notes\Meeting.md"),
            normalize_key(r"\\server\share\notes\meeting.md"),
        );
        // A root-plus-names parse would never equal the UNC prefix parse.
        assert_ne!(
            normalize_key(r"\server\share\meeting.md"),
            normalize_key(r"\\server\share\meeting.md"),
        );
    }

    #[test]
    fn rename_retires_ownership_and_proves_moved_bytes() {
        let folder = temp_folder("retire");
        let registry = NoteRegistry::default();
        let created = write_note(&folder, "draft", "first body", "md").unwrap();
        let keeper = write_note(&folder, "keeper", "other body", "md").unwrap();
        // The command registers ownership after a write; the test does too.
        registry.remember(&created.path);
        registry.remember(&keeper.path);
        // A destination that already exists is refused; nothing is clobbered.
        assert!(rename_note_with(&folder, &created.path, "keeper", "md", &registry, &|| Ok(())).is_err());
        assert_eq!(std::fs::read_to_string(&keeper.path).unwrap().trim(), "other body");
        // The verified rename compares the moved bytes against the source.
        let renamed = rename_note_with(&folder, &created.path, "final", "md", &registry, &|| Ok(())).unwrap();
        assert!(renamed.path.ends_with("final.md"));
        assert_eq!(std::fs::read_to_string(&renamed.path).unwrap().trim(), "first body");
        // The old path no longer inherits ownership; the new path is owned.
        assert!(!registry.owns(&created.path));
        assert!(registry.owns(&renamed.path));
        // Renaming through the retired path is refused.
        assert!(rename_note_with(&folder, &created.path, "again", "md", &registry, &|| Ok(())).is_err());
        let _ = std::fs::remove_dir_all(&folder);
    }

    #[test]
    fn move_refuses_collision_and_preserves_destination_bytes() {
        let folder = temp_folder("collision");
        let source = folder.join("source.md");
        let destination = folder.join("taken.md");
        std::fs::write(&source, "source bytes").unwrap();
        std::fs::write(&destination, "precious existing bytes").unwrap();
        // The low-level move refuses an existing destination outright, and
        // neither file is touched: the existing note keeps its exact bytes
        // and the source stays where it was.
        let err = move_file_noreplace(&source, &destination).unwrap_err();
        assert!(err.contains("already exists"), "unexpected error: {err}");
        assert_eq!(
            std::fs::read_to_string(&destination).unwrap().trim(),
            "precious existing bytes",
        );
        assert_eq!(std::fs::read_to_string(&source).unwrap().trim(), "source bytes");
        // Without the collision the same call moves the file intact.
        let free = folder.join("free.md");
        move_file_noreplace(&source, &free).unwrap();
        assert_eq!(std::fs::read_to_string(&free).unwrap().trim(), "source bytes");
        assert!(!source.exists());
        let _ = std::fs::remove_dir_all(&folder);
    }

    #[test]
    fn competing_renames_have_exactly_one_winner() {
        let folder = temp_folder("compete");
        let registry = NoteRegistry::default();
        let created = write_note(&folder, "draft", "content", "md").unwrap();
        registry.remember(&created.path);
        // Two renames race for one source with different destinations. The
        // refusal-to-replace move is atomic, so exactly one can win and no
        // destination is ever silently replaced.
        let (left, right) = std::thread::scope(|scope| {
            let a = scope.spawn(|| rename_note_with(&folder, &created.path, "left", "md", &registry, &|| Ok(())));
            let b = scope.spawn(|| rename_note_with(&folder, &created.path, "right", "md", &registry, &|| Ok(())));
            (a.join().unwrap(), b.join().unwrap())
        });
        let wins = [left.is_ok(), right.is_ok()]
            .iter()
            .filter(|ok| **ok)
            .count();
        assert_eq!(wins, 1, "exactly one competing rename wins");
        let left_exists = folder.join("left.md").is_file();
        let right_exists = folder.join("right.md").is_file();
        assert_ne!(left_exists, right_exists, "exactly one destination holds the note");
        let _ = std::fs::remove_dir_all(&folder);
    }

    #[test]
    fn open_refuses_missing_editor_and_unowned_paths() {
        let folder = temp_folder("open");
        let folder_raw = folder.to_string_lossy().to_string();
        let registry = NoteRegistry::default();
        let created = write_note(&folder, "draft", "body", "md").unwrap();
        registry.remember(&created.path);
        // No editor configured: unavailable with a reason, never a guess.
        assert!(open_owned_note(&folder_raw, "", &created.path, &registry)
            .unwrap_err()
            .contains("editor"));
        // A configured editor that does not exist is surfaced, not attempted.
        let missing = folder.join("no-such-editor.exe").to_string_lossy().to_string();
        assert!(open_owned_note(&folder_raw, &missing, &created.path, &registry)
            .unwrap_err()
            .contains("not found"));
        // An unowned path inside the folder is refused before any spawn.
        let unowned = write_note(&folder, "other", "body", "md").unwrap();
        assert!(open_owned_note(&folder_raw, &missing, &unowned.path, &registry)
            .unwrap_err()
            .contains("Flow created"));
        let _ = std::fs::remove_dir_all(&folder);
    }

    #[test]
    fn low_level_write_and_rename_revalidate_title_and_extension() {
        let folder = temp_folder("lowlevel");
        let registry = NoteRegistry::default();
        // A bad title or extension is refused here, not only at the command.
        assert!(write_note(&folder, "bad/name", "body", "md").is_err());
        assert!(write_note(&folder, "ok", "body", "exe").is_err());
        assert_eq!(std::fs::read_dir(&folder).unwrap().count(), 0);
        let created = write_note(&folder, "ok", "body", "md").unwrap();
        registry.remember(&created.path);
        assert!(rename_note_with(&folder, &created.path, "bad:name", "md", &registry, &|| Ok(())).is_err());
        assert!(rename_note_with(&folder, &created.path, "ok", "js", &registry, &|| Ok(())).is_err());
        // The original note is untouched after both refusals.
        assert!(Path::new(&created.path).exists());
        let _ = std::fs::remove_dir_all(&folder);
    }

    #[test]
    fn existing_notes_are_suffixed_not_overwritten() {
        let folder = temp_folder("suffix");
        let first = note_path_in(&folder, "meeting", "md");
        std::fs::write(&first, "one").unwrap();
        let second = note_path_in(&folder, "meeting", "md");
        assert_eq!(second, folder.join("meeting (2).md"));
        std::fs::write(&second, "two").unwrap();
        let third = note_path_in(&folder, "meeting", "md");
        assert_eq!(third, folder.join("meeting (3).md"));
        assert_eq!(std::fs::read_to_string(&first).unwrap(), "one");
        assert_eq!(std::fs::read_to_string(&second).unwrap(), "two");
        let _ = std::fs::remove_dir_all(&folder);
    }

    #[test]
    fn note_write_verifies_bytes_on_disk() {
        let folder = temp_folder("write");
        let receipt = write_note(&folder, "groceries", "buy milk", "md").unwrap();
        assert!(receipt.path.ends_with("groceries.md"));
        assert_eq!(receipt.bytes, "buy milk\n".len() as u64);
        assert_eq!(std::fs::read_to_string(&receipt.path).unwrap(), "buy milk\n");
        // A second identical title is a new file, never a loss.
        let second = write_note(&folder, "groceries", "buy tea", "md").unwrap();
        assert!(second.path.ends_with("groceries (2).md"));
        assert_eq!(std::fs::read_to_string(&receipt.path).unwrap(), "buy milk\n");
        let _ = std::fs::remove_dir_all(&folder);
    }

    #[test]
    fn note_write_rejects_oversized_body() {
        let folder = temp_folder("big");
        let oversized = "x".repeat(MAX_NOTE_BODY + 1);
        assert!(write_note(&folder, "big", &oversized, "md").is_err());
        assert_eq!(std::fs::read_dir(&folder).unwrap().count(), 0);
        let _ = std::fs::remove_dir_all(&folder);
    }

    #[test]
    fn rename_requires_session_ownership_and_stays_inside() {
        let folder = temp_folder("rename");
        let registry = NoteRegistry::default();
        let created = write_note(&folder, "draft", "hello", "md").unwrap();
        // Not owned yet: rename refused.
        assert!(rename_note_with(&folder, &created.path, "final", "md", &registry, &|| Ok(())).is_err());
        registry.remember(&created.path);
        let renamed = rename_note_with(&folder, &created.path, "final", "md", &registry, &|| Ok(())).unwrap();
        assert!(renamed.path.ends_with("final.md"));
        assert!(!Path::new(&created.path).exists());
        // The destination is now owned too.
        assert!(registry.owns(&renamed.path));
        // Renaming onto a different existing note is refused.
        let other = write_note(&folder, "taken", "second", "md").unwrap();
        assert!(rename_note_with(&folder, &renamed.path, "taken", "md", &registry, &|| Ok(())).is_err());
        // An arbitrary existing file the session did not create is refused.
        assert!(!registry.owns(&other.path));
        assert!(rename_note_with(&folder, &other.path, "moved", "md", &registry, &|| Ok(())).is_err());
        let _ = std::fs::remove_dir_all(&folder);
    }

    #[test]
    fn rename_rejects_traversal_and_outside_paths() {
        let folder = temp_folder("rename-out");
        let registry = NoteRegistry::default();
        let outside = std::env::temp_dir().join("choom-outside-note.md");
        std::fs::write(&outside, "x").unwrap();
        registry.remember(&outside.to_string_lossy());
        // Even an owned path outside the folder is refused by containment.
        assert!(rename_note_with(&folder, outside.to_string_lossy().as_ref(), "moved", "md", &registry, &|| Ok(())).is_err());
        let traversal = folder.join("..").join("escape.md");
        assert!(rename_note_with(&folder, &traversal.to_string_lossy(), "moved", "md", &registry, &|| Ok(())).is_err());
        let _ = std::fs::remove_file(&outside);
    }

    #[test]
    fn missing_notes_folder_is_actionable() {
        assert!(validate_notes_folder("").is_err());
        assert!(validate_notes_folder("relative/path").is_err());
        assert!(validate_notes_folder("C:\\definitely\\missing\\folder").is_err());
    }

    #[test]
    fn queries_are_percent_encoded() {
        assert_eq!(encode_query("c++ templates"), "c%2B%2B%20templates");
        assert_eq!(encode_query("a&b=c"), "a%26b%3Dc");
        assert_eq!(encode_query("plain"), "plain");
        assert_eq!(encode_query("héllo"), "h%C3%A9llo");
    }

    #[test]
    fn search_url_requires_a_valid_template_and_query() {
        let url = build_search_url("https://duckduckgo.com/?q={q}", "  rust ownership  ").unwrap();
        assert_eq!(url, "https://duckduckgo.com/?q=rust%20ownership");
        assert!(build_search_url("https://duckduckgo.com/?q={q}", "   ").is_err());
        assert!(build_search_url("https://duckduckgo.com/?q=nope", "rust").is_err());
        assert!(build_search_url("ftp://x?q={q}", "rust").is_err());
        // A hostile query cannot break out of the placeholder.
        let hostile = build_search_url("https://x.test/?q={q}&lang=en", "a&b=1\"<script>").unwrap();
        assert!(hostile.starts_with("https://x.test/?q=a%26b%3D1%22%3Cscript%3E"));
        assert!(hostile.ends_with("&lang=en"));
        assert!(!hostile.contains("<script>"));
        assert!(build_search_url("https://x.test/?q={q}", &"q".repeat(501)).is_err());
    }

    #[test]
    fn browser_receipt_is_never_verified_without_destination_proof() {
        // A non-http URL is refused before any dispatch.
        assert!(open_browser_url("", "file:///etc/passwd").is_err());
        assert!(open_browser_url("", "javascript:alert(1)").is_err());
        // A configured browser that is missing reports actionably.
        let missing = open_browser_url("C:\\definitely\\missing\\browser.exe", "https://example.com");
        assert!(missing.is_err());
    }

    #[test]
    fn new_prose_avoids_banned_connectors() {
        let source = include_str!("notes.rs");
        assert!(!source.contains('\u{2014}'), "notes.rs must not contain em dashes");
        assert!(!source.contains('\u{2013}'), "notes.rs must not contain en dashes");
    }
}
