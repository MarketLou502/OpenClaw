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
  setPendingConfirmation, takePendingConfirmation, AFFIRMATIVE_RE, NEGATIVE_RE, NEVERMIND_RE,
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
  await expectIntent("Can you tell me what's on my Work board?", 'ShowList', { list: 'Work' });
  await expectIntent('Please read the items from Market Lou list', 'ShowList', { list: 'Market Lou' });
  await expectIntent('Show all my boards', 'ListAllBoards');
});

test('tolerates a qualifier word between the board name and "list"/"board" — the reported bug', async () => {
  // "Add Cancelled Fabuletics to my Personal Task list" (the actual failing
  // utterance): previously matched AddListItem with list="Personal Task",
  // which no custom list matched, so it failed outright. The grammar itself
  // doesn't need to know "Personal" from "Personal Task" — that distinction
  // is resolveListTarget's job — but it must still capture the full phrase
  // as the {list} slot for the resolver to work with.
  await expectIntent('Add Cancelled Fabuletics to my Personal Task list', 'AddListItem', { item: 'Cancelled Fabuletics', list: 'Personal Task' });
  await expectIntent("What's on my work to-do list", 'ShowList', { list: 'work to-do' });
});

test('completes and removes items, grocery via CompleteItem/RemoveFromBoard, others via the unified list grammar', async () => {
  await expectIntent('Mark milk done on the grocery list', 'CompleteItem', { item: 'milk', board: 'grocery' });
  await expectIntent('Mark guitar done', 'CompleteItem', { item: 'guitar' });
  await expectIntent('Remove old report from my work board', 'RemoveListItem', { item: 'old report', list: 'work' });
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

test('grocery stays a fixed board; Work is a unified-list match instead', async () => {
  await expectIntent('Add soda to my grocery list', 'AddToBoard', { item: 'soda', board: 'grocery' });
  await expectIntent('Show my grocery list', 'ListBoard', { board: 'grocery' });
  await expectIntent('add milk to my work list', 'AddListItem', { item: 'milk', list: 'work' });
});

test('routes natural list-inventory phrasing, including the previously-missed variants', async () => {
  await expectIntent('Can you tell me all the lists I have', 'ListLists');
  await expectIntent('What are all my lists', 'ListLists');
  await expectIntent('Do I have any lists', 'ListLists');
  await expectIntent('What custom lists do I have', 'ListLists');
  await expectIntent('Show my lists please', 'ListLists');
});

test('bare "tell me" (no can/could/would-you prefix) still reaches its own intent', async () => {
  // Regression: the "can you tell me" wrapper-stripper previously ate a
  // bare leading "tell me" too, which orphaned every intent that lists
  // "tell me" as its own trigger verb whenever the remainder had no other
  // wh-word to fall back on.
  await expectIntent('Tell me the lists that I have', 'ListLists');
  await expectIntent('tell me my grocery list', 'ListBoard', { board: 'grocery' });
  await expectIntent('tell me all my habits', 'ListHabits');
});

test('covers the rest of the previously-missed phrasings', async () => {
  await expectIntent('Anything on my work board', 'ShowList', { list: 'work' });
  await expectIntent('Do I have anything on my Personal list', 'ShowList', { list: 'Personal' });
  await expectIntent('add eggs to grocery', 'AddToBoard', { item: 'eggs', board: 'grocery' });
  await expectIntent('What habits do I still have to do', 'ListHabits');
  await expectIntent('Did I do all my habits', 'ListHabits');
});

test('tolerates list-name/anchor word order — the live DeleteList miss reported 2026-08-02', async () => {
  // Real transcripts from ha-voice-adapter.log that missed the router before
  // this fix: the grammar only accepted "delete my {name} list", not
  // Aaron's actual "delete my list {name}" word order.
  await expectIntent('Delete my list test', 'DeleteList', { list: 'test' });
  await expectIntent('Delete my list ZZPhase2Test', 'DeleteList', { list: 'ZZPhase2Test' });
  await expectIntent('Delete my list. ZZ Phase 2 Test.', 'DeleteList', { list: 'ZZ Phase 2 Test' });
  // Same word-order tolerance applied uniformly across the other
  // {list}-plus-anchor intents, not just DeleteList.
  await expectIntent('Rename my list Reading to Books', 'RenameList', { list: 'Reading', name: 'Books' });
  await expectIntent('Change milk to oat milk in my list Groceries', 'EditListItem', { item: 'milk', text: 'oat milk', list: 'Groceries' });
  await expectIntent('Remove milk from my list Groceries', 'RemoveListItem', { item: 'milk', list: 'Groceries' });
  await expectIntent('Add milk to my list Groceries', 'AddListItem', { item: 'milk', list: 'Groceries' });
  await expectIntent("What's on my list Groceries", 'ShowList', { list: 'Groceries' });
  await expectIntent('Mark milk done on my list Groceries', 'CompleteListItem', { item: 'milk', list: 'Groceries' });
});

test('tolerates a connecting "of"/"for" when the anchor comes before the list name — the live AddListItem miss reported 2026-08-02', async () => {
  // Real transcript from home-assistant.log that missed the router before
  // this fix: "Can you add me on to the list of Songs I Want to Learn?"
  // (STT itself also mangled "a song" into "me on" — a separate, unrelated
  // issue). The anchor-first branch used to capture everything after "list"
  // verbatim, so {list} came out as "of Songs I Want to Learn" and matched
  // no real list downstream. See project-songs-list-goal-list-mismatch-2026-08-02.
  await expectIntent('Add guitar tabs to the list of Songs I Want to Learn', 'AddListItem', { item: 'guitar tabs', list: 'Songs I Want to Learn' });
  await expectIntent("What's on the list of Songs I Want to Learn", 'ShowList', { list: 'Songs I Want to Learn' });
  await expectIntent('Remove Wonderwall from the list of Songs I Want to Learn', 'RemoveListItem', { item: 'Wonderwall', list: 'Songs I Want to Learn' });
  await expectIntent('Delete my list for Songs I Want to Learn', 'DeleteList', { list: 'Songs I Want to Learn' });
  // No connector at all must still work — this is the original 2026-08-02
  // DeleteList fix and must not regress.
  await expectIntent('Delete my list ZZPhase2Test', 'DeleteList', { list: 'ZZPhase2Test' });
});

test('accepts verb synonyms added for DeleteList/RenameList/EditListItem', async () => {
  await expectIntent('Remove my Reading list', 'DeleteList', { list: 'Reading' });
  await expectIntent('Get rid of my Reading list', 'DeleteList', { list: 'Reading' });
  await expectIntent('Change the name of my Books list to Reading', 'RenameList', { list: 'Books', name: 'Reading' });
  await expectIntent('Update milk to oat milk in my Groceries list', 'EditListItem', { item: 'milk', text: 'oat milk', list: 'Groceries' });
});

test('item-removal phrasing is not swallowed by DeleteList\'s wider grammar', async () => {
  // Widening DeleteList's anchor to accept "board" (not just "list") and
  // allowing word-order permutation both increased its overlap with
  // RemoveListItem/RemoveFromBoard's "(remove|delete) {item} from ..."
  // shape. hassil's default tie-break prefers whichever parse has fewer
  // wildcard slots, which — before the pick_best() fix in recognize.py —
  // meant DeleteList's single {list} wildcard beat RemoveListItem's
  // {item}+{list} pair outright, regardless of literal text matched. That
  // silently misrouted "delete an item from a list" into "delete the whole
  // list". These must keep resolving to the item-level intent.
  await expectIntent('Remove old report from my work board', 'RemoveListItem', { item: 'old report', list: 'work' });
  await expectIntent('Remove Dune from my Books list', 'RemoveListItem', { item: 'Dune', list: 'Books' });
  await expectIntent('Delete milk from my Snacks list', 'RemoveListItem', { item: 'milk', list: 'Snacks' });
});

test('a genuine wildcard-word-count tie resolves deterministically, not by load order', async () => {
  // "board" and "list" both appear here, and either can serve as the other's
  // anchor, so {list} can capture "board" or "list" with the exact same
  // 1-word count either way — pick_best()'s primary criterion can't break
  // this tie. Its secondary tie-break (recognize.py's _tie_break_key, which
  // mirrors hassil's own recognize_best scoring) resolves it on wildcard
  // text length instead of falling through to whatever order recognize_all()
  // happened to yield the two parses in. Both word orders must land on the
  // same slot value.
  await expectIntent("what's on my board list", 'ShowList', { list: 'list' });
  await expectIntent("what's on my list board", 'ShowList', { list: 'list' });
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

test('affirmative/negative matchers used by the pending-confirmation flow', () => {
  for (const text of ['yes', 'Yes.', 'yeah', 'yep', 'sure', 'confirm', 'confirmed', 'do it', 'go ahead', 'please do']) {
    assert.equal(AFFIRMATIVE_RE.test(text), true, `expected affirmative: ${text}`);
  }
  for (const text of ['no', 'No.', 'nope', 'nah', 'nevermind', 'never mind', 'cancel', "don't"]) {
    assert.equal(NEGATIVE_RE.test(text), true, `expected negative: ${text}`);
  }
  // Not a bare yes/no — must not accidentally match either, since these
  // fall through to normal routing instead of resolving the pending action.
  assert.equal(AFFIRMATIVE_RE.test('yes please delete it'), false);
  assert.equal(NEGATIVE_RE.test("no I don't want that"), false);
});

test('a trailing "never mind" matches regardless of what precedes it, but only at the end', () => {
  for (const text of [
    'never mind', 'Never mind.', 'nevermind', 'never  mind!',
    'add milk to the grocery list, never mind', 'actually, never mind',
  ]) {
    assert.equal(NEVERMIND_RE.test(text), true, `expected never-mind cancel: ${text}`);
  }
  for (const text of ['never mind that, add milk', "I don't mind", 'mind the gap']) {
    assert.equal(NEVERMIND_RE.test(text), false, `expected no cancel: ${text}`);
  }
});

test('pending confirmation is single-use and scoped per conversation', () => {
  const ctx = { channel: 'voice-pe-kitchen', conversationId: 'test-device' };
  assert.equal(takePendingConfirmation(ctx), null, 'nothing pending yet');

  setPendingConfirmation(ctx, { route: 'dashboard-delete-list', script: 'x.js', args: ['delete-list'], label: 'test' });
  const first = takePendingConfirmation(ctx);
  assert.equal(first.route, 'dashboard-delete-list');
  assert.equal(takePendingConfirmation(ctx), null, 'second read must be empty — one-shot');

  // Different conversation never sees another conversation's pending action.
  setPendingConfirmation(ctx, { route: 'dashboard-delete-list', script: 'x.js', args: [], label: 'test' });
  assert.equal(takePendingConfirmation({ channel: 'voice-pe-kitchen', conversationId: 'other-device' }), null);
  takePendingConfirmation(ctx); // drain so it doesn't leak into other tests
});
