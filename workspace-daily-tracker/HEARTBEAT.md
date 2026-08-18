# HEARTBEAT.md - Retired

Task Tracker has no model-driven heartbeat and never decides on its own to
text Aaron. All proactive *sending* is deterministic and owned by Main:

- `workspace-main/scripts/calendar-notification-workflow.js`
- `ai.openclaw.daily-tracker-heartbeat` launchd label (`:00`/`:30`)
- Native OpenClaw iMessage delivery to Aaron's saved conversation

That one script/job does three things in the same run:
1. Sends a morning summary (only when calendar events exist) and one
   reminder for eligible timed events roughly 20–50 minutes before they
   begin. This covers standalone events and task-linked due dates alike.
2. Drains `memory/message-cues.json` — the sparse "coming up" heads-up
   texts `scripts/reassess.js` seeds for each daily habit (once per day,
   using `scripts/lib/slot-finder.js`). A cue is delivered once, within
   ~10 minutes of its scheduled time, and never re-sent.
3. Calls `scripts/reassess.js` for due-date pacing (see `AGENTS.md`/
   `PACING.md`). When a due-dated, estimated task's pacing status
   (`behind`/`at-risk`) warrants a check-in — gated so the same status
   never re-fires a message every 30 minutes — this workflow asks
   Task Tracker for a short, non-conversational compose-only turn (facts
   in, message text out), then sends the result itself.

**As of 2026-08-17, Task Tracker's model may be invoked outside a live user
turn** — for check-in composition (above) and for replies to those
check-ins, routed in by the `task-tracker-checkin-reply` plugin (an
`inbound_claim` hook, `plugins/task-tracker-checkin-reply/`) before Main's
normal routing sees the message. Both are compose-only: Task Tracker still
never calls `sendNativeIMessage` or any messaging tool — the deterministic
caller (the heartbeat workflow, or the plugin) does the actual send. This
is a narrow, deliberate exception to "no proactive messages itself" — the
*decision* to check in, and the *send*, both stay deterministic; only the
*wording* is now sometimes composed by the model.

Retired: the old `ai.openclaw.daily-goal-scheduler` launchd job (fixed
7:30 AM habit planner, `scripts/task-tracker-planner.js`) — see
`archives/task-tracker-planner-2026-08-17/README.md`. Its habit-cue
behavior was kept, just moved onto the reactive path above; nothing new
was added to launchd.

The legacy model-driven heartbeat and inbound watcher (pre-2026-07-31) are
archived outside this active workspace and must not be reactivated
alongside the native Gateway iMessage channel. Native iMessage belongs to
the Gateway and Main (plus the narrow check-in-reply carve-out above).
