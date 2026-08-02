#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'calendar-notification-workflow.js');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calendar-notification-test-'));
const configFile = path.join(tempDir, 'config.json');
const eventsFile = path.join(tempDir, 'events.json');
const stateFile = path.join(tempDir, 'state.json');
const legacyStateFile = path.join(tempDir, 'legacy-state.json');
const deliveryLog = path.join(tempDir, 'delivery.log');
const fakeCli = path.join(tempDir, 'fake-openclaw.js');
const logDir = path.join(tempDir, 'logs');

const config = {
  timezone: 'America/New_York',
  calendar: 'test@example.com',
  morningHour: 8,
  reminderWindowMinutes: { minimum: 20, maximum: 50 },
  noReminderTitles: ['Guitar', 'Golf', 'Spanish', 'Study AI 900', 'Clean', 'Workout/Run'],
};
fs.writeFileSync(configFile, JSON.stringify(config), 'utf8');
fs.writeFileSync(legacyStateFile, JSON.stringify({ date: '2026-08-01', morningSent: false, notified: [] }), 'utf8');
fs.writeFileSync(fakeCli, `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const message = args[args.indexOf('--message') + 1];
fs.appendFileSync(process.env.FAKE_DELIVERY_LOG, JSON.stringify({ args, message }) + '\\n');
if (message.includes('FAIL DELIVERY')) {
  process.stderr.write('fake delivery failure');
  process.exit(1);
}
process.stdout.write(JSON.stringify({ ok: true, messageId: 'fake-id' }));
`, { encoding: 'utf8', mode: 0o700 });

function writeEvents(events) {
  fs.writeFileSync(eventsFile, JSON.stringify(events), 'utf8');
}

function run(command, now) {
  const result = spawnSync(process.execPath, [SCRIPT, command], {
    encoding: 'utf8',
    env: {
      ...process.env,
      OPENCLAW_CALENDAR_NOTIFICATION_CONFIG: configFile,
      OPENCLAW_CALENDAR_NOTIFICATION_EVENTS_FILE: eventsFile,
      OPENCLAW_CALENDAR_NOTIFICATION_STATE: stateFile,
      OPENCLAW_CALENDAR_NOTIFICATION_LEGACY_STATE: legacyStateFile,
      OPENCLAW_CALENDAR_NOTIFICATION_LOG_DIR: logDir,
      OPENCLAW_CALENDAR_NOTIFICATION_NOW: now,
      OPENCLAW_NODE_PATH: process.execPath,
      OPENCLAW_CLI_PATH: fakeCli,
      FAKE_DELIVERY_LOG: deliveryLog,
    },
  });
  let body;
  try { body = JSON.parse(result.stdout); }
  catch { throw new Error(`Invalid output: ${result.stdout}; stderr=${result.stderr}`); }
  return { status: result.status, body };
}

function deliveries() {
  try { return fs.readFileSync(deliveryLog, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); }
  catch { return []; }
}

try {
  const commonEvents = [
    { eventId: 'all-day', title: 'Birthday', startTime: '0:00', endTime: '23:59', allDay: true },
    { eventId: 'guitar', title: 'Guitar', startTime: '9:00', endTime: '9:30', allDay: false },
    { eventId: 'team', title: 'Team meeting', startTime: '9:30', endTime: '10:00', allDay: false },
    { eventId: 'flagged', title: 'Private focus', startTime: '9:20', endTime: '9:50', allDay: false, noReminder: true },
  ];
  writeEvents(commonEvents);

  // A plan is read-only and includes a morning overview plus only the eligible
  // timed event reminder. Routine, all-day, and explicitly flagged events skip
  // reminder delivery.
  let result = run('plan', '2026-08-01T12:40:00.000Z'); // 08:40 EDT
  assert.equal(result.status, 0);
  assert.deepEqual(result.body.notifications.map((item) => item.key), ['morning', 'event:team']);
  assert.equal(deliveries().length, 0);

  result = run('run', '2026-08-01T12:40:00.000Z');
  assert.equal(result.status, 0);
  assert.equal(result.body.sent, 2);
  assert.equal(deliveries().length, 2);
  assert.match(deliveries()[0].message, /^🌅 Today:/);
  assert.ok(deliveries()[0].args.includes('imessage'));
  assert.ok(deliveries()[0].args.includes('chat_id:1'));
  assert.match(deliveries()[1].message, /^⏰ Team meeting/);

  // A repeat run cannot duplicate the morning or event reminder.
  result = run('run', '2026-08-01T12:40:00.000Z');
  assert.equal(result.body.sent, 0);
  assert.equal(deliveries().length, 2);

  // Exact exclusion means a distinct "Guitar lesson" still receives a reminder.
  writeEvents([{ eventId: 'lesson', title: 'Guitar lesson with Mike', startTime: '10:00', endTime: '11:00', allDay: false }]);
  result = run('run', '2026-08-01T13:30:00.000Z'); // 09:30 EDT
  assert.equal(result.body.sent, 1);
  assert.match(deliveries().at(-1).message, /Guitar lesson with Mike/);

  // Empty calendars remain silent and do not mark the morning notification sent.
  fs.unlinkSync(stateFile);
  fs.writeFileSync(legacyStateFile, JSON.stringify({ date: '2026-08-02', morningSent: false, notified: [] }), 'utf8');
  writeEvents([]);
  const beforeEmpty = deliveries().length;
  result = run('run', '2026-08-02T13:00:00.000Z'); // 09:00 EDT
  assert.equal(result.body.sent, 0);
  assert.equal(deliveries().length, beforeEmpty);
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).morningSent, false);

  // Failed delivery is not recorded as sent and is eligible for a later retry.
  writeEvents([{ eventId: 'failure', title: 'FAIL DELIVERY', startTime: '10:00', endTime: '10:30', allDay: false }]);
  result = run('run', '2026-08-02T13:30:00.000Z');
  assert.equal(result.status, 1);
  assert.equal(result.body.sent, 0);
  const failedState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.ok(!failedState.notified.includes('event:failure'));
  assert.ok(!failedState.sending['event:failure']);

  // A same-day legacy state import prevents duplicate legacy reminders.
  fs.unlinkSync(stateFile);
  fs.writeFileSync(legacyStateFile, JSON.stringify({
    date: '2026-08-03', morningSent: true, notified: ['10:00|Legacy event'],
  }), 'utf8');
  writeEvents([{ eventId: 'legacy-id', title: 'Legacy event', startTime: '10:00', endTime: '10:30', allDay: false }]);
  const beforeLegacy = deliveries().length;
  result = run('run', '2026-08-03T13:30:00.000Z');
  assert.equal(result.body.sent, 0);
  assert.equal(deliveries().length, beforeLegacy);
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).importedLegacyState, true);

  assert.equal(fs.statSync(stateFile).mode & 0o777, 0o600);
  process.stdout.write('calendar-notification-workflow tests passed\n');
} catch (error) {
  process.exitCode = 1;
  process.stderr.write(`${error.stack || error.message}\n`);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
