# HEARTBEAT.md - Retired

Daily Tracker has no model-driven heartbeat and sends no proactive messages.

The active calendar notification schedule is owned by Main:

- `workspace-main/scripts/calendar-notification-workflow.js`
- `ai.openclaw.daily-tracker-heartbeat` launchd label
- Native OpenClaw iMessage delivery to Aaron's saved conversation

It sends a morning summary only when calendar events exist and one reminder
for eligible timed events roughly 30 minutes before they begin. Routine titles
and events explicitly marked as needing no reminder remain silent.

The retired model-driven heartbeat and inbound watcher are archived outside
this active workspace. Native iMessage belongs to the Gateway and Main.
