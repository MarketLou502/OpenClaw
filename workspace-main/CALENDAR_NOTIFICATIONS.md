# Native Calendar Notifications

## Architecture

`launchd` (label `ai.openclaw.daily-tracker-heartbeat`) runs at minutes `00`
and `30`. It invokes the deterministic `scripts/calendar-notification-workflow.js`,
which reads `aaron@marketlou.com` and sends due notifications with
OpenClaw's native iMessage action to `chat_id:1`. In the same run it also
drains Task Tracker's `workspace-daily-tracker/memory/message-cues.json`
queue (see "Habit cue delivery" below), and, since 2026-08-17, calls
`workspace-daily-tracker/scripts/reassess.js` for due-date pacing check-ins
(see "Due-date pacing check-ins" below).

The workflow itself never invokes an LLM or raw `imsg` for calendar
reminders or cue delivery. As of 2026-08-17 it is the ONE place that calls
out to an LLM at all — narrowly, to ask `task-tracker` to compose a
due-date check-in's message text (never to decide whether to send, and
never to send directly). It is the active launchd program; the retired
watcher and handler are archived outside the active workspaces.

**2026-08-10 note:** this job's launchd plist had drifted stale (pointed at
a retired script, `heartbeat.js`, that no longer exists) and was not
actually loaded — calendar reminders and the morning overview were not
being delivered despite this doc describing them as active. Fixed as part
of the Task Tracker merge: a correct plist now points at
`calendar-notification-workflow.js` directly. See
`plans/TaskTracker_Unified_Agent_Design.md` §10 decision #4.

## Behavior — calendar reminders

- Before 8 AM, no morning overview is sent.
- At the first run at or after 8 AM, a morning overview is sent only if the
  calendar contains at least one event.
- Timed events receive one reminder when they are 20–50 minutes away. This
  covers standalone events and task-linked due-date events alike.
- All-day events appear in the morning overview but do not receive timed
  reminders.
- Exact case-insensitive routine titles are excluded from timed reminders
  (see `config/calendar-notifications.json`'s `noReminderTitles`). These
  titles no longer appear as calendar events at all since the daily habits
  moved off-calendar on 2026-08-10 — this exclusion list is now a no-op
  safety net, not load-bearing, and isn't kept in sync with
  `tasks/daily-habits.json` for that reason.
- A distinct title such as `Guitar lesson with Mike` is not excluded.
- A Google event can explicitly suppress notification by setting private
  extended property `openclawNoReminder=true`, or by explicitly setting no
  Google Calendar reminder overrides.
- Messages use native concise text such as `🌅 Today:` and
  `⏰ Dentist starts in ~30 min`; no agent signature is added.

## Behavior — habit cue delivery (added 2026-08-10, re-triggered 2026-08-17)

`workspace-daily-tracker/scripts/reassess.js` (called each heartbeat run,
no cron of its own — see "Due-date pacing check-ins" below) seeds today's
habit cues once per day if not already done, using the same free-slot
bin-packing logic as the retired `task-tracker-planner.js`
(`workspace-daily-tracker/scripts/lib/slot-finder.js`, extracted
unchanged) — finds a free 30-minute slot for each unfinished daily habit
and writes a `pending` cue to `message-cues.json` instead of creating a
calendar event. Each run of this workflow:

- Reads today's `message-cues.json`.
- Delivers any `pending`/`retry` cue whose `deliverAt` is within the next
  ~10 minutes or already past due.
- Flips it to `sent` on successful delivery. A cue is never re-sent once
  `sent`. `dropped` cues (habit completed or replanned out of the window)
  are never delivered.
- A habit's due-dated task reminders (if any) are unaffected — this is a
  separate queue only for the daily habits, so the same item is never
  double-texted from both paths.

## Behavior — due-date pacing check-ins (added 2026-08-17)

Replaces the retired `ai.openclaw.daily-goal-scheduler` 7:30 AM cron for
anything beyond habit cues (see `archives/task-tracker-planner-2026-08-17/README.md`).
Each heartbeat run, `reassess.js` computes pacing for every Work/Personal/
Market Lou task that has both a due date and an `estimatedBlocks` effort
estimate (`workspace-daily-tracker/scripts/pacing.js` — full model in
`workspace-daily-tracker/PACING.md`) and decides whether any task's status
(`behind`/`at-risk`) warrants a check-in, gated so the same status doesn't
re-fire a message every 30 minutes.

When one is warranted, this workflow calls `task-tracker` for a short,
non-conversational, compose-only turn (`workspace-main/scripts/lib/agent-turn.js`,
a non-delivering `openclaw agent` CLI call) to get message text, falls back
to a plain deterministic template on compose failure/timeout, and sends
the result via the same `sendNativeIMessage()` used for calendar
reminders. It records a correlation entry in
`workspace-daily-tracker/memory/pending-checkins.json` so a later reply can
be matched back to it (see "Replies" below). State is only committed as
"notified" after delivery is confirmed — a failed send leaves the task's
pacing status untouched so the next tick retries it.

### Replies

`plugins/task-tracker-checkin-reply/` (an `inbound_claim` hook, registered
in `openclaw.json`'s `plugins.load.paths`/`plugins.entries`) intercepts an
inbound iMessage reply against the pending-checkins ledger before Main's
normal routing sees it, and routes a match to `task-tracker` for a
compose-only reply turn. This is a new, purpose-built hook — explicitly
not a reactivation of the legacy watcher below, and does not conflict with
it since it runs entirely through the same native Gateway `inbound_claim`
mechanism `shared-routine-router` already uses in production.

## State and failure behavior

Calendar-reminder state is stored atomically in
`workspace-main/memory/calendar-notification-state.json`. On its first
same-day run it imports the old Daily Tracker state, preventing a cutover
from repeating the morning overview or an already-sent reminder. Habit-cue
state lives directly in `message-cues.json`'s per-cue `status` field —
there is no separate state file for cues.

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
node /Users/aaronmacmini/.openclaw/workspace-main/scripts/calendar-notification-workflow.js checkins-dry-run
```

`plan` reads the real calendar (and today's `message-cues.json`) but never
writes state or sends a message. `checkins-dry-run` runs `reassess.js` and,
for any warranted check-in, calls `task-tracker` to compose the text and
logs it instead of sending — the way to test the compose path end-to-end
without texting Aaron.

## Historical implementation

The former model-driven heartbeat and raw-iMessage watcher are preserved in
`archives/legacy-routing-2026-07-31/` for reference only. They are not a
supported production route and must not be loaded alongside this workflow.
