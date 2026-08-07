#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

process.env.NODE_NO_WARNINGS = '1';
const { execute } = require('./health-workflow.js');

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'health-dashboard-sync-test-'));
  const tokenFile = path.join(tempDir, 'token');
  const dbPath = path.join(tempDir, 'health.sqlite');
  fs.writeFileSync(tokenFile, 'test-token\n');
  const captured = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      captured.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      });
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    process.env.HEALTH_LEDGER_DB = dbPath;
    process.env.HEALTH_DASHBOARD_URL = `http://127.0.0.1:${address.port}`;
    process.env.HEALTH_DASHBOARD_TOKEN_FILE = tokenFile;
    process.env.HEALTH_NOW = '2026-07-31T17:00:00-04:00';
    delete process.env.HEALTH_DASHBOARD_SYNC;
    const result = await execute([
      'log-food',
      '--name', 'Dashboard sync test food',
      '--serving', '1 test serving',
      '--calories', '123',
      '--protein', '12.5',
      '--resolution-type', 'estimate',
      '--confidence', '0.5',
      '--idempotency-key', 'dashboard-sync-test',
    ]);
    // log-food still pushes no calories/protein value — dashboard-api
    // computes those live from the ledger on read — but it does send a
    // notify-only ping so dashboard-api recomputes and broadcasts fresh
    // totals over SSE to any open dashboard connection.
    assert.deepEqual(result.dashboard, { attempted: true, ok: true, healthUpdated: false, runGoalUpdated: false });
    assert.equal(result.reply, 'Got that logged.');
    assert.equal(captured.length, 1);
    assert.deepEqual(captured[0], {
      method: 'POST',
      url: '/api/notify/health',
      authorization: 'Bearer test-token',
      body: {},
    });

    const hourly = await execute([
      'log-workout',
      '--slot-hour', '13',
      '--idempotency-key', 'dashboard-hourly-test',
    ]);
    assert.equal(hourly.dashboard.ok, true);
    assert.equal(hourly.reply, 'Got that logged.');
    assert.deepEqual(captured[1], {
      method: 'PATCH',
      url: '/api/health',
      authorization: 'Bearer test-token',
      body: { hourlyWorkouts: { current: 1, target: 8, unit: '' } },
    });
    assert.deepEqual(captured[2], {
      method: 'POST',
      url: '/api/notify/health',
      authorization: 'Bearer test-token',
      body: {},
    });

    const run = await execute([
      'log-daily-run',
      '--idempotency-key', 'dashboard-run-test',
    ]);
    assert.equal(run.dashboard.ok, true);
    assert.equal(run.entry.durationMinutes, 30);
    assert.deepEqual(captured[3], {
      method: 'PATCH',
      url: '/api/goals/workout-run',
      authorization: 'Bearer test-token',
      body: { done: true },
    });
    assert.deepEqual(captured[4], {
      method: 'POST',
      url: '/api/notify/health',
      authorization: 'Bearer test-token',
      body: {},
    });
    process.stdout.write('health dashboard sync test passed\n');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
