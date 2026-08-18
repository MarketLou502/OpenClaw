# Deep Thinking Mode — AI Handoff

## Overview

This is a new feature: a runtime **"talking mode" / "deep thinking mode"** on
**Main** that switches Main's model to Claude Fable 5 and turns it into a
conversational, high-intelligence chief of staff. Sub-agents are NOT upgraded;
they stay on their regular models and provide data to Main when asked via
`sessions_send`.

**The core idea:** Main is Aaron's intelligent assistant. When talking mode is
on, Main switches to Fable 5 (1M context, extended reasoning) and can have
deep, multi-turn conversations — analyzing data from sub-agents, surfacing
patterns, making plans. When off, Main goes back to its normal model
(DeepSeek Flash) for fast, concise delegation.

---

## Status: Design Complete, Not Implemented

No code has been written yet. The design is locked in the design doc below.
No files have been changed. The implementation is ready to begin.

---

## Key Decisions (locked with Aaron)

| Decision | Value |
|---|---|
| **Intelligence layer** | **Main only.** Sub-agents stay on their normal models. |
| **Talking mode model** | `anthropic/claude-fable-5` (confirmed available in model catalog, 1M context, text+image, ~$10/M in / $50/M out) |
| **Normal model (restore)** | `openrouter/deepseek/deepseek-v4-flash` (Main's current primary) |
| **Model switching mechanism** | **Config swap** via a whitelisted wrapper script (`deep-mode.sh`). Changes `main.model.primary` in `openclaw.json`, triggers hot reload. |
| **Mode stickiness** | Sticky until explicitly turned off. State persisted in `state/deep-thinking.json`. |
| **Activation phrases** | "turn on deep thinking mode", "let's go into talking mode", "conversational mode" |
| **Deactivation phrases** | "turn off deep thinking mode", "exit talking mode", "back to normal" |
| **Voice support** | In-scope. Home Assistant voice PE already routes to Main. Multi-turn follow-up (no wake word needed between turns) is a prerequisite — not yet built. |
| **Single-active-mode** | Yes. Only one mode at a time. Activating a new mode while one is active is a no-op. |
| **Cost acceptance** | Aaron is okay paying for Fable 5 tokens during talking mode. |

---

## Reference Documents (read these)

These are the source files the implementing agent MUST read before starting:

### Primary design document
- `~/.openclaw/plans/DEEP_THINKING_MODE.md` — the full design doc with
  architecture, relay flow, risk mitigations, implementation plan, verification
  checklist, and file list. **Start here.**

### Architecture context
- `~/.openclaw/CURRENT_ARCHITECTURE.md` — the system architecture. Essential
  for understanding how Main routes, how delivery-mirror works, and the
  existing tool restrictions.
- `~/.openclaw/workspace-main/SOUL.md` — Main's current operating instructions.
  Will need a new "Deep Thinking Mode" section added.
- `~/.openclaw/workspace-main/AGENTS.md` — Main's agent roster and session
  startup procedure. Will need talking-mode state awareness added.
- `~/.openclaw/workspace-main/TOOLS.md` — Main's available tools. Will need
  `deep-mode.sh` added.

### Config (model paths, agent structure)
- `~/.openclaw/openclaw.json` — the live config. Main's `model.primary` is
  `openrouter/deepseek/deepseek-v4-flash` and `model.fallbacks` is
  `["ollama/llama3.1:8b"]`. The agent has `id: main`. Note: this file is
  live and should be read-only during implementation — only `deep-mode.sh`
  should write to it.
- `~/.openclaw/agents/main/agent/plugins/anthropic/catalog.json` — model
  catalog showing `claude-fable-5` is available with 1M context.

### Key patterns to follow
- `~/.openclaw/plans/DESIGN-execution-log-archivist.md` — the design for
  the Archivist agent, which uses the same **whitelisted wrapper-script
  pattern** (`arc-read.sh`/`arc-write.sh`). Deep-mode.sh should follow the
  same convention: narrow, scoped commands, no arbitrary writes.
- `~/.openclaw/workspace-systems-qa/SOUL.md` — systems-qa uses the same
  script-boundary pattern. Good reference for how Main delegates to a
  script-based tool.
- `~/.openclaw/SYSTEM_WALKTHROUGH.html` — contains the `contextPruning`
  incident history (§3.7) explaining why config surgery was dangerous
  before. Read this to understand the risk profile of model swapping.

### Model routing / agent mechanism
- The CLI supports `openclaw agent --model <id>` per-run model override
  and `--thinking <level>` for reasoning control.
- Main's toolset: `sessions_send`, `session_status`, `sessions_history`.
  Main does NOT have `exec`, `sessions_spawn`, `edit`, `write`, or
  `file_write` (all denied).
- The delivery-mirror mechanism automatically pushes a sub-agent's reply
  text to the originating channel (iMessage/voice). This is relevant for
  how Main's responses reach Aaron during talking mode.

---

## What Has NOT Been Done (Clean Expectations)

- No code has been written. No files changed.
- The `deep-mode.sh` script does not exist.
- The `state/deep-thinking.json` does not exist.
- No SOUL.md / AGENTS.md / TOOLS.md files have been edited.
- No voice adapter changes have been made.
- No verification tests exist.
- No cron jobs or bindings have been modified.
- The `Planned-Openclaw-Upgrades.md` file has NOT been updated with
  this feature entry (it should be, after implementation).

---

## Implementation Plan (from design doc)

### Phase 1 — Foundation (model switch + state)
1. Create `workspace-main/scripts/deep-mode.sh` — activate/deactivate/status
   with openclaw.json model swap + state file management
2. Create `state/deep-thinking.json` with `active: false` initial state
3. Verify: hot reload after model string change in openclaw.json (test
   manually — this is the key risk to validate)
4. Verify: fallback to DeepSeek Flash fires if Fable 5 errors

### Phase 2 — Main's instructions
5. Update `workspace-main/SOUL.md` — add "Deep Thinking Mode" section with
   behavior directives
6. Update `workspace-main/AGENTS.md` — add talking-mode awareness at session
   start (read state file, adjust behavior)
7. Update `workspace-main/TOOLS.md` — add `deep-mode.sh` to available tools
   with usage rules

### Phase 3 — Activation/deactivation phrases
8. Add recognition phrases to Main's routing decision table in SOUL.md
9. Wire activation flow: user phrase → deep-mode.sh activate → acknowledge
10. Wire deactivation flow: user phrase → deep-mode.sh deactivate → acknowledge

### Phase 4 — Voice
11. Build voice follow-up / multi-turn support in
    `services/ha-voice-adapter/server.js` — the `continue_conversation` path
    flagged in `Planned-Openclaw-Upgrades.md` §2.6
12. Test voice talking mode end-to-end

### Phase 5 — Polish
13. Add `Planned-Openclaw-Upgrades.md` entry for Deep Thinking Mode
14. Write contract test or verification checklist
15. Real-world usage: do a talking-mode session, fix rough edges

---

## Files to Create or Modify

| File | Action | Phase |
|---|---|---|
| `workspace-main/scripts/deep-mode.sh` | **Create** — model swap + state management | 1 |
| `state/deep-thinking.json` | **Create** — initial `{active: false}` | 1 |
| `workspace-main/SOUL.md` | **Edit** — add Deep Thinking Mode section | 2 |
| `workspace-main/AGENTS.md` | **Edit** — add state-check at session start | 2 |
| `workspace-main/TOOLS.md` | **Edit** — add `deep-mode.sh` tool entry | 2 |
| *(no sub-agent files need changes)* | — | — |
| `services/ha-voice-adapter/server.js` | **Edit** — multi-turn follow-up | 4 |

---

## Risks and Mitigations

### 1. Config swap reliability
The model swap changes `main.model.primary` in `openclaw.json` — a live file
that the Gateway monitors. The `contextPruning` incident
(`SYSTEM_WALKTHROUGH.html` §3.7) showed hot-reload acceptance ≠ cold-start
acceptance. However, that was a **new schema field** being added; this is an
**existing field value** change. Lower risk, but still the #1 thing to test
manually.

**Mitigations:**
- `deep-mode.sh` saves `lastGoodModel` before swap
- On hot reload failure, `deep-mode.sh` does NOT set `active: true`
- Deactivation always restores the saved rollback value

### 2. Cold restart during talking mode
If the Gateway restarts while talking mode is active, the config file will
contain Fable 5 as Main's model (since `deep-mode.sh` wrote it). On cold
start, the model string should be validated normally. But if it doesn't
survive, `state/deep-thinking.json` will still say `active: true` while Main
runs on the default model. Main should detect this mismatch and auto-deactivate.

### 3. Delivery-mirror double-response
When Main queries a sub-agent via `sessions_send`, the sub-agent's reply goes
both to Main (via `sessions_send` return value) AND to Aaron (via
delivery-mirror). During talking mode, Main needs to handle this gracefully —
it should acknowledge receiving the data but not echo it, preventing
confusing double-texts. Verify this flow.

### 4. Fable 5 cost
$10/M input, $50/M output. A typical deep thinking conversation could burn
$2-10 easily. No spending cap has been discussed. Consider adding a
turn-limit suggestion or a wallet-awareness note in Main's instructions.

---

## Open Decisions for the Implementing Agent

1. **Does `deep-mode.sh` need fallback model management?** Main already has
   `model.fallbacks: ["ollama/llama3.1:8b"]` in config. If Fable 5 errors
   (API down, rate limit), the fallback fires. Does the script need to handle
   this specially, or is the runtime fallback sufficient?

2. **Delivery-mirror double-response mitigation.** How should Main handle the
   fact that sub-agent replies reach Aaron unprompted during talking mode?
   Options:
   - Accept it (sub-agent's raw data dump is useful context for Aaron)
   - Suppress it (not possible — delivery-mirror is compiled Gateway behavior)
   - Main prefaces its reply to acknowledge "I just got the data, here's
     what I think..."

3. **Spending awareness.** Should Main remind Aaron about Fable 5 costs
   after N turns, or recommend deactivation after a certain budget?

4. **Voice multi-turn priority.** Build before v1 voice talking mode works.
   Text talking mode ships without it. Decide order.

5. **Verification checklist.** The design doc has a checklist (see
   `DEEP_THINKING_MODE.md`). Run through it after each phase.

---

## Quick-Start for the Implementing Agent

1. Read `~/.openclaw/plans/DEEP_THINKING_MODE.md` (this is your primary guide)
2. Read `~/.openclaw/CURRENT_ARCHITECTURE.md` (understand the system)
3. Read `~/.openclaw/workspace-main/SOUL.md` and `AGENTS.md` (understand Main)
4. Read `~/.openclaw/SYSTEM_WALKTHROUGH.html` §3.7 (understand config risks)
5. Start Phase 1: write `deep-mode.sh`
6. Test the model swap manually before moving to Phase 2
7. Report findings to Aaron

---

*Handoff prepared 2026-08-10 by previous agent. Design decisions locked with Aaron.*