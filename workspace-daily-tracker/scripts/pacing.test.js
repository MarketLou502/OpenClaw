#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { computePacing, daysUntil } = require('./pacing');

function task(overrides) {
  return {
    id: 't1', board: 'work', text: 'Write report', done: false, added: '2026-08-01',
    schedule: null, estimatedBlocks: null,
    ...overrides,
  };
}

try {
  // No due date, no estimate -> no pacing pressure.
  assert.equal(computePacing(task({}), [], '2026-08-17'), null);
  assert.equal(computePacing(task({ schedule: { startsAt: '2026-08-20T09:00:00-04:00' } }), [], '2026-08-17'), null);
  assert.equal(computePacing(task({ estimatedBlocks: 4 }), [], '2026-08-17'), null);

  // Done tasks never get pacing pressure regardless of fields.
  assert.equal(computePacing(task({ done: true, schedule: { startsAt: '2026-08-20T09:00:00-04:00' }, estimatedBlocks: 4 }), [], '2026-08-17'), null);

  // On-track: task was created recently relative to its due date, so
  // today's required pace is still close to the original flat plan even
  // with nothing logged yet.
  {
    const t = task({ added: '2026-08-16', schedule: { startsAt: '2026-09-15T09:00:00-04:00' }, estimatedBlocks: 10 });
    const p = computePacing(t, [], '2026-08-17');
    assert.equal(p.status, 'on-track');
    assert.equal(p.blocksRemaining, 10);
    assert.equal(p.daysRemaining, 29);
  }

  // Behind: no progress logged and today's required pace is well above the
  // pace the task would have needed if worked evenly since creation.
  {
    const t = task({ added: '2026-08-01', schedule: { startsAt: '2026-08-18T09:00:00-04:00' }, estimatedBlocks: 10 });
    // flat pace from creation (17 days) ~= 0.59/day; today only 1 day left -> 10/day required.
    const p = computePacing(t, [], '2026-08-17');
    assert.equal(p.status, 'at-risk'); // daysRemaining<=1 and blocksRemaining>1 takes priority
  }

  // Behind (not yet at-risk): several days left, but pace crept up because
  // of no progress relative to a flat plan.
  {
    const t = task({ added: '2026-08-01', schedule: { startsAt: '2026-08-21T09:00:00-04:00' }, estimatedBlocks: 20 });
    // flat pace from creation (20 days) = 1/day; today 4 days left -> 5/day required, > 1.25x flat.
    const p = computePacing(t, [], '2026-08-17');
    assert.equal(p.status, 'behind');
  }

  // Progress logged reduces blocksRemaining and can pull a task back on-track.
  {
    const t = task({ added: '2026-08-01', schedule: { startsAt: '2026-08-31T09:00:00-04:00' }, estimatedBlocks: 10, id: 't2' });
    const entries = [
      { taskId: 't2', blocksLogged: 3 },
      { taskId: 't2', blocksLogged: 1.5 },
      { taskId: 'other-task', blocksLogged: 99 }, // must not leak into t2's total
    ];
    const p = computePacing(t, entries, '2026-08-17');
    assert.equal(p.totalLogged, 4.5);
    assert.equal(p.blocksRemaining, 5.5);
  }

  // Due today still gets a same-day target instead of dividing by zero.
  {
    const t = task({ added: '2026-08-10', schedule: { startsAt: '2026-08-17T09:00:00-04:00' }, estimatedBlocks: 2 });
    const p = computePacing(t, [], '2026-08-17');
    assert.equal(p.daysRemaining, 1);
    assert.equal(p.targetBlocksPerDay, 2);
  }

  assert.equal(daysUntil('2026-08-20', '2026-08-17'), 3);
  assert.equal(daysUntil('2026-08-15', '2026-08-17'), 0); // floored at 0, never negative

  process.stdout.write('pacing tests passed\n');
} catch (error) {
  process.exitCode = 1;
  process.stderr.write(`${error.stack || error.message}\n`);
}
