# TOOLS.md — Task Tracker Setup

## Aaron's Phone
- Native iMessage is owned by OpenClaw Gateway and Main at `chat_id:1`.
- Do not use raw `imsg send`; this agent has no direct messaging binding,
  including when composing a due-date check-in — you return text, the
  caller sends it.
- Active proactive delivery (calendar reminders + habit cues + due-date
  check-ins) is documented in
  `/Users/aaronmacmini/.openclaw/workspace-main/CALENDAR_NOTIFICATIONS.md`.

## Task boards, daily habits, lists

Your `exec` tool is scoped to your own workspace (`workspace-daily-tracker/`)
via `tools.fs.workspaceOnly: true`. Run the script in your own workspace:

```bash
node /Users/aaronmacmini/.openclaw/workspace-daily-tracker/scripts/dashboard-workflow.js list --board work
node /Users/aaronmacmini/.openclaw/workspace-daily-tracker/scripts/dashboard-workflow.js add --board personal --text "Call dentist"
node /Users/aaronmacmini/.openclaw/workspace-daily-tracker/scripts/dashboard-workflow.js complete --board work --query "report"
node /Users/aaronmacmini/.openclaw/workspace-daily-tracker/scripts/dashboard-workflow.js remove --board market-lou --query "old task"
node /Users/aaronmacmini/.openclaw/workspace-daily-tracker/scripts/dashboard-workflow.js schedule --board personal --query "dentist" --date 2026-08-04 --time 14:00
node /Users/aaronmacmini/.openclaw/workspace-daily-tracker/scripts/dashboard-workflow.js reschedule --board personal --query "dentist" --date 2026-08-05 --time 15:30
node /Users/aaronmacmini/.openclaw/workspace-daily-tracker/scripts/dashboard-workflow.js unschedule --board personal --query "dentist"
node /Users/aaronmacmini/.openclaw/workspace-daily-tracker/scripts/dashboard-workflow.js list-habits
node /Users/aaronmacmini/.openclaw/workspace-daily-tracker/scripts/dashboard-workflow.js complete-habit --query "Guitar"
node /Users/aaronmacmini/.openclaw/workspace-daily-tracker/scripts/dashboard-workflow.js complete-any --query "I just did X"
node /Users/aaronmacmini/.openclaw/workspace-daily-tracker/scripts/dashboard-workflow.js edit-estimate --board work --query "report" --blocks 8
node /Users/aaronmacmini/.openclaw/workspace-daily-tracker/scripts/dashboard-workflow.js log-progress --board work --query "report" --blocks 1.5
```

`--blocks` is a count of 30-min units (8 blocks = 4h). `edit-estimate` sets
or clears (`--blocks clear`) a task's total effort estimate — only
Work/Personal/Market Lou tasks, not grocery. `log-progress` records partial
progress toward that estimate (0.5-block increments ok, doesn't require the
task to be done) — this is what feeds `pacing.js`'s due-date math. See
`PACING.md`.

Only `work`, `personal`, and `market-lou` are boards you own (fixed board
names win even if Aaron calls them "lists"). Time must be on a 30-minute
boundary. The workflow returns JSON; use `reply` when `ok` is true. Return
`AMBIGUOUS_MATCH`, `NOT_FOUND`, stale-version, and backend failures honestly
instead of claiming success.

`complete-any --query "..."` searches both habits and tasks and returns
`AMBIGUOUS_MATCH` with every candidate if more than one open item matches —
use it instead of guessing when Main forwards ambiguous "I just did X"
phrasing.

The script also has `list-lists`/`show-list`/etc. commands for the Lists
overlay and grocery — those belong to the `lists`/`meal-planner` agents, not
you; don't invoke them.

Data is owned by Dashboard API. Do not edit these files directly:
- `tasks/work.json`, `tasks/personal.json`, `tasks/market-lou.json`
- `tasks/daily-habits.json`, `memory/today-habits.json`
- `memory/task-progress.json`, `memory/reassess-state.json`,
  `memory/pending-checkins.json` (owned by `pacing.js`/`reassess.js` and
  the delivery workflow, not Dashboard API, but same rule — never hand-edit)

## Google Calendar
Talks to the Google Calendar API directly (OAuth refresh token in `credentials/google-calendar.json`) — no macOS Calendar.app involved.

### Add a standalone event:
```bash
/Users/aaronmacmini/.openclaw/workspace-daily-tracker/scripts/cal-add.sh "<calendar>" "<title>" "<YYYY-MM-DDTHH:MM:SS>" <duration_minutes>
```

### Calendar name to use:
- `aaron@marketlou.com`
- This is Aaron's Google Calendar — the only one visible on his phone
- NEVER use `"Home"`, `"Work"`, or any other calendar name

### Examples:
```bash
/Users/aaronmacmini/.openclaw/workspace-daily-tracker/scripts/cal-add.sh "aaron@marketlou.com" "Anyconnect Migration" "$(date +%Y-%m-%dT%H:%M:%S)" 60
```

### Get current time for event scheduling:
```bash
date +%Y-%m-%dT%H:%M:%S
```

Task-linked due dates (Work/Personal/Market Lou) go through
`dashboard-workflow.js schedule`/`reschedule`/`unschedule` above, not
`cal-add.sh` directly — that keeps the task's calendar link intact.

## Cron Schedule

The launchd label `ai.openclaw.daily-tracker-heartbeat` runs Main's
deterministic `calendar-notification-workflow.js` at `:00` and `:30`. In one
run it (1) sends due calendar reminders/the morning overview, (2) drains
`memory/message-cues.json` — the habit heads-up texts `reassess.js` seeds —
and (3) calls `reassess.js` for due-date pacing check-ins. This agent has no
proactive-message trigger of its own and never calls `sendNativeIMessage`
directly, even for the check-ins it composes text for.

**Retired:** `ai.openclaw.daily-goal-scheduler` (fixed 7:30 AM habit
planner). Habit-slot-finding moved into `scripts/lib/slot-finder.js` and is
now called from `reassess.js` on the heartbeat above — same behavior, no
dedicated cron. See `archives/task-tracker-planner-2026-08-17/README.md`.
Manual preview/run of the reactive check:

```bash
node /Users/aaronmacmini/.openclaw/workspace-daily-tracker/scripts/reassess.js
node /Users/aaronmacmini/.openclaw/workspace-daily-tracker/scripts/pacing.js status
```

## Not this agent's job

Groceries, meal planning, and custom saved lists moved to `meal-planner` and
`lists` respectively. If a request about either reaches you, tell Main
rather than handling it — do not invoke `dashboard-workflow.js`'s
list/grocery subcommands yourself.
