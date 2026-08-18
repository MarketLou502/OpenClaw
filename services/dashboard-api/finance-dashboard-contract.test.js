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

    // Mirrors server.js's nextOccurrence(): a monthly due_day that already
    // passed this month rolls forward to next month rather than dropping out.
    function daysInMonth(year, monthIndex) { return new Date(year, monthIndex + 1, 0).getDate(); }
    function nextOccurrence(dueDay) {
      const year = today.getFullYear();
      const month = today.getMonth();
      const thisMonthDay = Math.min(dueDay, daysInMonth(year, month));
      if (thisMonthDay >= today.getDate()) return new Date(year, month, thisMonthDay);
      const nextMonth = month === 11 ? 0 : month + 1;
      const nextMonthYear = month === 11 ? year + 1 : year;
      return new Date(nextMonthYear, nextMonth, Math.min(dueDay, daysInMonth(nextMonthYear, nextMonth)));
    }
    const alreadyPassedDueDate = ymd(nextOccurrence(priorDay.getDate()));
    sqlite(`
      CREATE TABLE plaid_transactions (
        transaction_id TEXT PRIMARY KEY, account_id TEXT, date TEXT, authorized_date TEXT,
        name TEXT, merchant_name TEXT, amount REAL, pending INTEGER, category TEXT,
        currency TEXT, updated_at TEXT
      );
      INSERT INTO plaid_transactions VALUES
        ('t1','acc1','${todayText}',NULL,'PURCHASE ONE','Purchase One',80,0,NULL,'USD','${todayText} 11:59:00'),
        ('t2','acc1','${todayText}',NULL,'PURCHASE TWO','Purchase Two',10,0,NULL,'USD','${todayText} 12:02:00'),
        ('t3','acc1','${todayText}',NULL,'DEPOSIT','Deposit',-6,0,NULL,'USD','${todayText} 12:03:00'),
        ('t4','acc1','${todayText}',NULL,'PURCHASE PENDING','Purchase Pending',25,1,NULL,'USD','${todayText} 12:04:00');
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
    // Pending amounts aren't final, so they're kept out of spent_today and
    // surfaced separately instead.
    assert.equal(body.spent_today, 90);
    assert.equal(body.spent_today_pending, 25);
    // The pending purchase (t4) shows up as needing review; once reviewed
    // it disappears from a follow-up read, but stays counted in spent_today_pending
    // since reviewing only acknowledges it — it doesn't change pending status.
    assert.deepEqual(body.pending_review.map((r) => r.id), ['t4']);
    assert.equal(body.pending_review[0].merchant_raw, 'Purchase Pending');

    const reviewResponse = await fetch(`http://127.0.0.1:${port}/api/financials/review/t4`, {
      method: 'PATCH',
      headers: { Authorization: 'Bearer test-token' },
    });
    assert.equal(reviewResponse.status, 200);
    const afterReview = await fetch(`http://127.0.0.1:${port}/api/financials`, {
      headers: { Authorization: 'Bearer test-token' },
    }).then((r) => r.json());
    assert.deepEqual(afterReview.pending_review, []);
    assert.equal(afterReview.spent_today_pending, 25);

    const missingReviewResponse = await fetch(`http://127.0.0.1:${port}/api/financials/review/does-not-exist`, {
      method: 'PATCH',
      headers: { Authorization: 'Bearer test-token' },
    });
    assert.equal(missingReviewResponse.status, 404);
    // Every active monthly expense recurs forever until deleted: "Already
    // passed" still shows, just rolled forward to its next occurrence.
    const byName = Object.fromEntries(body.upcoming_transactions.map((entry) => [entry.name, entry]));
    assert.deepEqual(Object.keys(byName).sort(), ['Already passed', 'Due today A', 'Due today B']);
    assert.equal(byName['Already passed'].due_date, alreadyPassedDueDate);
    assert.equal(byName['Due today A'].due_date, todayText);
    assert.equal(byName['Due today B'].due_date, todayText);
    assert.deepEqual(Object.keys(body).sort(), ['budget', 'currency', 'pending_review', 'spent_today', 'spent_today_pending', 'upcoming_transactions']);

    const html = await fetch(`http://127.0.0.1:${port}/`).then((result) => result.text());
    assert.match(html, /id="reviewButton"/);
    assert.match(html, /id="reviewBadge"/);
    assert.match(html, /id="reviewOverlay"/);
    assert.match(html, /id="financePasscodeOverlay"/);
    assert.match(html, /id="financePasscodeForm"/);
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
