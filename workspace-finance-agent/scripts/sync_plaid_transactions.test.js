#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'plaid-transaction-sync-'));
const credentials = path.join(temp, 'credentials.json');
const access = path.join(temp, 'access.json');
const state = path.join(temp, 'state.json');
const db = path.join(temp, 'finance.db');
fs.writeFileSync(credentials, JSON.stringify({ client_id: 'client', secret: 'secret', environment: 'production' }));
fs.writeFileSync(access, JSON.stringify({ items: [{ item_id: 'item-1', access_token: 'access', institution_name: 'Test Bank' }] }));

process.env.PLAID_API_BASE = 'https://mock.plaid.test';
process.env.PLAID_CREDENTIALS_FILE = credentials;
process.env.PLAID_ACCESS_FILE = access;
process.env.PLAID_SYNC_STATE_FILE = state;
process.env.FINANCE_DB_PATH = db;
process.env.DASHBOARD_API_TOKEN_FILE = path.join(temp, 'missing-token');

let requestCount = 0;
global.fetch = async (url, options) => {
  requestCount += 1;
  assert.equal(url, 'https://mock.plaid.test/transactions/sync');
  const parsed = JSON.parse(options.body);
  assert.equal(parsed.access_token, 'access');
  assert.equal(parsed.count, 500);
  if (requestCount === 2) assert.equal(parsed.cursor, 'cursor-1');
  return {
    ok: true,
    async json() {
      return {
        added: requestCount === 1 ? [{
          transaction_id: 'txn-1', account_id: 'acct-1', date: '2026-08-03',
          authorized_date: '2026-08-02', name: 'Coffee', merchant_name: 'Cafe',
          amount: 4.25, pending: false, category: ['Food', 'Coffee'], iso_currency_code: 'USD',
        }] : [],
        modified: [], removed: [],
        accounts: [{
          account_id: 'acct-1', name: 'Checking', mask: '1234',
          balances: { current: 95.75, available: 90.75, iso_currency_code: 'USD' },
        }],
        next_cursor: requestCount === 1 ? 'cursor-1' : 'cursor-2', has_more: false,
      };
    },
  };
};

const { run } = require('./sync_plaid_transactions.js');

(async () => {
  await run();
  await run();
  const row = spawnSync('sqlite3', [db, 'SELECT transaction_id,amount FROM plaid_transactions;'], { encoding: 'utf8' });
  assert.equal(row.stdout.trim(), 'txn-1|4.25');
  const balances = spawnSync('sqlite3', [db, 'SELECT COUNT(*) FROM account_balances;'], { encoding: 'utf8' });
  assert.equal(balances.stdout.trim(), '2');
  assert.equal(JSON.parse(fs.readFileSync(state, 'utf8')).items['item-1'].cursor, 'cursor-2');
  process.stdout.write('Plaid transaction sync test passed\n');
})().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
