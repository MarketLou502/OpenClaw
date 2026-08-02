'use strict';

// These tests exercise the hassil-backed matcher and the pure post-processing
// helpers only (matchIntent, boardKey, parseCalendarWhen) — never
// routeRoutineRequest itself, which spawns the real dashboard/calendar/
// health/echo-app workflow scripts and would create real board items,
// real calendar events, and real health log entries as a side effect of
// running the test suite.

const assert = require('node:assert/strict');
const test = require('node:test');
const { matchIntent, boardKey, parseCalendarWhen } = require('./index');

async function expectIntent(text, intent, slots = {}) {
  const result = await matchIntent(text);
  assert.equal(result.intent, intent, `expected ${JSON.stringify(text)} -> ${intent}, got ${result.intent}`);
  for (const [key, value] of Object.entries(slots)) {
    assert.equal(result.slots[key], value, `slot ${key} for ${text}`);
  }
}

async function expectNoMatch(text) {
  const result = await matchIntent(text);
  assert.equal(result.intent, null, `expected no match for ${text}, got ${result.intent}`);
}

test('adds to fixed boards, including the observed grocery command', async () => {
  await expectIntent('Can you add soda to the grocery list?', 'AddToBoard', { item: 'soda', board: 'grocery' });
  await expectIntent('Add prepare report to my work board', 'AddToBoard', { item: 'prepare report', board: 'work' });
  await expectIntent('Put call Mom on personal', 'AddToBoard', { item: 'call Mom', board: 'personal' });
  await expectIntent('Add inspect campaign to Market Lou', 'AddToBoard', { item: 'inspect campaign' });
  assert.equal(boardKey('market lou'), 'market-lou');
});

test('reads boards through the original phrasings and the wider fallback wording', async () => {
  await expectIntent("What's on my grocery list", 'ListBoard', { board: 'grocery' });
  await expectIntent("Can you tell me what's on my Work board?", 'ListBoard', { board: 'work' });
  await expectIntent('Can you show me my Work board?', 'ListBoard', { board: 'work' });
  await expectIntent('Please read the items from Market Lou', 'ListBoard', { board: 'market lou' });
  await expectIntent('Show all my boards', 'ListAllBoards');
});

test('completes and removes board items', async () => {
  await expectIntent('Mark milk done on the grocery list', 'CompleteItem', { item: 'milk', board: 'grocery' });
  await expectIntent('Mark guitar done', 'CompleteItem', { item: 'guitar' });
  await expectIntent('Remove old report from my work board', 'RemoveFromBoard', { item: 'old report', board: 'work' });
});

test('routes daily habits and cross-category completion', async () => {
  await expectIntent('Show my daily goals', 'ListHabits');
  await expectIntent('Mark guitar done for today on my daily goals', 'CompleteHabit', { item: 'guitar' });
  await expectIntent('I just finished call dentist', 'CompleteAnyFree', { item: 'call dentist' });
});

test('routes custom list lifecycle', async () => {
  await expectIntent('Create a new list called Books', 'CreateList', { name: 'Books' });
  await expectIntent('Add Dune to my Books list', 'AddListItem', { item: 'Dune', list: 'Books' });
  await expectIntent("What's on my Books list", 'ShowList', { list: 'Books' });
  await expectIntent('Mark Dune done on my Books list', 'CompleteListItem', { item: 'Dune', list: 'Books' });
  await expectIntent('Change Dune to Dune Messiah in my Books list', 'EditListItem', { item: 'Dune', text: 'Dune Messiah', list: 'Books' });
  await expectIntent('Remove Dune from my Books list', 'RemoveListItem', { item: 'Dune', list: 'Books' });
  await expectIntent('Rename my Books list to Reading', 'RenameList', { list: 'Books', name: 'Reading' });
  await expectIntent('Delete my Reading list', 'DeleteList', { list: 'Reading' });
});

test('grocery stays a fixed board, not a custom list', async () => {
  await expectIntent('Add soda to my grocery list', 'AddToBoard', { item: 'soda', board: 'grocery' });
  await expectIntent('Show my grocery list', 'ListBoard', { board: 'grocery' });
  await expectIntent('add milk to my work list', 'AddToBoard', { item: 'milk', board: 'work' });
});

test('routes natural list-inventory phrasing, including the previously-missed variants', async () => {
  await expectIntent('Can you tell me all the lists I have', 'ListLists');
  await expectIntent('What are all my lists', 'ListLists');
  await expectIntent('Do I have any lists', 'ListLists');
  await expectIntent('What custom lists do I have', 'ListLists');
  await expectIntent('Show my lists please', 'ListLists');
});

test('covers the rest of the previously-missed phrasings', async () => {
  await expectIntent('Anything on my work board', 'ListBoard', { board: 'work' });
  await expectIntent('Do I have anything on Personal', 'ListBoard', { board: 'personal' });
  await expectIntent('add eggs to grocery', 'AddToBoard', { item: 'eggs', board: 'grocery' });
  await expectIntent('What habits do I still have to do', 'ListHabits');
  await expectIntent('Did I do all my habits', 'ListHabits');
});

test('does not intercept general questions', async () => {
  await expectNoMatch('What is the capital of Australia?');
  await expectNoMatch('This is a totally unrelated sentence about nothing');
});

test('workout and run reports take priority over generic complete-any', async () => {
  await expectIntent('I just finished my workout', 'WorkoutLog');
  await expectIntent('I worked out', 'WorkoutLog');
  await expectIntent('I just finished my run', 'DailyRunLog');
  await expectIntent('I went for a run', 'DailyRunLog');
  await expectIntent("I'm done with the dishes", 'CompleteAnyFree', { item: 'the dishes' });
});

test('recognizes the spotify-open request', async () => {
  await expectIntent('open spotify', 'SpotifyOpen');
  await expectIntent('Can you launch Spotify on the Echo Show please?', 'SpotifyOpen');
});

test('recognizes the observed calendar command end to end', async () => {
  const result = await matchIntent("Can you add Dad's birthday to my calendar for 4pm tomorrow?");
  assert.equal(result.intent, 'AddCalendar');
  assert.equal(result.slots.title, "Dad's birthday");
  const parsed = parseCalendarWhen(result.slots.when, {
    now: new Date('2026-08-01T22:00:00Z'),
    timeZone: 'America/New_York',
  });
  assert.deepEqual(parsed, { date: '2026-08-02', time: '16:00' });
});

test('does not claim ambiguous calendar requests', async () => {
  // No "for/at/on" connector before the date phrase, so this doesn't match
  // the AddCalendar sentence shape at all — same as the original regex,
  // which required that connector as part of the pattern itself.
  await expectNoMatch('Add lunch to my calendar sometime tomorrow');
});
