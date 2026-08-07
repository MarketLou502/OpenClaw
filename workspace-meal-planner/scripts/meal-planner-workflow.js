#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const DEFAULT_DB = path.join(__dirname, '..', 'data', 'meal-planner.sqlite');
const DEFAULT_DASHBOARD_URL = 'http://127.0.0.1:18795';
const DEFAULT_TOKEN_FILE = '/Users/aaronmacmini/.openclaw/service-env/dashboard-api.token';
const TIME_ZONE = 'America/New_York';

const RECIPE_TYPES = new Set(['quick', 'prepared']);
const MEAL_SLOTS = new Set(['breakfast', 'lunch', 'dinner', 'snack', 'any']);
const BASE_SLOTS = ['breakfast', 'lunch', 'dinner'];

// Tuning constants for assemble-plan's fill heuristic. Deliberately simple
// and adjustable rather than a full optimizer — see MEAL_PLANNER_WORKFLOW_DESIGN.md.
const CALORIE_TOLERANCE = 1.1; // allow a candidate up to 10% over target before rejecting it outright
const SNACK_CALORIE_HEADROOM_MIN = 150; // don't bother adding a snack slot for a smaller gap than this
const SNACK_PROTEIN_HEADROOM_MIN = 10;
const MAX_SNACK_SLOTS = 3;
const INSUFFICIENT_PROTEIN_FRACTION = 0.15; // flag libraryInsufficient if this much of the protein target remains unmet

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const args = { _: [] };
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token.startsWith('--')) {
      args._.push(token);
      continue;
    }
    const key = token.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = rest[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return { command, args };
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(new RegExp('[\\u0300-\\u036f]', 'g'), '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function requireText(args, key, label = key) {
  const value = String(args[key] || '').trim();
  if (!value) throw workflowError('INVALID_ARGUMENT', `${label} is required`);
  return value;
}

function optionalText(args, key) {
  const value = args[key];
  return value === undefined ? null : String(value).trim() || null;
}

function numberArg(args, key, options = {}) {
  if (args[key] === undefined) {
    if (options.optional) return null;
    throw workflowError('INVALID_ARGUMENT', `${options.label || key} is required`);
  }
  const value = Number(args[key]);
  if (!Number.isFinite(value)) {
    throw workflowError('INVALID_ARGUMENT', `${options.label || key} must be a number`);
  }
  const min = options.min ?? 0;
  const max = options.max ?? Number.POSITIVE_INFINITY;
  if (value < min || value > max) {
    throw workflowError('INVALID_ARGUMENT', `${options.label || key} must be between ${min} and ${max}`);
  }
  return value;
}

function workflowError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function nowIso() {
  const override = process.env.MEAL_PLANNER_NOW;
  const date = override ? new Date(override) : new Date();
  if (Number.isNaN(date.getTime())) throw workflowError('INVALID_TIME', 'MEAL_PLANNER_NOW is not a valid date');
  return date.toISOString();
}

function localDate(iso = nowIso()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(iso));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function round1(value) {
  return Math.round(Number(value) * 10) / 10;
}

function openDatabase(dbPath = process.env.MEAL_PLANNER_DB || DEFAULT_DB) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS recipes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      normalized_name TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL CHECK(type IN ('quick','prepared')),
      meal_slot_hint TEXT NOT NULL CHECK(meal_slot_hint IN ('breakfast','lunch','dinner','snack','any')),
      serving TEXT NOT NULL,
      calories REAL NOT NULL CHECK(calories >= 0),
      protein REAL NOT NULL CHECK(protein >= 0),
      notes TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS recipe_aliases (
      recipe_id TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
      alias TEXT NOT NULL,
      normalized_alias TEXT NOT NULL UNIQUE,
      PRIMARY KEY (recipe_id, normalized_alias)
    );
    CREATE TABLE IF NOT EXISTS recipe_ingredients (
      id TEXT PRIMARY KEY,
      recipe_id TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
      ingredient_name TEXT NOT NULL,
      normalized_name TEXT NOT NULL,
      quantity TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS recipe_ingredients_recipe ON recipe_ingredients(recipe_id);
    CREATE INDEX IF NOT EXISTS recipe_ingredients_name ON recipe_ingredients(normalized_name);
    CREATE TABLE IF NOT EXISTS recipe_tags (
      recipe_id TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
      tag TEXT NOT NULL,
      PRIMARY KEY (recipe_id, tag)
    );
    CREATE TABLE IF NOT EXISTS daily_plans (
      id TEXT PRIMARY KEY,
      plan_date TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','confirmed')),
      calorie_target REAL NOT NULL,
      protein_target REAL NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS plan_items (
      id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL REFERENCES daily_plans(id) ON DELETE CASCADE,
      slot TEXT NOT NULL CHECK(slot IN ('breakfast','lunch','dinner','snack')),
      recipe_id TEXT REFERENCES recipes(id),
      recipe_name_snapshot TEXT NOT NULL,
      calories REAL NOT NULL,
      protein REAL NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','swapped','removed')),
      supersedes_id TEXT REFERENCES plan_items(id),
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS plan_items_plan ON plan_items(plan_id, status);
    CREATE TABLE IF NOT EXISTS pantry_items (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      normalized_name TEXT NOT NULL UNIQUE,
      quantity TEXT,
      updated_at TEXT NOT NULL
    );
  `);
  return db;
}

function withTransaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Recipes
// ---------------------------------------------------------------------------

function rowToRecipeBase(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    normalizedName: row.normalized_name,
    type: row.type,
    mealSlotHint: row.meal_slot_hint,
    servingText: row.serving,
    calories: row.calories,
    protein: row.protein,
    notes: row.notes,
    active: !!row.active,
  };
}

function attachRecipeChildren(db, recipe) {
  const ingredients = db.prepare(`
    SELECT ingredient_name, quantity FROM recipe_ingredients
    WHERE recipe_id = ? ORDER BY sort_order ASC
  `).all(recipe.id).map((r) => ({ name: r.ingredient_name, quantity: r.quantity }));
  const tags = db.prepare(`
    SELECT tag FROM recipe_tags WHERE recipe_id = ? ORDER BY tag ASC
  `).all(recipe.id).map((r) => r.tag);
  const aliases = db.prepare(`
    SELECT alias FROM recipe_aliases WHERE recipe_id = ? ORDER BY alias ASC
  `).all(recipe.id).map((r) => r.alias);
  return { ...recipe, ingredients, tags, aliases };
}

function parseListArg(raw) {
  return raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : [];
}

function parseIngredients(raw) {
  return parseListArg(raw).map((token, idx) => {
    const sep = token.indexOf(':');
    const name = sep === -1 ? token.trim() : token.slice(0, sep).trim();
    const quantity = sep === -1 ? null : token.slice(sep + 1).trim() || null;
    return { name, quantity, sortOrder: idx };
  });
}

function findDuplicateRecipe(db, normalizedName, excludeId) {
  const row = db.prepare(`
    SELECT r.name FROM recipes r
    LEFT JOIN recipe_aliases a ON a.recipe_id = r.id
    WHERE (r.normalized_name = ? OR a.normalized_alias = ?) AND r.id != ?
    LIMIT 1
  `).get(normalizedName, normalizedName, excludeId || '');
  return row || null;
}

function findRecipeByIdOrName(db, id, name) {
  let row = null;
  if (id) {
    row = db.prepare('SELECT * FROM recipes WHERE id = ? AND active = 1').get(id);
  } else if (name) {
    const normalized = normalizeText(name);
    row = db.prepare(`
      SELECT r.* FROM recipes r
      LEFT JOIN recipe_aliases a ON a.recipe_id = r.id
      WHERE r.active = 1 AND (r.normalized_name = ? OR a.normalized_alias = ?)
      LIMIT 1
    `).get(normalized, normalized);
  } else {
    throw workflowError('INVALID_ARGUMENT', 'A recipe id or name is required');
  }
  if (!row) throw workflowError('NOT_FOUND', 'No matching recipe was found');
  return row;
}

function addRecipe(db, args) {
  const name = requireText(args, 'name');
  const normalizedName = normalizeText(name);
  const type = requireText(args, 'type');
  if (!RECIPE_TYPES.has(type)) throw workflowError('INVALID_ARGUMENT', `type must be one of: ${[...RECIPE_TYPES].join(', ')}`);
  const serving = requireText(args, 'serving');
  const calories = numberArg(args, 'calories', { max: 10000 });
  const protein = numberArg(args, 'protein', { max: 1000 });
  const notes = optionalText(args, 'notes');
  const mealSlotHint = optionalText(args, 'mealSlotHint') || 'any';
  if (!MEAL_SLOTS.has(mealSlotHint)) throw workflowError('INVALID_ARGUMENT', `meal slot hint must be one of: ${[...MEAL_SLOTS].join(', ')}`);
  const tags = parseListArg(optionalText(args, 'tags'));
  const aliases = parseListArg(optionalText(args, 'aliases'));
  const ingredients = parseIngredients(optionalText(args, 'ingredients'));

  const duplicate = findDuplicateRecipe(db, normalizedName);
  if (duplicate) throw workflowError('DUPLICATE_RECIPE', `A recipe named or aliased '${duplicate.name}' already exists`);

  const createdAt = nowIso();
  const id = crypto.randomUUID();
  withTransaction(db, () => {
    db.prepare(`
      INSERT INTO recipes (id, name, normalized_name, type, meal_slot_hint, serving, calories, protein, notes, active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(id, name, normalizedName, type, mealSlotHint, serving, calories, protein, notes, createdAt, createdAt);
    const tagInsert = db.prepare('INSERT INTO recipe_tags (recipe_id, tag) VALUES (?, ?)');
    for (const tag of tags) tagInsert.run(id, tag);
    const aliasInsert = db.prepare('INSERT INTO recipe_aliases (recipe_id, alias, normalized_alias) VALUES (?, ?, ?)');
    for (const alias of aliases) aliasInsert.run(id, alias, normalizeText(alias));
    const ingredientInsert = db.prepare(`
      INSERT INTO recipe_ingredients (id, recipe_id, ingredient_name, normalized_name, quantity, sort_order)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const ing of ingredients) ingredientInsert.run(crypto.randomUUID(), id, ing.name, normalizeText(ing.name), ing.quantity, ing.sortOrder);
  });
  const recipe = attachRecipeChildren(db, rowToRecipeBase(db.prepare('SELECT * FROM recipes WHERE id = ?').get(id)));
  return { ok: true, operation: 'add-recipe', recipe, reply: `Added ${name} to your recipes.` };
}

function updateRecipe(db, args) {
  const existing = findRecipeByIdOrName(db, optionalText(args, 'id'), optionalText(args, 'match'));
  const newName = optionalText(args, 'name');
  const newNormalizedName = newName ? normalizeText(newName) : existing.normalized_name;
  const type = optionalText(args, 'type');
  if (type && !RECIPE_TYPES.has(type)) throw workflowError('INVALID_ARGUMENT', `type must be one of: ${[...RECIPE_TYPES].join(', ')}`);
  const serving = optionalText(args, 'serving');
  const calories = numberArg(args, 'calories', { optional: true, max: 10000 });
  const protein = numberArg(args, 'protein', { optional: true, max: 1000 });
  const notesProvided = args.notes !== undefined;
  const notes = notesProvided ? optionalText(args, 'notes') : undefined;
  const mealSlotHint = optionalText(args, 'mealSlotHint');
  if (mealSlotHint && !MEAL_SLOTS.has(mealSlotHint)) throw workflowError('INVALID_ARGUMENT', `meal slot hint must be one of: ${[...MEAL_SLOTS].join(', ')}`);

  if (newName && newNormalizedName !== existing.normalized_name) {
    const duplicate = findDuplicateRecipe(db, newNormalizedName, existing.id);
    if (duplicate) throw workflowError('DUPLICATE_RECIPE', `A recipe named or aliased '${duplicate.name}' already exists`);
  }

  const updatedAt = nowIso();
  withTransaction(db, () => {
    db.prepare(`
      UPDATE recipes SET
        name = ?, normalized_name = ?, type = ?, serving = ?, calories = ?, protein = ?,
        notes = ?, meal_slot_hint = ?, updated_at = ?
      WHERE id = ?
    `).run(
      newName || existing.name,
      newNormalizedName,
      type || existing.type,
      serving || existing.serving,
      calories ?? existing.calories,
      protein ?? existing.protein,
      notesProvided ? notes : existing.notes,
      mealSlotHint || existing.meal_slot_hint,
      updatedAt,
      existing.id,
    );
  });
  const recipe = attachRecipeChildren(db, rowToRecipeBase(db.prepare('SELECT * FROM recipes WHERE id = ?').get(existing.id)));
  return { ok: true, operation: 'update-recipe', recipe, reply: `Updated ${recipe.name}.` };
}

function removeRecipe(db, args) {
  const existing = findRecipeByIdOrName(db, optionalText(args, 'id'), optionalText(args, 'name'));
  const updatedAt = nowIso();
  db.prepare('UPDATE recipes SET active = 0, updated_at = ? WHERE id = ?').run(updatedAt, existing.id);
  return { ok: true, operation: 'remove-recipe', removed: { id: existing.id, name: existing.name }, reply: `Removed ${existing.name}.` };
}

function listRecipes(db, args) {
  const type = optionalText(args, 'type');
  const activeOnly = !!args.activeOnly;
  let sql = 'SELECT * FROM recipes WHERE 1=1';
  const values = [];
  if (activeOnly) sql += ' AND active = 1';
  if (type) {
    sql += ' AND type = ?';
    values.push(type);
  }
  sql += ' ORDER BY name ASC';
  const rows = db.prepare(sql).all(...values);
  let recipes = rows.map((row) => attachRecipeChildren(db, rowToRecipeBase(row)));
  const tag = optionalText(args, 'tag');
  if (tag) recipes = recipes.filter((r) => r.tags.includes(tag));
  return { ok: true, operation: 'list-recipes', recipes };
}

function findRecipe(db, args) {
  const query = requireText(args, 'query');
  const normalized = normalizeText(query);
  const row = db.prepare(`
    SELECT r.* FROM recipes r
    LEFT JOIN recipe_aliases a ON a.recipe_id = r.id
    WHERE r.active = 1 AND (r.normalized_name = ? OR a.normalized_alias = ?)
    LIMIT 1
  `).get(normalized, normalized);
  if (!row) return { ok: true, operation: 'find-recipe', found: false, recipe: null };
  return { ok: true, operation: 'find-recipe', found: true, recipe: attachRecipeChildren(db, rowToRecipeBase(row)) };
}

function listActiveRecipesFlat(db) {
  const rows = db.prepare(`
    SELECT id, name, type, calories, protein, meal_slot_hint FROM recipes WHERE active = 1
  `).all();
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    type: r.type,
    calories: r.calories,
    protein: r.protein,
    mealSlotHint: r.meal_slot_hint,
  }));
}

// ---------------------------------------------------------------------------
// Dashboard read (live calorie/protein target + what's already been eaten)
// ---------------------------------------------------------------------------

async function fetchHealthBudget() {
  const tokenFile = process.env.MEAL_PLANNER_DASHBOARD_TOKEN_FILE || DEFAULT_TOKEN_FILE;
  let token;
  try {
    token = fs.readFileSync(tokenFile, 'utf8').trim();
  } catch (error) {
    throw workflowError('DASHBOARD_UNAVAILABLE', `Could not read dashboard token file: ${error.message}`);
  }
  if (!token) throw workflowError('DASHBOARD_UNAVAILABLE', `dashboard token file is empty: ${tokenFile}`);
  const baseUrl = (process.env.MEAL_PLANNER_DASHBOARD_URL || DEFAULT_DASHBOARD_URL).replace(/\/$/, '');
  let response;
  try {
    response = await fetch(`${baseUrl}/api/health`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
  } catch (error) {
    throw workflowError('DASHBOARD_UNAVAILABLE', `Could not reach dashboard-api: ${error.message}`);
  }
  if (!response.ok) throw workflowError('DASHBOARD_UNAVAILABLE', `dashboard API returned HTTP ${response.status} for /api/health`);
  const body = await response.json();
  return {
    calories: { current: Number(body?.calories?.current ?? 0), target: Number(body?.calories?.target ?? 0) },
    protein: { current: Number(body?.protein?.current ?? 0), target: Number(body?.protein?.target ?? 0) },
  };
}

// ---------------------------------------------------------------------------
// Daily plans / plan items
// ---------------------------------------------------------------------------

function ensureDailyPlan(db, date, calorieTarget = 0, proteinTarget = 0) {
  const existing = db.prepare('SELECT * FROM daily_plans WHERE plan_date = ?').get(date);
  if (existing) return existing;
  const id = crypto.randomUUID();
  const createdAt = nowIso();
  db.prepare(`
    INSERT INTO daily_plans (id, plan_date, status, calorie_target, protein_target, created_at, updated_at)
    VALUES (?, ?, 'draft', ?, ?, ?, ?)
  `).run(id, date, calorieTarget, proteinTarget, createdAt, createdAt);
  return db.prepare('SELECT * FROM daily_plans WHERE id = ?').get(id);
}

function rowToPlanItem(row) {
  if (!row) return null;
  return {
    id: row.id,
    slot: row.slot,
    recipeId: row.recipe_id,
    recipeName: row.recipe_name_snapshot,
    calories: row.calories,
    protein: row.protein,
    status: row.status,
    sortOrder: row.sort_order,
  };
}

function planItemsTotals(items) {
  return items.reduce(
    (acc, item) => ({ calories: acc.calories + item.calories, protein: acc.protein + item.protein }),
    { calories: 0, protein: 0 },
  );
}

async function getPlan(db, args) {
  const date = optionalText(args, 'date') || localDate();
  const planRow = db.prepare('SELECT * FROM daily_plans WHERE plan_date = ?').get(date);
  const itemRows = planRow
    ? db.prepare(`SELECT * FROM plan_items WHERE plan_id = ? AND status = 'planned' ORDER BY sort_order ASC`).all(planRow.id)
    : [];
  const items = itemRows.map(rowToPlanItem);
  const planned = planItemsTotals(items);

  let health = null;
  try {
    health = await fetchHealthBudget();
  } catch (error) {
    health = null; // degrade gracefully — dashboard-api might be unreachable
  }

  const targets = health
    ? { calories: health.calories.target, protein: health.protein.target }
    : { calories: planRow?.calorie_target ?? 0, protein: planRow?.protein_target ?? 0 };
  const alreadyEaten = health
    ? { calories: health.calories.current, protein: health.protein.current }
    : { calories: 0, protein: 0 };
  const totals = {
    calories: round1(alreadyEaten.calories + planned.calories),
    protein: round1(alreadyEaten.protein + planned.protein),
  };
  const remaining = {
    calories: round1(Math.max(0, targets.calories - totals.calories)),
    protein: round1(Math.max(0, targets.protein - totals.protein)),
  };

  return {
    ok: true,
    operation: 'get-plan',
    date,
    status: planRow ? planRow.status : 'draft',
    items,
    plannedTotals: { calories: round1(planned.calories), protein: round1(planned.protein) },
    alreadyEaten,
    totals,
    targets,
    remaining,
    healthUnavailable: health === null,
  };
}

function candidatesForSlot(allRecipes, slot) {
  const exact = allRecipes.filter((r) => r.mealSlotHint === slot);
  if (exact.length > 0) return exact;
  const any = allRecipes.filter((r) => r.mealSlotHint === 'any');
  if (any.length > 0) return any;
  return allRecipes;
}

function pickCandidate(candidates, runningCalories, calorieTarget, usedRecipeIds, lastType) {
  if (candidates.length === 0) return null;
  const withinBudget = calorieTarget > 0
    ? candidates.filter((c) => runningCalories + c.calories <= calorieTarget * CALORIE_TOLERANCE)
    : candidates;
  const pool = withinBudget.length > 0 ? withinBudget : candidates;
  const unused = pool.filter((c) => !usedRecipeIds.has(c.id));
  const finalPool = unused.length > 0 ? unused : pool;
  const sorted = [...finalPool].sort((a, b) => {
    const densityA = a.calories > 0 ? a.protein / a.calories : 0;
    const densityB = b.calories > 0 ? b.protein / b.calories : 0;
    if (densityB !== densityA) return densityB - densityA;
    if (lastType && a.type !== b.type) {
      if (a.type === lastType) return 1;
      if (b.type === lastType) return -1;
    }
    return a.name.localeCompare(b.name);
  });
  return sorted[0];
}

async function assemblePlan(db, args) {
  const date = optionalText(args, 'date') || localDate();
  const lockExisting = !!args.lockExisting;
  const budget = await fetchHealthBudget();
  const remainingCalorieBudget = Math.max(0, budget.calories.target - budget.calories.current);
  const remainingProteinBudget = Math.max(0, budget.protein.target - budget.protein.current);

  const allRecipes = listActiveRecipesFlat(db);
  const libraryEmpty = allRecipes.length === 0;

  const plan = ensureDailyPlan(db, date, budget.calories.target, budget.protein.target);

  const insufficientFlag = withTransaction(db, () => {
    let existingItems = db.prepare(`
      SELECT * FROM plan_items WHERE plan_id = ? AND status = 'planned' ORDER BY sort_order ASC
    `).all(plan.id);

    if (!lockExisting) {
      db.prepare(`UPDATE plan_items SET status = 'removed' WHERE plan_id = ? AND status = 'planned'`).run(plan.id);
      existingItems = [];
    }

    let runningCalories = existingItems.reduce((sum, item) => sum + item.calories, 0);
    let runningProtein = existingItems.reduce((sum, item) => sum + item.protein, 0);
    const usedRecipeIds = new Set(existingItems.map((item) => item.recipe_id).filter(Boolean));
    const filledSlots = new Set(existingItems.map((item) => item.slot));
    let sortOrder = existingItems.length;
    let lastType = null;
    let anySlotUnfillable = libraryEmpty;

    const insertItem = (slot, recipe) => {
      const createdAt = nowIso();
      const id = crypto.randomUUID();
      db.prepare(`
        INSERT INTO plan_items (id, plan_id, slot, recipe_id, recipe_name_snapshot, calories, protein, sort_order, status, supersedes_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'planned', NULL, ?)
      `).run(id, plan.id, slot, recipe.id, recipe.name, recipe.calories, recipe.protein, sortOrder, createdAt);
      sortOrder += 1;
      runningCalories += recipe.calories;
      runningProtein += recipe.protein;
      usedRecipeIds.add(recipe.id);
      lastType = recipe.type;
    };

    for (const slot of BASE_SLOTS) {
      if (lockExisting && filledSlots.has(slot)) continue;
      const candidates = candidatesForSlot(allRecipes, slot);
      const pick = pickCandidate(candidates, runningCalories, remainingCalorieBudget, usedRecipeIds, lastType);
      if (!pick) {
        anySlotUnfillable = true;
        continue;
      }
      insertItem(slot, pick);
    }

    for (let i = 0; i < MAX_SNACK_SLOTS; i += 1) {
      const leftCalories = remainingCalorieBudget - runningCalories;
      const leftProtein = remainingProteinBudget - runningProtein;
      if (leftCalories < SNACK_CALORIE_HEADROOM_MIN && leftProtein < SNACK_PROTEIN_HEADROOM_MIN) break;
      const candidates = candidatesForSlot(allRecipes, 'snack');
      const pick = pickCandidate(candidates, runningCalories, remainingCalorieBudget, usedRecipeIds, lastType);
      if (!pick) break;
      insertItem('snack', pick);
    }

    const proteinShortfall = remainingProteinBudget - runningProtein;
    const insufficient = anySlotUnfillable
      || (remainingProteinBudget > 0 && proteinShortfall > remainingProteinBudget * INSUFFICIENT_PROTEIN_FRACTION);
    return insufficient;
  });

  const planResult = await getPlan(db, { date });
  return {
    ...planResult,
    operation: 'assemble-plan',
    libraryInsufficient: insufficientFlag,
    reply: insufficientFlag
      ? "Planned what I can, but the taught recipes can't reach today's targets yet."
      : "Planned today's meals.",
  };
}

function addPlanItem(db, args) {
  const date = optionalText(args, 'date') || localDate();
  const slot = requireText(args, 'slot');
  if (!BASE_SLOTS.includes(slot) && slot !== 'snack') {
    throw workflowError('INVALID_ARGUMENT', `slot must be one of: breakfast, lunch, dinner, snack`);
  }
  const recipeRow = findRecipeByIdOrName(db, optionalText(args, 'recipeId'), optionalText(args, 'recipeName'));
  const calories = numberArg(args, 'calories', { optional: true, max: 10000 }) ?? recipeRow.calories;
  const protein = numberArg(args, 'protein', { optional: true, max: 1000 }) ?? recipeRow.protein;
  const createdAt = nowIso();
  return withTransaction(db, () => {
    const plan = ensureDailyPlan(db, date);
    const sortOrder = db.prepare(`SELECT COUNT(*) AS n FROM plan_items WHERE plan_id = ? AND status = 'planned'`).get(plan.id).n;
    const id = crypto.randomUUID();
    db.prepare(`
      INSERT INTO plan_items (id, plan_id, slot, recipe_id, recipe_name_snapshot, calories, protein, sort_order, status, supersedes_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'planned', NULL, ?)
    `).run(id, plan.id, slot, recipeRow.id, recipeRow.name, calories, protein, sortOrder, createdAt);
    const item = rowToPlanItem(db.prepare('SELECT * FROM plan_items WHERE id = ?').get(id));
    return { ok: true, operation: 'add-plan-item', item, reply: `Added ${recipeRow.name} to ${slot}.` };
  });
}

function swapPlanItem(db, args) {
  const itemId = requireText(args, 'itemId', 'item id');
  const old = db.prepare(`SELECT * FROM plan_items WHERE id = ? AND status = 'planned'`).get(itemId);
  if (!old) throw workflowError('NOT_FOUND', `No active plan item '${itemId}' was found`);
  const recipeRow = findRecipeByIdOrName(db, optionalText(args, 'recipeId'), optionalText(args, 'recipeName'));
  const calories = numberArg(args, 'calories', { optional: true, max: 10000 }) ?? recipeRow.calories;
  const protein = numberArg(args, 'protein', { optional: true, max: 1000 }) ?? recipeRow.protein;
  const createdAt = nowIso();
  return withTransaction(db, () => {
    db.prepare(`UPDATE plan_items SET status = 'swapped' WHERE id = ?`).run(old.id);
    const id = crypto.randomUUID();
    db.prepare(`
      INSERT INTO plan_items (id, plan_id, slot, recipe_id, recipe_name_snapshot, calories, protein, sort_order, status, supersedes_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'planned', ?, ?)
    `).run(id, old.plan_id, old.slot, recipeRow.id, recipeRow.name, calories, protein, old.sort_order, old.id, createdAt);
    const item = rowToPlanItem(db.prepare('SELECT * FROM plan_items WHERE id = ?').get(id));
    return { ok: true, operation: 'swap-plan-item', replacedItemId: old.id, item, reply: `Swapped in ${recipeRow.name}.` };
  });
}

function removePlanItem(db, args) {
  const itemId = requireText(args, 'itemId', 'item id');
  const row = db.prepare(`SELECT * FROM plan_items WHERE id = ? AND status = 'planned'`).get(itemId);
  if (!row) throw workflowError('NOT_FOUND', `No active plan item '${itemId}' was found`);
  return withTransaction(db, () => {
    db.prepare(`UPDATE plan_items SET status = 'removed' WHERE id = ?`).run(row.id);
    return { ok: true, operation: 'remove-plan-item', removedItemId: row.id, reply: 'Removed.' };
  });
}

function confirmPlan(db, args) {
  const date = optionalText(args, 'date') || localDate();
  const row = db.prepare('SELECT * FROM daily_plans WHERE plan_date = ?').get(date);
  if (!row) throw workflowError('NOT_FOUND', `No plan exists for ${date} yet`);
  const updatedAt = nowIso();
  db.prepare(`UPDATE daily_plans SET status = 'confirmed', updated_at = ? WHERE id = ?`).run(updatedAt, row.id);
  return { ok: true, operation: 'confirm-plan', date, status: 'confirmed', reply: 'Plan confirmed.' };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

async function execute(argv) {
  const { command, args } = parseArgs(argv);
  if (!command) throw workflowError('USAGE', 'A command is required');
  const db = openDatabase();
  try {
    let result;
    if (command === 'init') {
      const recipeCount = db.prepare('SELECT COUNT(*) AS n FROM recipes WHERE active = 1').get().n;
      result = { ok: true, operation: 'init', database: process.env.MEAL_PLANNER_DB || DEFAULT_DB, recipeCount };
    } else if (command === 'add-recipe') {
      result = addRecipe(db, args);
    } else if (command === 'update-recipe') {
      result = updateRecipe(db, args);
    } else if (command === 'remove-recipe') {
      result = removeRecipe(db, args);
    } else if (command === 'list-recipes') {
      result = listRecipes(db, args);
    } else if (command === 'find-recipe') {
      result = findRecipe(db, args);
    } else if (command === 'get-plan') {
      result = await getPlan(db, args);
    } else if (command === 'assemble-plan') {
      result = await assemblePlan(db, args);
    } else if (command === 'add-plan-item') {
      result = addPlanItem(db, args);
    } else if (command === 'swap-plan-item') {
      result = swapPlanItem(db, args);
    } else if (command === 'remove-plan-item') {
      result = removePlanItem(db, args);
    } else if (command === 'confirm-plan') {
      result = confirmPlan(db, args);
    } else {
      throw workflowError('USAGE', `Unknown command '${command}'`);
    }
    return result;
  } finally {
    db.close();
  }
}

if (require.main === module) {
  execute(process.argv.slice(2))
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    })
    .catch((error) => {
      process.stdout.write(`${JSON.stringify({
        ok: false,
        code: error.code || 'MEAL_PLANNER_WORKFLOW_ERROR',
        error: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      })}\n`);
      process.exitCode = 1;
    });
}

module.exports = { execute, normalizeText, localDate };
