# Design: Execution-Log Archivist

Status: **Planning doc — not implemented** · 2026-08-06 (decisions locked with Aaron; build only when he picks it up)
Source: TencentDB Agent Memory analysis → in-house build recommendation
Index entry: `Planned-Openclaw-Upgrades.md` §2.8

---

## What This Does

A nightly cron job that reads Main's session trajectory files, distills durable
knowledge from the conversation — facts about Aaron, decisions, preferences,
recurring patterns, error signatures — and deposits structured knowledge
artifacts into the agent's workspace, where the existing `memorySearch` system
indexes and retrieves them automatically.

**Primary goal: memory quality, not token savings.** Aaron's request volume is
low, so the win is not compression — it's recall. `memorySearch` currently
searches raw transcripts, which are verbose and noisy; distilled artifacts make
search results hit the signal, not the noise. The cache-busting and token-cost
concerns that dominate TencentDB's pitch are secondary here. A small
`LATEST.md` "current state" preamble (in v1 scope) gives the context-map
benefit at negligible cost.

Distinct from OpenClaw's built-in context compaction
(`agents.defaults.compaction`) and the 04:00 `main-imessage-nightly-compact`
cron: those bound session size; this improves what the agent actually remembers.

---

## How It Differs From TencentDB's Approach

| Aspect | TencentDB | This design |
|---|---|---|
| Memory injection | Injected into system prompt every turn → breaks prompt cache | Written to disk → indexed by existing vector search → retrieved only when relevant |
| Cache impact | Severe (every turn busts cache) | Zero (no injection into context) |
| Security | Automated writes to persistent memory = prompt injection surface | Whitelisted wrapper scripts, workspace-only filesystem, same proven pattern as systems-qa |
| Architecture fit | Built for single-agent systems | Matches OpenClaw's multi-agent, isolated-session, cron-job pattern |
| Portability | Proprietary structured format | Plain JSON + Markdown, same as existing memory files |

---

## Architecture

### New Agent: `archivist`

A specialist agent with no channel binding, analogous to `systems-qa`.
Registered in `openclaw.json` with:
- `tools.fs.workspaceOnly: true`
- `memorySearch: { enabled: false }` (no need — it writes for other agents, doesn't search for itself)
- `tools.deny`: `imsg`, `group:web`, `group:ui`, `group:sessions`, `group:nodes`, `group:agents`, `cron`, `gateway`, `process`, `image`, `tts`, `pdf`, `subagents`, `message`, `sessions_spawn`, `sessions_send`, `sessions_list`, `sessions_yield`

### File Layout

```
~/.openclaw/agents/archivist/
  sessions/          # (created by runtime)
  agent/             # (created by runtime)

~/.openclaw/workspace-archivist/
  AGENTS.md
  SOUL.md            # Job procedure (the main instruction file)
  TOOLS.md           # Wrapper script usage only
  USER.md
  IDENTITY.md
  HEARTBEAT.md
  scripts/
    arc-read.sh      # Whitelisted read operations
    arc-write.sh     # Whitelisted write operations
  memory/            # Own run digests
  state/
    last_reviewed_at  # Watermark (unix-ms timestamp)
```

### Cron Job Registration

```bash
npx openclaw cron add \
  --name "execution-log-archivist" \
  --description "Nightly distillation of main's session trajectories into structured knowledge artifacts" \
  --agent archivist \
  --cron "0 3 * * *" \
  --session isolated \
  --model "openrouter/deepseek/deepseek-v4-flash" \
  --message "Run the nightly execution-log archivist job per SOUL.md." \
  --timeout-seconds 600 \
  --no-deliver \
  --stagger 60s
```

Scheduled at **03:00 daily** — deliberately before:
- `main-imessage-nightly-compact` at 04:00 (summarize before compaction prunes raw sessions)
- `systems-qa-nightly-routing-review` at 05:00 (avoids resource contention)

**Model rationale:** `openrouter/deepseek/deepseek-v4-flash` (locked with
Aaron 2026-08-06) — the same model Main runs on, with a 1M-token context
window at $0.10/M input. Reading multi-MB trajectory files is cheap at that
rate, and summarization/distillation is the kind of long-context reading
DeepSeek Flash is well-suited to. This job does not need Haiku's extra
reasoning margin the way systems-qa's grammar-diff job does.

---

## Wrapper Scripts

### `arc-read.sh` — Whitelisted Reads

```
arc-read.sh watermark
  → Reads state/last_reviewed_at (or "0" if absent)

arc-read.sh sessions-index
  → Reads agents/main/sessions/sessions.json (full session index)

arc-read.sh agent-trajectories <agentId> <since-unix-ms>
  → Reads trajectory files for the given agent, filtered to entries
    at or after the watermark. Covers multiple session files.
    Output: stream of JSONL lines with types:
      prompt.submitted, tool.invocation, tool.result, model.completed, session.ended

arc-read.sh agent-sessions <agentId> <since-unix-ms>
  → Reads session JSONL files for the given agent, filtered to message
    lines at or after the watermark. (Future use — not needed for v1.)
```

### `arc-write.sh` — Whitelisted Writes

```
arc-write.sh digest <YYYY-MM-DD>
  → Appends stdin to workspace-archivist/memory/<YYYY-MM-DD>.md
    (own run digest — turn counts, agents covered, summary of what was found)

arc-write.sh deposit-facts <agentId> <YYYY-MM-DD>
  → Writes stdin as structured JSON to:
      workspace-<agentId>/memory/compacted/<YYYY-MM-DD>.json
    This is the structured knowledge artifact: key facts, decisions,
    recurring patterns, completed operations.

arc-write.sh deposit-digest <agentId> <YYYY-MM-DD>
  → Writes stdin as human-readable Markdown to:
      workspace-<agentId>/memory/compacted/<YYYY-MM-DD>.md
    A concise summary of the session for that day.

arc-write.sh watermark
  → Stamps current system clock (unix-ms) to state/last_reviewed_at.
    Only call AFTER all deposits succeeded.
```

The `deposit-*` operations are the narrow, whitelisted exception for
cross-workspace writes — exactly like `qa-propose.sh consume-voice-fastpath-log`.
They only write to fixed paths under `workspace-<agentId>/memory/compacted/`
and nowhere else.

---

## Summarization Procedure (SOUL.md content)

The archivist runs as an **isolated session** — no memory of prior runs except
what was deliberately written to disk. The SOUL.md contains the full procedure:

### Steps

**1. Read watermark**
```
arc-read.sh watermark
```
Returns unix-ms timestamp of last successful run, or `0`.

**2. Gather source data**
```
arc-read.sh sessions-index
```
— find all `agent:main:*` sessions (plus any other registered agents) with
their IDs and timestamps.

For each relevant session with activity since the watermark:
```
arc-read.sh agent-trajectories main <watermark>
```
— streams trajectory JSONL entries. Each entry has a type (`prompt.submitted`,
`tool.invocation`, `tool.result`, `model.completed`, `session.ended`),
timestamp, model used, tool name + args + result, and assistant text.

**Empty-window guard.** If the window contains no new activity (typical on
low-volume days), skip classification and deposits entirely: write a one-line
own digest and advance the watermark. Never fabricate entries.

**3. Classify and extract**

For each tool call and message interaction, classify into one of:

| Category | Description | Retention |
|---|---|---|
| `user-state-change` | Aaron stated a preference, goal, or life event | Keep as permanent fact |
| `decision-record` | Aaron made a decision (e.g., "don't do X anymore") | Keep as decision |
| `completed-operation` | A tool call succeeded with meaningful result | Summarize, don't keep raw |
| `recurring-pattern` | Same request type seen 2+ times in window | Flag as pattern |
| `error-or-failure` | A tool call failed or the model hit an error | Keep error signature |
| `ephemeral` | Simple lookup/answer with no lasting significance | Discard |

**4. Produce structured artifacts**

For each agent being summarized, produce two files:

**Structured JSON** (`compacted/YYYY-MM-DD.json`):
```json
{
  "date": "2026-08-06",
  "agentId": "main",
  "turnCount": 14,
  "sessionCount": 3,
  "facts": [
    {"type": "preference", "text": "Aaron prefers brief confirmations", "source": "session-xxx", "confidence": "stated"}
  ],
  "decisions": [
    {"text": "Use marketlou.com for task scheduling calendar", "source": "session-yyy"}
  ],
  "patterns": [
    {"phrase": "add [item] to grocery list", "count": 4, "routed": "fast-path"}
  ],
  "errors": [
    {"tool": "calendar-add", "session": "session-zzz", "signature": "timeout on Google Calendar API"}
  ],
  "completedOperations": [
    {"summary": "Logged workout: 30min run", "count": 2}
  ]
}
```

**Human-readable digest** (`compacted/YYYY-MM-DD.md`):
```markdown
# Main — 2026-08-06

14 turns across 3 sessions.

## Facts learned
- Aaron prefers brief confirmations over detailed summaries

## Decisions
- Using marketlou.com as task-scheduling calendar

## Operations completed
- 2 workouts logged (30min run each)
- 4 grocery list additions
- 1 calendar event added

## Errors encountered
- calendar-add timed out once (Google Calendar API)

## Patterns detected
- "add [item] to grocery list" → fast-path routed (4× this window)
```

**5. Write outputs**

Deposit into the target agent's workspace:
```
arc-write.sh deposit-facts main 2026-08-06 < artifact.json
arc-write.sh deposit-digest main 2026-08-06 < digest.md
```

Write own run digest:
```
arc-write.sh digest 2026-08-06 < run-summary.txt
```

**6. Advance watermark**
```
arc-write.sh watermark
```
— only after all deposits in step 5 succeeded. If anything failed,
do NOT call this — let the unprocessed data get picked up again tomorrow.

### Security Rules

- **Never read directly with `read` or `exec`.** Always use `arc-read.sh`.
- **Never write directly with `write` or `exec`.** Always use `arc-write.sh`.
- **No modification of other agents' files.** The `deposit-*` operations only
  write under `workspace-<agentId>/memory/compacted/`.
- **No modification of config, cron, or gateway.** You summarize; you don't change.
- **No deletion of any files.** The existing compaction job handles pruning.
- **No auto-loading your output into any agent's context.** That's the agent's
  choice via memorySearch.

---

## Consumption: How Other Agents Use the Output

The compacted files land in `workspace-<agentId>/memory/compacted/`.

**The existing `memorySearch` system already indexes this directory** because
it watches the entire workspace `memory/` tree for changes (`onSessionStart: true`,
`watch: true`, `watchDebounceMs: 1500`). The compacted JSON and Markdown files
are chunked at 400 tokens with 80-token overlap and embedded into the vector
index alongside all other memory files.

When Main starts a new session and searches for relevant context (via its
existing `memorySearch` tool), the compacted summaries appear in search results
naturally — weighted by the 14-day temporal decay half-life so recent summaries
rank higher.

**The only existing-file change in v1** is one instruction added to Main's
`AGENTS.md`: "Read `memory/compacted/LATEST.md` at session start for a
current-state overview." That is the context-map benefit from TencentDB at
~200 tokens per session start — trivial, and Main's session is rebuilt by the
04:00 compact job anyway, so cache impact is minimal. If `session-logs`
telemetry ever shows the preamble as a measurable cost, the fix is to remove
that one line; nothing else depends on it.

---

## Phase 1 Scope (This Build)

- ✅ One agent: `archivist`
- ✅ One target: `main` only (conversation owner; the interface Aaron actually talks to)
- ✅ Output: structured JSON + Markdown digest per day, plus a maintained `LATEST.md`
- ✅ Small context preamble: Main reads `LATEST.md` at session start (~200 tokens)
- ✅ No pruning of raw session files (existing compaction handles this)
- ✅ No cross-agent summarization (main only for now)

## Future Scope (Explicitly Deferred)

| Feature | When |
|---|---|
| Add more target agents (health-tracker, finance-agent, etc.) | After v1 stabilizes |
| LATEST.md cost check | Confirm via `session-logs` that the ~200-token preamble is unmeasurable; drop the AGENTS.md line if it shows up |
| Automatic cleanup of summarized trajectory files | If disk usage becomes a concern |
| Multi-agent single-run (one cron job, multiple deposits) | If per-agent jobs become unwieldy |
| Error pattern aggregation across time windows | After 2+ weeks of data |

---

## Implementation Plan

### Files to Create (6 files)

| File | Est. time | Description |
|---|---|---|
| `openclaw.json` agent entry | 15min | Register the archivist agent in the config |
| `workspace-archivist/SOUL.md` | 2h | Full job procedure (the core of the feature) |
| `workspace-archivist/TOOLS.md` | 30min | Tool usage rules + wrapper script docs |
| `workspace-archivist/AGENTS.md` | 15min | Session startup instructions |
| `workspace-archivist/scripts/arc-read.sh` | 1h | Whitelisted read operations |
| `workspace-archivist/scripts/arc-write.sh` | 1h | Whitelisted write operations |

Plus: identity/ownership files (IDENTITY.md, USER.md, HEARTBEAT.md) — 15min.

### Steps

1. Create agent workspace directory structure
2. Write the two wrapper scripts
3. Write SOUL.md with the full summarization procedure
4. Write TOOLS.md, AGENTS.md, identity files
5. Register agent in `openclaw.json` (add to `agents.list`)
6. Register cron job via `openclaw cron add`
7. Cold-restart test: `launchctl kickstart -k gui/501/ai.openclaw.gateway`
8. Dry-run: `openclaw cron run execution-log-archivist`
9. Verify output files landed in `workspace-main/memory/compacted/`
10. Verify `memorySearch` indexes them (manual `memorySearch` call test)

### Estimated Total Effort

**~5-6 hours of implementation**, plus 2-3 hours of testing/iteration.
The bulk of the work is writing the SOUL.md procedure (the prompts/instructions
that determine summary quality) and testing the wrapper scripts.

---

## Decisions Locked (2026-08-06)

- **Goal:** knowledge extraction from conversation (durable facts about Aaron,
  decisions, preferences) — NOT token savings. Aaron's request volume is low.
- **Model:** `openrouter/deepseek/deepseek-v4-flash` — the same model Main
  runs on; 1M context window at $0.10/M input makes reading trajectory files
  cheap. Chosen over Haiku deliberately.
- **LATEST.md preamble:** in v1 scope (read at Main session start, ~200 tokens).
- **Output verbosity:** concise — facts, decisions, patterns, errors, completed
  operations. No full tool-call traces.

## Open Decisions (only if the plan is picked up and changed)

1. v1 targets: `main` only, or include specialists (health-tracker,
   finance-agent, scheduler) in the same first build?
2. Cadence: daily (default) vs. every-2-3 days, given low volume.
3. Should the archivist ever prune raw trajectory files itself? (Deferred by
   design — the existing compaction job owns pruning.)