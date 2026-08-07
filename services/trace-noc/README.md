# QA Agent Dashboard

A loopback-only, read-only request explorer for OpenClaw. It reconstructs owner
requests across Main, delegated agent sessions, model calls, tools, mutations,
and dashboard projection signals.

## Start

```sh
cd /Users/aaronmacmini/.openclaw/services/trace-noc
npm start
```

Open `http://127.0.0.1:18790` in Chrome. The server binds only to the local
loopback interface. Set `TRACE_NOC_PORT` to override the port or
`OPENCLAW_STATE_DIR` to inspect another OpenClaw state directory.

The service is dependency-free and does not require `npm install`.

## Current capabilities

- Discovers active and compacted/reset session transcripts across agents.
- Reads matching OpenClaw trajectory records for session/channel metadata.
- Correlates `sessions_send` delegation using inter-session provenance,
  message content, agent identity, and bounded timestamps.
- Shows model provider and local-versus-remote execution.
- Reports per-model-call and end-to-end request token usage, cache reads, and
  provider-billed cost directly from OpenClaw's session usage records.
- Reconstructs model, tool, delegation, and agent steps with source evidence.
- Redacts secret-bearing fields and phone numbers before returning API data.
- Detects structured tool failures and successful mutations that report no
  expected dashboard projection update.
- Searches and filters recent requests without modifying source logs.

## Read-only API

- `GET /api/health`
- `GET /api/requests?query=yogurt&status=warning&agent=health-tracker`
- `GET /api/requests/:id`

All other HTTP methods are rejected. Systems QA may eventually receive access
to these endpoints through a narrow wrapper, but it should not receive direct
ownership of this service or its evidence rules.

## Validate

```sh
npm test
```

The golden test reconstructs the yogurt request across Main and health-tracker
and asserts that the data-write/dashboard-projection contradiction is flagged.

See [DESIGN.md](./DESIGN.md) for the architecture and phased roadmap.
