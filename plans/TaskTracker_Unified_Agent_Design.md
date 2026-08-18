# Task Tracker — Unified Agent Design & Implementation Plan

- **Status:** Implemented (2026-08-10) — Phases 1+2 code/config/docs complete; Gateway restart + launchd activation pending Aaron's go-ahead; Phase 3 (turning cues on) not started
- **Date:** 2026-08-10
- **Decision:** Merge the three subagents **Scheduler**, **Boards**, and **Goals** into a single agent named **Task Tracker**. It takes on the **persona of Boards** (Boards already owns the calendar-write + due-date-button capability and `complete-any`). `lists`, `meal-planner`, `health-tracker`, `finance-agent`, `research`, `systems-qa`, `sports-betting`, and `spanish-tutor` are **unchanged and out of scope**.
- **Author's note:** This is intended to be handed off to an implementing coding sub-agent. Section 11 tells it exactly where to focus. Do **not** implement anything until this doc is approved.

---

## 1. Goal

Stop maintaining three thin subagents that all deal with the same dashboard data. Collapse **Scheduler + Boards + Goals** into one **Task Tracker** agent so that a single specialist owns:

1. Work / Personal / Market Lou task boards **and** their due dates (Boards).
2. The **Daily Goals widget** — the six recurring habits and their completion state (Goals).
3. Calendar reads/writes on `aaron@marketlou.com` (Scheduler).
4. **The "shadow second scheduler"** — an off-calendar plan that finds free 30-minute windows, schedules that plan as **texted reminders/check-ins rather than calendar blocks**, and (for due-dated tasks) surfaces "coming up" messages.

The persona is **Boards**, because Boards is the agent that already:
- writes task-linked due-date events to Google Calendar via the Dashboard API, and
- owns `complete-any` (the shared habit/task disambiguator).

So the merged agent is effectively "Boards, extended with Daily Habits + calendar planning + proactive cueing."

---

## 2. Current state (grounded facts)

### 2.1 The three agents today

| Agent | Workspace | agentDir | What it owns today |
|---|---|---|---|
| **Scheduler** | `workspace-daily-tracker/` | `agents/daily-tracker/agent` (registered as id `scheduler`) | Calendar add/reschedule/delete/read on `aaron@marketlou.com`; the deterministic daily-goal-scheduler |
| **Boards** | `workspace-boards/` | `agents/boards/agent` | Work/Personal/Market Lou tasks + task-linked due dates (`schedule`/`reschedule`/`unschedule`); `complete-any` |
| **Goals** | `workspace-goals/` | `agents/goals/agent` | Daily Goals bar habit completion (`complete-habit`); today's completion state |

### 2.2 The key conflict to resolve

`workspace-daily-tracker/scripts/daily-goal-scheduler.js` (owned by Scheduler, launched at **07:30** via `~/Library/LaunchAgents/ai.openclaw.daily-goal-scheduler.plist`) currently **writes real `"Goal: Guitar"` 30-minute events onto `aaron@marketlou.com`** between 08:00–17:00.

**Aaron does NOT want the six daily habits on his calendar.** He wants the six rituals to be **spaced out and texted to him as reminders/check-ins**, not shown as calendar blocks. The only part that should hit the calendar is the **due-date button** on Work/Personal/Market Lou tasks (task-linked events), which Boards already handles.

**Consequence (non-negotiable behavior change):** the daily-ritual planner must stop creating calendar events. It becomes an **off-calendar plan** that feeds a **message-cue queue** instead.

### 2.3 Infrastructure that already supports most of the target

- **Shared data home already exists:** `workspace-daily-tracker/tasks/*.json` holds `daily-habits.json`, `work.json`, `personal.json`, `market-lou.json`, `lists.json`, `grocery.json` and history sidecars. `memory/today-habits.json` holds today's habit completion. `memory/today-plan.json` already holds a plan with `source`/`goalId`/`status`/`nudgeCount` per block.
- **Dashboard API** (port 18795, `services/dashboard-api/server.js`) is the **sole writer** of task + habit JSON and pushes SSE. It already exposes `/api/goals`, `/api/goals/:id` (toggle habit), `/api/goals/history`, `/api/tasks/:board`, `/api/tasks/:board/:id/schedule`. It is the **single writer cleanly assumed** for the merged agent.
- **Deterministic proactive messaging already exists:** `workspace-main/scripts/calendar-notification-workflow.js` (launchd `ai.openclaw.daily-tracker-heartbeat` at `:00`/`:30`) reads the calendar and sends native iMessage reminders via `lib/native-imessage` → `chat_id:1`. It **never invokes an LLM**. This is the exact pattern to reuse for the shadow-scheduler's texted cues — "coming up in ~10 min"-style messages are already its idiom.
- **`today-plan.json` + `nudgeCount`** already preview a cue/message concept waiting to be wired up.
- **Deterministic fast paths:** `shared-routine-router` (plugin) + `services/shared-routine-router` handle `AddCalendar` and board/list wildcard phrasing **without any agent model**, and `services/ha-voice-adapter/server.js` reads the **exact `<!-- DELEGATION_TABLE_START -->` block** straight off `workspace-main/TOOLS.md` on every voice turn.

---

## 3. Target architecture

### 3.1 One agent: `task-tracker` (Task Tracker)

- **id:** `task-tracker`
- **Name:** Task Tracker
- **Persona:** Boards ("organized, exact, careful about task/calendar linkage") extended with daily habits + calendar planning + proactive cueing.
- **Model:** Boards/Goals ran on local Ollama; Scheduler on OpenRouter (deepseek-v4-flash). Recommendation: the merged agent runs on the stronger Scheduler model (OpenRouter/deepseek-v4-flash with Ollama fallback), since it now does planning + due-date interpretation, not just simple toggles. **Decision needed (see §10).**
- **Workspace:** One consolidated workspace. **Recommendation:** repurpose the existing **`workspace-daily-tracker/`** as Task Tracker's physical workspace (it already is the shared data home: `tasks/*.json`, `memory/today-habits.json`, `memory/today-plan.json`, plus the calendar + planner scripts). This avoids breaking the many hardcoded references to `workspace-daily-tracker` in `dashboard-api/server.js`, launchd plists, and the router. `goals` and `boards` workspaces retire (can be archived, see §7).

### 3.2 What the merged agent owns (final split)

| Capability | Source | Notes |
|---|---|---|
| Work/Personal/Market Lou tasks + due dates | Boards | Via merged `dashboard-workflow.js` |
| Daily Goals widget / habits completion | Goals | `/api/goals`, `/api/goals/:id` + `complete-habit`/`complete-any` |
| Calendar reads/writes (task-linked + standalone) | Scheduler | `aaron@marketlou.com` via `google-calendar.js` |
| Daily-ritual planner (off-calendar) | Scheduler's `daily-goal-scheduler` | **changed:** produces a plan + message cues, **no calendar writes** |
| Shadow-scheduler cue queue | NEW | See §4.3 |

### 3.3 What is retired / unchanged

- **Retired as separate agents:** `goals`, `boards`.
- **Repurposed:** `scheduler` registration becomes `task-tracker`.
- **Unchanged & untouched:** `lists`, `meal-planner`, `health-tracker`, `finance-agent`, `research`, `systems-qa`, `sports-betting`, `spanish-tutor`.

---

## 4. New behaviors (detail)

### 4.1 Daily ritual planner — off-calendar plan + cues

Rework `daily-goal-scheduler.js` (or a successor `task-tracker-planner.js`):

- Reads unfinished habits (`daily-habits.json` + today's completions).
- Reads the day's calendar events on `aaron@marketlou.com`.
- **Finds a free 30-minute slot for each unfinished habit** in the 08:00–17:00 window, spacing them ("even" distribution), **skipping slots already booked** or where a due-dated task event is scheduled.
- **Does NOT call `createEvent`/`updateEvent`.** Instead it writes a `today-plan.json` and produces a **message-cue list** (below).
- Retain the `plan`/`run` + `--date` + `OPENCLAW_DAILY_GOAL_NOW` test hooks. Keep the planner **deterministic** (no LLM in the proactive path — same rule as the calendar-notification workflow).

### 4.2 Due-date tasks stay on the calendar (unchanged from Boards)

- Task-linked due dates still create events on `aaron@marketlou.com` via `dashboard-api` `/api/tasks/:board/:id/schedule`. This is the Boards functionality that the user explicitly wants to keep and build on.
- The planner **must treat existing task-schedule events as busy** when hunting ritual slots.

### 4.3 Message-cue queue (the "shadow second scheduler" texting)

Define a deterministic cue contract so the agent/planner can request that **Main send a text**, without Task Tracker messaging Aaron directly (agents have no direct channel):

**Queue file:** `<workspace>/memory/message-cues.json`

```json
{
  "date": "2026-08-10",
  "cues": [
    {
      "key": "habit-guitar",
      "deliverAt": "2026-08-10T14:00:00-04:00",
      "text": "🎯 Up next: Guitar for 30 min at 14:00.",
      "status": "pending"         // pending | sent | dropped | retry
    },
    {
      "key": "task-report-due",
      "deliverAt": "2026-08-10T13:50:00-04:00",
      "text": "⏰ Task Tracker: 'Write report' comes up in ~10 min.",
      "status": "pending"
    }
  ]
}
```

**Delivery:** a launchd workflow (new, or extended `calendar-notification-workflow.js`) that on each `:00`/`:30` tick:
1. Reads `message-cues.json`.
2. Sends any `pending` cue whose `deliverAt` is within the next `~10` minutes **or already passed**, via `sendNativeIMessage` → `chat_id:1` (dedupe by `key`+`date`, exactly like calendar-notification's `state.sending` logic).
3. Marks them `sent` only on successful delivery; keeps `retry` if the time is still due.

**Conversational differences:** due-dated tasks on the calendar already get reminder messages from the existing calendar-notification workflow. The **new** texted reminders are primarily for the six **daily habits** (which are not on the calendar). So the planner seeds the cue queue for habits, and reuses the existing calendar reminder path for task events.

### 4.4 "Cue Main to send it" — the interface Aaron described

When Aaron asks in chat, the conversation flows Main → `task-tracker` → result. When the **planner** decides something should be texted, it does **not** message directly; it **puts a cue in `message-cues.json`**, and a **deterministic** workflow delivers it via main's native iMessage channel. This keeps the "you (the system) say it to Aaron, phrased as Task Tracker's voice" contract without letting an LLM drive outbound messages (guardrail §9).

---

## 5. Component design

### 5.1 Script bundle (consolidated into Task Tracker workspace)

Merge into one location, e.g. `workspace-daily-tracker/scripts/`:
- **`dashboard-workflow.js`** — from Boards + Goals. Should expose: board `list/add/complete/remove`, `schedule/reschedule/unschedule`, `complete-habit`, `complete-any`, habit `list`. These all call `dashboard-api` (the sole writer). Remove the per-workspace duplication that currently exists in `workspace-boards/scripts/` and `workspace-goals/scripts/`.
- **`daily-goal-scheduler.js` → reworked `task-tracker-planner.js`** (off-calendar + cue seeding, §4.1/§4.3).
- **`lib/google-calendar.js`** — calendar adapter (already shared; keep here).
- **`lib/native-imessage.js`** — used only by the deterministic delivery workflow (not by the agent's exec).

### 5.2 Deterministic delivery workflow

New launchd job (or folded into `ai.openclaw.daily-tracker-heartbeat` at `:00`/`:30`): drain `message-cues.json` to `sendNativeIMessage`. Model this file-for-file on `calendar-notification-workflow.js` (it already has the correct `state.sending` in-flight guard, retry-on-failure, and atomic state write).

### 5.3 Data ownership

- `dashboard-api` remains **sole writer** of task/habit JSON and task→calendar linkage.
- Task Tracker **never edits JSON directly**; it runs `dashboard-workflow.js` commands, which call the API.
- Task Tracker owns/reads `today-plan.json` and `message-cues.json`.
- No agent has direct Google credentials except through the deterministic scripts.

### 5.4 Agent registration (openclaw.json)

- In `agents.list`, rename/rebadge the **`scheduler`** entry → id `task-tracker`, Name `Task Tracker` (keep its `agentDir` `agents/daily-tracker/agent`, or create `agents/task-tracker/agent` — recommend reusing, to preserve its session sqlite/credentials).
- **Delete** `goals` and `boards` entries.
- Keep everything else.
- Update gateway **agent-to-agent allowlist** and Main's delegation list to reference `task-tracker` only.
- **Model decision** (§10).

---

## 6. Routing & integration changes

### 6.1 Main routing (workspace-main)

- `workspace-main/TOOLS.md` **DELEGATION_TABLE_START/END** block:
  - `Calendar events ...` → `task-tracker`
  - `Task boards (Work, Personal, Market Lou) + due dates` → `task-tracker`
  - `Daily habits ...` → `task-tracker`
  - Remove the separate `scheduler`, `boards`, `goals` rows.
- `workspace-main/CALENDAR_ROUTING.md` and `CALENDAR_NOTIFICATIONS.md`: update agent identity references `scheduler` → `task-tracker`; document the new cue queue.
- The "Dashboard widget delegation" and "Habit vs task ambiguity" nuance sections now collapse into a single `task-tracker` target.
- `shared-routine-router`: deterministic fast paths (AddCalendar, board/list wildcards) can keep running agent-free; update any hardcoded agent id references if present. The `complete-any` habit/task disambiguation now routes to the single Task Tracker.

### 6.2 Voice adapter

`services/ha-voice-adapter/server.js` reads the DELEGATION_TABLE block off disk each turn — so it updates automatically once `TOOLS.md` is edited. Verify after deploy.

### 6.3 launchd

- `ai.openclaw.daily-goal-scheduler.plist`: point ProgramArguments at the reworked planner, and (as part of the behavior change) reconfigure so it **plans + seeds cues** rather than writing calendar events.
- Add/adjust a job to drain `message-cues.json`.

### 6.4 dashboard-api

Update the `DT_WORKSPACE` constant if the workspace path changes (recommended: keep `workspace-daily-tracker` physical path, so no change needed). If a fresh `workspace-task-tracker` is chosen instead, update: `dashboard-api` `DT_WORKSPACE`, `HABITS_FILE`, `TODAY_HABITS_FILE`, all task-file paths, plists, and the router. **Decision needed (§10).** Recommendation: reuse the path to minimize blast radius.

---

## 7. Migration surface — every file/constant to touch

**openclaw.json**
- `agents.list`: scheduler → task-tracker (rebadge), remove goals + boards.
- Gateway agent-to-agent allowlist + Main allowlist.

**workspace (Task Tracker home)**
- New `IDENTITY.md`, `SOUL.md`, `AGENTS.md`, `TOOLS.md`, `HEARTBEAT.md`, `USER.md` written for the merged persona.
- Merge `dashboard-workflow.js` (boards + goals command sets).
- Rework planner + add `message-cues.json` seeding.
- `CONFIG`, `tasks/*`, `memory/*` unchanged physically.

**Retired workspaces** (`workspace-goals/`, `workspace-boards/` + `agents/goals`, `agents/boards`)
- Archive (e.g. `archives/task-tracker-merge-2026-08-10/`) rather than delete, after confirming no hardcoded live references remain.

**workspace-main**
- `TOOLS.md` delegation table + RULES/nuance.
- `CALENDAR_ROUTING.md`, `CALENDAR_NOTIFICATIONS.md`.
- Any hardcoded `agentId` references (`scheduler`/`boards`/`goals`) in scripts/plugins.

**services**
- `dashboard-api/server.js` constants if workspace renamed.
- `services/shared-routine-router` + `plugins/shared-routine-router/index.js` if agent ids are hardcoded.

**launchd**
- `ai.openclaw.daily-goal-scheduler.plist` program args + behavior.
- New (or extended) cue-drain job.

**tests**
- Re-run the live baseline: `dashboard-api` contract tests, `workspace-main/scripts/dashboard-workflow.test.js`, `workspace-daily-tracker/scripts/daily-goal-scheduler.test.js`, `calendar-notification-workflow.test.js`. Update tests for the off-calendar planner + cue queue.

---

## 8. Soft-load rollout (phases)

Approved guardrail: **soft-load first, observe, then load up.**

- **Phase 0 — baseline:** capture current state (git), run baseline tests, confirm all services up (Gateway 18789, dashboard-api 18795, voice 18796, trace-noc 18790).
- **Phase 1 — merge only (no behavior change):** create Task Tracker as Boards persona owning boards+daily habits via the merged `dashboard-workflow.js`; retire goals/boards; update routing + allowlists; verify Main can delegate board, habit, and calendar ops to the single agent. **Ritual planner still writes to calendar at this stage** (unchanged) so nothing regresses.
- **Phase 2 — flip the planner:** rework planner to off-calendar + seed `message-cues.json`; add the cue-drain workflow; stop writing `Goal:` events. This is the behavior Aaron actually wants.
- **Phase 3 — shadow scheduler up:** enable texted cues for the six habits (spaced, "coming up"/check-in voice via main's channel). Start sparse (soft): e.g. one per habit slot as a heads-up, no nagging.
- **Phase 4 — tune:** adjust cadence/wording from observed behavior; decide §10 open items (task-priority persona extension, etc.).

Deployment notes (from the due-date plan): backend module changes → restart only `ai.openclaw.dashboard-api`; static/frontend → reload kiosk; `openclaw.json`/gateway changes → restart Gateway; **documentation-only workspace edits do not require a restart.**

---

## 9. Risks & guardrails (lessons already learned in this repo)

1. **Do not recreate the pre-2026-08-02 monolithic "Daily-Tracker."** It was split apart for a reason. The merge is deliberate here (3 thin agents → 1), but keep the merged agent **read/writing through `dashboard-api` only** and keep each capability visually separated in its docs/tools so it doesn't become a swamp again.
2. **Proactive messages stay deterministic.** The existing rule: "Do not make this a model-driven cron job." The cue queue is written by the deterministic planner and drained by a deterministic workflow. **Task Tracker (an LLM) never calls `sendNativeIMessage` outbound.**
3. **`sessions_send`, never `sessionKey`/`sessions_spawn`.** Main's RULES are hard-won (self-messaging loop, fabricated results, session cap). The merged agent id `task-tracker` must be passed as `agentId` on every `sessions_send`.
4. **Single writer, single channel.** Task Tracker returns results to Main; outbound is main's native iMessage channel. No raw `imsg` from agents.
5. **Never edit task/habit JSON directly; never call Google Calendar directly** — always through `dashboard-workflow.js` / the deterministic planner / `google-calendar.js`.
6. **Hardcoded-path lesson:** `workspace-daily-tracker` path was intentionally kept because scripts reference it. Prefer reusing that path over a rename unless the implementing agent does a full constant sweep + retest.
7. **Don't hijack the existing calendar reminders for habits.** Habit cues come from the planner; task-event reminders come from the existing calendar workflow. Don't double-text the same item.
8. **Backup before structural moves** (workspaces, agents dirs). Archive, don't delete, until verified.

---

## 10. Decisions for Aaron — RESOLVED 2026-08-10

1. **Model for Task Tracker:** ✅ Strong (OpenRouter/deepseek-v4-flash, like Scheduler).
2. **Workspace:** ✅ Reuse physical `workspace-daily-tracker`.
3. **Shadow-scheduler cadence / voice:** ✅ Heads-up only, sparse — one "coming up in ~10 min" text per habit slot, no check-in/nag follow-up if missed.
4. **Keep existing calendar reminders for due-dated tasks:** ✅ Yes, unchanged — `calendar-notification-workflow.js` keeps owning task-event reminders; `message-cues.json` is only for the six habits.
5. **Extension (later, not now):** if the shadow scheduler must also *prioritize/plan* due-dated work tasks (not just rituals), that's a follow-up persona decision — explicitly deferred per soft-load.

---

## 11. Handoff instructions for the implementing agent

Read before coding:
- THIS document.
- `workspace-main/AGENTS.md` (roster + routing) and `workspace-main/TOOLS.md` (esp. the `<!-- DELEGATION_TABLE_START -->` block + RULES).
- `CURRENT_ARCHITECTURE.md`.
- `plans/OpenClaw_Due_Date_and_Agent_Coordination_Plan_REVISED.md` (the Boards/due-date architecture you are extending; follow its ownership rules: `dashboard-api` sole writer, no direct Calendar from agents).
- `workspace-daily-tracker/SOUL.md` + `scripts/daily-goal-scheduler.js` + `scripts/lib/google-calendar.js`.
- `workspace-boards/` and `workspace-goals/` `SOUL/AGENTS/TOOLS` (to merge).
- `workspace-main/scripts/calendar-notification-workflow.js` (the deterministic delivery pattern to copy for the cue drain).

Scope of a correct implementation:
1. Rewrite the Task Tracker identity/instruction docs (SOUL/AGENTS/IDENTITY/TOOLS/HEARTBEAT/USER) for the jointly-owned persona that owns boards+daily-habits+calendar-planning+proactive-cueing, and update `USER.md`/`HEARTBEAT.md` to allow deterministic message cues (user-facing, soft-load).
2. Merge `dashboard-workflow.js` command set (boards + habits + `complete-any`) into the Task Tracker workspace.
3. Rework `daily-goal-scheduler.js` into the off-calendar planner that seeds `message-cues.json` (no `createEvent`/`updateEvent` for habits). Add the cue-drain workflow modeled on `calendar-notification-workflow.js`.
4. Update `openclaw.json` (re badge scheduler→task-tracker, remove goals+boards, allowlists, model) and the launchd plist(s).
5. Update Main routing (`TOOLS.md` delegation table, CALENDAR_ROUTING/NOTIFICATIONS, any hardcoded agent ids) and verify the voice-adapter picks up the new table.
6. Archive goals/boards workspaces + agents dirs after confirming no live references.
7. Update and run tests; restore baseline; soft-load per §8.

Do **not** implement until Aaron approves §10 decisions and this doc's status flips from Proposed.