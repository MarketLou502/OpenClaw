# Plaid integration history — revised 2026-08-03

> The paid real-time Balance polling design described below is historical.
> On 2026-08-03 it was archived under
> `archive/paid-balance-polling-2026-08-03/` after confirming that the account
> is Pay As You Go: Balance costs $0.10 per successful call, while Transactions
> Sync is covered by the Transactions subscription. Active operation is now
> documented in `FINANCE_ARCHITECTURE.md` and `TOOLS.md`.

All four phases are done as of 2026-08-02. This doc is kept as build history
and Plaid-troubleshooting reference — for how the finished system actually
works day to day, see `FINANCE_ARCHITECTURE.md` and `TOOLS.md` instead.

Historical goal: pull real-time Capital One balance data via the official Plaid API
(Production Pay As You Go; it was mistakenly documented as a free Trial) into a local file
finance-agent (or any OpenClaw agent) can read. Aaron's original 4-phase
plan: (1) Plaid dashboard + local credentials, (2) one-time Link
authorization, (3) a daily balance-fetch script, (4) integration into
OpenClaw. This doc tracks status against that plan — pick up at "Next step."

## Context: this was already built once

This same integration (Plaid + a second provider, SimpleFIN) was built,
then deliberately retired 2026-07-31 as part of narrowing Finance's scope
to spending-today + upcoming-recurring-transactions only (see
`FINANCE_ARCHITECTURE.md`). That was a scope decision, not a technical
failure. Aaron explicitly decided 2026-08-02 to restart Plaid specifically
(not SimpleFIN) and reuse the retired code rather than rewrite it. Source:
`migration-backups/2026-07-31-balance-tracking-retirement/workspace-finance-agent/`.

## Status as of 2026-08-02

- **Phase 1 — done.** Plaid developer account created, approved for
  Production. Client ID + Production secret stored locally at
  `memory/.plaid_credentials.json` (mode 0600, gitignored via
  `/workspace-finance-agent/memory/.plaid_*.json` in the top-level
  `.gitignore` — added today, wasn't covered before).
- **Phase 2 — done, 2026-08-02.** Restored `scripts/plaid_hosted_link.js`
  (Hosted Link flow: `create|status|finalize|balance|search`) and
  `scripts/setup_plaid_credentials.py` from the backup; restored test
  (`scripts/plaid_hosted_link.test.js`) passes.
  - Two blockers hit and cleared along the way, in case they recur for a
    second institution/item later:
    1. `INSTITUTION_REGISTRATION_REQUIRED` for Capital One —
       Plaid's Compliance Center → **App profile** had required fields
       empty (Website URL, Reason for data access). Filled in
       (Website URL: `https://github.com/MarketLou502`; reason:
       personal-use, single-user, no third-party sharing) and saved;
       cleared after compliance review completed.
    2. `INVALID_LINK_CUSTOMIZATION` — Plaid also requires a **Data
       Transparency Messaging** use case configured at
       `https://dashboard.plaid.com/link/data-transparency-v5`
       (separate from the App profile). Took two attempts — the first
       save apparently didn't fully take/publish; confirmed working on
       retry.
  - `finalize` succeeded: persistent access token stored at
    `memory/.plaid_access.json` (0600, gitignored). First real balance
    pull confirmed working: Capital One 360 Checking (…3102) $586.12,
    360 Performance Savings (…3193) $0.38. `available` came back `null`
    for both (normal right after initial link for some institutions);
    `current` is the reliable field for now.
  - Going forward, no more Link flow needed — `node
    scripts/plaid_hosted_link.js balance` re-fetches on demand using the
    stored token.
- **Phase 3 — done, 2026-08-02.** `scripts/sync_balance.js` wraps
  `plaid_hosted_link.js`'s `getBalance()` and writes one row per account per
  fetch into `finance.db`'s `account_balances` table (SQLite, not a JSON
  file — chosen so `dashboard-api` could read it with the same `sqlite3`
  CLI pattern already used for every other Finance table). Scheduled via
  `launchd`, not `openclaw cron`: `launchd/com.openclaw.finance.balance-sync.plist`,
  twice daily (07:00 / 19:00 local), modeled directly on the live
  `com.openclaw.finance.pollmail.plist`. Log: `scripts/balance-sync.log`.
- **Phase 4 — done, 2026-08-02.** `dashboard-api`'s `getBudget()`
  (`services/dashboard-api/server.js`) reads the latest balance per account
  plus a 45-day expense-only shortfall forecast, folded into
  `/api/financials`'s `budget` field. Surfaces on the dashboard's Budget tab
  (third tab under the Financials $ button) and via two voice phrases
  (`GetBalance`, `GetBudgetForecast` in `shared-routine-router`). Aaron
  confirmed this surface explicitly rather than it being inferred — see
  `FINANCE_ARCHITECTURE.md` for the full flow.

## Ongoing operation

Balance sync runs unattended via `launchd`; no manual step needed. If Plaid
ever needs re-linking (expired/revoked access), rerun the Hosted Link flow
below, then confirm `scripts/sync_balance.js` still resolves the new access
token from `memory/.plaid_access.json`.

```bash
cd /Users/aaronmacmini/.openclaw/workspace-finance-agent
node scripts/plaid_hosted_link.js create   # new Hosted Link session
```
Open the returned `hosted_link_url`, complete the institution's OAuth, then:
```bash
node scripts/plaid_hosted_link.js status     # confirm complete: true
node scripts/plaid_hosted_link.js finalize   # exchanges token, fetches first balance
node scripts/sync_balance.js                 # writes it into account_balances
```
