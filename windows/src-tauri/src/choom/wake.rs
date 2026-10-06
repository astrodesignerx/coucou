// The wake strip's judgement calls: whether a wake is allowed right now, and
// how wide the strip may be. The dwell timer itself lives in the front end
// (windows/src/choom/wake.ts); this module is only consulted when it fires, so
// a hidden island still costs nothing.

use tauri::State;

use crate::settings::Settings;
use crate::Shared;

/// The settings window's strip-width range.
pub const MIN_STRIP_W: f64 = 120.0;
pub const MAX_STRIP_W: f64 = 600.0;

/// Full-screen notification states that keep the island hidden:
/// QUNS_BUSY (2), QUNS_RUNNING_D3D_FULL_SCREEN (3) and
/// QUNS_PRESENTATION_MODE (4) from SHQueryUserNotificationState.
pub fn quiet_for(state: i32) -> bool {
    matches!(state, 2 | 3 | 4)
}

/// The wake strip width, clamped to the range the settings window offers. A
/// value from a hand-edited settings.json can never make the OS strip and the
/// strip the page draws disagree.
pub fn strip_width(settings: &Settings) -> f64 {
    let width = settings.wake_strip_width;
    if width.is_finite() {
        width.clamp(MIN_STRIP_W, MAX_STRIP_W)
    } else {
        crate::island::STRIP_W
    }
}

/// Whether the front end may wake the island. Called only when a dwell timer
/// fires, so this is the one place the full-screen check runs.
#[tauri::command]
pub fn wake_allowed(shared: State<Shared>) -> bool {
    !shared.settings.lock().unwrap().wake_quiet_fullscreen || !quiet_now()
}

#[cfg(windows)]
fn quiet_now() -> bool {
    use ::windows::Win32::UI::Shell::SHQueryUserNotificationState;
    // A shell call that fails is not a reason to trap the island: allow the wake.
    match unsafe { SHQueryUserNotificationState() } {
        Ok(state) => quiet_for(state.0),
        Err(_) => false,
    }
}

#[cfg(not(windows))]
fn quiet_now() -> bool {
    // No such query on Linux: always allow the wake.
    false
}

#[cfg(test)]
mod tests {
    use super::{quiet_for, strip_width, MAX_STRIP_W, MIN_STRIP_W};
    use crate::settings::Settings;

    #[test]
    fn full_screen_states_stay_quiet() {
        // QUNS_BUSY, QUNS_RUNNING_D3D_FULL_SCREEN, QUNS_PRESENTATION_MODE.
        assert!(quiet_for(2));
        assert!(quiet_for(3));
        assert!(quiet_for(4));
        // QUNS_NOT_PRESENT, QUNS_ACCEPTS_NOTIFICATIONS, QUNS_QUIET_TIME, QUNS_APP.
        for state in [1, 5, 6, 7] {
            assert!(!quiet_for(state));
        }
    }

    #[test]
    fn strip_width_clamps_to_the_settings_window_range() {
        let mut settings = Settings::default();
        settings.wake_strip_width = 40.0;
        assert_eq!(strip_width(&settings), MIN_STRIP_W);
        settings.wake_strip_width = 900.0;
        assert_eq!(strip_width(&settings), MAX_STRIP_W);
        settings.wake_strip_width = 360.0;
        assert_eq!(strip_width(&settings), 360.0);
        settings.wake_strip_width = f64::NAN;
        assert_eq!(strip_width(&settings), crate::island::STRIP_W);
    }
}
