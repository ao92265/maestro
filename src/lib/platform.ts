/**
 * Detect whether the app is running on macOS (for platform-specific UI such as native traffic lights).
 */
export function isMac(): boolean {
  return navigator.platform.toLowerCase().includes("mac");
}

/**
 * Detect whether the app is running on Windows. Used to pick the quoting
 * rules for a command line typed into a session PTY (issue #158): the backend
 * spawns `COMSPEC` there on Windows and `$SHELL` everywhere else
 * (`process_manager::spawn_shell`), and the two families escape nothing alike.
 */
export function isWindows(): boolean {
  return navigator.platform.toLowerCase().startsWith("win");
}
