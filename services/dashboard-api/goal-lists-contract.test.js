#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const SERVER = path.join(__dirname, 'server.js');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-lists-contract-'));
const tokenFile = path.join(tempDir, 'token');
const listsFile = path.join(tempDir, 'goal-lists.json');
fs.writeFileSync(tokenFile, 'test-token\n', { mode: 0o600 });
fs.writeFileSync(listsFile, JSON.stringify({ version: 1, lists: [{ id: 'guitar', name: 'Guitar', goalId: 'guitar', items: [] }] }));

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
  });
}

async function waitForServer(port) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('dashboard test server did not start');
}

async function call(port, pathname, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    ...options,
    headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
  });
  return { status: response.status, body: await response.json() };
}

(async () => {
  let child;
  try {
    const port = await freePort();
    child = spawn(process.execPath, [SERVER], { env: { ...process.env, DASHBOARD_API_HOST: '127.0.0.1',
      DASHBOARD_API_PORT: String(port), DASHBOARD_API_TOKEN_FILE: tokenFile, LISTS_FILE: listsFile }, stdio: 'ignore' });
    await waitForServer(port);
    let result = await call(port, '/api/lists');
    assert.equal(result.body.lists.length, 1);
    result = await call(port, '/api/lists/guitar/items', { method: 'POST', body: JSON.stringify({ text: 'Learn Blackbird' }) });
    assert.equal(result.status, 201);
    const itemId = result.body.id;
    result = await call(port, `/api/lists/guitar/items/${itemId}`, { method: 'PATCH', body: JSON.stringify({ done: true }) });
    assert.equal(result.body.done, true);
    result = await call(port, `/api/lists/guitar/items/${itemId}`, { method: 'PATCH', body: JSON.stringify({ text: 'Learn Blackbird intro' }) });
    assert.equal(result.body.text, 'Learn Blackbird intro');
    result = await call(port, `/api/lists/guitar/items/${itemId}`, { method: 'DELETE' });
    assert.equal(result.body.removed.id, itemId);
    result = await call(port, '/api/lists', { method: 'POST', body: JSON.stringify({ name: 'Books' }) });
    assert.equal(result.body.name, 'Books');
    const html = await fetch(`http://127.0.0.1:${port}/`).then((response) => response.text());
    assert.match(html, /id="goalListsButton"/);
    assert.match(html, /id="goalListsOverlay"/);
    process.stdout.write('goal lists contract test passed\n');
  } catch (error) {
    process.exitCode = 1;
    process.stderr.write(`${error.stack || error.message}\n`);
  } finally {
    if (child) child.kill('SIGTERM');
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
})();
