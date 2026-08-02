#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const SERVER = path.join(__dirname, 'server.js');
const DASHBOARD_APP = path.join(__dirname, 'public', 'app.js');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calendar-dashboard-contract-'));
const tokenFile = path.join(tempDir, 'token');
const rangeScript = path.join(tempDir, 'calendar-range.js');
fs.writeFileSync(tokenFile, 'test-token\n', { mode: 0o600 });
fs.writeFileSync(rangeScript, `
process.stdout.write(JSON.stringify({
  month: process.argv[2],
  events: [
    { id: 'one', date: '2026-08-03', title: 'Dentist', start: '9:00', end: '10:00', allDay: false },
    { id: 'two', date: '2026-08-03', title: 'Vacation', start: '0:00', end: '23:59', allDay: true },
    { id: 'three', date: '2026-08-28', title: 'Dinner', start: '18:30', end: '20:00', allDay: false }
  ]
}));
`, { mode: 0o700 });

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
  for (let attempt = 0; attempt < 60; attempt += 1) {
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
    const port = await freePort();
    child = spawn(process.execPath, [SERVER], {
      env: {
        ...process.env,
        DASHBOARD_API_HOST: '127.0.0.1',
        DASHBOARD_API_PORT: String(port),
        DASHBOARD_API_TOKEN_FILE: tokenFile,
        CALENDAR_READ_RANGE_SCRIPT: rangeScript,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitForServer(port);
    const response = await fetch(`http://127.0.0.1:${port}/api/calendar?month=2026-08`, {
      headers: { Authorization: 'Bearer test-token' },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.month, '2026-08');
    assert.deepEqual(body.events.map((event) => event.date), ['2026-08-03', '2026-08-03', '2026-08-28']);
    assert.equal(body.events[0].start, '09:00');
    assert.equal(body.events[1].allDay, true);

    const html = await fetch(`http://127.0.0.1:${port}/`).then((res) => res.text());
    assert.match(html, /id="calendarDayView"/);
    assert.match(html, /id="calendarMonthView"/);
    assert.match(html, /id="calendarMonthGrid"/);
    assert.match(html, /data-board="work"/);
    assert.doesNotMatch(html, />Accenture</);

    const dashboardApp = fs.readFileSync(DASHBOARD_APP, 'utf8');
    assert.match(dashboardApp, /const CAL_START_HOUR = 7;/);
    assert.match(dashboardApp, /const CAL_END_HOUR = 22;/);
    assert.match(dashboardApp, /const CAL_VISIBLE_HOURS = 5;/);
    assert.match(dashboardApp, /function openCalendarDayView\(dateKey\)/);
    assert.match(dashboardApp, /cell\.addEventListener\('click', \(\) => \{\s*openCalendarDayView\(dateKey\);/);
    assert.match(dashboardApp, /load\(`\/api\/calendar\?date=\$\{dateKey\}`/);
    process.stdout.write('calendar dashboard contract test passed\n');
  } catch (error) {
    process.exitCode = 1;
    process.stderr.write(`${error.stack || error.message}\n`);
  } finally {
    if (child) child.kill('SIGTERM');
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
})();
