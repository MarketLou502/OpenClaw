#!/usr/bin/env node
'use strict';

// Recipe importer — fetches a recipe URL, extracts structured recipe data
// (JSON-LD → OpenGraph/meta → heuristic HTML fallback), standardizes it,
// and saves it into meal-planner.sqlite via meal-planner-workflow.js.
//
// Usage: node scripts/recipe-importer.js "https://www.example.com/recipe/..."
//
// No npm dependencies: uses Node's built-in fetch() and a small regex-based
// HTML scanner (sites with structured data — the overwhelming majority of
// real recipe pages — never need the heuristic fallback's regex parsing to
// do anything more than find a handful of well-known class names).

const path = require('node:path');
const workflow = require('./meal-planner-workflow.js');

const RECIPE_TYPES = new Set(['quick', 'prepared']);

function fail(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

async function fetchHtml(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw fail('INVALID_URL', `'${url}' is not a valid URL`);
  }
  if (parsed.protocol !== 'https:') {
    throw fail('INVALID_URL', 'Only https:// URLs are supported');
  }
  let response;
  try {
    response = await fetch(parsed.toString(), {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    });
  } catch (error) {
    throw fail('FETCH_FAILED', `Could not reach ${parsed.hostname}: ${error.message}`);
  }
  if (!response.ok) {
    throw fail('FETCH_FAILED', `${parsed.hostname} returned HTTP ${response.status}`);
  }
  const contentType = response.headers.get('content-type') || '';
  if (contentType && !contentType.includes('html')) {
    throw fail('NOT_HTML', `Expected an HTML page, got content-type '${contentType}'`);
  }
  const html = await response.text();
  return { html, finalUrl: response.url || parsed.toString() };
}

// ---------------------------------------------------------------------------
// Strategy A: schema.org Recipe via JSON-LD
// ---------------------------------------------------------------------------

function extractJsonLdBlocks(html) {
  const blocks = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = re.exec(html)) !== null) {
    const raw = decodeHtmlEntities(match[1].trim());
    try {
      blocks.push(JSON.parse(raw));
    } catch {
      // Some sites emit multiple JSON objects concatenated or trailing
      // commas — not worth a full recovery parser here, just skip it.
    }
  }
  return blocks;
}

function flattenJsonLd(node, out) {
  if (!node) return out;
  if (Array.isArray(node)) {
    for (const item of node) flattenJsonLd(item, out);
    return out;
  }
  if (typeof node !== 'object') return out;
  out.push(node);
  if (node['@graph']) flattenJsonLd(node['@graph'], out);
  return out;
}

function isRecipeNode(node) {
  const type = node['@type'];
  if (!type) return false;
  const types = Array.isArray(type) ? type : [type];
  return types.some((t) => String(t).toLowerCase() === 'recipe');
}

function findRecipeJsonLd(html) {
  const blocks = extractJsonLdBlocks(html);
  const flat = [];
  for (const block of blocks) flattenJsonLd(block, flat);
  return flat.find(isRecipeNode) || null;
}

// ---------------------------------------------------------------------------
// ISO 8601 duration → minutes (e.g. "PT30M", "PT1H15M")
// ---------------------------------------------------------------------------

function isoDurationToMinutes(iso) {
  if (!iso || typeof iso !== 'string') return null;
  const match = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?/.exec(iso.trim());
  if (!match) return null;
  const days = Number(match[1] || 0);
  const hours = Number(match[2] || 0);
  const minutes = Number(match[3] || 0);
  const total = days * 24 * 60 + hours * 60 + minutes;
  return total > 0 ? total : null;
}

// ---------------------------------------------------------------------------
// Text / HTML cleanup helpers
// ---------------------------------------------------------------------------

function decodeHtmlEntities(str) {
  if (!str) return '';
  return String(str)
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)));
}

function stripTags(html) {
  return decodeHtmlEntities(String(html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

// Normalizes unit spelling (tablespoon(s) -> tbsp, teaspoon(s) -> tsp, etc.)
// and strips parenthetical notes like "(optional)" or "(about 2 lbs)".
const UNIT_ALIASES = [
  [/\btablespoons?\b/gi, 'tbsp'],
  [/\bteaspoons?\b/gi, 'tsp'],
  [/\bounces?\b/gi, 'oz'],
  [/\bpounds?\b/gi, 'lb'],
  [/\bgrams?\b/gi, 'g'],
  [/\bkilograms?\b/gi, 'kg'],
  [/\bmilliliters?\b/gi, 'ml'],
  [/\bliters?\b/gi, 'l'],
  [/\bcups?\b/gi, 'cup'],
  [/\bcloves?\b/gi, 'clove'],
];

function cleanIngredientText(text) {
  let cleaned = stripTags(text);
  cleaned = cleaned.replace(/\([^)]*\)/g, ' '); // strip parenthetical notes
  for (const [pattern, replacement] of UNIT_ALIASES) {
    cleaned = cleaned.replace(pattern, replacement);
  }
  return cleaned.replace(/\s+/g, ' ').trim();
}

// Splits a raw ingredient line like "2 cups chopped tomatoes" into
// { quantity: "2 cup", name: "chopped tomatoes" }. Heuristic, not exact —
// good enough for display purposes; the exact string is preserved in notes
// if this fails to find a clean split.
function splitIngredientQuantity(line) {
  const cleaned = cleanIngredientText(line);
  const match = /^([\d./½¼¾⅓⅔⅛\s]+(?:-\s*[\d./]+)?\s*(?:tbsp|tsp|oz|lb|g|kg|ml|l|cup|clove|can|slice|slices|pinch|dash)?s?\.?)\s+(.*)$/i.exec(cleaned);
  if (match && match[2] && match[2].trim().length > 1) {
    return { quantity: match[1].trim() || null, name: match[2].trim() };
  }
  return { quantity: null, name: cleaned };
}

function parseServingSize(yieldValue) {
  if (yieldValue == null) return null;
  const values = Array.isArray(yieldValue) ? yieldValue : [yieldValue];
  for (const value of values) {
    const match = /(\d+)/.exec(String(value));
    if (match) return Number(match[1]);
  }
  return null;
}

// Extracts a leading number from strings like "350 calories", "350kcal", "350".
function parseNumericAmount(value) {
  if (value == null) return null;
  const match = /([\d.]+)/.exec(String(value));
  return match ? Number(match[1]) : null;
}

function instructionsToStrings(recipeInstructions) {
  if (!recipeInstructions) return [];
  if (typeof recipeInstructions === 'string') {
    // Some sites put the whole instructions blob as one string, sometimes
    // with steps separated by newlines.
    return recipeInstructions.split(/\n+/).map((s) => stripTags(s)).filter(Boolean);
  }
  if (!Array.isArray(recipeInstructions)) return [];
  const out = [];
  for (const item of recipeInstructions) {
    if (typeof item === 'string') {
      out.push(stripTags(item));
    } else if (item && item['@type'] === 'HowToSection' && Array.isArray(item.itemListElement)) {
      for (const sub of item.itemListElement) {
        if (sub && sub.text) out.push(stripTags(sub.text));
      }
    } else if (item && item.text) {
      out.push(stripTags(item.text));
    } else if (item && item.name) {
      out.push(stripTags(item.name));
    }
  }
  return out.filter(Boolean);
}

function firstImageUrl(image) {
  if (!image) return null;
  if (typeof image === 'string') return image;
  if (Array.isArray(image)) return firstImageUrl(image[0]);
  if (typeof image === 'object') return image.url || null;
  return null;
}

function extractNutrition(nutrition) {
  const out = { calories: null, protein: null };
  if (!nutrition || typeof nutrition !== 'object') return out;
  if (nutrition.calories) out.calories = parseNumericAmount(nutrition.calories);
  if (nutrition.proteinContent) out.protein = parseNumericAmount(nutrition.proteinContent);
  return out;
}

// ---------------------------------------------------------------------------
// Strategy B: OpenGraph / meta tags
// ---------------------------------------------------------------------------

function extractMeta(html) {
  const get = (attr, key) => {
    const re = new RegExp(`<meta[^>]+${attr}=["']${key}["'][^>]*content=["']([^"']*)["']`, 'i');
    const reRev = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*${attr}=["']${key}["']`, 'i');
    const match = re.exec(html) || reRev.exec(html);
    return match ? decodeHtmlEntities(match[1]) : null;
  };
  const titleMatch = /<title[^>]*>([^<]*)<\/title>/i.exec(html);
  return {
    title: get('property', 'og:title') || get('name', 'twitter:title') || (titleMatch ? decodeHtmlEntities(titleMatch[1]).trim() : null),
    description: get('property', 'og:description') || get('name', 'description'),
    image: get('property', 'og:image'),
  };
}

// ---------------------------------------------------------------------------
// Strategy C: heuristic HTML fallback (common class names / headings)
// ---------------------------------------------------------------------------

const INGREDIENT_CLASS_RE = /<(?:li|span|div|p)[^>]*class=["'][^"']*(?:ingredient)[^"']*["'][^>]*>([\s\S]*?)<\/(?:li|span|div|p)>/gi;
const INSTRUCTION_CLASS_RE = /<(?:li|p|div)[^>]*class=["'][^"']*(?:instruction|direction|step)[^"']*["'][^>]*>([\s\S]*?)<\/(?:li|p|div)>/gi;

function extractByClassName(html, regex) {
  const out = [];
  let match;
  const re = new RegExp(regex.source, regex.flags);
  while ((match = re.exec(html)) !== null) {
    const text = stripTags(match[1]);
    // Avoid grabbing wrapper elements that contain nested block markup and
    // little actual text, or elements that are themselves just containers.
    if (text && text.length > 1 && text.length < 500 && !/^ingredients?$/i.test(text) && !/^(instructions?|directions?|steps?)$/i.test(text)) {
      out.push(text);
    }
  }
  return [...new Set(out)];
}

function heuristicExtract(html) {
  const ingredients = extractByClassName(html, INGREDIENT_CLASS_RE);
  const instructions = extractByClassName(html, INSTRUCTION_CLASS_RE);
  return { ingredients, instructions };
}

// ---------------------------------------------------------------------------
// Standardize into the shape add-recipe / recipe_instructions expects
// ---------------------------------------------------------------------------

function estimateCaloriesFromIngredients(count) {
  // Very rough fallback used only when a site provides no nutrition data at
  // all: ~120 kcal/ingredient is a reasonable ballpark for a home-cooked
  // dish's per-serving share. Flagged in the reply so it's never mistaken
  // for a real figure.
  return count > 0 ? Math.round(count * 120) : 300;
}

function estimateProteinFromIngredients(count) {
  return count > 0 ? Math.round(count * 5) : 10;
}

function guessMealSlotHint(title, tags) {
  const haystack = `${title} ${tags.join(' ')}`.toLowerCase();
  if (/\b(breakfast|pancake|omelet|oatmeal|granola)\b/.test(haystack)) return 'breakfast';
  if (/\b(snack|bar|bite)\b/.test(haystack)) return 'snack';
  if (/\b(lunch|sandwich|salad|wrap)\b/.test(haystack)) return 'lunch';
  if (/\b(dinner|roast|casserole|stew)\b/.test(haystack)) return 'dinner';
  return 'any';
}

async function standardizeRecipe(url) {
  const { html, finalUrl } = await fetchHtml(url);
  const meta = extractMeta(html);
  const jsonLd = findRecipeJsonLd(html);

  let name = null;
  let description = null;
  let rawIngredients = [];
  let rawInstructions = [];
  let prepTimeMinutes = null;
  let cookTimeMinutes = null;
  let servingSize = null;
  let imageUrl = null;
  let cuisine = null;
  let calories = null;
  let protein = null;
  let strategyUsed = 'none';

  if (jsonLd) {
    strategyUsed = 'json-ld';
    name = jsonLd.name ? stripTags(jsonLd.name) : null;
    description = jsonLd.description ? stripTags(jsonLd.description) : null;
    rawIngredients = Array.isArray(jsonLd.recipeIngredient)
      ? jsonLd.recipeIngredient.map(stripTags)
      : (Array.isArray(jsonLd.ingredients) ? jsonLd.ingredients.map(stripTags) : []);
    rawInstructions = instructionsToStrings(jsonLd.recipeInstructions);
    prepTimeMinutes = isoDurationToMinutes(jsonLd.prepTime);
    cookTimeMinutes = isoDurationToMinutes(jsonLd.cookTime);
    if (!prepTimeMinutes && !cookTimeMinutes) {
      const total = isoDurationToMinutes(jsonLd.totalTime);
      if (total) cookTimeMinutes = total;
    }
    servingSize = parseServingSize(jsonLd.recipeYield);
    imageUrl = firstImageUrl(jsonLd.image);
    cuisine = jsonLd.recipeCuisine ? stripTags(Array.isArray(jsonLd.recipeCuisine) ? jsonLd.recipeCuisine[0] : jsonLd.recipeCuisine) : null;
    const nutrition = extractNutrition(jsonLd.nutrition);
    calories = nutrition.calories;
    protein = nutrition.protein;
  }

  if (!name) {
    strategyUsed = jsonLd ? strategyUsed : 'meta';
    name = meta.title;
    description = description || meta.description;
    imageUrl = imageUrl || meta.image;
  }

  if (rawIngredients.length === 0 || rawInstructions.length === 0) {
    const heuristic = heuristicExtract(html);
    if (rawIngredients.length === 0 && heuristic.ingredients.length) {
      strategyUsed = strategyUsed === 'none' ? 'heuristic' : `${strategyUsed}+heuristic`;
      rawIngredients = heuristic.ingredients;
    }
    if (rawInstructions.length === 0 && heuristic.instructions.length) {
      strategyUsed = strategyUsed === 'none' ? 'heuristic' : `${strategyUsed}+heuristic`;
      rawInstructions = heuristic.instructions;
    }
  }

  if (!name) {
    throw fail('NO_RECIPE_FOUND', `Could not find a recipe title on ${finalUrl}`);
  }
  if (rawIngredients.length === 0 && rawInstructions.length === 0) {
    throw fail('NO_RECIPE_FOUND', `Could not find recipe ingredients or instructions on ${finalUrl}`);
  }

  const ingredients = rawIngredients.map((raw) => splitIngredientQuantity(raw)).filter((i) => i.name);
  const instructions = rawInstructions.map((s) => stripTags(s)).filter(Boolean);

  let caloriesEstimated = false;
  let proteinEstimated = false;
  if (calories == null) {
    calories = estimateCaloriesFromIngredients(ingredients.length);
    caloriesEstimated = true;
  }
  if (protein == null) {
    protein = estimateProteinFromIngredients(ingredients.length);
    proteinEstimated = true;
  }

  const tags = [];
  if (cuisine) tags.push(cuisine.toLowerCase());

  return {
    name,
    description,
    ingredients,
    instructions,
    prepTimeMinutes,
    cookTimeMinutes,
    servingSize,
    imageUrl,
    cuisine,
    calories,
    protein,
    caloriesEstimated,
    proteinEstimated,
    sourceUrl: finalUrl,
    strategyUsed,
    mealSlotHint: guessMealSlotHint(name, tags),
    tags,
  };
}

// ---------------------------------------------------------------------------
// Save to DB via the workflow module
// ---------------------------------------------------------------------------

async function saveRecipe(standardized) {
  const existing = await workflow.execute(['find-recipe', '--query', standardized.name]);
  if (existing.ok && existing.found) {
    throw fail('DUPLICATE_RECIPE', `A recipe named '${existing.recipe.name}' already exists`, { recipeId: existing.recipe.id });
  }

  const type = standardized.instructions.length > 3 || (standardized.prepTimeMinutes || 0) + (standardized.cookTimeMinutes || 0) > 20
    ? 'prepared'
    : 'quick';

  const servingText = standardized.servingSize
    ? `${standardized.servingSize} serving${standardized.servingSize === 1 ? '' : 's'}`
    : 'servings not specified';

  const addArgv = [
    'add-recipe',
    '--name', standardized.name,
    '--type', type,
    '--serving', servingText,
    '--calories', String(Math.round(standardized.calories)),
    '--protein', String(Math.round(standardized.protein)),
    '--meal-slot-hint', standardized.mealSlotHint,
  ];
  if (standardized.tags.length) addArgv.push('--tags', standardized.tags.join(','));
  if (standardized.ingredients.length) {
    addArgv.push('--ingredients', standardized.ingredients.map((i) => (i.quantity ? `${i.name}:${i.quantity}` : i.name)).join(','));
  }
  if (standardized.instructions.length) {
    addArgv.push('--instructions', standardized.instructions.join('|'));
  }
  if (standardized.prepTimeMinutes) addArgv.push('--prep-time-minutes', String(standardized.prepTimeMinutes));
  if (standardized.cookTimeMinutes) addArgv.push('--cook-time-minutes', String(standardized.cookTimeMinutes));
  addArgv.push('--source-url', standardized.sourceUrl);
  if (standardized.imageUrl) addArgv.push('--image-url', standardized.imageUrl);
  if (standardized.cuisine) addArgv.push('--cuisine', standardized.cuisine);
  if (standardized.servingSize) addArgv.push('--serving-size', String(standardized.servingSize));

  const result = await workflow.execute(addArgv);
  if (!result.ok) {
    throw fail(result.code || 'SAVE_FAILED', result.error || 'Failed to save recipe');
  }
  return result.recipe;
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function importRecipe(url) {
  const standardized = await standardizeRecipe(url);
  const recipe = await saveRecipe(standardized);
  const notes = [];
  if (standardized.caloriesEstimated) notes.push('calories estimated from ingredient count (not found on page)');
  if (standardized.proteinEstimated) notes.push('protein estimated from ingredient count (not found on page)');
  return {
    ok: true,
    recipe: {
      id: recipe.id,
      name: recipe.name,
      ingredientsCount: recipe.ingredients.length,
      stepsCount: recipe.instructions.length,
      calories: recipe.calories,
      protein: recipe.protein,
      prepTimeMinutes: recipe.prepTimeMinutes,
      cookTimeMinutes: recipe.cookTimeMinutes,
      sourceUrl: recipe.sourceUrl,
      strategyUsed: standardized.strategyUsed,
    },
    warnings: notes,
    reply: `Imported "${recipe.name}" — ${recipe.ingredients.length} ingredients, ${recipe.instructions.length} steps.${notes.length ? ` (${notes.join('; ')})` : ''}`,
  };
}

async function main(argv) {
  const url = argv[0];
  if (!url) {
    process.stdout.write(`${JSON.stringify({ ok: false, code: 'USAGE', error: 'Usage: node recipe-importer.js <url>' })}\n`);
    process.exitCode = 1;
    return;
  }
  try {
    const result = await importRecipe(url);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      code: error.code || 'RECIPE_IMPORT_ERROR',
      error: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    })}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = {
  standardizeRecipe,
  saveRecipe,
  importRecipe,
  isoDurationToMinutes,
  cleanIngredientText,
  splitIngredientQuantity,
};
