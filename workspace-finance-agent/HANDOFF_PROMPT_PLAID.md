# Handoff prompt — Plaid balance integration, Phase 3 & 4

**Superseded 2026-08-02 — Phase 3 & 4 are both complete.** Kept for
history; see `PLAID_INTEGRATION.md`, `FINANCE_ARCHITECTURE.md`, and
`TOOLS.md` for how the finished system actually works. The "don't silently
wire this into the dashboard" caution below was heeded: Aaron was asked
explicitly and chose a new Budget tab on the existing Financials overlay
plus two voice phrases, not a change to the compact front-tile.

Paste everything below this line to a new AI session to continue this work.

---

You're picking up a project in `/Users/aaronmacmini/.openclaw/workspace-finance-agent/`
(part of a local, macOS-based multi-agent system called OpenClaw). The goal:
get real-time Capital One bank balance data flowing from the official Plaid
API into a local file/store that Aaron's `finance-agent` (or any of his
OpenClaw agents) can read, so it becomes a source of truth during his daily
check-ins. No public hosting, no heavy web server — this runs locally,
triggered once or twice a day.

**Read `PLAID_INTEGRATION.md` in this directory first** — it has the full
history and is more detailed than this prompt. Short version below.

## What's already done (Phase 1 & 2, complete)

- Plaid developer account created, approved for Production, Trial tier
  (free, up to 10 live Items, personal/developer use — this is a documented
  permitted use case, not a workaround).
- Credentials stored at `memory/.plaid_credentials.json` (0600, gitignored
  via `/workspace-finance-agent/memory/.plaid_*.json` in the top-level
  `.gitignore` — check that pattern is still intact before creating any new
  Plaid-related secret file; extend it if you add new credential filenames).
- Capital One linked via Plaid's Hosted Link flow. Persistent access token
  stored at `memory/.plaid_access.json` (0600, gitignored). Two accounts
  confirmed working: 360 Checking (…3102), 360 Performance Savings (…3193).
- Working scripts in `scripts/`:
  - `setup_plaid_credentials.py` — one-time credential entry (hidden input,
    never touches shell history).
  - `plaid_hosted_link.js` — `create|status|finalize|balance|search`
    subcommands. `balance` is the one you'll actually call going forward:
    it re-fetches current balance for all linked items using the stored
    access token, no browser flow needed. Has a real test suite
    (`plaid_hosted_link.test.js`, mocks Plaid's HTTP API) — follow that
    pattern for any new script you add.
- Confirmed with Aaron: Plaid's `/accounts/balance/get` is an on-demand,
  real-time query against Capital One (OAuth-connected institution), not a
  cached daily snapshot — so calling it 1-2x/day, as planned, gives
  genuinely current numbers each time, not stale data.

## What's NOT done yet — your job

**Phase 3 — daily fetcher + storage.** Wrap `node scripts/plaid_hosted_link.js
balance` (or reimplement its `getBalance()` logic directly) into something
that runs on a schedule (launchd, matching this repo's existing pattern —
see e.g. `launchd/com.openclaw.finance.simplefin-sync.plist` in
`migration-backups/2026-07-31-balance-tracking-retirement/workspace-finance-agent/`
as a template for a *retired* similar job, or just use `openclaw cron`,
the system's own scheduler) and writes a clean output.

Aaron's original ask was "local JSON file or SQLite database" — his call
which. Note: `finance.db` currently has only `transactions`, `expenses`,
and `processed_emails` tables (run `sqlite3 finance.db .schema` to confirm
before assuming anything else exists) — the old `account_balance` table
from before the 2026-07-31 retirement is gone, not just empty. If you go
the SQLite route, you're creating that table fresh, not restoring one.

**Phase 4 — integration.** Structure/expose the output so `finance-agent`
can use it in conversation and/or the Echo dashboard can display it.

**Read `FINANCE_ARCHITECTURE.md` before doing this part; a load-bearing
constraint lives there:** on 2026-07-31, Aaron deliberately retired all
account-funds tracking from the dashboard specifically — "no component
fetches, estimates, stores, reconciles, forecasts, or displays available
account funds" was the explicit design line, and restoring it needed "an
explicit new decision by Aaron." He made that new decision 2026-08-02 (this
project), but only confirmed *building the Plaid connection itself* — he
has not yet said the balance should go back into the same Echo dashboard
widget that was narrowed on purpose. **Don't silently wire this into the
dashboard's Financials panel.** Ask him explicitly where he wants the
output to surface (dashboard widget? finance-agent conversational
answers only? both?) before doing Phase 4 UI/integration work — that's a
design decision he should make, not one to infer.

Also worth knowing: `dashboard-api` (`services/dashboard-api/server.js`)
is the sole writer for daily-tracker's and health-tracker's data, by
deliberate one-writer-many-callers design. If Financials ends up needing a
new writer path, check whether it should go through `dashboard-api` too
for consistency, rather than introducing a second direct-file-writer
pattern.

## Conventions already established in this workspace — follow them

- Credentials: `memory/api-keys.md` documents *what* exists and *where*,
  never the actual secret values. Actual secrets live in their own
  sibling files, mode 0600, always gitignored before they're created.
- `finance-agent`'s current `AGENTS.md` scopes its role to "spending
  today, upcoming recurring transactions, and the transaction-review
  queue" — you'll be expanding that scope; update `AGENTS.md` to reflect
  the new balance capability once it's real, don't leave docs stale.
- This repo is pushed to a **public** GitHub
  (`github.com/MarketLou502/OpenClaw`) — double check `.gitignore`
  coverage for anything new before it's created, not after.
