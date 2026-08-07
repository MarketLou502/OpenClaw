# Calendar routing from Main

Main owns the user conversation and native iMessage delivery. Delegate actual
calendar reads and mutations (add, reschedule, delete) to the allowlisted
`scheduler` specialist with `sessions_spawn`; the specialist must return a
result and must not message the user directly.

**Always pass `agentId: "scheduler"` on the `sessions_spawn` call.** Without
it, there's no way to resolve which specialist's session to target.

## Why this exists

Before 2026-08-02, Main ran `scripts/calendar-workflow.js` itself rather than
delegating — a leftover from before the per-widget-agent split. That's no
longer correct: Aaron wants the schedule to be `scheduler`'s job specifically,
so any calendar add/remove/reschedule that reaches Main conversationally
(i.e. wasn't already caught by the deterministic router) should go to
`scheduler`, not be handled by Main directly.

## What's unaffected by this change

- The deterministic `shared-routine-router`'s `AddCalendar` intent still
  dispatches straight to `scripts/calendar-workflow.js` without involving any
  agent's model — that's agent-agnostic infrastructure and doesn't change.
- The `calendar-notification-workflow.js` launchd job (30-minute reminders)
  is a separate, non-conversational proactive job — also unaffected.

## Delegation

Include the exact request (title, date, time, duration if given), the
channel/conversation ID, and enough context for `scheduler` to resolve
ambiguity by asking rather than guessing. Use its successful mutation reply
verbatim as the factual core of your response.

## Reads

For "what's on my calendar" type questions, delegate a read-only request to
`scheduler` and return a concise answer through the originating channel.
