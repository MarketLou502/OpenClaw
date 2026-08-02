# MEMORY.md - Long-Term Memory

## Active Finance scope

- The Echo dashboard shows dollars spent today from successful debit-purchase emails.
- New debit purchases appear in the Echo dashboard's pending-review queue until Aaron confirms them.
- The dashboard shows recurring upcoming transactions due through the end of the current month.
- OpenClaw does not fetch, estimate, store, reconcile, forecast, or display available account funds.
- Finance sends no Discord or iMessage notifications.

## Data

- Database: `/Users/aaronmacmini/.openclaw/workspace-finance-agent/finance.db`
- `transactions`: successful debit purchases retained from Capital One email alerts, including pending-review state.
- `expenses`: recurring upcoming transactions maintained manually or by a coder.
- `monthly_summary`: historical spending totals.

## Notes

- Keep this file under 150 lines.
- Transaction email path: Mail poller → `parse_transaction.py` → `finance.db`.
