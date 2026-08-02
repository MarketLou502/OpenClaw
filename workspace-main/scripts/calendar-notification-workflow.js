#!/usr/bin/env node
'use strict';

// Deterministic proactive calendar notifications for Aaron. launchd supplies
// timing; this workflow reads Google Calendar, plans due notifications, and
// delivers through OpenClaw's native iMessage action. It never invokes an LLM,
// raw `imsg`, or the legacy inbound handler.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { listEvents } = require('../../workspace-daily-tracker/scripts/lib/google-calendar');
const { sendNativeIMessage } = require('./lib/native-imessage');

const WORKSPACE = path.join(__dirname, '..');
const CONFIG_FILE = process.env.OPENCLAW_CALENDAR_NOTIFICATION_CONFIG ||
  path.join(WORKSPACE, 'config', 'calendar-notifications.json');
const STATE_FILE = process.env.OPENCLAW_CALENDAR_NOTIFICATION_STATE ||
  path.join(WORKSPACE, 'memory', 'calendar-notification-state.json');
const LEGACY_STATE_FILE = process.env.OPENCLAW_CALENDAR_NOTIFICATION_LEGACY_STATE ||
  '/Users/aaronmacmini/.openclaw/workspace-daily-tracker/memory/state.json';
const LOG_DIR = process.env.OPENCLAW_CALENDAR_NOTIFICATION_LOG_DIR ||
  path.join(WORKSPACE, 'memory', 'calendar-notifications');

class WorkflowError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw new WorkflowError('JSON_READ_FAILED', `Could not read ${file}: ${error.message}`);
  }
}

function loadConfig() {
  const config = readJson(CONFIG_FILE);
  if (!config || typeof config !== 'object') throw new WorkflowError('CONFIG_INVALID', 'Calendar notification config is missing');
  if (!config.calendar || !config.timezone) throw new WorkflowError('CONFIG_INVALID', 'Calendar and timezone are required');
  const minimum = Number(config.reminderWindowMinutes?.minimum);
  const maximum = Number(config.reminderWindowMinutes?.maximum);
  if (!Number.isInteger(minimum) || !Number.isInteger(maximum) || minimum < 0 || maximum < minimum) {
    throw new WorkflowError('CONFIG_INVALID', 'Reminder window is invalid');
  }
  if (!Number.isInteger(config.morningHour) || config.morningHour < 0 || config.morningHour > 23) {
    throw new WorkflowError('CONFIG_INVALID', 'Morning hour is invalid');
  }
  return {
    ...config,
    noReminderTitles: Array.isArray(config.noReminderTitles) ? config.noReminderTitles : [],
  };
}

function injectedNow() {
  const value = process.env.OPENCLAW_CALENDAR_NOTIFICATION_NOW;
  if (!value) return new Date();
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new WorkflowError('INVALID_NOW', 'Injected current time is invalid');
  return parsed;
}

function zonedParts(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    hour: Number(values.hour),
    minute: Number(values.minute),
  };
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${crypto.randomBytes(5).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temp, file);
    fs.chmodSync(file, 0o600);
  } finally {
    try { fs.unlinkSync(temp); } catch {}
  }
}

function initialState(date) {
  const legacy = readJson(LEGACY_STATE_FILE, null);
  if (legacy?.date === date) {
    return {
      version: 1,
      date,
      morningSent: legacy.morningSent === true,
      notified: Array.isArray(legacy.notified) ? legacy.notified : [],
      sending: {},
      importedLegacyState: true,
    };
  }
  return { version: 1, date, morningSent: false, notified: [], sending: {} };
}

function loadState(date) {
  const state = readJson(STATE_FILE, null);
  if (!state || state.version !== 1 || state.date !== date) return initialState(date);
  state.notified = Array.isArray(state.notified) ? state.notified : [];
  state.sending = state.sending && typeof state.sending === 'object' ? state.sending : {};
  return state;
}

function appendLog(date, line) {
  fs.mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
  fs.appendFileSync(path.join(LOG_DIR, `${date}.log`), `${new Date().toISOString()} ${line}\n`, 'utf8');
}

function normalizedTitle(title) {
  return String(title || '').trim().toLocaleLowerCase('en-US');
}

function timeToMinutes(time) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(time || ''));
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function formatTime(time) {
  const minutes = timeToMinutes(time);
  if (minutes === null) return time;
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  return `${hour % 12 || 12}:${String(minute).padStart(2, '0')} ${hour >= 12 ? 'PM' : 'AM'}`;
}

function eventKey(event) {
  return event.eventId ? `event:${event.eventId}` : `legacy:${event.startTime}|${event.title}`;
}

function legacyEventKey(event) {
  return `${event.startTime}|${event.title}`;
}

function suppressReminder(event, config) {
  if (event.noReminder === true) return true;
  const excluded = new Set(config.noReminderTitles.map(normalizedTitle));
  return excluded.has(normalizedTitle(event.title));
}

function formatMorning(events) {
  const lines = events.map((event) => event.allDay
    ? `• All day — ${event.title}`
    : `• ${formatTime(event.startTime)} — ${event.title}`);
  return `🌅 Today:\n${lines.join('\n')}`;
}

function buildPlan(events, state, now, config) {
  const currentMinutes = now.hour * 60 + now.minute;
  const notifications = [];
  if (!state.morningSent && now.hour >= config.morningHour && events.length > 0) {
    notifications.push({ key: 'morning', type: 'morning', message: formatMorning(events) });
  }
  for (const event of events) {
    if (event.allDay || suppressReminder(event, config)) continue;
    const startMinutes = timeToMinutes(event.startTime);
    if (startMinutes === null) continue;
    const difference = startMinutes - currentMinutes;
    if (difference < config.reminderWindowMinutes.minimum || difference > config.reminderWindowMinutes.maximum) continue;
    const key = eventKey(event);
    if (state.notified.includes(key) || state.notified.includes(legacyEventKey(event))) continue;
    const approximate = Math.round(difference / 5) * 5;
    notifications.push({
      key,
      type: 'event',
      eventId: event.eventId,
      title: event.title,
      message: `⏰ ${event.title} starts in ~${approximate} min (${formatTime(event.startTime)})`,
    });
  }
  return notifications;
}

function deliver(message) {
  return sendNativeIMessage(message);
}

async function loadEvents(config, date) {
  if (process.env.OPENCLAW_CALENDAR_NOTIFICATION_EVENTS_FILE) {
    const events = readJson(process.env.OPENCLAW_CALENDAR_NOTIFICATION_EVENTS_FILE);
    if (!Array.isArray(events)) throw new WorkflowError('EVENTS_INVALID', 'Injected events must be an array');
    return events;
  }
  return listEvents(config.calendar, date);
}

async function run({ planOnly = false } = {}) {
  const config = loadConfig();
  const nowDate = injectedNow();
  const now = zonedParts(nowDate, config.timezone);
  const events = (await loadEvents(config, now.date)).sort((left, right) => {
    if (left.allDay !== right.allDay) return left.allDay ? -1 : 1;
    return (timeToMinutes(left.startTime) ?? 0) - (timeToMinutes(right.startTime) ?? 0);
  });
  const state = loadState(now.date);
  const plan = buildPlan(events, state, now, config);
  if (planOnly) return { ok: true, action: 'plan', date: now.date, events: events.length, notifications: plan };

  const results = [];
  for (const notification of plan) {
    // Persist an uncertain in-flight marker before delivery. A process crash
    // will not automatically duplicate a message whose provider result is
    // unknown. Explicit command failures clear the marker so a later run can
    // retry if the notification is still due.
    if (state.sending[notification.key]) {
      results.push({ key: notification.key, ok: false, skipped: 'prior_delivery_status_unknown' });
      continue;
    }
    state.sending[notification.key] = { startedAt: nowDate.toISOString(), message: notification.message };
    atomicWriteJson(STATE_FILE, state);
    const delivery = deliver(notification.message);
    if (!delivery.ok) {
      delete state.sending[notification.key];
      atomicWriteJson(STATE_FILE, state);
      appendLog(now.date, `Delivery failed (${notification.key}): ${delivery.error}`);
      results.push({ key: notification.key, ok: false, error: delivery.error });
      continue;
    }
    delete state.sending[notification.key];
    if (notification.type === 'morning') state.morningSent = true;
    else state.notified.push(notification.key);
    atomicWriteJson(STATE_FILE, state);
    appendLog(now.date, `Sent ${notification.key}: ${notification.message.replace(/\n/g, ' | ')}`);
    results.push({ key: notification.key, ok: true });
  }

  // Persist imported/reset state even on a quiet run.
  if (!fs.existsSync(STATE_FILE)) atomicWriteJson(STATE_FILE, state);
  return {
    ok: results.every((result) => result.ok !== false),
    action: 'run',
    date: now.date,
    events: events.length,
    planned: plan.length,
    sent: results.filter((result) => result.ok).length,
    results,
  };
}

async function main() {
  try {
    const command = process.argv[2] || 'run';
    if (!['run', 'plan'].includes(command)) throw new WorkflowError('INVALID_COMMAND', `Unknown command '${command}'`);
    const result = await run({ planOnly: command === 'plan' });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      error: {
        code: error instanceof WorkflowError ? error.code : 'INTERNAL_ERROR',
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    })}\n`);
    process.exitCode = 1;
  }
}

main();
