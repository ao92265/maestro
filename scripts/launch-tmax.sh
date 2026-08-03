#!/usr/bin/env bash
set -euo pipefail

# Resolve the app root directory relative to this script's location.
# (The binary was renamed tmax -> maestro; the script keeps its old name.)
APP_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_BIN="$APP_ROOT/target/release/maestro"
LOG_FILE="/tmp/maestro-launch.log"
cd "$APP_ROOT"

# Work around WebKitGTK + NVIDIA GPU compositing performance issues.
# DMABuf renderer causes rendering glitches on multi-GPU NVIDIA systems.
# Compositing mode causes severe input lag due to slow GPU layer composition.
export WEBKIT_DISABLE_DMABUF_RENDERER="${WEBKIT_DISABLE_DMABUF_RENDERER:-1}"
export WEBKIT_DISABLE_COMPOSITING_MODE="${WEBKIT_DISABLE_COMPOSITING_MODE:-1}"

{
  echo "[$(date -Is)] launching maestro from ${APP_BIN}"
} >>"$LOG_FILE"

exec "$APP_BIN" >>"$LOG_FILE" 2>&1
