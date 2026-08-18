#!/usr/bin/env node
'use strict';

// Deterministic proactive notifications for Aaron. launchd supplies timing;
// this workflow reads Google Calendar, plans due notifications, and delivers
// through OpenClaw's native iMessage action. It never invokes an LLM, raw
// `imsg`, or the legacy inbound handler for calendar reminders or cues.
//
// It also drains Task Tracker's message-cues.json queue (the daily habits'
// "coming up" texts, seeded reactively by reassess.js — see below) in the
// same :00/:30 run — one job, same in-flight/atomic-write idiom, covering
// calendar reminders, habit cues, and due-date pacing check-ins.
//
// Third stage: reassess.js (workspace-daily-tracker) computes due-date
// pacing for estimated/due-dated tasks and seeds today's habit cues (no
// standing cron of its own — this heartbeat is its only "did a day pass"
// signal). When it reports a check-in is warranted, this workflow is the
// ONE place that calls out to an LLM (task-tracker, via a non-delivering
// `openclaw agent` turn) — narrowly, to compose the message text — and
// still does the actual send itself. Task-tracker never calls
// sendNativeIMessage; this script always does.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { listEvents } = require('../../workspace-daily-tracker/scripts/lib/google-calendar');
const { sendNativeIMessage } = require('./lib/native-imessage');
const { requestAgentReply } = require('./lib/agent-turn');
const { reassess, commitReassessState } = require('../../workspace-daily-tracker/scripts/reassess');

const WORKSPACE = path.join(__dirname, '..');
const CONFIG_FILE = process.env.OPENCLAW_CALENDAR_NOTIFICATION_CONFIG ||
  path.join(WORKSPACE, 'config', 'calendar-notifications.json');
const STATE_FILE = process.env.OPENCLAW_CALENDAR_NOTIFICATION_STATE ||
  path.join(WORKSPACE, 'memory', 'calendar-notification-state.json');
const LEGACY_STATE_FILE = process.env.OPENCLAW_CALENDAR_NOTIFICATION_LEGACY_STATE ||
  '/Users/aaronmacmini/.openclaw/workspace-daily-tracker/memory/state.json';
const LOG_DIR = process.env.OPENCLAW_CALENDAR_NOTIFICATION_LOG_DIR ||
  path.join(WORKSPACE, 'memory', 'calendar-notifications');
const CUES_FILE = process.env.OPENCLAW_MESSAGE_CUES_FILE ||
  '/Users/aaronmacmini/.openclaw/workspace-daily-tracker/memory/message-cues.json';
const PENDING_CHECKINS_FILE = process.env.OPENCLAW_PENDING_CHECKINS_FILE ||
  '/Users/aaronmacmini/.openclaw/workspace-daily-tracker/memory/pending-checkins.json';
const CUE_LOOKAHEAD_MINUTES = 10;
const CHECKIN_EXPIRY_HOURS = 24;

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

// Cues due within the lookahead window or already past due, still pending
// or retryable. `sent`/`dropped` cues are never re-delivered.
function buildCuePlan(cuesDoc, nowDate) {
  if (!cuesDoc || !Array.isArray(cuesDoc.cues)) return [];
  const horizon = new Date(nowDate.getTime() + CUE_LOOKAHEAD_MINUTES * 60000);
  return cuesDoc.cues
    .filter((cue) => (cue.status === 'pending' || cue.status === 'retry') && new Date(cue.deliverAt) <= horizon)
    .map((cue) => ({ key: `cue:${cue.key}`, type: 'cue', cueKey: cue.key, message: cue.text }));
}

// Re-reads CUES_FILE (rather than reusing the in-memory copy from the start
// of the run) so a status update doesn't clobber changes task-tracker-planner
// made mid-run, then flips exactly one cue's status atomically.
function markCueSent(cueKey) {
  const doc = readJson(CUES_FILE, null);
  if (!doc || !Array.isArray(doc.cues)) return;
  const cue = doc.cues.find((item) => item.key === cueKey);
  if (!cue) return;
  cue.status = 'sent';
  atomicWriteJson(CUES_FILE, doc);
}

// ── Due-date pacing check-ins (Phase 4/5) ──

function checkinCorrelationId() {
  return `ck_${crypto.randomBytes(5).toString('hex')}`;
}

// Aged-out-not-deleted, same idiom as sweepToHistory elsewhere — an
// awaiting-reply entry older than CHECKIN_EXPIRY_HOURS is marked expired
// (not removed) so a late reply still fails to match cleanly instead of
// matching a stale, long-forgotten check-in. Also supersedes any still-open
// entry for the SAME task (e.g. a follow-up after silence) so the reply
// matcher only ever sees one live awaiting-reply entry per task — otherwise
// a single reply could look "ambiguous" against two entries about the same
// thing.
function recordPendingCheckin({ id, taskId, board, text, sentAt }) {
  const doc = readJson(PENDING_CHECKINS_FILE, { checkins: [] });
  const checkins = Array.isArray(doc.checkins) ? doc.checkins : [];
  const cutoff = new Date(sentAt).getTime() - CHECKIN_EXPIRY_HOURS * 3600_000;
  for (const entry of checkins) {
    if (entry.status !== 'awaiting-reply') continue;
    if (entry.taskId === taskId) entry.status = 'superseded';
    else if (new Date(entry.sentAt).getTime() < cutoff) entry.status = 'expired';
  }
  checkins.push({ id, taskId, board, sentAt, status: 'awaiting-reply', text });
  atomicWriteJson(PENDING_CHECKINS_FILE, { checkins });
}

// Aaron's explicit framing (2026-08-17): this is a conversation with someone
// rooting for his success, not a nag list — one task at a time, and if he
// says he didn't get to it, that's fine, accept it and move on rather than
// pushing. The model sees which of three situations this is (fresh, daily
// recheck, or a follow-up after he went quiet) and should read accordingly.
function checkinFacts(item) {
  const toneByReason = {
    status_transition: `This is the first check-in about this task since its pacing changed — introduce it naturally, don't assume he's heard about it before.`,
    daily_recheck: `He's heard about this task before (it's still behind/at-risk today) — keep it brief, don't repeat the full pitch, just a light nudge.`,
    followup_no_reply: `He didn't reply to the last check-in about this — this is a single gentle follow-up, not a second nag. If he still doesn't respond, that's fine too; don't pile on.`,
  };
  return [
    `Due-date pacing check for a task Aaron is tracking. He has other tasks too, but you're only bringing up ONE at a time — don't list the others.`,
    `Task: "${item.text}" (board: ${item.board})`,
    `Due: ${item.dueDate} (${item.daysRemaining} day${item.daysRemaining === 1 ? '' : 's'} left)`,
    `Estimate: ${item.estimatedBlocks}x30min total, ${item.totalLogged}x30min logged so far, ${item.blocksRemaining}x30min remaining`,
    `Needed pace to finish on time: ~${item.targetBlocksPerDay}x30min/day`,
    `Status: ${item.status} (reason: ${item.reason})`,
    toneByReason[item.reason] || '',
    ``,
    `Compose one short, warm text to send Aaron checking in on this — like a person who's rooting for him, not a status report or a guilt trip. He's human and won't get everything done on schedule every time; if that happens, the follow-up (if any) should be understanding, not pushier. Mention the concrete numbers naturally. Ask something he can reply to (e.g. whether he can grab time today, or just how it's going). Keep it to 1-3 sentences. Reply with ONLY the message text, nothing else.`,
  ].join('\n');
}

function checkinFallbackText(item) {
  return `⏳ '${item.text}' is due ${item.dueDate} — ${item.blocksRemaining}x30min left with ${item.daysRemaining} day${item.daysRemaining === 1 ? '' : 's'} to go (about ${item.targetBlocksPerDay}x30min/day to stay on pace). Got time for it today?`;
}

async function runCheckins(nowDate, { dryRun = false } = {}) {
  const result = await reassess({ now: nowDate })
    .catch((error) => ({ ok: false, error: error.message, checkins: [], nextState: null, priorState: null }));

  if (!result.checkins || !result.checkins.length) {
    // Still commit — decideCheckins may have recorded pure status
    // transitions (e.g. into on-track) with no send involved.
    if (!dryRun && result.nextState) commitReassessState(result.nextState);
    return { attempted: 0, sent: 0, dryRun: [] };
  }

  const outcomes = [];
  const finalTasks = { ...(result.nextState || {}) };
  for (const item of result.checkins) {
    const composed = requestAgentReply('task-tracker', checkinFacts(item), { timeoutSeconds: 30 });
    const text = composed.ok && composed.text.trim() ? composed.text.trim() : checkinFallbackText(item);
    if (!composed.ok) appendLog(nowDate.toISOString().slice(0, 10), `Check-in compose fallback for task ${item.taskId}: ${composed.error}`);

    if (dryRun) {
      outcomes.push({ taskId: item.taskId, text, composed: composed.ok });
      continue;
    }
    const delivery = deliver(text);
    const sentAt = new Date().toISOString();
    if (delivery.ok) {
      recordPendingCheckin({ id: checkinCorrelationId(), taskId: item.taskId, board: item.board, text, sentAt });
      appendLog(sentAt.slice(0, 10), `Sent check-in for task ${item.taskId} (${item.status}): ${text.replace(/\n/g, ' | ')}`);
    } else {
      appendLog(sentAt.slice(0, 10), `Check-in delivery failed for task ${item.taskId}: ${delivery.error}`);
      // Delivery genuinely failed — don't mark this task "notified", so the
      // next heartbeat tick treats it as still-pending and retries.
      if (result.priorState && result.priorState[item.taskId]) finalTasks[item.taskId] = result.priorState[item.taskId];
      else delete finalTasks[item.taskId];
    }
    outcomes.push({ taskId: item.taskId, ok: delivery.ok, error: delivery.error });
  }
  if (!dryRun) commitReassessState(finalTasks);
  return { attempted: result.checkins.length, sent: outcomes.filter((o) => o.ok).length, dryRun: dryRun ? outcomes : [] };
}

async function loadEvents(config, date) {
  if (process.env.OPENCLAW_CALENDAR_NOTIFICATION_EVENTS_FILE) {
    const events = readJson(process.env.OPENCLAW_CALENDAR_NOTIFICATION_EVENTS_FILE);
    if (!Array.isArray(events)) throw new WorkflowError('EVENTS_INVALID', 'Injected events must be an array');
    return events;
  }
  return listEvents(config.calendar, date);
}

async function run({ planOnly = false, checkinsDryRun = false } = {}) {
  const config = loadConfig();
  const nowDate = injectedNow();
  const now = zonedParts(nowDate, config.timezone);

  // Third stage: reassess.js seeds today's habit cues (if not already done)
  // and reports any due-date pacing check-ins warranted this run — must
  // happen before the cue-drain plan below reads CUES_FILE, since a fresh
  // day's cues may not exist yet until this runs.
  const checkinRun = planOnly ? { attempted: 0, sent: 0, dryRun: [] } : await runCheckins(nowDate, { dryRun: checkinsDryRun });

  const events = (await loadEvents(config, now.date)).sort((left, right) => {
    if (left.allDay !== right.allDay) return left.allDay ? -1 : 1;
    return (timeToMinutes(left.startTime) ?? 0) - (timeToMinutes(right.startTime) ?? 0);
  });
  const state = loadState(now.date);
  const cuesDoc = readJson(CUES_FILE, null);
  const cuePlan = cuesDoc && cuesDoc.date === now.date ? buildCuePlan(cuesDoc, nowDate) : [];
  const plan = [...buildPlan(events, state, now, config), ...cuePlan];
  if (planOnly) return { ok: true, action: 'plan', date: now.date, events: events.length, notifications: plan };
  if (checkinsDryRun) return { ok: true, action: 'checkins-dry-run', date: now.date, checkins: checkinRun.dryRun };

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
    else if (notification.type === 'cue') markCueSent(notification.cueKey);
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
    checkins: checkinRun,
  };
}

async function main() {
  try {
    const command = process.argv[2] || 'run';
    if (!['run', 'plan', 'checkins-dry-run'].includes(command)) throw new WorkflowError('INVALID_COMMAND', `Unknown command '${command}'`);
    const result = await run({ planOnly: command === 'plan', checkinsDryRun: command === 'checkins-dry-run' });
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
