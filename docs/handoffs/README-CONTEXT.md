# OpenClaw AI Handoff Packet

This folder contains sanitized copies of the files most useful for reviewing
the current OpenClaw agent, message-routing, automation, and dashboard
architecture.

The source files remain in their original locations. Editing files in this
handoff folder does not change the running OpenClaw installation.

## Contents

- `openclaw.sanitized.json` — configured agents, channel bindings, models,
  Gateway settings, and tool restrictions.
- `routing/` — the custom iMessage watcher and inbound router.
- `agents/` — operating instructions for the active agents.
- `services/` — the dashboard REST service and its shared atomic datastore.
- `automation/` — relevant launchd definitions and sanitized cron jobs.

## Important current-state facts

- The OpenClaw Gateway is the control plane on local port 18789.
- Native iMessage is bound directly to Main through the Gateway.
- Daily Tracker and Health Tracker are internal specialists with no direct
  messaging-channel bindings.
- Sports Betting is the only active Discord account/binding.
- The FBB agent and former raw-iMessage watcher/handler are archived under
  `~/.openclaw/archives/` and are not active dependencies.
- The Echo dashboard uses a separate REST service on LAN port 18795.
- The dashboard service is the single writer for shared task, grocery, goal,
  and health JSON state.

## Sanitization

Credential values, API keys, messaging IDs, the owner's phone number, and
the owner's calendar email were replaced with `<REDACTED>` placeholders.
No credential files, session transcripts, personal memory files, finance
database, dashboard token, financial PIN, or runtime logs are included.

Because sanitization is pattern-based, review files once more before sharing
them outside a trusted ChatGPT project.
