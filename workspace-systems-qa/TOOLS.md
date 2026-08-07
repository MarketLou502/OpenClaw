# TOOLS.md — Systems QA

Tool access is still intentionally conservative — no web, no messaging, no
cron/gateway, no ability to spawn or control other sessions yourself —
until Aaron designs the rest of this agent's job. Beyond the two jobs
documented in `SOUL.md`, do not use any tool for a purpose not described
here.

## Job 1: stuck-delegate diagnostics

Two tools are un-denied as of 2026-08-02, for exactly one purpose (see
`SOUL.md`'s "Your one designed job" section):

- **`session_status`** — given a `sessionKey`, reports its runtime state
  (running / completed+result / errored+error). This is your first, usually
  only, diagnostic step.
- **`sessions_history`** — given a `sessionKey`, returns the actual
  transcript/tool-call trace for that session. Use this only when
  `session_status` alone doesn't clearly explain what happened.

Every other `sessions_*` tool (`sessions_spawn`, `sessions_send`,
`sessions_list`, `sessions_yield`) stays denied — you investigate a session
someone else spawned, you don't spawn, message, or control your own or
anyone else's.

## Job 2: nightly routing QA review

Your `openclaw.json` entry sets `tools.fs.workspaceOnly: true`, which
confines the generic `read`/`write`/`edit`/`exec` tools to your own
workspace (`workspace-systems-qa/`). You can `exec` scripts within your
workspace freely; you cannot exec anything outside it. The two wrapper
scripts below are the only way you interact with anything outside your
workspace.

- **`scripts/qa-read.sh`** — the only way you read anything outside your
  own workspace. Fixed whitelist of operations (session index, session
  transcripts, the voice fast-path log, router grammar files, food-entry
  records, your watermark). Run it with no arguments to see the current
  list — it's the actual enforcement, this doc is not guaranteed to stay in
  sync with it.
- **`scripts/qa-propose.sh`** — the only way you write anything, ever, in
  this job. Writes only land under `memory/`, `proposed-diffs/`, and
  `state/` inside your own workspace. It has no path that reaches
  `services/shared-routine-router/` or any other agent's files — there is
  no way to use it to apply a change, only to propose one.

Full step-by-step recipe lives in `SOUL.md`'s "Your second designed job"
section — this file only covers the tool boundary, not the task logic.
