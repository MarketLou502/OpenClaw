#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DEFAULT_OUTPUT = path.join(__dirname, '..', 'data', 'nutrition.db');
const DATASET_NAMES = new Set(['foundation', 'fndds', 'sr_legacy']);

function parseArgs(argv) {
  const result = { sources: [], output: DEFAULT_OUTPUT };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--source') {
      const value = argv[++i];
      if (!value || !value.includes('=')) throw new Error('--source must use dataset=/absolute/path.json');
      const split = value.indexOf('=');
      const dataset = value.slice(0, split);
      const file = value.slice(split + 1);
      if (!DATASET_NAMES.has(dataset)) throw new Error(`unsupported dataset '${dataset}'`);
      result.sources.push({ dataset, file: path.resolve(file) });
    } else if (token === '--output') {
      result.output = path.resolve(argv[++i]);
    } else {
      throw new Error(`unknown argument '${token}'`);
    }
  }
  if (result.sources.length === 0) throw new Error('at least one --source is required');
  return result;
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function nutrientAmount(food, nutrientId) {
  const item = (food.foodNutrients || []).find((entry) => entry?.nutrient?.id === nutrientId);
  const amount = Number(item?.amount);
  return Number.isFinite(amount) ? amount : null;
}

function calorieAmount(food) {
  // USDA Foundation Foods increasingly publishes calculated kcal as Atwater
  // specific/general nutrients instead of legacy nutrient 1008.
  return nutrientAmount(food, 1008)
    ?? nutrientAmount(food, 2048)
    ?? nutrientAmount(food, 2047);
}

function portionDescription(portion) {
  if (portion.portionDescription) return String(portion.portionDescription).trim();
  const amount = Number(portion.amount ?? portion.value);
  const unit = portion.measureUnit?.abbreviation || portion.measureUnit?.name || '';
  const modifier = portion.modifier && portion.modifier !== 'undetermined' ? portion.modifier : '';
  return [Number.isFinite(amount) ? amount : '', unit, modifier]
    .filter((value) => value !== '')
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim() || 'portion';
}

function categoryName(food) {
  return food.foodCategory?.description
    || food.wweiaFoodCategory?.wweiaFoodCategoryDescription
    || food.wweiaFoodCategory?.description
    || null;
}

function topLevelFoods(parsed) {
  for (const value of Object.values(parsed)) {
    if (Array.isArray(value)) return value;
  }
  throw new Error('USDA JSON did not contain a top-level food array');
}

function createSchema(db) {
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = OFF;
    PRAGMA synchronous = OFF;
    PRAGMA temp_store = MEMORY;
    CREATE TABLE metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE foods (
      fdc_id INTEGER PRIMARY KEY,
      dataset TEXT NOT NULL,
      description TEXT NOT NULL,
      normalized_description TEXT NOT NULL,
      category TEXT,
      publication_date TEXT,
      calories_per_100g REAL NOT NULL,
      protein_per_100g REAL NOT NULL
    );
    CREATE TABLE portions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fdc_id INTEGER NOT NULL REFERENCES foods(fdc_id) ON DELETE CASCADE,
      description TEXT NOT NULL,
      gram_weight REAL NOT NULL,
      calories REAL NOT NULL,
      protein REAL NOT NULL
    );
    CREATE INDEX portions_fdc_id ON portions(fdc_id);
    CREATE VIRTUAL TABLE foods_fts USING fts5(
      description,
      normalized_description,
      dataset UNINDEXED,
      content='foods',
      content_rowid='fdc_id',
      tokenize='unicode61 remove_diacritics 2'
    );
  `);
}

function importSource(db, source) {
  const stat = fs.statSync(source.file);
  if (!stat.isFile()) throw new Error(`source is not a file: ${source.file}`);
  const parsed = JSON.parse(fs.readFileSync(source.file, 'utf8'));
  const foods = topLevelFoods(parsed);
  const insertFood = db.prepare(`
    INSERT OR REPLACE INTO foods (
      fdc_id, dataset, description, normalized_description, category,
      publication_date, calories_per_100g, protein_per_100g
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const deletePortions = db.prepare('DELETE FROM portions WHERE fdc_id = ?');
  const insertPortion = db.prepare(`
    INSERT INTO portions (fdc_id, description, gram_weight, calories, protein)
    VALUES (?, ?, ?, ?, ?)
  `);
  let imported = 0;
  let skipped = 0;
  let portionCount = 0;
  db.exec('BEGIN');
  try {
    for (const food of foods) {
      if (!food || typeof food !== 'object') {
        skipped += 1;
        continue;
      }
      const fdcId = Number(food.fdcId);
      const description = String(food.description || '').trim();
      const calories = calorieAmount(food);
      const protein = nutrientAmount(food, 1003);
      if (!Number.isInteger(fdcId) || !description || calories === null || protein === null) {
        skipped += 1;
        continue;
      }
      insertFood.run(
        fdcId,
        source.dataset,
        description,
        normalizeText(description),
        categoryName(food),
        food.publicationDate || null,
        calories,
        protein,
      );
      deletePortions.run(fdcId);
      for (const portion of food.foodPortions || []) {
        const grams = Number(portion.gramWeight);
        if (!Number.isFinite(grams) || grams <= 0) continue;
        insertPortion.run(
          fdcId,
          portionDescription(portion),
          grams,
          Math.round((calories * grams / 100) * 10) / 10,
          Math.round((protein * grams / 100) * 10) / 10,
        );
        portionCount += 1;
      }
      imported += 1;
    }
    db.prepare('INSERT INTO metadata (key, value) VALUES (?, ?)')
      .run(`source:${source.dataset}`, JSON.stringify({
        file: path.basename(source.file),
        imported,
        skipped,
        portions: portionCount,
      }));
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return { dataset: source.dataset, file: source.file, imported, skipped, portions: portionCount };
}

function buildIndex(options) {
  fs.mkdirSync(path.dirname(options.output), { recursive: true });
  const temporary = `${options.output}.building-${process.pid}`;
  if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  const db = new DatabaseSync(temporary);
  const summaries = [];
  try {
    createSchema(db);
    for (const source of options.sources) summaries.push(importSource(db, source));
    db.exec(`
      INSERT INTO foods_fts(rowid, description, normalized_description, dataset)
        SELECT fdc_id, description, normalized_description, dataset FROM foods;
      INSERT INTO metadata (key, value) VALUES ('built_at', '${new Date().toISOString()}');
      INSERT INTO metadata (key, value) VALUES ('schema_version', '1');
      ANALYZE;
    `);
    const foodCount = Number(db.prepare('SELECT COUNT(*) AS n FROM foods').get().n);
    const withPortions = Number(db.prepare('SELECT COUNT(DISTINCT fdc_id) AS n FROM portions').get().n);
    if (foodCount < options.sources.length) throw new Error('nutrition index validation failed: too few foods');
    db.close();
    const vacuumDb = new DatabaseSync(temporary);
    vacuumDb.exec('VACUUM; PRAGMA journal_mode = DELETE; PRAGMA synchronous = NORMAL;');
    vacuumDb.close();
    fs.renameSync(temporary, options.output);
    return {
      ok: true,
      output: options.output,
      bytes: fs.statSync(options.output).size,
      foodCount,
      foodsWithPortions: withPortions,
      sources: summaries,
    };
  } catch (error) {
    try { db.close(); } catch {}
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

if (require.main === module) {
  try {
    const result = buildIndex(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
    process.exitCode = 1;
  }
}

module.exports = { buildIndex, normalizeText, nutrientAmount, calorieAmount, portionDescription };
