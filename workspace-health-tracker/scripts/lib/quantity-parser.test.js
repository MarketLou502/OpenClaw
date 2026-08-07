#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

const { parseQuantity, matchLeadingQuantity, matchLeadingUnit, portionUnitFromDescription, findUsdaPortionGrams } = require('./quantity-parser');

// ─── matchLeadingQuantity tests ───────────────────────────────────────────────

function testMatchLeadingQuantity() {
  // Decimal/integer
  assert.deepEqual(matchLeadingQuantity('45 oz of chicken breast'), { value: 45, rest: 'oz of chicken breast' });
  assert.deepEqual(matchLeadingQuantity('1.5 cups of milk'), { value: 1.5, rest: 'cups of milk' });
  assert.deepEqual(matchLeadingQuantity('2 tbsp of peanut butter'), { value: 2, rest: 'tbsp of peanut butter' });
  assert.deepEqual(matchLeadingQuantity('0.5 cup'), { value: 0.5, rest: 'cup' });

  // Fraction
  assert.deepEqual(matchLeadingQuantity('1/2 cup of yogurt'), { value: 0.5, rest: 'cup of yogurt' });
  assert.deepEqual(matchLeadingQuantity('3/4 cup'), { value: 0.75, rest: 'cup' });
  assert.deepEqual(matchLeadingQuantity('1/4 tsp'), { value: 0.25, rest: 'tsp' });

  // Word numbers
  assert.deepEqual(matchLeadingQuantity('two eggs'), { value: 2, rest: 'eggs' });
  assert.deepEqual(matchLeadingQuantity('three slices of bread'), { value: 3, rest: 'slices of bread' });
  assert.deepEqual(matchLeadingQuantity('a dozen eggs'), { value: 12, rest: 'eggs' });

  // Articles
  assert.deepEqual(matchLeadingQuantity('a cup of yogurt'), { value: 1, rest: 'cup of yogurt' });
  assert.deepEqual(matchLeadingQuantity('an apple'), { value: 1, rest: 'apple' });

  // Special phrases
  const halfResult = matchLeadingQuantity('half a cup of yogurt');
  assert.equal(halfResult.value, 0.5);
  assert.ok(halfResult.rest.includes('cup'));

  const coupleResult = matchLeadingQuantity('a couple of eggs');
  assert.equal(coupleResult.value, 2);
  assert.ok(coupleResult.rest.includes('eggs'));

  const fewResult = matchLeadingQuantity('a few slices');
  assert.equal(fewResult.value, 3);

  // No quantity
  assert.equal(matchLeadingQuantity('yogurt'), null);
  assert.equal(matchLeadingQuantity('chicken breast'), null);

  process.stdout.write('  matchLeadingQuantity: OK\n');
}

// ─── matchLeadingUnit tests ───────────────────────────────────────────────────

function testMatchLeadingUnit() {
  let result = matchLeadingUnit('cups of yogurt');
  assert.equal(result.token, 'cups');
  assert.equal(result.grams, 240);
  assert.equal(result.rest, 'of yogurt');

  result = matchLeadingUnit('oz of chicken breast');
  assert.equal(result.token, 'oz');
  assert.equal(result.rest, 'of chicken breast');

  result = matchLeadingUnit('tbsp of peanut butter');
  assert.equal(result.token, 'tbsp');
  assert.equal(result.rest, 'of peanut butter');

  result = matchLeadingUnit('eggs');
  assert.equal(result.token, 'eggs');
  assert.equal(result.foodFallback, 'egg');

  result = matchLeadingUnit('ml');
  assert.equal(result.token, 'ml');
  assert.equal(result.grams, 1);

  result = matchLeadingUnit('yogurt');
  assert.equal(result, null);

  process.stdout.write('  matchLeadingUnit: OK\n');
}

// ─── parseQuantity tests ──────────────────────────────────────────────────────

async function testParseQuantity() {
  // Plan table examples
  assert.deepEqual(
    await parseQuantity('yogurt'),
    { foodName: 'yogurt', grams: 100, quantity: 1, unit: null, refinedFromUsda: false, originalText: 'yogurt' },
    'bare "yogurt" -> 100g default',
  );

  {
    const result = await parseQuantity('half a cup of yogurt');
    assert.equal(result.foodName, 'yogurt');
    assert.equal(result.quantity, 0.5);
    assert.equal(result.unit, 'cup');
    assert.equal(result.grams, 120); // 0.5 * 240
    assert.equal(result.refinedFromUsda, false);
  }

  {
    const result = await parseQuantity('a cup of yogurt');
    assert.equal(result.foodName, 'yogurt');
    assert.equal(result.quantity, 1);
    assert.equal(result.grams, 240);
    assert.equal(result.unit, 'cup');
  }

  {
    const result = await parseQuantity('45 oz of chicken breast');
    assert.equal(result.foodName, 'chicken breast');
    assert.equal(result.quantity, 45);
    assert.equal(result.grams, 1275.8); // 45 * 28.35
    assert.equal(result.unit, 'oz');
  }

  {
    const result = await parseQuantity('a can of soda');
    assert.equal(result.foodName, 'soda');
    assert.equal(result.quantity, 1);
    assert.equal(result.grams, 355);
    assert.equal(result.unit, 'can');
  }

  {
    const result = await parseQuantity('half a can of soda');
    assert.equal(result.foodName, 'soda');
    assert.equal(result.quantity, 0.5);
    assert.equal(result.grams, 177.5);
    assert.equal(result.unit, 'can');
  }

  {
    const result = await parseQuantity('2 tablespoons of peanut butter');
    assert.equal(result.foodName, 'peanut butter');
    assert.equal(result.quantity, 2);
    assert.equal(result.grams, 30);
    assert.equal(result.unit, 'tablespoons');
  }

  {
    const result = await parseQuantity('a liter of milk');
    assert.equal(result.foodName, 'milk');
    assert.equal(result.quantity, 1);
    assert.equal(result.grams, 1000);
    assert.equal(result.unit, 'liter');
  }

  {
    const result = await parseQuantity('a bottle of water');
    assert.equal(result.foodName, 'water');
    assert.equal(result.quantity, 1);
    assert.equal(result.grams, 500);
    assert.equal(result.unit, 'bottle');
  }

  {
    const result = await parseQuantity('a slice of bread');
    assert.equal(result.foodName, 'bread');
    assert.equal(result.quantity, 1);
    assert.equal(result.grams, 28);
    assert.equal(result.unit, 'slice');
  }

  // Egg special case: unit IS the food
  {
    const result = await parseQuantity('3 eggs');
    assert.equal(result.foodName, 'egg');
    assert.equal(result.quantity, 3);
    assert.equal(result.grams, 150);
    assert.equal(result.unit, 'eggs');
  }

  // Edge cases
  {
    const result = await parseQuantity('');
    assert.equal(result.foodName, '');
    assert.equal(result.grams, 0);
  }

  {
    const result = await parseQuantity('1/2 cup');
    assert.equal(result.foodName, ''); // no food after unit
    assert.equal(result.quantity, 0.5);
    assert.equal(result.grams, 120);
  }

  // Fraction
  {
    const result = await parseQuantity('1/4 cup of rice');
    assert.equal(result.foodName, 'rice');
    assert.equal(result.quantity, 0.25);
    assert.equal(result.grams, 60);
  }

  process.stdout.write('  parseQuantity (basic): OK\n');
}

// ─── USDA refinement tests ────────────────────────────────────────────────────

async function testUsdaRefinement() {
  // Mock USDA search that returns real yogurt data.
  const mockUsdaSearch = async (foodName) => {
    if (foodName === 'yogurt') {
      return {
        matches: [
          {
            fdcId: 2705414,
            description: 'Yogurt, NFS',
            caloriesPer100g: 94,
            proteinPer100g: 6.67,
            portions: [
              { description: '1 4 oz container', gramWeight: 113 },
              { description: '1 6 oz container', gramWeight: 170 },
              { description: '1 cup', gramWeight: 245 },
            ],
          },
        ],
      };
    }
    if (foodName === 'milk') {
      return {
        matches: [
          {
            fdcId: 12345,
            description: 'Milk, whole',
            caloriesPer100g: 61,
            proteinPer100g: 3.15,
            portions: [
              { description: '1 cup', gramWeight: 244 },
              { description: '1 fl oz', gramWeight: 30.5 },
            ],
          },
        ],
      };
    }
    return { matches: [] };
  };

  // "a cup of yogurt" — USDA knows 1 cup of yogurt = 245g, so use that
  // instead of the default 240g.
  {
    const result = await parseQuantity('a cup of yogurt', { usdaSearch: mockUsdaSearch });
    assert.equal(result.foodName, 'yogurt');
    assert.equal(result.quantity, 1);
    assert.equal(result.unit, 'cup');
    assert.equal(result.grams, 245, 'USDA portion should override default 240g');
    assert.equal(result.refinedFromUsda, true);
  }

  // "half a cup of yogurt" — 0.5 * 245 = 122.5
  {
    const result = await parseQuantity('half a cup of yogurt', { usdaSearch: mockUsdaSearch });
    assert.equal(result.foodName, 'yogurt');
    assert.equal(result.quantity, 0.5);
    assert.equal(result.grams, 122.5);
    assert.equal(result.refinedFromUsda, true);
  }

  // No USDA match — should fall back to defaults.
  {
    const result = await parseQuantity('a cup of soy milk', { usdaSearch: mockUsdaSearch });
    assert.equal(result.foodName, 'soy milk');
    assert.equal(result.quantity, 1);
    assert.equal(result.grams, 240); // default fallback
    assert.equal(result.refinedFromUsda, false);
  }

  // Egg unit — shouldn't be refined (it's in NO_REFINE_UNITS).
  {
    const result = await parseQuantity('3 eggs', { usdaSearch: mockUsdaSearch });
    assert.equal(result.foodName, 'egg');
    assert.equal(result.grams, 150);
    assert.equal(result.refinedFromUsda, false);
  }

  // USDA refinement for milk — 1 cup = 244g
  {
    const result = await parseQuantity('a cup of milk', { usdaSearch: mockUsdaSearch });
    assert.equal(result.foodName, 'milk');
    assert.equal(result.grams, 244);
    assert.equal(result.refinedFromUsda, true);
  }

  process.stdout.write('  parseQuantity (USDA refinement): OK\n');
}

// ─── portionUnitFromDescription tests ─────────────────────────────────────────

function testPortionUnitFromDescription() {
  assert.equal(portionUnitFromDescription('1 cup'), 'cup');
  assert.equal(portionUnitFromDescription('1 4 oz container'), 'ounce');
  assert.equal(portionUnitFromDescription('1 fl oz'), 'ounce');
  assert.equal(portionUnitFromDescription('Quantity not specified'), null);
  assert.equal(portionUnitFromDescription(''), null);
  assert.equal(portionUnitFromDescription('1 undetermined piece'), null);
  assert.equal(portionUnitFromDescription('1 tablespoon'), 'tablespoon');
  assert.equal(portionUnitFromDescription('1 tsp'), 'teaspoon');
  assert.equal(portionUnitFromDescription('1 bottle'), 'bottle');
  assert.equal(portionUnitFromDescription('3 oz'), 'ounce');

  process.stdout.write('  portionUnitFromDescription: OK\n');
}

// ─── findUsdaPortionGrams tests ───────────────────────────────────────────────

function testFindUsdaPortionGrams() {
  const match = {
    fdcId: 2705414,
    portions: [
      { description: '1 4 oz container', gramWeight: 113 },
      { description: '1 cup', gramWeight: 245 },
      { description: '1 6 oz container', gramWeight: 170 },
    ],
  };

  assert.equal(findUsdaPortionGrams(match, 'cup'), 245);
  assert.equal(findUsdaPortionGrams(match, 'ounce'), 113);
  assert.equal(findUsdaPortionGrams(match, 'tablespoon'), null); // no match
  assert.equal(findUsdaPortionGrams(null, 'cup'), null);
  assert.equal(findUsdaPortionGrams(match, 'egg'), null);

  process.stdout.write('  findUsdaPortionGrams: OK\n');
}

// ─── Run all tests ────────────────────────────────────────────────────────────

async function main() {
  process.stdout.write('quantity-parser tests:\n');
  testMatchLeadingQuantity();
  testMatchLeadingUnit();
  testPortionUnitFromDescription();
  testFindUsdaPortionGrams();
  await testParseQuantity();
  await testUsdaRefinement();
  process.stdout.write('\nquantity-parser tests passed\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});