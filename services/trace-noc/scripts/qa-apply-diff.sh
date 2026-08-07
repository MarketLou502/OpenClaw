#!/bin/bash
# Apply a proposed QA grammar diff to the shared-routine-router with
# automated validation and rollback. Called by the QA Agent Dashboard server when
# the user approves a diff via the Fast Router Proposals tab.
#
# Usage: qa-apply-diff.sh <slug>
#
# The slug must match a file at workspace-systems-qa/proposed-diffs/<date>-<slug>.patch.
# The script will:
#   1. Parse the patch to determine which grammar file(s) it targets
#   2. Create a backup of the target file(s)
#   3. Apply the patch (quietly, with -p1)
#   4. Run the test suite (node --test index.test.js)
#   5. If tests pass, mark the diff as applied
#   6. If tests fail, roll back the change
set -euo pipefail

ROOT="/Users/aaronmacmini/.openclaw"
QA_WORKSPACE="$ROOT/workspace-systems-qa"
ROUTER_DIR="$ROOT/services/shared-routine-router"
PROPOSED_DIR="$QA_WORKSPACE/proposed-diffs"
APPLIED_DIR="$QA_WORKSPACE/applied-diffs"
STATE_DIR="$QA_WORKSPACE/state"

mkdir -p "$APPLIED_DIR" "$STATE_DIR"

slug="${1:-}"
if [[ -z "$slug" ]]; then
  echo '{"ok":false,"error":"Usage: qa-apply-diff.sh <slug>"}'
  exit 1
fi

# Find the patch file (any date prefix)
patch_file=$(ls "$PROPOSED_DIR/"*-"$slug.patch" 2>/dev/null | head -1)
if [[ -z "$patch_file" ]]; then
  echo "{\"ok\":false,\"error\":\"No patch file found for slug: $slug\"}"
  exit 1
fi

patch_basename=$(basename "$patch_file")

# Check if already applied
if [[ -f "$APPLIED_DIR/$patch_basename.applied" ]]; then
  echo "{\"ok\":false,\"error\":\"Diff $patch_basename has already been applied.\"}"
  exit 1
fi

# Parse the patch to find target files
# Patch format: --- a/path/to/file +++ b/path/to/file
target_files=()
while IFS= read -r line; do
  target_files+=("$(echo "$line" | sed 's|^--- a/||')")
done < <(grep '^--- a/' "$patch_file" || true)
if [[ ${#target_files[@]} -eq 0 ]]; then
  echo "{\"ok\":false,\"error\":\"Could not parse target files from patch.\"}"
  exit 1
fi

# Build parallel target/backup arrays (not an associative array — the system
# /bin/bash on macOS is 3.2, which predates `declare -A` and errors out with
# "declare: -A: invalid option" on every invocation; this was a latent bug
# that never surfaced until an automated caller actually hit this path).
backup_files=()
for target_file in "${target_files[@]}"; do
  full_path="$ROOT/$target_file"
  if [[ ! -f "$full_path" ]]; then
    echo "{\"ok\":false,\"error\":\"Target file does not exist: $full_path\"}"
    exit 1
  fi
  backup_file="$STATE_DIR/$(basename "$target_file").bak.$(date +%s)"
  cp "$full_path" "$backup_file"
  backup_files+=("$backup_file")
done

restore_backups() {
  for i in "${!target_files[@]}"; do
    backup="${backup_files[$i]}"
    if [[ -n "$backup" && -f "$backup" ]]; then
      cp "$backup" "$ROOT/${target_files[$i]}"
    fi
  done
}

# Apply the patch (quiet, -p1 strips the standard a/ b/ prefixes)
if ! (cd "$ROOT" && patch -s -p1 < "$patch_file" 2>/dev/null); then
  restore_backups
  echo "{\"ok\":false,\"error\":\"Failed to apply patch. Rolled back.\"}"
  exit 1
fi

# Clean up any stray reject files from failed attempts
rm -f "$ROOT/Oops.rej" 2>/dev/null || true

# Run the test suite. errexit is disabled around this call — otherwise a
# non-zero `node --test` exit would abort the script here (via `set -e`)
# before the rollback logic below ever runs, and the caller would just see a
# bare non-JSON exit instead of a clean {"ok":false,...} response.
set +e
test_output=$(cd "$ROUTER_DIR" && node --test index.test.js 2>&1)
test_exit_code=$?
set -e

if [[ "$test_exit_code" -eq 0 ]]; then
  # Tests pass — mark as applied
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) | $patch_basename | applied | tests passed" >> "$STATE_DIR/apply-log.txt"
  cp "$patch_file" "$APPLIED_DIR/$patch_basename.applied"
  for backup in "${backup_files[@]}"; do
    [[ -n "$backup" && -f "$backup" ]] && rm -f "$backup"
  done
  echo "{\"ok\":true,\"slug\":\"$slug\",\"patch\":\"$patch_basename\",\"testExitCode\":0,\"testOutput\":$(echo "$test_output" | head -20 | jq -Rs .)}"
else
  # Tests fail — rollback
  restore_backups
  for backup in "${backup_files[@]}"; do
    [[ -n "$backup" && -f "$backup" ]] && rm -f "$backup"
  done
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) | $patch_basename | rollback | tests failed" >> "$STATE_DIR/apply-log.txt"
  echo "{\"ok\":false,\"slug\":\"$slug\",\"patch\":\"$patch_basename\",\"testExitCode\":$test_exit_code,\"testOutput\":$(echo "$test_output" | tail -40 | jq -Rs .),\"error\":\"Tests failed after applying patch. Rolled back.\"}"
  exit 1
fi