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

// Adds singular/plural query variants for irregular plurals so a spoken
// singular ("a French fry") still matches USDA data that only exists in
// plural form ("french fries"), and vice versa. The FTS5 index uses the
// plain unicode61 tokenizer (no stemming — see build-nutrition-index.js),
// and a prefix match alone doesn't bridge irregular plurals where the
// singular and plural share no common prefix (fry/fries: f-r-y vs
// f-r-i-e-s). Regular plurals (apple/apples) already work via the existing
// prefix match and don't need a variant. Confirmed 2026-08-10: "a large
// French fry" returned zero USDA candidates even though "french fries" is a
// well-populated category — the query literally became `"fry"*`, which
// prefix-matches unrelated words like "frybread"/"fryers" but not "fries".
function pluralVariants(token) {
  const variants = new Set([token]);
  if (/[^aeiou]y$/.test(token)) {
    variants.add(`${token.slice(0, -1)}ies`); // fry -> fries, city -> cities
  } else if (token.endsWith('ies') && token.length > 4) {
    variants.add(`${token.slice(0, -3)}y`); // fries -> fry
  }
  if (/[^aeiou]f$/.test(token)) {
    variants.add(`${token.slice(0, -1)}ves`); // leaf -> leaves, loaf -> loaves
  } else if (token.endsWith('ves') && token.length > 4) {
    variants.add(`${token.slice(0, -3)}f`); // leaves -> leaf
  }
  return Array.from(variants);
}

function filteredTokens(query) {
  return normalizeText(query).split(' ').filter((token) => token && !STOP_WORDS.has(token));
}

function matchExpression(query) {
  const tokens = filteredTokens(query);
  if (tokens.length === 0) throw new Error('query must include at least one searchable word');
  return tokens
    .map((token) => pluralVariants(token).map((variant) => `"${variant.replace(/"/g, '""')}"*`).join(' OR '))
    .map((clause) => `(${clause})`)
    .join(' AND ');
}

// ─── Fuzzy fallback (typos, unmodeled morphology) ──────────────────────────
//
// pluralVariants() above only covers the two irregular-plural shapes we've
// actually hit. Rather than keep enumerating morphology rules one report at
// a time — the "whack-a-mole" problem — anything the strict FTS5 match
// misses entirely falls back to character-trigram similarity against every
// food description. This is a general-purpose net: it also catches typos
// and near-misses that no morphology rule would ever cover, at the cost of
// being fuzzier evidence than an exact/prefix token match (callers should
// treat fuzzy hits as lower-confidence — see MIN_USDA_CONFIDENCE handling
// in shared-routine-router/index.js's tryUSDAFood).
//
// Considered SQLite's spellfix1 extension instead (this is exactly what it's
// for), but it isn't bundled with Homebrew's sqlite or Node's built-in
// `node:sqlite` — using it means compiling ext/misc/spellfix.c from the
// SQLite source tree into a native .dylib and loading it at runtime, which
// is a brittle, version-pinned build step for a table of ~13k rows that a
// pure-JS full scan handles in single-digit milliseconds. Revisit spellfix1
// only if the foods table grows enough that a JS scan becomes the
// bottleneck.
const MIN_FUZZY_SIMILARITY = 0.35;

function charTrigrams(str) {
  const padded = `  ${str}  `;
  const grams = new Set();
  for (let i = 0; i < padded.length - 2; i += 1) grams.add(padded.slice(i, i + 3));
  return grams;
}

function diceSimilarity(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a];
  let intersection = 0;
  for (const gram of smaller) if (larger.has(gram)) intersection += 1;
  return (2 * intersection) / (a.size + b.size);
}

function fuzzySearch(db, query, limit) {
  const queryText = filteredTokens(query).join(' ');
  if (!queryText) return [];
  const queryGrams = charTrigrams(queryText);
  const rows = db.prepare(`
    SELECT f.fdc_id AS fdcId,
           f.dataset,
           f.description,
           f.category,
           f.publication_date AS publicationDate,
           f.calories_per_100g AS caloriesPer100g,
           f.protein_per_100g AS proteinPer100g
    FROM foods f
  `).all();
  const scored = [];
  for (const row of rows) {
    const similarity = diceSimilarity(queryGrams, charTrigrams(normalizeText(row.description)));
    if (similarity >= MIN_FUZZY_SIMILARITY) scored.push({ ...row, similarity, fuzzyMatch: true });
  }
  scored.sort((a, b) => b.similarity - a.similarity);
  return scored.slice(0, limit).map((row) => ({ ...row, portions: portionsFor(db, row.fdcId) }));
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
  if (rows.length > 0) return rows.map((row) => ({ ...row, portions: portionsFor(db, row.fdcId) }));
  return fuzzySearch(db, query, limit);
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

module.exports = {
  execute, search, getFood, matchExpression, openIndex,
  // Exported for direct unit testing of the fuzzy fallback without needing
  // a query that happens to miss the strict FTS5 match.
  fuzzySearch, diceSimilarity, charTrigrams,
};
