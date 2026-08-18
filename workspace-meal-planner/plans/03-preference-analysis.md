# Workstream 3: Preference Learning & Eating Pattern Analysis

## Goal

Analyze Aaron's eating patterns over time using the food_log data (from Workstream 2) to:
- Identify which recipes he reaches for most often
- Track how often he eats out vs. homemade
- Discover his preferred meal slots (breakfast/lunch/dinner/snack) for each recipe
- Detect trends (emerging favorites, declining habits)
- Output preference scores that the meal planner can use to prioritize recommendations

## Context

### Data source: food_log table

After Workstream 2 is complete, every food entry Aaron logs gets written to the `food_log` table in `workspace-meal-planner/data/meal-planner.sqlite`:

```sql
CREATE TABLE food_log (
  id TEXT PRIMARY KEY,
  entry_date TEXT NOT NULL,
  entry_time TEXT,
  meal_slot TEXT,
  recipe_id TEXT REFERENCES recipes(id),
  recipe_name TEXT NOT NULL,
  calories REAL NOT NULL,
  protein REAL NOT NULL,
  is_takeout INTEGER NOT NULL DEFAULT 0,
  is_from_library INTEGER NOT NULL DEFAULT 0,
  source TEXT,
  original_wording TEXT,
  origin_channel TEXT,
  source_entry_id TEXT,
  created_at TEXT NOT NULL
);
```

### Recipe library

The `recipes` table has: id, name, type (quick/prepared), meal_slot_hint, calories, protein, tags, active status.

### What this workstream produces

A script that generates a preference profile — a structured JSON document that answers:

- **Top recipes** — which recipes are used most, ranked by frequency over the last 7/14/30 days
- **Takeout ratio** — % of meals that are takeout vs. homemade, trend direction
- **Slot preferences** — which meals Aaron tends to eat at breakfast/lunch/dinner/snack
- **Recipe rotation** — does he repeat the same meal frequently or prefer variety?
- **Missed opportunities** — recipes in the library that he likes but hasn't eaten recently (good candidates for a nudge)
- **Calorie pattern** — typical calorie intake per meal slot (to inform planning portion sizes)

## What to build

### Script: `scripts/analyze-preferences.js`

Run via:
```bash
node scripts/analyze-preferences.js [--days 30] [--format json|markdown]
node scripts/analyze-preferences.js --format markdown  # human-readable summary
node scripts/analyze-preferences.js --format json       # structured data for dashboard
node scripts/analyze-preferences.js --refresh           # recalculate and save to memory file
```

#### Output structure (JSON format):

```json
{
  "analyzedAt": "2026-08-09T12:00:00Z",
  "periodDays": 30,
  "totalEntries": 87,
  "takeoutRatio": 0.35,
  "takeoutTrend": "declining",         // "declining" | "stable" | "increasing"
  "libraryRatio": 0.42,               // % from known recipes
  "preferences": {
    "topRecipes": [
      { "recipeId": "uuid", "name": "Custom Tuna Salad Sandwich", "count": 12, "avgCalories": 315, "lastEaten": "2026-08-07" },
      ...
    ],
    "topTakeout": [
      { "name": "Zaxby's", "count": 8, "trend": "declining" },
      ...
    ],
    "mealSlotDistribution": {
      "breakfast": { "count": 20, "libraryPercent": 0.6, "takeoutPercent": 0.1 },
      "lunch": { "count": 28, "libraryPercent": 0.4, "takeoutPercent": 0.3 },
      "dinner": { "count": 25, "libraryPercent": 0.3, "takeoutPercent": 0.5 },
      "snack": { "count": 14, "libraryPercent": 0.5, "takeoutPercent": 0.2 }
    },
    "nudgeCandidates": [
      { "recipeName": "Boost Protein Shake", "lastEatenAgo": 14, "reason": "Favorite recipe, not used in 2 weeks" },
      { "recipeName": "Kirkland Breakfast Sandwich", "lastEatenAgo": 10, "reason": "Quick breakfast option, not recent" }
    ],
    "nutritionalPattern": {
      "avgDailyCalories": 2850,
      "avgDailyProtein": 125,
      "avgCaloriesBySlot": {
        "breakfast": { "avg": 450, "fromLibrary": 350, "fromTakeout": 100 },
        ...
      }
    }
  }
}
```

#### Scoring logic

- **Preference score for a recipe** = (frequency × recency_multiplier × library_bonus)
  - frequency = number of times eaten in period
  - recency_multiplier = 1.0 if eaten within 7 days, 0.7 within 14 days, 0.5 otherwise (decay over time to downweight old data)
  - library_bonus = 1.2 if from recipe library (prefer homemade), 1.0 otherwise
- **Takeout trend** = compare last 7 days' takeout ratio to 7-14 days ago
- **Nudge candidates** = recipes in library that scored high historically but haven't been used in ≥10 days

### Integration with meal-planner-workflow.js

Add a command to the workflow script:
```bash
node scripts/meal-planner-workflow.js analyze-preferences [--days 30]
```

That runs the analysis and returns the preference profile.

The `assemble-plan` command should optionally accept a `--prefer` flag that biases recipe selection toward higher-preference recipes:

```bash
node scripts/meal-planner-workflow.js assemble-plan --prefer
```

When `--prefer` is set, instead of sorting candidates purely by protein density, use a weighted score: `0.4 × preference_score + 0.6 × protein_density`.

### Storage

Save the latest analysis to:
- `memory/preference-profile.json` — structured JSON (overwritten each run)
- `memory/preference-summary.md` — human-readable Markdown summary (appended to)

### Dashboard read

Expose via dashboard API:
```
GET /api/meal-planner/preferences
```
Returns the latest preference profile from `memory/preference-profile.json`.

## Dependencies

- Requires the `food_log` table (Workstream 2) to have data to analyze. Works fine with an empty table (returns empty results).
- The `--prefer` flag for `assemble-plan` modifies existing logic slightly — coordinate with the plan assembly improvements if any.

## Success criteria

- `node scripts/analyze-preferences.js --days 30` produces a valid preference profile
- Top recipes are accurately ranked by frequency
- Takeout ratio and trend are calculated correctly
- Nudge candidates identify library recipes that haven't been eaten recently
- Dashboard can serve preferences via `/api/meal-planner/preferences`