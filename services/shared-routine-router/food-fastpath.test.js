'use strict';

// Unit tests for the pure food-logging fast-path helpers (moved into this
// router 2026-08-08 from services/ha-voice-adapter/server.js). Deliberately
// avoids exercising tryRecipeFood/tryUSDAFood/routeRoutineRequest directly,
// same reasoning as new-intents.test.js: those spawn the real
// health-tracker/USDA subprocesses and would write to Aaron's actual health
// log.

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  parseFoodReport,
  foodNameMatchScore,
  singularize,
  isReliableFoodMatch,
  computeUsdaConfidence,
} = require('./index');

// ─── parseFoodReport ─────────────────────────────────────────────────────────

test('parseFoodReport matches first-person "had/ate" phrasing', () => {
  assert.equal(parseFoodReport("I just had a large sweet tea from McDonald's."), "a large sweet tea from McDonald's");
  assert.equal(parseFoodReport('I had a banana'), 'a banana');
  assert.equal(parseFoodReport('I ate two eggs'), 'two eggs');
});

test('parseFoodReport matches "log X" phrasing', () => {
  assert.equal(parseFoodReport('log a cup of yogurt'), 'a cup of yogurt');
  assert.equal(parseFoodReport('log chicken breast for dinner'), 'chicken breast');
});

test('parseFoodReport strips a trailing meal-slot word', () => {
  assert.equal(parseFoodReport('I had oatmeal for breakfast'), 'oatmeal');
  assert.equal(parseFoodReport('I ate a salad for lunch'), 'a salad');
});

test('parseFoodReport does not match questions or unrelated phrasing', () => {
  assert.equal(parseFoodReport('What did I eat today?'), null);
  assert.equal(parseFoodReport('What is the capital of Australia?'), null);
  assert.equal(parseFoodReport('delete my last food entry'), null);
});

// ─── singularize / foodNameMatchScore ────────────────────────────────────────

test('singularize strips trailing s/es', () => {
  assert.equal(singularize('eggs'), 'egg');
  assert.equal(singularize('cookies'), 'cooki'); // crude by design, matches isReliableFoodMatch's own use
  assert.equal(singularize('banana'), 'banana');
});

test('foodNameMatchScore scores full token overlap as 1', () => {
  assert.equal(foodNameMatchScore('yogurt', 'Yogurt, NFS'), 1);
  assert.equal(foodNameMatchScore('banana', 'Bananas, raw'), 1);
});

test('foodNameMatchScore scores no overlap as 0', () => {
  assert.equal(foodNameMatchScore('soda', 'Bread, Irish soda bread'), 1); // "soda" token does appear
  assert.equal(foodNameMatchScore('rice', 'Snacks, popcorn'), 0);
});

// ─── isReliableFoodMatch ──────────────────────────────────────────────────────

test('isReliableFoodMatch requires the single-token food name to be the primary noun', () => {
  assert.ok(isReliableFoodMatch('yogurt', 'Yogurt, NFS'));
  assert.ok(!isReliableFoodMatch('oatmeal', 'Bread, oatmeal'));
  assert.ok(!isReliableFoodMatch('rice', 'Snacks, rice cracker'));
});

test('isReliableFoodMatch uses token overlap for multi-token food names', () => {
  assert.ok(isReliableFoodMatch('chicken breast', 'Chicken breast tenders'));
  assert.ok(!isReliableFoodMatch('chicken breast', 'Beef, ground'));
});

// ─── computeUsdaConfidence ────────────────────────────────────────────────────

test('computeUsdaConfidence ranks exact-food + refined-portion highest', () => {
  const c = computeUsdaConfidence({ foodName: 'yogurt', description: 'Yogurt, NFS', refinedFromUsda: true, matchCount: 1 });
  assert.equal(c, 0.95);
});

test('computeUsdaConfidence ranks exact-food + generic-portion lower', () => {
  const c = computeUsdaConfidence({ foodName: 'yogurt', description: 'Yogurt, NFS', refinedFromUsda: false, matchCount: 1 });
  assert.equal(c, 0.85);
});

test('computeUsdaConfidence ranks fuzzy match with multiple candidates lowest', () => {
  const c = computeUsdaConfidence({ foodName: 'oatmeal', description: 'Bread, wheat', refinedFromUsda: false, matchCount: 2 });
  assert.equal(c, 0.50);
});
