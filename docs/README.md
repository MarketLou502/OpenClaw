# OpenClaw Documentation

**Last updated:** 2026-08-07  
**Root:** `/Users/aaronmacmini/.openclaw/docs/`

This folder organizes all project documentation — architecture specs, agent identities, handoff packets, infrastructure notes, and service designs — into a discoverable, curated directory.

---

## Quick Start

| If you want… | Start here |
|---|---|
| The full system picture in 5 minutes | [`SYSTEM_WALKTHROUGH.html`](./SYSTEM_WALKTHROUGH.html) — three depth layers + mermaid diagrams |
| Every agent, its model, and its tool IDs | [`AGENT_INVENTORY.md`](./AGENT_INVENTORY.md) — exhaustive tool-deny/permit table |
| The one-page current architecture | [`CURRENT_ARCHITECTURE.md`](./CURRENT_ARCHITECTURE.md) |
| What's planned next (prioritized) | [`Planned-Openclaw-Upgrades.md`](./plans/Planned-Openclaw-Upgrades.md) |

---

## Directory Map

### Root
| File | What it is |
|------|-----------|
| [`AGENT_INVENTORY.md`](./AGENT_INVENTORY.md) | **Full agent/tool inventory** — every agent's model, denied tools, allowed tools, data flows, and role description. Generated from live `openclaw.json`. |
| [`CURRENT_ARCHITECTURE.md`](./CURRENT_ARCHITECTURE.md) | Living architecture document. Updated 2026-08-07. Covers routes, internal work, model policy, sub-agent channel access, secrets, archives. |
| [`SYSTEM_WALKTHROUGH.html`](./SYSTEM_WALKTHROUGH.html) | **New comprehensive system map** with detailed mermaid diagrams showing all 11 agents, their tool deny counts, model backends, delegation paths, service ports, and workspace file layouts. Three-layer readable design with legend. |
| [`SYSTEM_WALKTHROUGH_ORIGINAL.html`](./SYSTEM_WALKTHROUGH_ORIGINAL.html) | Original system walkthrough (871 lines). Contains deep-dive §3.6-§3.7 with incident history. Kept for reference. |

### [`agents/`](./agents/)
| File | What it is |
|------|-----------|
| [`FINANCE_ARCHITECTURE.md`](./agents/FINANCE_ARCHITECTURE.md) | Finance agent design — balance tracking, Plaid integration, email ingestion pipeline |
| [`HANDOFF_PROMPT_PLAID.md`](./agents/HANDOFF_PROMPT_PLAID.md) | Plaid integration handoff — webhook receiver setup, Transactions Sync |
| [`PLAID_INTEGRATION.md`](./agents/PLAID_INTEGRATION.md) | Plaid API integration details |
| [`HEALTH_WORKFLOW_DESIGN.md`](./agents/HEALTH_WORKFLOW_DESIGN.md) | Full health tracking workflow — food logging, USDA index, quantity resolution |
| [`CALENDAR_ROUTING.md`](./agents/CALENDAR_ROUTING.md) | Main's calendar delegation rules (→ scheduler) |
| [`HEALTH_ROUTING.md`](./agents/HEALTH_ROUTING.md) | Main's health delegation rules (→ health-tracker) |
| [`WEEKLY_UPDATE.md`](./agents/WEEKLY_UPDATE.md) | Main's weekly self-update procedure |
| [`ZAXBYS_WORKFLOW.md`](./agents/ZAXBYS_WORKFLOW.md) | Zaxby's survey automation workflow |

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

These files stay in `~/.openclaw/` because they are the live source that docs mirror:

| File | Why it stays at root |
|------|---------------------|
| `openclaw.json` | The live config — docs/AGENT_INVENTORY.md extracts from this |
| `SYSTEM_WALKTHROUGH.html` | Original file; new version lives in docs/ |
| Every `workspace-*/` directory | Live agent workspaces — their SOUL.md/AGENTS.md/TOOLS.md are the canonical source |
| Every script under `scripts/`, `services/` | Live code, not documentation |
| `.env` | Secrets — never documented |
| `exec-approvals.json`, `gateway-supervisor-restart-handoff.json` | Runtime state, not documentation |

---

## How To Keep This Updated

1. **After changing agents or tools** in `openclaw.json` → regenerate `docs/AGENT_INVENTORY.md`
2. **After a major architecture change** → update `docs/CURRENT_ARCHITECTURE.md` (canonical source at root → copy to docs/)
3. **After an incident** → add a caveat entry to `docs/SYSTEM_WALKTHROUGH.html`'s Known Caveats section
4. **New service or agent** → add its workspace docs to the appropriate `docs/` subdirectory, update the agent table in `AGENT_INVENTORY.md`, and add it to the mermaid diagram in `SYSTEM_WALKTHROUGH.html`