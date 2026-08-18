#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const NODE = '/opt/homebrew/opt/node@22/bin/node';
const SCRIPT = path.join(__dirname, 'health-workflow.js');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'health-workflow-test-'));
const dbPath = path.join(tempDir, 'health.sqlite');
const recipeDbPath = path.join(tempDir, 'recipes.sqlite');
const env = {
  ...process.env,
  HEALTH_LEDGER_DB: dbPath,
  HEALTH_RECIPE_DB: recipeDbPath,
  HEALTH_DASHBOARD_SYNC: 'off',
  HEALTH_NOW: '2026-07-31T12:00:00-04:00',
  NODE_NO_WARNINGS: '1',
};

function run(args, expectedStatus = 0) {
  const result = spawnSync(NODE, [SCRIPT, ...args], { encoding: 'utf8', env });
  assert.equal(result.status, expectedStatus, result.stderr || result.stdout);
  const parsed = JSON.parse(result.stdout.trim());
  return parsed;
}

try {
  const initialized = run(['init']);
  assert.equal(initialized.ok, true);

  // Seed a test recipe via add-recipe (creates the recipe DB tables too)
  const seed = run([
    'add-recipe',
    '--name', 'Daily coffee',
    '--serving', 'coffee with cream, milk, and 1 tbsp sugar',
    '--calories', '50',
    '--protein', '1',
    '--aliases', 'my coffee,coffee',
  ]);
  assert.equal(seed.ok, true);

  const recipe = run(['find-recipe', '--query', 'my coffee']);
  assert.equal(recipe.found, true);
  assert.equal(recipe.recipe.calories, 50);
  assert.equal(recipe.recipe.protein, 1);

  const recipeList = run(['list-recipes']);
  assert.equal(recipeList.recipes.length, 1);
  assert.ok(recipeList.recipes.some((r) => r.name === 'Daily coffee'));

  const newRecipe = run([
    'add-recipe',
    '--name', 'Test smoothie',
    '--serving', '1 bottle',
    '--calories', '600',
    '--protein', '45',
    '--aliases', 'my smoothie,test shake',
  ]);
  assert.equal(newRecipe.ok, true);
  const foundNewRecipe = run(['find-recipe', '--query', 'test shake']);
  assert.equal(foundNewRecipe.recipe.name, 'Test smoothie');

  const resolvedRecipe = run(['resolve-food', '--query', 'my coffee']);
  assert.equal(resolvedRecipe.recipe.calories, 50);
  assert.deepEqual(resolvedRecipe.usdaMatches, []);

  const resolvedUsda = run(['resolve-food', '--query', 'grilled chicken breast']);
  assert.equal(resolvedUsda.recipe, null);
  assert.ok(resolvedUsda.usdaMatches.length > 0);

  const duplicate = run([
    'add-recipe',
    '--name', 'My smoothie',
    '--serving', '1 bottle',
    '--calories', '610',
    '--protein', '46',
  ], 1);
  assert.equal(duplicate.code, 'DUPLICATE_RECIPE');

  const first = run([
    'log-food',
    '--name', 'Tuna salad sandwich',
    '--serving', '1 sandwich',
    '--calories', '315',
    '--protein', '19',
    '--resolution-type', 'staple',
    '--source-id', 'staple-tuna-salad-sandwich',
    '--confidence', '1',
    '--original', 'I ate my tuna sandwich',
    '--origin-channel', 'test',
    '--conversation-id', 'test-conversation',
    '--idempotency-key', 'test-log-1',
  ]);
  assert.equal(first.reply, 'Got that logged.');
  assert.deepEqual(first.totals, { calories: 315, protein: 19 });

  const duplicateLog = run([
    'log-food',
    '--name', 'Tuna salad sandwich',
    '--serving', '1 sandwich',
    '--calories', '315',
    '--protein', '19',
    '--resolution-type', 'staple',
    '--confidence', '1',
    '--idempotency-key', 'test-log-1',
  ]);
  assert.equal(duplicateLog.deduplicated, true);

  const second = run([
    'log-food',
    '--name', 'Apple',
    '--serving', '1 medium apple',
    '--calories', '95',
    '--protein', '0.5',
    '--resolution-type', 'usda',
    '--source-id', 'test-fdc-id',
    '--confidence', '0.9',
    '--conversation-id', 'test-conversation',
    '--idempotency-key', 'test-log-2',
  ]);
  assert.deepEqual(second.totals, { calories: 410, protein: 19.5 });

  const corrected = run([
    'correct-food',
    '--id', first.entry.id,
    '--quantity', '2',
    '--serving', '2 sandwiches',
    '--calories', '630',
    '--protein', '38',
    '--original', 'Actually I ate two',
    '--idempotency-key', 'test-correct-1',
  ]);
  assert.equal(corrected.reply, 'Updated.');
  assert.deepEqual(corrected.totals, { calories: 725, protein: 38.5 });

  const removed = run([
    'remove-food',
    '--id', second.entry.id,
    '--idempotency-key', 'test-remove-1',
  ]);
  assert.deepEqual(removed.totals, { calories: 630, protein: 38 });

  const undone = run([
    'undo',
    '--conversation-id', 'test-conversation',
    '--idempotency-key', 'test-undo-1',
  ]);
  assert.equal(undone.undoneOperation, 'remove-food');
  assert.deepEqual(undone.totals, { calories: 725, protein: 38.5 });

  const listed = run(['list-today']);
  assert.equal(listed.entries.length, 2);
  assert.deepEqual(listed.totals, { calories: 725, protein: 38.5 });

  const firstWorkout = run([
    'log-workout',
    '--original', 'Log a workout',
    '--origin-channel', 'imessage',
    '--conversation-id', 'test-conversation',
    '--idempotency-key', 'workout-first',
  ]);
  assert.equal(firstWorkout.reply, 'Got that logged.');
  assert.equal(firstWorkout.activity.hourlyWorkouts.current, 1);

  const secondWorkout = run([
    'log-workout',
    '--idempotency-key', 'workout-second-same-hour',
  ]);
  assert.equal(secondWorkout.activity.hourlyWorkouts.current, 2);

  const thirdWorkout = run([
    'log-workout',
    '--idempotency-key', 'workout-third',
  ]);
  assert.equal(thirdWorkout.activity.hourlyWorkouts.current, 3);

  const duplicateWorkoutRequest = run([
    'log-workout',
    '--idempotency-key', 'workout-third',
  ]);
  assert.equal(duplicateWorkoutRequest.deduplicated, true);
  assert.equal(duplicateWorkoutRequest.activity.hourlyWorkouts.current, 3);

  const dailyRun = run([
    'log-daily-run',
    '--original', 'I just ran',
    '--origin-channel', 'imessage',
    '--conversation-id', 'test-conversation',
    '--idempotency-key', 'daily-run-1',
  ]);
  assert.equal(dailyRun.reply, 'Got that logged.');
  assert.equal(dailyRun.entry.durationMinutes, 30);
  assert.equal(dailyRun.activity.dailyRun.done, true);

  const sameDayRun = run([
    'log-daily-run',
    '--duration-minutes', '45',
    '--idempotency-key', 'daily-run-2',
  ]);
  assert.equal(sameDayRun.alreadyRecorded, true);
  assert.equal(sameDayRun.entry.durationMinutes, 30);

  const activity = run(['activity-today']);
  assert.equal(activity.activity.hourlyWorkouts.current, 3);
  assert.equal(activity.activity.dailyRun.done, true);

  const listedWithActivity = run(['list-today']);
  assert.equal(listedWithActivity.activity.hourlyWorkouts.current, 3);
  assert.equal(listedWithActivity.activity.dailyRun.durationMinutes, 30);

  const invalid = run([
    'log-food',
    '--name', 'Impossible food',
    '--serving', '1',
    '--calories', '-1',
    '--protein', '2',
    '--resolution-type', 'estimate',
    '--idempotency-key', 'invalid-log',
  ], 1);
  assert.equal(invalid.code, 'INVALID_ARGUMENT');

  process.stdout.write('health-workflow tests passed\n');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
