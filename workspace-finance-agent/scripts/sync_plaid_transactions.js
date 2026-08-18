#!/usr/bin/env node
'use strict';

// Retrieve Plaid's already-collected transaction updates and cached balances.
// This intentionally uses /transactions/sync, never /accounts/balance/get or
// /transactions/refresh. The former is covered by the Transactions subscription;
// the latter two can create additional usage charges.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const WORKSPACE = path.resolve(__dirname, '..');
const API_BASE = (process.env.PLAID_API_BASE || 'https://production.plaid.com').replace(/\/$/, '');
const CREDENTIALS_FILE = process.env.PLAID_CREDENTIALS_FILE || path.join(WORKSPACE, 'memory/.plaid_credentials.json');
const ACCESS_FILE = process.env.PLAID_ACCESS_FILE || path.join(WORKSPACE, 'memory/.plaid_access.json');
const STATE_FILE = process.env.PLAID_SYNC_STATE_FILE || path.join(WORKSPACE, 'memory/.plaid_transactions_sync.json');
const DB_PATH = process.env.FINANCE_DB_PATH || path.join(WORKSPACE, 'finance.db');
const DASHBOARD_URL = process.env.DASHBOARD_API_URL || 'http://127.0.0.1:18795';
const DASHBOARD_TOKEN_FILE = process.env.DASHBOARD_API_TOKEN_FILE || '/Users/aaronmacmini/.openclaw/service-env/dashboard-api.token';

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writePrivateJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(temporary, 'w', 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
}

function sqlLiteral(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return `'${String(value).replace(/'/g, "''")}'`;
}

function credentials() {
  const value = readJson(CREDENTIALS_FILE, {});
  if (!value.client_id || !value.secret || value.environment !== 'production') {
    throw new Error('Plaid Production credentials are incomplete');
  }
  return value;
}

function accessItems(itemId = null) {
  const value = readJson(ACCESS_FILE, {});
  const items = Array.isArray(value.items) ? value.items : (value.access_token ? [value] : []);
  if (!items.length) throw new Error('No Plaid access token exists');
  if (!itemId) return items;
  const selected = items.filter((item) => item.item_id === itemId);
  if (!selected.length) throw new Error(`No Plaid access token exists for Item ${itemId}`);
  return selected;
}

async function plaidPost(endpoint, body) {
  const creds = credentials();
  const response = await fetch(`${API_BASE}${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'PLAID-CLIENT-ID': creds.client_id,
      'PLAID-SECRET': creds.secret,
      'Plaid-Version': '2020-09-14',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45_000),
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(value.error_message || `Plaid returned HTTP ${response.status}`);
    error.code = value.error_code;
    error.requestId = value.request_id;
    throw error;
  }
  return value;
}

async function retrieveItemUpdates(item, initialCursor) {
  const added = [];
  const modified = [];
  const removed = [];
  const accounts = new Map();
  let cursor = initialCursor || null;
  let hasMore = true;

  while (hasMore) {
    const body = { access_token: item.access_token, count: 500 };
    if (cursor) body.cursor = cursor;
    const response = await plaidPost('/transactions/sync', body);
    for (const transaction of response.added || []) added.push(transaction);
    for (const transaction of response.modified || []) modified.push(transaction);
    for (const transaction of response.removed || []) removed.push(transaction);
    for (const account of response.accounts || []) accounts.set(account.account_id, account);
    cursor = response.next_cursor;
    hasMore = response.has_more === true;
  }

  return { added, modified, removed, accounts: [...accounts.values()], cursor };
}

function schemaSql() {
  return `
    CREATE TABLE IF NOT EXISTS plaid_transactions (
      transaction_id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      date TEXT,
      authorized_date TEXT,
      name TEXT,
      merchant_name TEXT,
      amount REAL NOT NULL,
      pending INTEGER NOT NULL DEFAULT 0,
      category TEXT,
      currency TEXT,
      updated_at TEXT NOT NULL,
      reviewed INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_plaid_transactions_account_date
      ON plaid_transactions(account_id, date DESC);
    CREATE TABLE IF NOT EXISTS account_balances (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id TEXT NOT NULL,
      institution_name TEXT,
      account_name TEXT,
      account_mask TEXT,
      balance_current REAL,
      balance_available REAL,
      currency TEXT,
      fetched_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_account_balances_account_fetched
      ON account_balances(account_id, fetched_at DESC);
  `;
}

function transactionUpsertSql(transaction, now) {
  const category = Array.isArray(transaction.category) ? transaction.category.join(' > ') : null;
  const currency = transaction.iso_currency_code || transaction.unofficial_currency_code || null;
  const values = [
    transaction.transaction_id, transaction.account_id, transaction.date,
    transaction.authorized_date, transaction.name, transaction.merchant_name,
    transaction.amount, transaction.pending ? 1 : 0, category, currency, now,
  ].map(sqlLiteral).join(', ');
  return `INSERT INTO plaid_transactions
    (transaction_id, account_id, date, authorized_date, name, merchant_name, amount, pending, category, currency, updated_at)
    VALUES (${values})
    ON CONFLICT(transaction_id) DO UPDATE SET
      account_id=excluded.account_id, date=excluded.date,
      authorized_date=excluded.authorized_date, name=excluded.name,
      merchant_name=excluded.merchant_name, amount=excluded.amount,
      pending=excluded.pending, category=excluded.category,
      currency=excluded.currency, updated_at=excluded.updated_at;`;
}

function persistItemUpdates(item, update, now) {
  const statements = [schemaSql(), 'BEGIN IMMEDIATE;'];
  for (const transaction of [...update.added, ...update.modified]) {
    statements.push(transactionUpsertSql(transaction, now));
  }
  for (const transaction of update.removed) {
    statements.push(`DELETE FROM plaid_transactions WHERE transaction_id=${sqlLiteral(transaction.transaction_id)};`);
  }
  for (const account of update.accounts) {
    const balances = account.balances || {};
    statements.push(`INSERT INTO account_balances
      (account_id, institution_name, account_name, account_mask, balance_current, balance_available, currency, fetched_at)
      VALUES (${[
        account.account_id, item.institution_name, account.name, account.mask,
        balances.current, balances.available,
        balances.iso_currency_code || balances.unofficial_currency_code || null, now,
      ].map(sqlLiteral).join(', ')});`);
  }
  statements.push('COMMIT;');
  const result = spawnSync('sqlite3', [DB_PATH, statements.join('\n')], { encoding: 'utf8', timeout: 30_000 });
  if (result.status !== 0) throw new Error(`sqlite3 transaction sync failed: ${(result.stderr || '').slice(0, 500)}`);
}

async function notifyDashboard() {
  if (!fs.existsSync(DASHBOARD_TOKEN_FILE)) return;
  const token = fs.readFileSync(DASHBOARD_TOKEN_FILE, 'utf8').trim();
  try {
    await fetch(`${DASHBOARD_URL}/api/notify/financials`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    // The local database is authoritative; a dashboard refresh will recover.
  }
}

async function run(options = {}) {
  const state = readJson(STATE_FILE, { version: 1, items: {} });
  const summary = [];
  for (const item of accessItems(options.itemId || null)) {
    const itemId = item.item_id;
    if (!itemId) throw new Error('Plaid access store contains an Item without item_id');
    const originalCursor = state.items[itemId]?.cursor || null;
    let update;
    try {
      update = await retrieveItemUpdates(item, originalCursor);
    } catch (error) {
      if (error.code !== 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION') throw error;
      update = await retrieveItemUpdates(item, originalCursor);
    }
    const now = new Date().toISOString();
    persistItemUpdates(item, update, now);
    state.items[itemId] = { cursor: update.cursor, last_synced_at: now };
    writePrivateJson(STATE_FILE, state);
    summary.push({
      item_id: itemId,
      added: update.added.length,
      modified: update.modified.length,
      removed: update.removed.length,
      accounts: update.accounts.length,
    });
  }
  await notifyDashboard();
  const result = { ok: true, items: summary };
  process.stdout.write(`${new Date().toISOString()} ${JSON.stringify(result)}\n`);
  return result;
}

if (require.main === module) {
  const itemIndex = process.argv.indexOf('--item-id');
  const itemId = itemIndex >= 0 ? process.argv[itemIndex + 1] : null;
  if (itemIndex >= 0 && !itemId) {
    process.stderr.write('Usage: sync_plaid_transactions.js [--item-id ITEM_ID]\n');
    process.exitCode = 2;
  } else run({ itemId }).catch((error) => {
    process.stdout.write(`${new Date().toISOString()} ${JSON.stringify({ ok: false, error: error.message, code: error.code || null })}\n`);
    process.exitCode = 1;
  });
}

module.exports = { persistItemUpdates, retrieveItemUpdates, run, schemaSql, transactionUpsertSql };
