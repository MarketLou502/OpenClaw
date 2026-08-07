'use strict';

const crypto = require('crypto');
const path = require('path');
const { spawn } = require('child_process');

const NODE_BIN = process.env.OPENCLAW_NODE_BIN || '/opt/homebrew/opt/node@22/bin/node';
const DASHBOARD_SCRIPT = process.env.DASHBOARD_WORKFLOW_SCRIPT ||
  '/Users/aaronmacmini/.openclaw/workspace-main/scripts/dashboard-workflow.js';
const CALENDAR_SCRIPT = process.env.CALENDAR_WORKFLOW_SCRIPT ||
  '/Users/aaronmacmini/.openclaw/workspace-main/scripts/calendar-workflow.js';
const FINANCE_SCRIPT = process.env.FINANCE_WORKFLOW_SCRIPT ||
  '/Users/aaronmacmini/.openclaw/workspace-finance-agent/scripts/finance-workflow.js';
const HEALTH_SCRIPT = process.env.HEALTH_WORKFLOW_SCRIPT ||
  '/Users/aaronmacmini/.openclaw/workspace-health-tracker/scripts/health-workflow.js';
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

// Deterministic yes/no confirmation, no model involved: a handful of
// destructive/ambiguous routes (currently just DeleteList) ask before
// acting instead of acting immediately. State is in-memory per process —
// ha-voice-adapter and the iMessage plugin each hold their own, which is
// correct since a voice confirmation shouldn't resolve an iMessage one and
// vice versa. A process restart silently drops any pending confirmation,
// which is the right failure mode: a stray "yes" after a restart should
// fall through to normal routing, not execute something stale.
const PENDING_CONFIRMATION_TTL_MS = 30000;
const pendingConfirmations = new Map();
const AFFIRMATIVE_RE = /^(?:yes|yeah|yep|yup|sure|confirm(?:ed)?|correct|do it|go ahead|please do|affirmative)[.!]?$/i;
const NEGATIVE_RE = /^(?:no|nope|nah|never ?mind|cancel|stop|don'?t)[.!]?$/i;

// A trailing "never mind" cancels the whole turn, no matter what preceded it
// or whether a confirmation was pending — this is a global escape hatch, not
// scoped to the confirm flow above. It's checked first in
// routeRoutineRequest, before matchIntent spawns the recognizer subprocess,
// so saying it is always the fast path out of a call, never the slow one.
const NEVERMIND_RE = /\bnever\s*mind[.,!?]*$/i;

function pendingKey(context) {
  return `${context.channel || 'unknown'}:${context.conversationId || 'unknown'}`;
}

function setPendingConfirmation(context, pending) {
  pendingConfirmations.set(pendingKey(context), { ...pending, expiresAt: Date.now() + PENDING_CONFIRMATION_TTL_MS });
}

// Always removes whatever's pending (confirmed, declined, expired, or
// superseded by an unrelated utterance) — a pending confirmation is only
// ever good for one reply, never left around for a later message to trip.
function takePendingConfirmation(context) {
  const key = pendingKey(context);
  const pending = pendingConfirmations.get(key);
  if (!pending) return null;
  pendingConfirmations.delete(key);
  return pending.expiresAt >= Date.now() ? pending : null;
}

async function routeRoutineRequest(context) {
  const text = String(context.text || '').trim();
  if (!text) return { handled: false };

  if (NEVERMIND_RE.test(text)) {
    // Drop any pending confirmation too, so a stray later "yes" can't
    // resolve an action the caller just cancelled.
    const cancelledPending = takePendingConfirmation(context);
    return {
      handled: true,
      route: cancelledPending ? `${cancelledPending.route}-cancelled` : 'nevermind-cancel',
      ok: true,
      reply: 'OK, never mind.',
    };
  }

  const pending = takePendingConfirmation(context);
  if (pending && AFFIRMATIVE_RE.test(text)) {
    const result = await runWorkflow(pending.script, pending.args, pending.label);
    const reply = result.reply || (result.ok ? 'Done.' : 'Sorry, that action failed.');
    return { handled: true, route: pending.route, ok: Boolean(result.ok), reply };
  }
  if (pending && NEGATIVE_RE.test(text)) {
    return { handled: true, route: `${pending.route}-cancelled`, ok: true, reply: 'OK, never mind.' };
  }
  // Anything else (including an unrelated new command) falls through to
  // normal routing below — the pending confirmation is already gone from
  // the map via takePendingConfirmation, so it can't be double-resolved.

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

    case 'EditListItem':
      // Item-text editing has no board equivalent, so this stays
      // custom-lists-only — guard against a board name reaching it.
      if (boardKey(slots.list) || !slots.list || !slots.item || !slots.text) return { handled: false };
      route = 'dashboard-edit-list-item';
      result = await runWorkflow(DASHBOARD_SCRIPT, ['edit-list-item', '--list', slots.list, '--item', slots.item, '--text', slots.text], 'dashboard-workflow');
      break;

    case 'RemoveListItem':
      if (!slots.list || !slots.item) return { handled: false };
      route = 'dashboard-remove-list-item';
      result = await runWorkflow(DASHBOARD_SCRIPT, ['remove-list-item', '--list', slots.list, '--item', slots.item], 'dashboard-workflow');
      break;

    case 'RenameList':
      if (boardKey(slots.list) || !slots.name) return { handled: false };
      route = 'dashboard-rename-list';
      result = await runWorkflow(DASHBOARD_SCRIPT, ['rename-list', '--list', slots.list, '--name', slots.name], 'dashboard-workflow');
      break;

    case 'DeleteList': {
      if (boardKey(slots.list) || !slots.list) return { handled: false };
      route = 'dashboard-delete-list';
      setPendingConfirmation(context, {
        route,
        script: DASHBOARD_SCRIPT,
        args: ['delete-list', '--list', slots.list],
        label: 'dashboard-workflow',
      });
      return {
        handled: true,
        route: `${route}-confirm`,
        ok: true,
        expectsReply: true,
        reply: `Delete your ${slots.list} list? Say yes to confirm.`,
      };
    }

    case 'GetBalance':
      route = 'finance-balance';
      result = await runWorkflow(FINANCE_SCRIPT, ['balance'], 'finance-workflow');
      break;

    case 'GetBudgetForecast':
      route = 'finance-budget-forecast';
      result = await runWorkflow(FINANCE_SCRIPT, ['budget-forecast'], 'finance-workflow');
      break;

    default:
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
  setPendingConfirmation,
  takePendingConfirmation,
  AFFIRMATIVE_RE,
  NEGATIVE_RE,
  NEVERMIND_RE,
};
