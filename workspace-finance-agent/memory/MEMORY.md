# MEMORY.md - Long-Term Memory

## Active Finance scope

- The Echo dashboard shows dollars spent today from successful debit-purchase emails.
- New debit purchases appear in the Echo dashboard's pending-review queue until Aaron confirms them.
- The dashboard shows recurring upcoming transactions due through the end of the current month.
- As of 2026-08-03: last-known cached balance (returned with Plaid Transactions
  Sync updates) and a
  45-day expense-only shortfall forecast are both active, surfaced on the
  dashboard's Budget tab and via two voice phrases. See
  FINANCE_ARCHITECTURE.md for the full data flow and why the forecast
  can't see future income.
- Debt tracking, portfolio tracking, income scheduling, and execApprovals
  are dormant (retired 2026-07-31, deliberately not rebuilt) — don't infer
  they're active.
- Finance sends no Discord or iMessage notifications.

## Data

- Database: `/Users/aaronmacmini/.openclaw/workspace-finance-agent/finance.db`
- `transactions`: successful debit purchases retained from Capital One email alerts, including pending-review state.
- `expenses`: recurring upcoming transactions maintained manually or by a coder.
- `plaid_transactions`: incremental Plaid transaction records.
- `account_balances`: cached balances returned by Transactions Sync; latest row per `account_id` is last-known.
- Linked accounts: Capital One 360 Checking (…3102), 360 Performance Savings (…3193).

## Notes

- Keep this file under 150 lines.
- Transaction email path: Mail poller → `parse_transaction.py` → `finance.db`.
- Plaid path: `sync_plaid_transactions.js` → `/transactions/sync` →
  `plaid_transactions` + cached `account_balances`. Paid real-time Balance
  polling was archived on 2026-08-03.
- Plaid `SYNC_UPDATES_AVAILABLE` webhooks arrive through a Tailscale Funnel at
  the dedicated signed receiver. A 03:15 sync remains as reconciliation only.
