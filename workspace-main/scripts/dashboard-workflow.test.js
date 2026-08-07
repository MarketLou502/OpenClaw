#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const SCRIPT = path.join(__dirname, 'dashboard-workflow.js');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-workflow-test-'));
const tokenFile = path.join(tempDir, 'token');
const logDir = path.join(tempDir, 'logs');
fs.writeFileSync(tokenFile, 'test-token\n', 'utf8');

const state = {
  work: [{ id: 'a1', text: 'Prepare status report', done: false, version: 1, schedule: null }],
  'market-lou': [{ id: 'm1', text: 'Call vendor', done: false, version: 1, schedule: null }],
  personal: [
    { id: 'p1', text: 'Call dentist', done: false, version: 1, schedule: null },
    { id: 'p2', text: 'Call plumber', done: false, version: 1, schedule: null },
  ],
  grocery: [{ id: 'g1', text: 'Milk', done: false }],
  goals: [
    { id: 'guitar', label: 'Guitar', done: false },
    { id: 'spanish', label: 'Spanish', done: false },
  ],
};

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => resolve(raw ? JSON.parse(raw) : {}));
  });
}

const server = http.createServer(async (req, res) => {
  if (req.headers.authorization !== 'Bearer test-token') return json(res, 401, { error: 'unauthorized' });
  const parts = req.url.split('?')[0].split('/').filter(Boolean);
  let collection;
  let id;
  if (parts[1] === 'tasks') {
    collection = parts[2];
    id = parts[3];
  } else if (parts[1] === 'grocery') {
    collection = 'grocery';
    id = parts[2];
  } else if (parts[1] === 'goals') {
    collection = 'goals';
    id = parts[2];
  }
  if (!state[collection]) return json(res, 404, { error: 'not found' });
  if (req.method === 'GET') {
    return json(res, 200, collection === 'goals' ? { goals: state.goals } : { items: state[collection] });
  }
  if (req.method === 'POST' && parts[4] === 'schedule') {
    const body = await readBody(req);
    const item = state[collection].find((candidate) => candidate.id === id);
    item.schedule = { startsAt: body.startsAt, durationMinutes: 30, timezone: body.timezone, calendarEventId: 'event-1' };
    item.version += 1;
    return json(res, 200, item);
  }
  if (req.method === 'POST') {
    const body = await readBody(req);
    const item = { id: `new-${state[collection].length}`, text: body.text, done: false };
    state[collection].push(item);
    return json(res, 201, item);
  }
  if (req.method === 'PATCH') {
    const body = await readBody(req);
    const item = state[collection].find((candidate) => candidate.id === id);
    if (!item) return json(res, 404, { error: 'not found' });
    if (parts[4] === 'schedule') {
      item.schedule = { startsAt: body.startsAt, durationMinutes: 30, timezone: body.timezone, calendarEventId: 'event-1' };
      item.version += 1;
      return json(res, 200, item);
    }
    item.done = !!body.done;
    return json(res, 200, item);
  }
  if (req.method === 'DELETE' && parts[4] === 'schedule') {
    const item = state[collection].find((candidate) => candidate.id === id);
    item.schedule = null;
    item.version += 1;
    return json(res, 200, item);
  }
  return json(res, 405, { error: 'method not allowed' });
});

function run(port, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      env: {
        ...process.env,
        OPENCLAW_DASHBOARD_API_BASE: `http://127.0.0.1:${port}`,
        OPENCLAW_DASHBOARD_TOKEN_FILE: tokenFile,
        OPENCLAW_DAILY_LOG_DIR: logDir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => {
      try { resolve({ status, body: JSON.parse(stdout) }); }
      catch (error) { reject(new Error(`Invalid child output: ${error.message}; stderr=${stderr}`)); }
    });
  });
}

server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port;
  try {
    let result = await run(port, ['list', '--board', 'all']);
    assert.equal(result.status, 0);
    assert.equal(result.body.boards.length, 3);

    result = await run(port, ['list', '--board', 'Accenture']);
    assert.equal(result.status, 0);
    assert.equal(result.body.board, 'work');

    result = await run(port, ['add', '--board', 'grocery', '--text', 'Eggs']);
    assert.equal(result.status, 0);
    assert.equal(state.grocery.at(-1).text, 'Eggs');

    result = await run(port, ['complete', '--query', 'dentist']);
    assert.equal(result.status, 0);
    assert.equal(state.personal.find((item) => item.id === 'p1').done, true);

    result = await run(port, ['complete', '--query', 'Call']);
    assert.equal(result.status, 1);
    assert.equal(result.body.error.code, 'AMBIGUOUS_MATCH');
    assert.equal(state.personal.find((item) => item.id === 'p2').done, false);

    result = await run(port, ['complete-habit', '--query', 'Guitar']);
    assert.equal(result.status, 0);
    assert.equal(state.goals.find((habit) => habit.id === 'guitar').done, true);
    assert.match(fs.readFileSync(path.join(logDir, `${new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date())}.md`), 'utf8'), /Habit done: Guitar/);

    result = await run(port, ['schedule', '--board', 'work', '--query', 'status', '--date', '2026-08-04', '--time', '14:00']);
    assert.equal(result.status, 0);
    assert.equal(state.work[0].schedule.startsAt.slice(0, 16), '2026-08-04T14:00');

    result = await run(port, ['reschedule', '--board', 'work', '--query', 'status', '--date', '2026-08-05', '--time', '15:30']);
    assert.equal(result.status, 0);
    assert.equal(state.work[0].schedule.startsAt.slice(0, 16), '2026-08-05T15:30');

    result = await run(port, ['unschedule', '--board', 'work', '--query', 'status']);
    assert.equal(result.status, 0);
    assert.equal(state.work[0].schedule, null);

    process.stdout.write('dashboard-workflow tests passed\n');
  } catch (error) {
    process.exitCode = 1;
    process.stderr.write(`${error.stack || error.message}\n`);
  } finally {
    server.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
