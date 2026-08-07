#!/bin/bash
set -uo pipefail

# Deterministic weekly OpenClaw update check. Never invokes an LLM/agent.
#
# Design note on "safe": `openclaw update --dry-run` only previews the
# planned action (target version, restart flow) — it does not actually
# attempt an install, so it cannot tell you whether an update would break
# anything. The real safety net is `openclaw update` itself: it stages the
# new package in a temp prefix, verifies it, and only swaps it into the live
# install if that verification passes — a broken/corrupt fetch never gets
# swapped in, so a failed run here leaves the previous version running
# untouched. That's what "if it breaks, stay on the current version" actually
# means in practice; there is no automatic rollback of a *successfully*
# installed-but-behaviorally-bad version, only of a failed install.
#
# Observed 2026-08-02: after a real update, the Gateway's LaunchAgent did not
# always come back up on its own and needed an explicit `gateway restart`.
# This script checks for that and remediates it, so a routine update never
# silently leaves the Gateway down for a week.

export PATH="/opt/homebrew/bin:/opt/homebrew/opt/node@22/bin:/usr/bin:/bin:/usr/sbin:/sbin"

LOG_DIR="/Users/aaronmacmini/Library/Logs/openclaw"
LOG_FILE="$LOG_DIR/weekly-update.log"
mkdir -p "$LOG_DIR"

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" >> "$LOG_FILE"; }

gateway_healthy() { lsof -i :18789 -sTCP:LISTEN >/dev/null 2>&1; }

log "=== weekly update check starting ==="

UPDATE_OUTPUT=$(npx --yes openclaw@latest update --yes --json 2>&1)
UPDATE_EXIT=$?

if [ "$UPDATE_EXIT" -ne 0 ]; then
  log "update FAILED (exit $UPDATE_EXIT) — staying on current version, nothing swapped in. Output tail:"
  printf '%s\n' "$UPDATE_OUTPUT" | tail -30 >> "$LOG_FILE"
  log "=== weekly update check finished (no change) ==="
  exit 0
fi

log "update command succeeded — verifying gateway health"
sleep 5

if gateway_healthy; then
  log "gateway healthy after update"
else
  log "gateway NOT listening after update — attempting explicit restart"
  RESTART_OUTPUT=$(npx --yes openclaw@latest gateway restart 2>&1)
  sleep 5
  if gateway_healthy; then
    log "gateway healthy after explicit restart"
  else
    log "gateway STILL not healthy after explicit restart — needs manual attention. Restart output tail:"
    printf '%s\n' "$RESTART_OUTPUT" | tail -30 >> "$LOG_FILE"
  fi
fi

log "=== weekly update check finished ==="
