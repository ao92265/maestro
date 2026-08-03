#!/bin/bash
# Maestro CLI — launch Maestro from the terminal
# Usage: maestro [path]
#
# Examples:
#   maestro              # Launch/focus Maestro
#   maestro .            # Open current directory as a project
#   maestro /path/to/dir # Open a specific project path

resolve_path() {
    if [ -d "$1" ]; then
        (cd "$1" && pwd)
    else
        echo "$1"
    fi
}

launch_macos() {
    # Try bundle identifier first (most reliable)
    if open -b com.maestro.app "$@" 2>/dev/null; then
        return 0
    fi
    # Fall back to app name
    if open -a Maestro "$@" 2>/dev/null; then
        return 0
    fi
    echo "Error: Maestro.app not found. Is it installed?" >&2
    return 1
}

case "$(uname -s)" in
    Darwin)
        if [ -n "$1" ]; then
            PATH_ARG="$(resolve_path "$1")"
            # -n: force a second process. Without it, `open` merely focuses a
            # running app and --args is silently dropped — the second process
            # is what hands the path to the running instance via the
            # single-instance plugin.
            launch_macos -n --args "$PATH_ARG"
        else
            launch_macos
        fi
        ;;
    Linux)
        # Resolve the app binary: the cargo build produces `maestro`, the
        # bundled app `Maestro`. This CLI script is itself commonly installed
        # as `maestro`, so never launch our own path (infinite recursion).
        SELF_PATH="$(readlink -f "$0" 2>/dev/null || echo "$0")"
        if [ -z "$MAESTRO_BIN" ]; then
            for candidate in Maestro maestro; do
                RESOLVED="$(command -v "$candidate" 2>/dev/null || true)"
                if [ -n "$RESOLVED" ] && [ "$(readlink -f "$RESOLVED" 2>/dev/null || echo "$RESOLVED")" != "$SELF_PATH" ]; then
                    MAESTRO_BIN="$RESOLVED"
                    break
                fi
            done
        fi
        if [ -z "$MAESTRO_BIN" ]; then
            echo "Error: Maestro binary not found on PATH. Set MAESTRO_BIN to its location." >&2
            exit 1
        fi
        if [ -n "$1" ]; then
            PATH_ARG="$(resolve_path "$1")"
            "$MAESTRO_BIN" "$PATH_ARG" &
        else
            "$MAESTRO_BIN" &
        fi
        disown
        ;;
    MINGW*|MSYS*|CYGWIN*)
        if [ -n "$1" ]; then
            PATH_ARG="$(resolve_path "$1")"
            start "" "Maestro.exe" "$PATH_ARG"
        else
            start "" "Maestro.exe"
        fi
        ;;
    *)
        echo "Unsupported platform: $(uname -s)" >&2
        exit 1
        ;;
esac
