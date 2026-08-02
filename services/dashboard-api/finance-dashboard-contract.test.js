#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const SERVER = path.join(__dirname, 'server.js');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finance-dashboard-contract-'));
const db = path.join(tempDir, 'finance.db');
const tokenFile = path.join(tempDir, 'token');
fs.writeFileSync(tokenFile, 'test-token\n', { mode: 0o600 });

function ymd(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function sqlite(sql) {
  const result = spawnSync('sqlite3', [db, sql], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function waitForServer(port) {
  for (let i = 0; i < 60; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/app.js`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('dashboard test server did not start');
}

(async () => {
  let child;
  try {
    const today = new Date();
    const priorDay = new Date(today);
    priorDay.setDate(today.getDate() - 1);
    const todayText = ymd(today);
    sqlite(`
      CREATE TABLE transactions (
        id INTEGER PRIMARY KEY, date TEXT, type TEXT, amount REAL,
        merchant_raw TEXT, needs_review INTEGER, created_at TEXT
      );
      INSERT INTO transactions VALUES
        (1,'${todayText}','debit',80,'PURCHASE ONE',0,'${todayText} 11:59:00'),
        (2,'${todayText}','debit',10,'PURCHASE TWO',1,'${todayText} 12:02:00'),
        (3,'${todayText}','deposit',6,'DEPOSIT',0,'${todayText} 12:03:00'),
        (4,'${todayText}','refund',4,'REFUND',0,'${todayText} 12:04:00'),
        (5,'${todayText}','declined',500,'DECLINED',0,'${todayText} 12:05:00');
      CREATE TABLE expenses (
        id INTEGER PRIMARY KEY, name TEXT, amount_est REAL, due_day INTEGER,
        recurrence TEXT, is_negotiable INTEGER, active INTEGER
      );
      INSERT INTO expenses VALUES
        (1,'Due today B',20,${today.getDate()},'monthly',0,1),
        (2,'Due today A',10,${today.getDate()},'monthly',0,1),
        (3,'Already passed',999,${priorDay.getDate()},'monthly',0,1);
    `);

    const port = await freePort();
    child = spawn(process.execPath, [SERVER], {
      env: {
        ...process.env,
        DASHBOARD_API_HOST: '127.0.0.1',
        DASHBOARD_API_PORT: String(port),
        DASHBOARD_API_TOKEN_FILE: tokenFile,
        FINANCE_DB_PATH: db,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitForServer(port);
    const response = await fetch(`http://127.0.0.1:${port}/api/financials`, {
      headers: { Authorization: 'Bearer test-token' },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.spent_today, 90);
    assert.deepEqual(body.upcoming_transactions.map((entry) => entry.name), ['Due today A', 'Due today B']);
    assert.deepEqual(body.pending_review.map((entry) => entry.id), [2]);
    assert.deepEqual(Object.keys(body).sort(), ['currency', 'pending_review', 'spent_today', 'upcoming_transactions']);

    const reviewResponse = await fetch(`http://127.0.0.1:${port}/api/financials/review/2`, {
      method: 'PATCH',
      headers: { Authorization: 'Bearer test-token' },
    });
    assert.equal(reviewResponse.status, 200);
    const refreshed = await fetch(`http://127.0.0.1:${port}/api/financials`, {
      headers: { Authorization: 'Bearer test-token' },
    }).then((result) => result.json());
    assert.deepEqual(refreshed.pending_review, []);

    const html = await fetch(`http://127.0.0.1:${port}/`).then((result) => result.text());
    assert.match(html, /id="reviewButton"/);
    assert.match(html, /id="reviewBadge"/);
    assert.match(html, /id="reviewOverlay"/);
    assert.match(html, /id="reviewTransactionsTab"/);
    assert.match(html, /id="upcomingTransactionsTab"/);
    assert.match(html, /id="upcomingTransactionsPanel"/);
    assert.doesNotMatch(html, /financials-body[\s\S]*bills-list-wrap/);
    process.stdout.write('finance dashboard contract test passed\n');
  } catch (error) {
    process.exitCode = 1;
    process.stderr.write(`${error.stack || error.message}\n`);
  } finally {
    if (child) child.kill('SIGTERM');
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
})();
