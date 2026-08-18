#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { decideCheckins, deliverAtIso } = require('./reassess');

function pacingItem(overrides) {
  return { taskId: 't1', board: 'work', text: 'Report', status: 'behind', daysRemaining: 3, ...overrides };
}

try {
  // A brand-new behind/at-risk task with no prior state fires a check-in.
  {
    const { checkins, tasks } = decideCheckins([pacingItem({ status: 'at-risk' })], { tasks: {} }, '2026-08-17');
    assert.equal(checkins.length, 1);
    assert.equal(checkins[0].reason, 'status_transition');
    assert.equal(tasks.t1.lastNotifiedStatus, 'at-risk');
  }

  // Same status, same day, already notified -> gated, no re-fire.
  {
    const state = { tasks: { t1: { lastNotifiedStatus: 'behind', lastNotifiedAt: '2026-08-17T13:00:00.000Z' } } };
    const { checkins } = decideCheckins([pacingItem({ status: 'behind' })], state, '2026-08-17');
    assert.equal(checkins.length, 0);
  }

  // Same status, but last notified on an earlier calendar day -> once-a-day recheck fires.
  {
    const state = { tasks: { t1: { lastNotifiedStatus: 'behind', lastNotifiedAt: '2026-08-16T13:00:00.000Z' } } };
    const { checkins } = decideCheckins([pacingItem({ status: 'behind' })], state, '2026-08-17');
    assert.equal(checkins.length, 1);
    assert.equal(checkins[0].reason, 'daily_recheck');
  }

  // on-track never fires a checkin, but a transition into it is still recorded
  // so a later transition back into behind/at-risk is detected correctly.
  {
    const state = { tasks: { t1: { lastNotifiedStatus: 'behind', lastNotifiedAt: '2026-08-16T13:00:00.000Z' } } };
    const { checkins, tasks } = decideCheckins([pacingItem({ status: 'on-track' })], state, '2026-08-17');
    assert.equal(checkins.length, 0);
    assert.equal(tasks.t1.lastNotifiedStatus, 'on-track');
  }

  // One-at-a-time: two tasks newly eligible in the same run -> only the
  // first (pacing's own urgency sort order) gets a check-in; the second is
  // left untouched in state so it's still eligible once its turn comes.
  {
    const pacing = [pacingItem({ taskId: 't1', status: 'at-risk' }), pacingItem({ taskId: 't2', status: 'behind' })];
    const { checkins, tasks } = decideCheckins(pacing, { tasks: {} }, '2026-08-17');
    assert.equal(checkins.length, 1);
    assert.equal(checkins[0].taskId, 't1');
    assert.equal(tasks.t2, undefined); // untouched, not silently marked notified
  }

  // A different task's open thread blocks a new one from starting, even if
  // the new one is more urgent -- but the open thread's own task (if it also
  // needs a recheck) still gets through.
  {
    const pacing = [pacingItem({ taskId: 't1', status: 'at-risk' }), pacingItem({ taskId: 't2', status: 'behind' })];
    const { checkins, tasks } = decideCheckins(pacing, { tasks: {} }, '2026-08-17', 't2');
    assert.equal(checkins.length, 1);
    assert.equal(checkins[0].taskId, 't2');
    assert.equal(tasks.t1, undefined);
  }

  // Timezone offset sign regression guard (the 2026-08-17 bug: America/New_York
  // in August must render as -04:00, not +04:00, or every deliverAt parses
  // hours earlier than intended).
  {
    const iso = deliverAtIso('2026-08-17', '09:30', 'America/New_York');
    assert.equal(iso, '2026-08-17T09:30:00-04:00');
    assert.equal(new Date(iso).toISOString(), '2026-08-17T13:30:00.000Z');
  }

  process.stdout.write('reassess tests passed\n');
} catch (error) {
  process.exitCode = 1;
  process.stderr.write(`${error.stack || error.message}\n`);
}
