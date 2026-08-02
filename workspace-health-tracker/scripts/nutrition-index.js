#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DEFAULT_DB = path.join(__dirname, '..', 'data', 'nutrition.db');
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'at', 'for', 'from', 'i', 'of', 'some', 'the', 'with',
  'small', 'medium', 'large', 'serving', 'servings', 'piece', 'pieces',
  'cup', 'cups', 'ounce', 'ounces', 'oz', 'pound', 'pounds', 'lb', 'lbs',
  'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve',
]);

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const args = {};
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    args[key] = rest[++i];
  }
  return { command, args };
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function matchExpression(query) {
  const tokens = normalizeText(query).split(' ').filter((token) => token && !STOP_WORDS.has(token));
  if (tokens.length === 0) throw new Error('query must include at least one searchable word');
  return tokens.map((token) => `"${token.replace(/"/g, '""')}"*`).join(' AND ');
}

function openIndex() {
  const dbPath = process.env.NUTRITION_DB || DEFAULT_DB;
  if (!fs.existsSync(dbPath)) throw new Error(`nutrition index not found: ${dbPath}`);
  return new DatabaseSync(dbPath, { readOnly: true });
}

function portionsFor(db, fdcId, limit = 8) {
  return db.prepare(`
    SELECT description, gram_weight AS gramWeight, calories, protein
    FROM portions WHERE fdc_id = ?
    ORDER BY gram_weight ASC LIMIT ?
  `).all(fdcId, limit);
}

function search(db, query, limit) {
  const rows = db.prepare(`
    SELECT f.fdc_id AS fdcId,
           f.dataset,
           f.description,
           f.category,
           f.publication_date AS publicationDate,
           f.calories_per_100g AS caloriesPer100g,
           f.protein_per_100g AS proteinPer100g,
           bm25(foods_fts, 1.0, 0.5) AS rank
    FROM foods_fts
    JOIN foods f ON f.fdc_id = foods_fts.rowid
    WHERE foods_fts MATCH ?
    ORDER BY rank ASC
    LIMIT ?
  `).all(matchExpression(query), limit);
  return rows.map((row) => ({ ...row, portions: portionsFor(db, row.fdcId) }));
}

function getFood(db, fdcId) {
  const row = db.prepare(`
    SELECT fdc_id AS fdcId, dataset, description, category,
           publication_date AS publicationDate,
           calories_per_100g AS caloriesPer100g,
           protein_per_100g AS proteinPer100g
    FROM foods WHERE fdc_id = ?
  `).get(fdcId);
  return row ? { ...row, portions: portionsFor(db, row.fdcId, 50) } : null;
}

function metadata(db) {
  return Object.fromEntries(db.prepare('SELECT key, value FROM metadata ORDER BY key').all().map((row) => {
    let value = row.value;
    try { value = JSON.parse(row.value); } catch {}
    return [row.key, value];
  }));
}

function execute(argv) {
  const { command, args } = parseArgs(argv);
  const db = openIndex();
  try {
    if (command === 'search') {
      const query = String(args.query || '').trim();
      if (!query) throw new Error('--query is required');
      const limit = Math.min(Math.max(Number(args.limit || 5), 1), 20);
      const matches = search(db, query, limit);
      return { ok: true, operation: 'search', query, matches };
    }
    if (command === 'get') {
      const fdcId = Number(args.fdcId);
      if (!Number.isInteger(fdcId)) throw new Error('--fdc-id must be an integer');
      return { ok: true, operation: 'get', found: Boolean(getFood(db, fdcId)), food: getFood(db, fdcId) };
    }
    if (command === 'metadata') return { ok: true, operation: 'metadata', metadata: metadata(db) };
    throw new Error(`unknown command '${command || ''}'`);
  } finally {
    db.close();
  }
}

if (require.main === module) {
  try {
    process.stdout.write(`${JSON.stringify(execute(process.argv.slice(2)))}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
    process.exitCode = 1;
  }
}

module.exports = { execute, search, getFood, matchExpression };
