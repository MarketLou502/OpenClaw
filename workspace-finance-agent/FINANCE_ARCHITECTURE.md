# Finance services after balance-tracking retirement

The Finance conversational agent and Finance Discord account remain retired.
Active Finance behavior is deliberately limited to the kiosk workflow:

1. Dollars spent today from successful Capital One debit-purchase emails.
2. Upcoming recurring transactions from the `expenses` table, due today
   through the end of the current calendar month.
3. A review queue for successful debit-purchase emails. New purchases are
   stored with `needs_review=1`; tapping them in the kiosk confirms them by
   setting `needs_review=0`.

## Active data flow

```text
Capital One Mail every 60 seconds
  -> accept successful debit-purchase alerts only
  -> exact source-email deduplication
  -> finance.db transactions (pending review) + monthly_summary spending

finance.db expenses
  -> current-month upcoming recurring transactions

finance.db spending + pending review
  -> dashboard-api
  -> Echo kiosk Financials panel
```

No component fetches, estimates, stores, reconciles, forecasts, or displays
available account funds. Deposits, refunds, declines, and unknown email events
are ignored by the active parser. Finance sends no Discord or iMessage messages.

## Active services

- `com.openclaw.finance.pollmail` — Capital One Mail polling every 60 seconds.
- `ai.openclaw.dashboard-api` — read-only spending-today and upcoming-transaction display.

## Recurring transaction maintenance

Recurring estimates live in the `expenses` table. The dashboard lists active
monthly entries due today through month end, ordered by date and name. Update
the table through a purpose-built maintenance workflow or a coder; the kiosk
has no editing interface.

## Rollback

The pre-removal source and database are preserved under
`migration-backups/2026-07-31-balance-tracking-retirement/`. Credentials were
not included. Restoring balance tracking requires an explicit new decision by
Aaron and is not part of normal Finance operation.
