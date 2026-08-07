'use strict';

// Test for the new QueryCalendar intent — validates that calendar queries
// are properly recognized when the QueryCalendar intent is added to
// calendar.yaml.

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  matchIntent,
} = require('./index');

async function expectIntent(text, intent, slots = {}) {
  const result = await matchIntent(text);
  assert.equal(result.intent, intent, `expected ${JSON.stringify(text)} -> ${intent}, got ${result.intent}`);
  for (const [key, value] of Object.entries(slots)) {
    assert.equal(result.slots[key], value, `slot ${key} for ${text}`);
  }
}

test('QueryCalendar intent recognizes calendar read requests', async () => {
  // The actual observed phrase that escalated to Main instead of being
  // fast-pathed to the calendar workflow:
  await expectIntent('What\'s on my calendar today?', 'QueryCalendar');
  
  // Natural variations of the same intent:
  await expectIntent('What is on my calendar today', 'QueryCalendar');
  await expectIntent('What is scheduled for my calendar today', 'QueryCalendar');
  await expectIntent('Show me my calendar events for today', 'QueryCalendar');
  await expectIntent('Tell me all my calendar events for today', 'QueryCalendar');
  await expectIntent('Do I have anything on my calendar today', 'QueryCalendar');
  await expectIntent('Do I have any events on my calendar today', 'QueryCalendar');
  await expectIntent('List my calendar events', 'QueryCalendar');
  await expectIntent('Read my calendar events for this week', 'QueryCalendar');
});
