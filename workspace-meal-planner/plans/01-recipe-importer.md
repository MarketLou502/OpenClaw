# Workstream 1: Recipe Importer & Standardization

## Goal

Create a tool that takes a recipe URL (any cooking website), fetches the HTML page, parses/extracts the recipe content into a clean, standardized format, and saves it to the meal planner's recipe database. The result should display beautifully on Aaron's kiosk dashboard — every recipe looks the same, instructions are clear, and ingredients are listed with quantities.

## Context — existing system

### Recipe database (SQLite at `data/meal-planner.sqlite`)

Tables already exist:
- **recipes** — id, name, normalized_name, type (quick/prepared), meal_slot_hint (breakfast/lunch/dinner/snack/any), serving (text), calories, protein, notes, active, created_at, updated_at
- **recipe_ingredients** — id, recipe_id, ingredient_name, normalized_name, quantity, sort_order
- **recipe_tags** — recipe_id, tag
- **recipe_aliases** — recipe_id, alias, normalized_alias
- **pantry_items** — id, name, normalized_name, quantity, updated_at
- **daily_plans / plan_items** — for daily meal plans

### Current recipe workflow script

`scripts/meal-planner-workflow.js` handles all recipe and plan operations. Run via `node scripts/meal-planner-workflow.js <command> [args]`.

Commands of interest:
- `add-recipe --name "X" --type quick --serving "1 sandwich" --calories 315 --protein 19 --meal-slot-hint lunch --tags "sandwich,high-protein" --ingredients "tuna:2 cans,eggs:3,mayo:0.25 cup,white bread:2 slices"`
- `find-recipe --query "X"`
- `list-recipes --active-only`

The `normalizeText()` function strips leading articles ("a/an/the/some") for matching. Ingredients are passed as `name:quantity` comma-separated strings.

### Schema gaps

The current recipe schema is missing fields needed for a full kiosk-ready recipe:
- Instructions / cooking steps (ordered list of step text)
- Prep time (minutes)
- Cook time (minutes)
- Total time (minutes) — can be derived from prep+cook
- Source URL (where it was imported from)
- Image URL
- Cuisine type (optional)
- Serving size (integer — how many servings the recipe makes, separate from the "per serving" macros)

### Dashboard API

The dashboard-api server (`/Users/aaronmacmini/.openclaw/services/dashboard-api/server.js`) runs on port 18795 and proxies meal-planner-workflow.js calls through REST endpoints:

- `GET /api/meal-planner/recipes` — list recipes
- `POST /api/meal-planner/recipes` — add recipe (body: name, type, serving, calories, protein, mealSlotHint, tags[], aliases[], ingredients[])
- `PATCH /api/meal-planner/recipes/:id` — update recipe
- `DELETE /api/meal-planner/recipes/:id` — remove recipe

The frontend (`services/dashboard-api/kiosk-repo/dashboard-web/index.html` + `app.js`) has a "Recipes" tab that displays the recipe list. The data is pushed via SSE on the `meal-planner` channel.

## What to build

### Part A: Extend the schema

Add these columns/tables to `meal-planner.sqlite`:

```sql
-- Add instructions table (each recipe has ordered steps)
CREATE TABLE IF NOT EXISTS recipe_instructions (
  id TEXT PRIMARY KEY,
  recipe_id TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  step_number INTEGER NOT NULL,
  instruction TEXT NOT NULL,
  UNIQUE(recipe_id, step_number)
);
CREATE INDEX IF NOT EXISTS recipe_instructions_recipe ON recipe_instructions(recipe_id);

-- Add columns for richer recipe data
-- Execute via ALTER TABLE (with IF NOT NULL checks):
-- ALTER TABLE recipes ADD COLUMN prep_time_minutes INTEGER;
-- ALTER TABLE recipes ADD COLUMN cook_time_minutes INTEGER;
-- ALTER TABLE recipes ADD COLUMN source_url TEXT;
-- ALTER TABLE recipes ADD COLUMN image_url TEXT;
-- ALTER TABLE recipes ADD COLUMN cuisine TEXT;
-- ALTER TABLE recipes ADD COLUMN serving_size INTEGER;
```

### Part B: Create the recipe importer script

Create `scripts/recipe-importer.js` that:

1. **Accepts a URL** as argument: `node scripts/recipe-importer.js "https://www.allrecipes.com/recipe/..."`

2. **Fetches the webpage** using Node.js built-in `fetch()` (available in Node 22+). Handle HTTPS only.

3. **Parses the HTML** to extract recipe content. Since different sites have different structures, use a multi-strategy approach:
   - **Strategy A: Schema.org/LD+JSON** — Many recipe sites embed structured data in `<script type="application/ld+json">`. Parse this JSON-LD first — it's the most reliable source. Extract: name, description, recipeIngredient[], recipeInstructions[], prepTime (ISO 8601 duration), cookTime, totalTime, recipeYield, image, recipeCuisine, nutrition.calories, nutrition.protein
   - **Strategy B: OpenGraph / meta tags** — Fall back to `<meta property="og:title">`, `<meta name="description">`, etc.
   - **Strategy C: Heuristic HTML parsing** — As a last resort, look for common class names (.recipe-ingredients, .ingredient-list, .recipe-instructions, etc.) and common heading patterns ("Ingredients", "Directions", "Instructions")

4. **Standardizes the data** into a consistent format:
   - Clean ingredient names (strip parenthetical notes like "(optional)", normalize units — tsp/tablespoon/cup/oz to consistent forms)
   - Parse ISO 8601 durations from schema.org (PT30M → 30 minutes)
   - Convert serving sizes to integer
   - Extract calories and protein from nutrition info (heuristic parsing if string like "350 calories")
   - If calories/protein aren't found, estimate from ingredients

5. **Saves to the database** using the existing `add-recipe` workflow command plus any new fields. The importer should:
   - First check `find-recipe --query` to avoid duplicates
   - Call `add-recipe` for the basic fields
   - Then add instructions to `recipe_instructions` table
   - Update the recipe with new fields (prep_time, cook_time, etc.)

6. **Outputs the result** as JSON: `{ ok: true, recipe: { name, id, ingredientsCount, stepsCount, ... }, reply: "..." }`

### Part C: Update `meal-planner-workflow.js`

Extend the existing `add-recipe` and `update-recipe` commands to handle the new schema fields:
- `--prep-time-minutes N`
- `--cook-time-minutes N`
- `--source-url URL`
- `--image-url URL`
- `--cuisine TYPE`
- `--serving-size N`
- `add-instruction` subcommand or include instructions via `--instructions "Step 1 text|Step 2 text|..."` (pipe-delimited)

Also add a new command: `get-recipe --id ID` that returns a recipe with all its children (ingredients, instructions, tags, aliases) in one call.

### Part D: Update the kiosk frontend

In `services/dashboard-api/kiosk-repo/dashboard-web/app.js`, update the Recipes tab display to show more detail when a recipe is tapped:
- Ingredients with quantities
- Step-by-step instructions
- Prep/cook time
- Source URL link
- Calories and protein per serving

## Tech notes

- Use Node.js built-in `fetch()` and the built-in `node:sqlite` module (no npm dependencies needed)
- The script should handle errors gracefully: bad URLs, no recipe found, network errors
- Site-specific parsers can be added over time; start with the structured data approach
- The meal-planner-workflow.js already has the `normalizeText()` function — reuse the same normalization for ingredient matching
- All existing workflow commands must remain backward-compatible

## Files to modify

| File | Change |
|------|--------|
| `scripts/recipe-importer.js` | **New** — URL→recipe import tool |
| `scripts/meal-planner-workflow.js` | Extend add/update-recipe, add get-recipe, add instruction handling |
| `data/meal-planner.sqlite` | Schema migration for new fields |
| `services/dashboard-api/server.js` | Expose new recipe fields via API |
| `services/dashboard-api/kiosk-repo/dashboard-web/app.js` | Richer recipe display |

## Success criteria

- `node scripts/recipe-importer.js "https://example.com/recipe"` downloads the page, extracts the recipe, saves it to DB
- Recipe displays on the kiosk with all ingredients, step-by-step instructions, times, and source link
- Existing `add-recipe` and `update-recipe` still work as before
- No npm dependencies added