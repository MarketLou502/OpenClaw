#!/bin/bash
# Whitelisted write operations for the nightly routing-QA job
# (systems-qa-nightly-routing-review). Writes are confined to systems-qa's
# own workspace directories only — never services/shared-routine-router/ or
# any other agent's files. Grammar/code changes are proposed here for human
# review; this script has no path that applies or commits them.
set -euo pipefail

WORKSPACE="/Users/aaronmacmini/.openclaw/workspace-systems-qa"
VOICE_FASTPATH_LOG="/Users/aaronmacmini/.openclaw/logs/voice-fastpath.jsonl"
mkdir -p "$WORKSPACE/proposed-diffs" "$WORKSPACE/memory" "$WORKSPACE/state"

op="${1:-}"
case "$op" in
  digest)
    # qa-propose.sh digest <YYYY-MM-DD> ; body read from stdin, appended.
    if [[ ! "${2:-}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
      echo "qa-propose.sh: digest requires a YYYY-MM-DD date arg" >&2
      exit 1
    fi
    cat >> "$WORKSPACE/memory/$2.md"
    ;;
  diff)
    # qa-propose.sh diff <slug> ; body read from stdin, written fresh.
    if [[ ! "${2:-}" =~ ^[A-Za-z0-9_-]+$ ]]; then
      echo "qa-propose.sh: diff requires an alnum/dash/underscore slug" >&2
      exit 1
    fi
    cat > "$WORKSPACE/proposed-diffs/$(date +%F)-$2.patch"
    ;;
  watermark)
    # qa-propose.sh watermark ; records this run completed cleanly. Stamps
    # the actual system clock rather than trusting a model-computed epoch-ms
    # value — an LLM asked to compute "now" as a raw number is exactly the
    # kind of arithmetic that silently comes out wrong (observed: off by
    # ~2 years on the first real run), and a wrong watermark defeats the
    # entire point of it, quietly, forever.
    echo "$(($(date +%s) * 1000))" > "$WORKSPACE/state/last_reviewed_at"
    ;;
  consume-voice-fastpath-log)
    # One narrow, named exception to "writes stay under our own workspace":
    # truncates the shared ha-voice-adapter capture log (never anything
    # else in it) so it stays bounded to ~1 day of traffic. Only call this
    # AFTER `digest` has succeeded for tonight — there is no undo, and
    # skipping this call on a failed run is what leaves data for tomorrow.
    : > "$VOICE_FASTPATH_LOG"
    ;;
  *)
    echo "qa-propose.sh: unknown or unsupported op: ${op:-<none>}" >&2
    echo "allowed: digest <YYYY-MM-DD> | diff <slug> | watermark | consume-voice-fastpath-log" >&2
    exit 1
    ;;
esac
