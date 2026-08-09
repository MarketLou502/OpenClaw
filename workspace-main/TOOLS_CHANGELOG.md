# TOOLS_CHANGELOG.md — Human-readable history

This file tracks structural changes, regressions, and rationale for TOOLS.md.
It is **not** loaded into the model's prompt — it exists for human and
engineering reference only.

---

### 2026-08-07 — sessionKey self-messaging loop

The delegation routing block inside `<!-- DELEGATION_TABLE_START -->` was
missing an explicit `agentId`/`sessionKey` warning. `sessions_send` was called
with `sessionKey: "current"` (a valid shorthand on `session_status`/
`sessions_history`), which `sessions_send` silently interpreted as a literal
target name — causing a self-messaging loop instead of reaching the specialist.

**Resolution:** Added the `agentId`/`sessionKey` warning inside the delegation
routing block AND in the `sessions_send` call-syntax section. Later promoted
to a standalone CARDINAL RULE at the top of TOOLS.md (2026-08-08).

### 2026-08-02 — per-widget agent split

Dashboard widgets each got their own specialist agent. The delegation routing
table was updated to reflect the new roster (scheduler, goals, boards, lists,
meal-planner, health-tracker, finance-agent). `services/ha-voice-adapter/
server.js` was already reading the routing block straight off disk, but had
its own separate copy that drifted out of sync.

**Drift 1:** Server.js still referenced `sessions_spawn` in the routing block
after the main file had switched to `sessions_send`.
**Drift 2:** Health-tracker route was added to TOOLS.md but never propagated
to server.js's copy.
**Drift 3** (cumulative): Both stale `sessions_spawn` refs and missing routes
from the above.

**Resolution:** Server.js now reads the `<!-- DELEGATION_TABLE_START -->` block
directly from TOOLS.md on every voice turn. No separate copy to drift.