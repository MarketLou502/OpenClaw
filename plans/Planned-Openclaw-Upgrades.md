# OpenClaw — Planned Upgrades

Status: compiled 2026-08-06 from SYSTEM_WALKTHROUGH.html, CURRENT_ARCHITECTURE.md,
FINANCE_ARCHITECTURE.md, HEALTH_WORKFLOW_DESIGN.md, DESIGN.md (Trace NOC),
OpenClaw_Due_Date_and_Agent_Coordination_Plan_REVISED.md, and
DESIGN-execution-log-archivist.md.

Items are grouped by priority tier, then roughly ordered within each tier. Every
item cites its original document source.

---

## Tier 1 — Foundational & Blocking

These are the biggest structural items. They affect multiple downstream decisions
and should be tackled first.

---

### 1.1 Due-Date Feature — Full Delivery (Phases 0–5)

Source: `OpenClaw_Due_Date_and_Agent_Coordination_Plan_REVISED.md`

The largest planned feature: task-board items on Work / Personal / Market Lou
boards get calendar-linked due dates. The design is fully specified across 5
delivery phases.

**Phase 0 — Establish a recoverable baseline**
- Inventory and classify staged, unstaged, deleted, and untracked files in both
  repositories (parent OpenClaw repo + nested `Computer` kiosk repo).
- Run a staged secret scanner; inspect diffs for credentials.
- Commit the kiosk repo's current live dashboard state.
- Commit the parent repo's live architecture in coherent, reviewable commits.
- Push both repos; verify `0/0` against remotes.
- Re-run baseline tests; verify all listening services.

**Phase 1 — Restore the Boards boundary**
- Restore archived Boards workspace from
  `backups/2026-08-02-boards-lists-merge/workspace-boards` as a reviewed,
  modernized agent (no stale Chef references, no pre-due-date responsibility
  model).
- Register Boards in `openclaw.json`, Main's delegation list, agent-to-agent
  allowlists, and voice delegation guidance.
- Remove task-board responsibility from Lists' identity and tools.
- Update Main's routing decision table for fixed-board aliases vs. saved lists.
- Preserve shared-router direct execution; add board/list regression tests.
- Verify Main → Boards and Main → Lists delegation independently.

**Phase 2 — Backend schema and workflow**
- Add backward-compatible task versions and schedule field to task JSON.
- Add `POST/PATCH/DELETE /api/tasks/:board/:id/schedule` routes.
- Reuse `google-calendar.js` with event metadata + durable idempotency.
- Add compensation + reconciliation records for partial failures.
- Contract tests: success, duplicate, stale version, Calendar failure,
  task-write failure, compensation failure, reschedule, unschedule.

**Phase 3 — Kiosk UX**
- Due Date button and modal picker with explicit state machine
  (idle → selecting-task → editing-schedule → saving → error).
- Suppress completion toggles during task selection.
- Render due metadata and scheduled styling (red accent, non-color-only).
- Adjust calendar/task width allocation (~72 CSS pixels at 1280px).
- Test offline mock mode, SSE refresh, reconnect, touch targets.
- Verify on exact Echo Show viewport with screenshots.

**Phase 4 — Conversational access**
- Add `schedule`/`reschedule`/`unschedule` commands to `dashboard-workflow.js`.
- Update Boards and Main routing instructions.
- Exercise iMessage and voice through Main → Boards → workflow.

**Phase 5 — Controlled deployment**
- Commit and push backend + kiosk changes separately.
- Restart only `ai.openclaw.dashboard-api` for backend changes.
- Reload kiosk WebView for frontend changes.
- Restart Gateway only if `openclaw.json` changes require it.
- One test schedule, reschedule, completion, unschedule against disposable data.
- Verify no orphan events, SSE delivery, service health.

**Open decisions for Aaron:**
1. Approve `aaron@marketlou.com` as the task-scheduling calendar.
2. Approve 30-minute work-block interpretation (not deadline marker).
3. Approve retaining Calendar event unchanged on task completion.
4. Approve immediate light-red treatment for all scheduled tasks.
5. Decide whether moving tasks between boards is in scope.
6. Approve deferring the general coordination service.

---

### 1.2 Git Baseline — Commit Live State to Both Repos

Source: `OpenClaw_Due_Date_and_Agent_Coordination_Plan_REVISED.md` §2

Neither GitHub repository represents the full live implementation:
- Parent OpenClaw repo has extensive staged, unstaged, deleted, and untracked
  changes.
- Nested `Computer` kiosk repo has four heavily modified files (`README.md`,
  `dashboard-web/index.html`, `dashboard-web/app.js`, `dashboard-web/style.css`).
- `services/trace-noc` is running while still untracked.

Until this is done, no feature work can safely begin — there's no rollback point
if something goes wrong. This is the prerequisite for everything else.

---

### 1.3 Restore Boards Agent & Narrow Lists

Source: `OpenClaw_Due_Date_and_Agent_Coordination_Plan_REVISED.md` §4.1

Part of Due-Date Phase 1 but substantial enough to call out independently.
The pre-merge Boards workspace exists at
`backups/2026-08-02-boards-lists-merge/workspace-boards` but needs a full
rewrite for the current architecture. Lists must simultaneously lose board
ownership, board commands, board aliases, and `complete-any` responsibility
that crosses the task/habit boundary.

---

### 1.4 Re-add `contextPruning` in a Cold-Start-Safe Shape

Source: `SYSTEM_WALKTHROUGH.html` §3.7, "Cache-TTL pruning" and "Voice
food-logging redesign" entries

`contextPruning: {mode: "cache-ttl", ttl: "1h"}` was added to `main`,
`scheduler`, `meal-planner`, and `research` on 2026-08-02. It was accepted on
hot reload but rejected on cold restart (stricter validation in full-restart
path), causing the Gateway to crash-loop. `openclaw doctor --fix` removed it.
It is **no longer live on any agent**.

To re-add:
- Determine the correct schema shape that survives cold-start validation.
- Confirm with a real `launchctl kickstart -k` restart (not just hot reload).
- Consider which subset of Haiku-primary agents should get it (all 5 now:
  `main`, `scheduler`, `meal-planner`, `research`, `health-tracker`).

---

### 1.5 Verify OpenRouter Cache Effectiveness

Source: `SYSTEM_WALKTHROUGH.html` §3.7, "Cache-TTL pruning" and "Two bundled
skills enabled" entries; `CURRENT_ARCHITECTURE.md` "Model policy" section

Whether OpenRouter actually honors `cache_control` for cached reads is
**unverified**. OpenClaw docs claim it's functional for Anthropic models, but
an upstream GitHub issue (#9600) says `cache_control` pass-through isn't
implemented. The two sources disagree.

The `session-logs` skill (enabled 2026-08-02) can query per-session cost and
usage. Use it to check OpenRouter's Activity dashboard for nonzero
`cacheRead` tokens — don't assume either doc source blindly.

This matters because:
- If cache is working, proper `contextPruning` + `cacheRetention: "long"`
  could meaningfully reduce per-turn cost on the 5 Haiku-primary agents.
- If not, the only win is local history pruning (still useful, but less).

---

## Tier 2 — Design Gaps & Infrastructure

These are important features or fixes that are designed (partially or fully)
but not yet implemented.

---

### 2.1 Trace NOC — Phase 2 (Outcome Diagnosis)

Source: `services/trace-noc/DESIGN.md` "Delivery phases" § Phase 2

Phase 1 (evidence explorer) is live on port 18790. Phase 2 adds:
- Voice fast-path and deterministic-router event ingestion.
- Domain mutation and dashboard projection checks.
- First-suspicious-step rules and an investigation summary.
- Saved QA annotations (stored outside authoritative logs).

This is the phase that turns the NOC from a log browser into a real diagnostic
tool. It would have caught the yogurt incident's chain of failures automatically
rather than requiring manual session trace inspection.

---

### 2.2 Trace NOC — Phase 3 (Continuous NOC & QA API)

Source: `services/trace-noc/DESIGN.md` "Delivery phases" § Phase 3

- Watch for appended JSONL records and stream updates to the browser.
- Aggregate error, latency, routing, model, token, and cost views.
- Expose narrow read-only endpoint for Systems QA.
- Optionally export normalized OpenTelemetry/OTLP traces to Phoenix, Langfuse,
  or another compatible backend.

The QA API specifically would give `systems-qa` a structured data source rather
than having to read raw session files through wrapper scripts.

---

### 2.3 Nightly Routing-QA Job — Confirm Steady-State Token Cost

Source: `SYSTEM_WALKTHROUGH.html` §3.6 "Nightly routing QA review", §3.7
"Nightly routing-QA job's first live run"

The first manual run cost 717,227 input tokens (2,418 output). The three bugs
found were all fixed same-day (server-side jq filtering, real system-clock
watermark, SQLite type-affinity cast). But:
- **Steady-state incremental cost is unconfirmed.** Every verification run
  reset the watermark, so every run so far was effectively a first-run-of-the-day
  cost. The first true unattended incremental night has not yet happened.
- Run it once genuinely unattended (let the cron fire naturally) and check the
  actual token consumption.

---

### 2.4 Nutrition Vendor Cache — Optional Online Lookup Module

Source: `HEALTH_WORKFLOW_DESIGN.md` "Modular nutrition resolver"

The resolver architecture defines a `VendorCacheResolver` interface for
locally-cached vendor/restaurant data, but the initial version has no live
online lookup. The design keeps the boundary modular so a direct vendor/API
module can be added later without changing the ledger, voice interface, or
dashboard contract.

When implemented, preserve the URL and retrieval date for any manually-added
vendor value. Never present an AI estimate as current vendor data.

---

### 2.5 Import Global Branded Foods Dataset (Optional)

Source: `HEALTH_WORKFLOW_DESIGN.md` "Local public nutrition index"

The initial USDA index (13,545 foods, ~5 MB) was built from Foundation Foods,
FNDDS, and SR Legacy. The Global Branded Foods dataset (~3 GB uncompressed)
was explicitly **not imported** — most fields are irrelevant to the workflow.
Can be added as a separate optional module later if coverage gaps become
annoying in practice.

---

### 2.6 Home Assistant Follow-Up Conversation

Source: `HEALTH_WORKFLOW_DESIGN.md` "Home Assistant follow-up conversation"

Home Assistant's Conversation API supports `conversation_id` + a
`continue_conversation` response flag. The desired behavior:
1. Aaron says "I ate a chicken sandwich."
2. Jarvis says "Got that logged."
3. Voice PE briefly listens again without another wake word.
4. Aaron can ask "How many calories was that?" without saying "Hey Jarvis."
5. The follow-up reaches the same conversation/session.

The health workflow already supplies stable entry and conversation references.
The integration falls back safely to requiring "Hey Jarvis" again if the
device/pipeline doesn't support continued listening — but the adapter-side work
to preserve conversation IDs through follow-up turns hasn't been verified.

---

### 2.7 Dashboard SSE / Live Push Channel

Source: `SYSTEM_WALKTHROUGH.html` §2, "The kitchen dashboard screen"
`OpenClaw_Due_Date_and_Agent_Coordination_Plan_REVISED.md` §3

The kiosk polls every 60 seconds; there's no live push channel yet. The
due-date design mentions that task mutations already broadcast over SSE
(`tasks:<board>` topic), and the five-minute polling is described as a
"reconciliation net." The scope of SSE adoption across other widgets
(health totals, financials, grocery) is undeveloped and could be a separate
improvement pass — or left as-is if 60-second polling is acceptable.

---

### 2.8 Execution-Log Archivist — Conversation Knowledge Distillation

Source: `DESIGN-execution-log-archivist.md`

A nightly job that reads Main's session trajectory files, distills durable
knowledge from the conversation (facts about Aaron, decisions, preferences,
recurring patterns, error signatures), and deposits structured knowledge
artifacts into `workspace-main/memory/compacted/`, where the existing
`memorySearch` index picks them up automatically.

This is a **memory-quality** improvement, not a token-saving one. Aaron's
request volume is low, so the win is not compression — it's recall: the
`memorySearch` index currently searches raw transcripts, which are verbose
and noisy; distilled artifacts make search results hit the signal, not the
noise. Deliberately distinct from OpenClaw's built-in context compaction
(`agents.defaults.compaction`) and from the 04:00
`main-imessage-nightly-compact` cron — those bound session size, this
improves what the agent actually remembers.

**Design decisions (locked with Aaron 2026-08-06):**
- New agent `archivist` (no channel binding), mirroring `systems-qa`'s proven
  pattern: `tools.fs.workspaceOnly: true`, wrapper-script boundary
  (`arc-read.sh` / `arc-write.sh`), watermark-based incremental processing,
  isolated cron sessions.
- Cron job `execution-log-archivist`, 03:00 daily (before the 04:00 compact
  job so summaries exist before raw sessions get pruned), `sessionTarget:
  isolated`, `delivery.mode: none`, `failureAlert` to iMessage.
- Model override: `openrouter/deepseek/deepseek-v4-flash` — the same model
  Main runs on; 1M context window at $0.10/M input makes reading trajectory
  files cheap. Not Haiku, unlike systems-qa's job.
- Output: structured JSON + Markdown digest per day, deposited to
  `workspace-<agentId>/memory/compacted/`; indexed by the existing
  `memorySearch` (which already watches the whole workspace `memory/` tree).
- `memory/compacted/LATEST.md`: a small (~200-token) current-state preamble
  maintained by the job and read by Main at session start — the
  "context map" benefit; minimal cache impact, and Main's session is rebuilt
  by the 04:00 compact job anyway.
- Empty-window handling: no new activity since the watermark → one-line own
  digest and advance the watermark; no deposits, no fabrication.
- v1 targets `main` only; other agents are a later, mechanical extension.

**Implementation plan** (all new files; no changes to existing agents):
- `workspace-archivist/scripts/arc-read.sh` — whitelisted reads:
  `watermark | sessions-index | agent-trajectories <agentId> <since-ms>`
- `workspace-archivist/scripts/arc-write.sh` — whitelisted writes:
  `digest <YYYY-MM-DD> | deposit-facts <agentId> <YYYY-MM-DD> |
  deposit-digest <agentId> <YYYY-MM-DD> | latest-ref <agentId> | watermark`
- `workspace-archivist/SOUL.md` — full procedure: classification taxonomy
  (facts / decisions / patterns / errors / completed ops / ephemeral),
  extraction rules, empty-window path, watermark discipline
- `workspace-archivist/TOOLS.md`, `AGENTS.md`, `IDENTITY.md`, `USER.md`,
  `HEARTBEAT.md`
- `openclaw.json`: add `archivist` to `agents.list` (`workspaceOnly: true`,
  `memorySearch` off, `tools.deny` mirroring `systems-qa`)
- Main's `AGENTS.md`: add one line — read `memory/compacted/LATEST.md` at
  session start for current-state overview (the only existing-file change)
- Cron registration:
  `npx openclaw cron add --name execution-log-archivist --agent archivist
  --cron "0 3 * * *" --session isolated
  --model openrouter/deepseek/deepseek-v4-flash
  --message "Run the nightly execution-log archivist job per SOUL.md."
  --timeout-seconds 600 --no-deliver --stagger 60s`

**Verification checklist (do before calling it done):**
- Cold restart: `launchctl kickstart -k gui/501/ai.openclaw.gateway` — the
  `contextPruning` incident showed hot-reload acceptance ≠ cold-start
  validation acceptance; this job must survive a real restart.
- Dry run: `npx openclaw cron run execution-log-archivist`.
- Confirm deposits under `workspace-main/memory/compacted/`, own digest under
  `workspace-archivist/memory/`, watermark advanced.
- Confirm `memorySearch` returns compacted artifacts (manual search call).
- Confirm Main's session start reads `LATEST.md` without error.
- Confirm no measurable cache/token regression via the `session-logs` skill.

**Open decisions for Aaron (when picking this back up):**
1. v1 targets: `main` only, or add specialists (health-tracker,
   finance-agent, scheduler) in the same first build?
2. Cadence: daily (default, cheap) vs. every-2-3 days given low volume?
3. Should the archivist ever prune raw trajectory files itself? (Deferred
   by design — the existing compaction job owns pruning.)

---

## Tier 3 — Refinements & Operational Gaps

These are smaller, well-understood fixes or improvements. Each individually is
low-effort; together they reduce friction and prevent future incidents.

---

### 3.1 Message Provenance — Identify Sub-Agent Replies

Source: `SYSTEM_WALKTHROUGH.html` §3.7 "Sub-agent channel access"
`CURRENT_ARCHITECTURE.md` "passive outbound side"

The Gateway's `delivery-mirror` mechanism pushes a delegated sub-agent's final
reply text directly to the owner's channel as if it came from Main. There is
no prefix identifying the source. This means:
- A message the owner receives may be authored by a local `llama3.1:8b` model
  running in a specialist's session, never reviewed by Main.
- If that agent hallucinates or fabricates (as `scheduler` did with `cal-add.sh`),
  the reply reaches the owner unvetted.

The mechanism itself is compiled Gateway code, not configurable from this repo.
But the `delivery-mirror` behavior could potentially be documented or flagged.
Worth revisiting if message provenance ever needs to be user-visible.

---

### 3.2 `gh-issues` Skill — Decide on Autonomy Level

Source: `SYSTEM_WALKTHROUGH.html` §3.7 "Two bundled skills enabled"

`github` and `session-logs` were enabled. `gh-issues` (a related skill that
auto-spawns fix agents and opens PRs with no review gate) was left disabled.
Needs a deliberate decision on how much autonomy to grant it on a personal repo
before it can be turned on.

---

### 3.3 `qwen3.5:9b` on `lists` — Monitor & Confirm Quality

Source: `SYSTEM_WALKTHROUGH.html` §3.7 "Local-model swap on lists"

`lists` was moved from `ollama/llama3.1:8b` to `ollama/qwen3.5:9b` as a live
reliability test after the `host`-field tool-arg hallucination bug. If quality
regresses, revert to `ollama/llama3.1:8b` (pre-change config saved at
`openclaw.json.bak-20260802-213902`). No fallback model was added.

---

### 3.4 Heartbeat / Workout Prompt Refinements

Source: `HEALTH_WORKFLOW_DESIGN.md` "Workouts and daily run"
`CURRENT_ARCHITECTURE.md` "Proactive calendar and hourly-workout messages"

Current behavior:
- Workout prompts run 9 AM–4 PM ET but have no chase or pending-reply state.
- A bare "yes" is explicitly not interpreted as a workout.
- A daily run with no given duration defaults to 30 minutes.

No specific gaps identified, but this area has subtle edge cases (idempotency
across workouts in the same clock hour, the relationship between the
prompt-scheduler and the actual logging flow). Worth a light review once the
bigger items are handled.

---

### 3.5 Dashboard Health Refresh — Timing / Display Gap

Source: `SYSTEM_WALKTHROUGH.html` §3.7 "Voice food-logging redesign"

The yogurt incident surfaced that a logged food didn't appear on the dashboard
right away — but the API returned correct totals when queried directly. Ruled
out as most likely a kiosk SSE-connection-state or polling-timing issue, not a
server bug. The FALLBACK_POLL_MS (5 minutes) would catch it regardless.

Flagged for revisit only if a dashboard refresh ever fails to show a
voice-logged entry that's independently confirmed present via the API.

---

### 3.6 Reconciliation Command — Orphan Calendar Events

Source: `OpenClaw_Due_Date_and_Agent_Coordination_Plan_REVISED.md` §7

The due-date workflow's compensation design specifies that a reconciliation
command must be able to inspect incomplete operation-journal entries and either
repair task linkage or remove orphan Google Calendar events. This is described
as a deterministic command, not a model-driven cron job — but it hasn't been
built yet (depends on Phases 0–2).

---

### 3.7 Moving Tasks Between Boards (Explicit Non-Goal)

Source: `OpenClaw_Due_Date_and_Agent_Coordination_Plan_REVISED.md` §14

Explicitly tracked here as a non-goal for the first due-date release. The
current API has no move operation. Revisit if Aaron needs it — it would require
new API endpoints and data-model changes.

---

### 3.8 General Coordination Service (Deferred)

Source: `OpenClaw_Due_Date_and_Agent_Coordination_Plan_REVISED.md` §1, §14

The original proposal considered a general agent command queue / memory bus.
Deferred: Gateway delegation + narrow deterministic scripts already provide
working coordination. If still desired, it should receive a separate
architecture proposal based on demonstrated cross-agent workflow needs, not be
coupled to due dates.

---

### 3.9 `ha-voice-adapter` Prompt Drift — Check on Every Delegation Change

Source: `SYSTEM_WALKTHROUGH.html` §3.7 "Voice-turn delegation prompt was a
separate hardcoded string"

The Home Assistant voice adapter injects its own `extraSystemPrompt` (a
hardcoded template in `server.js:489`), not the agent's `TOOLS.md`. When
`sessions_spawn`→`sessions_send` migration happened, `TOOLS.md` was updated
but the voice adapter's prompt wasn't — causing live voice turns to fail until
discovered. Lesson: any future delegation-behavior change must check every
channel-specific adapter's own hardcoded prompt injection, not just the agent's
workspace docs.

No current action needed — just document the pattern for next time.

---

### 3.10 Full Disk Access Fragility on Node Upgrade

Source: `SYSTEM_WALKTHROUGH.html` §3.7 "Full Disk Access is binary-specific"

`node@22` is pinned (`brew pin node@22`), so this can't recur from a routine
`brew upgrade` without a deliberate unpin. But it's worth remembering that if
`node@22` is ever unpinned or replaced, iMessage will silently stop working
until Full Disk Access is re-granted in System Settings → Privacy & Security.
No action needed unless the pin is removed.

---

### 3.11 `node --test` Baseline — Confirm Still Passing

Source: `OpenClaw_Due_Date_and_Agent_Coordination_Plan_REVISED.md` §2

The following tests passed before feature work began:
- `services/dashboard-api/calendar-dashboard-contract.test.js`
- `services/dashboard-api/sse-push-contract.test.js`
- `workspace-main/scripts/calendar-workflow.test.js`
- `workspace-main/scripts/dashboard-workflow.test.js`
- `workspace-daily-tracker/scripts/daily-goal-scheduler.test.js`

Plus the shared-router test suite (`node --test index.test.js`, 21/21). Re-run
these before and after every change to catch regressions early.

---

## Priority Quick-Reference

| Priority | Item | Why |
|----------|------|-----|
| **1** | Due-Date Feature Phase 0 (Git baseline) | Blocks everything else — no rollback point |
| **2** | Due-Date Feature Phases 1–5 | Largest planned feature; rooting through |
| **3** | Re-add `contextPruning` (cold-start-safe) | Direct cost savings on every Haiku turn |
| **4** | Verify OpenRouter cache | Validates whether caching actually saves money |
| **5** | Trace NOC Phase 2 | Turns log browser into real diagnostic tool |
| **6** | Nightly QA steady-state check | Confirm the fix actually reduced token cost |
| **7** | Nutrition vendor cache / branded foods | Fills real gaps in food resolution |
| **8** | HA follow-up conversation | Makes voice multi-turn actually work |
| **9** | Dashboard SSE live push | Eliminates polling lag across all widgets |
| **10** | Execution-Log Archivist (§2.8) | Better long-term recall via knowledge distillation; no urgency — pure quality win, pick up when ready |
| **11** | Everything else in Tier 3 | Well-understood, individually small items |

---

*Last updated: 2026-08-06*