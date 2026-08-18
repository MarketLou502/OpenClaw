#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const SERVER = path.join(__dirname, 'server.js');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sse-push-contract-'));
const db = path.join(tempDir, 'finance.db');
const tokenFile = path.join(tempDir, 'token');
fs.writeFileSync(tokenFile, 'test-token\n', { mode: 0o600 });

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

// Parses "event: X\ndata: Y\n\n" frames off the raw SSE response stream in
// the background and appends them to `events` as they arrive.
function collectSse(response) {
  const events = [];
  let buffer = '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let sep;
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const eventMatch = frame.match(/^event: (.+)$/m);
          const dataMatch = frame.match(/^data: (.+)$/m);
          if (eventMatch && dataMatch) events.push({ topic: eventMatch[1], payload: JSON.parse(dataMatch[1]) });
        }
      }
    } catch {}
  })();
  return { events, cancel: () => reader.cancel().catch(() => {}) };
}

async function waitForNextEvent(collector, topic, afterIndex, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    for (let i = afterIndex; i < collector.events.length; i += 1) {
      if (collector.events[i].topic === topic) return collector.events[i];
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for SSE event '${topic}' after index ${afterIndex}`);
}

(async () => {
  let child;
  let sse;
  try {
    sqlite(`
      CREATE TABLE plaid_transactions (
        transaction_id TEXT PRIMARY KEY, account_id TEXT, date TEXT, authorized_date TEXT,
        name TEXT, merchant_name TEXT, amount REAL, pending INTEGER, category TEXT,
        currency TEXT, updated_at TEXT
      );
      INSERT INTO plaid_transactions VALUES
        ('t1','acc1','2026-01-01',NULL,'PURCHASE','Purchase',10,0,NULL,'USD','2026-01-01 12:00:00');
      CREATE TABLE expenses (
        id INTEGER PRIMARY KEY, name TEXT, amount_est REAL, due_day INTEGER,
        recurrence TEXT, is_negotiable INTEGER, active INTEGER, notes TEXT
      );
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

    // EventSource can't set headers, so /api/events also accepts the token
    // as a query param — confirm that path actually authenticates.
    const sseResponse = await fetch(`http://127.0.0.1:${port}/api/events?token=test-token`);
    assert.equal(sseResponse.status, 200);
    assert.match(sseResponse.headers.get('content-type'), /text\/event-stream/);
    sse = collectSse(sseResponse);

    // A mutation through the normal handler (financials/expenses) broadcasts
    // fresh financials to any open SSE connection.
    let before = sse.events.length;
    const addResponse = await fetch(`http://127.0.0.1:${port}/api/financials/expenses`, {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Test Bill', amount_est: 5, due_day: 1 }),
    });
    assert.equal(addResponse.status, 201);
    const added = await waitForNextEvent(sse, 'financials', before);
    assert.ok(added.payload.upcoming_transactions.some((entry) => entry.name === 'Test Bill'));

    // /api/notify/financials is the path external writers (the finance
    // email parser) use to trigger a broadcast without going through this
    // process's own PATCH/POST handlers.
    before = sse.events.length;
    const notifyResponse = await fetch(`http://127.0.0.1:${port}/api/notify/financials`, {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token' },
    });
    assert.equal(notifyResponse.status, 200);
    await waitForNextEvent(sse, 'financials', before);

    // No token at all (and no header) is rejected same as any other route.
    const unauthorized = await fetch(`http://127.0.0.1:${port}/api/events`);
    assert.equal(unauthorized.status, 401);

    process.stdout.write('sse push contract test passed\n');
  } catch (error) {
    process.exitCode = 1;
    process.stderr.write(`${error.stack || error.message}\n`);
  } finally {
    if (sse) sse.cancel();
    if (child) child.kill('SIGTERM');
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
})();
