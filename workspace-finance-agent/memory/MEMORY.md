# MEMORY.md - Long-Term Memory

## Active Finance scope

- Plaid `/transactions/sync` is the ONLY transaction source. The Capital One
  Mail-alert pipeline (mail rule + poller + parser, pending-review queue) was
  retired 2026-08-08 and permanently deleted 2026-08-12 — don't infer it
  exists or plan around it coming back without Aaron asking for it again.
- Because Plaid is the sole path, a purchase only appears once Capital One
  has reported it to Plaid — this can lag the real-world purchase by up to
  a day or more, especially for small merchants. That lag is expected now;
  it was not expected before 2026-08-08.
- The dashboard shows recurring upcoming transactions due through the end of the current month.
- Last-known cached balance (returned with Plaid Transactions Sync updates)
  and a 45-day expense-only shortfall forecast are active, surfaced on the
  dashboard's Budget tab and via two voice phrases. See
  FINANCE_ARCHITECTURE.md for the full data flow and why the forecast
  can't see future income.
- Debt tracking, portfolio tracking, income scheduling, and execApprovals
  are dormant (retired 2026-07-31, deliberately not rebuilt) — don't infer
  they're active.
- Finance sends no Discord or iMessage notifications.

## Data

- Database: `/Users/aaronmacmini/.openclaw/workspace-finance-agent/finance.db`
- `expenses`: recurring upcoming transactions maintained manually or by a coder.
- `plaid_transactions`: incremental Plaid transaction records — the only transaction table that exists.
- `account_balances`: cached balances returned by Transactions Sync; latest row per `account_id` is last-known.
- Linked accounts: Capital One 360 Checking (…3102), 360 Performance Savings (…3193).

## Notes

- Keep this file under 150 lines.
- Plaid path: `sync_plaid_transactions.js` → `/transactions/sync` →
  `plaid_transactions` + cached `account_balances`. Paid real-time Balance
  polling was archived on 2026-08-03.
- Plaid `SYNC_UPDATES_AVAILABLE` webhooks arrive through an ngrok tunnel
  (`com.openclaw.finance.ngrok-tunnel`) at the dedicated signed receiver
  (`com.openclaw.finance.plaid-webhook`). A 03:15 sync remains as
  reconciliation only. As of 2026-08-12 the ngrok session has been cycling
  reconnects every ~15 min (heartbeat timeouts) — worth checking if webhook
  delivery looks unreliable.
