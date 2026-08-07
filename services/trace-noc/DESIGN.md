# QA Agent Dashboard

Status: Phase 1 working locally; live yogurt trace validated on 2026-08-03.

## Purpose

The QA Agent Dashboard is a local, read-only observability application for reconstructing a
single owner request across OpenClaw's voice adapter, deterministic router,
Main/chief-of-staff session, delegated agent sessions, model calls, tool calls,
domain writes, and dashboard refreshes. Its primary question is not merely
"did the agent reply?" but "where did this request actually travel, what ran,
and which step first diverged from the expected outcome?"

The application runs as an independent service under `services/trace-noc/` and
opens in a browser on loopback only. It is not an agent tool and has no mutation
path into OpenClaw. Systems QA may later query a deliberately narrow, read-only
API exposed by this service.

## Existing foundation

No prior QA Agent Dashboard application or dedicated design was found. The repository
already contains most of the raw evidence the application needs:

- `agents/*/sessions/*.trajectory.jsonl`: structured runtime traces with
  schema/version, trace and run IDs, session key, agent workspace, provider,
  model, channel, prompt, tool metadata, usage, timing, and final status.
- `agents/*/sessions/*.jsonl`: conversation messages, inter-session provenance,
  tool calls, tool results, model/provider metadata, token usage, and cost.
- `agents/*/sessions/sessions.json`: session discovery/index metadata.
- `logs/voice-fastpath.jsonl`: voice requests handled before Main receives a
  session.
- `openclaw sessions export-trajectory`: an existing redacted export boundary.
- Systems QA's `qa-read.sh`: an existing example of allowlisted, read-only
  access to selected evidence.

The yogurt incident proves why cross-source correlation is necessary. Main's
session delegated via `sessions_send`; the health-tracker session used
OpenRouter/DeepSeek, performed nutrition lookups, and successfully wrote the
food entry; its result then reported `dashboard.ok: true` while also reporting
`healthUpdated: false`. Later source inspection established that this is
intentional: food totals are computed live from the ledger, so no cached health
PATCH occurs; `dashboard.ok: true` confirms the notify-only refresh completed.
The NOC must understand operation-specific contracts so it does not turn such
fields into false positives.

## Architecture decision

Build one program with two consumers:

1. A local browser GUI for interactive QA.
2. A small read-only JSON API that Systems QA can call later.

Do not make Systems QA the owner of the collector or UI. An agent under test
must not control the system that preserves and interprets its evidence.

The initial collector should adapt existing files without changing the
Gateway, agents, or workflows. Normalize events into a trace/span model inspired
by OpenTelemetry and OpenInference:

- trace: one owner request and its complete causal path
- span: channel receipt, router decision, agent run, model invocation, tool
  execution, data mutation, dashboard projection, and delivery
- link: a causal relationship when strict parent/child IDs do not cross a
  session boundary
- event: relevant state or evidence attached to a span

OpenClaw's raw IDs remain attached as source attributes. The normalization
layer owns all mapping to external semantic conventions so a future schema
change does not spread throughout the UI.

## Correlation strategy

Correlation is the hardest part and must be explicit rather than inferred only
from timestamps.

Use, in descending order of confidence:

1. Native trace/run/session IDs.
2. Inter-session provenance (`sourceSessionKey`, `sourceTool`) and
   `sessions_send` target/message records.
3. Conversation IDs, tool-call IDs, mutation IDs, idempotency keys, response
   IDs, and channel identifiers.
4. A bounded timestamp plus normalized-message match as a labeled heuristic.

Every link carries a confidence level and explanation. The UI must visually
distinguish exact links from inferred links.

## Product shape

The first viewport is a request investigation screen rather than a generic
metrics dashboard:

- left rail: recent requests, search, channel/status/agent filters
- center: vertical causal flow with branches for delegation and parallel tools
- right inspector: selected step's input/output, source file, timestamps,
  latency, provider/model, local-versus-remote classification, tokens, cost,
  IDs, and failure evidence
- top summary: end-to-end latency, participating agents, tool count, models,
  cost, final outcome, and first suspicious step

Status is multi-dimensional. A tool exit code of zero, an agent's successful
final status, and the user's intended outcome are separate facts. Initial
deterministic checks should flag contradictions such as `ok: true` paired with
an expected update field of `false`, tool errors followed by success language,
timeouts represented as completion, or a persisted mutation without a visible
projection refresh.

## Privacy and safety

- Bind to `127.0.0.1` only.
- Read only allowlisted paths under the OpenClaw state directory.
- Never display secrets or the full configuration snapshot embedded in trace
  metadata.
- Redact credentials, authorization values, phone numbers, and configured
  sensitive fields before indexing or returning API data.
- Keep original logs authoritative; store only a rebuildable local index.
- No replay, retry, edit, delete, config change, or agent-control action in the
  first version.

## Delivery phases

### Phase 1: evidence explorer

- Discover sessions across agents.
- Parse transcript and trajectory JSONL incrementally.
- Reconstruct Main-to-agent delegation.
- Classify models as local or remote from provider/base URL.
- Render the yogurt request as the first golden trace.
- Show source evidence and parsing/correlation confidence.

### Phase 2: outcome diagnosis

- Add voice fast-path and deterministic-router events.
- Add domain mutation and dashboard projection checks.
- Implement first-suspicious-step rules and an investigation summary.
- Add saved QA annotations that are stored outside authoritative logs.

### Phase 3: continuous NOC and QA API

- Watch for appended JSONL records and stream updates to the browser.
- Add aggregate error, latency, routing, model, token, and cost views.
- Expose a narrow read-only endpoint for Systems QA.
- Optionally export normalized OpenTelemetry/OTLP traces to Phoenix, Langfuse,
  or another compatible backend without changing the local UI.

## Initial non-goals

- Replacing OpenClaw's session store or trajectory writer.
- Sending raw prompts or personal data to a hosted observability vendor.
- Giving Systems QA broader file or agent permissions.
- Letting the NOC repair failures automatically.
- Treating heuristic correlation as certain.

## First acceptance test

Given the owner message `I had a half a cup of yogurt.`, the application shows
one connected trace containing:

1. Main received the message from the Home Assistant voice session.
2. Main used OpenRouter/DeepSeek and called `sessions_send` for health-tracker.
3. Health-tracker received the inter-session message with source provenance.
4. Health-tracker used OpenRouter/DeepSeek and ran two nutrition lookups.
5. Health-tracker executed `log-food` and received mutation and entry IDs.
6. The data mutation succeeded.
7. The dashboard sync completed through its notify-only food path; no cached
   health PATCH was expected.
8. The final user-facing confirmation claimed the yogurt was logged.

The trace should mark the request successful unless separate evidence shows the
dashboard notify or subsequent read failed. It must not interpret
`healthUpdated: false` as a food-log failure.
