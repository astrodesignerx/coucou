// PC vitals and battery: native Windows counters plus the pure helpers the
// tests cover. Sampling stays in the frontend, which only samples while the
// island is visible and monitoring is enabled. The first CPU read only stores
// a baseline, so an initial sample reports unavailable, never zero. Unknown or
// failed reads report unavailable, never healthy. Linux returns unavailable
// rather than fabricated telemetry. Battery changes arrive over native power
// notifications, never a repeating hidden poll.

use serde::Serialize;

/// The Tauri event the island listens to for native battery changes.
#[cfg_attr(not(windows), allow(dead_code))]
pub const EVENT: &str = "battery";

/// One on-demand reading of total CPU and memory.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VitalsSnapshot {
    /// Total CPU usage since the previous call. None on the first call, which
    /// only stores a baseline, and None when the counters cannot be read.
    pub cpu_percent: Option<f64>,
    pub mem_used_bytes: u64,
    pub mem_total_bytes: u64,
    pub mem_percent: Option<f64>,
    /// Set when a counter could not be read. The affected field stays None.
    pub unavailable: Option<String>,
}

/// One on-demand reading of the system battery.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatterySnapshot {
    /// False when there is no battery, when the status is unknown, and when
    /// the API call itself failed. Read `state` and `error` to tell why.
    pub has_battery: bool,
    /// 0-100. None when Windows reports 255 (unknown) or has no battery.
    pub percent: Option<u8>,
    /// True while charging. None when Windows does not say.
    pub charging: Option<bool>,
    /// AC line state. None when Windows does not say.
    pub ac_online: Option<bool>,
    /// Estimated seconds left, when Windows supplies one.
    pub time_secs: Option<u64>,
    /// "charging", "discharging", "no_battery", "unknown", "error" or
    /// "unavailable" (non-Windows).
    pub state: String,
    /// Set only when the native call itself failed, never for no battery.
    pub error: Option<String>,
}

// Pure helpers.

/// CPU usage between two cumulative samples, in percent. None when the total
/// did not advance, so a zero delta never reads as zero usage.
pub fn cpu_usage_percent(
    prev_idle: u64,
    prev_total: u64,
    cur_idle: u64,
    cur_total: u64,
) -> Option<f64> {
    let total_delta = cur_total.saturating_sub(prev_total);
    let idle_delta = cur_idle.saturating_sub(prev_idle);
    if total_delta == 0 {
        return None;
    }
    let busy = total_delta.saturating_sub(idle_delta.min(total_delta));
    Some(busy as f64 / total_delta as f64 * 100.0)
}

/// Memory usage in percent. None without a total, so empty counters never
/// read as healthy zero usage.
pub fn mem_percent(used_bytes: u64, total_bytes: u64) -> Option<f64> {
    if total_bytes == 0 {
        return None;
    }
    Some(used_bytes.min(total_bytes) as f64 / total_bytes as f64 * 100.0)
}

/// Sorts raw power-status values into a snapshot. Kept pure so the no
/// battery, unknown and charging cases are unit tested on every platform.
/// `ac`: 0 off, 1 on, 255 unknown. `flag`: bit 3 charging, bit 7 no battery,
/// 255 unknown. `percent`: 0-100, 255 unknown. `lifetime`: seconds remaining,
/// u32::MAX when unknown.
pub fn classify_battery(ac: u8, flag: u8, percent: u8, lifetime: u32) -> BatterySnapshot {
    const NO_BATTERY: u8 = 128;
    const CHARGING: u8 = 8;
    const UNKNOWN: u8 = 255;
    const NO_TIME: u32 = u32::MAX;
    let blank = |state: &str| BatterySnapshot {
        has_battery: false,
        percent: None,
        charging: None,
        ac_online: None,
        time_secs: None,
        state: state.to_string(),
        error: None,
    };
    if ac == UNKNOWN && flag == UNKNOWN {
        return blank("unknown");
    }
    if flag != UNKNOWN && (flag & NO_BATTERY) != 0 {
        return blank("no_battery");
    }
    let has_battery = flag != UNKNOWN;
    let percent = if percent == UNKNOWN { None } else { Some(percent) };
    let charging = if flag == UNKNOWN {
        None
    } else {
        Some((flag & CHARGING) != 0)
    };
    let ac_online = match ac {
        0 => Some(false),
        1 => Some(true),
        _ => None,
    };
    let time_secs = if lifetime == NO_TIME {
        None
    } else {
        Some(lifetime as u64)
    };
    let state = if percent.is_none() {
        "unknown"
    } else if charging == Some(true) {
        "charging"
    } else if has_battery {
        "discharging"
    } else {
        "unknown"
    };
    BatterySnapshot {
        has_battery,
        percent,
        charging,
        ac_online,
        time_secs,
        state: state.to_string(),
        error: None,
    }
}

// Snapshots.

#[cfg(not(windows))]
fn unavailable_vitals(message: &str) -> VitalsSnapshot {
    VitalsSnapshot {
        cpu_percent: None,
        mem_used_bytes: 0,
        mem_total_bytes: 0,
        mem_percent: None,
        unavailable: Some(message.to_string()),
    }
}

#[cfg(not(windows))]
fn unavailable_battery() -> BatterySnapshot {
    BatterySnapshot {
        has_battery: false,
        percent: None,
        charging: None,
        ac_online: None,
        time_secs: None,
        state: "unavailable".to_string(),
        error: None,
    }
}

/// The previous CPU counters. The first call only stores them and reports no
/// percentage, which is the warmup the frontend shows as starting.
#[cfg(windows)]
static PREV_CPU: std::sync::OnceLock<std::sync::Mutex<Option<(u64, u64)>>> =
    std::sync::OnceLock::new();

#[cfg(windows)]
fn prev_cpu() -> &'static std::sync::Mutex<Option<(u64, u64)>> {
    PREV_CPU.get_or_init(|| std::sync::Mutex::new(None))
}

#[cfg(windows)]
fn read_cpu_times() -> Option<(u64, u64)> {
    use windows::Win32::Foundation::FILETIME;
    use windows::Win32::System::Threading::GetSystemTimes;
    let as_u64 = |ft: &FILETIME| ((ft.dwHighDateTime as u64) << 32) | (ft.dwLowDateTime as u64);
    unsafe {
        let mut idle = FILETIME::default();
        let mut kernel = FILETIME::default();
        let mut user = FILETIME::default();
        GetSystemTimes(Some(&mut idle), Some(&mut kernel), Some(&mut user)).ok()?;
        let idle_u = as_u64(&idle);
        let total = as_u64(&kernel).wrapping_add(as_u64(&user));
        Some((idle_u, total))
    }
}

#[cfg(windows)]
fn read_memory() -> Option<(u64, u64)> {
    use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    unsafe {
        let mut mem = MEMORYSTATUSEX::default();
        mem.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
        GlobalMemoryStatusEx(&mut mem).ok()?;
        if mem.ullTotalPhys == 0 {
            return None;
        }
        Some((mem.ullTotalPhys.saturating_sub(mem.ullAvailPhys), mem.ullTotalPhys))
    }
}

#[cfg(windows)]
fn read_battery() -> BatterySnapshot {
    use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
    unsafe {
        let mut status = std::mem::zeroed::<SYSTEM_POWER_STATUS>();
        match GetSystemPowerStatus(&mut status) {
            Ok(()) => classify_battery(
                status.ACLineStatus,
                status.BatteryFlag,
                status.BatteryLifePercent,
                status.BatteryLifeTime,
            ),
            Err(err) => BatterySnapshot {
                has_battery: false,
                percent: None,
                charging: None,
                ac_online: None,
                time_secs: None,
                state: "error".to_string(),
                error: Some(format!("Battery status failed: {err}")),
            },
        }
    }
}

/// Total CPU and memory right now. Called only while the island is visible,
/// from the frontend sampler, never on a hidden timer.
#[tauri::command]
pub fn vitals_snapshot() -> VitalsSnapshot {
    #[cfg(windows)]
    {
        let cpu_times = read_cpu_times();
        let cpu = match cpu_times {
            None => None,
            Some((idle, total)) => {
                let mut prev = prev_cpu().lock().unwrap();
                let usage = match *prev {
                    // Warmup: the baseline is stored, no percentage yet.
                    None => None,
                    Some((prev_idle, prev_total)) => {
                        cpu_usage_percent(prev_idle, prev_total, idle, total)
                    }
                };
                *prev = Some((idle, total));
                usage
            }
        };
        let (used, total, mem) = match read_memory() {
            Some((used, total)) => (used, total, mem_percent(used, total)),
            None => (0, 0, None),
        };
        let unavailable = match (&cpu, &mem) {
            (Some(_), Some(_)) => None,
            // Warmup and zero-delta reads are not failures.
            (None, Some(_)) if cpu_times.is_some() => None,
            (None, Some(_)) => Some("Could not read CPU counters.".to_string()),
            (None, None) if cpu_times.is_none() => {
                Some("Could not read system counters.".to_string())
            }
            (None, None) => Some("Could not read memory counters.".to_string()),
            (Some(_), None) => Some("Could not read memory counters.".to_string()),
        };
        VitalsSnapshot {
            cpu_percent: cpu,
            mem_used_bytes: used,
            mem_total_bytes: total,
            mem_percent: mem,
            unavailable,
        }
    }
    #[cfg(not(windows))]
    {
        unavailable_vitals("PC vitals are not available on this system.")
    }
}

/// Battery percentage, charging and AC state right now. On Windows this backs
/// the startup and visible-wake refresh; changes in between arrive over the
/// native power notification thread below.
#[tauri::command]
pub fn battery_snapshot() -> BatterySnapshot {
    #[cfg(windows)]
    {
        read_battery()
    }
    #[cfg(not(windows))]
    {
        unavailable_battery()
    }
}

// Native battery watcher.
// One thread owns a message-only window and blocks in GetMessageW, so a quiet
// machine costs nothing. RegisterPowerSettingNotification turns AC and
// percentage changes into WM_POWERBROADCAST, which is re-read and emitted.
// No polling anywhere: with no power change the thread never wakes.

/// Starts the battery watcher, unless monitoring is off. No-op off Windows.
pub fn start(app: tauri::AppHandle) {
    #[cfg(windows)]
    watch::start(app);
    #[cfg(not(windows))]
    {
        let _ = app;
    }
}

/// Tears the native observer down, or respawns it. Called when the battery
/// monitoring setting changes, so a disabled feature leaves no native
/// battery observer registered.
#[tauri::command]
pub fn set_battery_watching(app: tauri::AppHandle, enabled: bool) {
    #[cfg(windows)]
    watch::set_enabled(&app, enabled);
    #[cfg(not(windows))]
    {
        let _ = (app, enabled);
    }
}

/// Signals the watcher thread and joins it. Called on app exit.
pub fn shutdown(_app: &tauri::AppHandle) {
    #[cfg(windows)]
    watch::shutdown();
    #[cfg(not(windows))]
    {
        let _ = app;
    }
}

#[cfg(windows)]
mod watch {
    use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
    use std::sync::{Arc, Mutex};

    use tauri::{AppHandle, Emitter, Manager};
    use windows::core::{GUID, w};
    use windows::Win32::Foundation::{HANDLE, LPARAM, WPARAM};
    use windows::Win32::System::Power::{
        RegisterPowerSettingNotification, UnregisterPowerSettingNotification,
    };
    use windows::Win32::System::Threading::GetCurrentThreadId;
    use windows::Win32::UI::WindowsAndMessaging::*;

    /// Windows SDK power-setting identifiers. Fixed OS ABI values, listed
    /// here because the installed windows crate does not generate them.
    const GUID_ACDC_POWER_SOURCE: GUID = GUID::from_u128(0x5d3e9a59_e9d5_4b00_a6bd_ff34ff516548);
    const GUID_BATTERY_PERCENTAGE_REMAINING: GUID =
        GUID::from_u128(0xa7ad8041_b45a_4cae_87a3_eecbb468a9e8);

    pub struct Running {
        shutdown: Arc<AtomicBool>,
        thread_id: Arc<AtomicU32>,
        thread: std::thread::JoinHandle<()>,
    }

    pub struct Control {
        enabled: bool,
        running: Option<Running>,
    }

    impl Control {
        fn new() -> Self {
            Self { enabled: true, running: None }
        }
    }

    static CONTROL: std::sync::OnceLock<Mutex<Control>> = std::sync::OnceLock::new();

    fn control() -> &'static Mutex<Control> {
        CONTROL.get_or_init(|| Mutex::new(Control::new()))
    }

    fn spawn_locked(ctrl: &mut Control, app: &AppHandle) {
        if ctrl.running.is_some() {
            return;
        }
        let shutdown = Arc::new(AtomicBool::new(false));
        let thread_id = Arc::new(AtomicU32::new(0));
        let handle = app.clone();
        let down = shutdown.clone();
        let id = thread_id.clone();
        match std::thread::Builder::new()
            .name("coucou-battery".into())
            .spawn(move || run(handle, down, id))
        {
            Ok(thread) => {
                ctrl.running = Some(Running { shutdown, thread_id, thread });
            }
            Err(err) => crate::log::line(format!("battery watcher failed to start: {err}")),
        }
    }

    fn stop_locked(ctrl: &mut Control) {
        let Some(running) = ctrl.running.take() else {
            return;
        };
        running.shutdown.store(true, Ordering::Relaxed);
        // WM_QUIT to the watcher thread ends its blocking GetMessageW. Posted
        // to the thread, not the window, which is the only quit that works
        // across threads.
        let id = running.thread_id.load(Ordering::Relaxed);
        if id != 0 {
            unsafe {
                let _ = PostThreadMessageW(id, WM_QUIT, WPARAM(0), LPARAM(0));
            }
        }
        let _ = running.thread.join();
    }

    pub fn start(app: AppHandle) {
        let enabled = app
            .try_state::<crate::Shared>()
            .map(|shared| shared.settings.lock().unwrap().battery_monitor)
            .unwrap_or(true);
        let mut ctrl = control().lock().unwrap();
        ctrl.enabled = enabled;
        if enabled {
            spawn_locked(&mut ctrl, &app);
        }
    }

    /// Follows the battery monitoring setting at runtime. Disabling tears
    /// the window, its power registrations and its thread down, so no native
    /// battery observer remains. Enabling respawns them. Idempotent.
    pub fn set_enabled(app: &AppHandle, on: bool) {
        let mut ctrl = control().lock().unwrap();
        ctrl.enabled = on;
        if on {
            spawn_locked(&mut ctrl, app);
        } else {
            stop_locked(&mut ctrl);
        }
    }

    pub fn shutdown() {
        let mut ctrl = control().lock().unwrap();
        ctrl.enabled = false;
        stop_locked(&mut ctrl);
    }

    fn run(app: AppHandle, shutdown: Arc<AtomicBool>, thread_id: Arc<AtomicU32>) {
        if shutdown.load(Ordering::Relaxed) {
            return;
        }
        unsafe {
            // A message-only window is never visible and takes no input. The
            // built-in STATIC class already has a window procedure, so no
            // class of our own is registered.
            let hwnd = match CreateWindowExW(
                WINDOW_EX_STYLE::default(),
                w!("STATIC"),
                w!("coucou-battery"),
                WINDOW_STYLE::default(),
                0,
                0,
                0,
                0,
                Some(HWND_MESSAGE),
                None,
                None,
                None,
            ) {
                Ok(hwnd) => hwnd,
                Err(err) => {
                    crate::log::line(format!("battery watcher: no window: {err}"));
                    return;
                }
            };
            thread_id.store(GetCurrentThreadId(), Ordering::Relaxed);
            // Force the thread message queue into existence before any
            // shutdown post can race it.
            let mut probe = MSG::default();
            let _ = PeekMessageW(&mut probe, None, 0, 0, PM_NOREMOVE);
            if shutdown.load(Ordering::Relaxed) {
                let _ = DestroyWindow(hwnd);
                return;
            }
            let recipient = HANDLE(hwnd.0 as *mut core::ffi::c_void);
            let ac = RegisterPowerSettingNotification(
                recipient,
                &GUID_ACDC_POWER_SOURCE,
                DEVICE_NOTIFY_WINDOW_HANDLE,
            );
            let pct = RegisterPowerSettingNotification(
                recipient,
                &GUID_BATTERY_PERCENTAGE_REMAINING,
                DEVICE_NOTIFY_WINDOW_HANDLE,
            );
            if let Err(err) = &ac {
                crate::log::line(format!("battery watcher: no AC notice: {err}"));
            }
            if let Err(err) = &pct {
                crate::log::line(format!("battery watcher: no percentage notice: {err}"));
            }
            let mut msg = MSG::default();
            // Blocking wait: the thread wakes only on a real message. A
            // return of 0 is WM_QUIT; -1 is an error, never a message.
            loop {
                let ret = GetMessageW(&mut msg, None, 0, 0);
                if ret.0 == 0 {
                    break;
                }
                if ret.0 == -1 {
                    crate::log::line("battery watcher: message wait failed".to_string());
                    break;
                }
                if msg.message == WM_POWERBROADCAST
                    && (msg.wParam.0 == PBT_APMPOWERSTATUSCHANGE as usize
                        || msg.wParam.0 == PBT_POWERSETTINGCHANGE as usize)
                {
                    let snapshot = super::read_battery();
                    let _ = app.emit_to(crate::island::WINDOW_LABEL, super::EVENT, &snapshot);
                }
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            if let Ok(handle) = ac {
                let _ = UnregisterPowerSettingNotification(handle);
            }
            if let Ok(handle) = pct {
                let _ = UnregisterPowerSettingNotification(handle);
            }
            let _ = DestroyWindow(hwnd);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{classify_battery, cpu_usage_percent, mem_percent};

    #[test]
    fn cpu_usage_comes_from_the_deltas() {
        // 1000 ticks total, 50 idle: 95 percent busy.
        assert_eq!(cpu_usage_percent(100, 1000, 150, 2000), Some(95.0));
        // Idle took the whole delta: fully idle.
        assert_eq!(cpu_usage_percent(0, 0, 500, 500), Some(0.0));
    }

    #[test]
    fn cpu_without_advanced_total_is_unavailable_not_zero() {
        assert_eq!(cpu_usage_percent(100, 1000, 100, 1000), None);
        // Wrapped or reordered counters saturate instead of going negative.
        assert_eq!(cpu_usage_percent(900, 1000, 100, 2000), Some(100.0));
    }

    #[test]
    fn memory_percent_needs_a_total() {
        assert_eq!(mem_percent(8_000, 16_000), Some(50.0));
        assert_eq!(mem_percent(0, 16_000), Some(0.0));
        assert_eq!(mem_percent(0, 0), None);
        // A used value past the total clamps instead of reporting over 100.
        assert_eq!(mem_percent(20_000, 16_000), Some(100.0));
    }

    #[test]
    fn battery_names_the_absent_battery() {
        // Bit 7 set: no battery in the machine.
        let snap = classify_battery(1, 128, 255, u32::MAX);
        assert_eq!(snap.state, "no_battery");
        assert!(!snap.has_battery);
        assert_eq!(snap.percent, None);
        assert_eq!(snap.error, None);
    }

    #[test]
    fn battery_marks_unknown_values_unknown() {
        // Both identifiers unknown: nothing is claimed.
        let snap = classify_battery(255, 255, 255, u32::MAX);
        assert_eq!(snap.state, "unknown");
        assert!(!snap.has_battery);
        // Present battery, unknown percentage: unknown, not healthy.
        let snap = classify_battery(0, 1, 255, u32::MAX);
        assert!(snap.has_battery);
        assert_eq!(snap.state, "unknown");
        assert_eq!(snap.percent, None);
    }

    #[test]
    fn battery_reports_charging_and_time_when_supplied() {
        let snap = classify_battery(1, 8, 50, 3600);
        assert!(snap.has_battery);
        assert_eq!(snap.state, "charging");
        assert_eq!(snap.charging, Some(true));
        assert_eq!(snap.ac_online, Some(true));
        assert_eq!(snap.percent, Some(50));
        assert_eq!(snap.time_secs, Some(3600));
        // Unknown lifetime is no time, not zero time.
        let snap = classify_battery(0, 1, 80, u32::MAX);
        assert_eq!(snap.state, "discharging");
        assert_eq!(snap.charging, Some(false));
        assert_eq!(snap.time_secs, None);
    }
}
