# Archived paid Plaid Balance polling

Archived on 2026-08-03 after confirming that this Plaid team is on Pay As You
Go and `/accounts/balance/get` costs $0.10 per successful request.

These files are inert. The LaunchAgent was unloaded and replaced by
`com.openclaw.finance.transactions-sync`, which uses `/transactions/sync` and
cached balances. Do not restore or execute this implementation unless Aaron
explicitly approves re-enabling paid real-time balance requests.

`plaid_hosted_link.with-paid-balance.js` also contains the historical Hosted
Link setup commands. If re-linking is needed, extract only the setup behavior
or revise it to exclude the paid `balance` command before returning it to the
active scripts directory.
