# Plan: Wire Router Coverage for Every Remaining Tool Catalog Entry

Handoff doc for whichever coding agent picks this up. This is a **follow-on**
to `TOOL_CATALOG_PLAN.md` (read that first — it explains how the router
works, the DOMAIN_FASTPATHS pattern, and the safety model around auto-apply
vs. human-reviewed changes; this doc assumes you already have that context
and doesn't re-derive it).

`TOOL_CATALOG_PLAN.md`'s own Phase 4 described wiring unrouted tools as
"case-by-case, do last" work. Aaron has since asked for a full sweep instead:
every tool in `services/trace-noc/lib/tool-catalog.js` that currently has
`routerWired: false` should get real router coverage, i.e. every ❌ in the
catalog becomes a ✅. This doc scopes that sweep, flags what's explicitly
**not** in scope and why, and gives the mechanics/patterns to reuse so each
new intent looks like it belongs next to the existing ones.

## Do not skip this: scope exclusions

Of the 36 catalog entries with `routerWired: false` as of 2026-08-07, **9 are
excluded from this sweep.** Wiring any of these without stopping to ask Aaron
first would either reverse a decision he already made on purpose, or wire
something that was never meant to be a voice/text phrase target.

**1. Six intents that were already wired once, then deliberately removed —
leave them removed:**

`services/shared-routine-router/index.js` (around line 269) has this
verbatim, with the grammar YAML for all six already deleted:

```js
case 'GetBalance':
case 'GetBudgetForecast':
case 'EditListItem':
case 'RemoveListItem':
case 'RenameList':
case 'DeleteList':
  // These intents have been removed from the router — they were
  // low-frequency operations better handled by the model-based agent.
  return { handled: false };
```

Confirmed with Aaron on 2026-08-07: correct, low-frequency, stays excluded.
Maps to these catalog entries — do not wire them:
- `finance.balance`
- `finance.budget-forecast`
- `lists.rename-list`
- `lists.delete-list`
- `lists.edit-list-item`
- `lists.remove-list-item`

**2. One entry that isn't a phrase target at all:**

- `boards.list-boards` — this exists purely as a machine-readable board enum
  for other services (e.g. the voice adapter builds a tool-call enum from
  it). Nobody says "list boards" to get this; it's not a router candidate.

**3. Two entries already fast via a different mechanism:**

- `health.find-recipe`
- `health.add-recipe`

These are the backing calls behind `DOMAIN_FASTPATHS`'s `food-recipe` entry
in `phrase-tracker.js` — they're already reached without going through the
hassil grammar at all (`ha-voice-adapter/server.js`'s `parseFoodReport`
regex calls them directly). Wiring them into the router grammar too would be
redundant, not additive.

**Also flag, don't silently proceed:** as of 2026-08-07 there's an
**unimplemented redesign in progress** (discussed with Aaron the same
session this plan was written, not yet built) that splits health-tracker's
recipe-adjacent data into three concepts: **Repeats** (health-tracker's
simple name/calories/protein list, moving out of meal-planner's SQLite
database into its own flat JSON file), **Recipes** (meal-planner's, stays in
SQLite, unchanged), and **Pantry** (a currently-in-house-ingredients list,
flat JSON, owned by meal-planner — its table already exists in
`meal-planner-workflow.js`'s schema as `pantry_items` but has zero CRUD
commands today). None of that has been built yet. It affects this sweep
because:
- `health.list-recipes` (in scope below) currently queries meal-planner's
  shared `recipes` table — if the Repeats migration lands first, this
  command's name and behavior will likely change (probably renamed to
  something like `list-repeats` against a new JSON store). **Check with
  Aaron whether that migration has landed before wiring this one; if it
  hasn't, either wait or confirm he wants it wired against the
  soon-to-be-replaced interface anyway.**
- Pantry has no commands yet at all, so nothing pantry-related exists in the
  tool catalog to wire — not a gap in this plan, just not built yet upstream.

## In scope: 27 entries

Everything else. Grouped by owning script/domain, with per-item notes on
what makes each one easy or hard — read these before picking an order, don't
just go top-to-bottom.

### `boards` — `workspace-main/scripts/dashboard-workflow.js`
- `boards.schedule` — 4 slots (board, query, date, time). Same shape as
  `scheduler.reschedule` below; expect similar grammar complexity.
- `boards.reschedule` — same 4 slots.
- `boards.unschedule` — 2 slots (board, query) — simpler, do this one first
  of the three to establish the pattern.

### `scheduler` — `workspace-main/scripts/calendar-workflow.js`
- `scheduler.list` — 1 slot (date). Read-only, low risk, good first target.
- `scheduler.delete` — 2 slots (title, date).
- `scheduler.reschedule` — 4 slots (title, date, new-date, new-time). Most
  complex item in this whole sweep — do it last, after the date/time
  extraction pattern (see `parseCalendarWhen` below) has been proven out on
  simpler cases.

### `finance-agent` — `workspace-finance-agent/scripts/finance-workflow.js`
No `finance.yaml` exists yet — this is a first-time grammar file for this
domain, and `index.js` has no `FINANCE_SCRIPT` path constant yet either
(mirror `HEALTH_SCRIPT`'s pattern to add one).
- `finance.add-expense` — 3 required slots (name, amount, due-day) + 1
  optional (notes). Amount and due-day both need numeric extraction —
  reuse the regex-based approach `parseCalendarWhen` uses for time, not a
  hassil wildcard, since hassil slots are text not validated numbers.
- `finance.review` — 1 slot (id), but it's an opaque database integer.
  **Flag for Aaron before building:** nobody has an expense-review ID
  memorized to say out loud. This may not be a realistic voice/text target
  at all — worth confirming intent before writing grammar for it.
- `finance.remove-expense` — same opaque-integer-ID problem as `review`.
  Flag the same way.

### `health-tracker` — `workspace-health-tracker/scripts/health-workflow.js`
- `health.list-today` — 0-1 slot (optional date). Low risk.
- `health.activity-today` — 0-1 slot (optional date). Low risk.
- `health.list-recipes` — 0 slots, but **see the Repeats-migration flag
  above before touching this one.**
- `health.correct-food`, `health.remove-food`, `health.undo` — each acts on
  "the most recent applicable entry" with 0 required slots beyond an
  optional date; the workflow script itself does the lookup
  (`selectEntry`). Low slot complexity, but these are voice-triggered
  *mutations with no confirmation step* — read `selectEntry`'s matching
  logic in `health-workflow.js` closely before wiring, and consider
  whether the router should require an explicit "date" slot rather than
  silently defaulting to today, given the fallback picks the single most
  recent entry with no read-back.
- `health.log-food` — **do not treat this as a normal grammar-wiring task.**
  It requires `resolution-type`, `serving`, `calories`, and `protein` as
  required args, none of which a caller can just say ("I had a burger" does
  not contain a calorie count). The existing `food-recipe` DOMAIN_FASTPATHS
  entry only handles the exact-known-recipe case; unknown food still falls
  through to Main today by design, because resolving "a burger" into
  calories/protein needs real lookup logic (USDA index, vendor cache,
  estimate), not sentence-slot extraction. Wiring this properly is a
  distinct project, not a Phase-4-style grammar addition — flag it back to
  Aaron rather than attempting it as part of this sweep.

### `meal-planner` — `workspace-meal-planner/scripts/meal-planner-workflow.js`
No `meal-planner.yaml` exists yet, and no `MEAL_PLANNER_SCRIPT` constant in
`index.js` yet either — same first-time-domain setup as finance.
- `meal-planner.get-plan` — 0-1 slot (date). Good first target for this
  domain.
- `meal-planner.list-recipes` — 0-2 slots (type, tag), all optional.
- `meal-planner.find-recipe` — 1 slot (query).
- `meal-planner.confirm-plan` — 0-1 slot (date).
- `meal-planner.assemble-plan` — 0-2 slots (date, lock-existing flag).
- `meal-planner.add-plan-item` — 2 required slots (slot, recipe-name).
- `meal-planner.swap-plan-item`, `meal-planner.remove-plan-item` — both key
  off `--item-id`, an opaque UUID. Same problem as `finance.review`/
  `finance.remove-expense` — flag before building; these may need the
  workflow script extended to accept a fuzzy query (slot + recipe name, the
  way `boards.complete` resolves by text) instead of a bare ID, which would
  be a workflow-script change, not just a router change.
- `meal-planner.add-recipe`, `meal-planner.update-recipe`,
  `meal-planner.remove-recipe` — `add-recipe` alone takes up to 9 args
  including free-form `ingredients` (a `name:quantity,name:quantity` mini
  format) and `tags`/`aliases` as CSV. This is a poor fit for a single
  hassil sentence pattern. Recommend treating recipe *creation* as
  out-of-voice-scope (dashboard form territory, same as the existing
  `formFields` generic-widget pattern from `TOOL_CATALOG_PLAN.md` Phase 3)
  rather than forcing it into router grammar. `remove-recipe` (id-or-name)
  is more reasonable to wire on its own if Aaron wants it.

## Mechanics: how to actually wire a new intent

1. **Grammar file**: add to an existing `sentences/en/*.yaml` file if the
   tool belongs to a domain that already has one (calendar.yaml,
   dashboard.yaml, health.yaml), or create a new file
   (`finance.yaml`, `meal-planner.yaml`) for the two domains that don't yet.
   No registration step needed beyond creating the file — `recognize.py`'s
   `load_intents()` globs `sentences/en/*.yaml` automatically.
2. **Case in `index.js`**: add a `case 'YourIntentName':` in
   `routeRoutineRequest`'s switch, following the existing style — validate
   required slots, return `{ handled: false }` if a required slot is
   missing (never call the workflow script with a hole in required args),
   set `route`, call `runWorkflow(SCRIPT, [...args], 'label')`.
3. **New script path constants**: `finance-workflow.js` and
   `meal-planner-workflow.js` need `FINANCE_SCRIPT`/`MEAL_PLANNER_SCRIPT`
   constants added near the top of `index.js`, mirroring `HEALTH_SCRIPT`.
4. **Idempotency keys**: any mutation (not a read) needs one — reuse
   `stableIdempotencyKey(context, text, route)`, already defined in
   `index.js` and used by `WorkoutLog`/`DailyRunLog`. Don't invent a second
   idempotency scheme.
5. **Slot normalization patterns already established, reuse them rather
   than inventing new ones**:
   - `boardKey()` — normalizes a free-text board name against a known enum
     (work/personal/market-lou/grocery). Same shape needed for anything
     with a small fixed value set (e.g. `meal-planner.add-plan-item`'s
     `slot` arg: breakfast/lunch/dinner/snack).
   - `parseCalendarWhen()` — regex-based date/time extraction, deliberately
     *not* a hassil wildcard slot, because arithmetic (today/tomorrow →
     ISO date) isn't phrasing variety and hassil doesn't validate numbers
     anyway. Reuse this approach for `finance.add-expense`'s `amount`/
     `due-day`, and for `scheduler.delete`/`scheduler.reschedule`'s dates.
6. **Ambiguous-match safety already lives in the workflow scripts, not the
   router** — `chooseUniqueMatch()` in `dashboard-workflow.js`,
   `chooseEvent()` in `calendar-workflow.js`, `selectEntry()` in
   `health-workflow.js` all already refuse to act when a query matches more
   than one candidate. The router's job is only to extract slots and call
   the right subcommand; don't re-implement matching logic in `index.js`.

## Safety rules (carried over from TOOL_CATALOG_PLAN.md, still apply)

- **Every new intent here is the higher-risk, human-reviewed path** — new
  YAML block + new `case`, not the existing one-click sentence-append
  auto-apply flow. Land each one as its own small, reviewed change. Do not
  batch multiple new intents into one commit/PR.
- **Test each new intent against every other intent's existing sentences
  before considering it done** — `recognize.py`'s `pick_best()` picks the
  single best match across *all* loaded intents, not per-file, so a new
  pattern can silently steal matches from (or lose to) something in a
  completely different domain's YAML file. There's no automated negative-
  test generation for this yet (a known gap noted in
  `TOOL_CATALOG_PLAN.md`) — check by hand.
- After each intent lands: flip that entry's `routerWired` to `true` (and
  set `routerRoute`) in `services/trace-noc/lib/tool-catalog.js`, **and**
  add the corresponding entry to `ROUTE_TO_YAML` in
  `services/trace-noc/lib/phrase-tracker.js` — that map's own comment says
  it "must be updated by hand if that switch changes." Both files will
  silently drift out of truth if only one gets updated.

## Suggested order

Lowest-risk first, biggest-unknowns last:

1. Read-only, 0-1 slot: `scheduler.list`, `health.list-today`,
   `health.activity-today`, `meal-planner.get-plan`,
   `meal-planner.list-recipes`, `meal-planner.find-recipe`,
   `meal-planner.confirm-plan` (skip `health.list-recipes` until the
   Repeats-migration question above is resolved).
2. Simple mutations, 1-2 slots, no ID-lookup problem: `boards.unschedule`,
   `scheduler.delete`, `health.correct-food`, `health.remove-food`,
   `health.undo`, `meal-planner.add-plan-item`, `meal-planner.assemble-plan`.
3. Multi-slot mutations: `boards.schedule`, `boards.reschedule`,
   `scheduler.reschedule`, `finance.add-expense`.
4. Stop and ask Aaron before building: `finance.review`,
   `finance.remove-expense`, `meal-planner.swap-plan-item`,
   `meal-planner.remove-plan-item` (all four have the opaque-ID problem),
   and `health.log-food` (needs a resolution pipeline, not grammar).
   `meal-planner.add-recipe`/`update-recipe`/`remove-recipe` are probably
   dashboard-form territory rather than voice targets — confirm before
   spending grammar-authoring effort on them.
