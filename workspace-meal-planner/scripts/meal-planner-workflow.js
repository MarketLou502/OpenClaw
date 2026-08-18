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

// Strips a leading "a"/"an"/"the"/"some" so "a Protein shake" matches a
// saved recipe named "Protein shake" — confirmed 2026-08-07 as the actual
// cause of a real recipe (an exact name match otherwise) missing on a live
// voice request; not a fuzzy-matching gap, just an unstripped article. Kept
// deliberately minimal (only these four words) rather than a broader
// stopword list — "my X" phrasing is already handled by explicit aliases
// in the data (e.g. "my coffee", "my burrito") and shouldn't be collapsed
// into the base name automatically. Must stay identical to health-workflow.js's
// copy of this function — both read/write the same shared recipes table.
function normalizeText(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(new RegExp('[\\u0300-\\u036f]', 'g'), '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/^(?:a|an|the|some)\s+/, '');
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
    -- Workstream 4 (pantry management). pantry_items above was scaffolding
    -- from an earlier pass — never wired to any command — and is left in
    -- place untouched rather than dropped/migrated, since dropping a table
    -- is not something to do casually and nothing reads it. pantry_stock is
    -- the real, wired-up table: numeric quantity + unit so deduction math
    -- is possible, plus a human-readable display_quantity for CLI/kiosk output.
    CREATE TABLE IF NOT EXISTS pantry_stock (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      normalized_name TEXT NOT NULL UNIQUE,
      quantity REAL,
      unit TEXT,
      display_quantity TEXT,
      category TEXT,
      min_quantity REAL,
      min_unit TEXT,
      notes TEXT,
      location TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS pantry_stock_category ON pantry_stock(category);
    CREATE TABLE IF NOT EXISTS recipe_instructions (
      id TEXT PRIMARY KEY,
      recipe_id TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
      step_number INTEGER NOT NULL,
      instruction TEXT NOT NULL,
      UNIQUE(recipe_id, step_number)
    );
    CREATE INDEX IF NOT EXISTS recipe_instructions_recipe ON recipe_instructions(recipe_id);
    CREATE TABLE IF NOT EXISTS food_log (
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
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'voided')),
      source TEXT,
      original_wording TEXT,
      origin_channel TEXT,
      source_entry_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS food_log_date ON food_log(entry_date);
    CREATE INDEX IF NOT EXISTS food_log_recipe ON food_log(recipe_id);
    CREATE INDEX IF NOT EXISTS food_log_takeout ON food_log(is_takeout);
    CREATE INDEX IF NOT EXISTS food_log_source_entry ON food_log(source_entry_id);
    -- Workstream 5 (dashboard notifications) — free-form messages any
    -- subagent can leave for Aaron's kiosk dashboard. Lives in
    -- meal-planner.sqlite (not a shared/global db) since meal-planner is the
    -- only writer today; agent_name distinguishes the source if that changes.
    CREATE TABLE IF NOT EXISTS agent_messages (
      id TEXT PRIMARY KEY,
      agent_name TEXT NOT NULL,
      message TEXT NOT NULL,
      message_type TEXT NOT NULL DEFAULT 'info',
      priority INTEGER NOT NULL DEFAULT 0,
      category TEXT,
      action_label TEXT,
      action_payload TEXT,
      is_read INTEGER NOT NULL DEFAULT 0,
      is_dismissed INTEGER NOT NULL DEFAULT 0,
      expires_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS agent_messages_active ON agent_messages(is_read, is_dismissed, expires_at);
  `);
  migrateRecipeColumns(db);
  return db;
}

// Workstream 1 (recipe importer) schema migration — additive only, safe to
// run on every startup. node:sqlite has no "ADD COLUMN IF NOT EXISTS", so
// each column is guarded by checking pragma table_info first.
const RECIPE_NEW_COLUMNS = [
  ['prep_time_minutes', 'INTEGER'],
  ['cook_time_minutes', 'INTEGER'],
  ['source_url', 'TEXT'],
  ['image_url', 'TEXT'],
  ['cuisine', 'TEXT'],
  ['serving_size', 'INTEGER'],
];

function migrateRecipeColumns(db) {
  const existing = new Set(db.prepare('PRAGMA table_info(recipes)').all().map((c) => c.name));
  for (const [name, type] of RECIPE_NEW_COLUMNS) {
    if (!existing.has(name)) {
      db.exec(`ALTER TABLE recipes ADD COLUMN ${name} ${type}`);
    }
  }
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
  const prepTimeMinutes = row.prep_time_minutes ?? null;
  const cookTimeMinutes = row.cook_time_minutes ?? null;
  const totalTimeMinutes = prepTimeMinutes != null || cookTimeMinutes != null
    ? (prepTimeMinutes || 0) + (cookTimeMinutes || 0)
    : null;
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
    prepTimeMinutes,
    cookTimeMinutes,
    totalTimeMinutes,
    sourceUrl: row.source_url ?? null,
    imageUrl: row.image_url ?? null,
    cuisine: row.cuisine ?? null,
    servingSize: row.serving_size ?? null,
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
  const instructions = db.prepare(`
    SELECT step_number, instruction FROM recipe_instructions
    WHERE recipe_id = ? ORDER BY step_number ASC
  `).all(recipe.id).map((r) => ({ stepNumber: r.step_number, instruction: r.instruction }));
  return { ...recipe, ingredients, tags, aliases, instructions };
}

// Instructions are passed as a pipe-delimited string: "Step one|Step two|..."
function parseInstructions(raw) {
  if (!raw) return [];
  return String(raw)
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((instruction, idx) => ({ stepNumber: idx + 1, instruction }));
}

function replaceInstructions(db, recipeId, instructions) {
  db.prepare('DELETE FROM recipe_instructions WHERE recipe_id = ?').run(recipeId);
  const insert = db.prepare(`
    INSERT INTO recipe_instructions (id, recipe_id, step_number, instruction)
    VALUES (?, ?, ?, ?)
  `);
  for (const step of instructions) {
    insert.run(crypto.randomUUID(), recipeId, step.stepNumber, step.instruction);
  }
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
  const instructions = parseInstructions(optionalText(args, 'instructions'));
  const prepTimeMinutes = numberArg(args, 'prepTimeMinutes', { optional: true, max: 10000 });
  const cookTimeMinutes = numberArg(args, 'cookTimeMinutes', { optional: true, max: 10000 });
  const sourceUrl = optionalText(args, 'sourceUrl');
  const imageUrl = optionalText(args, 'imageUrl');
  const cuisine = optionalText(args, 'cuisine');
  const servingSize = numberArg(args, 'servingSize', { optional: true, max: 1000 });

  const duplicate = findDuplicateRecipe(db, normalizedName);
  if (duplicate) throw workflowError('DUPLICATE_RECIPE', `A recipe named or aliased '${duplicate.name}' already exists`);

  const createdAt = nowIso();
  const id = crypto.randomUUID();
  withTransaction(db, () => {
    db.prepare(`
      INSERT INTO recipes (
        id, name, normalized_name, type, meal_slot_hint, serving, calories, protein, notes, active,
        prep_time_minutes, cook_time_minutes, source_url, image_url, cuisine, serving_size,
        created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, name, normalizedName, type, mealSlotHint, serving, calories, protein, notes,
      prepTimeMinutes, cookTimeMinutes, sourceUrl, imageUrl, cuisine, servingSize,
      createdAt, createdAt,
    );
    const tagInsert = db.prepare('INSERT INTO recipe_tags (recipe_id, tag) VALUES (?, ?)');
    for (const tag of tags) tagInsert.run(id, tag);
    const aliasInsert = db.prepare('INSERT INTO recipe_aliases (recipe_id, alias, normalized_alias) VALUES (?, ?, ?)');
    for (const alias of aliases) aliasInsert.run(id, alias, normalizeText(alias));
    const ingredientInsert = db.prepare(`
      INSERT INTO recipe_ingredients (id, recipe_id, ingredient_name, normalized_name, quantity, sort_order)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const ing of ingredients) ingredientInsert.run(crypto.randomUUID(), id, ing.name, normalizeText(ing.name), ing.quantity, ing.sortOrder);
    if (instructions.length) replaceInstructions(db, id, instructions);
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
  const prepTimeMinutes = numberArg(args, 'prepTimeMinutes', { optional: true, max: 10000 });
  const cookTimeMinutes = numberArg(args, 'cookTimeMinutes', { optional: true, max: 10000 });
  const sourceUrl = optionalText(args, 'sourceUrl');
  const imageUrl = optionalText(args, 'imageUrl');
  const cuisine = optionalText(args, 'cuisine');
  const servingSize = numberArg(args, 'servingSize', { optional: true, max: 1000 });
  const instructionsProvided = args.instructions !== undefined;
  const instructions = instructionsProvided ? parseInstructions(optionalText(args, 'instructions')) : null;

  if (newName && newNormalizedName !== existing.normalized_name) {
    const duplicate = findDuplicateRecipe(db, newNormalizedName, existing.id);
    if (duplicate) throw workflowError('DUPLICATE_RECIPE', `A recipe named or aliased '${duplicate.name}' already exists`);
  }

  const updatedAt = nowIso();
  withTransaction(db, () => {
    db.prepare(`
      UPDATE recipes SET
        name = ?, normalized_name = ?, type = ?, serving = ?, calories = ?, protein = ?,
        notes = ?, meal_slot_hint = ?,
        prep_time_minutes = ?, cook_time_minutes = ?, source_url = ?, image_url = ?, cuisine = ?, serving_size = ?,
        updated_at = ?
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
      prepTimeMinutes ?? existing.prep_time_minutes,
      cookTimeMinutes ?? existing.cook_time_minutes,
      sourceUrl !== null ? sourceUrl : existing.source_url,
      imageUrl !== null ? imageUrl : existing.image_url,
      cuisine !== null ? cuisine : existing.cuisine,
      servingSize ?? existing.serving_size,
      updatedAt,
      existing.id,
    );
    if (instructionsProvided) replaceInstructions(db, existing.id, instructions);
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

function getRecipe(db, args) {
  const row = findRecipeByIdOrName(db, optionalText(args, 'id'), optionalText(args, 'name') || optionalText(args, 'match'));
  const recipe = attachRecipeChildren(db, rowToRecipeBase(row));
  return { ok: true, operation: 'get-recipe', recipe };
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
// Pantry management (Workstream 4) — pantry_stock is the bridge between
// recipe ingredients and the grocery list. This intentionally lifts the old
// "grocery and meal planning are fully separate systems" rule from SOUL.md;
// see SOUL.md's pantry section for the current framing.
// ---------------------------------------------------------------------------

// Recipe ingredient quantities are free-text ("2 cans", "0.25 cup", "400 g").
// This is a light best-effort parse, not a unit-conversion engine: it splits
// a leading numeric amount from a trailing unit string and nothing else.
// Ingredients whose quantity doesn't start with a number (e.g. "to taste")
// come back with amount: null and are skipped by anything that deducts.
function parseQuantity(raw) {
  if (raw === undefined || raw === null) return null;
  const str = String(raw).trim();
  if (!str) return null;
  const match = str.match(/^(-?\d+(?:\.\d+)?)\s*(.*)$/);
  if (!match) return { amount: null, unit: str || null };
  const amount = Number(match[1]);
  const unit = match[2].trim().toLowerCase() || null;
  return { amount: Number.isFinite(amount) ? amount : null, unit };
}

// Loose unit comparison for deduction safety — "cans" vs "can", "G" vs "g".
// Never converts between units (e.g. never treats "g" as compatible with
// "cup"); this only tolerates plural/case differences on the same unit.
function normalizeUnit(unit) {
  if (!unit) return null;
  const u = String(unit).toLowerCase().trim();
  return u.length > 1 && u.endsWith('s') ? u.slice(0, -1) : u;
}

// Word-level matching between an ingredient name and a pantry item name, so
// "eggs" matches "large eggs" and "chicken" matches "chicken breasts"
// without "egg" accidentally matching "eggplant" (whole words, not
// substrings). Each word is crudely singularized (same trailing-"s" trim as
// normalizeUnit) so "egg"/"eggs" line up too. A match requires the smaller
// word set to be fully contained in the larger one.
function ingredientWordSet(name) {
  return new Set(
    String(name || '')
      .split(' ')
      .filter(Boolean)
      .map((w) => (w.length > 1 && w.endsWith('s') ? w.slice(0, -1) : w))
  );
}

function wordSetsOverlapAsIngredient(a, b) {
  if (a.size === 0 || b.size === 0) return false;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const word of small) {
    if (!large.has(word)) return false;
  }
  return true;
}

// Finds the pantry_stock row that best matches a recipe ingredient's
// normalized name — exact match first (fast path, and unambiguous when
// present), then a word-level match against every pantry row. Returns the
// first word-level match found; with typically small pantries this is fine,
// and an exact match (the common case once pantry naming settles) always
// wins over it.
function findPantryMatch(db, normalizedIngredientName) {
  if (!normalizedIngredientName) return null;
  const exact = db.prepare('SELECT * FROM pantry_stock WHERE normalized_name = ?').get(normalizedIngredientName);
  if (exact) return exact;
  const ingredientWords = ingredientWordSet(normalizedIngredientName);
  if (ingredientWords.size === 0) return null;
  const rows = db.prepare('SELECT * FROM pantry_stock').all();
  for (const row of rows) {
    if (wordSetsOverlapAsIngredient(ingredientWords, ingredientWordSet(row.normalized_name))) return row;
  }
  return null;
}

function rowToPantryItem(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    normalizedName: row.normalized_name,
    quantity: row.quantity,
    unit: row.unit,
    displayQuantity: row.display_quantity,
    category: row.category,
    minQuantity: row.min_quantity,
    minUnit: row.min_unit,
    notes: row.notes,
    location: row.location,
    updatedAt: row.updated_at,
    lowStock: row.min_quantity != null && row.quantity != null && row.quantity < row.min_quantity,
  };
}

function findPantryItemByIdOrName(db, id, name) {
  let row = null;
  if (id) {
    row = db.prepare('SELECT * FROM pantry_stock WHERE id = ?').get(id);
  } else if (name) {
    row = db.prepare('SELECT * FROM pantry_stock WHERE normalized_name = ?').get(normalizeText(name));
  } else {
    throw workflowError('INVALID_ARGUMENT', 'A pantry item id or name is required');
  }
  if (!row) throw workflowError('NOT_FOUND', 'No matching pantry item was found');
  return row;
}

function addPantryItem(db, args) {
  const name = requireText(args, 'name');
  const normalizedName = normalizeText(name);
  const dup = db.prepare('SELECT id FROM pantry_stock WHERE normalized_name = ?').get(normalizedName);
  if (dup) throw workflowError('DUPLICATE_PANTRY_ITEM', `A pantry item named '${name}' already exists`);
  const quantity = numberArg(args, 'quantity', { optional: true, max: 1000000 });
  const unit = optionalText(args, 'unit');
  const displayQuantity = optionalText(args, 'displayQuantity');
  const category = optionalText(args, 'category');
  const minQuantity = numberArg(args, 'minQuantity', { optional: true, max: 1000000 });
  const minUnit = optionalText(args, 'minUnit');
  const notes = optionalText(args, 'notes');
  const location = optionalText(args, 'location');
  const id = crypto.randomUUID();
  const updatedAt = nowIso();
  db.prepare(`
    INSERT INTO pantry_stock (
      id, name, normalized_name, quantity, unit, display_quantity, category,
      min_quantity, min_unit, notes, location, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, name, normalizedName, quantity, unit, displayQuantity, category, minQuantity, minUnit, notes, location, updatedAt);
  const item = rowToPantryItem(db.prepare('SELECT * FROM pantry_stock WHERE id = ?').get(id));
  return { ok: true, operation: 'add-pantry-item', item, reply: `Added ${name} to the pantry.` };
}

function updatePantryItem(db, args) {
  const existing = findPantryItemByIdOrName(db, optionalText(args, 'id'), optionalText(args, 'name'));
  const hasDeduct = args.deduct !== undefined;
  const hasSet = args.setQuantity !== undefined;
  if (hasDeduct && hasSet) throw workflowError('INVALID_ARGUMENT', 'Use either --deduct or --set-quantity, not both');

  const unitArg = optionalText(args, 'unit');
  if (unitArg && existing.unit && normalizeUnit(unitArg) !== normalizeUnit(existing.unit)) {
    throw workflowError(
      'INVALID_ARGUMENT',
      `Unit mismatch: '${existing.name}' is tracked in '${existing.unit}', got '${unitArg}'`,
    );
  }

  let newQuantity = existing.quantity;
  if (hasDeduct) {
    const deductAmount = numberArg(args, 'deduct', { max: 1000000 });
    newQuantity = round2((existing.quantity ?? 0) - deductAmount);
  } else if (hasSet) {
    newQuantity = numberArg(args, 'setQuantity', { max: 1000000 });
  }

  const displayQuantity = args.displayQuantity !== undefined ? optionalText(args, 'displayQuantity') : existing.display_quantity;
  const category = args.category !== undefined ? optionalText(args, 'category') : existing.category;
  const minQuantity = args.minQuantity !== undefined
    ? numberArg(args, 'minQuantity', { optional: true, max: 1000000 })
    : existing.min_quantity;
  const minUnit = args.minUnit !== undefined ? optionalText(args, 'minUnit') : existing.min_unit;
  const notes = args.notes !== undefined ? optionalText(args, 'notes') : existing.notes;
  const location = args.location !== undefined ? optionalText(args, 'location') : existing.location;
  const unit = unitArg || existing.unit;
  const updatedAt = nowIso();

  db.prepare(`
    UPDATE pantry_stock SET
      quantity = ?, unit = ?, display_quantity = ?, category = ?,
      min_quantity = ?, min_unit = ?, notes = ?, location = ?, updated_at = ?
    WHERE id = ?
  `).run(newQuantity, unit, displayQuantity, category, minQuantity, minUnit, notes, location, updatedAt, existing.id);

  const item = rowToPantryItem(db.prepare('SELECT * FROM pantry_stock WHERE id = ?').get(existing.id));
  return { ok: true, operation: 'update-pantry-item', item, lowStock: item.lowStock, reply: `Updated ${item.name}.` };
}

function listPantry(db, args) {
  const category = optionalText(args, 'category');
  const lowStockOnly = !!args.lowStock;
  let sql = 'SELECT * FROM pantry_stock WHERE 1=1';
  const values = [];
  if (category) {
    sql += ' AND category = ?';
    values.push(category);
  }
  sql += ' ORDER BY name ASC';
  let items = db.prepare(sql).all(...values).map(rowToPantryItem);
  if (lowStockOnly) items = items.filter((item) => item.lowStock);
  return { ok: true, operation: 'list-pantry', items };
}

function removePantryItem(db, args) {
  const existing = findPantryItemByIdOrName(db, optionalText(args, 'id'), optionalText(args, 'name'));
  db.prepare('DELETE FROM pantry_stock WHERE id = ?').run(existing.id);
  return { ok: true, operation: 'remove-pantry-item', removed: { id: existing.id, name: existing.name }, reply: `Removed ${existing.name} from the pantry.` };
}

function findRecipesByIngredient(db, args) {
  const ingredient = requireText(args, 'ingredient');
  const normalized = normalizeText(ingredient);
  const rows = db.prepare(`
    SELECT DISTINCT r.* FROM recipes r
    JOIN recipe_ingredients ri ON ri.recipe_id = r.id
    WHERE r.active = 1 AND ri.normalized_name LIKE ?
    ORDER BY r.name ASC
  `).all(`%${normalized}%`);
  const recipes = rows.map((row) => attachRecipeChildren(db, rowToRecipeBase(row)));
  return { ok: true, operation: 'find-recipes-by-ingredient', ingredient, recipes };
}

// "What can I make right now?" — scores each active recipe by pantry
// coverage (fraction of its ingredients present in pantry_stock, ignoring
// exact quantity — this deliberately doesn't try to prove there's *enough*
// of each ingredient, just that it's stocked at all) blended with the
// Workstream 3 preference score as a tiebreaker, per the spec's
// coverage-first ranking. Recipes with no tracked ingredients are excluded
// since coverage is undefined for them; recipes below 50% coverage are
// dropped as not worth suggesting.
function suggestRecipes(db, args) {
  const limit = numberArg(args, 'limit', { optional: true, max: 50 }) ?? 5;
  const pantryRows = db.prepare('SELECT normalized_name, quantity FROM pantry_stock').all();
  const pantryWordSets = pantryRows
    .filter((r) => r.quantity === null || r.quantity > 0)
    .map((r) => ingredientWordSet(r.normalized_name));
  const hasIngredient = (normalizedName) => {
    const words = ingredientWordSet(normalizedName);
    return pantryWordSets.some((pantryWords) => wordSetsOverlapAsIngredient(words, pantryWords));
  };
  const recipes = listActiveRecipesFlat(db);
  const preferenceMap = computePreferenceScoreMap(db);
  const suggestions = [];
  for (const recipe of recipes) {
    const ingredients = db.prepare('SELECT ingredient_name, normalized_name FROM recipe_ingredients WHERE recipe_id = ?').all(recipe.id);
    if (ingredients.length === 0) continue;
    const missing = ingredients.filter((i) => !hasIngredient(i.normalized_name));
    const have = ingredients.length - missing.length;
    const coverage = have / ingredients.length;
    if (coverage < 0.5) continue;
    const preferenceScore = preferenceMap.get(recipe.id) || 0;
    const group = coverage >= 1 ? 'make now' : coverage >= 0.75 ? 'almost there' : 'need a few things';
    suggestions.push({
      recipeId: recipe.id,
      name: recipe.name,
      calories: recipe.calories,
      protein: recipe.protein,
      mealSlotHint: recipe.mealSlotHint,
      coverage: round2(coverage),
      haveCount: have,
      totalCount: ingredients.length,
      missingIngredients: missing.map((i) => i.ingredient_name),
      group,
      rank: round2(0.85 * coverage + 0.15 * preferenceScore),
    });
  }
  suggestions.sort((a, b) => b.rank - a.rank || a.name.localeCompare(b.name));
  return { ok: true, operation: 'suggest-recipes', suggestions: suggestions.slice(0, limit) };
}

// Deducts one recipe's ingredients from pantry stock (best-effort — skips
// ingredients with no parseable amount, no matching pantry item, or a unit
// that doesn't match what's tracked, rather than guessing). Returns the
// names of any pantry items that dropped below their min_quantity as a
// result, for the caller to auto-add to the grocery list.
function deductPantryForRecipe(db, recipeId) {
  const ingredients = db.prepare(`
    SELECT ingredient_name, normalized_name, quantity FROM recipe_ingredients WHERE recipe_id = ?
  `).all(recipeId);
  const deducted = [];
  const lowStock = [];
  for (const ing of ingredients) {
    if (!ing.quantity) continue;
    const parsed = parseQuantity(ing.quantity);
    if (!parsed || parsed.amount === null) continue;
    const pantryItem = findPantryMatch(db, ing.normalized_name);
    if (!pantryItem) continue;
    if (pantryItem.unit && parsed.unit && normalizeUnit(parsed.unit) !== normalizeUnit(pantryItem.unit)) continue;

    const newQuantity = round2((pantryItem.quantity ?? 0) - parsed.amount);
    db.prepare('UPDATE pantry_stock SET quantity = ?, updated_at = ? WHERE id = ?').run(newQuantity, nowIso(), pantryItem.id);
    deducted.push({ name: pantryItem.name, amount: parsed.amount, unit: parsed.unit, newQuantity });
    if (pantryItem.min_quantity !== null && newQuantity < pantryItem.min_quantity) {
      lowStock.push(pantryItem.name);
    }
  }
  return { deducted, lowStock };
}

// Best-effort call out to dashboard-api's grocery board (same HTTP pattern
// as fetchHealthBudget below). Never throws — a dashboard-api hiccup here
// must not fail plan confirmation, it should just mean nothing got
// auto-added and the caller can note that in its reply.
async function autoAddLowStockToGrocery(names) {
  if (!names.length) return [];
  const tokenFile = process.env.MEAL_PLANNER_DASHBOARD_TOKEN_FILE || DEFAULT_TOKEN_FILE;
  let token;
  try {
    token = fs.readFileSync(tokenFile, 'utf8').trim();
  } catch {
    return [];
  }
  if (!token) return [];
  const baseUrl = (process.env.MEAL_PLANNER_DASHBOARD_URL || DEFAULT_DASHBOARD_URL).replace(/\/$/, '');
  const added = [];
  for (const name of names) {
    try {
      const response = await fetch(`${baseUrl}/api/grocery`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: `${name} (low stock)` }),
        signal: AbortSignal.timeout(5000),
      });
      if (response.ok) added.push(name);
    } catch {
      // best-effort — see comment above
    }
  }
  return added;
}

// ---------------------------------------------------------------------------
// Food log (Workstream 2) — what Aaron actually ate, shared with
// health-tracker via meal-planner.sqlite's food_log table. health-workflow.js
// writes here directly (see its syncFoodLog); these commands cover the
// "Aaron tells the meal planner directly what he ate" path plus read access
// for preference analysis (Workstream 3) and the dashboard-api routes below.
// ---------------------------------------------------------------------------

const RESTAURANT_KEYWORDS = [
  'takeout', 'take-out', 'take out', 'delivery', 'delivered', 'ordered from', 'ordered',
  'restaurant', 'drive thru', 'drive-thru',
  'zaxbys', "zaxby's", 'chick-fil-a', 'chick fil a', 'mcdonald', "mcdonald's",
  'wendy', "wendy's", 'burger king', 'pizza hut', 'domino', "domino's",
  'subway', 'chipotle', 'taco bell', 'panera', 'starbucks', 'dunkin',
  'popeyes', 'kfc', 'five guys', 'shake shack', 'sonic', 'arbys', "arby's",
  'wingstop', 'panda express', 'olive garden', 'applebee', 'chili\'s',
  'uber eats', 'ubereats', 'doordash', 'grubhub', 'postmates',
  '🍕', '🍔', '🍟', '🌮', '🍗',
];

function isRestaurantFood(text) {
  const value = String(text || '').toLowerCase();
  if (!value) return false;
  return RESTAURANT_KEYWORDS.some((keyword) => value.includes(keyword));
}

function rowToFoodLogEntry(row) {
  if (!row) return null;
  return {
    id: row.id,
    date: row.entry_date,
    time: row.entry_time,
    mealSlot: row.meal_slot,
    recipeId: row.recipe_id,
    recipeName: row.recipe_name,
    calories: row.calories,
    protein: row.protein,
    isTakeout: !!row.is_takeout,
    isFromLibrary: !!row.is_from_library,
    status: row.status,
    source: row.source,
    originalWording: row.original_wording,
    originChannel: row.origin_channel,
    sourceEntryId: row.source_entry_id,
    createdAt: row.created_at,
  };
}

function logFoodEntry(db, args) {
  const name = requireText(args, 'name');
  const calories = numberArg(args, 'calories', { max: 10000 });
  const protein = numberArg(args, 'protein', { max: 1000 });
  const createdAt = nowIso();
  const date = optionalText(args, 'date') || localDate(createdAt);
  const entryTime = optionalText(args, 'entryTime') || createdAt;
  const mealSlot = optionalText(args, 'mealSlot');
  if (mealSlot && !MEAL_SLOTS.has(mealSlot) && mealSlot !== 'any') {
    throw workflowError('INVALID_ARGUMENT', `meal slot must be one of: ${[...MEAL_SLOTS].join(', ')}`);
  }
  const originalWording = optionalText(args, 'original');

  let recipeMatch = null;
  const recipeId = optionalText(args, 'recipeId');
  if (recipeId) {
    recipeMatch = db.prepare('SELECT id, name FROM recipes WHERE id = ? AND active = 1').get(recipeId) || null;
  } else {
    const normalized = normalizeText(name);
    recipeMatch = db.prepare(`
      SELECT r.id, r.name FROM recipes r
      LEFT JOIN recipe_aliases a ON a.recipe_id = r.id
      WHERE r.active = 1 AND (r.normalized_name = ? OR a.normalized_alias = ?)
      LIMIT 1
    `).get(normalized, normalized) || null;
  }

  const isFromLibrary = recipeMatch ? 1 : 0;
  const explicitTakeout = args.takeout !== undefined ? !!args.takeout : null;
  const isTakeout = explicitTakeout !== null
    ? (explicitTakeout ? 1 : 0)
    : (!recipeMatch && isRestaurantFood(originalWording || name) ? 1 : 0);

  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO food_log (
      id, entry_date, entry_time, meal_slot, recipe_id, recipe_name, calories, protein,
      is_takeout, is_from_library, status, source, original_wording, origin_channel,
      source_entry_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 'manual', ?, ?, NULL, ?)
  `).run(
    id, date, entryTime, mealSlot || null,
    recipeMatch ? recipeMatch.id : null,
    recipeMatch ? recipeMatch.name : name,
    calories, protein, isTakeout, isFromLibrary,
    originalWording, optionalText(args, 'originChannel'), createdAt,
  );
  const entry = rowToFoodLogEntry(db.prepare('SELECT * FROM food_log WHERE id = ?').get(id));
  return { ok: true, operation: 'log-food-entry', entry, reply: `Logged ${entry.recipeName}.` };
}

function getFoodLog(db, args) {
  const date = optionalText(args, 'date');
  const limit = Math.min(numberArg(args, 'limit', { optional: true, max: 1000 }) ?? 30, 1000);
  let sql = `SELECT * FROM food_log WHERE status = 'active'`;
  const values = [];
  if (date) {
    sql += ' AND entry_date = ?';
    values.push(date);
  }
  sql += ' ORDER BY entry_date DESC, created_at DESC LIMIT ?';
  values.push(limit);
  const rows = db.prepare(sql).all(...values);
  return { ok: true, operation: 'get-food-log', date: date || null, entries: rows.map(rowToFoodLogEntry) };
}

function getFoodStats(db, args) {
  const days = Math.min(numberArg(args, 'days', { optional: true, max: 365 }) ?? 30, 365);
  const sinceDate = localDate(new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString());
  const rows = db.prepare(`
    SELECT * FROM food_log WHERE status = 'active' AND entry_date >= ? ORDER BY entry_date ASC
  `).all(sinceDate);

  const totalEntries = rows.length;
  const takeoutEntries = rows.filter((r) => r.is_takeout).length;
  const homemadeEntries = rows.filter((r) => !r.is_takeout).length;
  const libraryEntries = rows.filter((r) => r.is_from_library).length;

  const byName = new Map();
  const takeoutCaloriesByDate = new Map();
  const daySet = new Set();
  for (const row of rows) {
    daySet.add(row.entry_date);
    const key = row.recipe_name.trim().toLowerCase();
    byName.set(key, {
      name: row.recipe_name,
      count: (byName.get(key)?.count || 0) + 1,
    });
    if (row.is_takeout) {
      takeoutCaloriesByDate.set(row.entry_date, (takeoutCaloriesByDate.get(row.entry_date) || 0) + row.calories);
    }
  }
  const mostFrequent = [...byName.values()].sort((a, b) => b.count - a.count).slice(0, 10);
  const distinctDays = Math.max(daySet.size, 1);
  const takeoutCalorieTotal = [...takeoutCaloriesByDate.values()].reduce((sum, v) => sum + v, 0);

  return {
    ok: true,
    operation: 'get-food-stats',
    days,
    since: sinceDate,
    totalEntries,
    homemadeEntries,
    takeoutEntries,
    libraryEntries,
    takeoutFraction: totalEntries > 0 ? round1(takeoutEntries / totalEntries) : 0,
    mostFrequentFoods: mostFrequent,
    averageDailyTakeoutCalories: round1(takeoutCalorieTotal / distinctDays),
  };
}

// ---------------------------------------------------------------------------
// Preference analysis (Workstream 3) — turns food_log history into a
// preference profile. Shared by the standalone analyze-preferences.js
// script (which persists it to memory/) and by assemble-plan's --prefer
// flag (which uses computePreferenceScoreMap for in-process ranking).
// See workspace-meal-planner/plans/03-preference-analysis.md for the spec.
// ---------------------------------------------------------------------------

const RECENCY_WITHIN_7_DAYS = 1.0;
const RECENCY_WITHIN_14_DAYS = 0.7;
const RECENCY_OLDER = 0.5;
const LIBRARY_BONUS = 1.2;
const NON_LIBRARY_BONUS = 1.0;
const NUDGE_MIN_DAYS_SINCE = 10;
const NUDGE_LOOKBACK_DAYS = 60;
const NUDGE_MIN_HISTORICAL_COUNT = 2;
const TREND_DELTA_THRESHOLD = 0.05;

function round2(value) {
  return Math.round(Number(value) * 100) / 100;
}

function capitalize(value) {
  const s = String(value || '');
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

function daysBetween(fromDate, toDate) {
  const from = new Date(`${fromDate}T00:00:00Z`);
  const to = new Date(`${toDate}T00:00:00Z`);
  return Math.round((to.getTime() - from.getTime()) / 86400000);
}

function recencyMultiplier(daysAgo) {
  if (daysAgo <= 7) return RECENCY_WITHIN_7_DAYS;
  if (daysAgo <= 14) return RECENCY_WITHIN_14_DAYS;
  return RECENCY_OLDER;
}

function activeFoodLogRows(db, sinceDate) {
  return db.prepare(`
    SELECT * FROM food_log WHERE status = 'active' AND entry_date >= ? ORDER BY entry_date ASC
  `).all(sinceDate);
}

// Groups food_log rows by recipe (recipe_id when known, else normalized
// name — covers takeout/ad-hoc entries with no library match) and computes
// the frequency x recency x library-bonus preference score.
function computeRecipeGroups(rows, today) {
  const groups = new Map();
  for (const row of rows) {
    const key = row.recipe_id || `name:${normalizeText(row.recipe_name)}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        recipeId: row.recipe_id || null,
        name: row.recipe_name,
        count: 0,
        calorieSum: 0,
        lastEaten: row.entry_date,
        libraryHits: 0,
      };
      groups.set(key, group);
    }
    group.count += 1;
    group.calorieSum += row.calories;
    if (row.entry_date > group.lastEaten) group.lastEaten = row.entry_date;
    if (row.is_from_library) group.libraryHits += 1;
  }
  for (const group of groups.values()) {
    group.isFromLibrary = group.libraryHits >= group.count / 2;
    group.daysAgo = daysBetween(group.lastEaten, today);
    group.avgCalories = round1(group.calorieSum / group.count);
    const bonus = group.isFromLibrary ? LIBRARY_BONUS : NON_LIBRARY_BONUS;
    group.score = round2(group.count * recencyMultiplier(group.daysAgo) * bonus);
  }
  return groups;
}

// Ratio-based trend used for the overall takeout ratio: compares the
// fraction of takeout entries in the last 7 days against the 7 days before.
function computeRatioTrend(recentRows, priorRows) {
  const recentRatio = recentRows.length ? recentRows.filter((r) => r.is_takeout).length / recentRows.length : null;
  const priorRatio = priorRows.length ? priorRows.filter((r) => r.is_takeout).length / priorRows.length : null;
  if (recentRatio === null || priorRatio === null) return 'stable';
  const delta = recentRatio - priorRatio;
  if (delta <= -TREND_DELTA_THRESHOLD) return 'declining';
  if (delta >= TREND_DELTA_THRESHOLD) return 'increasing';
  return 'stable';
}

// Count-based trend used per-restaurant, where every row is already
// takeout=1 so a ratio comparison is meaningless — compare raw counts.
function computeCountTrend(recentCount, priorCount) {
  if (recentCount === priorCount) return 'stable';
  return recentCount > priorCount ? 'increasing' : 'declining';
}

function computePreferenceProfile(db, options = {}) {
  const days = Math.min(Math.max(Number(options.days) || 30, 1), 365);
  const today = localDate();
  const sinceDate = localDate(new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString());
  const rows = activeFoodLogRows(db, sinceDate);

  const totalEntries = rows.length;
  const takeoutEntries = rows.filter((r) => r.is_takeout).length;
  const libraryEntries = rows.filter((r) => r.is_from_library).length;
  const takeoutRatio = totalEntries > 0 ? round2(takeoutEntries / totalEntries) : 0;
  const libraryRatio = totalEntries > 0 ? round2(libraryEntries / totalEntries) : 0;

  const last7Since = localDate(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString());
  const prev7Since = localDate(new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString());
  const last7Rows = rows.filter((r) => r.entry_date >= last7Since);
  const prev7Rows = rows.filter((r) => r.entry_date >= prev7Since && r.entry_date < last7Since);
  const takeoutTrend = computeRatioTrend(last7Rows, prev7Rows);

  const groups = computeRecipeGroups(rows, today);
  const topRecipes = [...groups.values()]
    .sort((a, b) => b.count - a.count || b.score - a.score)
    .slice(0, 10)
    .map((g) => ({
      recipeId: g.recipeId,
      name: g.name,
      count: g.count,
      avgCalories: g.avgCalories,
      lastEaten: g.lastEaten,
    }));

  const takeoutRows = rows.filter((r) => r.is_takeout);
  const takeoutGroups = new Map();
  for (const row of takeoutRows) {
    const key = normalizeText(row.recipe_name);
    let group = takeoutGroups.get(key);
    if (!group) {
      group = { name: row.recipe_name, count: 0, entries: [] };
      takeoutGroups.set(key, group);
    }
    group.count += 1;
    group.entries.push(row);
  }
  const topTakeout = [...takeoutGroups.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 10)
    .map((g) => ({
      name: g.name,
      count: g.count,
      trend: computeCountTrend(
        g.entries.filter((r) => r.entry_date >= last7Since).length,
        g.entries.filter((r) => r.entry_date >= prev7Since && r.entry_date < last7Since).length,
      ),
    }));

  const SLOT_NAMES = ['breakfast', 'lunch', 'dinner', 'snack'];
  const mealSlotDistribution = {};
  const avgCaloriesBySlot = {};
  for (const slot of SLOT_NAMES) {
    const slotRows = rows.filter((r) => r.meal_slot === slot);
    const slotLibrary = slotRows.filter((r) => r.is_from_library);
    const slotTakeout = slotRows.filter((r) => r.is_takeout);
    mealSlotDistribution[slot] = {
      count: slotRows.length,
      libraryPercent: slotRows.length ? round2(slotLibrary.length / slotRows.length) : 0,
      takeoutPercent: slotRows.length ? round2(slotTakeout.length / slotRows.length) : 0,
    };
    avgCaloriesBySlot[slot] = {
      avg: slotRows.length ? round1(slotRows.reduce((s, r) => s + r.calories, 0) / slotRows.length) : 0,
      fromLibrary: slotLibrary.length ? round1(slotLibrary.reduce((s, r) => s + r.calories, 0) / slotLibrary.length) : 0,
      fromTakeout: slotTakeout.length ? round1(slotTakeout.reduce((s, r) => s + r.calories, 0) / slotTakeout.length) : 0,
    };
  }

  // Nudge candidates: active library recipes with real historical usage
  // (>= NUDGE_MIN_HISTORICAL_COUNT hits within NUDGE_LOOKBACK_DAYS) that
  // haven't been eaten in >= NUDGE_MIN_DAYS_SINCE days. Uses its own lookback
  // window (independent of --days) so a recipe doesn't lose nudge eligibility
  // just because the requested period is short.
  const lookbackSince = localDate(new Date(Date.now() - NUDGE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString());
  const lookbackRows = days >= NUDGE_LOOKBACK_DAYS ? rows : activeFoodLogRows(db, lookbackSince);
  const lookbackGroups = computeRecipeGroups(lookbackRows, today);
  const activeRecipes = db.prepare('SELECT * FROM recipes WHERE active = 1').all();
  const nudgeCandidates = [];
  for (const recipe of activeRecipes) {
    const group = lookbackGroups.get(recipe.id);
    if (!group || group.count < NUDGE_MIN_HISTORICAL_COUNT) continue;
    if (group.daysAgo < NUDGE_MIN_DAYS_SINCE) continue;
    const reason = group.count >= 5
      ? `Favorite recipe, not used in ${group.daysAgo} days`
      : `${recipe.meal_slot_hint === 'any' ? 'Quick' : capitalize(recipe.meal_slot_hint)} option, not used in ${group.daysAgo} days`;
    nudgeCandidates.push({ recipeName: recipe.name, lastEatenAgo: group.daysAgo, reason });
  }
  nudgeCandidates.sort((a, b) => b.lastEatenAgo - a.lastEatenAgo);

  const daySet = new Set(rows.map((r) => r.entry_date));
  const distinctDays = Math.max(daySet.size, 1);
  const totalCalories = rows.reduce((sum, r) => sum + r.calories, 0);
  const totalProtein = rows.reduce((sum, r) => sum + r.protein, 0);

  return {
    analyzedAt: nowIso(),
    periodDays: days,
    totalEntries,
    takeoutRatio,
    takeoutTrend,
    libraryRatio,
    preferences: {
      topRecipes,
      topTakeout,
      mealSlotDistribution,
      nudgeCandidates,
      nutritionalPattern: {
        avgDailyCalories: round1(totalCalories / distinctDays),
        avgDailyProtein: round1(totalProtein / distinctDays),
        avgCaloriesBySlot,
      },
    },
  };
}

// Normalized (0..1) preference score per recipeId, used by assemble-plan's
// --prefer flag. Normalizes against the max raw score among candidates so it
// blends sensibly with protein density (also roughly 0..1) in pickCandidate.
function computePreferenceScoreMap(db, days = 30) {
  const today = localDate();
  const sinceDate = localDate(new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString());
  const rows = activeFoodLogRows(db, sinceDate);
  const groups = computeRecipeGroups(rows, today);
  const maxScore = Math.max(0, ...[...groups.values()].map((g) => g.score));
  const map = new Map();
  for (const group of groups.values()) {
    if (!group.recipeId) continue;
    map.set(group.recipeId, maxScore > 0 ? group.score / maxScore : 0);
  }
  return map;
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

function pickCandidate(candidates, runningCalories, calorieTarget, usedRecipeIds, lastType, options = {}) {
  if (candidates.length === 0) return null;
  const withinBudget = calorieTarget > 0
    ? candidates.filter((c) => runningCalories + c.calories <= calorieTarget * CALORIE_TOLERANCE)
    : candidates;
  const pool = withinBudget.length > 0 ? withinBudget : candidates;
  const unused = pool.filter((c) => !usedRecipeIds.has(c.id));
  const finalPool = unused.length > 0 ? unused : pool;
  const preferenceMap = options.preferenceMap || null;
  const rank = (recipe) => {
    const density = recipe.calories > 0 ? recipe.protein / recipe.calories : 0;
    if (!preferenceMap) return density;
    // Workstream 3 (--prefer): blend normalized preference score with
    // protein density instead of ranking on density alone.
    const preferenceScore = preferenceMap.get(recipe.id) || 0;
    return 0.4 * preferenceScore + 0.6 * density;
  };
  const sorted = [...finalPool].sort((a, b) => {
    const rankB = rank(b);
    const rankA = rank(a);
    if (rankB !== rankA) return rankB - rankA;
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
  const prefer = !!args.prefer;
  const budget = await fetchHealthBudget();
  const remainingCalorieBudget = Math.max(0, budget.calories.target - budget.calories.current);
  const remainingProteinBudget = Math.max(0, budget.protein.target - budget.protein.current);

  const allRecipes = listActiveRecipesFlat(db);
  const libraryEmpty = allRecipes.length === 0;
  // Workstream 3: --prefer biases candidate selection toward recipes Aaron
  // actually reaches for, per the food_log-derived preference profile.
  const preferenceMap = prefer ? computePreferenceScoreMap(db) : null;
  const pickOptions = { preferenceMap };

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
      const pick = pickCandidate(candidates, runningCalories, remainingCalorieBudget, usedRecipeIds, lastType, pickOptions);
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
      const pick = pickCandidate(candidates, runningCalories, remainingCalorieBudget, usedRecipeIds, lastType, pickOptions);
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

async function confirmPlan(db, args) {
  const date = optionalText(args, 'date') || localDate();
  const row = db.prepare('SELECT * FROM daily_plans WHERE plan_date = ?').get(date);
  if (!row) throw workflowError('NOT_FOUND', `No plan exists for ${date} yet`);
  const wasAlreadyConfirmed = row.status === 'confirmed';
  const updatedAt = nowIso();
  db.prepare(`UPDATE daily_plans SET status = 'confirmed', updated_at = ? WHERE id = ?`).run(updatedAt, row.id);

  // Workstream 4: deduct pantry stock for the confirmed plan's recipes, and
  // auto-add anything that drops below its threshold to the grocery list.
  // Gated on wasAlreadyConfirmed so re-confirming an already-confirmed plan
  // (a no-op status-wise) doesn't double-deduct.
  let pantryNote = '';
  if (!wasAlreadyConfirmed) {
    const items = db.prepare(`
      SELECT * FROM plan_items WHERE plan_id = ? AND status = 'planned' AND recipe_id IS NOT NULL
    `).all(row.id);
    const lowStockNames = new Set();
    for (const item of items) {
      const { lowStock } = deductPantryForRecipe(db, item.recipe_id);
      lowStock.forEach((name) => lowStockNames.add(name));
    }
    if (lowStockNames.size) {
      const added = await autoAddLowStockToGrocery([...lowStockNames]);
      if (added.length) pantryNote = ` Auto-added to grocery (low stock): ${added.join(', ')}.`;
    }
  }

  return { ok: true, operation: 'confirm-plan', date, status: 'confirmed', reply: `Plan confirmed.${pantryNote}` };
}

// ---------------------------------------------------------------------------
// Agent messages (Workstream 5) — dashboard notification area
// ---------------------------------------------------------------------------

const MESSAGE_TYPES = new Set(['info', 'suggestion', 'reminder', 'achievement']);

function rowToAgentMessage(row) {
  if (!row) return null;
  return {
    id: row.id,
    agentName: row.agent_name,
    message: row.message,
    messageType: row.message_type,
    priority: row.priority,
    category: row.category,
    actionLabel: row.action_label,
    actionPayload: row.action_payload ? JSON.parse(row.action_payload) : null,
    isRead: !!row.is_read,
    isDismissed: !!row.is_dismissed,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

function listMessages(db, args) {
  const limit = numberArg(args, 'limit', { optional: true, max: 200 }) ?? 5;
  const unreadOnly = !!args.unread;
  let sql = `
    SELECT * FROM agent_messages
    WHERE is_dismissed = 0
    AND (expires_at IS NULL OR expires_at > ?)
  `;
  const values = [nowIso()];
  if (unreadOnly) sql += ' AND is_read = 0';
  sql += ' ORDER BY priority DESC, created_at DESC LIMIT ?';
  values.push(limit);
  const rows = db.prepare(sql).all(...values);
  return { ok: true, operation: 'list-messages', messages: rows.map(rowToAgentMessage) };
}

function postMessage(db, args) {
  const agentName = requireText(args, 'agentName', 'agent name');
  const message = requireText(args, 'message');
  const messageType = optionalText(args, 'messageType') || 'info';
  if (!MESSAGE_TYPES.has(messageType)) {
    throw workflowError('INVALID_ARGUMENT', `messageType must be one of: ${[...MESSAGE_TYPES].join(', ')}`);
  }
  const priority = numberArg(args, 'priority', { optional: true, min: 0, max: 10 }) ?? 0;
  const category = optionalText(args, 'category');
  const actionLabel = optionalText(args, 'actionLabel');
  // Accept either a pre-serialized JSON string (from the CLI/HTTP route) or a
  // plain object (when called in-process from generateMessages below).
  let actionPayload = null;
  if (args.actionPayload && typeof args.actionPayload === 'object') {
    actionPayload = JSON.stringify(args.actionPayload);
  } else {
    const actionPayloadRaw = optionalText(args, 'actionPayload');
    if (actionPayloadRaw) actionPayload = actionPayloadRaw;
  }
  const expiresAt = optionalText(args, 'expiresAt');
  const id = crypto.randomUUID();
  const createdAt = nowIso();
  db.prepare(`
    INSERT INTO agent_messages (
      id, agent_name, message, message_type, priority, category,
      action_label, action_payload, is_read, is_dismissed, expires_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)
  `).run(id, agentName, message, messageType, priority, category, actionLabel, actionPayload, expiresAt, createdAt);
  const row = db.prepare('SELECT * FROM agent_messages WHERE id = ?').get(id);
  return { ok: true, operation: 'post-message', message: rowToAgentMessage(row) };
}

function updateMessage(db, args) {
  const id = requireText(args, 'id');
  const existing = db.prepare('SELECT * FROM agent_messages WHERE id = ?').get(id);
  if (!existing) throw workflowError('NOT_FOUND', `No message found with id '${id}'`);
  const isRead = args.markRead !== undefined ? (args.markRead === false || args.markRead === 'false' ? 0 : 1) : existing.is_read;
  const isDismissed = args.markDismissed !== undefined ? (args.markDismissed === false || args.markDismissed === 'false' ? 0 : 1) : existing.is_dismissed;
  db.prepare('UPDATE agent_messages SET is_read = ?, is_dismissed = ? WHERE id = ?').run(isRead, isDismissed, id);
  const row = db.prepare('SELECT * FROM agent_messages WHERE id = ?').get(id);
  return { ok: true, operation: 'update-message', message: rowToAgentMessage(row) };
}

// Best-effort HTTP post to dashboard-api's own POST /api/meal-planner/messages
// so a real-time SSE broadcast fires — same loopback pattern as
// autoAddLowStockToGrocery above. Returns true if it made it over HTTP (in
// which case the caller must NOT also insert directly, to avoid a duplicate
// row: the route handler on the other end inserts via this same script).
async function postMessageToDashboard(payload) {
  const tokenFile = process.env.MEAL_PLANNER_DASHBOARD_TOKEN_FILE || DEFAULT_TOKEN_FILE;
  let token;
  try {
    token = fs.readFileSync(tokenFile, 'utf8').trim();
  } catch {
    return false;
  }
  if (!token) return false;
  const baseUrl = (process.env.MEAL_PLANNER_DASHBOARD_URL || DEFAULT_DASHBOARD_URL).replace(/\/$/, '');
  try {
    const response = await fetch(`${baseUrl}/api/meal-planner/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

// Avoids re-posting the same nudge/alert every time generate-messages runs
// (e.g. from a cron job) by checking for an existing active, undismissed
// message in the same category within the lookback window.
function hasRecentMessage(db, category, sinceIso) {
  const row = db.prepare(`
    SELECT id FROM agent_messages
    WHERE category = ? AND is_dismissed = 0 AND created_at >= ?
    LIMIT 1
  `).get(category, sinceIso);
  return !!row;
}

// Builds up to a handful of candidate dashboard messages from current state
// (remaining budget, preference profile, pantry) and posts each one — over
// HTTP to dashboard-api when reachable (for the SSE broadcast), falling back
// to a direct DB insert otherwise so this still works standalone/offline.
async function generateMessages(db, args) {
  const dedupeSinceIso = new Date(Date.now() - 20 * 60 * 60 * 1000).toISOString(); // ~20h dedupe window
  const candidates = [];

  // 1. Budget suggestion — a recipe that would use up most of the remaining
  // calorie budget for today, if there's meaningful headroom left.
  let plan = null;
  try {
    plan = await getPlan(db, {});
  } catch {
    plan = null;
  }
  if (plan && plan.remaining.calories > 200 && !hasRecentMessage(db, 'meal-suggestion', dedupeSinceIso)) {
    const recipes = listActiveRecipesFlat(db);
    const fits = recipes
      .filter((r) => r.calories > 0 && r.calories <= plan.remaining.calories * CALORIE_TOLERANCE)
      .sort((a, b) => b.calories - a.calories || b.protein - a.protein);
    const pick = fits[0];
    if (pick) {
      candidates.push({
        message: `You have ${Math.round(plan.remaining.calories)} calories to go today. ${pick.name} (${Math.round(pick.calories)} cal, ${Math.round(pick.protein)}g protein) would fit nicely.`,
        messageType: 'suggestion',
        priority: 1,
        category: 'meal-suggestion',
        actionLabel: 'Plan it',
        actionPayload: { recipeId: pick.id, recipeName: pick.name },
      });
    }
  }

  // 2. Preference nudge — a favorite recipe that hasn't been eaten in a while
  // (Workstream 3's nudgeCandidates already applies the recency/frequency
  // thresholds, so this just takes the top one).
  if (!hasRecentMessage(db, 'preference-nudge', dedupeSinceIso)) {
    let profile = null;
    try {
      profile = computePreferenceProfile(db, { days: 30 });
    } catch {
      profile = null;
    }
    const nudge = profile?.preferences?.nudgeCandidates?.[0];
    if (nudge) {
      candidates.push({
        message: `You haven't had ${nudge.recipeName} in ${nudge.lastEatenAgo} days — want it again soon?`,
        messageType: 'suggestion',
        priority: 0,
        category: 'preference-nudge',
        actionLabel: 'Plan it',
        actionPayload: { recipeName: nudge.recipeName },
      });
    }
  }

  // 3. Pantry alert — a low-stock ingredient that's still usable in a recipe
  // right now, worth using up before it's gone (Workstream 4).
  if (!hasRecentMessage(db, 'stock-alert', dedupeSinceIso)) {
    const lowStock = listPantry(db, { lowStock: true }).items;
    for (const item of lowStock) {
      const matches = findRecipesByIngredient(db, { ingredient: item.name }).recipes;
      if (matches.length) {
        candidates.push({
          message: `You're low on ${item.name} — I've got ${matches[0].name} in your recipes if you want to use it up.`,
          messageType: 'reminder',
          priority: 1,
          category: 'stock-alert',
          actionLabel: 'Plan it',
          actionPayload: { recipeId: matches[0].id, recipeName: matches[0].name },
        });
        break;
      }
    }
  }

  // 4. Achievement — positive reinforcement when the takeout ratio is
  // trending down week-over-week.
  if (!hasRecentMessage(db, 'takeout-trend', dedupeSinceIso)) {
    let profile = null;
    try {
      profile = computePreferenceProfile(db, { days: 14 });
    } catch {
      profile = null;
    }
    if (profile && profile.takeoutTrend === 'declining') {
      candidates.push({
        message: `Nice work — your takeout ratio is trending down this week. Keep it up!`,
        messageType: 'achievement',
        priority: 0,
        category: 'takeout-trend',
      });
    }
  }

  const posted = [];
  for (const candidate of candidates) {
    const payload = {
      agentName: 'meal-planner',
      message: candidate.message,
      messageType: candidate.messageType,
      priority: candidate.priority,
      category: candidate.category,
      ...(candidate.actionLabel ? { actionLabel: candidate.actionLabel } : {}),
      ...(candidate.actionPayload ? { actionPayload: candidate.actionPayload } : {}),
    };
    const delivered = await postMessageToDashboard(payload);
    if (delivered) {
      posted.push({ ...candidate, delivery: 'api' });
    } else {
      const result = postMessage(db, {
        agentName: payload.agentName,
        message: payload.message,
        messageType: payload.messageType,
        priority: payload.priority,
        category: payload.category,
        actionLabel: payload.actionLabel,
        actionPayload: payload.actionPayload,
      });
      posted.push({ ...candidate, delivery: 'direct', id: result.message.id });
    }
  }

  return { ok: true, operation: 'generate-messages', generated: posted.length, messages: posted };
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
    } else if (command === 'get-recipe') {
      result = getRecipe(db, args);
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
      result = await confirmPlan(db, args);
    } else if (command === 'add-pantry-item') {
      result = addPantryItem(db, args);
    } else if (command === 'update-pantry-item') {
      result = updatePantryItem(db, args);
    } else if (command === 'list-pantry') {
      result = listPantry(db, args);
    } else if (command === 'remove-pantry-item') {
      result = removePantryItem(db, args);
    } else if (command === 'find-recipes-by-ingredient') {
      result = findRecipesByIngredient(db, args);
    } else if (command === 'suggest-recipes') {
      result = suggestRecipes(db, args);
    } else if (command === 'log-food-entry') {
      result = logFoodEntry(db, args);
    } else if (command === 'get-food-log') {
      result = getFoodLog(db, args);
    } else if (command === 'get-food-stats') {
      result = getFoodStats(db, args);
    } else if (command === 'analyze-preferences') {
      const days = numberArg(args, 'days', { optional: true, max: 365 }) ?? 30;
      result = { ok: true, operation: 'analyze-preferences', ...computePreferenceProfile(db, { days }) };
    } else if (command === 'list-messages') {
      result = listMessages(db, args);
    } else if (command === 'post-message') {
      result = postMessage(db, args);
    } else if (command === 'update-message') {
      result = updateMessage(db, args);
    } else if (command === 'generate-messages') {
      result = await generateMessages(db, args);
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

module.exports = {
  execute,
  normalizeText,
  localDate,
  openDatabase,
  computePreferenceProfile,
  computePreferenceScoreMap,
};
