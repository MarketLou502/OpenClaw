# PACING.md — Due-date pacing model

Added 2026-08-17, replacing the fixed 7:30 AM habit planner (retired —
see `archives/task-tracker-planner-2026-08-17/README.md`) with a
reactive, due-date-aware system. This is the reference for how it works;
`AGENTS.md`/`SOUL.md` summarize the agent-facing rules.

## Scope

Pacing pressure applies **only** to a task that has both:
1. A due date (`task.schedule.startsAt`, set via `dashboard-workflow.js
   schedule`/`reschedule`, or the kiosk's due-date picker), and
2. An effort estimate (`task.estimatedBlocks`, an integer count of 30-min
   blocks, set via `dashboard-workflow.js edit-estimate` or the kiosk's
   estimate dropdown next to the due-date picker).

A task missing either field gets `null` pacing — no pressure, no
check-ins. This is the same distinction Aaron drew explicitly: due-dated,
estimated tasks are "more important," everything else stays a plain to-do.

`estimatedBlocks` is a **planning** concept (total effort for the whole
task). `task.schedule.durationMinutes` is a **scheduling** concept (the
size of one calendar work-session, always 30 min today). These are
deliberately separate fields — a 6-hour task (`estimatedBlocks: 12`) still
only ever gets one 30-min calendar event per work session.

The kiosk's dropdown (and `edit-estimate --blocks`) caps at 24 blocks / 12
hours — Aaron's explicit call: a task that would need more than that should
be split into more than one task, not estimated as a single block.

## The math

For a task with `estimatedBlocks` blocks total, due on `dueDate`:

```
totalLogged        = sum of all progress entries logged for this task
blocksRemaining     = max(estimatedBlocks - totalLogged, 0)
daysRemaining       = max(days from today to dueDate, 1)   # due today still gets a target
targetBlocksPerDay  = blocksRemaining / daysRemaining
```

`targetBlocksPerDay` is recomputed fresh every run — there's no separate
"did Aaron miss a day" detection. If yesterday had no progress logged,
`daysRemaining` shrank by one and `blocksRemaining` didn't, so
`targetBlocksPerDay` rises on its own. That's the whole "behind schedule,
do a bit more today" mechanic.

`flatPacePerDay` is the pace the task would have needed if worked evenly
since it was created (`estimatedBlocks / days from creation to due date`)
— used only as the baseline `targetBlocksPerDay` is compared against to
decide `behind` vs `on-track`.

### Status

- **`at-risk`** — `daysRemaining <= 1` and more than 1 block remains
  (can't realistically finish today alone).
- **`behind`** — today's required pace is more than 25% above the flat
  pace the task would have needed if worked evenly from the start.
- **`on-track`** — everything else.

## Logging progress

`dashboard-workflow.js log-progress --board B --query "task" --blocks N`
(0.5 increments allowed) appends to `memory/task-progress.json` — an
append-only log, multiple entries per day are summed, not overwritten, so
more than one check-in in a day can each log partial progress without
clobbering an earlier entry. Progress does not require marking the task
done; a task accumulates progress across many sessions before completion.

## Where it runs

`scripts/pacing.js` — pure computation + the progress log, no cron of its
own, called on demand (`computeAllPacing()`, or `node pacing.js status`
from the CLI).

`scripts/reassess.js` — called from Main's existing `:00`/`:30` heartbeat
(`calendar-notification-workflow.js`), not a new schedule. Two jobs each
run: seed today's habit cues once/day (unrelated to pacing, folded in from
the retired planner), and decide whether any task's pacing status warrants
a check-in — gated via `memory/reassess-state.json` so the same status
never re-fires a message every 30 minutes, only a real transition or a
once-a-day cap does.

**Why a heartbeat and not "fully reactive"**: task mutations (due date set,
estimate set) get picked up next time the heartbeat runs, or on the next
turn Task Tracker handles for Aaron directly — but "a day passed with no
progress" is inherently something only a recurring check can notice.
Rather than add a new cron for that, `reassess.js` piggybacks on the
heartbeat that's already running every 30 minutes for calendar reminders
and habit cues.

## One conversation at a time

Aaron's explicit ask: this should never feel like a task-list dump. Rules,
enforced in `reassess.js`:

- **At most one open check-in at a time.** If multiple tasks become
  eligible in the same run, only the most urgent (`pacing.js`'s own sort
  order) gets a check-in — the others wait their turn and are NOT marked
  "handled" internally, so they're still eligible once the open thread
  closes (replied, or aged out past `CHECKIN_EXPIRY_HOURS` in
  `pending-checkins.json`).
- **A different task's open thread blocks a new one from starting.** Even
  a more urgent task waits.
- **Silence gets one gentle follow-up, not a new topic.** If Aaron hasn't
  replied within `FOLLOWUP_AFTER_MS` (~2 hours), the next run proposes a
  single follow-up on the SAME task rather than starting a new one or
  repeating the ask. `recordPendingCheckin` supersedes the prior open
  entry for that task first, so a later reply is never seen as ambiguous
  against two entries about the same thing.
- **"I didn't get to it" is a valid, expected answer.** The compose prompt
  tells `task-tracker` which of three situations it's in — a fresh
  check-in, a same-day recheck (already mentioned today, keep it brief),
  or a follow-up after silence — and to accept honesty plainly: no guilt,
  no re-asking, just move on. He's human; not everything gets done on
  schedule every time.

## Compose/send split

`reassess.js` only decides *whether* a check-in is warranted — it never
composes text or sends anything. When one is warranted,
`calendar-notification-workflow.js` asks `task-tracker` (now on DeepSeek
V4 Flash) for a short, non-conversational, compose-only turn: structured
facts in, message text out. The workflow then sends that text itself via
the existing `sendNativeIMessage()` — same as calendar reminders. On
compose failure or timeout, a plain deterministic fallback template is
sent instead of silently skipping the check-in.

State is only committed as "notified" once delivery is confirmed —
if the actual send fails, the task's pacing status is left as it was, so
the next heartbeat tick treats it as still-pending and retries, rather
than silently losing that check-in.

## Replies

`plugins/task-tracker-checkin-reply/` claims an inbound iMessage reply
against `memory/pending-checkins.json` (correlation ledger, written when
a check-in is sent, entries expire after 24h) before Main's normal routing
sees it. One match → routed to `task-tracker` for a compose-only reply
turn (which may log progress via `dashboard-workflow.js log-progress`).
More than one match → still routed, with all candidates, so task-tracker
can ask which task he means. No match → falls through to Main unclaimed,
same as any other message. This is a new, purpose-built hook — not the
retired legacy inbound watcher (`archives/legacy-routing-2026-07-31/`),
which must never run alongside the native Gateway iMessage channel.
