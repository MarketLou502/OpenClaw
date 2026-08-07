#!/usr/bin/env node
// dashboard-api — single writer for goals/tasks/grocery/health/meal-planner
// data, and static host for the dashboard-web frontend itself.
//
// Serves the Echo Show dashboard's /api/* contract (see the Computer repo's
// README/app.js for the client-side shape). Also called internally, over
// localhost, by Main's deterministic workflows and delegated health logging
// turns — see the integration plan for why: this process is
// the ONLY thing that writes the underlying JSON files, so two callers can
// never race on the same file.
//
// dashboard-web's index.html/app.js/style.css are served from here too
// (public/) rather than from a separate process — confirmed necessary, not
// just simpler, by the kiosk-app team: app.js's API_BASE defaults to
// same-origin unless a `?api=` param is present, and MainActivity.kt's
// loadDashboard() never adds one, so the static files and this API must
// share an origin/port or every fetch() silently targets the wrong host.
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const store = require('../../lib/taskstore');
const {
  createEvent,
  updateEvent,
  deleteEvent,
} = require('../../workspace-daily-tracker/scripts/lib/google-calendar');

const PORT = Number(process.env.DASHBOARD_API_PORT || 18795);
const HOST = process.env.DASHBOARD_API_HOST || '0.0.0.0'; // LAN-reachable by default; tests use loopback.

const PUBLIC_DIR = path.join(__dirname, 'public');
const STATIC_FILES = {
  '/':          { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js':    { file: 'app.js', type: 'application/javascript; charset=utf-8' },
  '/style.css': { file: 'style.css', type: 'text/css; charset=utf-8' },
};

const TOKEN_FILE = process.env.DASHBOARD_API_TOKEN_FILE || '/Users/aaronmacmini/.openclaw/service-env/dashboard-api.token';
const DT_WORKSPACE = '/Users/aaronmacmini/.openclaw/workspace-daily-tracker';
const HT_WORKSPACE = '/Users/aaronmacmini/.openclaw/workspace-health-tracker';
const FIN_DB = process.env.FINANCE_DB_PATH || '/Users/aaronmacmini/.openclaw/workspace-finance-agent/finance.db';
const CAL_READ = process.env.CALENDAR_READ_SCRIPT || path.join(DT_WORKSPACE, 'scripts/cal-read.sh');
const CAL_READ_RANGE = process.env.CALENDAR_READ_RANGE_SCRIPT || path.join(DT_WORKSPACE, 'scripts/cal-read-range.js');

const TASKS_DIR = process.env.TASKS_DIR || path.join(DT_WORKSPACE, 'tasks');
const BOARDS = ['work', 'personal', 'market-lou'];
const boardFile = (board) => path.join(TASKS_DIR, `${board}.json`);
const TASK_SCHEDULE_OPERATIONS_FILE = process.env.TASK_SCHEDULE_OPERATIONS_FILE ||
  path.join(__dirname, '../../state/task-schedule-operations.json');
const TASK_CALENDAR_ID = process.env.TASK_CALENDAR_ID || 'aaron@marketlou.com';
const TASK_TIMEZONE = process.env.OPENCLAW_CALENDAR_TIMEZONE || 'America/New_York';
const GROCERY_FILE = path.join(TASKS_DIR, 'grocery.json');
const HABITS_FILE = path.join(TASKS_DIR, 'daily-habits.json');
const TODAY_HABITS_FILE = path.join(DT_WORKSPACE, 'memory/today-habits.json');
const GOALS_HISTORY_FILE = path.join(TASKS_DIR, 'goals-history.json');
const LISTS_FILE = process.env.LISTS_FILE || process.env.GOAL_LISTS_FILE || path.join(TASKS_DIR, 'lists.json');
const TODAY_HEALTH_FILE = process.env.HEALTH_STATE_FILE || path.join(HT_WORKSPACE, 'memory/today-state.json');
const HEALTH_WORKFLOW = process.env.HEALTH_WORKFLOW_SCRIPT || path.join(HT_WORKSPACE, 'scripts/health-workflow.js');
const MP_WORKSPACE = '/Users/aaronmacmini/.openclaw/workspace-meal-planner';
const MEAL_PLANNER_WORKFLOW = process.env.MEAL_PLANNER_WORKFLOW_SCRIPT || path.join(MP_WORKSPACE, 'scripts/meal-planner-workflow.js');

// Real targets from health-tracker's own MEMORY.md (3,250 kcal / 160g protein),
// not the dashboard repo's mock data (which shows 180g and includes water —
// water was explicitly dropped from this contract).
const HEALTH_DEFAULTS = {
  calories: { current: 0, target: 3250, unit: '' },
  protein: { current: 0, target: 160, unit: 'g' },
  hourlyWorkouts: { current: 0, target: 8, unit: '' },
};

function log(msg) { process.stdout.write(`[dashboard-api] ${new Date().toISOString()} ${msg}\n`); }

// ── Mutation trace logger ────────────────────────────────────────────────
// Writes a JSONL entry to logs/dashboard-mutations.jsonl so Trace NOC can
// correlate kiosk-originated data changes with the overall request picture.
const MUTATION_LOG = path.join(__dirname, '..', '..', 'logs', 'dashboard-mutations.jsonl');

function logMutation(resource, method, pathSegments, requestBody, result) {
  const entry = {
    timestamp: Date.now(),
    resource,
    method,
    path: pathSegments.join('/'),
    summary: mutationSummary(resource, method, pathSegments, requestBody),
    status: result && result.error ? 'error' : 'success',
    error: result && result.error ? result.error : undefined,
  };
  try {
    fs.appendFileSync(MUTATION_LOG, JSON.stringify(entry) + '\n', 'utf8');
  } catch { /* non-blocking: trace logging must never crash the server */ }
}

function mutationSummary(resource, method, segments, body) {
  const b = body || {};
  // segments = ['api', resource, ...subPath]
  const s = (i) => segments[i + 1]; // skip 'api' prefix
  switch (resource) {
    case 'goals':
      if (method === 'PATCH' && s(1)) return `Toggle goal ${s(1)} \u2192 ${!!b.done}`;
      return `Goals ${method}`;
    case 'goal-lists': case 'lists':
      if (method === 'POST' && !s(1)) return `Add list: ${b.name || ''}`;
      if (method === 'DELETE') return `Remove list: ${s(1)}`;
      if (s(2) === 'items') {
        if (method === 'POST') return `Add item to list ${s(1)}: ${b.text || ''}`;
        if (method === 'PATCH') return `Toggle item ${s(3)} in list ${s(1)} \u2192 ${!!b.done}`;
        if (method === 'DELETE') return `Remove item ${s(3)} from list ${s(1)}`;
      }
      return `Lists ${method} ${segments.join('/')}`;
    case 'tasks':
      const board = s(1) === 'accenture' ? 'work' : s(1);
      if (method === 'POST' && !s(2)) return `Add task to ${board}: ${b.text || ''}`;
      if (method === 'PATCH' && s(2)) return `Toggle task ${s(2)} on ${board} \u2192 ${!!b.done}`;
      if (method === 'DELETE' && s(2)) return `Remove task ${s(2)} from ${board}`;
      if (s(3) === 'schedule') return `${method === 'DELETE' ? 'Unschedule' : method === 'POST' ? 'Schedule' : 'Reschedule'} task ${s(2)}`;
      return `Tasks ${method} ${segments.join('/')}`;
    case 'grocery':
      if (method === 'POST') return `Add grocery: ${b.text || ''}`;
      if (method === 'PATCH') return `Toggle grocery ${s(1)} \u2192 ${!!b.done}`;
      if (method === 'DELETE') return `Remove grocery ${s(1)}`;
      return `Grocery ${method}`;
    case 'health':
      if (method === 'PATCH' && !s(2)) return `Update health state`;
      if (s(2) === 'foods') {
        if (method === 'PATCH') return `Correct food entry ${s(3)}: ${b.calories}cal ${b.protein}g`;
        if (method === 'DELETE') return `Remove food entry ${s(3)}`;
      }
      return `Health ${method}`;
    case 'meal-planner':
      if (s(2) === 'recipes') {
        if (method === 'POST') return `Add recipe: ${b.name || ''}`;
        if (method === 'PATCH') return `Update recipe ${s(3)}: ${b.name || ''}`;
        if (method === 'DELETE') return `Remove recipe ${s(3)}`;
      }
      if (s(2) === 'plan' && s(3) === 'assemble') return 'Assemble meal plan';
      if (s(2) === 'plan' && s(3) === 'items') {
        if (method === 'POST') return `Add plan item to ${b.slot || ''}`;
        if (method === 'PATCH') return `Swap plan item ${s(4)}`;
        if (method === 'DELETE') return `Remove plan item ${s(4)}`;
      }
      return `Meal planner ${method}`;
    case 'financials':
      if (s(2) === 'review') return `Mark transaction ${s(3)} reviewed`;
      if (s(2) === 'expenses') {
        if (method === 'POST') return `Add expense: ${b.name || ''}`;
        if (method === 'DELETE') return `Remove expense ${s(3)}`;
      }
      return `Financials ${method}`;
    default:
      return `${resource} ${method} ${segments.slice(2).join('/')}`;
  }
}

function runHealthWorkflow(args) {
  const result = spawnSync(process.execPath, [HEALTH_WORKFLOW, ...args], {
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, HEALTH_DASHBOARD_SYNC: 'off' },
  });
  try {
    const parsed = JSON.parse(result.stdout || '{}');
    if (!parsed.ok) return { error: parsed.error || 'health workflow failed', code: parsed.code };
    return { result: parsed };
  } catch {
    log(`health workflow failed: ${(result.stderr || result.stdout || '').slice(-300)}`);
    return { error: 'health workflow returned an invalid response' };
  }
}

// meal-planner-workflow.js's get-plan/assemble-plan fetch dashboard-api's
// own GET /api/health internally (read-only), so this needs a longer budget
// than the other workflow spawns to comfortably cover that round trip.
function runMealPlannerWorkflow(args) {
  const result = spawnSync(process.execPath, [MEAL_PLANNER_WORKFLOW, ...args], {
    encoding: 'utf8',
    timeout: 15000,
    env: process.env,
  });
  try {
    const parsed = JSON.parse(result.stdout || '{}');
    if (!parsed.ok) return { error: parsed.error || 'meal-planner workflow failed', code: parsed.code };
    return { result: parsed };
  } catch {
    log(`meal-planner workflow failed: ${(result.stderr || result.stdout || '').slice(-300)}`);
    return { error: 'meal-planner workflow returned an invalid response' };
  }
}

let TOKEN;
try {
  TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  if (!TOKEN) throw new Error('empty token file');
} catch (e) {
  console.error(`Cannot start: failed to read bearer token from ${TOKEN_FILE} (${e.message})`);
  process.exit(1);
}

// ── HTTP helpers ─────────────────────────────────────────────────────────

// Mutation context — set by handle() before each route handler so sendJson
// can auto-log mutations without every handler needing its own logMutation call.
let _mutationCtx = null;

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
  // Auto-log successful mutations (non-GET, 2xx status)
  if (_mutationCtx && status >= 200 && status < 300 && _mutationCtx.method !== 'GET') {
    logMutation(_mutationCtx.resource, _mutationCtx.method, _mutationCtx.segments, _mutationCtx.body, body);
  }
  _mutationCtx = null; // reset after each request
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 1_000_000) req.destroy(); });
    req.on('end', () => {
      if (!raw.trim()) { resolve({}); return; }
      try { resolve(JSON.parse(raw)); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// Reads straight off disk per request (no in-memory cache) so editing
// public/*.html/js/css takes effect on the WebView's next reload with no
// need to restart this process — matches the whole "edit and reload, no
// rebuild" point of the kiosk being a WebView instead of native.
function serveStatic(res, pathname) {
  const entry = STATIC_FILES[pathname];
  fs.readFile(path.join(PUBLIC_DIR, entry.file), (err, data) => {
    if (err) {
      log(`static file read failed for ${pathname}: ${err.message}`);
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': entry.type, 'Content-Length': data.length });
    res.end(data);
  });
}

// ── SSE push ─────────────────────────────────────────────────────────────
// goals/tasks/grocery/health/financials broadcast fresh data over this
// channel right after each mutation (see call sites in the router below),
// so any open dashboard connection updates immediately instead of waiting
// for its next poll. /api/notify/:resource covers the two writers that
// mutate their own store directly instead of going through this process's
// own handlers (the finance email parser, health-tracker's food logging).
// Calendar has no writer to hook (Google-originated) and stays on the
// client's own timer poll.
const sseClients = new Set();

function broadcast(topic, payload) {
  const frame = `event: ${topic}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of sseClients) {
    try { client.write(frame); } catch { sseClients.delete(client); }
  }
}

function handleEvents(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('retry: 3000\n\n');
  sseClients.add(res);
  res.on('error', () => sseClients.delete(res));
  req.on('close', () => sseClients.delete(res));
}

// Keeps a half-dead LAN connection from hanging silently until the OS-level
// TCP timeout — EventSource treats a closed connection as a signal to
// reconnect immediately rather than sitting quiet.
setInterval(() => {
  for (const client of sseClients) {
    try { client.write(': ping\n\n'); } catch { sseClients.delete(client); }
  }
}, 25_000);

// ── Domain handlers ──────────────────────────────────────────────────────

function getGoals() {
  const habits = store.readHabitLabels(HABITS_FILE);
  const state = store.readTodayHabits(TODAY_HABITS_FILE, habits);
  return { goals: habits.map((h) => ({ id: h.id, label: h.label, done: !!state.done[h.id] })) };
}

function patchGoal(id, done) {
  const habits = store.readHabitLabels(HABITS_FILE);
  const state = store.toggleHabit(TODAY_HABITS_FILE, habits, id, done, GOALS_HISTORY_FILE);
  return state; // null if id unknown
}

function getGoalsHistoryBuckets() {
  return { months: store.getHabitHistoryBuckets(GOALS_HISTORY_FILE) };
}

function getGoalsHistoryMonth(year, month) {
  const habits = store.readHabitLabels(HABITS_FILE);
  return { items: store.getHabitHistoryMonth(GOALS_HISTORY_FILE, habits, year, month) };
}

function readGoalLists() {
  try {
    const data = JSON.parse(fs.readFileSync(LISTS_FILE, 'utf8'));
    return { version: 1, lists: Array.isArray(data.lists) ? data.lists : [] };
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, lists: [] };
    throw error;
  }
}

function writeGoalLists(data) {
  const temp = `${LISTS_FILE}.${process.pid}.${store.newId()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, LISTS_FILE);
}

function cleanText(value) { return String(value || '').trim(); }

function listGoalLists() { return readGoalLists(); }

function addGoalList(nameValue) {
  const name = cleanText(nameValue);
  if (!name) return { error: 'name is required' };
  const data = readGoalLists();
  if (data.lists.some((list) => list.name.toLocaleLowerCase() === name.toLocaleLowerCase())) return { error: 'a list with that name already exists' };
  const list = { id: store.newId(), name, items: [] };
  data.lists.push(list);
  writeGoalLists(data);
  return { list };
}

function mutateGoalList(listId, mutation) {
  const data = readGoalLists();
  const list = data.lists.find((candidate) => candidate.id === listId);
  if (!list) return null;
  const result = mutation(list, data);
  writeGoalLists(data);
  return result;
}

function removeGoalList(listId) {
  const data = readGoalLists();
  const index = data.lists.findIndex((candidate) => candidate.id === listId);
  if (index < 0) return null;
  const [removed] = data.lists.splice(index, 1);
  writeGoalLists(data);
  return removed;
}

function listItems(filePath) {
  return { items: store.readItems(filePath) };
}

function addItem(filePath, text) {
  if (!text || !String(text).trim()) return null;
  return store.addItem(filePath, text);
}

function patchItem(filePath, id, done, expectedVersion) {
  return store.toggleItem(filePath, id, done, expectedVersion);
}

function removeItem(filePath, id) {
  return store.removeItem(filePath, id);
}

const scheduleLocks = new Set();

function scheduleOperationKey(board, taskId) {
  return `${board}:${taskId}`;
}

function readScheduleOperations() {
  const data = store.readJson(TASK_SCHEDULE_OPERATIONS_FILE, { operations: {} });
  return data && typeof data.operations === 'object' ? data : { operations: {} };
}

function recordScheduleOperation(idempotencyKey, patch) {
  if (!idempotencyKey) return;
  const data = readScheduleOperations();
  data.operations[idempotencyKey] = {
    ...(data.operations[idempotencyKey] || {}),
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  store.writeJsonAtomic(TASK_SCHEDULE_OPERATIONS_FILE, data);
}

function parseTaskScheduleRequest(body) {
  const startsAt = String(body.startsAt || '').trim();
  const parsed = new Date(startsAt);
  const durationMinutes = Number(body.durationMinutes === undefined ? 30 : body.durationMinutes);
  const timezone = String(body.timezone || TASK_TIMEZONE);
  const expectedVersion = Number(body.expectedVersion);
  const idempotencyKey = String(body.idempotencyKey || '').trim();
  if (!startsAt || !Number.isFinite(parsed.getTime()) || !/[+-]\d\d:\d\d$/.test(startsAt)) {
    return { error: 'startsAt must be a timezone-aware ISO timestamp' };
  }
  if (![0, 30].includes(parsed.getMinutes()) || parsed.getSeconds() !== 0) {
    return { error: 'startsAt must use a 30-minute increment' };
  }
  if (durationMinutes !== 30) return { error: 'durationMinutes must be 30' };
  if (timezone !== TASK_TIMEZONE) return { error: `timezone must be ${TASK_TIMEZONE}` };
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) return { error: 'expectedVersion must be a positive integer' };
  if (!idempotencyKey || idempotencyKey.length > 200) return { error: 'idempotencyKey is required' };
  return { startsAt, durationMinutes, timezone, expectedVersion, idempotencyKey };
}

function scheduleRecord(input, eventId) {
  return {
    startsAt: input.startsAt,
    durationMinutes: input.durationMinutes,
    timezone: input.timezone,
    calendarId: TASK_CALENDAR_ID,
    calendarEventId: eventId,
    status: 'scheduled',
    updatedAt: new Date().toISOString(),
  };
}

async function mutateTaskSchedule({ method, board, taskId, body }) {
  const file = boardFile(board);
  const lockKey = scheduleOperationKey(board, taskId);
  if (scheduleLocks.has(lockKey)) return { status: 409, body: { error: 'task schedule operation already in progress' } };
  scheduleLocks.add(lockKey);
  try {
    const task = store.readItems(file).find((item) => item.id === taskId);
    if (!task) return { status: 404, body: { error: `unknown task id '${taskId}'` } };
    if (task.done) return { status: 409, body: { error: 'completed tasks cannot be scheduled' } };

    if (method === 'DELETE') {
      const expectedVersion = Number(body.expectedVersion);
      const idempotencyKey = String(body.idempotencyKey || '').trim();
      if (!Number.isInteger(expectedVersion) || expectedVersion < 1 || !idempotencyKey) {
        return { status: 400, body: { error: 'expectedVersion and idempotencyKey are required' } };
      }
      if (task.version !== expectedVersion) return { status: 409, body: { error: 'stale task version', task } };
      if (!task.schedule) return { status: 409, body: { error: 'task is not scheduled' } };
      recordScheduleOperation(idempotencyKey, { status: 'running', action: 'unschedule', board, taskId });
      try {
        await deleteEvent({ calendar: task.schedule.calendarId || TASK_CALENDAR_ID, eventId: task.schedule.calendarEventId });
        const updated = store.setItemSchedule(file, taskId, null, expectedVersion);
        recordScheduleOperation(idempotencyKey, { status: 'succeeded', taskVersion: updated.version });
        return { status: 200, body: updated };
      } catch (error) {
        recordScheduleOperation(idempotencyKey, { status: 'failed', error: error.message });
        return { status: 502, body: { error: `calendar unschedule failed: ${error.message}` } };
      }
    }

    const input = parseTaskScheduleRequest(body);
    if (input.error) return { status: 400, body: { error: input.error } };
    const previousOperation = readScheduleOperations().operations[input.idempotencyKey];
    if (previousOperation && previousOperation.status === 'succeeded') {
      return { status: 200, body: task };
    }
    if (task.version !== input.expectedVersion) return { status: 409, body: { error: 'stale task version', task } };
    if (method === 'POST' && task.schedule) return { status: 409, body: { error: 'task is already scheduled', task } };
    if (method === 'PATCH' && !task.schedule) return { status: 409, body: { error: 'task is not scheduled' } };

    const action = method === 'POST' ? 'schedule' : 'reschedule';
    recordScheduleOperation(input.idempotencyKey, { status: 'running', action, board, taskId });
    let eventId = task.schedule && task.schedule.calendarEventId;
    try {
      if (method === 'POST') {
        const event = await createEvent({
          calendar: TASK_CALENDAR_ID,
          title: task.text,
          startIso: input.startsAt,
          durationMin: input.durationMinutes,
          extendedProperties: { private: {
            openclawBoard: board,
            openclawTaskId: taskId,
            openclawIdempotencyKey: input.idempotencyKey,
          } },
        });
        eventId = event && event.id;
        if (!eventId) throw new Error('calendar did not return an event id');
      } else {
        await updateEvent({
          calendar: task.schedule.calendarId || TASK_CALENDAR_ID,
          eventId,
          title: task.text,
          startIso: input.startsAt,
          durationMin: input.durationMinutes,
        });
      }

      const updated = store.setItemSchedule(file, taskId, scheduleRecord(input, eventId), input.expectedVersion);
      recordScheduleOperation(input.idempotencyKey, { status: 'succeeded', calendarEventId: eventId, taskVersion: updated.version });
      return { status: 200, body: updated };
    } catch (error) {
      let compensation = 'not-needed';
      if (method === 'POST' && eventId) {
        try {
          await deleteEvent({ calendar: TASK_CALENDAR_ID, eventId });
          compensation = 'deleted-created-event';
        } catch (compensationError) {
          compensation = `failed: ${compensationError.message}`;
        }
      } else if (method === 'PATCH' && task.schedule) {
        try {
          await updateEvent({
            calendar: task.schedule.calendarId || TASK_CALENDAR_ID,
            eventId,
            title: task.text,
            startIso: task.schedule.startsAt,
            durationMin: task.schedule.durationMinutes || 30,
          });
          compensation = 'restored-previous-event-time';
        } catch (compensationError) {
          compensation = `failed: ${compensationError.message}`;
        }
      }
      recordScheduleOperation(input.idempotencyKey, { status: 'failed', error: error.message, compensation, calendarEventId: eventId });
      return { status: 502, body: { error: `task schedule failed: ${error.message}`, compensation, idempotencyKey: input.idempotencyKey } };
    }
  } finally {
    scheduleLocks.delete(lockKey);
  }
}

function getItemHistoryBuckets(filePath) {
  return { months: store.getItemHistoryBuckets(filePath) };
}

function getItemHistoryMonth(filePath, year, month) {
  return { items: store.getItemHistoryMonth(filePath, year, month) };
}

// calories/protein are computed fresh from the food ledger on every request
// (same source list-today uses) rather than trusted from a cached counter —
// a cached "current" value can silently drift from the ledger (a failed
// sync PATCH, a stale write, anything) with nothing to catch it. The ledger
// is the only source of truth; hourlyWorkouts has no live-computable
// equivalent yet, so it still reads from the cache.
function getHealth() {
  const state = store.readTodayHealth(TODAY_HEALTH_FILE, HEALTH_DEFAULTS);
  const outcome = runHealthWorkflow(['list-today']);
  if (!outcome.result) {
    log(`getHealth: falling back to cached calories/protein — ${outcome.error}`);
    return Object.fromEntries(Object.keys(HEALTH_DEFAULTS).map((key) => [key, state[key]]));
  }
  const { totals } = outcome.result;
  return {
    calories: { ...state.calories, current: totals.calories },
    protein: { ...state.protein, current: totals.protein },
    hourlyWorkouts: state.hourlyWorkouts,
  };
}

function patchHealthState(patch) {
  const { date, ...rest } = store.patchHealth(TODAY_HEALTH_FILE, HEALTH_DEFAULTS, patch);
  return rest;
}

// ── Financials — spending today and upcoming recurring transactions ─────
// Everything below is computed fresh on every request straight from
// finance.db (no cached/persisted state), so it self-corrects as new
// transactions get parsed — same spawnSync-sqlite3 approach as spent_today.

function runFinSql(sql) {
  const result = spawnSync('sqlite3', ['-json', FIN_DB, sql], { encoding: 'utf8', timeout: 10000 });
  if (result.status !== 0) {
    log(`financials query failed: ${(result.stderr || '').slice(0, 200)}`);
    return [];
  }
  try { return JSON.parse(result.stdout || '[]'); } catch { return []; }
}

function parseYMD(str) {
  const [y, m, d] = str.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function toYMD(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getActiveMonthlyExpenses() {
  return runFinSql(`
    SELECT id, name, amount_est AS amount, due_day, is_negotiable
    FROM expenses
    WHERE active=1 AND recurrence='monthly' AND amount_est IS NOT NULL AND due_day IS NOT NULL;
  `);
}

function daysInMonth(year, monthIndex) {
  return new Date(year, monthIndex + 1, 0).getDate();
}

// due_day clamped to short months (e.g. 31 in a 30-day month lands on the
// last day), rolling into next month once this month's occurrence has passed.
function nextOccurrence(today, dueDay) {
  const year = today.getFullYear();
  const month = today.getMonth();
  const thisMonthDay = Math.min(dueDay, daysInMonth(year, month));
  if (thisMonthDay >= today.getDate()) return new Date(year, month, thisMonthDay);

  const nextMonth = month === 11 ? 0 : month + 1;
  const nextMonthYear = month === 11 ? year + 1 : year;
  const nextMonthDay = Math.min(dueDay, daysInMonth(nextMonthYear, nextMonth));
  return new Date(nextMonthYear, nextMonth, nextMonthDay);
}

// Every active monthly expense recurs forever until deleted, so it always
// contributes exactly one entry: its next due date (this month if not yet
// passed, otherwise next month).
function upcomingFromExpenses(expenses, today) {
  return expenses.map((e) => ({
    id: e.id,
    name: e.name,
    amount: e.amount,
    due_date: toYMD(nextOccurrence(today, e.due_day)),
    is_negotiable: !!e.is_negotiable,
  }));
}

function getPendingReview() {
  return runFinSql(`
    SELECT id, date, type, amount, merchant_raw
    FROM transactions
    WHERE needs_review=1 AND type='debit'
    ORDER BY date ASC, id ASC;
  `);
}

function markReviewed(id) {
  const rows = runFinSql(`
    UPDATE transactions SET needs_review=0
    WHERE id=${id} AND needs_review=1 AND type='debit';
    SELECT changes() AS n;
  `);
  return !!(rows[0] && rows[0].n === 1);
}

// spawnSync + sqlite3 CLI has no parameter binding, so text values going
// into an interpolated SQL string must be escaped by hand (standard SQL:
// double up single quotes). Numeric fields are validated as real numbers
// before interpolation instead, never escaped-as-string.
function sqlEscape(value) {
  return String(value).replace(/'/g, "''");
}

function addExpense({ name, amount_est, due_day, notes }) {
  const cleanName = String(name || '').trim();
  const amount = Number(amount_est);
  const day = Number(due_day);
  if (!cleanName) return { error: 'name is required' };
  if (!Number.isFinite(amount) || amount <= 0) return { error: 'amount_est must be a positive number' };
  if (!Number.isInteger(day) || day < 1 || day > 31) return { error: 'due_day must be an integer 1-31' };
  const cleanNotes = sqlEscape(String(notes || '').trim());

  // last_insert_rowid() is connection-scoped, so it must run in the same
  // sqlite3 invocation as the INSERT — a separate spawnSync call would see
  // a fresh connection and return nothing useful.
  const rows = runFinSql(`
    INSERT INTO expenses (name, amount_est, due_day, recurrence, is_negotiable, active, notes)
    VALUES ('${sqlEscape(cleanName)}', ${amount}, ${day}, 'monthly', 0, 1, '${cleanNotes}');
    SELECT * FROM expenses WHERE id = last_insert_rowid();
  `);
  return { expense: rows[0] };
}

function removeExpense(id) {
  const rows = runFinSql(`
    DELETE FROM expenses WHERE id=${id};
    SELECT changes() AS n;
  `);
  return !!(rows[0] && rows[0].n === 1);
}

function getFinancials() {
  const todayString = store.todayStr();
  const today = parseYMD(todayString);

  const spentRows = runFinSql(`SELECT COALESCE(SUM(amount), 0) AS spent_today FROM transactions WHERE type = 'debit' AND date = '${todayString}';`);
  const spent = spentRows[0] && typeof spentRows[0].spent_today === 'number' ? spentRows[0].spent_today : 0;

  const upcomingTransactions = upcomingFromExpenses(getActiveMonthlyExpenses(), today)
    .sort((left, right) => left.due_date.localeCompare(right.due_date) || left.name.localeCompare(right.name));

  return {
    spent_today: Math.round(spent * 100) / 100,
    currency: 'USD',
    upcoming_transactions: upcomingTransactions,
    pending_review: getPendingReview(),
    budget: getBudget(today),
  };
}

// ── Budget — balance + shortfall forecast ────────────────────────────────
// Balance comes from account_balances (cached values returned by Plaid
// Transactions Sync and written by sync_plaid_transactions.js; Plaid is
// never called live from here), summed across
// the latest snapshot per account. The forecast walks BUDGET_LOOKAHEAD_DAYS
// forward day by day (same expansion approach as the retired
// upcoming_check.py) applying every active monthly expense's due day,
// clamped to short months the same way nextOccurrence() does. It is
// deliberately expense-only: the transaction pipeline ignores deposits, so
// there is no income data to project against — the UI/voice layer must
// say so rather than imply a smarter forecast than this actually is.

const BUDGET_LOOKAHEAD_DAYS = 45;
const BUDGET_WARNING_THRESHOLD = 100;
const BUDGET_NOTE = 'Based on known recurring bills only — does not account for future income.';

function getLatestAccountBalances() {
  return runFinSql(`
    SELECT account_id, institution_name, account_name, account_mask, balance_current, balance_available, currency, fetched_at
    FROM account_balances ab
    WHERE fetched_at = (SELECT MAX(fetched_at) FROM account_balances WHERE account_id = ab.account_id)
    ORDER BY account_name;
  `);
}

function expandExpenseEvents(expenses, today, horizonDays) {
  const events = [];
  const cursor = new Date(today);
  for (let i = 0; i <= horizonDays; i += 1) {
    const lastDayOfMonth = daysInMonth(cursor.getFullYear(), cursor.getMonth());
    for (const expense of expenses) {
      const effectiveDay = Math.min(expense.due_day, lastDayOfMonth);
      if (cursor.getDate() === effectiveDay) {
        events.push({ date: toYMD(cursor), name: expense.name, amount: expense.amount });
      }
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return events;
}

function getBudget(today) {
  const accounts = getLatestAccountBalances();
  if (!accounts.length) {
    return {
      accounts: [],
      current_balance: null,
      projected_min_balance: null,
      projected_min_date: null,
      projected_min_cause: null,
      warning: false,
      note: 'No balance data yet — waiting on the first Plaid sync.',
    };
  }

  const currentBalance = accounts.reduce((sum, a) => sum + (a.balance_current || 0), 0);
  const events = expandExpenseEvents(getActiveMonthlyExpenses(), today, BUDGET_LOOKAHEAD_DAYS);

  let running = currentBalance;
  let minBalance = currentBalance;
  let minDate = toYMD(today);
  let minCause = null;
  for (const event of events) {
    running -= event.amount;
    if (running < minBalance) {
      minBalance = running;
      minDate = event.date;
      minCause = event.name;
    }
  }

  return {
    accounts: accounts.map((a) => ({
      name: a.account_name,
      mask: a.account_mask,
      balance: a.balance_current,
      as_of: a.fetched_at,
    })),
    current_balance: Math.round(currentBalance * 100) / 100,
    projected_min_balance: Math.round(minBalance * 100) / 100,
    projected_min_date: minDate,
    projected_min_cause: minCause,
    warning: minBalance < BUDGET_WARNING_THRESHOLD,
    note: BUDGET_NOTE,
  };
}

function getCalendar(dateStr) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(dateStr || '') ? dateStr : store.todayStr();
  const result = spawnSync('/bin/bash', [CAL_READ, date], { encoding: 'utf8', timeout: 45000 });
  if (result.status !== 0) {
    log(`calendar read failed for ${date}: ${(result.stderr || '').slice(0, 200)}`);
    return { events: [] };
  }
  const events = [];
  for (const line of (result.stdout || '').split('\n')) {
    const m = line.match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})\|(.*)$/);
    if (!m) continue;
    const [, sh, sm, eh, em, title] = m;
    const pad = (n) => n.padStart(2, '0');
    events.push({
      id: store.newId(),
      title: title.trim(),
      start: `${pad(sh)}:${sm}`,
      end: `${pad(eh)}:${em}`,
    });
  }
  return { events };
}

const calendarMonthCache = new Map();
const CALENDAR_MONTH_CACHE_MS = 60 * 1000;

function getCalendarMonth(monthStr) {
  const now = new Date();
  const fallbackMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const month = /^\d{4}-(?:0[1-9]|1[0-2])$/.test(monthStr || '') ? monthStr : fallbackMonth;
  const cached = calendarMonthCache.get(month);
  if (cached && Date.now() - cached.loadedAt < CALENDAR_MONTH_CACHE_MS) return cached.value;

  const result = spawnSync(process.execPath, [CAL_READ_RANGE, month], { encoding: 'utf8', timeout: 45000 });
  if (result.status !== 0) {
    log(`calendar month read failed for ${month}: ${(result.stderr || '').slice(0, 200)}`);
    return { month, events: [] };
  }
  try {
    const parsed = JSON.parse(result.stdout || '{}');
    const value = {
      month,
      events: Array.isArray(parsed.events) ? parsed.events.map((event) => ({
        id: String(event.id || store.newId()),
        date: String(event.date || ''),
        title: String(event.title || '').trim(),
        start: String(event.start || '00:00').padStart(5, '0'),
        end: String(event.end || '23:59').padStart(5, '0'),
        allDay: event.allDay === true,
      })).filter((event) => /^\d{4}-\d{2}-\d{2}$/.test(event.date)) : [],
    };
    calendarMonthCache.set(month, { loadedAt: Date.now(), value });
    return value;
  } catch (error) {
    log(`calendar month parse failed for ${month}: ${error.message}`);
    return { month, events: [] };
  }
}

// ── Router ───────────────────────────────────────────────────────────────

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const segments = url.pathname.split('/').filter(Boolean);

  if (segments[0] !== 'api') return sendJson(res, 404, { error: 'not found' });

  const [, resource, a, b, c, d] = segments;

  // Set mutation context so sendJson can auto-log data mutations
  _mutationCtx = { resource, method: req.method, segments, body: null };

  // "/history" and "/history/:year/:month" branches below sit alongside each
  // resource's normal GET/POST/PATCH routes — 'history' can never collide
  // with a real item id (tasks/grocery ids are random hex; goal ids are
  // slugified habit labels).
  function parseYearMonth(year, month) {
    const y = Number(year);
    const m = Number(month);
    if (!Number.isInteger(y) || !Number.isInteger(m) || m < 1 || m > 12) return null;
    return { y, m };
  }

  try {
    // ── /api/goals, /api/goals/:id, /api/goals/history[/:year/:month] ──
    if (resource === 'goals') {
      if (!a && req.method === 'GET') return sendJson(res, 200, getGoals());
      if (a === 'history' && !b && req.method === 'GET') return sendJson(res, 200, getGoalsHistoryBuckets());
      if (a === 'history' && b && c && req.method === 'GET') {
        const ym = parseYearMonth(b, c);
        return ym ? sendJson(res, 200, getGoalsHistoryMonth(ym.y, ym.m)) : sendJson(res, 400, { error: 'invalid year/month' });
      }
      if (a && a !== 'history' && req.method === 'PATCH') {
        const body = await readBody(req);
        const result = patchGoal(a, !!body.done);
        if (result) broadcast('goals', getGoals());
        return result ? sendJson(res, 200, {}) : sendJson(res, 404, { error: `unknown goal id '${a}'` });
      }
      return sendJson(res, 405, { error: 'method not allowed' });
    }

    // ── /api/goal-lists[/:listId[/items/:itemId]] ──
    if (resource === 'lists' || resource === 'goal-lists') {
      if (!a && req.method === 'GET') return sendJson(res, 200, listGoalLists());
      if (!a && req.method === 'POST') {
        const body = await readBody(req);
        const result = addGoalList(body.name);
        return result.error ? sendJson(res, 400, result) : sendJson(res, 201, result.list);
      }
      if (a && !b && req.method === 'GET') {
        const list = readGoalLists().lists.find((candidate) => candidate.id === a);
        return list ? sendJson(res, 200, list) : sendJson(res, 404, { error: `unknown goal list '${a}'` });
      }
      if (a && !b && req.method === 'PATCH') {
        const body = await readBody(req);
        const name = cleanText(body.name);
        if (!name) return sendJson(res, 400, { error: 'name is required' });
        const list = mutateGoalList(a, (target, data) => {
          if (data.lists.some((candidate) => candidate.id !== a && candidate.name.toLocaleLowerCase() === name.toLocaleLowerCase())) return { error: 'a list with that name already exists' };
          target.name = name;
          return target;
        });
        if (!list) return sendJson(res, 404, { error: `unknown goal list '${a}'` });
        return list.error ? sendJson(res, 400, list) : sendJson(res, 200, list);
      }
      if (a && !b && req.method === 'DELETE') {
        const removed = removeGoalList(a);
        return removed ? sendJson(res, 200, { ok: true, removed }) : sendJson(res, 404, { error: `unknown goal list '${a}'` });
      }
      if (a && b === 'items' && !c && req.method === 'POST') {
        const body = await readBody(req);
        const text = cleanText(body.text);
        if (!text) return sendJson(res, 400, { error: 'text is required' });
        const item = mutateGoalList(a, (list) => {
          const created = { id: store.newId(), text, done: false, added: store.todayStr(), doneDate: null };
          list.items.push(created);
          return created;
        });
        return item ? sendJson(res, 201, item) : sendJson(res, 404, { error: `unknown goal list '${a}'` });
      }
      if (a && b === 'items' && c && req.method === 'PATCH') {
        const body = await readBody(req);
        const item = mutateGoalList(a, (list) => {
          const target = list.items.find((candidate) => candidate.id === c);
          if (!target) return null;
          if (body.text !== undefined) {
            const text = cleanText(body.text);
            if (!text) return { error: 'text is required' };
            target.text = text;
          }
          if (body.done !== undefined) {
            target.done = !!body.done;
            target.doneDate = target.done ? store.todayStr() : null;
          }
          return target;
        });
        if (!item) return sendJson(res, 404, { error: 'unknown goal list or item' });
        return item.error ? sendJson(res, 400, item) : sendJson(res, 200, item);
      }
      if (a && b === 'items' && c && req.method === 'DELETE') {
        const item = mutateGoalList(a, (list) => {
          const index = list.items.findIndex((candidate) => candidate.id === c);
          return index < 0 ? null : list.items.splice(index, 1)[0];
        });
        return item ? sendJson(res, 200, { ok: true, removed: item }) : sendJson(res, 404, { error: 'unknown goal list or item' });
      }
      return sendJson(res, 405, { error: 'method not allowed' });
    }

    // ── /api/tasks/:board, /api/tasks/:board/:id, /api/tasks/:board/history[/:year/:month] ──
    if (resource === 'tasks') {
      const board = a === 'accenture' ? 'work' : a;
      if (!board || !BOARDS.includes(board)) return sendJson(res, 404, { error: `unknown board '${a || ''}'` });
      const file = boardFile(board);
      if (!b && req.method === 'GET') return sendJson(res, 200, listItems(file));
      if (!b && req.method === 'POST') {
        const body = await readBody(req);
        const item = addItem(file, body.text);
        if (item) broadcast(`tasks:${board}`, listItems(file));
        return item ? sendJson(res, 201, item) : sendJson(res, 400, { error: 'text is required' });
      }
      if (b === 'history' && !c && req.method === 'GET') return sendJson(res, 200, getItemHistoryBuckets(file));
      if (b === 'history' && c && d && req.method === 'GET') {
        const ym = parseYearMonth(c, d);
        return ym ? sendJson(res, 200, getItemHistoryMonth(file, ym.y, ym.m)) : sendJson(res, 400, { error: 'invalid year/month' });
      }
      if (b && b !== 'history' && c === 'schedule' && ['POST', 'PATCH', 'DELETE'].includes(req.method)) {
        const body = await readBody(req);
        const outcome = await mutateTaskSchedule({ method: req.method, board, taskId: b, body });
        if (outcome.status === 200) broadcast(`tasks:${board}`, listItems(file));
        return sendJson(res, outcome.status, outcome.body);
      }
      if (b && b !== 'history' && req.method === 'PATCH') {
        const body = await readBody(req);
        if (body.done === undefined) return sendJson(res, 400, { error: 'done is required' });
        const item = patchItem(file, b, !!body.done, body.expectedVersion);
        if (item && item.conflict) return sendJson(res, 409, { error: 'stale task version', task: item.item });
        if (item) broadcast(`tasks:${board}`, listItems(file));
        return item ? sendJson(res, 200, item) : sendJson(res, 404, { error: `unknown task id '${b}'` });
      }
      if (b && b !== 'history' && req.method === 'DELETE') {
        const item = removeItem(file, b);
        if (item) broadcast(`tasks:${board}`, listItems(file));
        return item ? sendJson(res, 200, { ok: true, removed: item }) : sendJson(res, 404, { error: `unknown task id '${b}'` });
      }
      return sendJson(res, 405, { error: 'method not allowed' });
    }

    // ── /api/grocery, /api/grocery/:id ──
    if (resource === 'grocery') {
      if (!a && req.method === 'GET') return sendJson(res, 200, listItems(GROCERY_FILE));
      if (!a && req.method === 'POST') {
        const body = await readBody(req);
        const item = addItem(GROCERY_FILE, body.text);
        if (item) broadcast('grocery', listItems(GROCERY_FILE));
        return item ? sendJson(res, 201, item) : sendJson(res, 400, { error: 'text is required' });
      }
      if (a && req.method === 'PATCH') {
        const body = await readBody(req);
        const item = patchItem(GROCERY_FILE, a, !!body.done);
        if (item) broadcast('grocery', listItems(GROCERY_FILE));
        return item ? sendJson(res, 200, item) : sendJson(res, 404, { error: `unknown grocery id '${a}'` });
      }
      if (a && req.method === 'DELETE') {
        const item = removeItem(GROCERY_FILE, a);
        if (item) broadcast('grocery', listItems(GROCERY_FILE));
        return item ? sendJson(res, 200, { ok: true, removed: item }) : sendJson(res, 404, { error: `unknown grocery id '${a}'` });
      }
      return sendJson(res, 405, { error: 'method not allowed' });
    }

    // ── /api/meal-planner/recipes[/:id], /api/meal-planner/plan[/assemble|/items[/:id]] ──
    // Grocery (above) and meal-planning are deliberately separate systems —
    // this block never touches GROCERY_FILE and the grocery block above
    // never touches meal-planner-workflow.js.
    if (resource === 'meal-planner') {
      if (a === 'recipes') {
        if (!b && req.method === 'GET') {
          const cliArgs = ['list-recipes', '--active-only'];
          const type = url.searchParams.get('type');
          const tag = url.searchParams.get('tag');
          if (type) cliArgs.push('--type', type);
          if (tag) cliArgs.push('--tag', tag);
          const outcome = runMealPlannerWorkflow(cliArgs);
          return outcome.error ? sendJson(res, 500, { error: outcome.error }) : sendJson(res, 200, { recipes: outcome.result.recipes });
        }
        if (!b && req.method === 'POST') {
          const body = await readBody(req);
          const cliArgs = ['add-recipe'];
          if (body.name !== undefined) cliArgs.push('--name', String(body.name));
          if (body.type !== undefined) cliArgs.push('--type', String(body.type));
          if (body.serving !== undefined) cliArgs.push('--serving', String(body.serving));
          if (body.calories !== undefined) cliArgs.push('--calories', String(body.calories));
          if (body.protein !== undefined) cliArgs.push('--protein', String(body.protein));
          if (body.notes) cliArgs.push('--notes', String(body.notes));
          if (body.mealSlotHint) cliArgs.push('--meal-slot-hint', String(body.mealSlotHint));
          if (Array.isArray(body.tags) && body.tags.length) cliArgs.push('--tags', body.tags.join(','));
          if (Array.isArray(body.aliases) && body.aliases.length) cliArgs.push('--aliases', body.aliases.join(','));
          if (Array.isArray(body.ingredients) && body.ingredients.length) {
            cliArgs.push('--ingredients', body.ingredients.map((i) => (i.quantity ? `${i.name}:${i.quantity}` : i.name)).join(','));
          }
          const outcome = runMealPlannerWorkflow(cliArgs);
          if (outcome.error) {
            const status = outcome.code === 'DUPLICATE_RECIPE' ? 409 : outcome.code === 'INVALID_ARGUMENT' ? 400 : 500;
            return sendJson(res, status, { error: outcome.error });
          }
          return sendJson(res, 201, outcome.result.recipe);
        }
        if (b && !c && req.method === 'PATCH') {
          const body = await readBody(req);
          const cliArgs = ['update-recipe', '--id', b];
          if (body.name !== undefined) cliArgs.push('--name', String(body.name));
          if (body.type !== undefined) cliArgs.push('--type', String(body.type));
          if (body.serving !== undefined) cliArgs.push('--serving', String(body.serving));
          if (body.calories !== undefined) cliArgs.push('--calories', String(body.calories));
          if (body.protein !== undefined) cliArgs.push('--protein', String(body.protein));
          if (body.notes !== undefined) cliArgs.push('--notes', String(body.notes));
          if (body.mealSlotHint !== undefined) cliArgs.push('--meal-slot-hint', String(body.mealSlotHint));
          const outcome = runMealPlannerWorkflow(cliArgs);
          if (outcome.error) {
            const status = outcome.code === 'NOT_FOUND' ? 404 : outcome.code === 'DUPLICATE_RECIPE' ? 409 : outcome.code === 'INVALID_ARGUMENT' ? 400 : 500;
            return sendJson(res, status, { error: outcome.error });
          }
          return sendJson(res, 200, outcome.result.recipe);
        }
        if (b && !c && req.method === 'DELETE') {
          const outcome = runMealPlannerWorkflow(['remove-recipe', '--id', b]);
          if (outcome.error) {
            const status = outcome.code === 'NOT_FOUND' ? 404 : 500;
            return sendJson(res, status, { error: outcome.error });
          }
          return sendJson(res, 200, { ok: true, removed: outcome.result.removed });
        }
        return sendJson(res, 405, { error: 'method not allowed' });
      }

      if (a === 'plan') {
        if (!b && req.method === 'GET') {
          const date = url.searchParams.get('date');
          const outcome = runMealPlannerWorkflow(['get-plan', ...(date ? ['--date', date] : [])]);
          return outcome.error ? sendJson(res, 500, { error: outcome.error }) : sendJson(res, 200, outcome.result);
        }
        if (b === 'assemble' && !c && req.method === 'POST') {
          const body = await readBody(req);
          const date = url.searchParams.get('date') || body.date;
          const cliArgs = ['assemble-plan'];
          if (date) cliArgs.push('--date', String(date));
          if (body.lockExisting) cliArgs.push('--lock-existing');
          const outcome = runMealPlannerWorkflow(cliArgs);
          if (outcome.error) {
            const status = outcome.code === 'DASHBOARD_UNAVAILABLE' ? 503 : 500;
            return sendJson(res, status, { error: outcome.error });
          }
          broadcast('meal-planner', outcome.result);
          return sendJson(res, 200, outcome.result);
        }
        if (b === 'items' && !c && req.method === 'POST') {
          const body = await readBody(req);
          if (!body.slot || (!body.recipeId && !body.recipeName)) {
            return sendJson(res, 400, { error: 'slot and recipeId or recipeName are required' });
          }
          const cliArgs = ['add-plan-item', '--slot', String(body.slot)];
          if (body.date) cliArgs.push('--date', String(body.date));
          if (body.recipeId) cliArgs.push('--recipe-id', String(body.recipeId));
          if (body.recipeName) cliArgs.push('--recipe-name', String(body.recipeName));
          if (body.calories !== undefined) cliArgs.push('--calories', String(body.calories));
          if (body.protein !== undefined) cliArgs.push('--protein', String(body.protein));
          const outcome = runMealPlannerWorkflow(cliArgs);
          if (outcome.error) {
            const status = outcome.code === 'NOT_FOUND' ? 404 : outcome.code === 'INVALID_ARGUMENT' ? 400 : 500;
            return sendJson(res, status, { error: outcome.error });
          }
          const planOutcome = runMealPlannerWorkflow(['get-plan', ...(body.date ? ['--date', String(body.date)] : [])]);
          if (!planOutcome.error) broadcast('meal-planner', planOutcome.result);
          return sendJson(res, 201, outcome.result.item);
        }
        if (b === 'items' && c && req.method === 'PATCH') {
          const body = await readBody(req);
          if (!body.recipeId && !body.recipeName) return sendJson(res, 400, { error: 'recipeId or recipeName is required' });
          const cliArgs = ['swap-plan-item', '--item-id', c];
          if (body.recipeId) cliArgs.push('--recipe-id', String(body.recipeId));
          if (body.recipeName) cliArgs.push('--recipe-name', String(body.recipeName));
          if (body.calories !== undefined) cliArgs.push('--calories', String(body.calories));
          if (body.protein !== undefined) cliArgs.push('--protein', String(body.protein));
          const outcome = runMealPlannerWorkflow(cliArgs);
          if (outcome.error) {
            const status = outcome.code === 'NOT_FOUND' ? 404 : outcome.code === 'INVALID_ARGUMENT' ? 400 : 500;
            return sendJson(res, status, { error: outcome.error });
          }
          const planOutcome = runMealPlannerWorkflow(['get-plan']);
          if (!planOutcome.error) broadcast('meal-planner', planOutcome.result);
          return sendJson(res, 200, outcome.result.item);
        }
        if (b === 'items' && c && req.method === 'DELETE') {
          const outcome = runMealPlannerWorkflow(['remove-plan-item', '--item-id', c]);
          if (outcome.error) {
            const status = outcome.code === 'NOT_FOUND' ? 404 : 500;
            return sendJson(res, status, { error: outcome.error });
          }
          const planOutcome = runMealPlannerWorkflow(['get-plan']);
          if (!planOutcome.error) broadcast('meal-planner', planOutcome.result);
          return sendJson(res, 200, { ok: true, removedItemId: outcome.result.removedItemId });
        }
        return sendJson(res, 405, { error: 'method not allowed' });
      }

      return sendJson(res, 404, { error: `unknown meal-planner resource '${a || ''}'` });
    }

    // ── /api/health (totals plus today's food-ledger detail) ──
    if (resource === 'health') {
      if (!a && req.method === 'GET') return sendJson(res, 200, getHealth());
      if (!a && req.method === 'PATCH') {
        const body = await readBody(req);
        const patched = patchHealthState(body);
        broadcast('health', getHealth());
        return sendJson(res, 200, patched);
      }
      if (a === 'foods' && !b && req.method === 'GET') {
        const outcome = runHealthWorkflow(['list-today']);
        return outcome.error
          ? sendJson(res, 500, { error: outcome.error })
          : sendJson(res, 200, { date: outcome.result.date, entries: outcome.result.entries, totals: outcome.result.totals });
      }
      if (a === 'foods' && b && !c && req.method === 'PATCH') {
        const body = await readBody(req);
        const calories = Number(body.calories);
        const protein = Number(body.protein);
        if (!Number.isFinite(calories) || calories < 0 || calories > 10000
          || !Number.isFinite(protein) || protein < 0 || protein > 1000) {
          return sendJson(res, 400, { error: 'calories and protein must be valid non-negative numbers' });
        }
        const outcome = runHealthWorkflow([
          'correct-food', '--id', b,
          '--calories', String(calories),
          '--protein', String(protein),
          '--reason', 'edited from Echo dashboard',
          '--idempotency-key', `echo-dashboard-edit-${crypto.randomUUID()}`,
        ]);
        if (outcome.error) {
          const status = outcome.code === 'NOT_FOUND' ? 404 : 500;
          return sendJson(res, status, { error: outcome.error });
        }
        broadcast('health', getHealth());
        return sendJson(res, 200, {
          ok: true,
          replacedEntryId: b,
          entry: outcome.result.entry,
          totals: outcome.result.totals,
        });
      }
      if (a === 'foods' && b && !c && req.method === 'DELETE') {
        const outcome = runHealthWorkflow([
          'remove-food', '--id', b,
          '--reason', 'removed from Echo dashboard',
          '--idempotency-key', `echo-dashboard-remove-${crypto.randomUUID()}`,
        ]);
        if (outcome.error) {
          const status = outcome.code === 'NOT_FOUND' ? 404 : 500;
          return sendJson(res, status, { error: outcome.error });
        }
        broadcast('health', getHealth());
        return sendJson(res, 200, { ok: true, removedEntryId: b, totals: outcome.result.totals });
      }
      return sendJson(res, 405, { error: 'method not allowed' });
    }

    // ── /api/financials (read), /api/financials/review/:id (confirm) ──
    if (resource === 'financials') {
      if (!a && req.method === 'GET') return sendJson(res, 200, getFinancials());
      if (a === 'review' && b && req.method === 'PATCH') {
        if (!/^\d+$/.test(b)) return sendJson(res, 400, { error: 'invalid transaction id' });
        const ok = markReviewed(Number(b));
        if (ok) broadcast('financials', getFinancials());
        return ok ? sendJson(res, 200, { ok: true }) : sendJson(res, 404, { error: `no pending transaction with id '${b}'` });
      }
      if (a === 'expenses' && !b && req.method === 'POST') {
        const body = await readBody(req);
        const result = addExpense(body);
        if (!result.error) broadcast('financials', getFinancials());
        return result.error ? sendJson(res, 400, { error: result.error }) : sendJson(res, 201, result.expense);
      }
      if (a === 'expenses' && b && req.method === 'DELETE') {
        if (!/^\d+$/.test(b)) return sendJson(res, 400, { error: 'invalid expense id' });
        const ok = removeExpense(Number(b));
        if (ok) broadcast('financials', getFinancials());
        return ok ? sendJson(res, 200, { ok: true }) : sendJson(res, 404, { error: `no expense with id '${b}'` });
      }
      return sendJson(res, 405, { error: 'method not allowed' });
    }

    // ── /api/calendar?date=YYYY-MM-DD or ?month=YYYY-MM (read-only) ──
    if (resource === 'calendar') {
      if (!a && req.method === 'GET') {
        const month = url.searchParams.get('month');
        return sendJson(res, 200, month ? getCalendarMonth(month) : getCalendar(url.searchParams.get('date')));
      }
      return sendJson(res, 405, { error: 'method not allowed' });
    }

    // ── /api/notify/:resource — ping from writers that mutate their own
    // store directly (finance email parser writing to finance.db,
    // health-tracker's food logging writing to its ledger) without going
    // through this process's own handlers above. No body; just recomputes
    // the resource fresh and broadcasts it.
    if (resource === 'notify' && req.method === 'POST') {
      if (a === 'financials') { broadcast('financials', getFinancials()); return sendJson(res, 200, { ok: true }); }
      if (a === 'health') { broadcast('health', getHealth()); return sendJson(res, 200, { ok: true }); }
      return sendJson(res, 404, { error: `unknown notify resource '${a || ''}'` });
    }

    return sendJson(res, 404, { error: 'not found' });
  } catch (e) {
    log(`error handling ${req.method} ${url.pathname}: ${e.stack || e.message}`);
    return sendJson(res, e instanceof SyntaxError ? 400 : 500, { error: e instanceof SyntaxError ? 'invalid JSON body' : 'internal error' });
  }
}

// ── Server ───────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  // Permissive CORS: this is a bearer-token-gated, LAN-only service (see the
  // README's "Auth: shared LAN token" reasoning) — the token, not CORS, is
  // the trust boundary, so this just avoids foot-guns if the dashboard's
  // static files end up served from a different origin/port than this API.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const { pathname, searchParams } = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // Static dashboard-web assets are unauthenticated on purpose: the WebView's
  // very first request (loading index.html) has no way to carry the bearer
  // token yet — app.js is what attaches it to later fetch() calls, and it
  // can't run before it's loaded. The token protects the data behind
  // /api/*; the page shell itself isn't sensitive, and this is already a
  // LAN-only trust model per the README.
  if (req.method === 'GET' && Object.prototype.hasOwnProperty.call(STATIC_FILES, pathname)) {
    serveStatic(res, pathname);
    return;
  }

  const auth = req.headers.authorization || '';
  const provided = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  // EventSource can't set an Authorization header, so this one route also
  // accepts the token as a query param — every other client here
  // (dashboard-web's fetch(), health-workflow.js, the finance parser) sets
  // a real header instead.
  const isEventsRoute = req.method === 'GET' && pathname === '/api/events';
  const queryProvided = isEventsRoute ? (searchParams.get('token') || '') : '';
  if (provided !== TOKEN && queryProvided !== TOKEN) { sendJson(res, 401, { error: 'unauthorized' }); return; }

  if (isEventsRoute) { handleEvents(req, res); return; }

  handle(req, res);
});

server.listen(PORT, HOST, () => {
  log(`listening on http://${HOST}:${PORT}`);
});
