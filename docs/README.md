# OpenClaw Documentation

**Last updated:** 2026-08-17
**Root:** `/Users/aaronmacmini/.openclaw/docs/`

This folder is for design docs, handoffs, and infrastructure notes that have
no other home. It is **not** a mirror of anything — every file here is the
single source for its topic. Docs that describe *live, current* system state
(architecture, agent roster, tool grants) live at the top level of
`~/.openclaw/` instead, generated from/kept in sync with the running config,
and are linked from here rather than copied.

Previously this folder held second copies of `CURRENT_ARCHITECTURE.md`,
`SYSTEM_WALKTHROUGH.html`, `AGENT_INVENTORY.md`, and
`agents/FINANCE_ARCHITECTURE.md`. Those copies went stale against their
originals (nobody was regenerating them) and were deleted 2026-08-17 rather
than kept in sync — a dual-copy setup that isn't actively maintained just
recreates the exact "docs pointing to nothing" problem it was meant to
solve.

---

## Quick Start

| If you want… | Start here |
|---|---|
| The full system picture in 5 minutes | [`../SYSTEM_WALKTHROUGH.html`](../SYSTEM_WALKTHROUGH.html) — canonical, at repo root |
| The one-page current architecture | [`../CURRENT_ARCHITECTURE.md`](../CURRENT_ARCHITECTURE.md) — canonical, at repo root |
| Every agent, its model, and its tool IDs | `openclaw.json`'s `agents.list` directly — no maintained inventory doc exists; both canonical docs above have gone stale on the agent roster before, so cross-check config directly rather than trusting any doc alone |
| What's planned next (prioritized) | [`plans/Planned-Openclaw-Upgrades.md`](./plans/Planned-Openclaw-Upgrades.md) |

---

## Directory Map

### Root
| File | What it is |
|------|-----------|
| [`FILE_CATALOG.html`](./FILE_CATALOG.html) | File-by-file catalog of the repo (generated 2026-08-10 — may be stale, verify before trusting for anything current). |
| [`HANDOFF_VOICE_INTERFACE.md`](./HANDOFF_VOICE_INTERFACE.md) | Reusable playbook for extracting a standalone "voice-orb" web app (Gemini Live speech-to-speech) out of OpenClaw into its own VPS deployment. Used for both the Spanish tutor and Meal Planner orbs. |

### [`agents/`](./agents/)
| File | What it is |
|------|-----------|
| [`HANDOFF_PROMPT_PLAID.md`](./agents/HANDOFF_PROMPT_PLAID.md) | Plaid integration handoff — webhook receiver setup, Transactions Sync |
| [`PLAID_INTEGRATION.md`](./agents/PLAID_INTEGRATION.md) | Plaid API integration details |
| [`HEALTH_WORKFLOW_DESIGN.md`](./agents/HEALTH_WORKFLOW_DESIGN.md) | Full health tracking workflow — food logging, USDA index, quantity resolution |
| [`CALENDAR_ROUTING.md`](./agents/CALENDAR_ROUTING.md) | Main's calendar delegation rules (→ task-tracker) |
| [`HEALTH_ROUTING.md`](./agents/HEALTH_ROUTING.md) | Main's health delegation rules (→ health-tracker) |
| [`WEEKLY_UPDATE.md`](./agents/WEEKLY_UPDATE.md) | Main's weekly self-update procedure |
| [`ZAXBYS_WORKFLOW.md`](./agents/ZAXBYS_WORKFLOW.md) | Zaxby's survey automation workflow |

Finance architecture now lives only at
[`../workspace-finance-agent/FINANCE_ARCHITECTURE.md`](../workspace-finance-agent/FINANCE_ARCHITECTURE.md)
— the `docs/agents/` copy was one of the stale mirrors removed 2026-08-17.

### [`handoffs/`](./handoffs/)
| File | What it is |
|------|-----------|
| [`OpenClaw_Due_Date_and_Agent_Coordination_Plan_REVISED.md`](./handoffs/OpenClaw_Due_Date_and_Agent_Coordination_Plan_REVISED.md) | Full due-date feature plan — 5 delivery phases, data model, API contract, acceptance criteria |
| [`README-CONTEXT.md`](./handoffs/README-CONTEXT.md) | AI handoff packet overview — describes what's in the handoff directory and its purpose |
| [`RESTORE.md`](./handoffs/RESTORE.md) | Disaster recovery checklist — what you get from git vs. what needs manual re-creation |

### [`infrastructure/`](./infrastructure/)
| File | What it is |
|------|-----------|
| [`setup_notes.md`](./infrastructure/setup_notes.md) | Original setup reference — multi-bot Discord config pattern, workspace file conventions, supervisor/specialist design, known gotchas |

### [`plans/`](./plans/)
| File | What it is |
|------|-----------|
| [`Planned-Openclaw-Upgrades.md`](./plans/Planned-Openclaw-Upgrades.md) | **Prioritized upgrade roadmap** — Tier 1 (foundational/blocking), Tier 2 (design gaps), Tier 3 (refinements). Sources cited. |
| [`DESIGN-execution-log-archivist.md`](./plans/DESIGN-execution-log-archivist.md) | Design for Execution-Log Archivist agent — nightly knowledge distillation from session trajectories |

### [`services/`](./services/)
| File | What it is |
|------|-----------|
| [`DESIGN.md`](./services/DESIGN.md) | Trace NOC design — log/evidence explorer, outcome diagnosis, continuous NOC phases |
| [`ROUTER_WIRING_PLAN.md`](./services/ROUTER_WIRING_PLAN.md) | Trace NOC — router wiring plan |
| [`TOOL_CATALOG_PLAN.md`](./services/TOOL_CATALOG_PLAN.md) | Trace NOC — tool catalog expansion |
| [`HANDOFF-intent-wiring.md`](./services/HANDOFF-intent-wiring.md) | Home Assistant voice adapter — intent wiring handoff for deterministic voice commands |
| [`README.md`](./services/README.md) | Trace NOC overview |

---

## Files Not In Docs (Stay At Root)

These files stay in `~/.openclaw/` because they are canonical and either
live config or actively kept current:

| File | Why it stays at root |
|------|---------------------|
| `openclaw.json` | The live config — the single source of truth for the agent roster and tool grants |
| `CURRENT_ARCHITECTURE.md` | Canonical, living architecture doc — do not copy into `docs/` |
| `SYSTEM_WALKTHROUGH.html` | Canonical system map — do not copy into `docs/` |
| Every `workspace-*/` directory | Live agent workspaces — their SOUL.md/AGENTS.md/TOOLS.md are the canonical source |
| Every script under `scripts/`, `services/` | Live code, not documentation |
| `.env` | Secrets — never documented |
| `exec-approvals.json`, `gateway-supervisor-restart-handoff.json` | Runtime state, not documentation |

---

## How To Keep This Updated

1. **After changing agents or tools** in `openclaw.json` → update
   `CURRENT_ARCHITECTURE.md` at root directly. Do not create a second copy
   in `docs/`.
2. **After an incident** → add a caveat entry to `SYSTEM_WALKTHROUGH.html`'s
   Known Caveats section, at root.
3. **New design doc, handoff, or plan with no other home** → add it under
   the appropriate `docs/` subdirectory and list it in this README.
4. **Before trusting any doc on the agent roster** → cross-check
   `openclaw.json`'s `agents.list` directly. Both canonical docs have gone
   stale on this before.
