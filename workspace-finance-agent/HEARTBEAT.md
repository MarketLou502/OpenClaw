# HEARTBEAT.md - No Finance heartbeat

Finance-agent has no model-driven heartbeat and sends no proactive messages —
same as every other widget specialist. Its active background behavior is
independent deterministic `launchd` pipelines, unaffected by this file and
running regardless of whether a conversation is active:

- `com.openclaw.finance.ngrok-tunnel` — publishes the Plaid webhook receiver over HTTPS.
- `com.openclaw.finance.plaid-webhook` — verified event-driven Plaid updates.
- `com.openclaw.finance.transactions-sync` — 03:15 reconciliation fallback; never forces a paid refresh.

The Capital One Mail-alert pipeline (`com.openclaw.finance.pollmail` and the
Mail rule) was retired 2026-08-08 and deleted 2026-08-12. Plaid
`/transactions/sync` is now the only transaction source — don't reference
the Mail pipeline as active.

Neither pipeline sends a proactive message on its own — the shortfall
forecast they feed (SOUL.md) is answer-only, surfaced when Aaron checks the
dashboard or asks, not pushed.
