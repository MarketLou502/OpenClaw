#!/usr/bin/env node
'use strict';

// Plaid balance sync — fetches current balances for every linked account
// via plaid_hosted_link.js's getBalance() (real Plaid call, stored access
// token, no browser flow) and appends a snapshot row per account into
// finance.db's account_balances table. Intended to run 1-2x/day via the
// com.openclaw.finance.balance-sync LaunchAgent, not on every dashboard
// poll — dashboard-api reads the latest stored row instead of calling
// Plaid live. Run standalone any time with `node scripts/sync_balance.js`.

const path = require('path');
const { spawnSync } = require('child_process');
const { getBalance } = require('./plaid_hosted_link.js');

const DB_PATH = process.env.FINANCE_DB_PATH ||
  path.join(__dirname, '..', 'finance.db');

function sqlEscape(value) {
  return String(value).replace(/'/g, "''");
}

function sqlLiteral(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return `'${sqlEscape(value)}'`;
}

function insertBalances(rows) {
  if (!rows.length) return 0;
  const values = rows.map((row) => `(${[
    sqlLiteral(row.account_id),
    sqlLiteral(row.institution_name),
    sqlLiteral(row.account_name),
    sqlLiteral(row.account_mask),
    sqlLiteral(row.balance_current),
    sqlLiteral(row.balance_available),
    sqlLiteral(row.currency),
    sqlLiteral(row.fetched_at),
  ].join(', ')})`).join(',\n');

  const sql = `INSERT INTO account_balances
    (account_id, institution_name, account_name, account_mask, balance_current, balance_available, currency, fetched_at)
    VALUES\n${values};`;

  const result = spawnSync('sqlite3', [DB_PATH, sql], { encoding: 'utf8', timeout: 10000 });
  if (result.status !== 0) {
    throw new Error(`sqlite3 insert failed: ${(result.stderr || '').slice(0, 500)}`);
  }
  return rows.length;
}

async function run() {
  const { items } = await getBalance();
  const rows = [];
  for (const item of items) {
    for (const account of item.accounts) {
      rows.push({
        account_id: account.account_id,
        institution_name: item.institution_name,
        account_name: account.name,
        account_mask: account.mask,
        balance_current: account.current,
        balance_available: account.available,
        currency: account.currency || 'USD',
        fetched_at: item.fetched_at,
      });
    }
  }
  const inserted = insertBalances(rows);
  const summary = { ok: true, inserted, accounts: rows.map((r) => ({ name: r.account_name, current: r.balance_current })) };
  process.stdout.write(`${new Date().toISOString()} ${JSON.stringify(summary)}\n`);
  return summary;
}

if (require.main === module) {
  run().catch((error) => {
    process.stdout.write(`${new Date().toISOString()} ${JSON.stringify({ ok: false, error: error.message })}\n`);
    process.exitCode = 1;
  });
}

module.exports = { insertBalances, run };
