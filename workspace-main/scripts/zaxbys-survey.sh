#!/usr/bin/env bash
# Usage: zaxbys-survey.sh <SURVEY_CODE>
# Fills out the Zaxby's survey and prints a JSON result.
# Called by Clawd when Aaron texts a Zaxby's receipt photo.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/zaxbys-survey" && pwd)"
CODE="${1:-}"

if [[ -z "$CODE" ]]; then
  echo '{"success":false,"message":"No survey code provided."}'
  exit 1
fi

cd "$SCRIPT_DIR"
node run-survey.js "$CODE"
