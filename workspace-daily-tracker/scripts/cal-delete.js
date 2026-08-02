#!/usr/bin/env node
// Delete all events with an exact-match title via the Google Calendar API.
//
// Usage: cal-delete.js <calendar> <title>

const { deleteEventsByTitle } = require('./lib/google-calendar');

async function main() {
  const [calendar, title] = process.argv.slice(2);
  if (!calendar || !title) {
    process.stderr.write('Usage: cal-delete.js <calendar> <title>\n');
    process.exit(1);
  }

  try {
    const count = await deleteEventsByTitle({ calendar, title });
    process.stdout.write(`Deleted ${count} event(s) titled '${title}' from ${calendar}\n`);
  } catch (err) {
    process.stderr.write(`Error deleting event: ${err.message}\n`);
    process.exit(1);
  }
}

main();
