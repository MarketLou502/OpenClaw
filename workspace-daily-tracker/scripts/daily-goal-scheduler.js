#!/usr/bin/env node
'use strict';

// Places unfinished daily habits into free Google Calendar slots. Existing
// non-goal events win; reruns keep valid goal blocks and move conflicts.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { listEvents, createEvent, updateEvent } = require('./lib/google-calendar');

const WORKSPACE = path.join(__dirname, '..');
const CONFIG_FILE = process.env.OPENCLAW_DAILY_GOAL_CONFIG || path.join(WORKSPACE, 'config', 'daily-goal-scheduler.json');
const HABITS_FILE = process.env.OPENCLAW_DAILY_GOAL_HABITS || path.join(WORKSPACE, 'tasks', 'daily-habits.json');
const HISTORY_FILE = process.env.OPENCLAW_DAILY_GOAL_HISTORY || path.join(WORKSPACE, 'tasks', 'goals-history.json');
const PLAN_FILE = process.env.OPENCLAW_DAILY_GOAL_PLAN || path.join(WORKSPACE, 'memory', 'today-plan.json');

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temp, file);
  } finally { try { fs.unlinkSync(temp); } catch {} }
}

function minutes(time) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(time));
  if (!match) throw new Error(`Invalid time '${time}'`);
  return Number(match[1]) * 60 + Number(match[2]);
}

function hhmm(value) {
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
}

function localDate(now = new Date(), timezone = 'America/New_York') {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return { date: `${value.year}-${value.month}-${value.day}`, minute: Number(value.hour) * 60 + Number(value.minute) };
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

function buildSchedule({ habits, completedIds, events, config, earliestMinute }) {
  const windowStart = Math.max(minutes(config.windowStart), earliestMinute);
  const windowEnd = minutes(config.windowEnd);
  const duration = Number(config.slotMinutes);
  const prefix = config.eventPrefix;
  const busy = events.filter((event) => !event.allDay && !event.title.startsWith(prefix)).map((event) => ({
    start: minutes(event.startTime), end: minutes(event.endTime),
  }));
  const managed = new Map(events.filter((event) => !event.allDay && event.title.startsWith(prefix))
    .map((event) => [event.title.slice(prefix.length), event]));
  const activeHabits = habits.filter((habit) => !completedIds.has(habit.id));
  const scheduled = [];
  const unscheduled = [];

  for (let index = 0; index < activeHabits.length; index += 1) {
    const habit = activeHabits[index];
    const existing = managed.get(habit.label);
    const current = existing && { start: minutes(existing.startTime), end: minutes(existing.endTime) };
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
    const unchanged = current && current.start === start && current.end - current.start === duration;
    scheduled.push({ id: habit.id, label: habit.label, start, duration, existing, changed: !unchanged });
  }
  return { scheduled, unscheduled };
}

async function run({ date, planOnly = false } = {}) {
  const config = readJson(CONFIG_FILE);
  const habits = readJson(HABITS_FILE, { habits: [] }).habits || [];
  const history = readJson(HISTORY_FILE, { completions: [] }).completions || [];
  const injected = process.env.OPENCLAW_DAILY_GOAL_NOW ? new Date(process.env.OPENCLAW_DAILY_GOAL_NOW) : new Date();
  if (!Number.isFinite(injected.getTime())) throw new Error('OPENCLAW_DAILY_GOAL_NOW is invalid');
  const now = localDate(injected, config.timezone);
  const targetDate = date || now.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) throw new Error('Date must be YYYY-MM-DD');
  const completedIds = new Set(history.filter((item) => item.date === targetDate).map((item) => item.id));
  const events = await listEvents(config.calendar, targetDate);
  const roundedNow = Math.ceil(now.minute / config.slotMinutes) * config.slotMinutes;
  const earliestMinute = targetDate === now.date ? roundedNow : minutes(config.windowStart);
  const plan = buildSchedule({ habits, completedIds, events, config, earliestMinute });

  if (!planOnly) {
    for (const item of plan.scheduled) {
      if (!item.changed) continue;
      const title = `${config.eventPrefix}${item.label}`;
      const startIso = `${targetDate}T${hhmm(item.start)}:00`;
      if (item.existing) {
        await updateEvent({ calendar: config.calendar, eventId: item.existing.eventId, title, startIso, durationMin: item.duration });
      } else {
        await createEvent({ calendar: config.calendar, title, startIso, durationMin: item.duration,
          extendedProperties: { private: { openclawDailyGoalId: item.id } } });
      }
    }
    const oldPlan = readJson(PLAN_FILE, { date: targetDate, blocks: [] });
    const retained = oldPlan.date === targetDate && Array.isArray(oldPlan.blocks)
      ? oldPlan.blocks.filter((block) => block.source !== 'habits') : [];
    atomicWriteJson(PLAN_FILE, {
      date: targetDate,
      blocks: [...retained, ...plan.scheduled.map((item) => ({
        slot: hhmm(item.start), task: item.label, goalId: item.id, source: 'habits',
        durationMin: item.duration, status: 'pending', nudgeCount: 0,
      }))].sort((a, b) => a.slot.localeCompare(b.slot)),
    });
  }
  return { ok: true, action: planOnly ? 'plan' : 'schedule', date: targetDate,
    window: `${config.windowStart}-${config.windowEnd}`,
    scheduled: plan.scheduled.map((item) => ({ id: item.id, label: item.label, time: hhmm(item.start), changed: item.changed })),
    unscheduled: plan.unscheduled };
}

async function main() {
  try {
    const args = process.argv.slice(2);
    const command = args[0] || 'run';
    if (!['run', 'plan'].includes(command)) throw new Error(`Unknown command '${command}'`);
    const dateIndex = args.indexOf('--date');
    const result = await run({ date: dateIndex >= 0 ? args[dateIndex + 1] : undefined, planOnly: command === 'plan' });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: error.message }, null, 2)}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();
module.exports = { buildSchedule, findSlot, findSlotNear, overlaps, run };
