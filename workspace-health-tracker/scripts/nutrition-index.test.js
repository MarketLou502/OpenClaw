#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const NODE = '/opt/homebrew/opt/node@22/bin/node';
const BUILDER = path.join(__dirname, 'build-nutrition-index.js');
const QUERY = path.join(__dirname, 'nutrition-index.js');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nutrition-index-test-'));
const sourcePath = path.join(tempDir, 'foundation.json');
const dbPath = path.join(tempDir, 'nutrition.db');

const mock = {
  FoundationFoods: [
    {
      fdcId: 1001,
      dataType: 'Foundation',
      description: 'Chicken breast, boneless, grilled',
      publicationDate: '4/30/2026',
      foodCategory: { description: 'Poultry Products' },
      foodNutrients: [
        { nutrient: { id: 1008, name: 'Energy', unitName: 'kcal' }, amount: 165 },
        { nutrient: { id: 1003, name: 'Protein', unitName: 'g' }, amount: 31 },
      ],
      foodPortions: [
        { amount: 1, measureUnit: { name: 'piece', abbreviation: 'piece' }, gramWeight: 120 },
      ],
    },
    {
      fdcId: 1002,
      dataType: 'Foundation',
      description: 'Apple, raw, with skin',
      publicationDate: '4/30/2026',
      foodNutrients: [
        { nutrient: { id: 2048, name: 'Energy (Atwater Specific Factors)', unitName: 'kcal' }, amount: 52 },
        { nutrient: { id: 1003, name: 'Protein', unitName: 'g' }, amount: 0.26 },
      ],
      foodPortions: [
        { amount: 1, measureUnit: { name: 'fruit', abbreviation: 'fruit' }, modifier: 'medium', gramWeight: 182 },
      ],
    },
  ],
};

function run(program, args, env = {}) {
  const result = spawnSync(NODE, [program, ...args], {
    encoding: 'utf8',
    env: { ...process.env, NODE_NO_WARNINGS: '1', ...env },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout.trim());
}

try {
  fs.writeFileSync(sourcePath, JSON.stringify(mock));
  const built = run(BUILDER, ['--source', `foundation=${sourcePath}`, '--output', dbPath]);
  assert.equal(built.foodCount, 2);
  assert.equal(built.foodsWithPortions, 2);

  const chicken = run(QUERY, ['search', '--query', 'grilled chicken breast'], { NUTRITION_DB: dbPath });
  assert.equal(chicken.matches.length, 1);
  assert.equal(chicken.matches[0].fdcId, 1001);
  assert.equal(chicken.matches[0].caloriesPer100g, 165);
  assert.equal(chicken.matches[0].portions[0].calories, 198);
  assert.equal(chicken.matches[0].portions[0].protein, 37.2);

  const appleSearch = run(QUERY, ['search', '--query', 'one medium apple raw'], { NUTRITION_DB: dbPath });
  assert.equal(appleSearch.matches[0].fdcId, 1002);

  const apple = run(QUERY, ['get', '--fdc-id', '1002'], { NUTRITION_DB: dbPath });
  assert.equal(apple.found, true);
  assert.equal(apple.food.portions[0].gramWeight, 182);

  process.stdout.write('nutrition-index tests passed\n');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
