# TOOLS.md - Active Finance data

## Database

Path: `/Users/aaronmacmini/.openclaw/workspace-finance-agent/finance.db`

Active tables:

| Table | Active purpose |
|---|---|
| `transactions` | Successful Capital One debit-purchase email events |
| `monthly_summary` | Historical spending totals |
| `expenses` | Known recurring upcoming transactions |

### Dollars spent today

```bash
sqlite3 /Users/aaronmacmini/.openclaw/workspace-finance-agent/finance.db "SELECT ROUND(COALESCE(SUM(amount),0),2) FROM transactions WHERE type='debit' AND date=date('now','localtime');"
```

### Upcoming recurring transactions

The dashboard expands active monthly `expenses` entries from today through the
end of the current calendar month and orders them by date and name.

```bash
sqlite3 /Users/aaronmacmini/.openclaw/workspace-finance-agent/finance.db "SELECT name, amount_est, due_day FROM expenses WHERE active=1 AND recurrence='monthly' AND amount_est IS NOT NULL AND due_day IS NOT NULL ORDER BY due_day,name;"
```

### Pending transaction review

New debit-purchase emails use `needs_review=1`. The dashboard lists those rows
and sets the selected row to `0` only after Aaron taps it to confirm it.

## Active services

- `com.openclaw.finance.pollmail` — checks Capital One Mail every 60 seconds.
- `ai.openclaw.dashboard-api` — supplies the Echo kiosk Financials panel.

No balance provider, browser relay, aggregation API, cash-flow forecast, or
account-balance credential is active.
