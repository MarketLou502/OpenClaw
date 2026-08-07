# HEARTBEAT.md - No Finance heartbeat

Finance-agent has no model-driven heartbeat and sends no proactive messages —
same as every other widget specialist. Its active background behavior is two
independent deterministic `launchd` pipelines, both unaffected by this file
and both running regardless of whether a conversation is active:

- `com.openclaw.finance.pollmail` — Capital One Mail poll into `finance.db`, every 60s.
- `com.openclaw.finance.plaid-webhook` — verified event-driven Plaid updates.
- `com.openclaw.finance.transactions-sync` — 03:15 reconciliation fallback; never forces a paid refresh.

Neither pipeline sends a proactive message on its own — the shortfall
forecast they feed (SOUL.md) is answer-only, surfaced when Aaron checks the
dashboard or asks, not pushed.
