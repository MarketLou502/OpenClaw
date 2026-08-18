# Spanish Tutor — Project Handoff

**Date:** 2026-08-10
**Author:** Pi coding agent (via OpenClaw)
**For:** Any AI taking over this project

This document hands off the **Spanish Tutor** sub-agent project for Aaron's
OpenClaw system. It's the same style as the OTHER handoff docs in this repo
(`services/home-assistant/HANDOFF-intent-wiring.md`, `docs/`). Read
`CURRENT_ARCHITECTURE.md` first if you're new to this system — it explains
how Main delegates to specialist agents.

---

## Project goal (from Aaron)

Aaron wants a **Spanish teacher sub-agent** he can talk to hands-free via the
Home Assistant Voice PE — like "a real tutor while doing chores." Key
requirements:

- **Continuous conversation:** once started, the Voice PE should keep its mic
  open (no wake word for each exchange) so back-and-forth tutoring feels
  natural.
- **Personality:** funny, warm, sarcastic. Gets serious/stern when he *repeats*
  the same mistake over and over. Not afraid of foul language or "ugh"/"hmm"
  when frustrated. Fun but relentless.
- **Correction style:** **end-of-thought** corrections — let him finish a
  sentence, then correct everything wrong in one pass. Not instant per-word.
- **Model:** **DeepSeek R1** via OpenRouter (user's choice).
- **Long-term progress tracking** across sessions.

---

## What's DONE (Phase 1 complete)

### 1. Spanish-tutor workspace created
`/Users/aaronmacmini/.openclaw/workspace-spanish-tutor/`

| File | Purpose |
|---|---|
| `SOUL.md` | Personality + teaching method + session lifecycle. THE key file — implements the funny/sarcastic/stern-when-repeating persona, end-of-thought corrections, voice-mode specifics. |
| `IDENTITY.md` | Name, role, emoji (💃), vibe. |
| `USER.md` | What works / doesn't work for Aaron (prefers real/sarcastic teachers, hates sanitized feedback). |
| `AGENTS.md` | Session startup checklist + memory rules. |
| `TOOLS.md` | Full progress-db schema + read/write `sqlite3` queries + brainstormed scripts. |
| `HEARTBEAT.md` | Retired — no proactive messages. |
| `scripts/init-db.js` | One-time DB + seed setup. **Already run** — DB exists. |
| `progress.db` | SQLite DB. Already initialized and seeded with 15 starter concepts. |

### 2. `progress.db` schema (already live)
```sql
concepts (id, name UNIQUE, category, level, strength, last_reviewed, created_at)
mistakes (id, concept_id FK, spoken_phrase, correct_version, correction_notes, session_date, created_at)
sessions (id, started_at, ended_at, topics, mistake_count, notes)
```
Seeded with 15 concepts (subjunctive weakest at 0.1, stem-changers 0.3,
preterite 0.3, etc.). This is what enables cross-session pattern detection
("you've mixed up por/para 6 times this week").

**2026-08-10 addendum — CEFR + SM-2 upgrade (researched, not just Phase 1's
guesswork):** Aaron was worried an open-ended "teach him Spanish" mandate
would drift for months with no real sense of progress. Researched three
things — CEFR proficiency levels (A1-C2, the standard framework), the SM-2
spaced-repetition algorithm (same one Anki uses), and Krashen's
comprehensible-input/i+1 principle — and wired all three in via
`scripts/migrate-cefr-sm2.js` (already run):
- `profile` table: single-row current CEFR level, the actual curriculum spine.
- `cefr_skills` table: 36 concrete "can-do" milestones (6 per level) to mark
  done as Aaron demonstrates them — this is the visible progress signal.
- `concepts` gained real SM-2 fields (`ease_factor`, `interval_days`,
  `repetitions`, `next_review_date`) instead of a hand-nudged strength
  float. `scripts/review-update.js --concept X --quality 0-5` applies the
  actual algorithm after every drill.
- SOUL.md's session-start now reads ONE bounded snapshot query (level + due
  reviews + open skills + last session) instead of history — this is the
  answer to "won't a new session be bloated / lose context": it was never
  going to read raw history, it reads a small deterministic summary that
  stays the same size no matter how many months have passed.
- SOUL.md's teaching method now targets comprehensible input at
  current-level-plus-one, calibrated by the CEFR level in `profile`.
See `TOOLS.md` for the full query set.

### 3. `openclaw.json` updated — NOW VALID ✅
The JSON was initially broken by a bad edit (an extra `}` at line 821), but
**this is now fixed and validated.** Three changes made:

1. **Added `deepseek/deepseek-r1`** to the OpenRouter model list.
2. **Registered `spanish-tutor` agent** with:
   - workspace `/Users/aaronmacmini/.openclaw/workspace-spanish-tutor`
   - model primary `openrouter/deepseek/deepseek-r1`, fallback `ollama/llama3.1:8b`
   - `memorySearch.enabled: true`
   - `tools.deny`: blocks web/ui/sessions/nodes/agents/cron/gateway/process/
     image/tts/pdf/dir/file/session_status/subagents/message/edit/write
   - `fs.workspaceOnly: true`
3. **Added `spanish-tutor` to `tools.agentToAgent.allow`.**

**NOTE:** `spanish-tutor` does NOT have an `agentDir` field set, unlike all
other agents (they point to `agents/<id>/agent`). If the agent fails to boot,
it likely needs an `agentDir` — check whether OpenClaw auto-creates it or
requires it. This is the most likely thing to verify when testing.

---

## Phases 2-3: DONE and verified live (2026-08-10)

Implemented in `services/ha-voice-adapter/server.js`, tested through the real
`/voice` HTTP endpoint after a `launchctl kickstart` of the live service
(with Aaron's go-ahead — it's the production kitchen-speaker path):

- `SPANISH_ENTER_RE` / `SPANISH_EXIT_RE` regexes detect start/stop phrases
  ("let's do spanish", "estoy listo", "gracias, adiós", etc).
- `spanishModeByDevice` is a sticky per-device Map (last-active timestamp),
  checked before `routeRoutineRequest()` so grammar/food fast-paths never
  see Spanish text mid-lesson. Auto-clears after `SPANISH_MODE_IDLE_TIMEOUT_MS`
  (20 min, env-overridable) if no exit phrase ever comes — the safety net
  for gotcha #3/#4 below.
- `runAgentTurn()` was generalized to take `agentId`/`sessionKey`/prompt
  overrides instead of hardcoding Main; `buildMainTurnParams()` and
  `buildSpanishTutorTurnParams()` supply each agent's specific values so no
  gateway/timeout/TTS plumbing is duplicated (the decided approach —
  extend in place, not a sibling service).
- Session key is `agent:spanish-tutor:${deviceSlug}` — **not** a bare
  `spanish_tutor:${deviceSlug}` as originally planned. Confirmed via direct
  gateway test that a bare key defaults to agent "main" and gets rejected
  for any other agentId; the Gateway requires the `agent:<agentId>:` prefix.
  This fully resolves gotcha #2 (session isolation) with the actual correct
  format, not just a plan.
- `agentDir` gotcha (#1) is resolved: **not required**. Direct gateway test
  confirmed `spanish-tutor` boots fine without it — session storage
  auto-derives to `agents/spanish-tutor/sessions/`.
- Live-tested full loop through the real endpoint: enter → stayed in mode
  across a turn with no wake word needed → exact exit phrase closed the
  mic (`expectsReply:false`) → next request correctly went back through the
  normal grammar router (verified via `logs/voice-fastpath.jsonl`: routes
  logged as `spanish-tutor-enter` → `spanish-tutor` → `spanish-mode-exit` →
  `router`). The agent's replies matched SOUL.md's personality and correctly
  referenced the live CEFR level from `progress.db` unprompted.

## What's NEXT (Phase 4-5 not started)

### Phase 2: Continuous conversation wiring (the hard part)
This is the crux of the whole project and needs the most thought. Current
voice flow (read `services/ha-voice-adapter/server.js` and
`services/home-assistant/custom_components/openclaw_main/conversation.py`):

```
Voice PE "Hey Jarvis" → HA Assist pipeline
  → custom_components/openclaw_main/ (ConversationEntity proxy)
  → POST http://host.docker.internal:18796/voice (ha-voice-adapter)
  → shared-routine-router (deterministic grammar match OR food fast path OR fallthru)
  → Main agent (delegates to specialists)
  → reply → Piper TTS → Voice PE
```

**The open-mic mechanism already exists.** In
`conversation.py`, the proxy returns `continue_conversation=bool(data.get("expectsReply"))`.
When `expectsReply` is true, Home Assistant keeps the satellite listening
without the wake word. Currently `ha-voice-adapter` sets it via a heuristic
(trailing "?") — see `expectsFollowUp()` in `server.js`.

**Planned approach (Phase 2):**
1. Add a **"SpanishMode" / "ExitSpanishMode"** intent to
   `services/shared-routine-router/sentences/en/` (new `spanish.yaml`), wired
   in `routeRoutineRequest()` (`services/shared-routine-router/index.js`).
2. Add mode-state management to `ha-voice-adapter`: when "start Spanish" is
   detected, set a per-device sticky flag; while set, ALL subsequent utterances
   route to the `spanish-tutor` agent (NOT Main) and ALWAYS return
   `expectsReply: true`. "stop / gracias / exit" clears the flag → back to Main.
3. The tutor agent is reached via the OpenClaw Gateway WebSocket protocol —
   mirror `runAgentTurn()` in `ha-voice-adapter/server.js` but with:
   - `agentId: 'spanish-tutor'`
   - a separate `sessionKey` (e.g. `spanish_tutor:kitchen`) so its
     conversation history stays isolated from Main's session.
   - `bootstrapContextMode` / `promptMode` still to be decided (tutor needs
     its workspace docs + TOOLS.md to read progress.db).

**Recommended reading before Phase 2:**
- `services/ha-voice-adapter/server.js` (full read — has `runAgentTurn`,
  `expectsFollowUp`, session-idle-reset logic you'll want to mirror)
- `services/home-assistant/ha-config/configuration.yaml` (the `rest_command`
  + `intent_script.AskMain`)
- `services/home-assistant/custom_components/openclaw_main/conversation.py`
  + `const.py` (the ConversationEntity proxy + how continue_conversation flows)
- `services/shared-routine-router/index.js` + `recognize.py` (matchIntent,
  routeRoutineRequest, the switch statement pattern for new intents)
- `services/shared-routine-router/sentences/en/*.yaml` (sentence grammar format)
- `services/home-assistant/HANDOFF-intent-wiring.md` (prior HA wiring research)
- `CURRENT_ARCHITECTURE.md` (system-wide view)

### Phase 3: Tutor adapter / routing
**Decided (2026-08-10 audit): extend `ha-voice-adapter` in place**, not a
sibling service. Add a sticky per-device Spanish-mode flag near the top of
the existing request handler in `server.js`; when set, skip
`routeRoutineRequest()` entirely and call a `spanish-tutor`-targeted version
of `runAgentTurn()` (agentId + sessionKey swapped, always `expectsReply:
true`). Reuses the existing gateway-connection/timeout/TTS-stripping code
instead of duplicating it in a second file — avoids the exact
copy-drifts-out-of-sync failure mode already hit once with Main's routing
table (see server.js's own 2026-08-07 comment block).

### Phase 4: Personality + session flow refinement
Live-test the voice loop. Tweak `SOUL.md` based on what feels right. Verify
the progress-db read/write path works through the agent's tools.

### Phase 5: Progress tracking polish
Wire `spanish-workflow.js` CLI (sketched in TOOLS.md) for easy progress query
/ mistake logging. Consider pattern-detection alerts.

---

## Key files / where everything lives

| Item | Path |
|---|---|
| Spanish tutor workspace | `/Users/aaronmacmini/.openclaw/workspace-spanish-tutor/` |
| Personality prompt | `.../workspace-spanish-tutor/SOUL.md` |
| DB schema/queries | `.../workspace-spanish-tutor/TOOLS.md` |
| Progress database | `.../workspace-spanish-tutor/progress.db` |
| DB init script | `.../workspace-spanish-tutor/scripts/init-db.js` |
| Agent registration + model | `/Users/aaronmacmini/.openclaw/openclaw.json` |
| Voice adapter | `/Users/aaronmacmini/.openclaw/services/ha-voice-adapter/server.js` |
| HA ConversationEntity proxy | `.../services/home-assistant/ha-config/custom_components/openclaw_main/conversation.py` |
| Grammar router | `.../services/shared-routine-router/index.js` + `recognize.py` |
| HA sentences | `.../services/shared-routine-router/sentences/en/*.yaml` |
| HA config | `.../services/home-assistant/ha-config/configuration.yaml` |
| System architecture doc | `/Users/aaronmacmini/.openclaw/CURRENT_ARCHITECTURE.md` |
| Service tokens | `/Users/aaronmacmini/.openclaw/service-env/ha-voice-adapter.token` |

---

## Gotchas / things to watch

1. **RESOLVED — `agentDir`:** confirmed not required via a direct gateway
   test (2026-08-10). No config change needed.
2. **RESOLVED — `sessionKey` isolation:** uses `agent:spanish-tutor:${deviceSlug}`,
   confirmed the required format via the same test (a bare key defaults to
   agent "main" and the gateway rejects it for any other agentId). See
   `buildSpanishTutorTurnParams()` in `ha-voice-adapter/server.js`.
3. **RESOLVED — model:** switched to `deepseek/deepseek-v4-flash` (2026-08-10)
   — R1's reasoning-model latency risked blowing past `AGENT_TIMEOUT_MS`
   (45s). Live-tested, ~13-25s per turn.
4. **RESOLVED — `expectsReply` mic-forever risk:** `SPANISH_EXIT_RE` phrases
   close the mic explicitly (`expectsReply:false`); `SPANISH_MODE_IDLE_TIMEOUT_MS`
   (20 min, env-overridable) is the backstop if no exit phrase ever comes.
5. **Voice TTS** — replies get `stripForSpeech()` in ha-voice-adapter to remove
   emoji/smart-quotes. The tutor's spoken replies should avoid emoji.
6. **Personality is in SOUL.md, not code.** Tuning = editing that file; treat
   it as the source of truth for the teacher's voice.
7. **JSON edits to openclaw.json** — validate with
   `python3 -c "import json; json.load(open('openclaw.json'))"` after changes.
   The "same text appears twice in file" trap bit us once (two
   `sessions_yield` entries); use enough surrounding context in edit matches.

---

## To verify on next session
- [x] `openclaw.json` parses (confirmed 2026-08-10)
- [x] spanish-tutor agent boots — confirmed via direct gateway test, no `agentDir` needed
- [x] Phase 2/3 built and live-tested through the real `/voice` endpoint (2026-08-10)
- [ ] Phase 4: live-test the voice loop through the actual kitchen speaker (not just curl) and tune SOUL.md from what feels right in practice
- [ ] Phase 5: `spanish-workflow.js` CLI polish (progress query / mistake logging convenience wrapper) — `review-update.js` already covers the SM-2 half of this