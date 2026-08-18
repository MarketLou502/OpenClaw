# TOOLS.md — Meal Planner

## Grocery workflow

Your `exec` tool is scoped to your own workspace (`workspace-meal-planner/`)
via `tools.fs.workspaceOnly: true`. Run the script in your own workspace:

```
node /Users/aaronmacmini/.openclaw/workspace-meal-planner/scripts/dashboard-workflow.js list --board grocery
node /Users/aaronmacmini/.openclaw/workspace-meal-planner/scripts/dashboard-workflow.js add --board grocery --text "Milk"
node /Users/aaronmacmini/.openclaw/workspace-meal-planner/scripts/dashboard-workflow.js complete --board grocery --query "milk"
node /Users/aaronmacmini/.openclaw/workspace-meal-planner/scripts/dashboard-workflow.js remove --board grocery --query "duplicate item"
```

The program returns JSON. If `ok` is true, use its `reply` field as the
factual core of your response back to Main. If it returns `AMBIGUOUS_MATCH`,
ask Main (who asks Aaron) which one was meant — never choose one yourself. If
it returns `NOT_FOUND`, say nothing was changed.

Data location (read-only context, not yours to edit directly):
`workspace-daily-tracker/tasks/grocery.json`, owned by `dashboard-api` (the
single writer); always go through the script above, never edit this file
yourself.

**As of Workstream 4 (pantry management), this is no longer fully separate
from meal planning.** `meal-planner-workflow.js confirm-plan` deducts pantry
stock and can auto-add low-stock items to this same grocery board itself
(tagged `"(low stock)"`) — see the Pantry section below. You still don't add
grocery items by hand "because of a meal plan"; that auto-add is the
workflow script's job.

---

## Meal-planning workflow

Script:
`/Users/aaronmacmini/.openclaw/workspace-meal-planner/scripts/meal-planner-workflow.js`

Run it via `exec` — this script is inside your own workspace, so
`workspaceOnly` allows it. Never edit
`workspace-meal-planner/data/meal-planner.sqlite` directly, always go
through this script. It returns JSON with `{ok, code, error}` on failure
or the requested data on success.

This script does all the calorie/protein math. You never compute totals
yourself — call `assemble-plan` or `get-plan` and relay what it returns.

This script does all the calorie/protein math. You never compute totals
yourself — the script's output is the source of truth.

### Teaching recipes

```bash
node /Users/aaronmacmini/.openclaw/workspace-meal-planner/scripts/meal-planner-workflow.js add-recipe \
  --name "Custom Tuna Salad Sandwich" --type quick --serving "1 sandwich" \
  --calories 315 --protein 19 --meal-slot-hint lunch \
  --tags "sandwich,high-protein" --ingredients "tuna:2 cans,eggs:3,mayo:0.25 cup,white bread:2 slices"

node /Users/aaronmacmini/.openclaw/workspace-meal-planner/scripts/meal-planner-workflow.js find-recipe --query "tuna"
node /Users/aaronmacmini/.openclaw/workspace-meal-planner/scripts/meal-planner-workflow.js list-recipes --active-only
node /Users/aaronmacmini/.openclaw/workspace-meal-planner/scripts/meal-planner-workflow.js update-recipe --match "Daily Coffee" --calories 55
node /Users/aaronmacmini/.openclaw/workspace-meal-planner/scripts/meal-planner-workflow.js remove-recipe --name "Old Recipe"
```

`add-recipe` rejects a duplicate name/alias — if Aaron describes a meal that
sounds close to an existing one, use `find-recipe` first and ask whether he
means to update it (`update-recipe`) instead of adding a near-duplicate.

`type` is `quick` (grab-and-go, minimal prep) or `prepared` (cooked from
ingredients). `meal-slot-hint` is one of `breakfast`, `lunch`, `dinner`,
`snack`, `any` — used by `assemble-plan` to prefer the right recipe for the
right slot, not a hard restriction.

### Building/adjusting today's plan

```bash
node /Users/aaronmacmini/.openclaw/workspace-meal-planner/scripts/meal-planner-workflow.js get-plan
node /Users/aaronmacmini/.openclaw/workspace-meal-planner/scripts/meal-planner-workflow.js assemble-plan
node /Users/aaronmacmini/.openclaw/workspace-meal-planner/scripts/meal-planner-workflow.js assemble-plan --lock-existing
node /Users/aaronmacmini/.openclaw/workspace-meal-planner/scripts/meal-planner-workflow.js swap-plan-item --item-id ITEM_ID --recipe-name "Boost Protein Shake"
node /Users/aaronmacmini/.openclaw/workspace-meal-planner/scripts/meal-planner-workflow.js remove-plan-item --item-id ITEM_ID
node /Users/aaronmacmini/.openclaw/workspace-meal-planner/scripts/meal-planner-workflow.js confirm-plan
```

- `get-plan` is read-only — use it to check today's plan without changing
  anything.
- `assemble-plan` fetches Aaron's remaining calorie/protein budget for today
  live from `GET /api/health` on dashboard-api (target minus what
  health-tracker has already logged as eaten) and fills empty meal slots from
  the taught recipe library. Plain `assemble-plan` rebuilds the whole day;
  `--lock-existing` only fills slots that are still empty, preserving any
  edits Aaron already made.
- If the result includes a `libraryInsufficient` flag, tell Aaron plainly
  that the recipe library doesn't have enough taught meals to hit today's
  targets yet — never fill the gap with an invented recipe.
- `assemble-plan`/`get-plan` never touch the grocery list. `confirm-plan`
  does, indirectly, via the pantry bridge described below.

### Pantry (Workstream 4)

```bash
node /Users/aaronmacmini/.openclaw/workspace-meal-planner/scripts/meal-planner-workflow.js add-pantry-item \
  --name "All-purpose flour" --quantity 2000 --unit g --display-quantity "2 kg" \
  --category pantry --min-quantity 200 --min-unit g --location pantry

node /Users/aaronmacmini/.openclaw/workspace-meal-planner/scripts/meal-planner-workflow.js update-pantry-item \
  --name "all purpose flour" --deduct 200 --unit g
node /Users/aaronmacmini/.openclaw/workspace-meal-planner/scripts/meal-planner-workflow.js update-pantry-item \
  --name "all purpose flour" --set-quantity 1800

node /Users/aaronmacmini/.openclaw/workspace-meal-planner/scripts/meal-planner-workflow.js list-pantry
node /Users/aaronmacmini/.openclaw/workspace-meal-planner/scripts/meal-planner-workflow.js list-pantry --category dairy
node /Users/aaronmacmini/.openclaw/workspace-meal-planner/scripts/meal-planner-workflow.js list-pantry --low-stock

node /Users/aaronmacmini/.openclaw/workspace-meal-planner/scripts/meal-planner-workflow.js remove-pantry-item --name "Old ingredient"

node /Users/aaronmacmini/.openclaw/workspace-meal-planner/scripts/meal-planner-workflow.js find-recipes-by-ingredient --ingredient "chicken"
node /Users/aaronmacmini/.openclaw/workspace-meal-planner/scripts/meal-planner-workflow.js suggest-recipes
```

- Quantities are numeric, tracked in a single unit per item (`--unit`).
  `update-pantry-item --deduct`/`--set-quantity` reject a `--unit` that
  doesn't match what's already tracked, rather than silently mixing units.
- `confirm-plan` (above) auto-deducts the confirmed plan's recipe
  ingredients from pantry stock, matching by the recipe ingredient's
  normalized name against `pantry_stock.normalized_name`. Ingredients not
  tracked in the pantry, with no parseable quantity, or with a mismatched
  unit are silently skipped rather than guessed at.
- If a deduction drops an item below its `min_quantity`, `confirm-plan`
  itself calls dashboard-api's `POST /api/grocery` to add
  `"<item> (low stock)"` to the grocery board, and says so in its `reply`.
  This is the one sanctioned grocery/meal-planning bridge — don't replicate
  it by hand elsewhere.
- `suggest-recipes` scores active recipes by pantry coverage (fraction of
  ingredients currently in stock) blended with the Workstream 3 preference
  score, grouped into `make now` (100% coverage), `almost there` (≥75%), and
  `need a few things` (≥50%). Recipes below 50% coverage aren't returned.

## Food log & preferences (Workstreams 2–3)

```bash
node /Users/aaronmacmini/.openclaw/workspace-meal-planner/scripts/meal-planner-workflow.js get-food-log --days 7
node /Users/aaronmacmini/.openclaw/workspace-meal-planner/scripts/meal-planner-workflow.js get-food-stats --days 30
node /Users/aaronmacmini/.openclaw/workspace-meal-planner/scripts/meal-planner-workflow.js analyze-preferences --days 30
```

- You never write `food_log` rows yourself — `health-workflow.js` mirrors
  every entry Aaron logs with health-tracker into this table automatically,
  matching it against your recipe library (`is_from_library`) and a
  restaurant-keyword heuristic (`is_takeout`).
- `get-food-log` returns raw entries; `get-food-stats` returns aggregate
  totals; `analyze-preferences` returns recipe frequency, takeout ratio,
  meal-slot distribution, and nutritional averages. All are read-only.
- With a thin or empty log, `analyze-preferences` returns zeroed/empty
  results — expected while history is still building, not an error.
- `suggest-recipes` (pantry, above) already consumes this preference score
  internally — no need to call `analyze-preferences` first.

## Dashboard messages (Workstream 5)

```bash
node /Users/aaronmacmini/.openclaw/workspace-meal-planner/scripts/meal-planner-workflow.js list-messages --unread
node /Users/aaronmacmini/.openclaw/workspace-meal-planner/scripts/meal-planner-workflow.js post-message --text "You have 600 cal left today."
node /Users/aaronmacmini/.openclaw/workspace-meal-planner/scripts/meal-planner-workflow.js update-message --id MESSAGE_ID --status read
node /Users/aaronmacmini/.openclaw/workspace-meal-planner/scripts/meal-planner-workflow.js generate-messages
```

- These write to a message area on the kiosk dashboard, separate from the
  plan widget — a passive area Aaron checks himself, not a push
  notification, so it doesn't count as messaging him directly.
- `generate-messages` synthesizes a suggested nudge from the current
  plan/budget/pantry state. Nothing schedules it automatically (heartbeat is
  off, no cron job calls it) — only run it when Main explicitly delegates a
  suggestion/nudge request. Never call it on your own initiative.

## Data location (read-only context, not yours to edit directly)

- `workspace-meal-planner/data/meal-planner.sqlite`

Owned by `dashboard-api` and this script only; always go through
`meal-planner-workflow.js` above, never edit the SQLite file yourself.
