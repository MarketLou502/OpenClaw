# Native Calendar Notifications

## Architecture

`launchd` runs at minutes `00` and `30`. It invokes the deterministic
`scripts/calendar-notification-workflow.js`, which reads
`aaron@marketlou.com` and sends due notifications with OpenClaw's native
iMessage action to `chat_id:1`.

The workflow never invokes an LLM or raw `imsg`. It is the active launchd
program; the retired watcher and handler are archived outside the active
workspaces.

## Behavior

- Before 8 AM, no morning overview is sent.
- At the first run at or after 8 AM, a morning overview is sent only if the
  calendar contains at least one event.
- Timed events receive one reminder when they are 20–50 minutes away.
- All-day events appear in the morning overview but do not receive timed
  reminders.
- Exact case-insensitive routine titles are excluded from timed reminders:
  Guitar, Golf, Spanish, Study AI 900, Clean, and Workout/Run.
- A distinct title such as `Guitar lesson with Mike` is not excluded.
- A Google event can explicitly suppress notification by setting private
  extended property `openclawNoReminder=true`, or by explicitly setting no
  Google Calendar reminder overrides.
- Messages use native concise text such as `🌅 Today:` and
  `⏰ Dentist starts in ~30 min`; no agent signature is added.

## State and failure behavior

State is stored atomically in
`workspace-main/memory/calendar-notification-state.json`. On its first same-day
run it imports the old Daily Tracker state, preventing a cutover from repeating
the morning overview or an already-sent reminder.

A notification is marked complete only after OpenClaw returns successful
delivery. Explicit delivery failure remains retryable if it is still due. An
in-flight marker prevents an automatic duplicate when a process crashes after
delivery starts but before provider status is known. Logs are written under
`workspace-main/memory/calendar-notifications/`.

Configuration lives in `workspace-main/config/calendar-notifications.json`.

## Verification

```bash
node /Users/aaronmacmini/.openclaw/workspace-main/scripts/calendar-notification-workflow.test.js
node /Users/aaronmacmini/.openclaw/workspace-main/scripts/calendar-notification-workflow.js plan
```

`plan` reads the real calendar but never writes state or sends a message.

## Historical implementation

The former model-driven heartbeat and raw-iMessage watcher are preserved in
`archives/legacy-routing-2026-07-31/` for reference only. They are not a
supported production route and must not be loaded alongside this workflow.
