#!/bin/bash
# Whitelisted read-only operations for the nightly routing-QA job
# (systems-qa-nightly-routing-review). systems-qa's exec tool is not denied
# at the config layer, so this script is the actual enforcement boundary:
# only the operations below are reachable, everything else is refused.
# Never used for writes — see qa-propose.sh for that half.
set -euo pipefail

ROOT="/Users/aaronmacmini/.openclaw"
SAFE_TOKEN='^[A-Za-z0-9_.-]+$'

require_safe_token() {
  if [[ ! "$1" =~ $SAFE_TOKEN ]]; then
    echo "qa-read.sh: unsafe or missing argument: ${1:-<none>}" >&2
    exit 1
  fi
}

op="${1:-}"
case "$op" in
  sessions-index)
    # Full sessionKey -> {sessionId, deliveryContext.channel, ...} index.
    cat "$ROOT/agents/main/sessions/sessions.json"
    ;;
  main-session)
    # qa-read.sh main-session <sessionId> <since-unix-ms>
    # Filtered server-side to type:message lines at/after <since-unix-ms> —
    # session files here run 1-6MB+; the whole point of the watermark is to
    # never require reading (or paying to reason over) history already
    # reviewed on a prior run.
    require_safe_token "${2:-}"
    if [[ ! "${3:-}" =~ ^[0-9]+$ ]]; then
      echo "qa-read.sh: main-session requires a numeric since-unix-ms as the third argument" >&2
      exit 1
    fi
    jq -c --argjson since "$3" \
      'select(.type == "message" and (.message.timestamp // 0) >= $since)' \
      "$ROOT/agents/main/sessions/$2.jsonl"
    ;;
  voice-fastpath-log)
    # Weather + router-dispatch voice turns captured by ha-voice-adapter.
    cat "$ROOT/logs/voice-fastpath.jsonl" 2>/dev/null || true
    ;;
  router-grammar)
    # qa-read.sh router-grammar <filename.yaml>
    require_safe_token "${2:-}"
    cat "$ROOT/services/shared-routine-router/sentences/en/$2"
    ;;
  food-entries-since)
    # qa-read.sh food-entries-since <unix_ms>
    # created_at is stored as an ISO8601 TEXT string, not an epoch number —
    # comparing it directly to an integer is a SQLite type-affinity trap:
    # TEXT always sorts greater than INTEGER regardless of value, so a
    # naive `created_at >= $ms` matches every row, every time, silently.
    # Convert the column to epoch-ms instead and compare numerically.
    if [[ ! "${2:-}" =~ ^[0-9]+$ ]]; then
      echo "qa-read.sh: food-entries-since requires a numeric unix-ms timestamp" >&2
      exit 1
    fi
    sqlite3 -json \
      "$ROOT/workspace-health-tracker/data/health-ledger.sqlite" \
      "SELECT original_text, origin_channel, conversation_id, created_at
       FROM food_entries
       WHERE CAST(strftime('%s', created_at) AS INTEGER) * 1000 >= $2
         AND origin_channel = 'voice-pe-kitchen'
       ORDER BY created_at;"
    ;;
  watermark)
    # Last successful run's watermark, if any.
    cat "$ROOT/workspace-systems-qa/state/last_reviewed_at" 2>/dev/null || echo "0"
    ;;
  *)
    echo "qa-read.sh: unknown or unsupported op: ${op:-<none>}" >&2
    echo "allowed: sessions-index | main-session <id> | voice-fastpath-log | router-grammar <file> | food-entries-since <ms> | watermark" >&2
    exit 1
    ;;
esac
