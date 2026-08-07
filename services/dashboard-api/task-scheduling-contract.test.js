#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const SERVER = path.join(__dirname, 'server.js');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-scheduling-contract-'));
const tasksDir = path.join(tempDir, 'tasks');
fs.mkdirSync(tasksDir);
for (const board of ['work', 'personal', 'market-lou']) {
  fs.writeFileSync(path.join(tasksDir, `${board}.json`), JSON.stringify({ items: board === 'work' ? [
    { id: 'abc12345', text: 'Send invoice', done: false, added: '2026-08-03', doneDate: null },
  ] : [] }));
}
const tokenFile = path.join(tempDir, 'token');
const credentialsFile = path.join(tempDir, 'google.json');
fs.writeFileSync(tokenFile, 'test-token\n');
fs.writeFileSync(credentialsFile, JSON.stringify({ client_id: 'x', client_secret: 'y', refresh_token: 'z' }));

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

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function waitForServer(port) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/app.js`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('dashboard test server did not start');
}

async function request(port, method, pathname, body) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const parsed = await response.json();
  return { status: response.status, body: parsed };
}

(async () => {
  let child;
  let google;
  try {
    const dashboardPort = await freePort();
    const googlePort = await freePort();
    const events = new Map();
    let creates = 0;
    let updates = 0;
    let deletes = 0;
    google = http.createServer((req, res) => {
      if (req.url === '/token') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ access_token: 'fake' }));
        return;
      }
      if (req.method === 'POST' && /\/events$/.test(req.url)) {
        creates += 1;
        const id = `event-${creates}`;
        events.set(id, true);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id }));
        return;
      }
      const match = req.url.match(/\/events\/([^?]+)/);
      if (req.method === 'PATCH' && match) {
        updates += 1;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: decodeURIComponent(match[1]) }));
        return;
      }
      if (req.method === 'DELETE' && match) {
        deletes += 1;
        events.delete(decodeURIComponent(match[1]));
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await listen(google, googlePort);

    child = spawn(process.execPath, [SERVER], {
      env: {
        ...process.env,
        DASHBOARD_API_HOST: '127.0.0.1',
        DASHBOARD_API_PORT: String(dashboardPort),
        DASHBOARD_API_TOKEN_FILE: tokenFile,
        TASKS_DIR: tasksDir,
        TASK_SCHEDULE_OPERATIONS_FILE: path.join(tempDir, 'operations.json'),
        OPENCLAW_GOOGLE_CALENDAR_CREDENTIALS: credentialsFile,
        OPENCLAW_GOOGLE_TOKEN_URL: `http://127.0.0.1:${googlePort}/token`,
        OPENCLAW_GOOGLE_CALENDAR_API_BASE: `http://127.0.0.1:${googlePort}/calendar/v3`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitForServer(dashboardPort);

    const first = await request(dashboardPort, 'POST', '/api/tasks/work/abc12345/schedule', {
      startsAt: '2026-08-04T14:00:00-04:00', durationMinutes: 30,
      timezone: 'America/New_York', expectedVersion: 1, idempotencyKey: 'create-one',
    });
    assert.equal(first.status, 200);
    assert.equal(first.body.version, 2);
    assert.equal(first.body.schedule.calendarEventId, 'event-1');
    assert.equal(creates, 1);

    const duplicate = await request(dashboardPort, 'POST', '/api/tasks/work/abc12345/schedule', {
      startsAt: '2026-08-04T14:00:00-04:00', durationMinutes: 30,
      timezone: 'America/New_York', expectedVersion: 1, idempotencyKey: 'create-one',
    });
    assert.equal(duplicate.status, 200);
    assert.equal(creates, 1, 'idempotent retry must not create another event');

    const stale = await request(dashboardPort, 'PATCH', '/api/tasks/work/abc12345/schedule', {
      startsAt: '2026-08-05T15:30:00-04:00', durationMinutes: 30,
      timezone: 'America/New_York', expectedVersion: 1, idempotencyKey: 'stale-move',
    });
    assert.equal(stale.status, 409);
    assert.equal(updates, 0, 'stale task must be rejected before calendar mutation');

    const moved = await request(dashboardPort, 'PATCH', '/api/tasks/work/abc12345/schedule', {
      startsAt: '2026-08-05T15:30:00-04:00', durationMinutes: 30,
      timezone: 'America/New_York', expectedVersion: 2, idempotencyKey: 'move-one',
    });
    assert.equal(moved.status, 200);
    assert.equal(moved.body.version, 3);
    assert.equal(updates, 1);

    const completed = await request(dashboardPort, 'PATCH', '/api/tasks/work/abc12345', { done: true, expectedVersion: 3 });
    assert.equal(completed.status, 200);
    assert.equal(completed.body.version, 4);
    assert.equal(completed.body.schedule.calendarEventId, 'event-1');
    assert.equal(deletes, 0, 'completion retains calendar history');

    process.stdout.write('task scheduling contract test passed\n');
  } catch (error) {
    process.exitCode = 1;
    process.stderr.write(`${error.stack || error.message}\n`);
  } finally {
    if (child) child.kill('SIGTERM');
    if (google) await close(google);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
})();
