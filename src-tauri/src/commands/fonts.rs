//! Tauri commands for font detection.

use crate::core::{detect_available_fonts, is_font_available, AvailableFont};

/// Returns a list of available terminal-suitable fonts on the system.
///
/// Fonts are returned in priority order: Nerd Fonts first, then standard
/// monospace fonts. Each font includes metadata about whether it's a
/// Nerd Font variant.
///
/// `async` so Tauri runs it on the async runtime instead of inline on the
/// IPC/main thread: building the system font collection is heavy and this is
/// invoked during first paint.
#[tauri::command]
pub async fn get_available_fonts() -> Vec<AvailableFont> {
    detect_available_fonts()
}

/// Checks if a specific font family is available on the system.
///
/// This is useful for checking if a user's preferred font is installed
/// before attempting to use it.
///
/// `async` for the same reason as `get_available_fonts`: it builds the system
/// font collection, which must not run on the main thread.
#[tauri::command]
pub async fn check_font_available(family: String) -> bool {
    is_font_available(&family)
}
