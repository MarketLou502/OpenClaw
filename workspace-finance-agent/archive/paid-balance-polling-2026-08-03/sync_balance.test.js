#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'sync_balance.js');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-balance-'));
const credentials = path.join(temp, 'credentials.json');
const access = path.join(temp, 'access.json');
const db = path.join(temp, 'finance.db');

fs.writeFileSync(credentials, JSON.stringify({
  client_id: 'client-secret-value', secret: 'production-secret-value', environment: 'production',
}), { mode: 0o600 });

// Pre-linked item, so getBalance() calls straight through to
// /accounts/balance/get without needing the create/finalize Link flow.
fs.writeFileSync(access, JSON.stringify({
  version: 2,
  items: [{ access_token: 'access-production-capital-one', institution_id: 'ins_128026', institution_name: 'Capital One' }],
}), { mode: 0o600 });

spawnSync('sqlite3', [db, `
  CREATE TABLE account_balances (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id        TEXT NOT NULL,
      institution_name  TEXT,
      account_name      TEXT,
      account_mask      TEXT,
      balance_current   REAL,
      balance_available REAL,
      currency          TEXT DEFAULT 'USD',
      fetched_at        TEXT NOT NULL
  );
`]);

const requests = [];
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    requests.push({ url: req.url, body: JSON.parse(raw || '{}') });
    let body;
    if (req.url === '/accounts/balance/get') {
      body = { accounts: [
        { account_id: 'acct-checking', name: '360 Checking', mask: '3102', type: 'depository', subtype: 'checking', balances: { available: null, current: 586.12, iso_currency_code: 'USD' } },
        { account_id: 'acct-savings', name: '360 Performance Savings', mask: '3193', type: 'depository', subtype: 'savings', balances: { available: 0.38, current: 0.38, iso_currency_code: 'USD' } },
      ] };
    } else {
      res.writeHead(404); res.end('{}'); return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });
});

function run(port) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT], {
      env: {
        ...process.env,
        PLAID_API_BASE: `http://127.0.0.1:${port}`,
        PLAID_CREDENTIALS_FILE: credentials,
        PLAID_ACCESS_FILE: access,
        FINANCE_DB_PATH: db,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port;
  try {
    const result = await run(port);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /"ok":true/);
    assert.match(result.stdout, /"inserted":2/);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, '/accounts/balance/get');

    const rows = JSON.parse(spawnSync('sqlite3', ['-json', db,
      'SELECT account_id, account_name, account_mask, balance_current, balance_available, currency FROM account_balances ORDER BY account_id;',
    ], { encoding: 'utf8' }).stdout);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].account_id, 'acct-checking');
    assert.equal(rows[0].balance_current, 586.12);
    assert.equal(rows[0].balance_available, null);
    assert.equal(rows[1].account_id, 'acct-savings');
    assert.equal(rows[1].balance_current, 0.38);
    assert.equal(rows[1].account_mask, '3193');

    process.stdout.write('sync_balance test passed\n');
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  } finally {
    server.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
