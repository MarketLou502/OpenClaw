#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('./taskstore');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskstore-schedule-'));
const file = path.join(dir, 'tasks.json');
try {
  fs.writeFileSync(file, JSON.stringify({ items: [
    { id: 'legacy', text: 'Legacy task', done: false, added: '2026-08-03', doneDate: null },
  ] }));
  const legacy = store.readItems(file)[0];
  assert.equal(legacy.version, 1);
  assert.equal(legacy.schedule, null);

  const scheduled = store.setItemSchedule(file, 'legacy', {
    startsAt: '2026-08-04T14:00:00-04:00', calendarEventId: 'event-1',
  }, 1);
  assert.equal(scheduled.version, 2);
  assert.equal(scheduled.schedule.calendarEventId, 'event-1');

  const conflict = store.toggleItem(file, 'legacy', true, 1);
  assert.equal(conflict.conflict, true);
  assert.equal(store.readItems(file)[0].done, false);

  const completed = store.toggleItem(file, 'legacy', true, 2);
  assert.equal(completed.version, 3);
  assert.equal(completed.schedule.calendarEventId, 'event-1');
  process.stdout.write('taskstore schedule test passed\n');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
