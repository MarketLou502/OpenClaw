#!/usr/bin/env node
'use strict';

// Deterministic Google Calendar workflow for OpenClaw's main agent.
// It never classifies natural language and never sends messages. Mutations
// target one resolved event ID so rescheduling cannot delete same-title events.

const {
  listEvents,
  createEvent,
  updateEvent,
  deleteEvent,
} = require('../../workspace-daily-tracker/scripts/lib/google-calendar');

const CALENDAR = 'aaron@marketlou.com';

class WorkflowError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token.startsWith('--')) throw new WorkflowError('INVALID_ARGUMENT', `Unexpected argument '${token}'`);
    const key = token.slice(2);
    const value = rest[i + 1];
    if (!value || value.startsWith('--')) throw new WorkflowError('INVALID_ARGUMENT', `Missing value for --${key}`);
    options[key] = value;
    i += 1;
  }
  return { command, options };
}

function required(value, name) {
  const text = String(value || '').trim();
  if (!text) throw new WorkflowError('INVALID_ARGUMENT', `${name} is required`);
  return text;
}

function validDate(value, name = 'Date') {
  const date = required(value, name);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new WorkflowError('INVALID_ARGUMENT', `${name} must be YYYY-MM-DD`);
  const [year, month, day] = date.split('-').map(Number);
  const parsed = new Date(year, month - 1, day);
  if (parsed.getFullYear() !== year || parsed.getMonth() !== month - 1 || parsed.getDate() !== day) {
    throw new WorkflowError('INVALID_ARGUMENT', `${name} is not a real calendar date`);
  }
  return date;
}

function validTime(value) {
  const time = required(value, 'Time');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new WorkflowError('INVALID_ARGUMENT', 'Time must be HH:MM in 24-hour time');
  return time;
}

function validDuration(value) {
  const duration = value === undefined ? 60 : Number(value);
  if (!Number.isInteger(duration) || duration < 1 || duration > 1440) {
    throw new WorkflowError('INVALID_ARGUMENT', 'Duration must be an integer from 1 to 1440 minutes');
  }
  return duration;
}

function formatTime(time) {
  const [hourText, minute] = time.split(':');
  const hour = Number(hourText);
  const suffix = hour >= 12 ? 'PM' : 'AM';
  return `${hour % 12 || 12}:${minute} ${suffix}`;
}

function formatEvents(date, events) {
  if (!events.length) return `📅 Nothing scheduled for ${date}.`;
  return `📅 ${date}:\n${events.map((event) => event.allDay
    ? `• All day — ${event.title}`
    : `• ${formatTime(event.startTime.padStart(5, '0'))}–${formatTime(event.endTime.padStart(5, '0'))} — ${event.title}`).join('\n')}`;
}

function chooseEvent(events, title) {
  const needle = title.toLocaleLowerCase();
  const exact = events.filter((event) => event.title.toLocaleLowerCase() === needle);
  const matches = exact.length ? exact : events.filter((event) => event.title.toLocaleLowerCase().includes(needle));
  if (!matches.length) throw new WorkflowError('NOT_FOUND', `No event found matching '${title}' on that date`);
  if (matches.length > 1) {
    throw new WorkflowError('AMBIGUOUS_MATCH', `More than one event matches '${title}' on that date`, {
      matches: matches.map(({ eventId, title: eventTitle, startTime, endTime }) => ({ eventId, title: eventTitle, startTime, endTime })),
    });
  }
  return matches[0];
}

async function list(dateValue) {
  const date = validDate(dateValue);
  const events = await listEvents(CALENDAR, date);
  return { ok: true, action: 'list', calendar: CALENDAR, date, events, reply: formatEvents(date, events) };
}

async function add(options) {
  const title = required(options.title, 'Title');
  const date = validDate(options.date);
  const time = validTime(options.time);
  const durationMinutes = validDuration(options.duration);
  const event = await createEvent({ calendar: CALENDAR, title, startIso: `${date}T${time}:00`, durationMin: durationMinutes });
  return {
    ok: true,
    action: 'add',
    calendar: CALENDAR,
    eventId: event && event.id,
    title,
    date,
    time,
    durationMinutes,
    reply: `📅 Added “${title}” on ${date} at ${formatTime(time)} for ${durationMinutes} minutes.`,
  };
}

async function resolveByDateAndTitle(dateValue, titleValue) {
  const date = validDate(dateValue);
  const title = required(titleValue, 'Title');
  const events = await listEvents(CALENDAR, date);
  return { date, match: chooseEvent(events, title) };
}

async function remove(options) {
  const { date, match } = await resolveByDateAndTitle(options.date, options.title);
  await deleteEvent({ calendar: CALENDAR, eventId: match.eventId });
  return {
    ok: true,
    action: 'delete',
    calendar: CALENDAR,
    eventId: match.eventId,
    title: match.title,
    date,
    reply: `🗑 Removed “${match.title}” from ${date}.`,
  };
}

async function reschedule(options) {
  const { date: oldDate, match } = await resolveByDateAndTitle(options.date, options.title);
  if (match.allDay) throw new WorkflowError('UNSUPPORTED_EVENT', 'All-day events cannot be rescheduled with this timed-event workflow');
  const newDate = validDate(options['new-date'], 'New date');
  const newTime = validTime(options['new-time']);
  const currentDuration = Math.round((new Date(match.endIso) - new Date(match.startIso)) / 60000);
  const durationMinutes = options.duration === undefined ? currentDuration : validDuration(options.duration);
  await updateEvent({
    calendar: CALENDAR,
    eventId: match.eventId,
    title: match.title,
    startIso: `${newDate}T${newTime}:00`,
    durationMin: durationMinutes,
  });
  return {
    ok: true,
    action: 'reschedule',
    calendar: CALENDAR,
    eventId: match.eventId,
    title: match.title,
    oldDate,
    newDate,
    newTime,
    durationMinutes,
    reply: `📅 Moved “${match.title}” to ${newDate} at ${formatTime(newTime)}.`,
  };
}

function help() {
  return {
    ok: true,
    action: 'help',
    usage: [
      'calendar-workflow.js list --date YYYY-MM-DD',
      'calendar-workflow.js add --title "Event" --date YYYY-MM-DD --time HH:MM [--duration 60]',
      'calendar-workflow.js delete --title "Event" --date YYYY-MM-DD',
      'calendar-workflow.js reschedule --title "Event" --date YYYY-MM-DD --new-date YYYY-MM-DD --new-time HH:MM [--duration 60]',
    ],
  };
}

async function run(argv) {
  const { command, options } = parseArgs(argv);
  switch (command) {
    case 'list': return list(options.date);
    case 'add': return add(options);
    case 'delete': return remove(options);
    case 'reschedule': return reschedule(options);
    case 'help':
    case '--help':
    case undefined: return help();
    default: throw new WorkflowError('INVALID_COMMAND', `Unknown command '${command}'`, { usage: help().usage });
  }
}

run(process.argv.slice(2))
  .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
  .catch((error) => {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      error: {
        code: error.code || 'CALENDAR_ERROR',
        message: error.message || String(error),
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    }, null, 2)}\n`);
    process.exitCode = 1;
  });

