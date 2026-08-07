'use strict';

const crypto = require('crypto');
const path = require('path');
const { spawn } = require('child_process');

const NODE_BIN = process.env.OPENCLAW_NODE_BIN || '/opt/homebrew/opt/node@22/bin/node';
const DASHBOARD_SCRIPT = process.env.DASHBOARD_WORKFLOW_SCRIPT ||
  '/Users/aaronmacmini/.openclaw/workspace-main/scripts/dashboard-workflow.js';
const CALENDAR_SCRIPT = process.env.CALENDAR_WORKFLOW_SCRIPT ||
  '/Users/aaronmacmini/.openclaw/workspace-main/scripts/calendar-workflow.js';
const HEALTH_SCRIPT = process.env.HEALTH_WORKFLOW_SCRIPT ||
  '/Users/aaronmacmini/.openclaw/workspace-health-tracker/scripts/health-workflow.js';
const FINANCE_SCRIPT = process.env.FINANCE_WORKFLOW_SCRIPT ||
  '/Users/aaronmacmini/.openclaw/workspace-finance-agent/scripts/finance-workflow.js';
const MEAL_PLANNER_SCRIPT = process.env.MEAL_PLANNER_WORKFLOW_SCRIPT ||
  '/Users/aaronmacmini/.openclaw/workspace-meal-planner/scripts/meal-planner-workflow.js';
const CALENDAR_TIMEZONE = process.env.OPENCLAW_CALENDAR_TIMEZONE || 'America/New_York';

const PYTHON_BIN = process.env.ROUTINE_ROUTER_PYTHON_BIN || path.join(__dirname, 'venv', 'bin', 'python3');
const RECOGNIZE_SCRIPT = path.join(__dirname, 'recognize.py');

function boardKey(value) {
  const normalized = String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (normalized === 'work' || normalized === 'accenture') return 'work';
  if (normalized === 'personal') return 'personal';
  if (normalized === 'market lou' || normalized === 'market') return 'market-lou';
  if (normalized === 'grocery' || normalized === 'groceries') return 'grocery';
  return null;
}

function zonedDateParts(now, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (type) => Number(parts.find((part) => part.type === type).value);
  return { year: get('year'), month: get('month'), day: get('day') };
}

function relativeDate(offsetDays, now, timeZone) {
  const { year, month, day } = zonedDateParts(now, timeZone);
  const shifted = new Date(Date.UTC(year, month - 1, day + offsetDays));
  return shifted.toISOString().slice(0, 10);
}

function parseClockTime(hourText, minuteText, meridiem) {
  let hour = Number(hourText);
  const minute = Number(minuteText || 0);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || minute > 59) return null;
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    if (meridiem.toLowerCase() === 'pm' && hour !== 12) hour += 12;
    if (meridiem.toLowerCase() === 'am' && hour === 12) hour = 0;
  } else if (hour > 23) {
    return null;
  }
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

// The {when} slot is a wildcard (hassil recognizes the AddCalendar sentence
// shape, not free-form dates) — date/time extraction stays regex-based here
// because it's arithmetic, not phrasing variety, and gains nothing from a
// sentence grammar. A missing date word (e.g. "for 9am") defaults to today —
// that's the natural reading of a bare time, and how most people actually
// phrase a same-day request; only "tomorrow" shifts the date. What's still
// ambiguous is a missing *time* (e.g. "sometime tomorrow") — that yields no
// match, same as before. Confirmed via reproduction on 2026-08-03: a real
// same-day request ("add a morning meeting to my calendar for 9am") silently
// fell through to Main instead of the deterministic calendar workflow
// because this used to require an explicit "today"/"tomorrow" — see
// project-calendar-when-missing-date-word-bug-2026-08-03.
function parseCalendarWhen(when, options = {}) {
  const value = String(when || '').trim();
  const dateMatch = value.match(/\b(today|tomorrow)\b/i);
  const timeMatch = value.match(/\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)\b/i)
    || value.match(/\b(?:at\s+)?([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (!timeMatch) return null;

  const meridiem = timeMatch[3] ? timeMatch[3].replace(/\./g, '') : null;
  const time = parseClockTime(timeMatch[1], timeMatch[2], meridiem);
  if (!time) return null;
  const now = options.now || new Date();
  const timeZone = options.timeZone || CALENDAR_TIMEZONE;
  const date = relativeDate(dateMatch && dateMatch[1].toLowerCase() === 'tomorrow' ? 1 : 0, now, timeZone);
  return { date, time };
}

function matchIntent(text) {
  return new Promise((resolve) => {
    const child = spawn(PYTHON_BIN, [RECOGNIZE_SCRIPT, text], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.on('error', () => resolve({ intent: null, slots: {} }));
    child.on('close', () => {
      try {
        const parsed = JSON.parse(stdout);
        resolve({ intent: parsed.intent || null, slots: parsed.slots || {} });
      } catch (error) {
        resolve({ intent: null, slots: {} });
      }
    });
  });
}

function runWorkflow(script, args, label) {
  return new Promise((resolve) => {
    const child = spawn(NODE_BIN, [script, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => resolve({ ok: false, reply: null, error: { message: `${label}: ${error.message}` } }));
    child.on('close', () => {
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        resolve({ ok: false, reply: null, error: { message: `${label}: ${error.message}; ${stderr.slice(-300)}` } });
      }
    });
  });
}

function stableIdempotencyKey(context, text, route) {
  const source = [context.channel, context.accountId, context.conversationId, context.messageId, route, text].join('|');
  return crypto.createHash('sha256').update(source).digest('hex');
}

// A trailing "never mind" cancels the whole turn, no matter what preceded it
// — this is a global escape hatch. It's checked first in
// routeRoutineRequest, before matchIntent spawns the recognizer subprocess,
// so saying it is always the fast path out of a call, never the slow one.
const NEVERMIND_RE = /\bnever\s*mind[.,!?]*$/i;

async function routeRoutineRequest(context) {
  const text = String(context.text || '').trim();
  if (!text) return { handled: false };

  if (NEVERMIND_RE.test(text)) {
    return {
      handled: true,
      route: 'nevermind-cancel',
      ok: true,
      reply: 'OK, never mind.',
    };
  }

  const { intent, slots } = await matchIntent(text);
  if (!intent) return { handled: false };

  let route;
  let result;

  switch (intent) {
    case 'WorkoutLog':
      route = 'workout-log';
      result = await runWorkflow(HEALTH_SCRIPT, [
        'log-workout', '--idempotency-key', stableIdempotencyKey(context, text, route),
        '--original', text, '--origin-channel', context.channel || 'unknown',
      ], 'health-workflow');
      break;

    case 'DailyRunLog':
      route = 'daily-run-log';
      result = await runWorkflow(HEALTH_SCRIPT, [
        'log-daily-run', '--idempotency-key', stableIdempotencyKey(context, text, route),
        '--original', text, '--origin-channel', context.channel || 'unknown',
      ], 'health-workflow');
      break;

    case 'AddCalendar': {
      const parsed = parseCalendarWhen(slots.when, { timeZone: CALENDAR_TIMEZONE });
      if (!parsed || !slots.title) return { handled: false };
      route = 'calendar-add';
      result = await runWorkflow(CALENDAR_SCRIPT, [
        'add', '--title', slots.title, '--date', parsed.date, '--time', parsed.time,
      ], 'calendar-workflow');
      break;
    }

    case 'AddToBoard': {
      const board = boardKey(slots.board);
      if (!board || !slots.item) return { handled: false };
      route = 'dashboard-add';
      result = await runWorkflow(DASHBOARD_SCRIPT, ['add', '--board', board, '--text', slots.item], 'dashboard-workflow');
      break;
    }

    case 'ListBoard': {
      const board = boardKey(slots.board);
      if (!board) return { handled: false };
      route = 'dashboard-list';
      result = await runWorkflow(DASHBOARD_SCRIPT, ['list', '--board', board], 'dashboard-workflow');
      break;
    }

    case 'ListAllBoards':
      route = 'dashboard-list';
      result = await runWorkflow(DASHBOARD_SCRIPT, ['list', '--board', 'all'], 'dashboard-workflow');
      break;

    case 'CompleteItem': {
      if (!slots.item) return { handled: false };
      const board = boardKey(slots.board);
      route = board ? 'dashboard-complete' : 'dashboard-complete-any';
      const args = board
        ? ['complete', '--query', slots.item, '--board', board]
        : ['complete-any', '--query', slots.item];
      result = await runWorkflow(DASHBOARD_SCRIPT, args, 'dashboard-workflow');
      break;
    }

    case 'CompleteAnyFree':
      if (!slots.item) return { handled: false };
      route = 'dashboard-complete-any';
      result = await runWorkflow(DASHBOARD_SCRIPT, ['complete-any', '--query', slots.item], 'dashboard-workflow');
      break;

    case 'RemoveFromBoard': {
      const board = boardKey(slots.board);
      if (!board || !slots.item) return { handled: false };
      route = 'dashboard-remove';
      result = await runWorkflow(DASHBOARD_SCRIPT, ['remove', '--board', board, '--query', slots.item], 'dashboard-workflow');
      break;
    }

    case 'ListHabits':
      route = 'dashboard-list-habits';
      result = await runWorkflow(DASHBOARD_SCRIPT, ['list-habits'], 'dashboard-workflow');
      break;

    case 'CompleteHabit':
      if (!slots.item) return { handled: false };
      route = 'dashboard-complete-habit';
      result = await runWorkflow(DASHBOARD_SCRIPT, ['complete-habit', '--query', slots.item], 'dashboard-workflow');
      break;

    case 'ListLists':
      route = 'dashboard-list-lists';
      result = await runWorkflow(DASHBOARD_SCRIPT, ['list-lists'], 'dashboard-workflow');
      break;

    case 'CreateList':
      if (!slots.name) return { handled: false };
      route = 'dashboard-create-list';
      result = await runWorkflow(DASHBOARD_SCRIPT, ['create-list', '--name', slots.name], 'dashboard-workflow');
      break;

    case 'AddListItem': {
      // {list} covers Work/Personal/Market Lou as well as custom lists —
      // dashboard-workflow.js's resolveListTarget decides which, so no
      // board-name guard here (unlike the list-management cases below).
      if (!slots.list || !slots.item) return { handled: false };
      route = 'dashboard-add-list-item';
      result = await runWorkflow(DASHBOARD_SCRIPT, ['add-list-item', '--list', slots.list, '--text', slots.item], 'dashboard-workflow');
      break;
    }

    case 'ShowList':
      if (!slots.list) return { handled: false };
      route = 'dashboard-show-list';
      result = await runWorkflow(DASHBOARD_SCRIPT, ['show-list', '--list', slots.list], 'dashboard-workflow');
      break;

    case 'CompleteListItem':
      if (!slots.list || !slots.item) return { handled: false };
      route = 'dashboard-complete-list-item';
      result = await runWorkflow(DASHBOARD_SCRIPT, ['complete-list-item', '--list', slots.list, '--item', slots.item], 'dashboard-workflow');
      break;

    // ─── Board schedule/unschedule/reschedule ───────────────────────
    case 'ScheduleItem': {
      const schedBoard = boardKey(slots.schedule_board);
      if (!schedBoard || !slots.query) return { handled: false };
      const schedParsed = parseCalendarWhen(slots.when, { timeZone: CALENDAR_TIMEZONE });
      if (!schedParsed) return { handled: false };
      route = 'dashboard-schedule';
      result = await runWorkflow(DASHBOARD_SCRIPT, [
        'schedule', '--board', schedBoard, '--query', slots.query,
        '--date', schedParsed.date, '--time', schedParsed.time,
        '--idempotency-key', stableIdempotencyKey(context, text, route),
      ], 'dashboard-workflow');
      break;
    }

    case 'RescheduleItem': {
      const reschedBoard = boardKey(slots.schedule_board);
      if (!reschedBoard || !slots.query) return { handled: false };
      const reschedParsed = parseCalendarWhen(slots.when, { timeZone: CALENDAR_TIMEZONE });
      if (!reschedParsed) return { handled: false };
      route = 'dashboard-reschedule';
      result = await runWorkflow(DASHBOARD_SCRIPT, [
        'reschedule', '--board', reschedBoard, '--query', slots.query,
        '--date', reschedParsed.date, '--time', reschedParsed.time,
        '--idempotency-key', stableIdempotencyKey(context, text, route),
      ], 'dashboard-workflow');
      break;
    }

    case 'UnscheduleItem': {
      const unschedBoard = boardKey(slots.schedule_board);
      if (!unschedBoard || !slots.query) return { handled: false };
      route = 'dashboard-unschedule';
      result = await runWorkflow(DASHBOARD_SCRIPT, [
        'unschedule', '--board', unschedBoard, '--query', slots.query,
        '--idempotency-key', stableIdempotencyKey(context, text, route),
      ], 'dashboard-workflow');
      break;
    }

    // ─── Calendar list / delete / reschedule ────────────────────────
    case 'ListCalendar': {
      const listParsed = parseCalendarWhen(slots.when, { timeZone: CALENDAR_TIMEZONE });
      const listDate = listParsed ? listParsed.date : relativeDate(0, new Date(), CALENDAR_TIMEZONE);
      route = 'calendar-list';
      result = await runWorkflow(CALENDAR_SCRIPT, ['list', '--date', listDate], 'calendar-workflow');
      break;
    }

    case 'DeleteCalendar': {
      if (!slots.title) return { handled: false };
      const delParsed = parseCalendarWhen(slots.when, { timeZone: CALENDAR_TIMEZONE });
      if (!delParsed) return { handled: false };
      route = 'calendar-delete';
      result = await runWorkflow(CALENDAR_SCRIPT, [
        'delete', '--title', slots.title, '--date', delParsed.date,
      ], 'calendar-workflow');
      break;
    }

    case 'RescheduleCalendar': {
      if (!slots.title) return { handled: false };
      const oldParsed = parseCalendarWhen(slots.when, { timeZone: CALENDAR_TIMEZONE });
      if (!oldParsed) return { handled: false };
      const newParsed = parseCalendarWhen([slots.new_when, slots.new_time].filter(Boolean).join(' '), { timeZone: CALENDAR_TIMEZONE });
      if (!newParsed) return { handled: false };
      route = 'calendar-reschedule';
      result = await runWorkflow(CALENDAR_SCRIPT, [
        'reschedule', '--title', slots.title, '--date', oldParsed.date,
        '--new-date', newParsed.date, '--new-time', newParsed.time,
      ], 'calendar-workflow');
      break;
    }

    // ─── Finance ────────────────────────────────────────────────────
    case 'AddExpense': {
      if (!slots.name || !slots.amount || !slots.due_day) return { handled: false };
      const amountMatch = String(slots.amount).match(/(\d+(?:\.\d+)?)/);
      if (!amountMatch) return { handled: false };
      const dueDayMatch = String(slots.due_day).match(/(\d+)/);
      if (!dueDayMatch) return { handled: false };
      const amount = Number(amountMatch[1]);
      const dueDay = Number(dueDayMatch[1]);
      if (dueDay < 1 || dueDay > 31) return { handled: false };
      route = 'finance-add-expense';
      const expenseArgs = ['add-expense', '--name', slots.name, '--amount', String(amount), '--due-day', String(dueDay)];
      if (slots.notes) expenseArgs.push('--notes', slots.notes);
      result = await runWorkflow(FINANCE_SCRIPT, expenseArgs, 'finance-workflow');
      break;
    }

    // ─── Health tracker ─────────────────────────────────────────────
    case 'ListToday': {
      const todayParsed = parseCalendarWhen(slots.when, { timeZone: CALENDAR_TIMEZONE });
      route = 'health-list-today';
      const todayArgs = ['list-today'];
      if (todayParsed && todayParsed.date) todayArgs.push('--date', todayParsed.date);
      result = await runWorkflow(HEALTH_SCRIPT, todayArgs, 'health-workflow');
      break;
    }

    case 'ActivityToday': {
      const activityParsed = parseCalendarWhen(slots.when, { timeZone: CALENDAR_TIMEZONE });
      route = 'health-activity-today';
      const activityArgs = ['activity-today'];
      if (activityParsed && activityParsed.date) activityArgs.push('--date', activityParsed.date);
      result = await runWorkflow(HEALTH_SCRIPT, activityArgs, 'health-workflow');
      break;
    }

    case 'CorrectFood': {
      route = 'health-correct-food';
      const correctArgs = ['correct-food', '--idempotency-key', stableIdempotencyKey(context, text, route)];
      if (slots.when) {
        const cfParsed = parseCalendarWhen(slots.when, { timeZone: CALENDAR_TIMEZONE });
        if (cfParsed && cfParsed.date) correctArgs.push('--date', cfParsed.date);
      }
      result = await runWorkflow(HEALTH_SCRIPT, correctArgs, 'health-workflow');
      break;
    }

    case 'RemoveFood': {
      route = 'health-remove-food';
      const removeArgs = ['remove-food', '--idempotency-key', stableIdempotencyKey(context, text, route)];
      if (slots.when) {
        const rfParsed = parseCalendarWhen(slots.when, { timeZone: CALENDAR_TIMEZONE });
        if (rfParsed && rfParsed.date) removeArgs.push('--date', rfParsed.date);
      }
      result = await runWorkflow(HEALTH_SCRIPT, removeArgs, 'health-workflow');
      break;
    }

    case 'UndoFood': {
      route = 'health-undo';
      const undoArgs = ['undo', '--idempotency-key', stableIdempotencyKey(context, text, route)];
      if (slots.when) {
        const ufParsed = parseCalendarWhen(slots.when, { timeZone: CALENDAR_TIMEZONE });
        if (ufParsed && ufParsed.date) undoArgs.push('--date', ufParsed.date);
      }
      result = await runWorkflow(HEALTH_SCRIPT, undoArgs, 'health-workflow');
      break;
    }

    // ─── Meal planner ───────────────────────────────────────────────
    case 'GetPlan': {
      const planParsed = parseCalendarWhen(slots.date, { timeZone: CALENDAR_TIMEZONE });
      route = 'meal-planner-get-plan';
      const planArgs = ['get-plan'];
      if (planParsed && planParsed.date) planArgs.push('--date', planParsed.date);
      result = await runWorkflow(MEAL_PLANNER_SCRIPT, planArgs, 'meal-planner-workflow');
      break;
    }

    case 'ListRecipes': {
      route = 'meal-planner-list-recipes';
      const recipesArgs = ['list-recipes'];
      if (slots.type) recipesArgs.push('--type', slots.type);
      if (slots.tag) recipesArgs.push('--tag', slots.tag);
      result = await runWorkflow(MEAL_PLANNER_SCRIPT, recipesArgs, 'meal-planner-workflow');
      break;
    }

    case 'FindRecipe': {
      if (!slots.query) return { handled: false };
      route = 'meal-planner-find-recipe';
      result = await runWorkflow(MEAL_PLANNER_SCRIPT, ['find-recipe', '--query', slots.query], 'meal-planner-workflow');
      break;
    }

    case 'ConfirmPlan': {
      const confirmParsed = parseCalendarWhen(slots.date, { timeZone: CALENDAR_TIMEZONE });
      route = 'meal-planner-confirm-plan';
      const confirmArgs = ['confirm-plan'];
      if (confirmParsed && confirmParsed.date) confirmArgs.push('--date', confirmParsed.date);
      result = await runWorkflow(MEAL_PLANNER_SCRIPT, confirmArgs, 'meal-planner-workflow');
      break;
    }

    case 'AssemblePlan': {
      const assembleParsed = parseCalendarWhen(slots.date, { timeZone: CALENDAR_TIMEZONE });
      route = 'meal-planner-assemble-plan';
      const assembleArgs = ['assemble-plan'];
      if (assembleParsed && assembleParsed.date) assembleArgs.push('--date', assembleParsed.date);
      result = await runWorkflow(MEAL_PLANNER_SCRIPT, assembleArgs, 'meal-planner-workflow');
      break;
    }

    case 'AddPlanItem': {
      if (!slots.recipe_name || !slots.slot) return { handled: false };
      const mealSlot = String(slots.slot).toLowerCase();
      if (!['breakfast', 'lunch', 'dinner', 'snack'].includes(mealSlot)) return { handled: false };
      const itemParsed = parseCalendarWhen(slots.date, { timeZone: CALENDAR_TIMEZONE });
      route = 'meal-planner-add-plan-item';
      const itemArgs = ['add-plan-item', '--slot', mealSlot, '--recipe-name', slots.recipe_name];
      if (itemParsed && itemParsed.date) itemArgs.push('--date', itemParsed.date);
      result = await runWorkflow(MEAL_PLANNER_SCRIPT, itemArgs, 'meal-planner-workflow');
      break;
    }

    case 'GetBalance':
    case 'GetBudgetForecast':
    case 'EditListItem':
    case 'RemoveListItem':
    case 'RenameList':
    case 'DeleteList':
      // These intents have been removed from the router — they were
      // low-frequency operations better handled by the model-based agent.
      return { handled: false };

    default:
      // Intent was recognized by the grammar but has no wired case in the
      // router — likely a Phase-4 tool that was deliberately deferred or
      // an ask-Aaron-first item. Fall through to the model-based agent.
      return { handled: false };
  }

  const reply = result.reply || (result.error && (result.error.message || result.error.code)) ||
    (result.ok ? 'Done.' : 'Sorry, that command was routed correctly but the action failed.');
  return { handled: true, route, ok: Boolean(result.ok), reply };
}

module.exports = {
  routeRoutineRequest,
  matchIntent,
  boardKey,
  parseCalendarWhen,
};
