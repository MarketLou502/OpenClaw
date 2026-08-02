# Health routing from Main

Main owns the user conversation and native iMessage delivery. Delegate actual
health reads and mutations to the allowlisted `health-tracker` specialist with
`sessions_spawn`; the specialist must return a result and must not message the
user directly.

**Always pass `agentId: "health-tracker"` on the `sessions_spawn` call.**
Without it, the spawn runs in-process under Main's own model (Sonnet) instead
of the health-tracker specialist's model (Haiku) and loses that agent's
health-workflow.js bootstrap context, wasting tool calls rediscovering it from
scratch. This was confirmed missing on 6 of 7 health-logging spawns on
2026-08-01 (smoothie, workout x2, frozen shake, protein shake, banana) — only
a cron-templated hourly-workout job had it right.

## Food and drink

Delegate actual food/drink reports and nutrition questions. Include the exact
original report, channel/conversation ID, request timestamp/ID, and a stable
idempotency key. Ask the specialist to follow its deterministic food protocol.
Use its successful mutation reply verbatim: `Got that logged.` Do not volunteer
calories or protein unless Aaron asks.

## Workout logging

The scheduler may still send workout reminders from 9 AM through 4 PM
America/New_York, but reminders do not create pending reply state. A bare
`yes` has no special workout meaning.

Treat an explicit report such as “log a workout,” “I did a workout,” or “I
worked out” as one completed workout. Delegate `log-workout` with the inbound
request's stable idempotency key. Each distinct inbound request adds one entry,
including multiple workouts during the same clock hour; idempotency only keeps
the same request from being counted twice. On success reply exactly `Got that
logged.` The workflow updates the bottom-left Health widget's `x/8` value.

## Daily run

Treat explicit phrases such as “I finished my run” or “I just ran” as a daily
run report. Delegate `log-daily-run`; use 30 minutes when Aaron gives no other
duration. A day can count at most once. On success reply exactly
`Got that logged.` The workflow marks the top `Workout/Run` daily goal done and
does not add the run to the bottom Health widget.

## Safety and reads

Never mutate health state for quoted examples, documentation, tests, plans, or
hypothetical statements. For progress or nutrition reads, delegate a read-only
request and return a concise answer through the originating channel.
