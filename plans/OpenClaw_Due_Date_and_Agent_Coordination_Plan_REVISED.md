# OpenClaw Due-Date Architecture and Delivery Plan — Revised Against Live Source

Date: August 3, 2026  
Status: Implemented and verified August 3, 2026

## 1. Recommendation

Implement task due-date scheduling as a dashboard-owned domain workflow. Keep
`dashboard-api` on port 18795 as the sole writer of task-board JSON, and have it
call the existing Google Calendar helper to create, update, and delete the
linked event.

Do **not** build a general agent command queue or memory bus as part of this
feature. OpenClaw already has working agent coordination through the Gateway's
allowlisted `sessions_send` path, and agents already invoke narrow,
deterministic workflows. A new coordination service would add a second task
delivery mechanism without being required for the requested dashboard flow.

Restore a dedicated Boards specialist for Work, Personal, and Market Lou. For
conversational scheduling, extend Boards and `dashboard-workflow.js` with typed
task-scheduling commands. Boards owns task-board intent and task-linked due-date
intent; `dashboard-api` performs the task/calendar transaction-like workflow.
Lists returns to saved lists only. The Scheduler specialist remains responsible
for ordinary calendar requests that are not linked to task-board records.

This agent split does not require the deterministic shared router to invoke an
agent. Fast-pathed commands should remain model-free and call the same narrow
workflow directly. The agent boundary applies to requests that reach Main and
need conversational interpretation or clarification.

## 2. Verified current state

### Source control

- Main OpenClaw repository: `Prod` and `origin/Prod` both point to `7269fa2`.
- Nested kiosk repository: `main` and `origin/main` both point to `3b89d4c`.
- Both repositories are `0` commits ahead and `0` behind after fetching.
- Neither GitHub repository represents the full live implementation:
  - The OpenClaw repository has extensive staged, unstaged, deleted, and
    untracked operational changes.
  - The nested `Computer` kiosk repository has four heavily modified files:
    `README.md`, `dashboard-web/index.html`, `dashboard-web/app.js`, and
    `dashboard-web/style.css`.
  - `services/trace-noc` is running while still untracked.

Feature implementation must not begin by resetting or replacing either working
tree. The current local files are the live source and must first be captured in
reviewable commits.

### Runtime

- Gateway: port 18789.
- Trace NOC: port 18790.
- Dashboard API and static dashboard host: port 18795.
- Home Assistant voice adapter: port 18796.
- Local MLX model server: port 8080.
- Whisper: port 10300.

The Dashboard API, voice adapter, shared router, Trace NOC, and Gateway process
start times are later than the modification times of the source/configuration
they currently load. No stale process or required restart was found during this
review.

Static files under `services/dashboard-api/public` are a symlink to the nested
kiosk repository and are read from disk on every request. Frontend edits need a
WebView/page reload, not a Dashboard API restart.

### Test baseline

The following live-source tests pass before feature work:

- `services/dashboard-api/calendar-dashboard-contract.test.js`
- `services/dashboard-api/sse-push-contract.test.js`
- `workspace-main/scripts/calendar-workflow.test.js`
- `workspace-main/scripts/dashboard-workflow.test.js`
- `workspace-daily-tracker/scripts/daily-goal-scheduler.test.js`

## 3. Corrections to the original proposal

| Proposal assumption | Live-source finding | Revised direction |
| --- | --- | --- |
| `handle-inbound.js` may be a competing iMessage writer/router | The active architecture has no raw iMessage watcher; Gateway owns human ingress | Do not add migration work for `handle-inbound.js` |
| Stable task IDs may need to be introduced | All task-board items already have random hexadecimal `id` values | Preserve existing IDs; no ID migration |
| Task versions may already exist | Individual task-board records do not have versions | Add a backward-compatible integer `version` per task |
| Calendar integration is unknown | Google Calendar API v3 helper already supports create/update/delete by event ID | Reuse and harden the existing helper |
| Calendar target is undecided | All current calendar workflows explicitly use `aaron@marketlou.com` | Use that calendar unless Aaron explicitly changes it |
| Timezone example uses Louisville | Runtime and calendar helper use `America/New_York` | Store and validate `America/New_York` |
| Dashboard relies on polling | Task mutations already broadcast over SSE; five-minute polling is a reconciliation net | Broadcast scheduled task state over the existing `tasks:<board>` topic |
| A new coordination service should be an implementation phase | Gateway delegation and narrow deterministic scripts already provide coordination | Defer the service; document typed workflow contracts instead |
| Browser may need a broad `GET /api/tasks` endpoint | The live UI loads one endpoint per fixed board | Keep the existing board-scoped contract unless a concrete client need emerges |
| Lists should continue owning both fixed boards and saved lists | That merge was made for semantic routing convenience, but due dates give task boards a distinct lifecycle and calendar relationship | Restore Boards; restrict Lists to saved lists |
| The shared router must select Boards versus Lists | The shared router currently executes `dashboard-workflow.js` directly and does not delegate to either agent | Keep fast paths direct; separate agent selection in Main's fallback routing |

## 4. Current ownership and intended boundaries

### Existing owners

- Gateway/Main owns user ingress and conversational routing.
- Lists specialist owns only user-created saved lists and their items.
- A restored Boards specialist owns Work, Personal, and Market Lou task intent,
  including task-linked scheduling, rescheduling, and unscheduling.
- Scheduler specialist owns standalone calendar reads and mutations.
- `dashboard-workflow.js` remains a shared deterministic client, with separate
  board and saved-list command families.
- `dashboard-api` is the sole writer of task-board JSON and broadcasts task SSE.
- `google-calendar.js` is the shared deterministic Google Calendar adapter.
- The kiosk frontend is a thin client of `dashboard-api`.

### Due-date ownership

- Kiosk UI requests a schedule change directly from `dashboard-api`.
- Conversational requests go Main → Boards → `dashboard-workflow.js` →
  `dashboard-api`.
- `dashboard-api` validates the task, calls Google Calendar, persists linkage,
  compensates partial failure, and broadcasts the resulting board state.
- Scheduler is not inserted between `dashboard-api` and Google Calendar. That
  would make a model-driven agent part of a deterministic consistency path.

The Boards agent does not become a second task or calendar writer. It interprets
the request, resolves ambiguity, and invokes the typed workflow. This is a small
architectural extension of the current single-writer design, not a new
coordination platform.

## 4.1 Restoring Boards safely

A complete pre-merge Boards workspace exists at:

`backups/2026-08-02-boards-lists-merge/workspace-boards`

Restore it into a live `workspace-boards` directory as a starting point, then
rewrite it for the current architecture. Do not copy it verbatim because it
contains stale references to the old Chef role, old tool-field guidance, and a
pre-due-date responsibility model.

The restored agent should have:

- No human channel binding.
- No proactive heartbeat or notifications.
- No direct JSON editing.
- No direct Google Calendar credentials or Calendar helper execution.
- Access only to the execution capability required to run the documented
  `dashboard-workflow.js` commands.
- The same outbound-message restrictions as other internal specialists.
- A dedicated agent directory and explicit inclusion in Main's allowlist and
  the Gateway's agent-to-agent allowlist.

Lists' workspace must be narrowed at the same time: remove board ownership,
board commands, board aliases, and `complete-any` responsibility that crosses
the task/habit boundary. Lists should only create, read, rename, edit, complete,
and delete saved lists and saved-list items.

## 5. Data model

Extend each existing task item without changing the board-file envelope:

```json
{
  "id": "1eeee5d9",
  "text": "Meeting with Rupesh",
  "done": false,
  "added": "2026-07-31",
  "doneDate": null,
  "version": 1,
  "schedule": {
    "startsAt": "2026-08-04T14:00:00-04:00",
    "durationMinutes": 30,
    "timezone": "America/New_York",
    "calendarId": "aaron@marketlou.com",
    "calendarEventId": "...",
    "status": "scheduled",
    "updatedAt": "2026-08-03T14:30:00.000Z"
  }
}
```

Rules:

- Missing `version` is interpreted as version `1` during rollout.
- Missing or `null` `schedule` means unscheduled.
- Every successful task mutation increments `version`, including completion.
- Existing fields and task IDs remain unchanged.
- Completed scheduled tasks retain their schedule metadata when swept into the
  existing history sidecar.
- Scheduling is allowed only for `work`, `personal`, and `market-lou`; grocery,
  daily goals, and saved-list items are excluded.

No eager rewrite of every task file is required. Normalize records when read
and persist new fields only when the item next changes, backed by a one-time
validation/migration command for explicit rollout verification.

## 6. API contract

Use the live board-scoped URL shape so task identity remains unambiguous:

| Method | Endpoint | Meaning |
| --- | --- | --- |
| `POST` | `/api/tasks/:board/:id/schedule` | Create and link the task's first event |
| `PATCH` | `/api/tasks/:board/:id/schedule` | Move the existing linked event |
| `DELETE` | `/api/tasks/:board/:id/schedule` | Remove the linked event and clear active schedule |

Example request:

```json
{
  "startsAt": "2026-08-04T14:00:00-04:00",
  "durationMinutes": 30,
  "timezone": "America/New_York",
  "expectedVersion": 1,
  "idempotencyKey": "5a3c..."
}
```

Responses return the complete updated task. Errors use explicit status codes:

- `400`: invalid date/time, duration, timezone, or payload.
- `404`: board or task not found.
- `409`: stale version, duplicate/conflicting schedule state, or task already
  changed during the operation.
- `502`: Google Calendar operation failed before task persistence.
- `500`: task persistence failed; response includes whether compensation
  succeeded and an audit/reconciliation identifier.

The existing `PATCH /api/tasks/:board/:id` completion route must stop coercing
every request to `{done}`. It should validate supported fields and use
`expectedVersion` when supplied. Scheduling remains on its dedicated endpoint.

## 7. Calendar consistency and idempotency

The existing helper already supports exact event mutation by Google event ID.
Extend it rather than invoking `cal-add.sh` or matching events by title.

Scheduling workflow:

1. Validate board, task ID, open task state, expected version, timezone, and
   30-minute increment.
2. Acquire an in-process operation guard for `board + task ID` so two requests
   cannot schedule the same task concurrently inside the sole writer.
3. Check a small durable operation journal by `idempotencyKey`.
4. Create the Google event with private extended properties identifying the
   OpenClaw board, task ID, and idempotency key.
5. Persist the returned event ID and schedule object with an atomic JSON rename.
6. Mark the journal operation succeeded.
7. Broadcast the updated board through `tasks:<board>`.
8. Return success only after the task record is durable.

If task persistence fails after event creation, attempt immediate deletion by
event ID and record whether compensation succeeded. A reconciliation command
must be able to inspect incomplete journal entries and either repair task
linkage or remove the orphan event. Do not make this a model-driven cron job.

Reschedule uses the stored `calendarEventId`; it never searches by task text.
Unschedule deletes by the stored ID and clears the active schedule only after
calendar deletion succeeds.

## 8. Completion policy recommendation

Recommended initial behavior: completing a scheduled task leaves the Google
Calendar event unchanged and preserves schedule metadata in task history.

Reasons:

- The event records what was planned and may already be in the past.
- Silent deletion would erase calendar history.
- Renaming the event to include completion status creates an unnecessary second
  failure path for the common completion action.

If Aaron later wants completion reflected in Calendar, implement that as an
explicit policy change with its own tests—not as an implicit side effect in
the first release.

## 9. Dashboard interaction

### Markup

In the existing top row, add a `Due Date` button immediately before the current
`Lists` button. Group them in a small controls container so both retain large
touch targets at the fixed 1280-pixel kiosk viewport.

Add one accessible modal/panel containing:

- Selected task title and board.
- Date input.
- Time selector restricted to 30-minute increments.
- Confirm, cancel-selection, and exit-mode actions.
- An inline error/status region.

### State machine

Use explicit states rather than a loose boolean:

- `idle`
- `selecting-task`
- `editing-schedule`
- `saving`
- `error`

Behavior:

- Pressing Due Date enters `selecting-task` and visibly activates the button.
- Only non-completed items in the three task columns gain scheduling-target
  behavior.
- The selection click must not call the existing completion handler.
- An unscheduled task opens create mode; a scheduled task opens reschedule mode.
- Closing the picker without confirmation returns to `selecting-task`.
- Explicitly exiting Due Date mode returns to `idle`.
- Success returns to `idle` and relies on the API response/SSE for canonical
  rendering.
- Failure keeps the task and entered values available for retry.
- While `saving`, disable duplicate submission.

### Rendering

- Add a non-color-only due label below task text using localized short date and
  time.
- Use a restrained light-red surface/accent with high-contrast text for every
  scheduled task, matching the original requested behavior.
- Do not display scheduling controls on completed items, grocery items, daily
  goals, or saved lists.
- Update embedded mock task data to include at least one scheduled task so the
  offline/demo state exercises the design.

### Layout

The current `.main-row` splits the calendar and `.tasks-row` evenly, while the
three task columns share the task half. Shift the calendar left by reallocating
width—not by physical inches or absolute positioning.

First pass: reduce the calendar share and increase `.tasks-row` by roughly 72
CSS pixels at the fixed 1280-pixel viewport. Verify the date label does not
truncate task text excessively. Preserve the existing desktop/fixed-kiosk
behavior and tune from a real Echo Show screenshot.

## 10. Conversational, router, and agent behavior

Add narrow commands to `dashboard-workflow.js`:

- `schedule --board ... --query ... --date ... --time ...`
- `reschedule --board ... --query ... --date ... --time ...`
- `unschedule --board ... --query ...`

The client resolves a unique open task using its existing exact/substring
matching safety behavior, then sends task ID and version to the API. It does not
call Calendar directly.

These task commands belong in Boards' tool documentation. Update Main's routing
text so task-board and task-linked due-date requests go to Boards, saved-list
requests go to Lists, and ordinary calendar requests continue to Scheduler.

Main's semantic rule should be:

- A named fixed board—Work, Personal, or Market Lou—always means Boards, even
  when Aaron calls it a "list," "task list," or "to-do list."
- A named user-created collection means Lists.
- "My lists," "create a list," and List-button/library requests mean Lists.
- A task due date, a task schedule, or "put this task on my calendar" means
  Boards.
- A calendar event with no task-board record means Scheduler.
- If a name could be both a saved list and a board alias, fixed board names win;
  otherwise the workflow returns ambiguity rather than guessing.

The shared router currently unifies named board and saved-list phrasing into
wildcard list intents, then lets `dashboard-workflow.js` resolve fixed board
aliases first. That behavior is already safe for fast paths and can remain
during the agent split. Add explicit due-date grammar only after collecting real
phrases and only if date/time extraction is deterministic. Do not route a fast
path through Boards merely to reflect ownership; doing so would add model
latency to a deterministic operation.

Add regression cases for at least:

- "Add X to my Work list" → Work board workflow.
- "What's on my Personal task list?" → Personal board workflow.
- "Add X to my Songs I Want to Learn list" → saved-list workflow.
- "Show my lists" → saved-list library.
- "Give X on my Market Lou list a due date" → Boards when handled by Main,
  and a typed board schedule workflow if later fast-pathed.
- An unknown named list → saved-list lookup, never defaulting to Personal.

No changes are required to agent-to-agent transport, Gateway bindings, passive
delivery-mirror behavior, or agent private memory.

## 11. Files expected to change

### Main OpenClaw repository

- `lib/taskstore.js`
  - Normalize versions/schedules; guarded task mutation; preserve schedule in
    history.
- `services/dashboard-api/server.js`
  - Schedule routes, validation, orchestration, SSE broadcast, and failure
    mapping.
- `workspace-daily-tracker/scripts/lib/google-calendar.js`
  - Extended properties/idempotency metadata and any lookup needed only for
    deterministic reconciliation.
- New dashboard API schedule contract test.
- New taskstore migration/version tests.
- `workspace-main/scripts/dashboard-workflow.js` and its tests.
- Restored and updated `workspace-boards/` instruction files.
- Narrowed `workspace-lists/AGENTS.md`, `SOUL.md`, `IDENTITY.md`, and `TOOLS.md`.
- `openclaw.json` for the Boards agent registration and allowlists.
- Main routing documentation and Home Assistant voice delegation prompt.
- Shared-router regression tests and, only if needed, grammar changes.
- `CURRENT_ARCHITECTURE.md` after rollout, not before behavior is verified.

### Nested `Computer` kiosk repository

- `dashboard-web/index.html`
- `dashboard-web/app.js`
- `dashboard-web/style.css`
- `README.md` for the updated API/interaction contract.

Do not copy kiosk files into the parent repository. Continue using the existing
symlink and commit them in their own repository.

## 12. Delivery sequence

### Phase 0 — establish a recoverable baseline

1. Inventory and classify both repositories' staged, unstaged, deleted, and
   untracked files.
2. Separate runtime data/log churn and secrets from source/configuration.
3. Run the staged secret scanner and inspect both diffs for credentials.
4. Commit the nested kiosk repository's current live dashboard state.
5. Commit the parent repository's current live architecture in coherent,
   reviewable commits.
6. Push both repositories and verify local branches are `0/0` against remotes.
7. Re-run the baseline tests and verify all listening services.

This phase may require multiple commits; it must not flatten unrelated live
work into one opaque checkpoint.

### Phase 1 — restore the Boards boundary

1. Restore the archived Boards workspace as a reviewed, modernized agent.
2. Register Boards in `openclaw.json`, Main's delegation list, agent-to-agent
   allowlists, and voice delegation guidance.
3. Remove task-board responsibility from Lists' identity and tools.
4. Update Main's routing decision table for fixed-board aliases versus saved
   lists.
5. Preserve shared-router direct execution and add board/list regression tests.
6. Verify direct Main delegation to Boards and Lists independently before due
   dates are exposed.

This phase is an independently deployable architecture correction. Complete and
verify it before adding due dates so routing failures are not confused with
schedule-workflow failures.

### Phase 2 — backend schema and workflow

1. Add backward-compatible task versions and schedule normalization.
2. Add schedule/reschedule/unschedule API routes.
3. Reuse the Calendar helper with event metadata and durable idempotency.
4. Add compensation and reconciliation records.
5. Add contract tests for success, duplicate submission, stale version,
   Calendar failure, task-write failure, compensation failure, reschedule, and
   unschedule.

### Phase 3 — kiosk UX

1. Add controls, picker, and explicit mode state machine.
2. Suppress completion toggles during task selection.
3. Render due metadata and scheduled styling.
4. Adjust calendar/task width allocation.
5. Test offline mock mode, SSE refresh, reconnect behavior, and touch targets.
6. Verify on the exact Echo Show viewport with screenshots.

### Phase 4 — conversational access

1. Add typed workflow commands and tests.
2. Update Boards and Main routing instructions.
3. Exercise iMessage and voice requests through Main without adding a second
   writer or direct Calendar access to Boards.

### Phase 5 — controlled deployment

1. Commit and push backend and nested kiosk changes separately.
2. Restart only `ai.openclaw.dashboard-api` for backend module changes.
3. Reload the kiosk page/WebView for static frontend changes.
4. Restart Gateway only if `openclaw.json` or Gateway-loaded prompt/config
   changes require it; documentation-only workspace edits do not justify a
   restart by themselves.
5. Run one test schedule, reschedule, completion, and unschedule against a
   disposable task/event, then remove the disposable records.
6. Confirm service health, logs, SSE delivery, and absence of orphan events.

## 13. Acceptance criteria

- Due Date mode is entered from beside Lists and exits after success.
- Selecting a task in that mode never completes it.
- Only open tasks on Work, Personal, and Market Lou are eligible.
- One confirmation creates exactly one 30-minute event on
  `aaron@marketlou.com`.
- Repeating the same request does not create a duplicate event.
- Rescheduling edits the stored event ID.
- A stale task version returns a conflict without mutating either system.
- Calendar failure leaves task state unchanged.
- Post-calendar task-write failure is compensated or leaves a deterministic,
  actionable reconciliation record.
- The task immediately displays its date/time via response or existing SSE.
- Scheduled styling is legible and not color-only.
- Completion retains the Calendar event and historical schedule metadata.
- Main delegates fixed-board aliases such as "Work list" to Boards, while
  saved-list/library requests go to Lists.
- Boards can request task-linked schedule operations but cannot write task JSON
  or call Google Calendar directly.
- Saved lists, grocery, and daily goals remain behaviorally unchanged.
- Both GitHub repositories contain the deployed source.
- Runtime processes are confirmed to be running the deployed revisions.

## 14. Decisions for Aaron's review

The source resolves most questions from the original plan. These choices remain:

1. Approve `aaron@marketlou.com` as the task-scheduling calendar.
2. Approve the interpretation that the chosen time is a 30-minute work block,
   not merely a deadline marker.
3. Approve retaining the Calendar event unchanged when a task is completed.
4. Approve immediate light-red treatment for all scheduled tasks.
5. Decide whether moving tasks between boards is in scope. The current API has
   no move operation; the recommended first release leaves it out.
6. Approve deferring the general coordination service. If still desired, it
   should receive a separate architecture proposal based on demonstrated
   cross-agent workflows, not be coupled to due dates.

## 15. Explicit non-goals for the first release

- General-purpose agent message bus or shared editable memory.
- Replacement of Gateway delegation.
- Browser access to Google credentials.
- Direct JSON writes by agents or frontend code.
- Scheduling saved-list items, groceries, or daily goals.
- Arbitrary task durations.
- Automatic task movement between boards.
- Retrofitting historical tasks with guessed schedules.
- Broad routing changes unrelated to task-linked due dates.
