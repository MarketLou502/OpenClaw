# API Keys — finance-agent

Actual secret values are never written here — only what exists and where,
per this file's own convention. See SOUL.md's Data Locations section too.

- **Plaid** (Production, linked 2026-08-02): `memory/.plaid_credentials.json`
  (client ID + secret), `memory/.plaid_access.json` (persistent access
  token — treat as a bearer secret), `memory/.plaid_user.json`,
  `memory/.plaid_link_session.json`. All mode 0600, all gitignored via
  `/workspace-finance-agent/memory/.plaid_*.json` in the top-level
  `.gitignore`. Read by `scripts/plaid_hosted_link.js` and
  `scripts/sync_plaid_transactions.js` only. The active script is restricted
  to `/transactions/sync`; paid Balance and forced-refresh calls are archived.
- **Capital One Mail** — no credential file; the poller reads local Mail.app
  data, not an API key.

No other balance provider or financial aggregation credential is
configured — see `FINANCE_ARCHITECTURE.md` for what's explicitly out of
scope (SimpleFIN, brokerage/portfolio APIs, etc.).
