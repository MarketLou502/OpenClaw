#!/bin/bash
# Thin shim, same pattern as cal-read.sh / cal-add.sh. Real logic is in
# cal-delete.js, which talks to the Google Calendar API directly.
exec /opt/homebrew/opt/node@22/bin/node "$(dirname "$0")/cal-delete.js" "$@"
