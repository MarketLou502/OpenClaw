#!/usr/bin/env node
'use strict';

// Reactive replacement for the retired task-tracker-planner.js (7:30 AM
// cron, see archives/task-tracker-planner-2026-08-17/README.md). No cron of
// its own — called from workspace-main's already-loaded :00/:30 heartbeat
// job (calendar-notification-workflow.js), which is the only source of
// "did a day silently pass" awareness a reactive system can honestly have.
// Two responsibilities per run, both deterministic, no LLM:
//   1. Seed today's habit heads-up cues once per day (same slot-finder
//      logic the old planner used, unchanged in spirit).
//   2. Decide whether any due-dated, estimated task's pacing state
//      warrants a check-in today, gated so the same status never re-fires
//      a message every 30 minutes — only a transition or a once-per-day
//      cap does. Returns a signal; does not compose or send text itself.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { listEvents } = require('./lib/google-calendar');
const { buildSchedule } = require('./lib/slot-finder');
const { computeAllPacing, todayInNewYork } = require('./pacing');

const WORKSPACE = path.join(__dirname, '..');
const CONFIG_FILE = process.env.OPENCLAW_DAILY_GOAL_CONFIG || path.join(WORKSPACE, 'config', 'daily-goal-scheduler.json');
const HABITS_FILE = process.env.OPENCLAW_DAILY_GOAL_HABITS || path.join(WORKSPACE, 'tasks', 'daily-habits.json');
const HISTORY_FILE = process.env.OPENCLAW_DAILY_GOAL_HISTORY || path.join(WORKSPACE, 'tasks', 'goals-history.json');
const CUES_FILE = process.env.OPENCLAW_MESSAGE_CUES_FILE || path.join(WORKSPACE, 'memory', 'message-cues.json');
const REASSESS_STATE_FILE = process.env.OPENCLAW_REASSESS_STATE_FILE || path.join(WORKSPACE, 'memory', 'reassess-state.json');
const PENDING_CHECKINS_FILE = process.env.OPENCLAW_PENDING_CHECKINS_FILE || path.join(WORKSPACE, 'memory', 'pending-checkins.json');

// A task only re-triggers a check-in if its status *transitioned*, or if
// the last notification for it was on an earlier calendar day than today
// (once-per-day cap) — same "never re-send" idiom message-cues.json uses.
const DAILY_RECHECK_STATUSES = new Set(['behind', 'at-risk']);

// Aaron's explicit ask (2026-08-17): one conversation at a time, and if he
// goes quiet, a single gentle follow-up on the SAME task rather than piling
// on with a new one. No reply within this window -> follow up once.
const FOLLOWUP_AFTER_MS = 2 * 60 * 60 * 1000;

function readJson(file, fallback) {
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

function minutesOf(time) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(time));
  return Number(match[1]) * 60 + Number(match[2]);
}

function hhmm(value) {
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
}

function localDate(now, timezone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return { date: `${value.year}-${value.month}-${value.day}`, minute: Number(value.hour) * 60 + Number(value.minute) };
}

function tzOffset(dateStr, timeStr, timezone) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = timeStr.split(':').map(Number);
  const utcGuess = new Date(Date.UTC(y, m - 1, d, hh, mm, 0));
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(utcGuess);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const asIfUtc = Date.UTC(Number(value.year), Number(value.month) - 1, Number(value.day), Number(value.hour), Number(value.minute));
  const offsetMinutes = (asIfUtc - utcGuess.getTime()) / 60000;
  // offsetMinutes is already the correct signed ISO offset (e.g. -240 for
  // EDT) — sign must follow it directly. A pre-existing bug here (inherited
  // from the retired task-tracker-planner.js, dormant since 2026-08-10
  // because its delivery cron was never loaded) inverted this, producing
  // "+04:00" instead of "-04:00" for America/New_York and making every cue
  // parse as hours earlier than intended — confirmed live on 2026-08-17,
  // the first time this code path ever actually ran end-to-end.
  const sign = offsetMinutes < 0 ? '-' : '+';
  const absolute = Math.abs(offsetMinutes);
  return `${sign}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}`;
}

function deliverAtIso(dateStr, timeStr, timezone) {
  return `${dateStr}T${timeStr}:00${tzOffset(dateStr, timeStr, timezone)}`;
}

// Ports mergeCues from the retired planner unchanged: never overwrite a cue
// that's already `sent`; drop (not delete) cues for habits no longer active.
function mergeCues(targetDate, scheduled) {
  const existing = readJson(CUES_FILE, null);
  const priorByKey = new Map(
    existing && existing.date === targetDate && Array.isArray(existing.cues)
      ? existing.cues.map((cue) => [cue.key, cue])
      : [],
  );
  const scheduledKeys = new Set(scheduled.map((item) => `habit-${item.id}`));
  const cues = [];
  for (const item of scheduled) {
    const key = `habit-${item.id}`;
    const prior = priorByKey.get(key);
    if (prior && prior.status === 'sent') { cues.push(prior); continue; }
    cues.push({
      key,
      deliverAt: deliverAtIso(targetDate, hhmm(item.start), 'America/New_York'),
      text: `🎯 Up next: ${item.label} for ${item.duration} min at ${hhmm(item.start)}.`,
      status: 'pending',
    });
  }
  for (const [key, prior] of priorByKey) {
    if (scheduledKeys.has(key)) continue;
    cues.push(prior.status === 'pending' || prior.status === 'retry' ? { ...prior, status: 'dropped' } : prior);
  }
  return { date: targetDate, cues };
}

async function ensureHabitCuesSeeded(nowDate) {
  const config = readJson(CONFIG_FILE);
  if (!config) return { seeded: false, reason: 'no_config' };
  const now = localDate(nowDate, config.timezone);
  const cuesDoc = readJson(CUES_FILE, null);
  if (cuesDoc && cuesDoc.date === now.date) return { seeded: false, reason: 'already_seeded_today' };

  const habits = (readJson(HABITS_FILE, { habits: [] }).habits) || [];
  const history = (readJson(HISTORY_FILE, { completions: [] }).completions) || [];
  const completedIds = new Set(history.filter((item) => item.date === now.date).map((item) => item.id));
  const events = await listEvents(config.calendar, now.date);
  const roundedNow = Math.ceil(now.minute / config.slotMinutes) * config.slotMinutes;
  const plan = buildSchedule({ habits, completedIds, events, config, earliestMinute: roundedNow });
  atomicWriteJson(CUES_FILE, mergeCues(now.date, plan.scheduled));
  return { seeded: true, date: now.date, scheduled: plan.scheduled.length, unscheduled: plan.unscheduled.length };
}

function loadReassessState() {
  const data = readJson(REASSESS_STATE_FILE, { tasks: {} });
  return data && typeof data.tasks === 'object' ? data : { tasks: {} };
}

// A check-in is warranted when a task's pacing status transitions to
// behind/at-risk, or when it's still behind/at-risk and today hasn't had a
// check-in for it yet (the once-per-day cap — prevents re-firing every
// heartbeat tick for a status that hasn't changed).
//
// One conversation at a time (Aaron's explicit ask, 2026-08-17): at most
// one NEW check-in is proposed per run, and if `openThreadTaskId` names a
// task with an unreplied check-in already out, only that same task is
// eligible — everything else waits its turn rather than piling on. Aaron
// knows there are other tasks; the point is not to inundate him with all
// of them at once.
function decideCheckins(pacing, state, today, openThreadTaskId = null) {
  const checkins = [];
  const nextTasks = { ...state.tasks };
  let pickedOne = false;
  for (const item of pacing) {
    const prior = state.tasks[item.taskId];
    const transitioned = !prior || prior.lastNotifiedStatus !== item.status;
    const dueForDailyRecheck = DAILY_RECHECK_STATUSES.has(item.status)
      && prior && prior.lastNotifiedStatus === item.status
      && prior.lastNotifiedAt && prior.lastNotifiedAt.slice(0, 10) !== today;
    const eligible = DAILY_RECHECK_STATUSES.has(item.status) && (transitioned || dueForDailyRecheck);
    const blockedByOpenThread = openThreadTaskId && openThreadTaskId !== item.taskId;

    if (eligible && !blockedByOpenThread && !pickedOne) {
      checkins.push({ ...item, reason: transitioned ? 'status_transition' : 'daily_recheck' });
      nextTasks[item.taskId] = { lastNotifiedStatus: item.status, lastNotifiedAt: new Date().toISOString() };
      pickedOne = true;
    } else if (!DAILY_RECHECK_STATUSES.has(item.status) && transitioned) {
      // Pure on-track transition bookkeeping — safe to record regardless of
      // the cap/thread above, since no send is involved and it only helps
      // detect a future transition back into behind/at-risk correctly.
      nextTasks[item.taskId] = { lastNotifiedStatus: item.status, lastNotifiedAt: prior?.lastNotifiedAt || null };
    }
    // else: eligible but suppressed this run (one-at-a-time cap, or blocked
    // by a different task's open thread) — deliberately leave nextTasks
    // untouched so it stays eligible (still "transitioned") once the cap/
    // thread clears, instead of being silently marked as already handled.
  }
  return { checkins, tasks: nextTasks };
}

function openAwaitingReplyThread() {
  const doc = readJson(PENDING_CHECKINS_FILE, { checkins: [] });
  const checkins = Array.isArray(doc.checkins) ? doc.checkins : [];
  // Most recent awaiting-reply entry — there should only ever be one live
  // at a time (recordPendingCheckin supersedes an older one for the same
  // task before adding a new one), but take the latest defensively.
  return checkins.filter((c) => c.status === 'awaiting-reply').sort((a, b) => b.sentAt.localeCompare(a.sentAt))[0] || null;
}

// Does NOT persist state itself — decideCheckins is pure, and whether a
// checkin actually gets sent (vs. failing delivery) is only known to the
// caller (calendar-notification-workflow.js). Marking a task "notified"
// before delivery is confirmed would silently swallow a check-in on any
// send failure. Callers must call commitReassessState() themselves once
// they know which checkins actually went out — see runCheckins there.
//
// One conversation at a time: while a check-in is awaiting-reply, no new
// task gets brought up. If Aaron has gone quiet past FOLLOWUP_AFTER_MS, a
// single follow-up on that SAME task is proposed instead of starting a new
// one — never both, and never a second follow-up while the first is still
// within its own window (recordPendingCheckin resets sentAt on each send).
async function reassess({ now = new Date() } = {}) {
  const cueResult = await ensureHabitCuesSeeded(now).catch((error) => ({ seeded: false, error: error.message }));
  const today = todayInNewYork();
  const pacing = await computeAllPacing(today);
  const state = loadReassessState();
  const openThread = openAwaitingReplyThread();

  if (openThread) {
    const quietMs = now.getTime() - new Date(openThread.sentAt).getTime();
    if (quietMs >= FOLLOWUP_AFTER_MS) {
      const item = pacing.find((p) => p.taskId === openThread.taskId);
      const checkins = item ? [{ ...item, reason: 'followup_no_reply' }] : [];
      return { ok: true, habitCues: cueResult, pacing, checkins, nextState: state.tasks, priorState: state.tasks };
    }
    // Still within the quiet window — say nothing, wait for a reply.
    return { ok: true, habitCues: cueResult, pacing, checkins: [], nextState: state.tasks, priorState: state.tasks };
  }

  const { checkins, tasks } = decideCheckins(pacing, state, today, null);
  return { ok: true, habitCues: cueResult, pacing, checkins, nextState: tasks, priorState: state.tasks };
}

function commitReassessState(tasks) {
  atomicWriteJson(REASSESS_STATE_FILE, { tasks });
}

// Standalone CLI use (debugging/manual runs) has no downstream sender to
// gate the state commit on, so it commits immediately — production use
// goes through calendar-notification-workflow.js's runCheckins(), which
// commits only after attempting delivery (see commitReassessState above).
async function main() {
  try {
    const result = await reassess({
      now: process.env.OPENCLAW_CALENDAR_NOTIFICATION_NOW ? new Date(process.env.OPENCLAW_CALENDAR_NOTIFICATION_NOW) : undefined,
    });
    commitReassessState(result.nextState);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: error.message }, null, 2)}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  reassess, ensureHabitCuesSeeded, decideCheckins, mergeCues, deliverAtIso,
  loadReassessState, commitReassessState, openAwaitingReplyThread,
  REASSESS_STATE_FILE, PENDING_CHECKINS_FILE, FOLLOWUP_AFTER_MS,
};
