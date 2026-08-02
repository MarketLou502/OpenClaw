#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const DEFAULT_DB = path.join(__dirname, '..', 'data', 'health-ledger.sqlite');
const DEFAULT_DASHBOARD_URL = 'http://127.0.0.1:18795';
const DEFAULT_TOKEN_FILE = '/Users/aaronmacmini/.openclaw/service-env/dashboard-api.token';
const TIME_ZONE = 'America/New_York';
const HOURLY_WORKOUT_TARGET = 8;

const SEED_STAPLES = [
  {
    id: 'staple-tuna-salad-sandwich',
    name: 'Tuna salad sandwich',
    serving: '75g tuna salad scoop with 2 slices white bread',
    calories: 400,
    protein: 20,
    aliases: ['the sandwich', 'tuna sandwich'],
  },
  {
    id: 'staple-custom-frozen-burrito',
    name: 'Custom frozen burrito',
    serving: '1 burrito (about 278g)',
    calories: 520,
    protein: 28,
    aliases: ['frozen burrito', 'my burrito'],
  },
  {
    id: 'staple-boost-protein-shake',
    name: 'Boost Protein Shake',
    serving: '1 shake',
    calories: 530,
    protein: 22,
    aliases: ['boost shake'],
  },
  {
    id: 'staple-kirkland-breakfast-sandwich',
    name: 'Kirkland breakfast sandwich',
    serving: '1 sandwich',
    calories: 510,
    protein: 17,
    aliases: ['breakfast sandwich'],
  },
  {
    id: 'staple-daily-coffee',
    name: 'Daily coffee',
    serving: 'coffee with cream, milk, and 1 tbsp sugar',
    calories: 50,
    protein: 1,
    aliases: ['my coffee', 'coffee'],
  },
  {
    id: 'staple-protein-shake',
    name: 'Protein shake',
    serving: '1 scoop Kirkland protein powder + 1 cup 2% milk',
    calories: 252,
    protein: 33,
    aliases: ['my protein shake'],
  },
  {
    id: 'staple-chicken-tortilla-soup',
    name: 'Chicken tortilla soup',
    serving: '1 cup',
    calories: 215,
    protein: 20,
    aliases: ['tortilla soup', 'chicken soup'],
  },
  {
    id: 'staple-smoothie',
    name: 'Smoothie',
    serving: '1 cup',
    calories: 150,
    protein: 2,
    aliases: [],
  },
];

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
    .replace(/[\u0300-\u036f]/g, '')
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
  const override = process.env.HEALTH_NOW;
  const date = override ? new Date(override) : new Date();
  if (Number.isNaN(date.getTime())) throw workflowError('INVALID_TIME', 'HEALTH_NOW is not a valid date');
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

function openDatabase(dbPath = process.env.HEALTH_LEDGER_DB || DEFAULT_DB) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS staples (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      normalized_name TEXT NOT NULL UNIQUE,
      serving TEXT NOT NULL,
      calories REAL NOT NULL CHECK(calories >= 0),
      protein REAL NOT NULL CHECK(protein >= 0),
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS staple_aliases (
      staple_id TEXT NOT NULL REFERENCES staples(id) ON DELETE CASCADE,
      alias TEXT NOT NULL,
      normalized_alias TEXT NOT NULL UNIQUE,
      PRIMARY KEY (staple_id, normalized_alias)
    );
    CREATE TABLE IF NOT EXISTS food_entries (
      id TEXT PRIMARY KEY,
      entry_date TEXT NOT NULL,
      created_at TEXT NOT NULL,
      original_text TEXT,
      name TEXT NOT NULL,
      quantity REAL NOT NULL DEFAULT 1 CHECK(quantity > 0),
      serving TEXT NOT NULL,
      calories REAL NOT NULL CHECK(calories >= 0),
      protein REAL NOT NULL CHECK(protein >= 0),
      resolution_type TEXT NOT NULL,
      source_id TEXT,
      source_name TEXT,
      source_url TEXT,
      confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
      origin_channel TEXT,
      conversation_id TEXT,
      status TEXT NOT NULL CHECK(status IN ('active', 'voided', 'superseded')),
      supersedes_id TEXT REFERENCES food_entries(id),
      status_reason TEXT
    );
    CREATE INDEX IF NOT EXISTS food_entries_day_status
      ON food_entries(entry_date, status, created_at);
    CREATE INDEX IF NOT EXISTS food_entries_conversation
      ON food_entries(conversation_id, status, created_at);
    CREATE TABLE IF NOT EXISTS mutations (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      entry_date TEXT NOT NULL,
      operation TEXT NOT NULL,
      conversation_id TEXT,
      payload_json TEXT NOT NULL,
      undone_at TEXT
    );
    CREATE INDEX IF NOT EXISTS mutations_recent
      ON mutations(entry_date, created_at DESC);
    CREATE TABLE IF NOT EXISTS idempotency (
      key TEXT PRIMARY KEY,
      operation TEXT NOT NULL,
      created_at TEXT NOT NULL,
      result_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS hourly_workouts (
      id TEXT PRIMARY KEY,
      entry_date TEXT NOT NULL,
      slot_hour INTEGER NOT NULL CHECK(slot_hour >= 9 AND slot_hour <= 16),
      completed_at TEXT NOT NULL,
      original_text TEXT,
      origin_channel TEXT,
      conversation_id TEXT,
      UNIQUE(entry_date, slot_hour)
    );
    CREATE INDEX IF NOT EXISTS hourly_workouts_day
      ON hourly_workouts(entry_date, slot_hour);
    CREATE TABLE IF NOT EXISTS workout_entries (
      id TEXT PRIMARY KEY,
      entry_date TEXT NOT NULL,
      completed_at TEXT NOT NULL,
      original_text TEXT,
      origin_channel TEXT,
      conversation_id TEXT
    );
    CREATE INDEX IF NOT EXISTS workout_entries_day
      ON workout_entries(entry_date, completed_at);
    INSERT OR IGNORE INTO workout_entries
      (id, entry_date, completed_at, original_text, origin_channel, conversation_id)
    SELECT id, entry_date, completed_at, original_text, origin_channel, conversation_id
    FROM hourly_workouts;
    CREATE TABLE IF NOT EXISTS daily_runs (
      id TEXT PRIMARY KEY,
      entry_date TEXT NOT NULL UNIQUE,
      completed_at TEXT NOT NULL,
      duration_minutes REAL NOT NULL CHECK(duration_minutes > 0),
      original_text TEXT,
      origin_channel TEXT,
      conversation_id TEXT
    );
  `);
  seedStaples(db);
  return db;
}

function seedStaples(db) {
  const insertStaple = db.prepare(`
    INSERT OR IGNORE INTO staples
      (id, name, normalized_name, serving, calories, protein, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertAlias = db.prepare(`
    INSERT OR IGNORE INTO staple_aliases (staple_id, alias, normalized_alias)
    VALUES (?, ?, ?)
  `);
  const createdAt = nowIso();
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const staple of SEED_STAPLES) {
      insertStaple.run(
        staple.id,
        staple.name,
        normalizeText(staple.name),
        staple.serving,
        staple.calories,
        staple.protein,
        createdAt,
      );
      for (const alias of staple.aliases) {
        insertAlias.run(staple.id, alias, normalizeText(alias));
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
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

function rowToEntry(row) {
  if (!row) return null;
  return {
    id: row.id,
    date: row.entry_date,
    createdAt: row.created_at,
    originalText: row.original_text,
    name: row.name,
    quantity: row.quantity,
    serving: row.serving,
    calories: row.calories,
    protein: row.protein,
    resolutionType: row.resolution_type,
    sourceId: row.source_id,
    sourceName: row.source_name,
    sourceUrl: row.source_url,
    confidence: row.confidence,
    originChannel: row.origin_channel,
    conversationId: row.conversation_id,
    status: row.status,
    supersedesId: row.supersedes_id,
    statusReason: row.status_reason,
  };
}

function totalsForDate(db, date) {
  const row = db.prepare(`
    SELECT COALESCE(SUM(calories), 0) AS calories,
           COALESCE(SUM(protein), 0) AS protein
    FROM food_entries
    WHERE entry_date = ? AND status = 'active'
  `).get(date);
  return {
    calories: Math.round(Number(row.calories) * 10) / 10,
    protein: Math.round(Number(row.protein) * 10) / 10,
  };
}

function activityForDate(db, date) {
  const workoutRows = db.prepare(`
    SELECT id, completed_at
    FROM workout_entries
    WHERE entry_date = ?
    ORDER BY completed_at ASC
  `).all(date);
  const run = db.prepare(`
    SELECT id, completed_at, duration_minutes
    FROM daily_runs
    WHERE entry_date = ?
  `).get(date);
  return {
    hourlyWorkouts: {
      current: workoutRows.length,
      target: HOURLY_WORKOUT_TARGET,
      entries: workoutRows.map((row) => ({ id: row.id, completedAt: row.completed_at })),
    },
    dailyRun: run ? {
      done: true,
      id: run.id,
      completedAt: run.completed_at,
      durationMinutes: run.duration_minutes,
    } : { done: false, durationMinutes: null },
  };
}

function findIdempotentResult(db, key) {
  if (!key) return null;
  const row = db.prepare('SELECT result_json FROM idempotency WHERE key = ?').get(key);
  return row ? JSON.parse(row.result_json) : null;
}

function saveIdempotentResult(db, key, operation, createdAt, result) {
  if (!key) return;
  db.prepare(`
    INSERT INTO idempotency (key, operation, created_at, result_json)
    VALUES (?, ?, ?, ?)
  `).run(key, operation, createdAt, JSON.stringify(result));
}

function mutation(db, operation, date, conversationId, payload, createdAt) {
  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO mutations
      (id, created_at, entry_date, operation, conversation_id, payload_json, undone_at)
    VALUES (?, ?, ?, ?, ?, ?, NULL)
  `).run(id, createdAt, date, operation, conversationId, JSON.stringify(payload));
  return id;
}

function listStaples(db) {
  const rows = db.prepare(`
    SELECT s.id, s.name, s.serving, s.calories, s.protein,
           GROUP_CONCAT(a.alias, '|') AS aliasList
    FROM staples s
    LEFT JOIN staple_aliases a ON a.staple_id = s.id
    GROUP BY s.id
    ORDER BY s.name
  `).all();
  const staples = rows.map((row) => ({
    id: row.id,
    name: row.name,
    serving: row.serving,
    calories: row.calories,
    protein: row.protein,
    aliases: row.aliasList ? row.aliasList.split('|') : [],
  }));
  return { ok: true, operation: 'list-staples', staples };
}

function findStaple(db, query) {
  const normalized = normalizeText(query);
  if (!normalized) return null;
  const row = db.prepare(`
    SELECT s.*
    FROM staples s
    LEFT JOIN staple_aliases a ON a.staple_id = s.id
    WHERE s.normalized_name = ? OR a.normalized_alias = ?
    LIMIT 1
  `).get(normalized, normalized);
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    serving: row.serving,
    calories: row.calories,
    protein: row.protein,
  };
}

function addStaple(db, args) {
  const name = requireText(args, 'name');
  const normalizedName = normalizeText(name);
  const serving = requireText(args, 'serving');
  const calories = numberArg(args, 'calories', { max: 10000 });
  const protein = numberArg(args, 'protein', { max: 1000 });
  const aliases = optionalText(args, 'aliases')
    ? optionalText(args, 'aliases').split(',').map((item) => item.trim()).filter(Boolean)
    : [];
  const duplicate = db.prepare(`
    SELECT s.name
    FROM staples s
    LEFT JOIN staple_aliases a ON a.staple_id = s.id
    WHERE s.normalized_name = ? OR a.normalized_alias = ?
    LIMIT 1
  `).get(normalizedName, normalizedName);
  if (duplicate) {
    throw workflowError('DUPLICATE_STAPLE', `A staple named or aliased '${duplicate.name}' already exists`);
  }
  const createdAt = nowIso();
  const id = crypto.randomUUID();
  withTransaction(db, () => {
    db.prepare(`
      INSERT INTO staples
        (id, name, normalized_name, serving, calories, protein, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, name, normalizedName, serving, calories, protein, createdAt);
    const aliasInsert = db.prepare(`
      INSERT INTO staple_aliases (staple_id, alias, normalized_alias)
      VALUES (?, ?, ?)
    `);
    for (const alias of aliases) aliasInsert.run(id, alias, normalizeText(alias));
  });
  return {
    ok: true,
    operation: 'add-staple',
    staple: { id, name, serving, calories, protein, aliases },
    reply: `Added ${name} to your staples.`,
  };
}

function baseFoodFromArgs(args) {
  const resolutionType = requireText(args, 'resolutionType', 'resolution type');
  const allowedTypes = new Set(['staple', 'usda', 'vendor_cache', 'estimate', 'manual']);
  if (!allowedTypes.has(resolutionType)) {
    throw workflowError('INVALID_ARGUMENT', `resolution type must be one of: ${[...allowedTypes].join(', ')}`);
  }
  const calories = numberArg(args, 'calories', { max: 10000 });
  const protein = numberArg(args, 'protein', { max: 1000 });
  return {
    name: requireText(args, 'name'),
    quantity: numberArg(args, 'quantity', { optional: true, min: 0.01, max: 1000 }) ?? 1,
    serving: requireText(args, 'serving'),
    calories,
    protein,
    resolutionType,
    sourceId: optionalText(args, 'sourceId'),
    sourceName: optionalText(args, 'sourceName'),
    sourceUrl: optionalText(args, 'sourceUrl'),
    confidence: numberArg(args, 'confidence', { optional: true, min: 0, max: 1 }) ?? 0.5,
    originalText: optionalText(args, 'original'),
    originChannel: optionalText(args, 'originChannel'),
    conversationId: optionalText(args, 'conversationId'),
    sanityWarning: calories > 4000 || protein > 300,
  };
}

function insertFoodEntry(db, entry) {
  db.prepare(`
    INSERT INTO food_entries (
      id, entry_date, created_at, original_text, name, quantity, serving,
      calories, protein, resolution_type, source_id, source_name, source_url,
      confidence, origin_channel, conversation_id, status, supersedes_id,
      status_reason
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    entry.id,
    entry.date,
    entry.createdAt,
    entry.originalText,
    entry.name,
    entry.quantity,
    entry.serving,
    entry.calories,
    entry.protein,
    entry.resolutionType,
    entry.sourceId,
    entry.sourceName,
    entry.sourceUrl,
    entry.confidence,
    entry.originChannel,
    entry.conversationId,
    entry.status,
    entry.supersedesId,
    entry.statusReason,
  );
}

function logFood(db, args) {
  const idemKey = requireText(args, 'idempotencyKey', 'idempotency key');
  const existing = findIdempotentResult(db, idemKey);
  if (existing) return { ...existing, deduplicated: true };
  const food = baseFoodFromArgs(args);
  const createdAt = nowIso();
  const date = optionalText(args, 'date') || localDate(createdAt);
  const entry = {
    id: crypto.randomUUID(),
    date,
    createdAt,
    ...food,
    status: 'active',
    supersedesId: null,
    statusReason: null,
  };
  return withTransaction(db, () => {
    const raced = findIdempotentResult(db, idemKey);
    if (raced) return { ...raced, deduplicated: true };
    insertFoodEntry(db, entry);
    const mutationId = mutation(db, 'log-food', date, entry.conversationId, { entryId: entry.id }, createdAt);
    const result = {
      ok: true,
      operation: 'log-food',
      mutationId,
      entry: rowToEntry(db.prepare('SELECT * FROM food_entries WHERE id = ?').get(entry.id)),
      totals: totalsForDate(db, date),
      sanityWarning: food.sanityWarning,
      reply: 'Got that logged.',
    };
    saveIdempotentResult(db, idemKey, 'log-food', createdAt, result);
    return result;
  });
}

function logWorkout(db, args) {
  const idemKey = requireText(args, 'idempotencyKey', 'idempotency key');
  const existing = findIdempotentResult(db, idemKey);
  if (existing) return { ...existing, deduplicated: true };
  const completedAt = nowIso();
  const date = optionalText(args, 'date') || localDate(completedAt);
  const conversationId = optionalText(args, 'conversationId');
  return withTransaction(db, () => {
    const raced = findIdempotentResult(db, idemKey);
    if (raced) return { ...raced, deduplicated: true };
    const id = crypto.randomUUID();
    db.prepare(`
      INSERT INTO workout_entries
        (id, entry_date, completed_at, original_text, origin_channel, conversation_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      id,
      date,
      completedAt,
      optionalText(args, 'original'),
      optionalText(args, 'originChannel'),
      conversationId,
    );
    const result = {
      ok: true,
      operation: 'log-workout',
      entry: { id, date, completedAt },
      activity: activityForDate(db, date),
      reply: 'Got that logged.',
    };
    saveIdempotentResult(db, idemKey, 'log-workout', completedAt, result);
    return result;
  });
}

function logDailyRun(db, args) {
  const idemKey = requireText(args, 'idempotencyKey', 'idempotency key');
  const existing = findIdempotentResult(db, idemKey);
  if (existing) return { ...existing, deduplicated: true };
  const completedAt = nowIso();
  const date = optionalText(args, 'date') || localDate(completedAt);
  const durationMinutes = numberArg(args, 'durationMinutes', { optional: true, min: 1, max: 600 }) ?? 30;
  const conversationId = optionalText(args, 'conversationId');
  return withTransaction(db, () => {
    const raced = findIdempotentResult(db, idemKey);
    if (raced) return { ...raced, deduplicated: true };
    const prior = db.prepare('SELECT * FROM daily_runs WHERE entry_date = ?').get(date);
    let id = prior?.id;
    if (!prior) {
      id = crypto.randomUUID();
      db.prepare(`
        INSERT INTO daily_runs
          (id, entry_date, completed_at, duration_minutes, original_text, origin_channel, conversation_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        date,
        completedAt,
        durationMinutes,
        optionalText(args, 'original'),
        optionalText(args, 'originChannel'),
        conversationId,
      );
    }
    const result = {
      ok: true,
      operation: 'log-daily-run',
      entry: {
        id,
        date,
        completedAt: prior?.completed_at || completedAt,
        durationMinutes: prior?.duration_minutes ?? durationMinutes,
      },
      alreadyRecorded: !!prior,
      activity: activityForDate(db, date),
      reply: 'Got that logged.',
    };
    saveIdempotentResult(db, idemKey, 'log-daily-run', completedAt, result);
    return result;
  });
}

function selectEntry(db, args, statuses = ['active']) {
  const id = optionalText(args, 'id');
  if (id) {
    const placeholders = statuses.map(() => '?').join(',');
    const row = db.prepare(`SELECT * FROM food_entries WHERE id = ? AND status IN (${placeholders})`).get(id, ...statuses);
    if (!row) throw workflowError('NOT_FOUND', `No matching food entry '${id}' was found`);
    return row;
  }
  const date = optionalText(args, 'date') || localDate();
  const conversationId = optionalText(args, 'conversationId');
  const placeholders = statuses.map(() => '?').join(',');
  let sql = `SELECT * FROM food_entries WHERE entry_date = ? AND status IN (${placeholders})`;
  const values = [date, ...statuses];
  if (conversationId) {
    sql += ' AND conversation_id = ?';
    values.push(conversationId);
  }
  sql += ' ORDER BY created_at DESC, rowid DESC LIMIT 1';
  const row = db.prepare(sql).get(...values);
  if (!row) throw workflowError('NOT_FOUND', 'No applicable food entry was found');
  return row;
}

function correctFood(db, args) {
  const idemKey = requireText(args, 'idempotencyKey', 'idempotency key');
  const existing = findIdempotentResult(db, idemKey);
  if (existing) return { ...existing, deduplicated: true };
  const old = selectEntry(db, args, ['active']);
  const createdAt = nowIso();
  const calories = numberArg(args, 'calories', { optional: true, max: 10000 }) ?? old.calories;
  const protein = numberArg(args, 'protein', { optional: true, max: 1000 }) ?? old.protein;
  const entry = {
    id: crypto.randomUUID(),
    date: old.entry_date,
    createdAt,
    originalText: optionalText(args, 'original') || old.original_text,
    name: optionalText(args, 'name') || old.name,
    quantity: numberArg(args, 'quantity', { optional: true, min: 0.01, max: 1000 }) ?? old.quantity,
    serving: optionalText(args, 'serving') || old.serving,
    calories,
    protein,
    resolutionType: optionalText(args, 'resolutionType') || old.resolution_type,
    sourceId: optionalText(args, 'sourceId') || old.source_id,
    sourceName: optionalText(args, 'sourceName') || old.source_name,
    sourceUrl: optionalText(args, 'sourceUrl') || old.source_url,
    confidence: numberArg(args, 'confidence', { optional: true, min: 0, max: 1 }) ?? old.confidence,
    originChannel: optionalText(args, 'originChannel') || old.origin_channel,
    conversationId: optionalText(args, 'conversationId') || old.conversation_id,
    status: 'active',
    supersedesId: old.id,
    statusReason: null,
  };
  return withTransaction(db, () => {
    const raced = findIdempotentResult(db, idemKey);
    if (raced) return { ...raced, deduplicated: true };
    db.prepare(`UPDATE food_entries SET status = 'superseded', status_reason = ? WHERE id = ?`)
      .run(optionalText(args, 'reason') || 'corrected', old.id);
    insertFoodEntry(db, entry);
    const mutationId = mutation(db, 'correct-food', old.entry_date, entry.conversationId, {
      oldEntryId: old.id,
      newEntryId: entry.id,
    }, createdAt);
    const result = {
      ok: true,
      operation: 'correct-food',
      mutationId,
      replacedEntryId: old.id,
      entry: rowToEntry(db.prepare('SELECT * FROM food_entries WHERE id = ?').get(entry.id)),
      totals: totalsForDate(db, old.entry_date),
      sanityWarning: calories > 4000 || protein > 300,
      reply: 'Updated.',
    };
    saveIdempotentResult(db, idemKey, 'correct-food', createdAt, result);
    return result;
  });
}

function removeFood(db, args) {
  const idemKey = requireText(args, 'idempotencyKey', 'idempotency key');
  const existing = findIdempotentResult(db, idemKey);
  if (existing) return { ...existing, deduplicated: true };
  const row = selectEntry(db, args, ['active']);
  const createdAt = nowIso();
  return withTransaction(db, () => {
    const raced = findIdempotentResult(db, idemKey);
    if (raced) return { ...raced, deduplicated: true };
    db.prepare(`UPDATE food_entries SET status = 'voided', status_reason = ? WHERE id = ?`)
      .run(optionalText(args, 'reason') || 'removed', row.id);
    const mutationId = mutation(db, 'remove-food', row.entry_date, row.conversation_id, { entryId: row.id }, createdAt);
    const result = {
      ok: true,
      operation: 'remove-food',
      mutationId,
      removedEntryId: row.id,
      totals: totalsForDate(db, row.entry_date),
      reply: 'Removed.',
    };
    saveIdempotentResult(db, idemKey, 'remove-food', createdAt, result);
    return result;
  });
}

function undoLast(db, args) {
  const idemKey = requireText(args, 'idempotencyKey', 'idempotency key');
  const existing = findIdempotentResult(db, idemKey);
  if (existing) return { ...existing, deduplicated: true };
  const date = optionalText(args, 'date') || localDate();
  const conversationId = optionalText(args, 'conversationId');
  let sql = `SELECT * FROM mutations WHERE entry_date = ? AND undone_at IS NULL`;
  const values = [date];
  if (conversationId) {
    sql += ' AND conversation_id = ?';
    values.push(conversationId);
  }
  sql += ' ORDER BY created_at DESC, rowid DESC LIMIT 1';
  const prior = db.prepare(sql).get(...values);
  if (!prior) throw workflowError('NOT_FOUND', 'There is no reversible health action to undo');
  const payload = JSON.parse(prior.payload_json);
  const createdAt = nowIso();
  return withTransaction(db, () => {
    const raced = findIdempotentResult(db, idemKey);
    if (raced) return { ...raced, deduplicated: true };
    if (prior.operation === 'log-food') {
      db.prepare(`UPDATE food_entries SET status = 'voided', status_reason = 'undo' WHERE id = ?`).run(payload.entryId);
    } else if (prior.operation === 'remove-food') {
      db.prepare(`UPDATE food_entries SET status = 'active', status_reason = NULL WHERE id = ?`).run(payload.entryId);
    } else if (prior.operation === 'correct-food') {
      db.prepare(`UPDATE food_entries SET status = 'voided', status_reason = 'undo correction' WHERE id = ?`).run(payload.newEntryId);
      db.prepare(`UPDATE food_entries SET status = 'active', status_reason = NULL WHERE id = ?`).run(payload.oldEntryId);
    } else {
      throw workflowError('NOT_REVERSIBLE', `Operation '${prior.operation}' cannot be undone`);
    }
    db.prepare('UPDATE mutations SET undone_at = ? WHERE id = ?').run(createdAt, prior.id);
    const result = {
      ok: true,
      operation: 'undo',
      undoneMutationId: prior.id,
      undoneOperation: prior.operation,
      totals: totalsForDate(db, prior.entry_date),
      reply: 'Undone.',
    };
    saveIdempotentResult(db, idemKey, 'undo', createdAt, result);
    return result;
  });
}

function listToday(db, args) {
  const date = optionalText(args, 'date') || localDate();
  const rows = db.prepare(`
    SELECT * FROM food_entries
    WHERE entry_date = ? AND status = 'active'
    ORDER BY created_at ASC, rowid ASC
  `).all(date);
  return {
    ok: true,
    operation: 'list-today',
    date,
    entries: rows.map(rowToEntry),
    totals: totalsForDate(db, date),
    activity: activityForDate(db, date),
  };
}

function activityToday(db, args) {
  const date = optionalText(args, 'date') || localDate();
  return { ok: true, operation: 'activity-today', date, activity: activityForDate(db, date) };
}

function getEntry(db, args) {
  const row = selectEntry(db, args, ['active']);
  return { ok: true, operation: 'get-entry', entry: rowToEntry(row) };
}

async function syncDashboard(result) {
  const healthPatch = {};
  if (result.totals) {
    healthPatch.calories = { current: result.totals.calories };
    healthPatch.protein = { current: result.totals.protein };
  }
  if (result.operation === 'log-workout' && result.activity) {
    healthPatch.hourlyWorkouts = {
      current: result.activity.hourlyWorkouts.current,
      target: HOURLY_WORKOUT_TARGET,
      unit: '',
    };
  }
  const markRunGoal = result.operation === 'log-daily-run';
  if (Object.keys(healthPatch).length === 0 && !markRunGoal) return { attempted: false, ok: true };
  if (process.env.HEALTH_DASHBOARD_SYNC === 'off') {
    return { attempted: false, ok: true, skipped: true };
  }
  const tokenFile = process.env.HEALTH_DASHBOARD_TOKEN_FILE || DEFAULT_TOKEN_FILE;
  const token = fs.readFileSync(tokenFile, 'utf8').trim();
  if (!token) throw new Error(`dashboard token file is empty: ${tokenFile}`);
  const baseUrl = (process.env.HEALTH_DASHBOARD_URL || DEFAULT_DASHBOARD_URL).replace(/\/$/, '');
  const request = async (pathname, body) => {
    const response = await fetch(`${baseUrl}${pathname}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`dashboard API returned HTTP ${response.status} for ${pathname}`);
  };
  if (Object.keys(healthPatch).length > 0) await request('/api/health', healthPatch);
  if (markRunGoal) await request('/api/goals/workout-run', { done: true });
  return { attempted: true, ok: true, healthUpdated: Object.keys(healthPatch).length > 0, runGoalUpdated: markRunGoal };
}

function isMutationCommand(command) {
  return new Set([
    'log-food', 'correct-food', 'remove-food', 'undo',
    'log-workout', 'log-daily-run',
  ]).has(command);
}

async function execute(argv) {
  const { command, args } = parseArgs(argv);
  if (!command) throw workflowError('USAGE', 'A command is required');
  const db = openDatabase();
  try {
    let result;
    if (command === 'init') {
      const stapleCount = db.prepare('SELECT COUNT(*) AS n FROM staples').get().n;
      result = { ok: true, operation: 'init', database: process.env.HEALTH_LEDGER_DB || DEFAULT_DB, stapleCount };
    } else if (command === 'list-staples') {
      result = listStaples(db);
    } else if (command === 'find-staple') {
      const staple = findStaple(db, requireText(args, 'query'));
      result = staple
        ? { ok: true, operation: 'find-staple', found: true, staple }
        : { ok: true, operation: 'find-staple', found: false, staple: null };
    } else if (command === 'add-staple') {
      result = addStaple(db, args);
    } else if (command === 'log-food') {
      result = logFood(db, args);
    } else if (command === 'log-workout') {
      result = logWorkout(db, args);
    } else if (command === 'log-daily-run') {
      result = logDailyRun(db, args);
    } else if (command === 'correct-food') {
      result = correctFood(db, args);
    } else if (command === 'remove-food') {
      result = removeFood(db, args);
    } else if (command === 'undo') {
      result = undoLast(db, args);
    } else if (command === 'list-today') {
      result = listToday(db, args);
    } else if (command === 'activity-today') {
      result = activityToday(db, args);
    } else if (command === 'get-entry') {
      result = getEntry(db, args);
    } else {
      throw workflowError('USAGE', `Unknown command '${command}'`);
    }

    if (isMutationCommand(command)) {
      try {
        result.dashboard = await syncDashboard(result);
      } catch (error) {
        result.dashboard = { attempted: true, ok: false, error: error.message };
        result.reply = `${result.reply} The dashboard may be behind.`;
      }
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
        code: error.code || 'HEALTH_WORKFLOW_ERROR',
        error: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      })}\n`);
      process.exitCode = 1;
    });
}

module.exports = { execute, normalizeText, localDate };
