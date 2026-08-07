#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const SERVER = path.join(__dirname, 'server.js');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meal-planner-contract-'));
const tokenFile = path.join(tempDir, 'token');
const workflowScript = path.join(tempDir, 'meal-planner-workflow.js');
fs.writeFileSync(tokenFile, 'test-token\n', { mode: 0o600 });

// Stub stands in for the real meal-planner-workflow.js -- this test is only
// exercising dashboard-api's HTTP contract (arg-building, status-code
// mapping, SSE broadcast), not the workflow script's own logic (that's
// meal-planner-workflow.test.js's job).
fs.writeFileSync(workflowScript, `
const args = process.argv.slice(2);
const command = args[0];
const value = (name) => { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1]; };
const hasFlag = (name) => args.includes(name);

if (command === 'add-recipe') {
  if (value('--name') === 'Daily Coffee') {
    process.stdout.write(JSON.stringify({ ok: false, code: 'DUPLICATE_RECIPE', error: "A recipe named or aliased 'Daily Coffee' already exists" }));
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({
    ok: true,
    operation: 'add-recipe',
    recipe: { id: 'r1', name: value('--name'), type: value('--type'), calories: Number(value('--calories')), protein: Number(value('--protein')), ingredients: [], tags: [], aliases: [] },
  }));
  process.exit(0);
}

if (command === 'get-plan') {
  process.stdout.write(JSON.stringify({
    ok: true,
    operation: 'get-plan',
    date: '2026-08-02',
    status: 'draft',
    items: [{ id: 'mp1', slot: 'breakfast', recipeId: 'r1', recipeName: 'Daily Coffee', calories: 55, protein: 1, status: 'planned' }],
    plannedTotals: { calories: 55, protein: 1 },
    alreadyEaten: { calories: 0, protein: 0 },
    totals: { calories: 55, protein: 1 },
    targets: { calories: 3250, protein: 160 },
    remaining: { calories: 3195, protein: 159 },
    healthUnavailable: false,
  }));
  process.exit(0);
}

if (command === 'assemble-plan') {
  process.stdout.write(JSON.stringify({
    ok: true,
    operation: 'assemble-plan',
    date: '2026-08-02',
    status: 'draft',
    items: [{ id: 'mp1', slot: 'breakfast', recipeId: 'r1', recipeName: 'Daily Coffee', calories: 55, protein: 1, status: 'planned' }],
    plannedTotals: { calories: 55, protein: 1 },
    alreadyEaten: { calories: 0, protein: 0 },
    totals: { calories: 55, protein: 1 },
    targets: { calories: 3250, protein: 160 },
    remaining: { calories: 3195, protein: 159 },
    healthUnavailable: false,
    libraryInsufficient: true,
    reply: "Planned what I can, but the taught recipes can't reach today's targets yet.",
  }));
  process.exit(0);
}

if (command === 'swap-plan-item') {
  if (value('--item-id') !== 'mp1') {
    process.stdout.write(JSON.stringify({ ok: false, code: 'NOT_FOUND', error: "No active plan item 'unknown-id' was found" }));
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({
    ok: true,
    operation: 'swap-plan-item',
    replacedItemId: 'mp1',
    item: { id: 'mp2', slot: 'breakfast', recipeId: 'r2', recipeName: value('--recipe-name') || 'unknown', calories: 300, protein: 18, status: 'planned' },
  }));
  process.exit(0);
}

if (command === 'remove-plan-item') {
  if (value('--item-id') !== 'mp1') {
    process.stdout.write(JSON.stringify({ ok: false, code: 'NOT_FOUND', error: "No active plan item 'unknown-id' was found" }));
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({ ok: true, operation: 'remove-plan-item', removedItemId: 'mp1' }));
  process.exit(0);
}

process.exit(2);
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
        MEAL_PLANNER_WORKFLOW_SCRIPT: workflowScript,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitForServer(port);
    const auth = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' };

    // add-recipe -> 201
    const addResponse = await fetch(`http://127.0.0.1:${port}/api/meal-planner/recipes`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ name: 'Tuna Salad Sandwich', type: 'quick', serving: '1 sandwich', calories: 315, protein: 19 }),
    });
    assert.equal(addResponse.status, 201);
    const added = await addResponse.json();
    assert.equal(added.name, 'Tuna Salad Sandwich');
    assert.equal(added.calories, 315);

    // duplicate add-recipe -> 409
    const dupResponse = await fetch(`http://127.0.0.1:${port}/api/meal-planner/recipes`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ name: 'Daily Coffee', type: 'quick', serving: '1 cup', calories: 50, protein: 1 }),
    });
    assert.equal(dupResponse.status, 409);

    // get-plan is read-only -- calling it twice must not mutate/re-assemble
    const planResponse1 = await fetch(`http://127.0.0.1:${port}/api/meal-planner/plan`, { headers: auth });
    assert.equal(planResponse1.status, 200);
    const plan1 = await planResponse1.json();
    assert.equal(plan1.operation, 'get-plan');
    assert.equal(plan1.status, 'draft');
    assert.deepEqual(plan1.targets, { calories: 3250, protein: 160 });

    const planResponse2 = await fetch(`http://127.0.0.1:${port}/api/meal-planner/plan`, { headers: auth });
    const plan2 = await planResponse2.json();
    assert.deepEqual(plan1, plan2);

    // assemble-plan -> drafts a plan, surfaces libraryInsufficient
    const assembleResponse = await fetch(`http://127.0.0.1:${port}/api/meal-planner/plan/assemble`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({}),
    });
    assert.equal(assembleResponse.status, 200);
    const assembled = await assembleResponse.json();
    assert.equal(assembled.operation, 'assemble-plan');
    assert.equal(assembled.libraryInsufficient, true);

    // swap-plan-item -> 200, unknown id -> 404
    const swapResponse = await fetch(`http://127.0.0.1:${port}/api/meal-planner/plan/items/mp1`, {
      method: 'PATCH',
      headers: auth,
      body: JSON.stringify({ recipeName: 'Boost Protein Shake' }),
    });
    assert.equal(swapResponse.status, 200);
    const swapped = await swapResponse.json();
    assert.equal(swapped.recipeName, 'Boost Protein Shake');

    const swapMissingResponse = await fetch(`http://127.0.0.1:${port}/api/meal-planner/plan/items/unknown-id`, {
      method: 'PATCH',
      headers: auth,
      body: JSON.stringify({ recipeName: 'Boost Protein Shake' }),
    });
    assert.equal(swapMissingResponse.status, 404);

    // remove-plan-item -> 200, unknown id -> 404
    const removeResponse = await fetch(`http://127.0.0.1:${port}/api/meal-planner/plan/items/mp1`, {
      method: 'DELETE',
      headers: auth,
    });
    assert.equal(removeResponse.status, 200);
    const removed = await removeResponse.json();
    assert.equal(removed.ok, true);

    const removeMissingResponse = await fetch(`http://127.0.0.1:${port}/api/meal-planner/plan/items/unknown-id`, {
      method: 'DELETE',
      headers: auth,
    });
    assert.equal(removeMissingResponse.status, 404);

    // shipped frontend actually wires these routes up, not just the server
    const app = fs.readFileSync(path.join(__dirname, 'public', 'app.js'), 'utf8');
    assert.match(app, /\/api\/meal-planner\/plan/);
    assert.match(app, /\/api\/meal-planner\/plan\/assemble/);
    assert.match(app, /getElementById\('mealPlanDetailsButton'\)/);
    assert.match(app, /getElementById\('mealPlanStat'\)/);
    const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
    assert.match(html, />Meal Planner</);
    assert.match(html, /id="mealPlanDetailsButton"/);
    assert.match(html, /id="mealPlanStat"/);

    process.stdout.write('meal planner contract test passed\n');
  } catch (error) {
    process.exitCode = 1;
    process.stderr.write(`${error.stack || error.message}\n`);
  } finally {
    if (child) child.kill('SIGTERM');
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
})();
