// Compact local tools: colour pocket, command bar and routines at basic scope.
// No eyedropper, no shelf, no shell strings, no scheduling, no external
// actions and no agent-generated routines. Everything here is explicit and
// local: user-entered HEX colours, saved executable and folder shortcuts, and
// ordered shortcut lists that only run after an explicit Run.
//
// Launching never builds a shell string. Executables are spawned directly with
// no arguments, folders go through the platform reveal helper, and every
// missing target reports an actionable error instead of failing quietly.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

/// Version of the persisted tools shape. Unknown versions load as empty
/// rather than being misread.
pub const TOOLS_VERSION: u32 = 1;
/// Visual swatch history cap, newest first.
pub const MAX_COLOURS: usize = 24;
/// Sane caps so a hand-edited settings file cannot grow the card forever.
pub const MAX_SHORTCUTS: usize = 100;
pub const MAX_ROUTINES: usize = 30;
pub const MAX_STEPS: usize = 20;
pub const MAX_NAME_LEN: usize = 60;

/// One saved launcher: an app executable or a folder. The target is always a
/// full local path; URLs and shell fragments are rejected at validation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolShortcut {
    pub id: String,
    pub name: String,
    /// "app" or "folder".
    pub kind: String,
    pub target: String,
}

/// One user-created routine: an ordered list of shortcut ids.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolRoutine {
    pub id: String,
    pub name: String,
    pub steps: Vec<String>,
}

/// Persisted tools state, stored inside settings.json through the existing
/// settings save path. No secrets ever land here.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolsData {
    /// Missing in hand-written files, which read as v1; any other version
    /// loads as empty rather than being misread.
    #[serde(default = "default_tools_version")]
    pub version: u32,
    #[serde(default)]
    pub colours: Vec<String>,
    #[serde(default)]
    pub shortcuts: Vec<ToolShortcut>,
    #[serde(default)]
    pub routines: Vec<ToolRoutine>,
}

fn default_tools_version() -> u32 {
    TOOLS_VERSION
}

impl Default for ToolsData {
    fn default() -> Self {
        Self { version: TOOLS_VERSION, colours: Vec::new(), shortcuts: Vec::new(), routines: Vec::new() }
    }
}

/// One routine step, resolved to kind and target at Run time so the backend
/// revalidates what it launches instead of trusting stored ids.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineStep {
    pub id: String,
    pub kind: String,
    pub target: String,
}

/// Per-step outcome of a routine run, in execution order.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StepResult {
    pub id: String,
    /// "ok", "failed", "cancelled" or "skipped".
    pub status: String,
    pub message: String,
}

/// Guards one routine run at a time. Shared by the Tauri command state and by
/// the unit tests, so duplicate-run prevention is proven without spawning.
#[derive(Debug, Default)]
pub struct RoutineGate {
    running: Mutex<Option<String>>,
}

impl RoutineGate {
    pub fn try_begin(&self, id: &str) -> Result<(), String> {
        let mut running = self.running.lock().unwrap();
        if running.is_some() {
            return Err("A routine is already running. Wait for it to finish or cancel it.".to_string());
        }
        *running = Some(id.to_string());
        Ok(())
    }

    pub fn finish(&self) {
        *self.running.lock().unwrap() = None;
    }

    #[cfg(test)]
    pub fn current(&self) -> Option<String> {
        self.running.lock().unwrap().clone()
    }
}

/// Command state for routine runs: the duplicate-run gate plus the cancel
/// flag the Cancel button sets between steps.
#[derive(Debug, Default)]
pub struct RoutineState {
    pub gate: RoutineGate,
    pub cancel: AtomicBool,
}

// ── Colours ─────────────────────────────────────────────────────────────────

/// Normalises user-entered HEX to `#RRGGBB`. Accepts an optional single `#`
/// and 3 or 6 hex digits; anything else is None, never a guess.
pub fn normalize_hex(input: &str) -> Option<String> {
    let text = input.trim();
    let digits = text.strip_prefix('#').unwrap_or(text);
    if digits.len() != 3 && digits.len() != 6 {
        return None;
    }
    if !digits.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    if digits.len() == 3 {
        let mut out = String::with_capacity(7);
        out.push('#');
        for b in digits.bytes() {
            out.push((b as char).to_ascii_uppercase());
            out.push((b as char).to_ascii_uppercase());
        }
        Some(out)
    } else {
        Some(format!("#{}", digits.to_ascii_uppercase()))
    }
}

/// Adds a colour to the history, newest first. Duplicates (any case) move to
/// the front instead of doubling, and the history is capped at 24.
/// Test-covered through the test harness; kept warning-free for normal builds.
#[allow(dead_code)]
pub fn add_colour(colours: &[String], input: &str) -> Result<Vec<String>, String> {
    let hex = normalize_hex(input)
        .ok_or_else(|| "Enter a HEX colour like #1ED760 or 1ED760.".to_string())?;
    let mut next: Vec<String> = Vec::with_capacity(MAX_COLOURS);
    next.push(hex.clone());
    for existing in colours {
        if existing.eq_ignore_ascii_case(&hex) {
            continue;
        }
        if next.len() >= MAX_COLOURS {
            break;
        }
        next.push(existing.clone());
    }
    Ok(next)
}

/// Removes one colour, matching any case. Unknown values leave the list alone.
#[allow(dead_code)]
pub fn remove_colour(colours: &[String], hex: &str) -> Vec<String> {
    colours.iter().filter(|c| !c.eq_ignore_ascii_case(hex)).cloned().collect()
}

// ── Shortcut validation ─────────────────────────────────────────────────────

pub fn is_valid_id(id: &str) -> bool {
    if id.is_empty() || id.len() > 32 {
        return false;
    }
    let mut chars = id.chars();
    let first = chars.next().unwrap();
    if !first.is_ascii_lowercase() && !first.is_ascii_digit() {
        return false;
    }
    id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// Executable extensions launched directly on Windows. Scripts run through
/// Rust's own spawning (no shell string is ever built); anything else —
/// documents, links, Store apps — is out of basic scope.
#[cfg(windows)]
const APP_EXTENSIONS: &[&str] = &["exe", "bat", "cmd"];

/// Shape validation only (no file system touch): kind, absolute path, no
/// nulls or URLs, and the executable extension on Windows.
pub fn validate_shortcut_shape(kind: &str, target: &str) -> Result<(), String> {
    if kind != "app" && kind != "folder" {
        return Err("Shortcut kind must be \"app\" or \"folder\".".to_string());
    }
    let target = target.trim();
    if target.is_empty() {
        return Err("Pick a file or folder first.".to_string());
    }
    if target.len() > 4096 {
        return Err("That path is too long to be a shortcut target.".to_string());
    }
    if target.contains('\0') {
        return Err("That path contains a character shortcuts cannot hold.".to_string());
    }
    let lower = target.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("shell:") {
        return Err("Shortcuts point at local files and folders, not links.".to_string());
    }
    let path = Path::new(target);
    if !path.is_absolute() {
        return Err("Shortcuts need a full path, like C:\\Tools\\app.exe.".to_string());
    }
    if kind == "app" {
        #[cfg(windows)]
        {
            let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
            if !APP_EXTENSIONS.contains(&ext.as_str()) {
                return Err("Pick an .exe, .bat or .cmd file for an app shortcut.".to_string());
            }
        }
    }
    Ok(())
}

/// Existence check with an actionable message: what is missing and the two
/// things the user can do about it.
pub fn check_target_exists(kind: &str, target: &str) -> Result<(), String> {
    let target = target.trim();
    let path = Path::new(target);
    let ok = if kind == "folder" { path.is_dir() } else { path.is_file() };
    if ok {
        return Ok(());
    }
    if kind == "folder" {
        Err(format!("Folder not found: \"{target}\". Pick the folder again or remove this shortcut."))
    } else {
        Err(format!("Target not found: \"{target}\". Pick the file again or remove this shortcut."))
    }
}

pub fn validate_target(kind: &str, target: &str) -> Result<(), String> {
    validate_shortcut_shape(kind, target)?;
    check_target_exists(kind, target)
}

// ── Persistence validation ──────────────────────────────────────────────────

fn clean_name(name: &str) -> Option<String> {
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed.len() > MAX_NAME_LEN {
        return None;
    }
    Some(trimmed.to_string())
}

fn clean_shortcut(raw: &ToolShortcut) -> Option<ToolShortcut> {
    if !is_valid_id(&raw.id) {
        return None;
    }
    let name = clean_name(&raw.name)?;
    if raw.kind != "app" && raw.kind != "folder" {
        return None;
    }
    let target = raw.target.trim().to_string();
    if validate_shortcut_shape(&raw.kind, &target).is_err() {
        return None;
    }
    Some(ToolShortcut { id: raw.id.clone(), name, kind: raw.kind.clone(), target })
}

/// Validates persisted tools: keeps every valid entry, drops what cannot be
/// trusted, and never invents replacements. Unknown future versions load as
/// empty rather than being misread.
pub fn sanitize_data(data: ToolsData) -> ToolsData {
    if data.version != TOOLS_VERSION {
        return ToolsData::default();
    }
    let mut colours: Vec<String> = Vec::new();
    for raw in &data.colours {
        if let Some(hex) = normalize_hex(raw) {
            if !colours.iter().any(|c| c.eq_ignore_ascii_case(&hex)) {
                colours.push(hex);
            }
        }
        if colours.len() >= MAX_COLOURS {
            break;
        }
    }
    let mut shortcuts: Vec<ToolShortcut> = Vec::new();
    for raw in &data.shortcuts {
        if shortcuts.len() >= MAX_SHORTCUTS {
            break;
        }
        if let Some(clean) = clean_shortcut(raw) {
            if !shortcuts.iter().any(|s| s.id == clean.id) {
                shortcuts.push(clean);
            }
        }
    }
    let mut routines: Vec<ToolRoutine> = Vec::new();
    for raw in &data.routines {
        if routines.len() >= MAX_ROUTINES {
            break;
        }
        if !is_valid_id(&raw.id) || routines.iter().any(|r| r.id == raw.id) {
            continue;
        }
        let Some(name) = clean_name(&raw.name) else { continue };
        if raw.steps.is_empty() || raw.steps.len() > MAX_STEPS {
            continue;
        }
        // Every step must resolve to a kept shortcut, or the routine is
        // dropped whole: steps are never silently rewritten on load.
        if !raw.steps.iter().all(|id| shortcuts.iter().any(|s| &s.id == id)) {
            continue;
        }
        routines.push(ToolRoutine { id: raw.id.clone(), name, steps: raw.steps.clone() });
    }
    ToolsData { version: TOOLS_VERSION, colours, shortcuts, routines }
}

/// Untyped entry point for settings.json values: wrong shapes and future
/// versions become empty tools, never an error and never a partial read.
#[allow(dead_code)]
pub fn sanitize_value(value: serde_json::Value) -> ToolsData {
    if !value.is_object() {
        return ToolsData::default();
    }
    if let Some(version) = value.get("version").and_then(|v| v.as_u64()) {
        if version != u64::from(TOOLS_VERSION) {
            return ToolsData::default();
        }
    }
    match serde_json::from_value::<ToolsData>(value) {
        Ok(data) => sanitize_data(data),
        Err(_) => ToolsData::default(),
    }
}

// ── Routine execution ───────────────────────────────────────────────────────

fn ok_message(kind: &str) -> String {
    if kind == "folder" { "Opened.".to_string() } else { "Launched.".to_string() }
}

/// Runs steps in order with the given launcher. Stops after the first
/// failure (later steps read "skipped") and honours cancellation before each
/// step (that step and the rest read "cancelled").
pub fn run_steps(
    steps: &[RoutineStep],
    launch: &dyn Fn(&str, &str) -> Result<(), String>,
    cancel: &AtomicBool,
) -> Vec<StepResult> {
    let mut results: Vec<StepResult> = Vec::with_capacity(steps.len());
    let mut stopping: Option<&str> = None;
    for step in steps {
        if stopping.is_none() && cancel.load(Ordering::SeqCst) {
            stopping = Some("cancelled");
        }
        if let Some(how) = stopping {
            results.push(StepResult {
                id: step.id.clone(),
                status: how.to_string(),
                message: if how == "cancelled" {
                    "Cancelled before this step ran.".to_string()
                } else {
                    "Skipped after an earlier step failed.".to_string()
                },
            });
            continue;
        }
        match launch(&step.kind, &step.target) {
            Ok(()) => results.push(StepResult {
                id: step.id.clone(),
                status: "ok".to_string(),
                message: ok_message(&step.kind),
            }),
            Err(err) => {
                results.push(StepResult { id: step.id.clone(), status: "failed".to_string(), message: err });
                stopping = Some("skipped");
            }
        }
    }
    results
}

// ── Native launching (side effects live here, not in the pure helpers) ─────

fn launch_app_native(target: &str) -> Result<(), String> {
    validate_shortcut_shape("app", target)?;
    check_target_exists("app", target)?;
    let target = target.trim();
    let mut cmd = std::process::Command::new(target);
    // No arguments, no shell: the path is handed over as the program itself.
    crate::platform::no_console(&mut cmd);
    cmd.spawn().map(|_| ()).map_err(|err| format!("Could not launch \"{target}\": {err}"))
}

fn open_folder_native(target: &str) -> Result<(), String> {
    validate_shortcut_shape("folder", target)?;
    check_target_exists("folder", target)?;
    crate::platform::reveal_folder(target.trim());
    Ok(())
}

fn launch_step(kind: &str, target: &str) -> Result<(), String> {
    if kind == "folder" { open_folder_native(target) } else { launch_app_native(target) }
}

// ── Native selection dialogs ────────────────────────────────────────────────
// The OS draws the picker; the app only receives the chosen path. Cancelled
// dialogs and unsupported platforms report None, never an error.

/// Native open-file dialog for app shortcuts (Windows). Filtered to directly
/// launchable programs; the user can still pick any file and validation
/// reports back when it is not launchable.
#[tauri::command]
pub fn tools_pick_file() -> Option<String> {
    #[cfg(windows)]
    {
        pick_file_native()
    }
    #[cfg(not(windows))]
    {
        None
    }
}

/// Native folder picker (Windows). Elsewhere the path is typed or dropped in
/// and validated the same way.
#[tauri::command]
pub fn tools_pick_folder() -> Option<String> {
    #[cfg(windows)]
    {
        pick_folder_native()
    }
    #[cfg(not(windows))]
    {
        None
    }
}

#[cfg(windows)]
fn pick_file_native() -> Option<String> {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::Controls::Dialogs::{
        GetOpenFileNameW, OPENFILENAMEW, OFN_DONTADDTORECENT, OFN_EXPLORER, OFN_FILEMUSTEXIST,
        OFN_NOCHANGEDIR, OFN_PATHMUSTEXIST,
    };
    use windows::core::{PCWSTR, PWSTR};

    let filter: Vec<u16> = "Programs (*.exe;*.bat;*.cmd)\0*.exe;*.bat;*.cmd\0All files (*.*)\0*.*\0"
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let title: Vec<u16> = "Choose an app for Tools".encode_utf16().chain(std::iter::once(0)).collect();
    let mut file_buf = vec![0u16; 32768];
    let mut dialog: OPENFILENAMEW = unsafe { std::mem::zeroed() };
    dialog.lStructSize = std::mem::size_of::<OPENFILENAMEW>() as u32;
    dialog.hwndOwner = HWND(std::ptr::null_mut());
    dialog.lpstrFilter = PCWSTR(filter.as_ptr());
    dialog.lpstrFile = PWSTR(file_buf.as_mut_ptr());
    dialog.nMaxFile = file_buf.len() as u32;
    dialog.lpstrTitle = PCWSTR(title.as_ptr());
    dialog.Flags = OFN_EXPLORER | OFN_FILEMUSTEXIST | OFN_PATHMUSTEXIST | OFN_NOCHANGEDIR | OFN_DONTADDTORECENT;
    if !unsafe { GetOpenFileNameW(&mut dialog) }.as_bool() {
        return None;
    }
    let len = file_buf.iter().position(|&c| c == 0).unwrap_or(file_buf.len());
    let path = String::from_utf16_lossy(&file_buf[..len]);
    if path.is_empty() { None } else { Some(path) }
}

#[cfg(windows)]
fn pick_folder_native() -> Option<String> {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::Shell::{
        BIF_NEWDIALOGSTYLE, BIF_RETURNONLYFSDIRS, BROWSEINFOW, ILFree, SHBrowseForFolderW,
        SHGetPathFromIDListW,
    };
    use windows::core::{PCWSTR, PWSTR};

    let title: Vec<u16> = "Choose a folder for Tools".encode_utf16().chain(std::iter::once(0)).collect();
    let mut display = [0u16; 260];
    let mut info: BROWSEINFOW = unsafe { std::mem::zeroed() };
    info.hwndOwner = HWND(std::ptr::null_mut());
    info.pszDisplayName = PWSTR(display.as_mut_ptr());
    info.lpszTitle = PCWSTR(title.as_ptr());
    info.ulFlags = BIF_RETURNONLYFSDIRS | BIF_NEWDIALOGSTYLE;
    let pidl = unsafe { SHBrowseForFolderW(&info) };
    if pidl.is_null() {
        return None;
    }
    let mut path = [0u16; 260];
    let ok = unsafe { SHGetPathFromIDListW(pidl, &mut path) }.as_bool();
    unsafe { ILFree(Some(pidl as *const _)) };
    if !ok {
        return None;
    }
    let len = path.iter().position(|&c| c == 0).unwrap_or(path.len());
    let picked = String::from_utf16_lossy(&path[..len]);
    if picked.is_empty() { None } else { Some(picked) }
}

// ── Commands ────────────────────────────────────────────────────────────────

/// Shape plus existence check for the shortcut form, before anything saves.
#[tauri::command]
pub fn tools_validate_target(kind: String, target: String) -> Result<(), String> {
    validate_target(&kind, &target)
}

/// Launches one saved executable directly: no arguments, no shell string.
#[tauri::command]
pub fn tools_launch_app(target: String) -> Result<(), String> {
    launch_app_native(&target)
}

/// Opens one saved folder through the platform file manager.
#[tauri::command]
pub fn tools_open_folder(target: String) -> Result<(), String> {
    open_folder_native(&target)
}

/// Runs a routine's resolved steps in order. Refused while another routine
/// runs; stops after the first failure; honours tools_routine_cancel before
/// each step. Every step is revalidated at launch time.
#[tauri::command]
pub fn tools_routine_start(
    state: tauri::State<'_, RoutineState>,
    routine_id: String,
    steps: Vec<RoutineStep>,
) -> Result<Vec<StepResult>, String> {
    state.gate.try_begin(&routine_id)?;
    state.cancel.store(false, Ordering::SeqCst);
    if steps.is_empty() {
        state.gate.finish();
        return Err("This routine has no steps to run.".to_string());
    }
    let results = run_steps(&steps, &launch_step, &state.cancel);
    state.gate.finish();
    Ok(results)
}

/// Cancels the running routine before its next step. No routine running is
/// fine: the next run starts uncancelled either way.
#[tauri::command]
pub fn tools_routine_cancel(state: tauri::State<'_, RoutineState>) {
    state.cancel.store(true, Ordering::SeqCst);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;

    fn step(id: &str) -> RoutineStep {
        RoutineStep { id: id.to_string(), kind: "app".to_string(), target: "C:\\x.exe".to_string() }
    }

    #[test]
    fn invalid_colours_are_rejected_not_guessed() {
        for bad in ["", "#", "#12", "#1234", "#12345", "#1234567", "red", "gggggg", "#1ED75G",
            "##123456", "#12 3456", "#1ED760 "] {
            if bad == "#1ED760 " {
                assert_eq!(normalize_hex(bad), Some("#1ED760".to_string()));
                continue;
            }
            assert_eq!(normalize_hex(bad), None, "{bad:?} must be rejected");
        }
    }

    #[test]
    fn valid_colours_normalise_to_rrggbb() {
        assert_eq!(normalize_hex("#1ed760"), Some("#1ED760".to_string()));
        assert_eq!(normalize_hex("1ED760"), Some("#1ED760".to_string()));
        assert_eq!(normalize_hex("#abc"), Some("#AABBCC".to_string()));
        assert_eq!(normalize_hex("  #AbC  "), Some("#AABBCC".to_string()));
    }

    #[test]
    fn colour_history_dedupes_and_caps_at_24() {
        let mut colours: Vec<String> = Vec::new();
        colours = add_colour(&colours, "#1ED760").unwrap();
        colours = add_colour(&colours, "1ed760").unwrap();
        assert_eq!(colours, vec!["#1ED760".to_string()]);
        for i in 0..30 {
            colours = add_colour(&colours, &format!("#{i:06X}")).unwrap();
        }
        assert_eq!(colours.len(), MAX_COLOURS);
        assert_eq!(colours[0], "#00001D".to_string());
        assert!(!colours.iter().any(|c| c == "#1ED760"));
        // Re-adding an existing colour moves it to the front without doubling.
        let front = colours[5].clone();
        colours = add_colour(&colours, &front).unwrap();
        assert_eq!(colours.len(), MAX_COLOURS);
        assert_eq!(colours[0], front);
        assert_eq!(colours.iter().filter(|c| *c == &front).count(), 1);
    }

    #[test]
    fn removing_colours_matches_any_case() {
        let colours = vec!["#1ED760".to_string(), "#AABBCC".to_string()];
        assert_eq!(remove_colour(&colours, "#1ed760"), vec!["#AABBCC".to_string()]);
        assert_eq!(remove_colour(&colours, "#missing"), colours);
    }

    #[test]
    fn invalid_launch_targets_are_rejected() {
        assert!(validate_shortcut_shape("link", "C:\\x.exe").is_err());
        assert!(validate_shortcut_shape("app", "").is_err());
        assert!(validate_shortcut_shape("app", "relative\\app.exe").is_err());
        assert!(validate_shortcut_shape("app", "https://example.com/x.exe").is_err());
        assert!(validate_shortcut_shape("folder", "shell:AppsFolder").is_err());
        assert!(validate_shortcut_shape("app", "C:\\x\0.exe").is_err());
        #[cfg(windows)]
        {
            assert!(validate_shortcut_shape("app", "C:\\x.txt").is_err());
            assert!(validate_shortcut_shape("app", "C:\\x.lnk").is_err());
            assert!(validate_shortcut_shape("app", "C:\\x.exe").is_ok());
            assert!(validate_shortcut_shape("folder", "C:\\Windows").is_ok());
        }
    }

    #[test]
    fn missing_targets_report_actionable_errors() {
        let missing = if cfg!(windows) { "C:\\coucou-definitely-missing-9f3\\app.exe" } else { "/tmp/coucou-definitely-missing-9f3/app" };
        let err = check_target_exists("app", missing).unwrap_err();
        assert!(err.contains(missing), "names the target: {err}");
        assert!(err.contains("Pick the file again or remove this shortcut"), "says what to do: {err}");
        let err = check_target_exists("folder", missing).unwrap_err();
        assert!(err.contains("Pick the folder again or remove this shortcut"), "folder advice: {err}");
    }

    #[test]
    fn existing_file_and_dir_pass() {
        let dir = std::env::temp_dir().join(format!("coucou-tools-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("app.exe");
        std::fs::write(&file, b"x").unwrap();
        assert!(check_target_exists("folder", dir.to_str().unwrap()).is_ok());
        assert!(check_target_exists("app", file.to_str().unwrap()).is_ok());
        assert!(check_target_exists("app", dir.to_str().unwrap()).is_err());
        assert!(check_target_exists("folder", file.to_str().unwrap()).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn persistence_validation_keeps_valid_drops_invalid() {
        let data = ToolsData {
            version: TOOLS_VERSION,
            colours: vec!["#1ED760".to_string(), "nope".to_string(), "1ed760".to_string()],
            shortcuts: vec![
                ToolShortcut { id: "code".to_string(), name: " Code ".to_string(), kind: "app".to_string(), target: "C:\\t\\code.exe".to_string() },
                ToolShortcut { id: "code".to_string(), name: "Dupe".to_string(), kind: "app".to_string(), target: "C:\\t\\dupe.exe".to_string() },
                ToolShortcut { id: "Bad Id".to_string(), name: "x".to_string(), kind: "app".to_string(), target: "C:\\t\\x.exe".to_string() },
                ToolShortcut { id: "doc".to_string(), name: "x".to_string(), kind: "app".to_string(), target: "C:\\t\\x.txt".to_string() },
            ],
            routines: vec![
                ToolRoutine { id: "ship".to_string(), name: "Ship it".to_string(), steps: vec!["code".to_string()] },
                ToolRoutine { id: "broken".to_string(), name: "Broken".to_string(), steps: vec!["ghost".to_string()] },
                ToolRoutine { id: "empty".to_string(), name: "Empty".to_string(), steps: vec![] },
            ],
        };
        let clean = sanitize_data(data);
        assert_eq!(clean.colours, vec!["#1ED760".to_string()]);
        assert_eq!(clean.shortcuts.len(), 1);
        assert_eq!(clean.shortcuts[0].name, "Code");
        assert_eq!(clean.routines.len(), 1);
        assert_eq!(clean.routines[0].id, "ship");
    }

    #[test]
    fn unknown_versions_and_shapes_load_empty() {
        let mut future = ToolsData::default();
        future.version = 99;
        assert_eq!(sanitize_data(future), ToolsData::default());
        assert_eq!(sanitize_value(serde_json::json!({"nope": true})), ToolsData::default());
        assert_eq!(sanitize_value(serde_json::json!([1, 2])), ToolsData::default());
        // A missing version reads as v1 so older hand-written files still load.
        let legacy = sanitize_value(serde_json::json!({"colours": ["#abc"]}));
        assert_eq!(legacy.colours, vec!["#AABBCC".to_string()]);
    }

    #[test]
    fn routine_runs_in_order_and_stops_on_failure() {
        let order = Mutex::new(Vec::new());
        let launch = |_kind: &str, target: &str| -> Result<(), String> {
            order.lock().unwrap().push(target.to_string());
            if target == "bad" { Err("Target not found: \"bad\".".to_string()) } else { Ok(()) }
        };
        let steps = vec![
            RoutineStep { id: "a".to_string(), kind: "app".to_string(), target: "one".to_string() },
            RoutineStep { id: "b".to_string(), kind: "app".to_string(), target: "bad".to_string() },
            RoutineStep { id: "c".to_string(), kind: "app".to_string(), target: "three".to_string() },
        ];
        let results = run_steps(&steps, &launch, &AtomicBool::new(false));
        assert_eq!(order.lock().unwrap().as_slice(), &["one".to_string(), "bad".to_string()]);
        let statuses: Vec<&str> = results.iter().map(|r| r.status.as_str()).collect();
        assert_eq!(statuses, vec!["ok", "failed", "skipped"]);
        assert!(results[1].message.contains("bad"));
    }

    #[test]
    fn routine_cancel_stops_before_the_next_step() {
        let cancel = AtomicBool::new(false);
        let launch = |_kind: &str, _target: &str| -> Result<(), String> {
            cancel.store(true, Ordering::SeqCst);
            Ok(())
        };
        let results = run_steps(&[step("a"), step("b"), step("c")], &launch, &cancel);
        let statuses: Vec<&str> = results.iter().map(|r| r.status.as_str()).collect();
        assert_eq!(statuses, vec!["ok", "cancelled", "cancelled"]);
    }

    #[test]
    fn gate_prevents_duplicate_concurrent_runs() {
        let gate = RoutineGate::default();
        assert!(gate.try_begin("ship").is_ok());
        assert_eq!(gate.current(), Some("ship".to_string()));
        let err = gate.try_begin("sync").unwrap_err();
        assert!(err.contains("already running"));
        gate.finish();
        assert!(gate.try_begin("sync").is_ok());
        gate.finish();
    }
}
