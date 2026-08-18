# Workstream 2: Food Log Sharing — Meal Planner Learns What Aaron Eats

## Goal

Today, when Aaron tells OpenClaw what he ate, only the **health-tracker** agent logs it. The **meal planner** needs to also know what Aaron eats so it can learn his preferences, track how often he eats out vs. in, and use that data to make better meal recommendations.

**Constraint:** Agents cannot communicate with each other directly. All data sharing must go through a shared service — the dashboard API.

## Context — existing data flow

### Current flow (what happens when Aaron logs food)

1. Main receives "I ate a tuna sandwich" via iMessage/Voice
2. Main delegates to health-tracker subagent
3. Health-tracker calls `health-workflow.js log-food --name ... --calories ... --protein ...`
4. `health-workflow.js` writes to `workspace-health-tracker/data/health-ledger.sqlite` (table: `food_entries`)
5. `health-workflow.js` syncs to dashboard-api via `PATCH /api/health` then `POST /api/notify/health`
6. Dashboard API updates in-memory health state and broadcasts via SSE

### What meal planner currently reads

- `GET /api/health` returns `{ calories: { current, target }, protein: { current, target }, hourlyWorkouts: { current, target } }`
- Meal planner's `assemble-plan` calls `fetchHealthBudget()` which hits this endpoint
- It knows how many calories/protein are **remaining**, but NOT **what specific foods** were eaten

### What's needed for preference learning

The meal planner needs to know:
- What specific foods/recipes Aaron ate (names, not just calorie totals)
- Whether each meal was homemade/from the recipe library vs. takeout/restaurant
- Timestamps and meal context (breakfast/lunch/dinner/snack)
- Patterns over time (frequency, favorites, trends)

## What to build

### Option A: Shared food_log table in meal-planner.sqlite (recommended)

Since meal-planner.sqlite is already a shared database (health-tracker also reads recipes from it), extend it with a food log table that both agents can write to.

#### 1. Add food_log table to meal-planner.sqlite

```sql
CREATE TABLE IF NOT EXISTS food_log (
  id TEXT PRIMARY KEY,
  entry_date TEXT NOT NULL,
  entry_time TEXT,           -- ISO 8601 time or null
  meal_slot TEXT,            -- breakfast/lunch/dinner/snack, null if unknown
  recipe_id TEXT REFERENCES recipes(id),  -- null if not from a known recipe
  recipe_name TEXT NOT NULL, -- snapshot of what was described/eaten
  calories REAL NOT NULL,
  protein REAL NOT NULL,
  is_takeout INTEGER NOT NULL DEFAULT 0,  -- 1 = takeout/restaurant, 0 = homemade
  is_from_library INTEGER NOT NULL DEFAULT 0, -- 1 = matched a known recipe
  source TEXT,               -- 'health-tracker' or 'manual'
  original_wording TEXT,     -- what Aaron actually said ("I ate a tuna sandwich")
  origin_channel TEXT,       -- 'imessage', 'voice', 'dashboard', etc.
  source_entry_id TEXT,      -- id from health-ledger's food_entries for correlation
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS food_log_date ON food_log(entry_date);
CREATE INDEX IF NOT EXISTS food_log_recipe ON food_log(recipe_id);
CREATE INDEX IF NOT EXISTS food_log_takeout ON food_log(is_takeout);
```

#### 2. Extend health-workflow.js to also write to food_log

After `log-food`, `correct-food`, `remove-food`, and `undo` mutations, also write/update the `food_log` table in meal-planner.sqlite. When logging food:

- Call `find-recipe --query "food name"` first (same as current flow)
- If a recipe match is found: set `is_from_library = 1` and link `recipe_id`
- If no recipe match: set `is_from_library = 0` (likely takeout or a new food)
- Heuristic for is_takeout: if no recipe match AND the original wording contains restaurant keywords (restaurant name, "takeout", "delivery", "ordered from"), set `is_takeout = 1`
- When a recipe is corrected/removed/undone, mirror the change in food_log

#### 3. Add a new API endpoint in dashboard-api

```
GET /api/meal-planner/food-log?date=2026-08-09&limit=30
```

Returns food log entries for the given date or most recent N entries. This API should read from meal-planner.sqlite's food_log table.

```
GET /api/meal-planner/food-log/stats?days=30
```

Returns aggregate statistics: total entries, breakdown by homemade vs takeout, most frequent recipes, average daily calories from takeout, etc.

### Option B: Health-tracker broadcasts food entries via dashboard API SSE

A lighter-weight alternative: when health-tracker syncs a food entry, have the dashboard API also emit it on the `meal-planner` SSE channel. The meal planner would need to listen for SSE and store it. But since the meal planner is a subagent (not a persistent process), this is less practical.

**Stick with Option A** — the shared SQLite table is simpler and doesn't depend on SSE timing.

## Changes needed

### File: `workspace-health-tracker/scripts/health-workflow.js`

After every food mutation (`log-food`, `correct-food`, `remove-food`, `undo`), also open the meal planner database and write/update food_log:

```javascript
function syncFoodLog(db, operation, entry, originalWording) {
  const mpDb = openMealPlannerDb();
  try {
    // If logging food: insert
    if (operation === 'log-food') {
      // Check if recipe matches
      const recipeRow = mpDb.prepare(`
        SELECT r.id, r.name FROM recipes r
        LEFT JOIN recipe_aliases a ON a.recipe_id = r.id
        WHERE r.active = 1 AND (r.normalized_name = ? OR a.normalized_alias = ?)
        LIMIT 1
      `).get(normalizeText(entry.name), normalizeText(entry.name));
      
      const isTakeout = !recipeRow && isRestaurantFood(originalWording || entry.name) ? 1 : 0;
      
      mpDb.prepare(`
        INSERT INTO food_log (id, entry_date, entry_time, meal_slot, recipe_id, recipe_name, calories, protein, is_takeout, is_from_library, original_wording, origin_channel, source_entry_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(...);
    }
    // If correcting: update the existing entry's calories/protein
    // If removing: mark as voided in food_log
  } finally { mpDb.close(); }
}
```

Add a helper `isRestaurantFood(text)` that checks against a small keyword set: ['takeout', 'delivery', 'ordered', 'restaurant', 'zaxbys', 'chick-fil-a', 'mcdonald', 'wendy', 'pizza hut', 'domino', 'subway', 'chipotle', 'taco bell', ...plus '🍕', '🍔' emoji patterns].

### File: `workspace-meal-planner/scripts/meal-planner-workflow.js`

Add commands:
- `log-food-entry` — manually add a food log entry (for when Aaron tells the meal planner directly what he ate)
- `get-food-log` — query food log by date range
- `get-food-stats` — aggregate statistics for preference analysis

### File: `services/dashboard-api/server.js`

Add routes:
- `GET /api/meal-planner/food-log` — query food log table (reads from MP SQLite)
- `GET /api/meal-planner/food-log/stats` — returns aggregate stats

## Dependencies

This workstream depends on nothing else. It creates the food_log table and writes to it. The preference analysis (Workstream 3) will read from this table.

## Success criteria

- When health-tracker logs food via `health-workflow.js`, it also writes a food_log entry
- The food_log table correctly tracks recipe matches vs. takeout
- `GET /api/meal-planner/food-log?date=2026-08-09` returns today's entries
- Recipe corrections/removals are mirrored in food_log