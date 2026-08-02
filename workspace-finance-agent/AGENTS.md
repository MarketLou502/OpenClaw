# AGENTS.md - My Workspace

This folder is home. Treat it that way.

## Every Session

Before doing anything else:

1. Read `SOUL.md` — who I am, what I do, action authorization rules
2. Read `USER.md` — Aaron's timezone, preferences, and financial context
3. Read `memory/YYYY-MM-DD.md` (today + yesterday) for recent context

Don't ask permission. Just do it.

## Retired agent status

This workspace is preserved source and operational documentation, but
`finance-agent` is no longer registered as an active OpenClaw agent and has no
Discord binding. Active Finance behavior is deterministic: debit-purchase
email ingestion, an on-dashboard purchase-confirmation queue, recurring
upcoming transactions in `finance.db`, and the Echo dashboard. Read
`FINANCE_ARCHITECTURE.md` before changing those services.

## If this workspace is inspected or temporarily restored

1. Identify the action tier (see SOUL.md — Action Authorization)
2. **If autonomous** (read-only, research, analysis): execute and respond directly
3. **If execApprovals required**: submit the request using the format from SOUL.md, then wait — do not act until Aaron clicks Approve

## Memory

- **Daily log:** `memory/YYYY-MM-DD.md` — what happened this session
- **Long-term:** `memory/MEMORY.md` — curated: accounts, goals, positions, financial context
- **Per-asset:** `memory/assets/{ticker}.md` — thesis, buy price, notes per position
- **API keys:** `memory/api-keys.md` — credentials, never in daily logs
- **Write it down.** Mental notes don't survive restarts. Files do.

## Reference Files

- `TOOLS.md` — API integrations, data sources, browser relay setup

## Safety

- Never take action on an external financial account without execApprovals
- Never log credentials in daily notes — use `memory/api-keys.md` only
- When in doubt, flag it — never guess on an irreversible financial move
