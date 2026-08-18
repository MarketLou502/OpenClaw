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
// ScheduleItem/RescheduleItem/UnscheduleItem were cut from dashboard.yaml
// 2026-08-10 — due dates by voice are gone, the kiosk button covers it.

test('board schedule/unschedule phrasing no longer routes', async () => {
  await expectNoMatch('schedule dentist on my work board at 4pm tomorrow');
  await expectNoMatch('unschedule dentist on my work board');
  await expectNoMatch('clear the deadline for review');
});

test('"reschedule"/"move" board phrasing now falls to RescheduleCalendar instead — harmless, since no matching calendar event exists', async () => {
  // With RescheduleItem gone, "reschedule"/"move"/"push" are calendar-only
  // trigger verbs (see calendar.yaml), so this phrasing is picked up by
  // RescheduleCalendar with the whole board reference folded into {title}.
  // The router will look for a calendar event named "dentist on my work
  // board" and fail to find one — a harmless no-op bail, not a crash or a
  // wrong action — so this isn't guarded against, just documented.
  await expectIntent('reschedule dentist on my work board to 5pm tomorrow', 'RescheduleCalendar');
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

// Meal-planner grammar (GetPlan/ListRecipes/FindRecipe/ConfirmPlan/
// AssemblePlan/AddPlanItem) was disabled 2026-08-08 —
// sentences/en/meal-planner.yaml.disabled is no longer loaded by
// recognize.py's load_intents(), so those intent names can no longer match.
// Confirm that explicitly rather than just deleting the old coverage.
test('meal-planner phrasing no longer matches (grammar disabled)', async () => {
  await expectNoMatch('show my meal plan for tomorrow');
  await expectNoMatch('list my meal planner recipes');
  await expectNoMatch('find the recipe chicken parmesan');
  await expectNoMatch('confirm the meal plan for tomorrow');
  await expectNoMatch('assemble a meal plan for tomorrow');
  await expectNoMatch('add oatmeal to the breakfast slot');
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