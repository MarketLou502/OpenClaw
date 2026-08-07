# Finance architecture

Finance-agent is a live conversational widget specialist (revived
2026-08-02, see SOUL.md) sitting on top of two independent, deterministic
`launchd` pipelines. Both run regardless of whether a conversation is
active; the agent reads their output, it doesn't drive them.

1. Dollars spent today from successful Capital One debit-purchase emails.
2. Upcoming recurring transactions from the `expenses` table, due today
   through the end of the current calendar month.
3. A review queue for successful debit-purchase emails. New purchases are
   stored with `needs_review=1`; tapping them in the kiosk confirms them by
   setting `needs_review=0`.
4. Last-known balance per linked account, returned with Plaid transaction updates.
5. A 45-day, expense-only shortfall forecast built from (2) and (4).

## Active data flow

```text
Capital One Mail rule on message receipt
  -> accept successful debit-purchase alerts only
  -> exact source-email deduplication
  -> finance.db transactions (pending review)

15-minute Capital One Mail poll (reconciliation fallback)
  -> catches messages if Mail does not fire the rule
  -> the same exact source-email deduplication prevents double counting

Plaid's normal institution updates (typically one to four times daily)
  -> signed SYNC_UPDATES_AVAILABLE webhook reaches the dedicated receiver
     through Tailscale Funnel
  -> /transactions/sync retrieves added/modified/removed transactions
     and the cached balances returned with those updates
  -> scripts/sync_plaid_transactions.js saves the cursor
  -> finance.db plaid_transactions + account_balances

finance.db expenses
  -> current-month upcoming recurring transactions (dashboard list)
  -> 45-day day-by-day expansion (dashboard-api getBudget()) for the forecast

finance.db account_balances (latest per account) + the forecast above
  -> dashboard-api getBudget()
  -> dashboard's Budget tab, and finance-workflow.js's `balance`/
     `budget-forecast` voice-reply commands

finance.db spending + pending review + budget
  -> dashboard-api /api/financials
  -> Echo kiosk Financials panel ($ button -> Review / Upcoming / Budget tabs)
```

Deposits, refunds, declines, and unknown email events are still ignored by
the active email parser — this is why the forecast is expense-only. Finance
sends no Discord or iMessage messages of its own; Main is the only
user-facing reply channel outside the dashboard and the couple of voice
phrases in `shared-routine-router` (see TOOLS.md).

## Active services

- Mail rule `OpenClaw Finance — Capital One` — immediately passes matching
  incoming messages to `scripts/capital_one_mail_rule.applescript`, which
  invokes the existing transaction parser and dashboard notification path.
- `com.openclaw.finance.pollmail` — Capital One Mail reconciliation poll every
  15 minutes, retained as a fallback if Mail does not fire the rule.
- `com.openclaw.finance.plaid-webhook` — loopback-only signed webhook receiver;
  Tailscale Funnel publishes its single-purpose route over HTTPS.
- `com.openclaw.finance.transactions-sync` — one 03:15 reconciliation run in
  case a webhook was missed. This does not force an institution refresh and
  does not call the paid Balance endpoint.
- `ai.openclaw.dashboard-api` — spending-today, upcoming-transactions, review queue, and budget display.

## Recurring transaction maintenance

Recurring estimates live in the `expenses` table. The dashboard lists active
monthly entries due today through month end, ordered by date and name, and
the same table drives the shortfall forecast's 45-day expansion. Update the
table through `scripts/finance-workflow.js` (`add-expense`/`remove-expense`);
the kiosk's own editing interface (bill-add-row on the Upcoming Transactions
tab) calls the same mutation path.

## Balance tracking: retired once, rebuilt narrower — know the difference

Balance tracking was deliberately retired 2026-07-31 (full advisor scope:
SimpleFIN + Plaid, debt tracking, portfolio tracking, income scheduling,
execApprovals). Aaron explicitly restarted it 2026-08-02, Plaid only, and
**only up through balance + a bill-based shortfall forecast** — not a
restoration of the full retired scope. Don't reintroduce debt/portfolio/
income-schedule tracking or the execApprovals flow without Aaron asking for
it again; it's dormant, not planned.

The pre-2026-07-31 source and database are preserved under
`migration-backups/2026-07-31-balance-tracking-retirement/` — useful for
reference (e.g. `upcoming_check.py`'s forecast logic, which the current
`getBudget()` adapts) but not for restoring wholesale. Credentials were not
included in that backup.

## Plaid cost boundary

The active pipeline may call `/transactions/sync`, which is covered by the
Transactions subscription. It must not call `/accounts/balance/get` (the
per-request real-time Balance product) or `/transactions/refresh` (a separately
priced forced refresh) unless Aaron explicitly chooses to re-enable paid calls.
The archived paid polling implementation is under
`archive/paid-balance-polling-2026-08-03/`.

Plaid's `SYNC_UPDATES_AVAILABLE` webhook is active at the Tailscale Funnel URL.
The receiver validates Plaid's ES256 signature, five-minute issue time, and
raw-body SHA-256 before queuing an Item-specific sync. The 03:15 scheduled sync
is retained only as reconciliation if a webhook or tunnel is temporarily down.
