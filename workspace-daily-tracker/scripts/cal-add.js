#!/usr/bin/env node
// Add a calendar event via the Google Calendar API.
//
// Usage: cal-add.js <calendar> <title> <start-iso8601> <duration-minutes>
// Example: cal-add.js "aaron@marketlou.com" "Guitar Practice" "2026-05-24T14:00:00" 30

const { createEvent } = require('./lib/google-calendar');

async function main() {
  const [calendar, title, startIso, durationArg] = process.argv.slice(2);
  if (!calendar || !title || !startIso) {
    process.stderr.write('Usage: cal-add.js <calendar> <title> <start-iso8601> <duration-minutes>\n');
    process.exit(1);
  }
  const durationMin = durationArg ? Number(durationArg) : 60;

  try {
    await createEvent({ calendar, title, startIso, durationMin });
    process.stdout.write(`Created '${title}' in ${calendar} at ${startIso} (${durationMin} min)\n`);
  } catch (err) {
    process.stderr.write(`Error creating event: ${err.message}\n`);
    process.exit(1);
  }
}

main();
