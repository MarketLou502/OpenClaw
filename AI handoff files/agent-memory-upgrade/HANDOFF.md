# Agent Memory Upgrade — AI Handoff

## Overview

Aaron wants to steal four ideas from Tencent Cloud's open-source
**TencentDB Agent Memory** project (github.com/TencentCloud/TencentDB-Agent-Memory,
MIT license) and adapt them into OpenClaw, WITHOUT adopting their actual
stack (no Docker Memory-Core/Memory-Hub/Proxy services, no sqlite-vec
dependency required unless a later decision picks it). The four ideas,
in Aaron's own priority order of interest:

1. **Automatic fact extraction** — an LLM pass that mines every
   conversation for atomic facts (preferences, decisions, constraints)
   instead of relying on an agent to notice and hand-write a memory.
2. **Scenario/project bundles** — facts auto-grouped into topic bundles
   (e.g. "finance dashboard rebuild") so a whole cluster of context loads
   at once instead of one fact at a time.
3. **Persona layer** — a running, auto-updated "who is this user, what
   are their patterns" profile, separate from raw facts.
4. **Symbolic short-term memory** — mid-conversation compression: instead
   of keeping raw tool-call JSON/output in a live session's context,
   compress it into a compact shorthand (Tencent uses Mermaid diagrams)
   representing "the shape of what happened." This is the one most
   directly aimed at a known problem: Main's context bloat (~24k
   tokens/call), see `project-main-voice-chiefofstaff-plan-2026-08-02`.

Aaron is fine with the extra LLM calls this implies — cost is not the
blocker. **What matters is not breaking the existing system.** This is
explicitly flagged as a major architectural change.

---

## Status: Design NOT started. Planning only. Do not write code yet.

This handoff exists to brief an implementing agent so it can run its own
plan-mode session — it is not itself an approved implementation plan.
Nothing below is locked. Aaron has explicitly asked for a **separate,
dedicated brainstorming session focused only on danger zones/caveats**
before any Phase begins, because this system has known fragile spots
that a generic "add a memory pipeline" plan would not know to protect.

---

## Existing memory system this must not break

OpenClaw already has a working, hand-curated memory system:
`MEMORY.md` index + linked topic files with `type: user/feedback/project/reference`
frontmatter, written by an agent when something notable happens, plus
per-agent `SOUL.md`/daily logs. This is cheap (no standing pipeline),
human-auditable, and already trusted. Any new system should be additive
or should have an explicit, discussed migration path — not a silent
replacement.

---

## Danger zones specific to this OpenClaw install (flag, don't solve yet)

These are the reasons this needs its own brainstorming pass before
Phase 1 starts — each one is a place where a generic implementation
would collide with something already true about this system:

1. **Per-agent isolation is a deliberate design choice, not an
   oversight.** A prior architecture audit explicitly rejected a shared
   mega-DB across agents (`project-data-architecture-audit-2026-08-02`).
   Tencent's "Team Memory" / cross-agent sharing concept is the opposite
   of that. Whether facts/personas (features 1–3) are per-agent-isolated
   or shared needs an explicit decision, not a default.

2. **Config hot-reload has already burned this system once.** The
   `contextPruning` incident (`SYSTEM_WALKTHROUGH.html` §3.7) showed
   hot-reload accepting a NEW schema field without validating it would
   survive a cold start. If this pipeline needs new `openclaw.json`
   fields (backend URLs, extraction-model routes), treat that as
   high-risk by default and test cold-start survival explicitly.

3. **Whitelisted-script pattern is the established safe path for new
   agent capabilities.** See `deep-mode.sh` / `arc-read.sh`/`arc-write.sh`
   convention. Any new component agents call into (especially Main,
   which has `write`/`edit`/`exec`/`sessions_spawn` all denied) should
   probably follow this pattern rather than getting broad new tool
   grants.

4. **Silent LLM-fallback history.** OpenRouter credit exhaustion has
   silently degraded every agent to weak local `llama3.1:8b` at least
   twice (`project-openrouter-credit-exhaustion-recurring-2026-08-03`).
   An extraction pipeline that runs on every conversation multiplies
   this failure surface — a broken/degraded extraction pass could
   silently write garbage facts instead of just failing loudly.

5. **"No unrequested monitoring/standing infrastructure" is standing
   feedback from Aaron** (`feedback-no-unrequested-monitoring-infra`).
   An always-on extraction/compression pipeline IS new standing
   infrastructure by definition — this conflicts with that feedback on
   its face and needs Aaron's explicit sign-off per component, not an
   assumption that "more features" implies blanket approval.

6. **Most agent workspaces have `.git` initialized but zero commits** —
   not a real safety net. Back up memory directories manually before any
   migration/schema change touches existing `.md`/`.sqlite` memory files.

7. **Main's tool restrictions are intentional sandboxing**
   (`project-sessions-spawn-tool-inheritance-bug-2026-08-02`). Feature 4
   (symbolic compression) needs to compress Main's live tool-call
   context — decide up front whether that logic lives in the Gateway/
   harness layer (outside Main's own restricted toolset) or needs a new
   narrow whitelisted tool for Main specifically.

8. **Delivery-mirror auto-send is a fixed OpenClaw platform behavior**,
   not something this repo controls (`project-subagent-channel-access-audit-2026-08-02`).
   If any memory feature summarizes or intercepts sub-agent replies,
   verify it doesn't fight with delivery-mirror's automatic push to
   Aaron.

9. **This overlaps with an already-open plan.** Main's context-bloat
   problem already has a phased plan in flight
   (`project-main-voice-chiefofstaff-plan-2026-08-02`, phases 1–2 open).
   Decide explicitly whether feature 4 supersedes, merges with, or runs
   parallel to that plan — don't let two uncoordinated efforts both aim
   at the same bottleneck.

---

## Recommended phase order (high-level only — no implementation detail)

Ordered by architectural risk, lowest first, so early phases can ship
and be trusted before the riskier cross-agent phases begin.

### Phase 0 — Danger-zone brainstorm (blocking, Aaron + implementing agent)
Work through the 9 items above to a decision, before any code. Output:
a locked decisions table (same style as the Deep Thinking Mode handoff)
covering at minimum: per-agent vs shared storage, where compression
logic lives relative to Main's tool sandbox, which new config fields
(if any) are needed and how cold-start survival will be verified, and
explicit Aaron sign-off that the new standing pipeline is wanted despite
the no-unrequested-infra default.

### Phase 1 — Feature 4: Symbolic short-term memory (Main only)
Scoped narrowly to Main's live session tool-call history. Highest
value-to-risk ratio: directly targets a known, already-prioritized
problem, touches only one agent, and doesn't require deciding the
cross-agent sharing question from Phase 0 item 1.

### Phase 2 — Feature 1: Automatic fact extraction (single agent pilot)
Pilot on one agent's memory pipeline (not all 11) before wider rollout.
Must decide: extraction runs on every conversation, or only long/notable
ones? Failure mode when extraction LLM call fails or is degraded
(item 4 above) must fail loudly, not silently corrupt memory.

### Phase 3 — Feature 2: Scenario/project bundles
Builds on Phase 2's extracted facts. Closest existing analog is the
`project-*.md` memory files — decide whether this generates those files
automatically or is a separate, parallel structure.

### Phase 4 — Feature 3: Persona layer
Builds on Phases 2–3. Closest existing analog is `user`-type memories.
Lowest urgency of the four — no known active pain point driving it,
unlike Feature 4.

---

## What this handoff deliberately excludes

- No file list, schema, or code-level detail — Aaron asked to keep this
  high-level; the implementing agent should produce that detail itself
  during its own plan-mode session, after Phase 0.
- No decision on whether to borrow any of Tencent's actual code/libraries
  vs. reimplementing the ideas natively in this repo's Node stack — that's
  a Phase 0/1 design question, not decided here.
- No commitment that Phases 2–4 will happen at all — Phase 0 may
  conclude some of them aren't worth the architectural risk relative to
  the existing hand-curated memory system.

---

## Quick-start for the implementing agent

1. Read this file in full.
2. Read `~/.openclaw/CURRENT_ARCHITECTURE.md` and
   `~/.openclaw/SYSTEM_WALKTHROUGH.html` (esp. §3.7).
3. Read the memory files referenced above via the project's `MEMORY.md`
   index (`~/.claude/projects/-Users-aaronmacmini--openclaw/memory/`) —
   don't trust this handoff's summaries of them as current; re-check.
4. Do NOT start Phase 1 work. Start with Phase 0: run a dedicated
   planning/brainstorm session with Aaron, working through the 9 danger
   zones to explicit decisions, before writing any design doc for
   Phase 1.
5. Only after Phase 0 decisions are locked, open a plan-mode session for
   Phase 1 (Feature 4 / Main's symbolic short-term memory) as the first
   real implementation target.

---

*Handoff prepared 2026-08-17. Research-only; no code written, no files
outside this handoff created or modified. Source research:
github.com/TencentCloud/TencentDB-Agent-Memory.*

---

## Addendum: Phase 0 decisions locked (2026-08-17)

The blocking Phase 0 brainstorm ran the same day this handoff was written.
Three re-verification passes checked the 9 danger zones above against
current system state (this handoff's own summaries were, as instructed,
not trusted blindly). Corrections found: agent roster is now 11, not 10;
"per-agent isolation" is not absolute — `task-tracker`/`lists` already
share `dashboard-api` and `meal-planner`/`health-tracker` already share a
recipe DB, so the real precedent is *deliberate, scoped* sharing, not
blanket isolation; Main's `tools.deny` has grown to 34 entries (from 22);
`deep-mode.sh` has since been actually implemented, not just designed;
`contextPruning` is confirmed unset on every agent today.

### Locked decisions

| Decision | Value |
|---|---|
| **Storage model for features 1–3** | Per-agent, no cross-agent sharing. Matches today's hand-curated `MEMORY.md` shape; consistent with the 2026-08-02 architecture audit's rejection of a shared mega-DB. |
| **Where feature 4's compression logic lives** | Gateway/harness layer, outside any agent's own toolset. No new tool grant or whitelisted script for Main — compression happens in session/context management before content reaches Main's context window. |
| **Standing-infrastructure sign-off** | Per-component, per-phase. This session approves direction and phase order only; each phase's own standing pieces (cron/daemon/always-on hook) need their own explicit go/no-go before being built. |
| **Relationship to the open Main chief-of-staff plan** (`project-main-voice-chiefofstaff-plan-2026-08-02`) | Feature 4 becomes the mechanism that completes that plan's still-open Phase 1/2 (deterministic yes/no via HA ConversationEntity; leaner voice persona/toolset) — one effort against Main's ~24k-token/call bloat, not two. |

### Other danger zones — locked as defaults, no branching decision needed

- **Config hot-reload** (#2): any new `openclaw.json` field this project introduces must be verified against a real full-restart, never trusted on hot-reload acceptance alone.
- **Silent LLM-fallback risk** (#4, relevant from Phase 2 on): extraction/compression output must record which model produced it and fail loudly (skip writing) rather than silently persist facts generated during a detected OpenRouter-fallback-to-local-model period. Concrete mechanism deferred to Phase 2's own session.
- **No real git safety net** (#6): back up any memory directory manually before a migration/schema change touches it.
- **Delivery-mirror auto-send** (#8): not fixable from this repo, treated as a hard constraint. Phase 1 doesn't touch sub-agent replies, so it isn't implicated yet — re-flag if a later phase considers summarizing/intercepting sub-agent output.
- **Main's tool sandboxing** (#7): resolved by the Gateway/harness placement decision above — doesn't apply to Phase 1 as scoped.

### Next step

A separate, dedicated plan-mode session for **Phase 1 only** (symbolic
compression at the Gateway/harness layer) — using Explore/Plan sub-agents
to pin down exactly where in the session/context pipeline compression
hooks in, without touching Main's `tools.deny` or config schema without a
cold-start test. Phases 2–4 remain un-pre-approved beyond direction and
order; each gets its own such session later.

---

## Addendum: Phase 1 design locked, two corrections to Phase 0 (2026-08-17)

The Phase 1 design session ran the same day. It found two of the Phase 0
locked decisions above didn't survive contact with the actual system —
both are corrected here rather than silently overridden:

1. **"Relationship to the open Main chief-of-staff plan" is corrected to
   decoupled.** The chief-of-staff plan's Phase 1 (deterministic yes/no
   via HA `ConversationEntity`) was already built and working before this
   session started — the actual remaining gap is a small, unrelated
   router-side "pending confirmation state" feature. Its Phase 2 just
   needs a short lean-persona doc written. Neither is a context-size
   problem, so Feature 4 cannot be "the mechanism" that completes them.
   Feature 4 now proceeds on its own merit (Main's live tool-call output
   bloat, a real and separate problem); the two chief-of-staff gaps are a
   separate, later, quick follow-up — not part of this project.

2. **"Where feature 4's compression logic lives" is corrected from
   "Gateway/harness layer, new plugin" to an async offline script.**
   OpenClaw's Gateway is an external black-box npm binary exposing a
   plugin/hook API, but every hook that can see full tool-call content is
   read-only, and the one hook that can rewrite it (`tool_result_persist`)
   is synchronous-only — an `await` on an LLM call inside it is silently
   discarded. `registerCompactionProvider()`, the other mutation point, is
   structurally global (all 11 agents), conflicting with Main-only scope.
   The corrected design: a plain Node script
   (`services/main-context-compressor/`) chained onto the existing
   `main-imessage-nightly-compact` cron job's shell command, rewriting
   large tool-call entries in Main's session transcript after the fact.
   This satisfies the original intent (no new tool grant or agent-visible
   capability for Main) via a simpler path — no Gateway plugin, no new
   `openclaw.json` schema fields, no new standing infrastructure (reuses
   the existing cron trigger).

All other Phase 0 decisions (per-agent storage for features 1–3,
per-component/per-phase infra sign-off, and the other danger-zone
defaults) stand unchanged. Full design detail: see the Phase 1 plan file
this session produced, and `project-agent-memory-upgrade-phase1-2026-08-17.md`.

**Further correction, same session, during implementation**: the async
cron-script design above was itself superseded before anything shipped.
Hands-on inspection of Main's actual live session file found it's
append-only from the Gateway's perspective while running — an external
script rewriting entries in place risks the Gateway's open file handle
pointing at a now-unlinked file after a swap, silently losing any message
written in that window. The `sessions compact` CLI avoids this because it
talks to the running Gateway in-process, not by editing the file from
outside. So the actually-shipped mechanism reverted to a Gateway plugin
after all — `plugins/main-context-compressor/`, registered in
`openclaw.json`'s `plugins.entries` — using the one hook that's both safe
(in-process) and can rewrite content: `tool_result_persist`. That hook is
synchronous-only, so the LLM-based semantic shorthand originally envisioned
isn't possible there; the shipped version does fast, deterministic,
non-LLM compaction instead (minify JSON, truncate long arrays/strings with
a "+N more" marker, archive the original raw text first). Verified via a
real Gateway restart, not just hot-reload. See
`project-agent-memory-upgrade-phase1-2026-08-17.md` for the final version.
