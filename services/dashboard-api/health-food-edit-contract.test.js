#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const SERVER = path.join(__dirname, 'server.js');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'health-food-edit-contract-'));
const tokenFile = path.join(tempDir, 'token');
const workflowScript = path.join(tempDir, 'health-workflow.js');
fs.writeFileSync(tokenFile, 'test-token\n', { mode: 0o600 });
fs.writeFileSync(workflowScript, `
const args = process.argv.slice(2);
if (args[0] !== 'correct-food') process.exit(2);
const value = (name) => args[args.indexOf(name) + 1];
process.stdout.write(JSON.stringify({
  ok: true,
  entry: { id: 'replacement-id', calories: Number(value('--calories')), protein: Number(value('--protein')) },
  totals: { calories: 500, protein: 40 }
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
        HEALTH_WORKFLOW_SCRIPT: workflowScript,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitForServer(port);
    const response = await fetch(`http://127.0.0.1:${port}/api/health/foods/original-id`, {
      method: 'PATCH',
      headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ calories: 250.5, protein: 20 }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.replacedEntryId, 'original-id');
    assert.deepEqual(body.entry, { id: 'replacement-id', calories: 250.5, protein: 20 });
    assert.deepEqual(body.totals, { calories: 500, protein: 40 });

    const invalidResponse = await fetch(`http://127.0.0.1:${port}/api/health/foods/original-id`, {
      method: 'PATCH',
      headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ calories: -1, protein: 20 }),
    });
    assert.equal(invalidResponse.status, 400);

    const app = fs.readFileSync(path.join(__dirname, 'public', 'app.js'), 'utf8');
    assert.match(app, /class="today-food-calories"/);
    assert.match(app, /class="today-food-protein"/);
    assert.match(app, /method: 'PATCH'/);
    process.stdout.write('health food edit contract test passed\n');
  } catch (error) {
    process.exitCode = 1;
    process.stderr.write(`${error.stack || error.message}\n`);
  } finally {
    if (child) child.kill('SIGTERM');
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
})();
