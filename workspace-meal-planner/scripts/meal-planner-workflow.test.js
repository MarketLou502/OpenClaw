#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawnSync } = require('node:child_process');
const { execute } = require('./meal-planner-workflow.js');

const NODE = '/opt/homebrew/opt/node@22/bin/node';
const SCRIPT = path.join(__dirname, 'meal-planner-workflow.js');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meal-planner-workflow-test-'));
const dbPath = path.join(tempDir, 'meal-planner.sqlite');
const tokenFile = path.join(tempDir, 'dashboard.token');
fs.writeFileSync(tokenFile, 'test-token');

// Fixed calorie/protein "already eaten today" + targets, served by a local
// stub instead of the real dashboard-api, so assemble-plan's math is
// deterministic and the test never touches production data.
let mockHealth = { calories: { current: 0, target: 2000 }, protein: { current: 0, target: 100 } };

const mockServer = http.createServer((req, res) => {
  if (req.url === '/api/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(mockHealth));
    return;
  }
  res.writeHead(404);
  res.end();
});

// Commands that don't touch the network run as a real CLI subprocess,
// exercising the actual argv-parsing path.
function run(args, expectedStatus = 0, envOverrides = {}) {
  const env = {
    ...process.env,
    MEAL_PLANNER_DB: dbPath,
    MEAL_PLANNER_NOW: '2026-07-31T12:00:00-04:00',
    NODE_NO_WARNINGS: '1',
    ...envOverrides,
  };
  const result = spawnSync(NODE, [SCRIPT, ...args], { encoding: 'utf8', env });
  assert.equal(result.status, expectedStatus, result.stderr || result.stdout);
  return JSON.parse(result.stdout.trim());
}

// get-plan/assemble-plan fetch GET /api/health over loopback. The sandbox
// this runs under allows a process to fetch its own freshly-bound loopback
// server, but blocks a *child* spawned via spawnSync from reaching it
// (confirmed by isolated repro) -- only pre-existing, already-running local
// services are reachable cross-process. So these two commands are exercised
// in-process via the exported `execute()` instead of spawnSync, against the
// mock server bound in this same process. The script itself is otherwise
// identical whether invoked as a CLI subprocess or required as a module --
// see the manual end-to-end plan in the project plan doc for a real
// cross-process check against the live dashboard-api.
async function runLive(args, expectedStatus = 0, dbOverride = dbPath) {
  process.env.MEAL_PLANNER_DB = dbOverride;
  process.env.MEAL_PLANNER_NOW = '2026-07-31T12:00:00-04:00';
  process.env.MEAL_PLANNER_DASHBOARD_URL = `http://127.0.0.1:${mockServer.address().port}`;
  process.env.MEAL_PLANNER_DASHBOARD_TOKEN_FILE = tokenFile;
  try {
    const result = await execute(args);
    assert.equal(expectedStatus, 0, `expected command to fail but it succeeded: ${JSON.stringify(result)}`);
    return result;
  } catch (error) {
    assert.equal(expectedStatus, 1, `expected command to succeed but it threw: ${error.message}`);
    return { ok: false, code: error.code, error: error.message };
  }
}

async function main() {
  await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
  try {
    const initialized = run(['init']);
    assert.equal(initialized.recipeCount, 0);

    // --- recipe CRUD ---

    const coffee = run([
      'add-recipe',
      '--name', 'Daily Coffee',
      '--type', 'quick',
      '--serving', '1 cup',
      '--calories', '50',
      '--protein', '1',
      '--meal-slot-hint', 'breakfast',
      '--tags', 'drink,low-cal',
      '--aliases', 'my coffee',
    ]);
    assert.equal(coffee.ok, true);
    assert.equal(coffee.recipe.ingredients.length, 0);

    const sandwich = run([
      'add-recipe',
      '--name', 'Tuna Salad Sandwich',
      '--type', 'quick',
      '--serving', '1 sandwich',
      '--calories', '315',
      '--protein', '19',
      '--meal-slot-hint', 'lunch',
      '--ingredients', 'tuna:2 cans,bread:2 slices',
    ]);
    assert.equal(sandwich.recipe.ingredients.length, 2);
    assert.deepEqual(sandwich.recipe.ingredients[0], { name: 'tuna', quantity: '2 cans' });

    const burrito = run([
      'add-recipe',
      '--name', 'Frozen Burrito',
      '--type', 'quick',
      '--serving', '1 burrito',
      '--calories', '520',
      '--protein', '28',
      '--meal-slot-hint', 'dinner',
    ]);
    assert.equal(burrito.ok, true);

    const duplicate = run([
      'add-recipe',
      '--name', 'my coffee',
      '--type', 'quick',
      '--serving', '1 cup',
      '--calories', '50',
      '--protein', '1',
    ], 1);
    assert.equal(duplicate.code, 'DUPLICATE_RECIPE');

    const found = run(['find-recipe', '--query', 'my coffee']);
    assert.equal(found.found, true);
    assert.equal(found.recipe.name, 'Daily Coffee');

    const notFound = run(['find-recipe', '--query', 'nonexistent meal']);
    assert.equal(notFound.found, false);

    const listed = run(['list-recipes', '--active-only']);
    assert.equal(listed.recipes.length, 3);

    const updated = run(['update-recipe', '--match', 'Daily Coffee', '--calories', '55']);
    assert.equal(updated.recipe.calories, 55);
    assert.equal(updated.recipe.name, 'Daily Coffee');

    // --- plan assembly (in-process, against the mock health server) ---

    mockHealth = { calories: { current: 0, target: 2000 }, protein: { current: 0, target: 100 } };
    const assembled = await runLive(['assemble-plan']);
    assert.equal(assembled.ok, true);
    assert.equal(assembled.items.length >= 3, true, 'expected at least the 3 base slots filled');
    const slots = assembled.items.map((item) => item.slot);
    assert.ok(slots.includes('breakfast'));
    assert.ok(slots.includes('lunch'));
    assert.ok(slots.includes('dinner'));
    // The 3 base recipes alone (coffee/sandwich/burrito) total 48g protein
    // against a 100g target, but the snack-fill loop tops up with repeats of
    // the highest protein-density recipe (the sandwich) since no dedicated
    // snack recipe exists, closing the gap -- so this should NOT be flagged
    // insufficient.
    assert.equal(assembled.libraryInsufficient, false);
    assert.ok(assembled.plannedTotals.protein >= 85, `expected snack top-up to close most of the protein gap, got ${assembled.plannedTotals.protein}`);

    const fetched = await runLive(['get-plan']);
    assert.equal(fetched.items.length, assembled.items.length);
    assert.equal(fetched.status, 'draft');

    // A target far beyond what repeats of the library can reach should be
    // flagged. Uses a distinct date so it doesn't touch today's plan (whose
    // item ids the rest of this test still needs).
    const savedMockHealth = mockHealth;
    mockHealth = { calories: { current: 0, target: 4000 }, protein: { current: 0, target: 300 } };
    const unreachable = await runLive(['assemble-plan', '--date', '2026-01-01']);
    assert.equal(unreachable.libraryInsufficient, true);
    mockHealth = savedMockHealth;

    // --- manual plan edits (no network -- real CLI subprocess) ---

    const breakfastItem = fetched.items.find((item) => item.slot === 'breakfast');
    const swapped = run(['swap-plan-item', '--item-id', breakfastItem.id, '--recipe-name', 'Tuna Salad Sandwich', '--calories', '300', '--protein', '18']);
    assert.equal(swapped.item.recipeName, 'Tuna Salad Sandwich');
    assert.equal(swapped.item.calories, 300);

    const afterSwap = await runLive(['get-plan']);
    assert.equal(afterSwap.items.find((item) => item.id === breakfastItem.id), undefined, 'swapped-out item should no longer be active');
    assert.equal(afterSwap.items.some((item) => item.id === swapped.item.id), true);

    const removedResult = run(['remove-plan-item', '--item-id', swapped.item.id]);
    assert.equal(removedResult.removedItemId, swapped.item.id);

    const afterRemove = await runLive(['get-plan']);
    assert.equal(afterRemove.items.some((item) => item.id === swapped.item.id), false);

    const added = run(['add-plan-item', '--slot', 'snack', '--recipe-name', 'Daily Coffee']);
    assert.equal(added.item.slot, 'snack');
    assert.equal(added.item.calories, 55);

    const missingItem = run(['remove-plan-item', '--item-id', 'not-a-real-id'], 1);
    assert.equal(missingItem.code, 'NOT_FOUND');

    const confirmed = run(['confirm-plan']);
    assert.equal(confirmed.status, 'confirmed');

    const noPlanYet = run(['confirm-plan', '--date', '2020-01-01'], 1);
    assert.equal(noPlanYet.code, 'NOT_FOUND');

    // --- assemble-plan reflects live "already eaten" totals ---

    mockHealth = { calories: { current: 1800, target: 2000 }, protein: { current: 90, target: 100 } };
    const tightBudget = await runLive(['get-plan']);
    assert.equal(tightBudget.alreadyEaten.calories, 1800);
    assert.ok(tightBudget.remaining.calories <= 200);

    // --- library-empty edge case ---

    const emptyLibDb = path.join(tempDir, 'empty-lib.sqlite');
    mockHealth = { calories: { current: 0, target: 2000 }, protein: { current: 0, target: 100 } };
    const emptyLibResult = await runLive(['assemble-plan'], 0, emptyLibDb);
    assert.equal(emptyLibResult.libraryInsufficient, true);
    assert.equal(emptyLibResult.items.length, 0);

    // --- recipe removal (back on the main test DB) ---

    const removedRecipe = run(['remove-recipe', '--name', 'Frozen Burrito']);
    assert.equal(removedRecipe.removed.name, 'Frozen Burrito');
    const goneRecipe = run(['find-recipe', '--query', 'Frozen Burrito']);
    assert.equal(goneRecipe.found, false);
    const listAfterRemoval = run(['list-recipes', '--active-only']);
    assert.equal(listAfterRemoval.recipes.length, 2);

    // --- validation errors ---

    const badType = run(['add-recipe', '--name', 'Bad', '--type', 'weird', '--serving', 'x', '--calories', '1', '--protein', '1'], 1);
    assert.equal(badType.code, 'INVALID_ARGUMENT');

    const badSlot = run(['add-plan-item', '--slot', 'midnight', '--recipe-name', 'Daily Coffee'], 1);
    assert.equal(badSlot.code, 'INVALID_ARGUMENT');

    process.stdout.write('meal-planner-workflow tests passed\n');
  } finally {
    await new Promise((resolve) => mockServer.close(resolve));
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
