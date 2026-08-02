# Current OpenClaw Architecture

Last updated: 2026-08-01

## User-facing routes

1. Native iMessage → OpenClaw Gateway (port 18789) → Main → native
   Gateway reply to the originating iMessage thread.
2. Home Assistant Voice PE → voice adapter → deterministic fast path
   (for narrow, frequent commands) or isolated Main session → spoken
   response through Home Assistant. Unmatched requests always go to Main;
   the adapter does not act as a second general-purpose assistant. Voice Main
   turns use the local MLX backend for latency while retaining Main's identity,
   context, tools, and conversation ownership.
3. OpenClaw Control UI → Main.
4. Sports Betting Discord account → Sports Betting agent. This is the only
   active Discord account and binding.

Main can also open allowlisted apps on the Echo Show through paired wireless
ADB. Spotify is the initial allowlisted app; conversational input cannot supply
arbitrary Android packages or shell commands.

The adapter handles routine dashboard language programmatically before Main:
reading, adding, completing, and removing fixed-board items; reading and
completing daily habits; and reading, creating, renaming, deleting, and
updating custom lists. These routes call the existing deterministic workflows,
which remain the only writers and retain their unique-match safety checks.

## Internal work

- Main owns the conversation and delegates health work to Health Tracker.
- Daily Tracker is an internal task/calendar specialist with no channel binding.
- Daily Tracker's deterministic goal scheduler places unfinished daily habits
  into open 30-minute calendar blocks from 8:00 AM to 5:00 PM each day.
- The dashboard's general Lists library is independent from Daily Goals. It
  reads and writes Daily Tracker's extensible `tasks/lists.json` store
  through dashboard-api; Main has deterministic commands for list and item
  creation, editing, completion, and removal.
- Deterministic calendar, dashboard, health, finance-spend/review, and Zaxby's
  workflows update their existing stores/services; the Echo dashboard reads
  those services and files.
- Proactive calendar and hourly-workout messages use the native Gateway
  iMessage action. There is no raw iMessage watcher.

## Secrets

OpenRouter is still active. `openclaw.json` references environment variables;
the actual OpenRouter key and retained Sports Betting token are stored in the
private, mode-600 `~/.openclaw/.env` file.

## Archives

- FBB recovery archive: `archives/fbb-agent-2026-07-31/`
- Retired raw-iMessage routing archive:
  `archives/legacy-routing-2026-07-31/`

FBB is not active. Its old Discord token is intentionally not stored in its
restore manifest; restoring FBB requires a newly issued token and an explicit
agent/account/binding config change.
