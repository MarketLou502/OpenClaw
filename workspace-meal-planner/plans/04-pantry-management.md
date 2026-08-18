# Workstream 4: Pantry Management & Grocery Auto-Suggestions

## Goal

Build a pantry inventory system that:
1. Catalogs everything Aaron has in his kitchen (with rough quantities)
2. Tracks when ingredients are used (when a recipe is planned/followed, deducts ingredients)
3. Detects when stock is running low and **automatically adds items to the grocery list**
4. Surfaces "you can make X with what you have" suggestions

## Context — existing system

### Pantry table already exists

The meal planner SQLite database (`workspace-meal-planner/data/meal-planner.sqlite`) already has a `pantry_items` table:

```sql
CREATE TABLE IF NOT EXISTS pantry_items (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL UNIQUE,
  quantity TEXT,
  updated_at TEXT NOT NULL
);
```

This table exists but is **not wired up** — there are no workflow commands for it and no current logic that reads or writes to it.

### Recipe ingredients

Each recipe has ingredients stored in `recipe_ingredients`:

```sql
CREATE TABLE IF NOT EXISTS recipe_ingredients (
  id TEXT PRIMARY KEY,
  recipe_id TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  ingredient_name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  quantity TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0
);
```

The `quantity` field is a text string like "2 cans", "0.25 cup", "400 g", "2 slices". There's no normalization to a base unit — this is human-readable.

### Grocery list

The grocery list is stored in `workspace-daily-tracker/tasks/grocery.json` and managed via `dashboard-workflow.js`:
```bash
node scripts/dashboard-workflow.js add --board grocery --text "Milk"
node scripts/dashboard-workflow.js list --board grocery
node scripts/dashboard-workflow.js remove --board grocery --query "Milk"
```

It is **intentionally disconnected** from meal planning. This workstream will bridge that gap.

### Current constraint (from SOUL.md)

> **Grocery and meal planning are fully separate systems.** Never add ingredients to the grocery list because of a meal plan, never read the grocery list to inform a plan, and never suggest doing either. If Aaron asks for that kind of connection, tell him it isn't wired up rather than faking it by hand.

**This constraint is being lifted by this workstream.** The pantry system is the bridge: it connects recipe ingredients → pantry stock → grocery list.

## What to build

### Part A: Extend pantry_items table

The existing table needs richer tracking. Either add columns or create a new schema:

```sql
-- Extend pantry_items with better tracking
-- (Use ALTER TABLE ADD COLUMN with IFNULL checks)
ALTER TABLE pantry_items ADD COLUMN category TEXT;  -- 'produce', 'dairy', 'meat', 'pantry', 'frozen', 'spices', 'condiments', etc.
ALTER TABLE pantry_items ADD COLUMN min_quantity TEXT;  -- auto-reorder threshold, e.g. "100 g" or "1"
ALTER TABLE pantry_items ADD COLUMN unit TEXT;  -- base unit for tracking: 'g', 'ml', 'pieces', 'cans', etc.
ALTER TABLE pantry_items ADD COLUMN notes TEXT;
```

Or create a new `pantry_stock` table with better tracking:
```sql
CREATE TABLE IF NOT EXISTS pantry_stock (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL UNIQUE,
  quantity REAL,           -- numeric quantity in the base unit
  unit TEXT,               -- 'g', 'ml', 'pieces', 'cans', 'sheets', 'slices'
  display_quantity TEXT,   -- human-readable: "400 g", "2 cans", "0.25 cup"
  category TEXT,
  min_quantity REAL,       -- reorder threshold (in the same unit)
  min_unit TEXT,           -- unit for min_quantity
  notes TEXT,
  location TEXT,           -- 'pantry', 'fridge', 'freezer', 'spice rack'
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS pantry_stock_category ON pantry_stock(category);
```

### Part B: Add pantry workflow commands

Add these commands to `scripts/meal-planner-workflow.js`:

```bash
# Add item to pantry
node scripts/meal-planner-workflow.js add-pantry-item \
  --name "All-purpose flour" \
  --quantity 2000 --unit g \
  --display-quantity "2 kg" \
  --category pantry \
  --min-quantity 200 --min-unit g \
  --location pantry

# Update quantity (after using some)
node scripts/meal-planner-workflow.js update-pantry-item \
  --name "all purpose flour" \
  --deduct 200 --unit g

# Or set absolute:
node scripts/meal-planner-workflow.js update-pantry-item \
  --name "all purpose flour" \
  --set-quantity 1800 --unit g

# List pantry
node scripts/meal-planner-workflow.js list-pantry [--category dairy] [--low-stock]
node scripts/meal-planner-workflow.js list-pantry --low-stock  # items below min threshold

# Remove item
node scripts/meal-planner-workflow.js remove-pantry-item --name "Old ingredient"

# Find recipes using an ingredient
node scripts/meal-planner-workflow.js find-recipes-by-ingredient --ingredient "chicken"

# Find what you can make right now
node scripts/meal-planner-workflow.js suggest-recipes  # recipes where all ingredients are in stock
```

### Part C: Auto-deduct when planning meals

When `assemble-plan` or `confirm-plan` runs, also deduct the planned recipe's ingredients from pantry stock:

```javascript
function deductPantryForPlanItem(db, recipeId) {
  const ingredients = db.prepare(`
    SELECT ingredient_name, normalized_name, quantity FROM recipe_ingredients WHERE recipe_id = ?
  `).all(recipeId);
  
  for (const ing of ingredients) {
    if (!ing.quantity) continue; // can't deduct without a quantity
    
    const pantryItem = db.prepare(`
      SELECT * FROM pantry_stock WHERE normalized_name = ?
    `).get(ing.normalized_name);
    
    if (!pantryItem) continue; // not tracked in pantry
    
    // Parse the recipe quantity and deduct
    const deduction = parseQuantity(ing.quantity); // returns { amount, unit }
    const newQuantity = pantryItem.quantity - deduction.amount;
    
    db.prepare(`UPDATE pantry_stock SET quantity = ?, updated_at = ? WHERE id = ?`)
      .run(newQuantity, nowIso(), pantryItem.id);
    
    // Check if below threshold
    if (pantryItem.min_quantity && newQuantity < pantryItem.min_quantity) {
      autoAddToGroceryList(pantryItem.name, deduction.unit);
    }
  }
}
```

### Part D: Auto-add to grocery list

When an ingredient drops below its `min_quantity`, automatically add it to the grocery list by calling `dashboard-workflow.js`:

```javascript
function autoAddToGroceryList(itemName, unit) {
  const result = spawnSync(process.execPath, [
    path.join(DT_WORKSPACE, 'scripts/dashboard-workflow.js'),
    'add', '--board', 'grocery', '--text', `${itemName} (running low)`
  ], { encoding: 'utf8' });
  
  // Log the auto-add
  log(`Auto-added to grocery: ${itemName}`);
}
```

The grocery list entry text should include context — e.g., "Flour (low stock)" or "Chicken breast (meal plan)". This helps Aaron understand WHY it appeared.

### Part E: The "what can I make?" suggestion

Add a kiosk-visible feature:

```
GET /api/meal-planner/pantry/suggestions
```

Returns recipes where all or most ingredients are available in the current pantry stock. Scores them by pantry coverage (100% = all ingredients in stock, 80% = need 1-2 items).

The suggestion algorithm:
1. For each active recipe, check its ingredients against pantry stock
2. Score: `(ingredients_in_stock / total_ingredients) * preference_score`
3. Return top 5, grouped by "make now" (100%) > "almost there" (≥75%) > "need a few things" (≥50%)

## Dashboard API routes

```
GET  /api/meal-planner/pantry              — list all pantry items
POST /api/meal-planner/pantry              — add item
PATCH /api/meal-planner/pantry/:id         — update quantity
DELETE /api/meal-planner/pantry/:id        — remove item
GET  /api/meal-planner/pantry/suggestions  — what can I make?
GET  /api/meal-planner/pantry/low-stock    — items below threshold
```

## Success criteria

- Pantry items can be added, updated, listed, and removed via workflow commands
- When a meal plan is assembled/confirmed, recipe ingredients are deducted from pantry
- Items that drop below threshold are auto-added to the grocery list dashboard board
- "What can I make?" suggests recipes sorted by pantry coverage
- Grocery list shows context for auto-added items ("Flour (low stock)")

## Dependencies

- Recipe data must exist in the DB (Workstream 1 provides richer recipes, but the current schema already has ingredients)
- The grocery list is managed by `dashboard-workflow.js` in `workspace-daily-tracker` — the auto-add logic should call this script
- No dependency on food log sharing (Workstream 2) or preference learning (Workstream 3)