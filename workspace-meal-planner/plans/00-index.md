# Meal Planner — Workstream Overview

Five independent workstreams for improving the Meal Planner agent. Each is self-contained with complete context — agents working on them do not need to communicate with each other.

## Architecture summary

```
Aaron says "I ate X" 
       ↓
    Main agent (OpenClaw)
       ↓ delegates to
┌──────────────────┐
│  Health Tracker  │──logs food to──► health-ledger.sqlite
│  (subagent)      │──syncs to──────► dashboard-api (/api/health)
└──────────────────┘                  ↓
                                      ├──► SSE broadcast to kiosk
                                      │
┌──────────────────┐                  └──► meal planner reads budget
│  Meal Planner    │◄──reads budget──────┘
│  (subagent)      │──reads/writes────► meal-planner.sqlite
└──────────────────┘    (shared with health-tracker for recipes)
```

## Workstream dependency map

```
01: Recipe Importer ──────────► no deps, builds on existing schema
02: Food Log Sharing ─────────► no deps, adds new table + hooks
03: Preference Analysis ─────► depends on 02 (needs food_log data)
04: Pantry Management ───────► no deps, builds on existing tables
05: Dashboard Notifications ─► no deps, adds new table + API
```

Workstreams 01, 02, 04, 05 have **no dependencies** on each other. Workstream 03 depends on 02 having data, but is still self-contained (works fine with empty data).

## Quick reference — files to modify

| File | 01 | 02 | 03 | 04 | 05 |
|------|:--:|:--:|:--:|:--:|:--:|
| `workspace-meal-planner/scripts/meal-planner-workflow.js` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `workspace-meal-planner/scripts/recipe-importer.js` | ✅ | | | | |
| `workspace-meal-planner/scripts/analyze-preferences.js` | | | ✅ | | |
| `workspace-meal-planner/data/meal-planner.sqlite` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `workspace-health-tracker/scripts/health-workflow.js` | | ✅ | | | |
| `services/dashboard-api/server.js` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `services/dashboard-api/kiosk-repo/dashboard-web/index.html` | ✅ | | | | ✅ |
| `services/dashboard-api/kiosk-repo/dashboard-web/app.js` | ✅ | | ✅ | ✅ | ✅ |
| `services/dashboard-api/kiosk-repo/dashboard-web/style.css` | | | | | ✅ |

## How to run each workstream

Each plan in this directory (`01-*.md`, `02-*.md`, etc.) is a **complete prompt** you can hand to a subagent. The agent gets:
1. The full context of what already exists
2. A clear goal with success criteria
3. Exact files to modify and how
4. No assumptions about other workstreams' output

The subagent should be given access to read all referenced files and write/edit the relevant scripts. Work in the respective workspace directories as noted.