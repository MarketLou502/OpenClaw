'use strict';

// Tests for the Phase-4 router coverage sweep: each new YAML intent matches
// the phrases users actually say, and cross-domain interference is minimal.
// These test the grammar/matching layer only (matchIntent), never
// routeRoutineRequest (which would spawn real workflow scripts).

const assert = require('node:assert/strict');
const test = require('node:test');
const { matchIntent, parseCalendarWhen } = require('./index');

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function expectIntent(text, intent, slots = {}) {
  const result = await matchIntent(text);
  assert.equal(result.intent, intent, `expected ${JSON.stringify(text)} -> ${intent}, got ${result.intent}`);
  for (const [key, value] of Object.entries(slots)) {
    assert.equal(result.slots[key], value, `slot ${key} for ${text}: expected ${JSON.stringify(value)}, got ${JSON.stringify(result.slots[key])}`);
  }
}

async function expectNoMatch(text) {
  const result = await matchIntent(text);
  assert.equal(result.intent, null, `expected no match for ${JSON.stringify(text)}, got ${result.intent}`);
}

// ─── Board schedule/unschedule/reschedule ─────────────────────────────────────

test('routes board schedule commands', async () => {
  await expectIntent('schedule dentist on my work board at 4pm tomorrow', 'ScheduleItem', { query: 'dentist', schedule_board: 'work' });
  await expectIntent('schedule meeting on personal board at 3pm', 'ScheduleItem', { query: 'meeting', schedule_board: 'personal' });
  await expectIntent('set review on my market lou board at 9am', 'ScheduleItem', { query: 'review', schedule_board: 'market lou' });
});

test('routes board reschedule commands', async () => {
  await expectIntent('reschedule dentist on my work board to 5pm tomorrow', 'RescheduleItem', { query: 'dentist', schedule_board: 'work' });
  await expectIntent('move meeting on personal board to 2pm', 'RescheduleItem', { query: 'meeting', schedule_board: 'personal' });
});

test('routes board unschedule commands', async () => {
  await expectIntent('unschedule dentist on my work board', 'UnscheduleItem', { query: 'dentist', schedule_board: 'work' });
  await expectIntent('remove due date for dentist on my personal board', 'UnscheduleItem', { query: 'dentist', schedule_board: 'personal' });
  await expectIntent('clear the deadline for review', 'UnscheduleItem', { query: 'review' });
});

// ─── Calendar list / delete / reschedule ─────────────────────────────────────

test('routes calendar list commands', async () => {
  // "what's on my calendar" is handled by the existing QueryCalendar intent —
  // ListCalendar handles complementary patterns
  await expectIntent("what do i have scheduled on friday", 'ListCalendar');
  await expectIntent('whats scheduled for tomorrow', 'ListCalendar');
  await expectIntent('tell me my calendar for tomorrow', 'ListCalendar');
  await expectIntent('list my schedule for today', 'ListCalendar');
});

test('routes calendar delete commands', async () => {
  await expectIntent("delete dentist from my calendar for tomorrow", 'DeleteCalendar', { title: 'dentist' });
  await expectIntent("remove lunch from my calendar for today", 'DeleteCalendar', { title: 'lunch' });
  await expectIntent("cancel the event morning standup", 'DeleteCalendar', { title: 'morning standup' });
});

test('routes calendar reschedule commands', async () => {
  await expectIntent("move dentist to tomorrow at 3pm", 'RescheduleCalendar', { title: 'dentist' });
  await expectIntent("reschedule meeting from today to tomorrow at 2pm", 'RescheduleCalendar', { title: 'meeting' });
  await expectIntent("push standup to tomorrow at 9am", 'RescheduleCalendar', { title: 'standup' });
});

// ─── Finance ─────────────────────────────────────────────────────────────────

test('routes add-expense commands', async () => {
  await expectIntent("add expense called netflix for 15.99 due 15 day", 'AddExpense', { name: 'netflix' });
  await expectIntent("log a bill named internet for 80 due 5 day", 'AddExpense', { name: 'internet' });
  await expectIntent("add a expense called rent for 1500 due on the 1st day", 'AddExpense', { name: 'rent' });
});

// ─── Health tracker ──────────────────────────────────────────────────────────

test('routes list-today commands', async () => {
  await expectIntent("show me what i ate today", 'ListToday');
  await expectIntent("what did i eat yesterday", 'ListToday');
  await expectIntent("show my meals for today", 'ListToday');
  await expectIntent("list my food log", 'ListToday');
  await expectIntent("what have i eaten today", 'ListToday');
});

test('routes activity-today commands', async () => {
  await expectIntent("show me my activity today", 'ActivityToday');
  await expectIntent("what exercise did i do yesterday", 'ActivityToday');
  await expectIntent("how active was i", 'ActivityToday');
  await expectIntent("what activity did i do", 'ActivityToday');
});

test('routes correct-food commands', async () => {
  await expectIntent("correct my food entry", 'CorrectFood');
  await expectIntent("fix my last food entry", 'CorrectFood');
  await expectIntent("change my meal entry", 'CorrectFood');
});

test('routes remove-food commands', async () => {
  await expectIntent("remove my last food entry", 'RemoveFood');
  await expectIntent("delete food entry for today", 'RemoveFood');
  await expectIntent("delete my last food entry", 'RemoveFood');
});

test('routes undo commands', async () => {
  await expectIntent("undo my last food entry", 'UndoFood');
  await expectIntent("undo that", 'UndoFood');
  await expectIntent("never mind about that food entry", 'UndoFood');
});

// ─── Meal planner ────────────────────────────────────────────────────────────

test('routes get-plan commands', async () => {
  await expectIntent("show my meal plan for tomorrow", 'GetPlan');
  await expectIntent("what is the plan for today", 'GetPlan');
  await expectIntent("read my meal plan", 'GetPlan');
});

test('routes list-recipes commands', async () => {
  await expectIntent("list my meal planner recipes", 'ListRecipes');
  await expectIntent("tell me my recipes", 'ListRecipes');
  await expectIntent("what recipes do i have", 'ListRecipes');
  await expectIntent("list all recipes", 'ListRecipes');
});

test('routes find-recipe commands', async () => {
  await expectIntent("find the recipe chicken parmesan", 'FindRecipe', { query: 'chicken parmesan' });
  await expectIntent("search for oatmeal recipe", 'FindRecipe', { query: 'oatmeal' });
  await expectIntent("look up the recipe pancakes", 'FindRecipe', { query: 'pancakes' });
});

test('routes confirm-plan commands', async () => {
  await expectIntent("confirm the meal plan for tomorrow", 'ConfirmPlan');
  await expectIntent("lock in the meal plan", 'ConfirmPlan');
  await expectIntent("finalize meal plan for today", 'ConfirmPlan');
});

test('routes assemble-plan commands', async () => {
  await expectIntent("assemble a meal plan for tomorrow", 'AssemblePlan');
  await expectIntent("build a meal plan", 'AssemblePlan');
  await expectIntent("fill in the meal plan for today", 'AssemblePlan');
  await expectIntent("generate a meal plan", 'AssemblePlan');
});

test('routes add-plan-item commands', async () => {
  // With anchor word "slot" or "meal"
  await expectIntent("add oatmeal to the breakfast slot", 'AddPlanItem', { recipe_name: 'oatmeal' });
  await expectIntent("put chicken to the dinner slot", 'AddPlanItem', { recipe_name: 'chicken' });
  await expectIntent("add salad to the lunch slot for tomorrow", 'AddPlanItem', { recipe_name: 'salad' });
  // With closed-set meal slot name (no anchor word required)
  await expectIntent("add oatmeal to breakfast", 'AddPlanItem', { recipe_name: 'oatmeal' });
  await expectIntent("put chicken to dinner", 'AddPlanItem', { recipe_name: 'chicken' });
});

// ─── Cross-domain safety ─────────────────────────────────────────────────────

test('does not claim ambiguous calendar requests as meal-planner items', async () => {
  await expectNoMatch('Add lunch to my calendar sometime tomorrow');
  await expectNoMatch('Add lunch to my calendar');
});

test('still does not intercept general questions', async () => {
  await expectNoMatch('What is the capital of Australia?');
  await expectNoMatch('This is a totally unrelated sentence about nothing');
});

test('schedule command with no parseable time still reaches the grammar but the router will reject it', async () => {
  // This is expected grammar behavior: ScheduleItem matches because {when}
  // wildcard captures "sometime tomorrow" — the router's parseCalendarWhen
  // will reject it at routing time since there's no time number present.
  const result = await matchIntent('schedule review on my work board sometime tomorrow');
  assert.equal(result.intent, 'ScheduleItem', 'grammar should match ScheduleItem');
  assert.ok(result.slots.query, 'should capture query');
  assert.ok(result.slots.schedule_board, 'should capture board');
});

test('delete and remove-list phrasing still falls through to the model', async () => {
  await expectNoMatch('Remove my Reading list');
  await expectNoMatch('Delete my Reading list');
  await expectNoMatch('Change Dune to Dune Messiah in my Books list');
});

// ─── parseCalendarWhen edge cases ────────────────────────────────────────────

test('parseCalendarWhen still handles basic cases', () => {
  const withToday = parseCalendarWhen('for 4pm today', {
    now: new Date('2026-08-07T10:00:00Z'),
    timeZone: 'America/New_York',
  });
  assert.ok(withToday);
  assert.equal(withToday.date, '2026-08-07');
  assert.equal(withToday.time, '16:00');

  const withTomorrow = parseCalendarWhen('for 9am tomorrow', {
    now: new Date('2026-08-07T22:00:00Z'),
    timeZone: 'America/New_York',
  });
  assert.ok(withTomorrow);
  assert.equal(withTomorrow.date, '2026-08-08');
  assert.equal(withTomorrow.time, '09:00');
});