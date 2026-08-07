# Tier 2: USDA Food Lookup — Plan

## The good news: most of the infrastructure already exists

There's already a full USDA nutrition database in your system:

- **`workspace-health-tracker/scripts/nutrition-index.js`** — a CLI tool that searches a local SQLite database of USDA food data. Supports `search --query "chicken breast"` and `get --fdc-id 12345`. Returns `caloriesPer100g`, `proteinPer100g`, and `portions` (named servings with gram weights, like "1 cup" = 244g).

- **`workspace-health-tracker/scripts/refresh-nutrition-index.js`** — downloads USDA datasets (Foundation, FNDDS, SR Legacy = ~400K foods) and builds the SQLite database. Already in use.

- **`log-food` already accepts `--resolution-type usda`** — the health-workflow.js command already knows how to store food logged via USDA.

What's missing is the **quantity parser** and the **integration** that connects the USDA search to the fast path.

---

## What needs to be built

### Component 1: Quantity parser (`lib/quantity-parser.js`)

A standalone JavaScript file that converts a food description like "half a cup of yogurt" into:
- A **food name** ("yogurt")
- A **gram weight** (122g, since 1 cup of yogurt ≈ 244g, half is 122g)

**Input examples → Desired output:**

| Input | Food name | Grams |
|---|---|---|
| "yogurt" | "yogurt" | 100 (default) |
| "half a cup of yogurt" | "yogurt" | 122 |
| "a cup of yogurt" | "yogurt" | 244 |
| "45 oz of chicken breast" | "chicken breast" | 1276 |
| "a can of soda" | "soda" | 355 |
| "half a can of soda" | "soda" | 177 |
| "2 tablespoons of peanut butter" | "peanut butter" | 32 |
| "a liter of milk" | "milk" | 1000 |
| "a bottle of water" | "water" | 500 |
| "a slice of bread" | "bread" | 28 |
| "3 eggs" | "eggs" | 150 |

**How it works:**

```js
// Pseudocode
function parseQuantity(text) {
  // Step 1: Strip leading quantity words
  // Patterns to detect:
  //   "half a" / "a half" → 0.5
  //   "a" / "an" → 1
  //   "one" through "twelve" → 1-12
  //   "1/2", "1/4", "3/4" → fractions
  //   "1.5", "45" → decimals
  //   "a couple of" → 2
  //   "a few" → 3
  
  // Step 2: Detect unit and convert to grams
  // Known units with gram equivalents:
  //   cup/cups          → 1 cup = 240g (water) — but varies by food!
  //   ounce/ounces/oz   → 1 oz = 28.35g
  //   pound/pounds/lb   → 1 lb = 453.6g
  //   tablespoon/tablespoons/Tbsp/Tbs
  //   teaspoon/teaspoons/tsp
  //   liter/liters/L    → 1000g
  //   milliliter/mL     → 1g (water)
  //   gram/grams/g      → exact
  //   can/cans          → 355g (standard soda can)
  //   bottle/bottles    → 500g (standard)
  //   slice/slices      → 28g (bread)
  //   egg/eggs          → 50g (large egg)
  //   scoop/scoops      → 30g (protein powder standard)
  //   bowl/bowls        → 300g (generic)
  //   plate/plates      → 400g (generic)

  // Step 3: Return the stripped food name + gram weight
  return { foodName: "yogurt", grams: 122 };
}
```

**Important: the USDA already has portion data** — the `nutrition-index.js` returns `portions` which include named servings with gram weights. So if the USDA knows "1 cup of yogurt = 244g", we should use that when available instead of hardcoded defaults. The quantity parser should:
1. First try to find the food in USDA and match the portion name to get the exact gram weight
2. Fall back to hardcoded defaults if no USDA match is found

**Where it lives:** `workspace-health-tracker/scripts/lib/quantity-parser.js`

---

### Component 2: USDA lookup router extension

The existing `food-recipe` DOMAIN_FASTPATH in `phrase-tracker.js` and the `tryRecipeFood` function in `ha-voice-adapter/server.js` need to be extended to add a USDA tier between the recipe check and the Main fallthrough.

**Current flow in `ha-voice-adapter/server.js`:**

```
voice input → parseFoodReport() → tryRecipeFood() → recipe found? → log it
                                                    → no recipe → send to Main
```

**Desired flow:**

```
voice input → parseFoodReport() → tryRecipeFood() → recipe found? → log it
                                                    → no recipe → tryUSDA() → found? → log it
                                                                               → not found → send to Main
```

**`tryUSDA(description, rawText)` function** (in `ha-voice-adapter/server.js`):

```js
async function tryUSDAFood(description, rawText) {
  // 1. Parse quantity from the description
  const { foodName, grams } = parseQuantity(description);
  
  // 2. Search USDA database
  const result = runHealthWorkflow(['search', '--query', foodName, '--limit', '3']);
  if (!result || !result.matches || !result.matches.length) return null;
  
  // 3. Pick the best match (first result is ranked by BM25)
  const match = result.matches[0];
  
  // 4. Calculate nutrition based on gram weight
  //    USDA data is per 100g, so scale proportionally
  const scaleFactor = grams / 100;
  const calories = Math.round(match.caloriesPer100g * scaleFactor);
  const protein = Math.round(match.proteinPer100g * scaleFactor * 10) / 10;
  
  // 5. Log it
  return runHealthWorkflow([
    'log-food',
    '--idempotency-key', crypto.randomUUID(),
    '--resolution-type', 'usda',
    '--name', match.description,
    '--serving', `${grams}g`,
    '--calories', String(calories),
    '--protein', String(protein),
    '--quantity', '1',
    '--confidence', '0.85',
    '--source-id', String(match.fdcId),
    '--original', rawText,
    '--origin-channel', 'voice-pe-kitchen',
  ]);
}
```

Same pattern needs to be duplicated in `phrase-tracker.js`'s `DOMAIN_FASTPATHS` entry for `food-recipe`, so the trace-noc dashboard correctly reflects that USDA matches are handled.

---

### Component 3: Confidence scoring

Not all USDA matches are equally reliable. The system should use a confidence score:

| Scenario | Confidence |
|---|---|
| Exact food name match + exact portion match | 0.95 |
| Exact food name match + generic portion | 0.85 |
| Fuzzy food name match + exact portion | 0.75 |
| Fuzzy food name match + generic portion | 0.60 |
| Multiple close matches, picked the best | 0.50 |

The `log-food` command already accepts `--confidence` as a parameter. Below 0.7, the system should still log it but flag it for review.

---

## Implementation order

### Phase 1: Build the quantity parser (1-2 hours)
- Create `workspace-health-tracker/scripts/lib/quantity-parser.js`
- Test with common phrases: "half a cup of yogurt", "45 oz chicken", "a can of soda", "2 tbsp peanut butter", "3 eggs", "a liter of milk"
- Handle edge cases: no quantity word ("yogurt"), fraction ("1/2 cup"), decimal ("1.5 cups")

### Phase 2: Build the USDA fast path (1 hour)
- Add `tryUSDAFood()` to `ha-voice-adapter/server.js`
- Call it from the food handling pipeline after `tryRecipeFood()` returns null
- Wire the same logic into `phrase-tracker.js`'s `DOMAIN_FASTPATHS[0]`

### Phase 3: Test with real food (1 hour)
- Say "I had half a cup of yogurt" → should log via USDA with ~80 cal, ~7g protein
- Say "I had a can of soda" → should log via USDA with ~150 cal, 0g protein
- Say "I had 45 oz of chicken breast" → should log via USDA with ~1200 cal, ~210g protein
- Verify that unknown foods still fall through to Main

### Phase 4 (future): Repeats list
The user mentioned "repeats" — simple foods you eat often. This could be a separate flat JSON file that the fast path checks before USDA, acting as a "frequently eaten" cache. Not in scope for this plan, but the architecture supports adding it later.

---

## Files to create

| File | Purpose |
|---|---|
| `workspace-health-tracker/scripts/lib/quantity-parser.js` | Parse food descriptions into food name + gram weight |
| `workspace-health-tracker/scripts/lib/quantity-parser.test.js` | Tests for the parser |

## Files to modify

| File | Change |
|---|---|
| `services/ha-voice-adapter/server.js` | Add `tryUSDAFood()` after `tryRecipeFood()` failure |
| `services/trace-noc/lib/phrase-tracker.js` | Extend `food-recipe` DOMAIN_FASTPATH with USDA tier |
| `workspace-health-tracker/scripts/health-workflow.js` | Possibly add a `find-food` command that combines recipe + USDA search |

---

## Key design decisions

1. **Use the existing USDA SQLite database** — don't create a new data store. `nutrition-index.js` already has the search infrastructure.

2. **Quantity parser is a separate module** — it has clear input/output, can be tested independently, and can be reused by the voice adapter and the router fast path.

3. **USDA lookup happens before Main** — the whole point is to avoid calling the LLM when the USDA already knows the answer.

4. **Log with `--resolution-type usda`** — this preserves the audit trail of where the data came from, so you can see in the health tracker which foods were logged via USDA vs recipe vs AI estimate.

5. **Portion data from USDA takes priority** — when the USDA database has a portion called "1 cup" with a known gram weight, use that. Only fall back to hardcoded defaults when the USDA doesn't have a portion match.