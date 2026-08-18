'use strict';

// These tests exercise the hassil-backed matcher and the pure post-processing
// helpers only (matchIntent, boardKey, parseCalendarWhen) — never
// routeRoutineRequest itself, which spawns the real dashboard/calendar/
// health/echo-app workflow scripts and would create real board items,
// real calendar events, and real health log entries as a side effect of
// running the test suite.

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  matchIntent, boardKey, parseCalendarWhen,
} = require('./index');

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

test('grocery is still the one fixed board matched directly', async () => {
  await expectIntent('Can you add soda to the grocery list?', 'AddToBoard', { item: 'soda', board: 'grocery' });
  await expectIntent('add eggs to grocery', 'AddToBoard', { item: 'eggs', board: 'grocery' });
  assert.equal(boardKey('market lou'), 'market-lou');
});

test('Work/Personal/Market Lou now route through the unified list grammar, not AddToBoard/ListBoard', async () => {
  // These used to be a separate closed-set "board" match; they're resolved
  // to the right board downstream by dashboard-workflow.js's
  // resolveListTarget, not by the router/recognizer, so the intent here is
  // the same one a genuine custom list would hit.
  await expectIntent('Add prepare report to my work board', 'AddListItem', { item: 'prepare report', list: 'work' });
  await expectIntent('Put call Mom on personal list', 'AddListItem', { item: 'call Mom', list: 'personal' });
  await expectIntent('Add inspect campaign to Market Lou list', 'AddListItem', { item: 'inspect campaign', list: 'Market Lou' });
});

test('tolerates a qualifier word between the board name and "list"/"board" — the reported bug', async () => {
  // "Add Cancelled Fabuletics to my Personal Task list" (the actual failing
  // utterance): previously matched AddListItem with list="Personal Task",
  // which no custom list matched, so it failed outright. The grammar itself
  // doesn't need to know "Personal" from "Personal Task" — that distinction
  // is resolveListTarget's job — but it must still capture the full phrase
  // as the {list} slot for the resolver to work with.
  await expectIntent('Add Cancelled Fabuletics to my Personal Task list', 'AddListItem', { item: 'Cancelled Fabuletics', list: 'Personal Task' });
});

test('completes and removes items, grocery via CompleteItem/RemoveFromBoard', async () => {
  await expectIntent('Mark milk done on the grocery list', 'CompleteItem', { item: 'milk', board: 'grocery' });
  await expectIntent('Mark guitar done', 'CompleteItem', { item: 'guitar' });
  // Item-removal from non-grocery targets is no longer routed.
  await expectNoMatch('Remove old report from my work board');
});

test('routes daily habits and cross-category completion', async () => {
  await expectIntent('Mark guitar done for today on my daily goals', 'CompleteHabit', { item: 'guitar' });
  await expectIntent('I just finished call dentist', 'CompleteAnyFree', { item: 'call dentist' });
});

test('board/list read-backs and list-management no longer route — voice is add/complete only', async () => {
  // ListAllBoards/ListHabits/ListLists/CreateList/ShowList were cut
  // 2026-08-10 at Aaron's request: reading a list back or creating one by
  // voice was never something he actually used, and it padded out the
  // grammar. The kiosk handles those now.
  await expectNoMatch('Show all my boards');
  await expectNoMatch('Show my daily goals');
  await expectNoMatch('Create a new list called Books');
  await expectIntent('Add Dune to my Books list', 'AddListItem', { item: 'Dune', list: 'Books' });
  await expectNoMatch("What's on my Books list");
  await expectIntent('Mark Dune done on my Books list', 'CompleteListItem', { item: 'Dune', list: 'Books' });
  // Edit/rename/delete/remove-item are no longer routed either.
  await expectNoMatch('Change Dune to Dune Messiah in my Books list');
  await expectNoMatch('Remove Dune from my Books list');
  await expectNoMatch('Rename my Books list to Reading');
  await expectNoMatch('Delete my Reading list');
});

test('grocery stays a fixed board; Work is a unified-list match instead', async () => {
  await expectIntent('Add soda to my grocery list', 'AddToBoard', { item: 'soda', board: 'grocery' });
  await expectIntent('Show my grocery list', 'ListBoard', { board: 'grocery' });
  await expectIntent('add milk to my work list', 'AddListItem', { item: 'milk', list: 'work' });
});

test('list-inventory and habit read-back phrasing no longer routes', async () => {
  await expectNoMatch('Can you tell me all the lists I have');
  await expectNoMatch('What are all my lists');
  await expectNoMatch('Do I have any lists');
  await expectNoMatch('What custom lists do I have');
  await expectNoMatch('Show my lists please');
  await expectNoMatch('What habits do I still have to do');
  await expectNoMatch('Did I do all my habits');
});

test('bare "tell me" (no can/could/would-you prefix) still reaches its own intent for phrasing that still routes', async () => {
  // Regression: the "can you tell me" wrapper-stripper previously ate a
  // bare leading "tell me" too, which orphaned every intent that lists
  // "tell me" as its own trigger verb whenever the remainder had no other
  // wh-word to fall back on. ListLists/ListHabits themselves are gone now
  // (see above), but the wrapper-stripping behavior still matters for the
  // intents that remain, e.g. grocery's ListBoard.
  await expectIntent('tell me my grocery list', 'ListBoard', { board: 'grocery' });
});

test('tolerates list-name/anchor word order', async () => {
  // Real transcripts from ha-voice-adapter.log that showed the grammar
  // only accepted {name} then anchor, not anchor then {name}.
  await expectIntent('Add milk to my list Groceries', 'AddListItem', { item: 'milk', list: 'Groceries' });
  await expectIntent('Mark milk done on my list Groceries', 'CompleteListItem', { item: 'milk', list: 'Groceries' });
  // Edit/rename/delete/remove-item are no longer routed.
  await expectNoMatch('Rename my list Reading to Books');
  await expectNoMatch('Change milk to oat milk in my list Groceries');
  await expectNoMatch('Remove milk from my list Groceries');
  await expectNoMatch('Delete my list test');
  await expectNoMatch('Delete my list ZZPhase2Test');
  await expectNoMatch('Delete my list. ZZ Phase 2 Test.');
});

test('tolerates a connecting "of"/"for" when the anchor comes before the list name', async () => {
  // Real transcript from home-assistant.log that missed the router before
  // this fix: "Can you add me on to the list of Songs I Want to Learn?"
  await expectIntent('Add guitar tabs to the list of Songs I Want to Learn', 'AddListItem', { item: 'guitar tabs', list: 'Songs I Want to Learn' });
  // Remove-from-list and delete-list are no longer routed.
  await expectNoMatch('Remove Wonderwall from the list of Songs I Want to Learn');
  await expectNoMatch('Delete my list for Songs I Want to Learn');
});

test('edit/rename/delete/remove-item phrasing now falls through to the model', async () => {
  // DeleteList, RemoveListItem, RenameList, and EditListItem are no longer
  // routed — these operations are handled by the model-based agent instead.
  await expectNoMatch('Remove my Reading list');
  await expectNoMatch('Get rid of my Reading list');
  await expectNoMatch('Change the name of my Books list to Reading');
  await expectNoMatch('Update milk to oat milk in my Groceries list');
  await expectNoMatch('Remove old report from my work board');
  await expectNoMatch('Remove Dune from my Books list');
  await expectNoMatch('Delete milk from my Snacks list');
});

test('a genuine wildcard-word-count tie resolves deterministically, not by load order', async () => {
  // "board" and "list" both appear here, and either can serve as the other's
  // anchor, so {list} can capture "board" or "list" with the exact same
  // 1-word count either way — pick_best()'s primary criterion can't break
  // this tie. Its secondary tie-break (recognize.py's _tie_break_key, which
  // mirrors hassil's own recognize_best scoring) resolves it on wildcard
  // text length instead of falling through to whatever order recognize_all()
  // happened to yield the two parses in. Both word orders must land on the
  // same slot value. CompleteListItem is the only remaining {list}-based
  // intent that can exercise this ambiguity now that ShowList is gone.
  await expectIntent("mark it done on my board list", 'CompleteListItem', { item: 'it', list: 'list' });
  await expectIntent("mark it done on my list board", 'CompleteListItem', { item: 'it', list: 'list' });
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

test('a bare same-day time with no date word defaults to today', async () => {
  // Regression test for the 2026-08-03 bug: "add a morning meeting to my
  // calendar for 9am" used to silently fail to route because
  // parseCalendarWhen required a literal "today"/"tomorrow" in {when}, which
  // nobody actually says when scheduling something later the same day.
  const result = await matchIntent('add a morning meeting to my calendar for 9am');
  assert.equal(result.intent, 'AddCalendar');
  assert.equal(result.slots.title, 'a morning meeting');
  const parsed = parseCalendarWhen(result.slots.when, {
    now: new Date('2026-08-03T13:00:00Z'),
    timeZone: 'America/New_York',
  });
  assert.deepEqual(parsed, { date: '2026-08-03', time: '09:00' });
});

test('a bare time still requires an actual time to be present', async () => {
  const parsed = parseCalendarWhen('sometime soon', { timeZone: 'America/New_York' });
  assert.equal(parsed, null);
});

test('a period-separated time with am/pm parses correctly', async () => {
  // Regression test for the 2026-08-08 bug: "add Go To The Data Center on my
  // calendar for 11.30 PM Tonight" silently failed to route because the time
  // regex only recognized ":" between hour and minutes. With ".", the regex
  // skipped past "11." entirely and matched "30 PM" as if 30 were the hour,
  // which parseClockTime correctly rejected as invalid, dropping the whole
  // request.
  const result = await matchIntent('Add Go To The Data Center on my Calendar for 11.30 PM Tonight.');
  assert.equal(result.intent, 'AddCalendar');
  assert.equal(result.slots.title, 'Go To The Data Center');
  const parsed = parseCalendarWhen(result.slots.when, {
    now: new Date('2026-08-08T13:00:00Z'),
    timeZone: 'America/New_York',
  });
  assert.deepEqual(parsed, { date: '2026-08-08', time: '23:30' });
});

test('"next week" resolves to +7 days instead of defaulting to today', () => {
  // Regression test for the reported 2026-08-17 bug: a request scheduled
  // "distinctly for next week" was silently placed on today's date because
  // parseCalendarWhen previously only recognized the literal words
  // "today"/"tomorrow" and treated everything else as if no date word were
  // present at all.
  const now = new Date('2026-08-17T13:00:00Z'); // a Monday
  const parsed = parseCalendarWhen('next week at 3pm', { now, timeZone: 'America/New_York' });
  assert.deepEqual(parsed, { date: '2026-08-24', time: '15:00' });
});

test('weekday names resolve to the next occurrence of that day', () => {
  const now = new Date('2026-08-17T13:00:00Z'); // a Monday
  assert.deepEqual(
    parseCalendarWhen('friday at 5pm', { now, timeZone: 'America/New_York' }),
    { date: '2026-08-21', time: '17:00' },
  );
  assert.deepEqual(
    parseCalendarWhen('next friday at 5pm', { now, timeZone: 'America/New_York' }),
    { date: '2026-08-21', time: '17:00' },
  );
  // Naming today's own weekday means "next week", not "right now" — same
  // reasoning as "next <weekday>", to avoid a second ambiguous special case.
  assert.deepEqual(
    parseCalendarWhen('monday at 5pm', { now, timeZone: 'America/New_York' }),
    { date: '2026-08-24', time: '17:00' },
  );
});

test('"in N days" resolves to a relative offset', () => {
  const now = new Date('2026-08-17T13:00:00Z');
  const parsed = parseCalendarWhen('in 3 days at 5pm', { now, timeZone: 'America/New_York' });
  assert.deepEqual(parsed, { date: '2026-08-20', time: '17:00' });
});

test('a bare ordinal day of month resolves to that date', () => {
  // Regression test for the actual reported request behind the 2026-08-17
  // bug report: "schedule a doctor's appointment on the 24th for 8:30 AM"
  // has no "next"/weekday/month word at all, so it matched none of the
  // patterns from the first fix and still silently fell back to today.
  const now = new Date('2026-08-17T13:00:00Z'); // the 17th, so the 24th is still ahead this month
  const parsed = parseCalendarWhen('on the 24th for 8:30 AM', { now, timeZone: 'America/New_York' });
  assert.deepEqual(parsed, { date: '2026-08-24', time: '08:30' });
});

test('a bare ordinal day of month rolls to next month once it has passed', () => {
  const now = new Date('2026-08-27T13:00:00Z'); // the 27th, so the 24th already passed this month
  const parsed = parseCalendarWhen('on the 24th for 8:30 AM', { now, timeZone: 'America/New_York' });
  assert.deepEqual(parsed, { date: '2026-09-24', time: '08:30' });
});

test('an explicit month and day resolves to that date', () => {
  const now = new Date('2026-08-17T13:00:00Z');
  assert.deepEqual(
    parseCalendarWhen('august 24th at 8:30am', { now, timeZone: 'America/New_York' }),
    { date: '2026-08-24', time: '08:30' },
  );
  assert.deepEqual(
    parseCalendarWhen('8/24 at 8:30am', { now, timeZone: 'America/New_York' }),
    { date: '2026-08-24', time: '08:30' },
  );
});

test('an unrecognized date phrase falls through instead of defaulting to today', () => {
  // "next month" isn't one of the forms resolveDateOffset understands, but
  // it clearly is trying to name a date (unlike a bare "for 9am"), so this
  // must return null and let the caller fall through to Main rather than
  // silently guessing today.
  const now = new Date('2026-08-17T13:00:00Z');
  const parsed = parseCalendarWhen('next month at 5pm', { now, timeZone: 'America/New_York' });
  assert.equal(parsed, null);
});