# OpenClaw Agent & Tool Inventory

**Last updated:** 2026-08-07  
**Source:** `openclaw.json` (live config), workspace TOOLS.md/SOUL.md/AGENTS.md files, CURRENT_ARCHITECTURE.md

---

## 1. Agents Overview

| # | Agent ID | Name | Model (Primary) | Fallback | Model Provider | Channel Binding |
|---|----------|------|-----------------|----------|---------------|-----------------|
| 1 | `main` | Main | `ollama/llama3.1:8b` | — | Local (Ollama) | iMessage, Voice |
| 2 | `scheduler` | Scheduler | `openrouter/deepseek/deepseek-v4-flash` | `ollama/llama3.1:8b` | OpenRouter → local | None (internal) |
| 3 | `health-tracker` | Health Tracker | `openrouter/deepseek/deepseek-v4-flash` | `ollama/llama3.1:8b` | OpenRouter → local | None (internal) |
| 4 | `sports-betting` | Sports Betting | `ollama/llama3.1:8b` | — | Local (Ollama) | Discord (only active) |
| 5 | `goals` | Goals | `ollama/llama3.1:8b` | — | Local (Ollama) | None (internal) |
| 6 | `boards` | Boards | `ollama/qwen3.5:9b` | — | Local (Ollama) | None (internal) |
| 7 | `lists` | Lists | `ollama/qwen3.5:9b` | — | Local (Ollama) | None (internal) |
| 8 | `meal-planner` | Meal Planner | `openrouter/deepseek/deepseek-v4-flash` | `ollama/llama3.1:8b` | OpenRouter → local | None (internal) |
| 9 | `finance-agent` | Finance Agent | `ollama/llama3.1:8b` | — | Local (Ollama) | None (internal) |
| 10 | `research` | Research | `openrouter/deepseek/deepseek-v4-flash` | `ollama/llama3.1:8b` | OpenRouter → local | None (internal) |
| 11 | `systems-qa` | Systems QA | `ollama/llama3.1:8b` | — | Local (Ollama) | None (internal) |

---

## 2. Tool Access by Agent

### 2.1 `main` — Router/Delegator
- **Denied tools (33):** `agents_list`, `apply_patch`, `browser`, `canvas`, `cron`, `dir_fetch`, `dir_list`, `edit`, `exec`, `file_fetch`, `file_write`, `gateway`, `github`, `image`, `image_generate`, `imsg`, `memory_get`, `message`, `music_generate`, `nodes`, `pdf`, `process`, `read`, `session-logs`, `sessions_list`, `sessions_send`, `sessions_yield`, `subagents`, `tts`, `video_generate`, `web_fetch`, `web_search`, `write`
- **Primary allowed:** `sessions_spawn` (removed from deny but see §3.7 caveat), `sessions_status`, `sessions_history`, `memory_search`, `skills` (github, session-logs, imsg)
- **Model:** `ollama/llama3.1:8b` (local, no cloud dependency)
- **FS:** `workspaceOnly: true`
- **Role:** Pure task delegator/router. Delegates via `sessions_send` (not `sessions_spawn`) to specialists. Never executes tasks directly.

### 2.2 `scheduler` — Calendar Specialist
- **Denied tools (23):** `imsg`, `group:web`, `group:ui`, `group:memory`, `group:sessions`, `group:nodes`, `group:agents`, `apply_patch`, `cron`, `edit`, `gateway`, `process`, `image`, `tts`, `pdf`, `dir_fetch`, `dir_list`, `file_fetch`, `file_write`, `session_status`, `subagents`, `message`, `write`
- **Allows (key):** `exec` (for calendar scripts), `read`, `memory_search`
- **Model:** `openrouter/deepseek/deepseek-v4-flash` → `ollama/llama3.1:8b` fallback
- **FS:** `workspaceOnly: true`
- **Role:** Google Calendar CRUD. Runs scripts via `exec` (cal-add.sh, cal-delete.js, cal-read.js, daily-goal-scheduler.js)

### 2.3 `health-tracker` — Nutrition & Fitness Specialist
- **Denied tools (17):** `imsg`, `message`, `gateway`, `cron`, `group:sessions`, `group:agents`, `group:nodes`, `edit`, `write`, `file_write`, `web_search`, `web_fetch`, `browser`, `tts`, `image`, `pdf`, `canvas`
- **Allows (key):** `exec` (for health-workflow.js), `read`, `memory_search`
- **Model:** `openrouter/deepseek/deepseek-v4-flash` → `ollama/llama3.1:8b` fallback
- **FS:** `workspaceOnly: true`
- **Role:** Food logging, workout logging, nutrition tracking via health-workflow.js

### 2.4 `sports-betting` — Discord Betting Scraper
- **Denied tools (21):** `imsg`, `group:web`, `group:ui`, `group:memory`, `group:sessions`, `group:nodes`, `group:agents`, `cron`, `gateway`, `process`, `image`, `tts`, `pdf`, `dir_fetch`, `dir_list`, `file_fetch`, `file_write`, `edit`, `subagents`, `session_status`, `message`
- **Allows (key):** `exec` (for Playwright scraper scripts)
- **Model:** `ollama/llama3.1:8b`
- **FS:** `workspaceOnly: true`
- **Skills:** `[]` (empty allowlist — no github, session-logs, or imsg)
- **Role:** Silent betting data pipeline. Scrapes CrazyNinjaOdds via Playwright.

### 2.5 `goals` — Daily Habits Specialist
- **Denied tools (20):** `imsg`, `group:web`, `group:ui`, `group:memory`, `group:sessions`, `group:nodes`, `group:agents`, `cron`, `gateway`, `process`, `image`, `tts`, `pdf`, `dir_fetch`, `dir_list`, `file_fetch`, `file_write`, `session_status`, `subagents`, `message`
- **Allows (key):** `exec` (for dashboard-workflow.js), `read`, `memory_search`
- **Model:** `ollama/llama3.1:8b`
- **FS:** `workspaceOnly: true`
- **Role:** Guitar, Golf, Spanish, Study AI 900, Clean, Workout/Run habit tracking

### 2.6 `boards` — Task Board Specialist
- **Denied tools (20):** same as `goals`
- **Allows (key):** `exec` (for dashboard-workflow.js), `read`, `memory_search`
- **Model:** `ollama/qwen3.5:9b`
- **FS:** `workspaceOnly: true`
- **Role:** Work, Personal, Market Lou task boards + due-date scheduling

### 2.7 `lists` — Saved-List Library Specialist
- **Denied tools (20):** same as `goals`
- **Allows (key):** `exec` (for dashboard-workflow.js), `read`, `memory_search`
- **Model:** `ollama/qwen3.5:9b`
- **FS:** `workspaceOnly: true`
- **Role:** User-created saved collections (Songs I Want to Learn, Books, etc.)

### 2.8 `meal-planner` — Grocery & Meal Planning Specialist
- **Denied tools (19):** `imsg`, `group:web`, `group:ui`, `group:sessions`, `group:nodes`, `group:agents`, `cron`, `gateway`, `process`, `image`, `tts`, `pdf`, `dir_fetch`, `dir_list`, `file_fetch`, `file_write`, `session_status`, `subagents`, `message`
- **Allows (key):** `exec` (for meal-planner-workflow.js + dashboard-workflow.js grocery), `read`, `memory_search`
- **Model:** `openrouter/deepseek/deepseek-v4-flash` → `ollama/llama3.1:8b` fallback
- **FS:** `workspaceOnly: true`
- **Role:** Meal plans from recipe library + grocery list management (separate data layers)

### 2.9 `finance-agent` — Budget Accountant
- **Denied tools (21):** `imsg`, `group:web`, `group:ui`, `group:memory`, `group:sessions`, `group:nodes`, `group:agents`, `cron`, `gateway`, `process`, `image`, `tts`, `pdf`, `dir_fetch`, `dir_list`, `file_fetch`, `edit`, `write`, `session_status`, `subagents`, `message`
- **Allows (key):** `exec` (for finance-workflow.js + sqlite3 CLI), `read`, `memory_search`
- **Model:** `ollama/llama3.1:8b`
- **FS:** `workspaceOnly: true`
- **Role:** Spending review, balance check, 45-day shortfall forecast, Capital One email ingestion

### 2.10 `research` — Web-Search Q&A Specialist
- **Denied tools (21):** `imsg`, `group:ui`, `group:memory`, `group:sessions`, `group:nodes`, `group:agents`, `cron`, `gateway`, `process`, `image`, `tts`, `pdf`, `dir_fetch`, `dir_list`, `file_fetch`, `file_write`, `edit`, `write`, `session_status`, `subagents`, `message`
- **Allows (key):** `web_search`, `web_fetch`, `exec`, `read`, `memory_search` — intentionally wide for research purpose
- **Model:** `openrouter/deepseek/deepseek-v4-flash` → `ollama/llama3.1:8b` fallback
- **FS:** `workspaceOnly: true`
- **Role:** Knowledge questions requiring current web information

### 2.11 `systems-qa` — System Diagnostics & Routing QA
- **Denied tools (22):** `imsg`, `group:web`, `group:ui`, `group:memory`, `group:nodes`, `group:agents`, `cron`, `gateway`, `process`, `image`, `tts`, `pdf`, `dir_fetch`, `dir_list`, `file_fetch`, `file_write`, `subagents`, `message`, `sessions_spawn`, `sessions_send`, `sessions_list`, `sessions_yield`
- **Allows (key):** `exec` (for qa-read.sh / qa-propose.sh wrapper scripts only), `read`, `memory_search`
- **Model:** `ollama/llama3.1:8b` (nightly routing-QA job uses override: `openrouter/anthropic/claude-haiku-4-5`)
- **FS:** `workspaceOnly: true`
- **Role:** (1) Stuck-delegate diagnostics for Main, (2) Nightly routing-QA review (cron job at 05:00)

---

## 3. Model Configuration Summary

| Agent | Primary | Fallback | Notes |
|-------|---------|----------|-------|
| main | `ollama/llama3.1:8b` | — | Purely local; no cloud dependency |
| scheduler | `openrouter/deepseek/deepseek-v4-flash` | `ollama/llama3.1:8b` | DeepSeek Flash for calendar tool-calling reliability |
| health-tracker | `openrouter/deepseek/deepseek-v4-flash` | `ollama/llama3.1:8b` | Post-2026-08-02 upgrade; was local-only |
| sports-betting | `ollama/llama3.1:8b` | — | Local only |
| goals | `ollama/llama3.1:8b` | — | Local only |
| boards | `ollama/qwen3.5:9b` | — | Local; swapped from llama3.1 for tool-calling reliability |
| lists | `ollama/qwen3.5:9b` | — | Same swap as boards (live reliability test) |
| meal-planner | `openrouter/deepseek/deepseek-v4-flash` | `ollama/llama3.1:8b` | DeepSeek Flash for tool-calling reliability |
| finance-agent | `ollama/llama3.1:8b` | — | Local only |
| research | `openrouter/deepseek/deepseek-v4-flash` | `ollama/llama3.1:8b` | Cloud for up-to-date web access |
| systems-qa | `ollama/llama3.1:8b` | — | Cron job uses Haiku override |

---

## 4. Skills Enabled

| Skill | Enabled | Scope | Description |
|-------|---------|-------|-------------|
| `imsg` | ✅ | All agents (except sports-betting) | Native iMessage send/receive via CLI |
| `github` | ✅ | All agents (except sports-betting) | Natural-language GitHub issue/PR access via `gh` CLI |
| `session-logs` | ✅ | All agents (except sports-betting) | Historical session query + cost calculation |
| `gh-issues` | ❌ | — | Auto-spawns fix agents/opens PRs; pending autonomy decision |

`sports-betting` has `skills: []` — an explicit empty allowlist. All other agents inherit the global skill set.

---

## 5. Data Flow Map

```
iMessage ──→ Gateway (18789) ──→ main ──→ sessions_send ──→ [scheduler, health-tracker,
                                       │                       goals, boards, lists,
                                       │                       meal-planner, finance-agent,
                                       │                       research, systems-qa]
                                       │
Voice (HA) ──→ ha-voice-adapter (18796) ──→ shared-routine-router (fast path)
                                       │                                   └──→ exec scripts
                                       └──→ Main (fallback) ──→ [same delegation]
```

- **Dashboard API** (18795) is the single writer for JSON state files and SQLite (finance.db)
- **Plaid webhook receiver** (18797) handles signed SYNC_UPDATES_AVAILABLE events
- **All specialists are internal** — no direct channel binding, no proactive outbound messaging

---

## 6. Tool Groups Reference

OpenClaw tool groups that appear in `tools.deny`:

| Group | Tools included |
|-------|---------------|
| `group:web` | `web_search`, `web_fetch`, `browser` |
| `group:ui` | `canvas`, `image`, `image_generate`, `music_generate`, `video_generate` |
| `group:memory` | `memory_get`, `memory_search` |
| `group:sessions` | `sessions_spawn`, `sessions_send`, `sessions_list`, `sessions_yield`, `sessions_status`, `sessions_history` |
| `group:nodes` | Node/device management tools |
| `group:agents` | `agents_list`, `agents_get` |