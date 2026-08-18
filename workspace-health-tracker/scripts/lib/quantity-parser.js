'use strict';

// Converts a spoken food description like "half a cup of yogurt" or
// "45 oz of chicken breast" into a food name plus a gram weight, so the
// voice/USDA fast path can scale the USDA's per-100g nutrition data without
// an LLM.
//
// Design notes:
//   * Pure and dependency-free — this module never touches the USDA SQLite
//     database itself. Callers (ha-voice-adapter's tryUSDAFood, the router
//     fast path) own the USDA I/O and can pass an optional `usdaSearch`
//     hook so portion-name matching against real USDA portions can refine
//     the gram weight (per USDA_TIER_2_PLAN.md: "Portion data from USDA
//     takes priority. Only fall back to hardcoded defaults when the USDA
//     doesn't have a portion match.").
//   * Deterministic: same input + same hook => same output, so the parser
//     itself can be tested standalone in quantity-parser.test.js.

// Hardcoded default gram weight per unit when the USDA doesn't know better.
// Volume/liquid units assume water density (1 g/mL); food-specific defaults
// (slice, egg, can, scoop...) are rough single-serving estimates that the
// USDA portion match overrides whenever one exists.
const UNIT_GRAMS = {
  cup: 240, cups: 240, c: 240,
  ounce: 28.35, ounces: 28.35, oz: 28.35,
  pound: 453.6, pounds: 453.6, lb: 453.6, lbs: 453.6,
  tablespoon: 15, tablespoons: 15, tbsp: 15, tbs: 15, 'tbsps': 15,
  teaspoon: 5, teaspoons: 5, tsp: 5, tsps: 5,
  liter: 1000, liters: 1000, litre: 1000, litres: 1000, l: 1000,
  milliliter: 1, milliliters: 1, ml: 1, millilitre: 1, millilitres: 1,
  gram: 1, grams: 1, g: 1, gm: 1, gms: 1,
  can: 355, cans: 355,
  bottle: 500, bottles: 500,
  slice: 28, slices: 28,
  egg: 50, eggs: 50,
  scoop: 30, scoops: 30,
  bowl: 300, bowls: 300,
  plate: 400, plates: 400,
  piece: 50, pieces: 50,
  serving: 100, servings: 100,
  handful: 30, handfuls: 30,
  bar: 60, bars: 60,
  pack: 100, packs: 100,
  bag: 200, bags: 200,
  glass: 240, glasses: 240,
  box: 300, boxes: 300,
};

// Whole-number words -> numeric quantity.
const NUMBER_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, dozen: 12,
};

// Explicit quantity phrases that don't fit word-or-number rules. All regexes
// are anchored at ^ so they only match at the start of the input.
// "half of a"/"quarter of an" must be listed before the bare "half"/"quarter"
// fallbacks below — those only strip the quantity word itself and leave a
// dangling "of a ham sandwich" as the food name, since the cleanup step
// further down only strips a *leading* article ("a"/"an"), not "of a".
// Fixed 2026-08-10 after "I just had half of a ham sandwich" parsed to food
// name "of a ham sandwich" instead of "ham sandwich".
const SPECIAL_QUANTITIES = [
  { re: /^(?:a\s+)?couple\s+of\b/i, value: 2 },
  { re: /^a\s+few\b/i, value: 3 },
  { re: /^a\s+half\b/i, value: 0.5 },
  { re: /^half\s+of\s+an?\b/i, value: 0.5 },
  { re: /^half\s+an?\b/i, value: 0.5 },
  { re: /^quarter\s+of\s+an?\b/i, value: 0.25 },
  { re: /^quarter\s+an?\b/i, value: 0.25 },
  { re: /^half\b/i, value: 0.5 },
  { re: /^quarter\b/i, value: 0.25 },
];

// Unit tokens, longest-first so "tablespoons" wins over "tablespoon" and
// "ml" isn't grabbed by the "m" nothing-else rule. Matched case-insensitively
// with word boundaries. `foodFallback` marks units that are themselves the
// food ("3 eggs" has no "of" — the unit IS the food).
const UNITS = [
  { token: 'tablespoons', grams: 15, foodFallback: null },
  { token: 'tablespoon', grams: 15, foodFallback: null },
  { token: 'tbsp', grams: 15, foodFallback: null },
  { token: 'tbsps', grams: 15, foodFallback: null },
  { token: 'teaspoons', grams: 5, foodFallback: null },
  { token: 'teaspoon', grams: 5, foodFallback: null },
  { token: 'tsp', grams: 5, foodFallback: null },
  { token: 'tsps', grams: 5, foodFallback: null },
  { token: 'milliliters', grams: 1, foodFallback: null },
  { token: 'milliliters', grams: 1, foodFallback: null },
  { token: 'milliliter', grams: 1, foodFallback: null },
  { token: 'millilitre', grams: 1, foodFallback: null },
  { token: 'millilitres', grams: 1, foodFallback: null },
  { token: 'milliliter', grams: 1, foodFallback: null },
  { token: 'ounces', grams: 28.35, foodFallback: null },
  { token: 'ounce', grams: 28.35, foodFallback: null },
  { token: 'oz', grams: 28.35, foodFallback: null },
  { token: 'pounds', grams: 453.6, foodFallback: null },
  { token: 'pound', grams: 453.6, foodFallback: null },
  { token: 'lbs', grams: 453.6, foodFallback: null },
  { token: 'lb', grams: 453.6, foodFallback: null },
  { token: 'grams', grams: 1, foodFallback: null },
  { token: 'gram', grams: 1, foodFallback: null },
  { token: 'gms', grams: 1, foodFallback: null },
  { token: 'gm', grams: 1, foodFallback: null },
  { token: 'liters', grams: 1000, foodFallback: null },
  { token: 'liter', grams: 1000, foodFallback: null },
  { token: 'litres', grams: 1000, foodFallback: null },
  { token: 'litre', grams: 1000, foodFallback: null },
  { token: 'cups', grams: 240, foodFallback: null },
  { token: 'cup', grams: 240, foodFallback: null },
  { token: 'cans', grams: 355, foodFallback: 'can' },
  { token: 'can', grams: 355, foodFallback: 'can' },
  { token: 'bottles', grams: 500, foodFallback: 'bottle' },
  { token: 'bottle', grams: 500, foodFallback: 'bottle' },
  { token: 'slices', grams: 28, foodFallback: 'slice' },
  { token: 'slice', grams: 28, foodFallback: 'slice' },
  { token: 'eggs', grams: 50, foodFallback: 'egg' },
  { token: 'egg', grams: 50, foodFallback: 'egg' },
  { token: 'scoops', grams: 30, foodFallback: 'scoop' },
  { token: 'scoop', grams: 30, foodFallback: 'scoop' },
  { token: 'bowls', grams: 300, foodFallback: 'bowl' },
  { token: 'bowl', grams: 300, foodFallback: 'bowl' },
  { token: 'plates', grams: 400, foodFallback: 'plate' },
  { token: 'plate', grams: 400, foodFallback: 'plate' },
  { token: 'pieces', grams: 50, foodFallback: 'piece' },
  { token: 'piece', grams: 50, foodFallback: 'piece' },
  { token: 'servings', grams: 100, foodFallback: 'serving' },
  { token: 'serving', grams: 100, foodFallback: 'serving' },
  { token: 'handfuls', grams: 30, foodFallback: 'handful' },
  { token: 'handful', grams: 30, foodFallback: 'handful' },
  { token: 'bars', grams: 60, foodFallback: 'bar' },
  { token: 'bar', grams: 60, foodFallback: 'bar' },
  { token: 'packs', grams: 100, foodFallback: 'pack' },
  { token: 'pack', grams: 100, foodFallback: 'pack' },
  { token: 'bags', grams: 200, foodFallback: 'bag' },
  { token: 'bag', grams: 200, foodFallback: 'bag' },
  { token: 'glasses', grams: 240, foodFallback: 'glass' },
  { token: 'glass', grams: 240, foodFallback: 'glass' },
  { token: 'boxes', grams: 300, foodFallback: 'box' },
  { token: 'box', grams: 300, foodFallback: 'box' },
  { token: 'ml', grams: 1, foodFallback: null },
  { token: 'l', grams: 1000, foodFallback: null },
  { token: 'g', grams: 1, foodFallback: null },
  { token: 'c', grams: 240, foodFallback: null },
];

function normalizeText(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// Parses a leading number in word, fraction, or decimal form. Returns the
// numeric value plus the remaining (unmatched) text, or null if no leading
// quantity exists.
function matchLeadingQuantity(text) {
  const lower = text.toLowerCase();

  // Fraction form: "1/2 cup", "3/4 cup", "1/4 cup"
  const fraction = lower.match(/^(\d+)\s*\/\s*(\d+)\b(.*)$/);
  if (fraction) {
    const numerator = Number(fraction[1]);
    const denominator = Number(fraction[2]);
    if (denominator > 0 && numerator < denominator && numerator > 0) {
      return { value: numerator / denominator, rest: fraction[3].trim() };
    }
  }

  // Decimal or integer form: "1.5 cups", "45 oz", "2 tbsp"
  const number = lower.match(/^(\d+(?:\.\d+)?)\b(.*)$/);
  if (number) {
    return { value: Number(number[1]), rest: number[2].trim() };
  }

  // Special multi-word quantity phrases first ("a couple of", "half a",
  // "a half", "a few") so their leading article isn't swallowed by the bare
  // article rule below.
  for (const { re, value } of SPECIAL_QUANTITIES) {
    const match = lower.match(re);
    if (match) {
      let rest = lower.slice(match[0].length).trim();
      // "half a cup" -> strip the trailing "a"/"an" article after "half".
      rest = rest.replace(/^a\s+an?\b/, '').trim();
      return { value, rest };
    }
  }

  // Whole-number words at the start: "two eggs", "three slices of bread".
  for (const [word, value] of Object.entries(NUMBER_WORDS)) {
    if (lower === word) return { value, rest: '' };
    if (lower.startsWith(`${word} `)) return { value, rest: lower.slice(word.length).trim() };
  }

  // Article "a"/"an" — possibly followed by a number word ("a dozen eggs"
  // means 12, not 1). Falls through to a bare single article otherwise.
  const articlePair = lower.match(/^(an?)\s+([a-z]+)\b(.*)$/);
  if (articlePair) {
    const nextWord = articlePair[2];
    if (NUMBER_WORDS[nextWord] !== undefined) {
      return { value: NUMBER_WORDS[nextWord], rest: articlePair[3].trim() };
    }
    return { value: 1, rest: `${nextWord}${articlePair[3]}`.trim() };
  }
  const articleAlone = lower.match(/^(an?)\b(.*)$/);
  if (articleAlone) return { value: 1, rest: articleAlone[2].trim() };

  return null;
}

// Finds a unit token at the start of the text. Returns { token, grams,
// foodFallback, rest } or null.
function matchLeadingUnit(text) {
  const lower = text.toLowerCase();
  for (const unit of UNITS) {
    const re = new RegExp(`^${unit.token}\\b(.*)$`, 'i');
    const match = lower.match(re);
    if (match) {
      return { ...unit, rest: match[1].trim() };
    }
  }
  return null;
}

// Normalizes a "1 4 oz container"-style USDA portion description so it can be
// matched against the user's unit. Returns 'cup', 'ounce', 'tablespoon', ...
// or null when the description is too vague ("Quantity not specified").
function portionUnitFromDescription(description) {
  const normalized = normalizeText(description);
  if (!normalized || normalized === 'quantity not specified' || normalized === 'nfs') return null;
  // "undetermined" portions ("1 undetermined piece") have unreliable weights.
  if (normalized.includes('undetermined')) return null;

  // Strip the leading amount token ("1", "4") and any count prefix ("4 oz"
  // in "1 4 oz container") so we can match the real unit. The portion text
  // after the first token is what we search for unit keywords.
  const tokens = normalized.split(' ').filter(Boolean);
  // Skip the first token (the amount number) and look for a known unit.
  const afterAmount = tokens.slice(1).join(' ');

  // Known unit patterns to match in the remaining text.
  if (/\boz\b/.test(afterAmount)) return 'ounce';
  if (/\bcups?\b/.test(afterAmount)) return 'cup';
  if (/\btablespoons?\b|\btbsp\b/.test(afterAmount)) return 'tablespoon';
  if (/\bteaspoons?\b|\btsp\b/.test(afterAmount)) return 'teaspoon';
  if (/\bml\b/.test(afterAmount)) return 'milliliter';
  if (/\blit(?:er|re)s?\b/.test(afterAmount)) return 'liter';
  if (/\bgrams?\b/.test(afterAmount)) return 'gram';
  if (/\bbottles?\b/.test(afterAmount)) return 'bottle';
  if (/\bcans?\b/.test(afterAmount)) return 'can';
  if (/\bslices?\b/.test(afterAmount)) return 'slice';
  if (/\beggs?\b/.test(afterAmount)) return 'egg';
  if (/\bscoops?\b/.test(afterAmount)) return 'scoop';
  if (/\bbowls?\b/.test(afterAmount)) return 'bowl';
  if (/\bpieces?\b/.test(afterAmount)) return 'piece';
  if (/\bservings?\b/.test(afterAmount)) return 'serving';

  // If the first token is "1" and the second token is a plain word (not a
  // number), that word is the unit: "1 cup", "1 bottle", "1 piece".
  if (tokens[0] === '1' && tokens[1] && !/^\d+$/.test(tokens[1])) {
    return tokens[1];
  }

  return null;
}

// Looks for a portion in the USDA result whose unit matches the user's unit
// and whose description implies a single serving ("1 cup", "1 4 oz container",
// "1 piece"), then returns its gram weight. Returns null when no portion
// matches or when the unit was a food-with-no-portions kind ("egg").
//
// When multiple portions match the same unit, prefers the one whose description
// starts with "1 <unit>" (a direct measurement) over "Guideline amount per cup
// of X" or other indirect descriptions.
function findUsdaPortionGrams(match, unit) {
  if (!match || !Array.isArray(match.portions) || !unit) return null;

  // When a portion description starts with "1 <unit>" (e.g. "1 cup"), it's a
  // direct measurement. Otherwise it's a guideline or derived amount (
  // "Guideline amount per cup of hot cereal") and should only be used as a
  // fallback.
  const directPrefix = new RegExp(`^1\\s+${unit}\\b`, 'i');

  let bestPortion = null;
  let bestIsDirect = false;

  for (const portion of match.portions) {
    const portionUnit = portionUnitFromDescription(portion.description);
    if (portionUnit !== unit) continue;
    const isDirect = directPrefix.test(portion.description);
    if (isDirect) return portion.gramWeight; // direct match wins immediately
    // Keep the first indirect match as a fallback.
    if (!bestPortion) bestPortion = portion;
  }

  return bestPortion ? bestPortion.gramWeight : null;
}

// Unit tokens that never get a USDA portion refinement — the USDA stores
// "1 egg" as a portion in some datasets but the gram weight per egg varies
// wildly by size class, and the fallback is good enough.
const NO_REFINE_UNITS = new Set(['egg', 'eggs', 'slice', 'slices', 'can', 'cans', 'bottle', 'bottles', 'bowl', 'bowls', 'plate', 'plates', 'piece', 'pieces']);

/**
 * parseQuantity(text[, options]) -> { foodName, grams, quantity, unit,
 *                                   refinedFromUsda, originalText }
 *
 * options:
 *   usdaSearch: async (foodName) => Promise<{ matches: [...] } | null> —
 *     the same shape nutrition-index.js's `search` command returns. When
 *     provided and the unit is a refinable volume/weight unit, the best
 *     match's "1 <unit>" portion weight replaces the hardcoded default.
 */
async function parseQuantity(text, options = {}) {
  const originalText = String(text || '').trim();
  if (!originalText) {
    return { foodName: '', grams: 0, quantity: 1, unit: null, refinedFromUsda: false, originalText };
  }

  const normalized = normalizeText(originalText);

  // Step 1: strip leading quantity.
  const quantityMatch = matchLeadingQuantity(normalized);
  const quantity = quantityMatch ? quantityMatch.value : null;
  const afterQuantity = quantityMatch ? quantityMatch.rest : normalized;

  // Step 2: detect unit immediately after the quantity (or at the start if
  // there was no quantity, e.g. "cup of yogurt" is a bit odd but valid).
  let unitMatch = quantityMatch ? matchLeadingUnit(afterQuantity) : matchLeadingUnit(normalized);

  // Step 3: split food name. Two shapes:
  //   (a) "N <unit> of <food>"  -> food = remainder after "of"
  //   (b) "N <unit>" (egg-like) -> food = the unit itself ("3 eggs")
  //   (c) no unit               -> food = the whole remainder ("yogurt")
  let foodName;
  let unit = null;
  let unitGrams = null;
  let refinedFromUsda = false;

  if (unitMatch) {
    unit = unitMatch.token;
    unitGrams = unitMatch.grams;
    const afterUnit = unitMatch.rest;
    const ofSplit = afterUnit.match(/^of\s+(.+)$/);
    if (ofSplit) {
      foodName = ofSplit[1].trim();
    } else if (unitMatch.foodFallback && !ofSplit) {
      // "3 eggs" — the unit is the food.
      foodName = unitMatch.foodFallback;
    } else {
      // "a cup yogurt" (no "of") — treat the remainder as the food.
      foodName = afterUnit || unitMatch.foodFallback;
    }
  } else {
    foodName = afterQuantity || normalized;
    // No unit and no quantity word -> plain food name.
  }

  if (!foodName) foodName = unitMatch?.foodFallback || '';

  // Step 4: compute grams.
  let grams;
  const baseUnit = unit ? unit.replace(/s$/, '') : unit; // singular for lookup
  if (!unit) {
    // No unit: default to 100g per "serving" (the plan's convention: bare
    // "yogurt" → 100g, "a banana" → 100g, "two bananas" → 200g).
    grams = (quantity ?? 1) * 100;
  } else if (quantity === null) {
    // "cup of yogurt" without a leading number -> one unit.
    grams = unitGrams;
  } else {
    grams = quantity * unitGrams;
  }

  // Step 5: USDA portion refinement — only when the caller passed a search
  // hook, we have a real unit, and that unit is one the USDA portion table
  // can improve (cups/oz/tbsp/tsp/ml/g etc.).
  if (typeof options.usdaSearch === 'function' && unit && !NO_REFINE_UNITS.has(unit)) {
    try {
      const result = await options.usdaSearch(foodName);
      const matches = result && Array.isArray(result.matches) ? result.matches : [];
      // Scan every candidate match's portions for one whose unit matches the
      // user's unit — the top-ranked USDA hit is often a generic/odd food
      // ("Tofu yogurt") whose portion table lacks a clean "1 cup", while a
      // lower-ranked one has exactly what we want.
      let portionGrams = null;
      for (const match of matches) {
        portionGrams = findUsdaPortionGrams(match, unit);
        if (portionGrams && portionGrams > 0) break;
      }
      if (portionGrams && portionGrams > 0) {
        grams = (quantity ?? 1) * portionGrams;
        refinedFromUsda = true;
      }
    } catch (_err) {
      // USDA refinement is best-effort — fall back to the default silently.
    }
  }

  grams = Math.round(grams * 10) / 10;

  return {
    foodName,
    grams,
    quantity: quantity ?? 1,
    unit: unit || null,
    refinedFromUsda,
    originalText,
  };
}

module.exports = {
  parseQuantity,
  // exported for tests / reuse
  UNIT_GRAMS,
  matchLeadingQuantity,
  matchLeadingUnit,
  portionUnitFromDescription,
  findUsdaPortionGrams,
};
