#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const SCRIPT = path.join(__dirname, 'calendar-workflow.js');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calendar-workflow-test-'));
const credentialsFile = path.join(tempDir, 'credentials.json');
fs.writeFileSync(credentialsFile, JSON.stringify({
  client_id: 'test-client', client_secret: 'test-secret', refresh_token: 'test-refresh',
}), 'utf8');

let events = [
  {
    id: 'event-dentist',
    summary: 'Dentist',
    start: { dateTime: '2026-08-02T10:00:00-04:00' },
    end: { dateTime: '2026-08-02T11:00:00-04:00' },
  },
  {
    id: 'event-meeting-1',
    summary: 'Meeting',
    start: { dateTime: '2026-08-02T12:00:00-04:00' },
    end: { dateTime: '2026-08-02T13:00:00-04:00' },
  },
  {
    id: 'event-meeting-2',
    summary: 'Meeting',
    start: { dateTime: '2026-08-02T15:00:00-04:00' },
    end: { dateTime: '2026-08-02T16:00:00-04:00' },
  },
];

function sendJson(res, status, body) {
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
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/token') return sendJson(res, 200, { access_token: 'test-access-token' });
  if (req.headers.authorization !== 'Bearer test-access-token') return sendJson(res, 401, { error: { message: 'unauthorized' } });

  const eventPrefix = '/calendar/v3/calendars/aaron%40marketlou.com/events';
  if (!url.pathname.startsWith(eventPrefix)) return sendJson(res, 404, { error: { message: 'not found' } });
  const eventId = decodeURIComponent(url.pathname.slice(eventPrefix.length).replace(/^\//, ''));

  if (!eventId && req.method === 'GET') return sendJson(res, 200, { items: events });
  if (!eventId && req.method === 'POST') {
    const body = await readBody(req);
    const event = { id: 'event-new', ...body };
    events.push(event);
    return sendJson(res, 200, event);
  }
  const index = events.findIndex((event) => event.id === eventId);
  if (index < 0) return sendJson(res, 404, { error: { message: 'event not found' } });
  if (req.method === 'PATCH') {
    const body = await readBody(req);
    events[index] = { ...events[index], ...body };
    return sendJson(res, 200, events[index]);
  }
  if (req.method === 'DELETE') {
    events.splice(index, 1);
    res.writeHead(204);
    return res.end();
  }
  return sendJson(res, 405, { error: { message: 'method not allowed' } });
});

function run(port, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      env: {
        ...process.env,
        OPENCLAW_GOOGLE_CALENDAR_CREDENTIALS: credentialsFile,
        OPENCLAW_GOOGLE_TOKEN_URL: `http://127.0.0.1:${port}/token`,
        OPENCLAW_GOOGLE_CALENDAR_API_BASE: `http://127.0.0.1:${port}/calendar/v3`,
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
    let result = await run(port, ['list', '--date', '2026-08-02']);
    assert.equal(result.status, 0);
    assert.equal(result.body.events.length, 3);
    assert.equal(result.body.events[0].eventId, 'event-dentist');

    result = await run(port, ['add', '--title', 'Migration Test', '--date', '2026-08-03', '--time', '09:30', '--duration', '45']);
    assert.equal(result.status, 0);
    assert.equal(events.find((event) => event.id === 'event-new').summary, 'Migration Test');

    result = await run(port, ['delete', '--title', 'Meeting', '--date', '2026-08-02']);
    assert.equal(result.status, 1);
    assert.equal(result.body.error.code, 'AMBIGUOUS_MATCH');
    assert.equal(events.filter((event) => event.summary === 'Meeting').length, 2);

    result = await run(port, [
      'reschedule', '--title', 'Dentist', '--date', '2026-08-02',
      '--new-date', '2026-08-04', '--new-time', '14:15',
    ]);
    assert.equal(result.status, 0);
    assert.equal(result.body.eventId, 'event-dentist');
    assert.equal(events.find((event) => event.id === 'event-dentist').start.dateTime, '2026-08-04T14:15:00');

    result = await run(port, ['delete', '--title', 'Migration Test', '--date', '2026-08-03']);
    assert.equal(result.status, 0);
    assert.equal(events.some((event) => event.id === 'event-new'), false);

    process.stdout.write('calendar-workflow tests passed\n');
  } catch (error) {
    process.exitCode = 1;
    process.stderr.write(`${error.stack || error.message}\n`);
  } finally {
    server.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

