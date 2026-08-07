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

**This system is fully separate from meal planning below — never bridge the
two.**

```
node /Users/aaronmacmini/.openclaw/workspace-main/scripts/dashboard-workflow.js list --board grocery
node /Users/aaronmacmini/.openclaw/workspace-main/scripts/dashboard-workflow.js add --board grocery --text "Milk"
node /Users/aaronmacmini/.openclaw/workspace-main/scripts/dashboard-workflow.js complete --board grocery --query "milk"
node /Users/aaronmacmini/.openclaw/workspace-main/scripts/dashboard-workflow.js remove --board grocery --query "duplicate item"
```

Data location (read-only context, not yours to edit directly):
`workspace-daily-tracker/tasks/grocery.json`, owned by `dashboard-api` (the
single writer); never edit this file yourself.

**This system is fully separate from meal planning below — never bridge the
two.**

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
- `assemble-plan`/`get-plan` never touch the grocery list in any way.

## Data location (read-only context, not yours to edit directly)

- `workspace-meal-planner/data/meal-planner.sqlite`

Owned by `dashboard-api` and this script only; always go through
`meal-planner-workflow.js` above, never edit the SQLite file yourself.
