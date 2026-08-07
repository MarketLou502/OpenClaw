# TOOLS.md — Scheduler Setup

## Aaron's Phone
- Native iMessage is owned by OpenClaw Gateway and Main at `chat_id:1`.
- Do not use raw `imsg send`; this agent has no direct messaging binding.
- Active proactive calendar delivery is documented in
  `/Users/aaronmacmini/.openclaw/workspace-main/CALENDAR_NOTIFICATIONS.md`.

## Google Calendar
Talks to the Google Calendar API directly (OAuth refresh token in `credentials/google-calendar.json`) — no macOS Calendar.app involved.

### Add an event:
```bash
/Users/aaronmacmini/.openclaw/workspace-daily-tracker/scripts/cal-add.sh "<calendar>" "<title>" "<YYYY-MM-DDTHH:MM:SS>" <duration_minutes>
```

### Calendar name to use:
- `aaron@marketlou.com`
- This is Aaron's Google Calendar — the only one visible on his phone
- NEVER use `"Home"`, `"Work"`, or any other calendar name

### Examples:
```bash
# Block 30 min for guitar starting now
/Users/aaronmacmini/.openclaw/workspace-daily-tracker/scripts/cal-add.sh "aaron@marketlou.com" "Guitar Practice" "$(date +%Y-%m-%dT%H:%M:%S)" 30

# Block 60 min for work starting now
/Users/aaronmacmini/.openclaw/workspace-daily-tracker/scripts/cal-add.sh "aaron@marketlou.com" "Anyconnect Migration" "$(date +%Y-%m-%dT%H:%M:%S)" 60
```

### Get current time for event scheduling:
```bash
date +%Y-%m-%dT%H:%M:%S
```

## Cron Schedule
The launchd label `ai.openclaw.daily-tracker-heartbeat` runs Main's
deterministic calendar-notification workflow at `:00` and `:30`. This agent has
no inbound-message watcher or proactive-message trigger.

The launchd label `ai.openclaw.daily-goal-scheduler` runs at 7:30 AM daily.
It schedules unfinished habits (definitions owned by the `goals` agent) into
conflict-free 30-minute blocks from 8:00 AM through 5:00 PM. Manual
preview/run:

```bash
node /Users/aaronmacmini/.openclaw/workspace-daily-tracker/scripts/daily-goal-scheduler.js plan
node /Users/aaronmacmini/.openclaw/workspace-daily-tracker/scripts/daily-goal-scheduler.js run
```

## Not this agent's job anymore

Task boards, groceries, custom lists, and daily-habit completion moved to
`boards`, `meal-planner`, `lists`, and `goals` respectively on 2026-08-02. If a
request about any of those reaches you, tell Main rather than handling it —
do not invoke `dashboard-workflow.js` yourself for non-calendar operations.
