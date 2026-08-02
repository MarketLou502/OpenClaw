#!/bin/bash
# Thin shim so existing callers (server.js, heartbeat.js) that invoke this
# path via `/bin/bash <path>` keep working unchanged. Real logic is in
# cal-read.js, which talks to the Google Calendar API directly — no more
# macOS Calendar.app / AppleScript involved.
exec /opt/homebrew/opt/node@22/bin/node "$(dirname "$0")/cal-read.js" "$@"
