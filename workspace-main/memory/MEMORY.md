# MEMORY.md — Main Agent Long-Term Memory

This file is indexed by the embedding system and searched semantically on every session.
Keep entries factual, concise, and current. Delete stale entries — don't hoard.

---

## User: Aaron

- Waking hours: 08:00–23:00 EST
- Communication style: concise, direct, no walls of text
- Prefers recommendations with clear reasoning over exhaustive options lists

## System Architecture

- OpenClaw version: 2026.3.2, running via npx on macOS
- Gateway: port 18789, loopback-only, auth mode: none
- Active agents: main, daily-tracker, health-tracker, and sports-betting
- Native iMessage is bound to Main. Daily Tracker and Health Tracker are
  internal specialists with no channel binding.
- Sports Betting is the only active Discord account and binding.
- FBB is archived at `archives/fbb-agent-2026-07-31/` and requires a new token
  if restored. The legacy iMessage watcher/handler is archived at
  `archives/legacy-routing-2026-07-31/`.
- Direct, unambiguous calendar and dashboard requests are authorized by the
  request itself; do not require approval codes or Discord buttons.

## Key Configs

- Main config: `/Users/aaronmacmini/.openclaw/openclaw.json`
- Agents dir: `/Users/aaronmacmini/.openclaw/agents/`
- Workspaces: `/Users/aaronmacmini/.openclaw/workspace-*/`
- Memory SQLite: `/Users/aaronmacmini/.openclaw/memory/{agentId}.sqlite`
- Browser relay port: 18792 (gateway + 3)

## Decisions & Preferences

- Primary model: `ollama/qwen2.5:7b` (local), fallback: `openrouter/anthropic/claude-sonnet-4-5`
- Embedding: `google/gemini-embedding-001` via OpenRouter (provider: openai, custom baseUrl)
- qwen2.5:7b has poor tool-use reliability — escalate complex tool chains to Claude Sonnet fallback

## Memory Rules (follow on every session)

- Write new permanent facts here before context compacts
- Write ephemeral daily notes to `memory/YYYY-MM-DD.md`, not here
- Keep this file under 150 lines — consolidate and delete stale entries
- Do not duplicate what is already in workspace .md files (SOUL.md, TOOLS.md, etc.)
