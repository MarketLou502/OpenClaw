# TOOLS.md - Local Notes

Skills define _how_ tools work. This file is for _your_ specifics — the stuff that's unique to your setup.

## What Goes Here

Things like:

- Camera names and locations
- SSH hosts and aliases
- Preferred voices for TTS
- Speaker/room names
- Device nicknames
- Anything environment-specific

## Examples

```markdown
### Cameras

- living-room → Main area, 180° wide angle
- front-door → Entrance, motion-triggered

### SSH

- home-server → 192.168.1.100, user: admin

### TTS

- Preferred voice: "Nova" (warm, slightly British)
- Default speaker: Kitchen HomePod
```

## Why Separate?

Skills are shared. Your setup is yours. Keeping them apart means you can update skills without losing your notes, and share skills without leaking your infrastructure.

---

Add whatever helps you do your job. This is your cheat sheet.

## Internal specialist role

Native iMessage is owned by `main`. Health requests arrive here as an internal
OpenClaw subagent task. Complete only the assigned health task and return one
concise factual result to main. Never send to iMessage or Discord directly;
main consolidates and the Gateway delivers the user-facing response.

For read-only/test prompts, do not update files, daily totals, habits, or the
dashboard. Quoted examples are not food consumed or workouts completed.

## Health state and dashboard

- Daily targets: 3,250 kcal, 160g protein, eight workouts,
  and one 30-minute run.
- Dashboard API: `http://127.0.0.1:18795`
- Bearer token file:
  `/Users/aaronmacmini/.openclaw/service-env/dashboard-api.token`
- Deterministic food ledger:
  `/Users/aaronmacmini/.openclaw/workspace-health-tracker/data/health-ledger.sqlite`
- Read-only local USDA index:
  `/Users/aaronmacmini/.openclaw/workspace-health-tracker/data/nutrition.db`
- Food workflow:
  `/Users/aaronmacmini/.openclaw/workspace-health-tracker/scripts/health-workflow.js`
- USDA query tool:
  `/Users/aaronmacmini/.openclaw/workspace-health-tracker/scripts/nutrition-index.js`

The food workflow is the only writer for food entries, corrections,
undo state, cumulative calorie/protein totals, and the food-driven dashboard
update. Do not directly edit the SQLite files, `today-state.json`, or a daily
Markdown file for a new food report. Do not call `/api/health` separately after
the workflow succeeds; the workflow already sends the full cumulative totals.
Recipes are stored in the shared recipe database
(`workspace-meal-planner/data/meal-planner.sqlite`) that both health-tracker
and meal-planner read and write — health-tracker does not own recipe data.

### Food resolution protocol

For an actual food/drink report:

1. Call `find-recipe --query` with the normalized food name. The recipe
   database is shared with meal-planner and includes staples, recipes, and
   their aliases.
2. If there is an exact recipe/alias match, use its exact serving, calories,
   protein, ID, and confidence `1`.
3. Otherwise query the local USDA index. Use a clean food query; quantity and
   words such as `medium`, `cup`, or `ounces` are serving information, not the
   food identity. Prefer a close description and the portion that best matches
   Aaron's report.
4. If no local match is reasonably applicable—especially a named restaurant
   item—make a serving-aware estimate yourself as Claude Haiku. The initial
   workflow has no live web search. Mark it `estimate`, use honest confidence,
   and never say a current vendor website was checked.
5. Call `log-food` once with total calories/protein for the complete reported
   amount, the original wording, source channel/conversation, and the stable
   idempotency key supplied by main.
6. Return the workflow JSON result to main. On normal success, the only
   user-facing confirmation is its `reply`: `Got that logged.` Do not volunteer
   nutrition numbers unless Aaron asked for them.

Examples (values are examples only; never treat them as consumed food):

```bash
node /Users/aaronmacmini/.openclaw/workspace-health-tracker/scripts/health-workflow.js find-recipe --query "my coffee"
node /Users/aaronmacmini/.openclaw/workspace-health-tracker/scripts/nutrition-index.js search --query "grilled chicken breast" --limit 5
node /Users/aaronmacmini/.openclaw/workspace-health-tracker/scripts/health-workflow.js log-food --name "Example" --serving "1 serving" --calories 100 --protein 10 --resolution-type estimate --confidence 0.5 --original "quoted example" --origin-channel test --conversation-id test --idempotency-key test-only
```

The final example must only be used against an isolated test database. Never
run it against the production ledger.

### Food corrections and queries

- `list-today` returns active entries and totals.
- `get-entry --id ID` returns one active entry.
- `correct-food --id ID ... --idempotency-key KEY` supersedes an entry while
  preserving history.
- `remove-food --id ID --idempotency-key KEY` voids an entry.
- `undo --conversation-id ID --idempotency-key KEY` reverses the latest
  applicable mutation in that conversation.
- `add-recipe` requires a distinct name, serving, calories, and protein. It
  rejects duplicate names/aliases and does not update/delete existing recipes.

Resolve `that` and `last` against the most recent active entry in the same
conversation. Use the returned stable entry ID for mutations. If there is no
safe target, ask a focused clarification instead of changing another entry.

Every mutation requires a stable idempotency key derived from the originating
request, not a new random key on each retry. Report a dashboard sync failure
honestly; do not retry by logging the food a second time.

### Deterministic exercise protocol

The health workflow is the only writer for workout and daily-run ledger
entries. Every mutation requires Main's stable inbound idempotency key.

For an explicit workout report, log one workout:

```bash
node /Users/aaronmacmini/.openclaw/workspace-health-tracker/scripts/health-workflow.js log-workout --origin-channel imessage --conversation-id chat_id:1 --idempotency-key REQUEST_KEY
```

Each distinct inbound request counts once, and multiple workouts in the same
clock hour are allowed. The stable idempotency key prevents only the same
request from being counted twice. The command synchronizes the bottom-left
Health widget's `hourlyWorkouts` value against target 8. It does not mark the
top daily run goal.

For “I finished my run,” “I just ran,” or an equivalent explicit report:

```bash
node /Users/aaronmacmini/.openclaw/workspace-health-tracker/scripts/health-workflow.js log-daily-run --duration-minutes 30 --origin-channel imessage --conversation-id chat_id:1 --idempotency-key REQUEST_KEY
```

Default to 30 minutes only when no duration was given. The command records one
run per day and marks the top dashboard goal `Workout/Run` done; it does not
change the bottom Health widget. Return the workflow reply to Main. Normal
success is exactly `Got that logged.`

Use `activity-today` for a read-only activity summary. Never run either
mutation for a quoted example, test, plan, or hypothetical statement.
