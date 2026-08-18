// lib/taskstore.js — shared atomic JSON file helpers for dashboard-api.
//
// dashboard-api is the only process that writes these files (see the
// integration plan) — that's what makes the plain read-modify-write below
// safe without cross-process locking. Do not import this from anything
// other than dashboard-api's own server/migration scripts.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath, data) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
}

function todayStr() {
  return new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD in the host timezone
}

function yesterdayStr() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toLocaleDateString('en-CA');
}

function historyFilePath(filePath) {
  return filePath.replace(/\.json$/, '.history.json');
}

function slugify(text) {
  // "Workout/Run" -> "workout-run", "Study AI 900" -> "study-ai-900"
  return (text || '').toLowerCase().trim().replace(/[\s/]+/g, '-').replace(/[^a-z0-9-]/g, '');
}

function newId() {
  return crypto.randomBytes(4).toString('hex');
}

// Returns today's data, reinitializing via factory(today) if the file is
// missing or its stored `date` doesn't match today — same "date field
// mismatch -> fresh state" pattern daily-tracker's own memory/state.json
// already uses for morningSent/notified.
function ensureToday(filePath, factory) {
  const today = todayStr();
  const existing = readJson(filePath, null);
  if (existing && existing.date === today) return existing;
  const fresh = factory(today);
  writeJsonAtomic(filePath, fresh);
  return fresh;
}

// ── Item lists (tasks/grocery — shape: { items: [{id, text, done, added, doneDate}] }) ──
//
// Done items older than yesterday age out of the active file into a sidecar
// <file>.history.json on every read, so the active list (and every dashboard
// poll of it) stays bounded regardless of how long the board has been in
// use — completed-item history keeps accumulating, just not in the hot path.

// 24 x 30min = 12h — Aaron's explicit cap (2026-08-17): anything bigger
// should be split into more than one task, not estimated as a single block.
const MAX_ESTIMATED_BLOCKS = 24;

function clampEstimatedBlocks(value) {
  return Number.isInteger(value) && value > 0 ? Math.min(value, MAX_ESTIMATED_BLOCKS) : null;
}

function normalizeItem(item) {
  return {
    ...item,
    version: Number.isInteger(item && item.version) && item.version > 0 ? item.version : 1,
    schedule: item && item.schedule && typeof item.schedule === 'object' ? item.schedule : null,
    estimatedBlocks: clampEstimatedBlocks(item && item.estimatedBlocks),
  };
}

function readItems(filePath) {
  const data = readJson(filePath, { items: [] });
  const items = Array.isArray(data.items) ? data.items.map(normalizeItem) : [];
  return sweepToHistory(filePath, items);
}

function sweepToHistory(filePath, items) {
  const cutoffOk = new Set([todayStr(), yesterdayStr()]);
  const keep = [];
  const aged = [];
  for (const item of items) {
    if (item.done && item.doneDate && !cutoffOk.has(item.doneDate)) aged.push(item);
    else keep.push(item);
  }
  if (aged.length) {
    const histPath = historyFilePath(filePath);
    const histData = readJson(histPath, { items: [] });
    const existing = Array.isArray(histData.items) ? histData.items : [];
    const byId = new Map(existing.map((i) => [i.id, i]));
    for (const item of aged) byId.set(item.id, item);
    writeJsonAtomic(histPath, { items: [...byId.values()] });
    writeJsonAtomic(filePath, { items: keep });
  }
  return keep;
}

function writeItems(filePath, items) {
  writeJsonAtomic(filePath, { items });
}

function addItem(filePath, text, estimatedBlocks) {
  const items = readItems(filePath);
  const item = {
    id: newId(), text: String(text).trim(), done: false, added: todayStr(), doneDate: null,
    version: 1, schedule: null,
    estimatedBlocks: clampEstimatedBlocks(estimatedBlocks),
  };
  items.push(item);
  writeItems(filePath, items);
  return item;
}

function mutateItem(filePath, id, expectedVersion, mutation) {
  const items = readItems(filePath);
  const item = items.find((i) => i.id === id);
  if (!item) return null;
  if (expectedVersion !== undefined && expectedVersion !== null && Number(expectedVersion) !== item.version) {
    return { conflict: true, item };
  }
  mutation(item);
  item.version += 1;
  writeItems(filePath, items);
  return item;
}

function toggleItem(filePath, id, done, expectedVersion) {
  return mutateItem(filePath, id, expectedVersion, (item) => {
    item.done = !!done;
    item.doneDate = item.done ? todayStr() : null;
  });
}

function setItemSchedule(filePath, id, schedule, expectedVersion) {
  return mutateItem(filePath, id, expectedVersion, (item) => {
    item.schedule = schedule;
  });
}

// estimatedBlocks is the task's total effort estimate in 30-min units — a
// planning concept, distinct from schedule.durationMinutes (the size of one
// calendar work session). null means "no estimate given".
function setItemEstimate(filePath, id, estimatedBlocks, expectedVersion) {
  return mutateItem(filePath, id, expectedVersion, (item) => {
    item.estimatedBlocks = clampEstimatedBlocks(estimatedBlocks);
  });
}

function removeItem(filePath, id) {
  const items = readItems(filePath);
  const index = items.findIndex((i) => i.id === id);
  if (index === -1) return null;
  const [removed] = items.splice(index, 1);
  writeItems(filePath, items);
  return removed;
}

// ── Item history (Year -> Month browsing over aged-out + still-active done items) ──

function monthBucketsFromDates(dates) {
  const counts = new Map(); // "YYYY-MM" -> count
  for (const d of dates) {
    if (!d) continue;
    const key = d.slice(0, 7);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ year: Number(key.slice(0, 4)), month: Number(key.slice(5, 7)), count }))
    .sort((a, b) => (b.year - a.year) || (b.month - a.month));
}

function allDoneItems(filePath) {
  const active = readItems(filePath); // also triggers the sweep
  const hist = readJson(historyFilePath(filePath), { items: [] });
  const histItems = Array.isArray(hist.items) ? hist.items : [];
  return [...active.filter((i) => i.done), ...histItems];
}

function getItemHistoryBuckets(filePath) {
  return monthBucketsFromDates(allDoneItems(filePath).map((i) => i.doneDate));
}

function getItemHistoryMonth(filePath, year, month) {
  const prefix = `${year}-${String(month).padStart(2, '0')}`;
  return allDoneItems(filePath)
    .filter((i) => (i.doneDate || '').startsWith(prefix))
    .sort((a, b) => (a.doneDate < b.doneDate ? 1 : -1));
}

// ── Habits (static labels file + per-day done state file) ──

function readHabitLabels(habitsFile) {
  const data = readJson(habitsFile, { habits: [] });
  return Array.isArray(data.habits) ? data.habits : [];
}

function readTodayHabits(todayHabitsFile, habitLabels) {
  return ensureToday(todayHabitsFile, (today) => {
    const done = {};
    habitLabels.forEach((h) => { done[h.id] = false; });
    return { date: today, done };
  });
}

function toggleHabit(todayHabitsFile, habitLabels, id, done, historyFile) {
  const state = readTodayHabits(todayHabitsFile, habitLabels);
  if (!(id in state.done)) return null;
  state.done[id] = !!done;
  writeJsonAtomic(todayHabitsFile, state);
  if (historyFile) recordHabitCompletion(historyFile, id, state.date, !!done);
  return state;
}

// ── Habit history (Year -> Month browsing) ──
//
// today-habits.json only ever holds *today's* state (ensureToday wipes it on
// every date rollover), so it can't answer "was Guitar done on June 3rd" a
// month later. This log is the only place that fact survives — a flat,
// deduped (habitId, date) list, appended to on every completion and pruned
// on same-day undo.

function readHabitHistory(historyFile) {
  const data = readJson(historyFile, { completions: [] });
  return Array.isArray(data.completions) ? data.completions : [];
}

function recordHabitCompletion(historyFile, id, date, done) {
  const completions = readHabitHistory(historyFile);
  const idx = completions.findIndex((c) => c.id === id && c.date === date);
  if (done && idx === -1) completions.push({ id, date });
  else if (!done && idx !== -1) completions.splice(idx, 1);
  else return;
  writeJsonAtomic(historyFile, { completions });
}

function getHabitHistoryBuckets(historyFile) {
  return monthBucketsFromDates(readHabitHistory(historyFile).map((c) => c.date));
}

function getHabitHistoryMonth(historyFile, habitLabels, year, month) {
  const prefix = `${year}-${String(month).padStart(2, '0')}`;
  const labelById = new Map(habitLabels.map((h) => [h.id, h.label]));
  return readHabitHistory(historyFile)
    .filter((c) => c.date.startsWith(prefix))
    .map((c) => ({ id: c.id, label: labelById.get(c.id) || c.id, date: c.date }))
    .sort((a, b) => (a.date < b.date ? 1 : -1));
}

// ── Health (per-day running totals — shape: { date, calories:{current,target,unit}, ... }) ──

function readTodayHealth(todayStateFile, defaults) {
  const state = ensureToday(todayStateFile, (today) => ({ date: today, ...defaults }));
  let changed = false;
  for (const [key, value] of Object.entries(defaults)) {
    if (state[key] === undefined) {
      state[key] = JSON.parse(JSON.stringify(value));
      changed = true;
    }
  }
  if (changed) writeJsonAtomic(todayStateFile, state);
  return state;
}

function patchHealth(todayStateFile, defaults, patch) {
  const state = readTodayHealth(todayStateFile, defaults);
  for (const key of Object.keys(patch)) {
    if (state[key] && typeof state[key] === 'object' && typeof patch[key] === 'object') {
      Object.assign(state[key], patch[key]);
    }
  }
  writeJsonAtomic(todayStateFile, state);
  return state;
}

module.exports = {
  readJson, writeJsonAtomic, todayStr, yesterdayStr, slugify, newId, ensureToday,
  normalizeItem, readItems, writeItems, addItem, mutateItem, toggleItem, setItemSchedule, setItemEstimate, removeItem,
  getItemHistoryBuckets, getItemHistoryMonth,
  readHabitLabels, readTodayHabits, toggleHabit,
  getHabitHistoryBuckets, getHabitHistoryMonth,
  readTodayHealth, patchHealth,
};
