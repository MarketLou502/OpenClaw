# TOOLS.md - Active Finance data

## Database

Path: `/Users/aaronmacmini/.openclaw/workspace-finance-agent/finance.db`

Active tables:

| Table | Active purpose |
|---|---|
| `transactions` | Successful Capital One debit-purchase email events |
| `plaid_transactions` | Plaid transaction records maintained by incremental Transactions Sync |
| `expenses` | Known recurring upcoming transactions |
| `account_balances` | Cached balances returned with Plaid transaction updates; latest row per `account_id` is the last-known balance |

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

### Current balance

Latest cached snapshot per account, summed. Never call Plaid live to answer a
question. This is not guaranteed real-time; report its `fetched_at` timestamp
when freshness matters. Accounts with no transaction activity may retain an
older cached balance because Transactions Sync only returns accounts associated
with transactions in that response.

```bash
sqlite3 /Users/aaronmacmini/.openclaw/workspace-finance-agent/finance.db "
  SELECT account_name, account_mask, balance_current, fetched_at
  FROM account_balances ab
  WHERE fetched_at = (SELECT MAX(fetched_at) FROM account_balances WHERE account_id = ab.account_id)
  ORDER BY account_name;
"
```

### Shortfall forecast

Not a raw query — computed by `dashboard-api`'s `getBudget()`
(`services/dashboard-api/server.js`): current balance minus every active
monthly expense's occurrences over the next 45 days, walked forward day by
day, flagging the date/cause of the lowest projected point if it drops below
$100. Expense-only — doesn't know about future income (deposits aren't
parsed by the email pipeline). Read it via `/api/financials`'s `budget`
field rather than reimplementing the walk elsewhere.

## Active services

- `com.openclaw.finance.pollmail` — checks Capital One Mail every 60 seconds.
- `com.openclaw.finance.plaid-webhook` — verifies signed Plaid events arriving
  through Tailscale Funnel and runs Item-specific sync on
  `SYNC_UPDATES_AVAILABLE`.
- `com.openclaw.finance.transactions-sync` — reconciliation call at 03:15,
  saves incremental transaction changes plus Plaid's cached
  balances, and persists a cursor in `memory/.plaid_transactions_sync.json`.
  Script: `scripts/sync_plaid_transactions.js`; log:
  `scripts/transactions-sync.log`.
- `ai.openclaw.dashboard-api` — supplies the Echo kiosk Financials panel,
  including the Budget tab.

No aggregation API, external cash-flow service, or account-balance
credential beyond the single linked Plaid Production item is active.

## Mutations (via dashboard-api, not direct file/DB writes)

For anything that changes `finance.db` rather than just reading it (adding a
recurring expense, marking a transaction reviewed), use
`scripts/finance-workflow.js`, which talks to `dashboard-api` the same way
`workspace-main/scripts/dashboard-workflow.js` does for other widgets — do
not write to `finance.db` directly for these.

```bash
node /Users/aaronmacmini/.openclaw/workspace-finance-agent/scripts/finance-workflow.js review --id 42
node /Users/aaronmacmini/.openclaw/workspace-finance-agent/scripts/finance-workflow.js add-expense --name "Rent" --amount 1500 --due-day 1
node /Users/aaronmacmini/.openclaw/workspace-finance-agent/scripts/finance-workflow.js remove-expense --id 7
```

The program returns JSON; use its `reply` field as the factual core of your
response to Main. Read-only queries (spent today, upcoming transactions,
pending review, current balance) can still go straight to `sqlite3` as
documented above — `dashboard-api` doesn't expose a dedicated read endpoint
for those beyond the full `/api/financials` payload, which computes them
fresh from `finance.db` on every call.

### Voice reads (finance-workflow.js `balance` / `budget-forecast`)

Two additional read-only `finance-workflow.js` commands exist specifically
for `shared-routine-router` — they call `GET /api/financials` (the same
authenticated client the mutation commands use) and return a spoken-friendly
`reply` string, so the router only has to spawn one process:

```bash
node scripts/finance-workflow.js balance          # "You have $X total — ..."
node scripts/finance-workflow.js budget-forecast   # shortfall warning or all-clear
```

Reached via voice phrases in
`services/shared-routine-router/sentences/en/financials.yaml`
(`GetBalance`, `GetBudgetForecast`) — these bypass Main entirely, same
mechanism as the board/list/health voice intents.

## Plaid

Credentials, access tokens, and the Transactions cursor live in
`memory/.plaid_*.json` (0600, gitignored). The active client is
`scripts/sync_plaid_transactions.js` and is restricted to
`/transactions/sync`.

Cost boundary: `/transactions/sync` is covered by the $0.30-per-connected-
account/month Transactions subscription. `/accounts/get` is free but cached.
Do not call `/accounts/balance/get` ($0.10 per successful real-time request)
or `/transactions/refresh` (separately priced forced refresh) without Aaron's
explicit approval. The former balance implementation and Hosted Link client
are preserved under `archive/paid-balance-polling-2026-08-03/`.
