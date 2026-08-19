#!/bin/bash
# Vanguard digest: reads the band snapshot Maestro mirrors to
# ~/.maestro/band-snapshot.json and messages Alex on Telegram.
#
# Two triggers, both idempotent across the 10-minute launchd interval:
#   1. Needs-you ping: the blocked set has sat unchanged for >10 minutes and
#      this exact set has not been pinged yet (dedupe via a hash marker).
#   2. Daily digest: once per day, in the 09:00 hour.
#
# Send path: direct Bot API sendMessage (plain text, no parse_mode; Telegram
# would reject unescaped titles as broken markup). Token is READ at runtime
# from the env file named in the config; never written anywhere. Fallback
# when the token is missing or the send fails: drop a message file into the
# IPC inbox (write-then-rename; its owner polls every second). NEVER call
# getUpdates here: the bot's own process owns that poll, a second reader
# steals its messages or 409s it.
#
# This repo is public, so the chat id and local paths live in a private
# config file, not here. Required keys: CHAT_ID. Optional: NANOCLAW_ENV
# (env file holding TELEGRAM_BOT_TOKEN), IPC_DIR (fallback inbox).
#
# Usage: [VANGUARD_CONF=<path>] vanguard-digest.sh [--dry-run]

set -euo pipefail

SNAPSHOT="$HOME/.maestro/band-snapshot.json"
STATE_DIR="$HOME/.maestro"
SEEN_MARKER="$STATE_DIR/digest-blocked-seen"   # "<hash> <epoch-first-seen>"
SENT_MARKER="$STATE_DIR/digest-blocked-sent"   # "<hash>" already pinged
DAILY_MARKER="$STATE_DIR/digest-daily-sent"    # "YYYY-MM-DD" already digested

CONF="${VANGUARD_CONF:-$HOME/.maestro/vanguard-digest.conf}"
if [ -f "$CONF" ]; then
  # shellcheck source=/dev/null
  . "$CONF"
fi
if [ -z "${CHAT_ID:-}" ]; then
  echo "vanguard-digest: CHAT_ID not set (expected in $CONF)" >&2
  exit 1
fi
NANOCLAW_ENV="${NANOCLAW_ENV:-}"
IPC_DIR="${IPC_DIR:-}"

STALE_AFTER_S=900   # writtenAt older than 15 min = app closed
BLOCKED_AFTER_S=600 # blocked set must sit 10 min before a ping

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1
SEND_SEQ=0 # per-run counter, disambiguates same-second IPC fallback files

[ -f "$SNAPSHOT" ] || exit 0 # app has never written a snapshot; nothing to say
mkdir -p "$STATE_DIR"

now_s=$(date +%s)
today=$(date +%F)
hour=$(date +%H)

# --- Freshness ---------------------------------------------------------------
written_at_ms=$(jq -r '.writtenAt // 0' "$SNAPSHOT")
written_at_ms=${written_at_ms:-0} # empty snapshot file: jq emits nothing
written_at_s=$((written_at_ms / 1000))
stale_suffix=""
if [ $((now_s - written_at_s)) -gt "$STALE_AFTER_S" ]; then
  stale_suffix=" (stale, app closed)"
fi

# --- Send helpers ------------------------------------------------------------
send_telegram() {
  # Primary: direct Bot API. Plain text on purpose, no parse_mode.
  local text="$1"
  local token
  # `|| true`: under pipefail a missing token line would otherwise kill the
  # whole script here, silently skipping the IPC fallback below.
  token=$(grep -E '^TELEGRAM_BOT_TOKEN=' "$NANOCLAW_ENV" 2>/dev/null | head -1 | cut -d= -f2- || true)
  if [ -n "$token" ]; then
    # --fail: without it curl exits 0 on a 400/401 body, the send would be
    # marked delivered, and the fallback built for exactly that never fires.
    # Belt and braces: also require Telegram's own `"ok":true`.
    local response
    if response=$(curl -sS --fail --max-time 15 \
      "https://api.telegram.org/bot${token}/sendMessage" \
      --data-urlencode "chat_id=${CHAT_ID}" \
      --data-urlencode "text=${text}" 2>/dev/null); then
      if [ "$(printf '%s' "$response" | jq -r '.ok // false')" = "true" ]; then
        return 0
      fi
    fi
  fi
  # Fallback: IPC inbox, write-then-rename so its 1s poll never reads a
  # half-written file.
  [ -n "$IPC_DIR" ] && [ -d "$IPC_DIR" ] || return 1
  # macOS date has no %N, so epoch+PID alone collides when one run sends both
  # a ping and the daily digest in the same second; the sequence breaks that.
  SEND_SEQ=$((SEND_SEQ + 1))
  local name
  name="vanguard-$(date +%s)-$$-${SEND_SEQ}.json"
  jq -n --arg jid "tg:${CHAT_ID}" --arg text "$text" \
    '{type: "message", chatJid: $jid, text: $text}' >"$IPC_DIR/.$name.tmp"
  mv "$IPC_DIR/.$name.tmp" "$IPC_DIR/$name"
}

send() {
  local text="$1"
  if [ "$DRY_RUN" = 1 ]; then
    printf -- '--- DRY RUN, would send ---\n%s\n---------------------------\n' "$text"
  else
    send_telegram "$text"
  fi
}

# --- Needs-you ping ----------------------------------------------------------
blocked_lines=$(jq -r '.blocked // [] | .[] | "• \(.label)" + (if .detail != "" then ": \(.detail)" else "" end)' "$SNAPSHOT")
blocked_count=$(jq -r '.blocked // [] | length' "$SNAPSHOT")
blocked_count=${blocked_count:-0}

if [ "$blocked_count" -gt 0 ]; then
  hash=$(printf '%s' "$blocked_lines" | shasum -a 256 | cut -d' ' -f1)
  seen_hash=""
  seen_at=0
  if [ -f "$SEEN_MARKER" ]; then
    read -r seen_hash seen_at <"$SEEN_MARKER" || true
  fi
  seen_at=${seen_at:-0}
  if [ "$seen_hash" != "$hash" ]; then
    # New blocked set: start its clock, ping on a later run if it survives.
    printf '%s %s\n' "$hash" "$now_s" >"$SEEN_MARKER.tmp"
    mv "$SEEN_MARKER.tmp" "$SEEN_MARKER"
  elif [ $((now_s - seen_at)) -ge "$BLOCKED_AFTER_S" ] &&
    [ "$(cat "$SENT_MARKER" 2>/dev/null)" != "$hash" ]; then
    send "Vanguard: ${blocked_count} thing(s) need you${stale_suffix}

${blocked_lines}"
    if [ "$DRY_RUN" = 0 ]; then
      printf '%s\n' "$hash" >"$SENT_MARKER.tmp"
      mv "$SENT_MARKER.tmp" "$SENT_MARKER"
    fi
  fi
else
  # Nothing blocked: clear the markers so the next block starts a fresh clock.
  rm -f "$SEEN_MARKER" "$SENT_MARKER"
fi

# --- Daily digest ------------------------------------------------------------
# "At or after 09:00" rather than "in the 09 hour": a laptop asleep through
# 09:xx still gets its digest on the first run after it wakes. 10# stops the
# leading zero being read as octal.
if [ "$((10#$hour))" -ge 9 ] && [ "$(cat "$DAILY_MARKER" 2>/dev/null)" != "$today" ]; then
  digest=$(jq -r --arg stale "$stale_suffix" '
    "Vanguard daily digest\($stale)",
    "Running: \(.runningCount // 0)",
    "Blocked: \(.blocked // [] | length)",
    (.blocked // [] | .[] | "• \(.label)" + (if .detail != "" then ": \(.detail)" else "" end)),
    "Landed: \(.landed // [] | length)",
    (.landed // [] | .[] | "• \(.label)" + (if .detail != "" then ": \(.detail)" else "" end)),
    (if .moreHandoffs > 0 then "Parked beyond the fold: \(.moreHandoffs)" else empty end)
  ' "$SNAPSHOT")
  send "$digest"
  if [ "$DRY_RUN" = 0 ]; then
    printf '%s\n' "$today" >"$DAILY_MARKER.tmp"
    mv "$DAILY_MARKER.tmp" "$DAILY_MARKER"
  fi
fi
