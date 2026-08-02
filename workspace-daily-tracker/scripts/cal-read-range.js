#!/usr/bin/env node
'use strict';

// Read one complete calendar month with a single Google Calendar API request.
// Output: { month, events: [{ eventId, date, title, startTime, endTime, allDay }] }

const { listEventsRange } = require('./lib/google-calendar');

const CALENDAR = 'aaron@marketlou.com';

function currentMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function monthBounds(month) {
  const [year, monthNumber] = month.split('-').map(Number);
  const start = `${year}-${String(monthNumber).padStart(2, '0')}-01`;
  const next = new Date(year, monthNumber, 1, 12, 0, 0);
  const end = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-01`;
  return { start, end };
}

async function main() {
  const candidate = process.argv[2] || currentMonth();
  const month = /^\d{4}-(?:0[1-9]|1[0-2])$/.test(candidate) ? candidate : currentMonth();
  try {
    const { start, end } = monthBounds(month);
    const events = await listEventsRange(CALENDAR, start, end);
    process.stdout.write(`${JSON.stringify({
      month,
      events: events.map((event) => ({
        id: event.eventId,
        date: event.date,
        title: event.title,
        start: event.startTime,
        end: event.endTime,
        allDay: event.allDay,
      })),
    })}\n`);
  } catch (error) {
    process.stderr.write(`cal-read-range failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

main();
