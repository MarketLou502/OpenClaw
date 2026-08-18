'use strict';

// Free-slot-finding for habit cue scheduling, extracted from the retired
// task-tracker-planner.js (archives/task-tracker-planner-2026-08-17/) —
// same bin-packing logic, unchanged, now called from reassess.js instead of
// a dedicated 7:30am cron. Pure functions, no I/O.

function minutes(time) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(time));
  if (!match) throw new Error(`Invalid time '${time}'`);
  return Number(match[1]) * 60 + Number(match[2]);
}

function hhmm(value) {
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
}

function overlaps(left, right) { return left.start < right.end && right.start < left.end; }

function findSlot(busy, start, end, duration) {
  for (let candidate = start; candidate + duration <= end; candidate += duration) {
    const interval = { start: candidate, end: candidate + duration };
    if (!busy.some((item) => overlaps(interval, item))) return candidate;
  }
  return null;
}

function findSlotNear(busy, start, end, duration, target) {
  const candidates = [];
  for (let candidate = start; candidate + duration <= end; candidate += duration) {
    const interval = { start: candidate, end: candidate + duration };
    if (!busy.some((item) => overlaps(interval, item))) candidates.push(candidate);
  }
  candidates.sort((left, right) => Math.abs(left - target) - Math.abs(right - target) || left - right);
  return candidates.length ? candidates[0] : null;
}

// Every existing calendar event (including task-linked due-date events)
// counts as busy — habit slot-finding must never double-book a due date.
function buildSchedule({ habits, completedIds, events, config, earliestMinute }) {
  const windowStart = Math.max(minutes(config.windowStart), earliestMinute);
  const windowEnd = minutes(config.windowEnd);
  const duration = Number(config.slotMinutes);
  const busy = events.filter((event) => !event.allDay).map((event) => ({
    start: minutes(event.startTime), end: minutes(event.endTime),
  }));
  const activeHabits = habits.filter((habit) => !completedIds.has(habit.id));
  const scheduled = [];
  const unscheduled = [];

  for (let index = 0; index < activeHabits.length; index += 1) {
    const habit = activeHabits[index];
    const lastStart = windowEnd - duration;
    const ideal = activeHabits.length === 1
      ? windowStart + Math.floor((lastStart - windowStart) / (2 * duration)) * duration
      : windowStart + Math.round((index * (lastStart - windowStart) / (activeHabits.length - 1)) / duration) * duration;
    const afterPriorGoal = scheduled.length ? scheduled[scheduled.length - 1].start + duration : windowStart;
    const start = config.distribution === 'even'
      ? findSlotNear(busy, afterPriorGoal, windowEnd, duration, ideal)
      : findSlot(busy, afterPriorGoal, windowEnd, duration);
    if (start === null) {
      unscheduled.push({ id: habit.id, label: habit.label, reason: 'no_open_slot' });
      continue;
    }
    busy.push({ start, end: start + duration });
    scheduled.push({ id: habit.id, label: habit.label, start, duration });
  }
  return { scheduled, unscheduled };
}

module.exports = { minutes, hhmm, overlaps, findSlot, findSlotNear, buildSchedule };
