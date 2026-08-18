# Design: Deep Thinking Mode ("Talking Mode")

Status: **Design doc — not implemented** · compiled 2026-08-10 · decisions locked with Aaron
Source: user request for higher-intelligence conversational access with his OpenClaw assistant
Index entry: planned feature — see `Planned-Openclaw-Upgrades.md` (add to it if merging)

---

## What This Is

A runtime **mode** on **Main only** that gives Aaron a conversational,
high-intelligence interface to his OpenClaw system. When activated, Main
switches to Claude Fable 5 (1M context, extended reasoning) and becomes a
deep conversational partner — Aaron's chief of staff with full reasoning
capability. Sub-agents stay on their regular models; Main queries them via
`sessions_send` for data, reads `sessions_history`, and synthesizes insight.

**The key insight:** the intelligence upgrade is AT MAIN. Sub-agents are data
providers, not conversational partners. This avoids dual-session complexity,
per-agent provisioning, and model-switching infrastructure.

---

## Core Decisions (locked with Aaron 2026-08-10)

| Decision | Choice |
|---|---|
| Intelligence layer | **Main only.** Sub-agents stay on their regular models (DeepSeek Flash / Llama 3.1 / Qwen). |
| Model | **Claude Fable 5** (`anthropic/claude-fable-5`), 1M context, extended reasoning. |
| Model switching mechanism | **Config swap via whitelisted script.** `deep-mode.sh activate` changes `main.model.primary` in `openclaw.json` to Fable 5 and triggers a config re-read. Deactivation restores the original model. |
| Activation phrase | "turn on deep thinking mode", "let's go into talking mode", "conversational mode" |
| Deactivation phrase | "turn off deep thinking mode", "exit talking mode", "back to normal" |
| Mode stickiness | Sticky until explicitly turned off. Main checks state at every session start. |
| Voice | In-scope. Home Assistant voice PE routes to Main (as it already does); Main on Fable 5 thinks and responds. Multi-turn follow-up (keep channel open without wake word) is a prerequisite — flagged in `Planned-Openclaw-Upgrades.md` §2.6, not yet built. |
| State tracking | Single JSON file: `state/deep-thinking.json`. Written by `deep-mode.sh`, read by Main at every session start. |

---

## Why Config Swap (Not Dual Sessions, Not Per-Agent Binding)

The original design draft proposed per-agent dual sessions (normal + Fable 5)
with session-key routing. Aaron clarified: **the intelligence upgrade is
Main-only.** Sub-agents don't get the better model — they just provide data
to Main via `sessions_send`. This eliminates the entire dual-session,
per-agent provisioning layer.

The config swap approach (changing `main.model.primary` in `openclaw.json`)
is the simplest path:
- It changes an **existing field value**, not a new schema field.
- The `contextPruning` crash (`SYSTEM_WALKTHROUGH.html` §3.7) was about
  adding a **brand-new config section** that the cold-start validator didn't
  expect. Swapping a model string is lower-risk.
- If the hot reload rejects the model string, Main simply stays on its
  current model — no crash-loop.

**Mitigations to implement:**
1. `deep-mode.sh` writes a `last-good` rollback value before the swap, so
   deactivation can always restore the known-good config.
2. If hot reload fails during activation, the script logs the failure and
   does NOT update `state/deep-thinking.json` (so Main won't assume mode is on).

---

## Relay Flow

```
You (iMessage): "let's go into talking mode"

Main reads → recognizes "talking mode"
  → call deep-mode.sh activate
      · change main.model.primary → anthropic/claude-fable-5
      · write state/deep-thinking.json {active: true}
      · trigger config re-read (or note for next turn)
  → acknowledge: "Talking mode on. I'm running on Fable 5. What's on your mind?"

You: "I feel like my eating has gotten repetitive. Can you check?"

Main (on Fable 5):
  → sessions_send to meal-planner: "List my recent meal patterns"
  → sessions_send to health-tracker: "Show me my food log for the last 30 days"
  → reads sessions_history of both
  → synthesizes across the data
  → replies with insight

You: "Can you suggest a few things I should add to my grocery list based on that?"

Main → continues the conversation, proposes specific grocery items.

You: "that's enough. back to normal."

Main → call deep-mode.sh deactivate
  → restore original model → write state → acknowledge
```

---

## State

Single file: `~/.openclaw/state/deep-thinking.json`

```json
{
  "active": false,
  "activatedAt": null,
  "lastGoodModel": "openrouter/deepseek/deepseek-v4-flash"
}
```

When `active: true`, Main reads this at the start of every turn and adjusts
its behavior: more conversational, deeper reasoning, explicit data-synthesis
from sub-agents.

---

## Wrapper Script: `deep-mode.sh`

Lives at `workspace-main/scripts/deep-mode.sh`. Main calls it with one of:

```
deep-mode.sh activate
    · save current main.model.primary as lastGoodModel
    · write main.model.primary → anthropic/claude-fable-5 in openclaw.json
    · write state/deep-thinking.json {active: true, lastGoodModel: "..."}
    · trigger config hot reload (or flag for next session start)
    · on failure: do NOT update state; log error

deep-mode.sh deactivate
    · read lastGoodModel from state
    · restore main.model.primary in openclaw.json
    · write state/deep-thinking.json {active: false}
    · trigger config hot reload

deep-mode.sh status
    · echo current mode + agent state
```

Uses the same whitelisted-script pattern as `systems-qa`'s `qa-read.sh`/`qa-propose.sh`
and the designed `arc-read.sh`/`arc-write.sh`. Main may only call these three
subcommands.

---

## Main's Behavioral Changes in Talking Mode

Main's SOUL.md / AGENTS.md gain a new section. When talking mode is active:

- You are running on **Claude Fable 5** (1M context, extended reasoning).
- You are a deep conversational partner — Aaron's chief of staff. Be
  insightful, proactive, and analytical.
- You have `sessions_send`, `session_status`, and `sessions_history`. Use
  these to query any sub-agent for data relevant to Aaron's questions.
- Synthesize across sub-agents' data to surface patterns, gaps, and
  suggestions Aaron wouldn't think to ask.
- Do NOT attempt to mimic or impersonate sub-agents. You are Main — the
  coordinator. You reference sub-agents' data, not their identity.
- When you need data, call `sessions_send` to the sub-agent and wait for the
  result. If you need historical context, call `sessions_history`.
- Be proactive within reason: if you spot something concerning in the data
  (nutrient deficiency, spending spike, missed goal streak), flag it.
- You can propose plans ("I'll draft a revised meal plan and send the grocery
  list to the meal-planner — want me to do that?") and implement them on
  Aaron's approval.

When talking mode is OFF:
- Return to normal behavior: fast routing, concise delegation, no deep
  analysis. Your model is back to DeepSeek Flash.

---

## Interaction: Sub-Agent Data Queries

Main uses `sessions_send` to ask sub-agents for data. The sub-agents run
their normal models and respond with whatever data they can access. No
sub-agent changes are needed for talking mode to query them.

Example query pattern:
```
Main → sessions_send to meal-planner:
  "Aaron is asking about his eating patterns. I need your food log data
   for the last 30 days — meal types, recipe names, macros, takeout flags,
   and any preference analysis you have. Send me the data as text."
```

Main receives the sub-agent's response (via `sessions_send`'s return value)
and uses it in its synthesis. The delivery-mirror also sends the sub-agent's
reply text to Aaron, but for talking mode this is secondary — Main is the
conversational voice and may choose to override or build on the sub-agent's
raw data.

---

## Risk Mitigations

| Risk | Mitigation |
|---|---|
| Config hot-reload fails | Script saves `lastGoodModel` before swap; does NOT set `active: true` if reload fails. Turn's normal model runs instead. |
| Cold restart during mode | `state/deep-thinking.json` persists. If `active: true` but model is back to default (cold restart discards hot-reload changes), Main detects the mismatch and treats the mode as auto-deactivated, then logs a note. |
| Fable 5 API error | DeepSeek Flash is already in main's `fallbacks` array. If Fable 5 errors, the fallback kicks in automatically — no special handling needed. |
| Two concurrent mode activations | Not possible — only one `active` flag. Calling activate when already active is a no-op (log + acknowledge). |

---

## Implementation Plan

### Phase 1 — Foundation (model switch + state)

1. Create `workspace-main/scripts/deep-mode.sh` — activate/deactivate/status
   with openclaw.json model swap + state file management
2. Create `state/deep-thinking.json` with `active: false` initial state
3. Verify: hot reload after model string change in openclaw.json (test
   manually — this is the key risk to validate)
4. Verify: fallback to DeepSeek Flash fires if Fable 5 errors

### Phase 2 — Main's instructions

5. Update `workspace-main/SOUL.md` — add "Deep Thinking Mode" section with
   behavior directives (from this doc's behavioral section above)
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
|------|--------|-------|
| `workspace-main/scripts/deep-mode.sh` | **Create** — model swap + state management | 1 |
| `state/deep-thinking.json` | **Create** — initial `{active: false}` | 1 |
| `workspace-main/SOUL.md` | **Edit** — add Deep Thinking Mode section | 2 |
| `workspace-main/AGENTS.md` | **Edit** — add state-check at session start | 2 |
| `workspace-main/TOOLS.md` | **Edit** — add `deep-mode.sh` tool entry | 2 |
| *(no sub-agent files need changes)* | — | — |
| `services/ha-voice-adapter/server.js` | **Edit** — multi-turn follow-up | 4 |

---

## Verification Checklist

- [ ] `deep-mode.sh activate` swaps model in openclaw.json, writes state
- [ ] Model swap survives a hot reload (cold-start test is bonus)
- [ ] Main reads state file at session start, adjusts behavior
- [ ] "turn on talking mode" → Main activates → acknowledges
- [ ] Main queries sub-agents via `sessions_send` during talking mode
- [ ] Main synthesizes sub-agent data into conversational insight
- [ ] "turn off talking mode" → Main deactivates → restores normal model
- [ ] Fallback to DeepSeek Flash if Fable 5 errors
- [ ] Cold restart with `active: true` auto-deactivates gracefully

---

## Open Items (for the implementing agent)

1. **Target model cost.** Fable 5 is $10/M input, $50/M output (from catalog).
   This matters for budgeting. Consider adding a spending-cap reminder or a
   turn-limit (e.g., "after 20 turns, suggest deactivating").
2. **Voice multi-turn priority.** Build before v1 voice talking mode works.
   Text talking mode ships without it.
3. **State file path.** Confirm absolute path is `~/.openclaw/state/deep-thinking.json`
   and that Main's filesystem access covers it (Main has `group:fs` allowed).
4. **Sessions_send data flow.** When Main queries a sub-agent, the
   delivery-mirror also pushes the sub-agent's reply to Aaron. For talking
   mode, Main should acknowledge that it received the data but not repeat it.
   Verify this doesn't cause confusing double-responses.
5. **Potential edge case:** sub-agent has no relevant data (empty food log,
   no transactions). Main should handle gracefully: "I don't have enough data
   to give you a meaningful answer yet."