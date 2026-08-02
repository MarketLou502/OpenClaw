#!/usr/bin/env node
'use strict';
const assert = require('assert');
const { buildSchedule } = require('./daily-goal-scheduler');
const config = { windowStart: '08:00', windowEnd: '17:00', slotMinutes: 30, distribution: 'even', eventPrefix: 'Goal: ' };
const habits = [{ id: 'guitar', label: 'Guitar' }, { id: 'golf', label: 'Golf' }, { id: 'spanish', label: 'Spanish' }];

let result = buildSchedule({ habits, completedIds: new Set(), config, earliestMinute: 480, events: [
  { title: 'Work meeting', startTime: '8:00', endTime: '9:00', allDay: false },
  { title: 'Lunch', startTime: '12:00', endTime: '13:00', allDay: false },
] });
assert.deepEqual(result.scheduled.map((item) => item.start), [540, 780, 990]);

result = buildSchedule({ habits, completedIds: new Set(['golf']), config, earliestMinute: 600, events: [
  { eventId: 'g1', title: 'Goal: Guitar', startTime: '10:00', endTime: '10:30', allDay: false },
  { title: 'Conflict', startTime: '10:30', endTime: '11:30', allDay: false },
] });
assert.equal(result.scheduled.length, 2);
assert.equal(result.scheduled[0].start, 600);
assert.equal(result.scheduled[0].changed, false);
assert.equal(result.scheduled[1].start, 990);

result = buildSchedule({ habits: [{ id: 'guitar', label: 'Guitar' }], completedIds: new Set(), config,
  earliestMinute: 990, events: [{ title: 'Late meeting', startTime: '16:30', endTime: '17:00', allDay: false }] });
assert.equal(result.scheduled.length, 0);
assert.equal(result.unscheduled[0].reason, 'no_open_slot');
process.stdout.write('daily-goal-scheduler tests passed\n');
