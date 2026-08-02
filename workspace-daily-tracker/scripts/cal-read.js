#!/usr/bin/env node
// Read calendar events for a given date (YYYY-MM-DD) from Google Calendar.
// Outputs one line per event: H:MM-H:MM|Title
// Usage: cal-read.js 2026-05-31
// Defaults to tomorrow if no date given.
// On any failure, exits 0 with empty output — callers (server.js, heartbeat.js)
// treat that as "no events", not an error.

const { listEvents } = require('./lib/google-calendar');

const CALENDAR = 'aaron@marketlou.com';

function tomorrow() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

async function main() {
  const date = process.argv[2] || tomorrow();
  try {
    const events = await listEvents(CALENDAR, date);
    for (const e of events) {
      process.stdout.write(`${e.startTime}-${e.endTime}|${e.title}\n`);
    }
  } catch (err) {
    process.stderr.write(`cal-read failed: ${err.message}\n`);
  }
}

main();
