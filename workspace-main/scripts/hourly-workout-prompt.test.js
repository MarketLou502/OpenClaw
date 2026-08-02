#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'hourly-workout-prompt.js');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hourly-workout-prompt-test-'));
const configFile = path.join(tempDir, 'config.json');
const stateFile = path.join(tempDir, 'state.json');
const deliveryLog = path.join(tempDir, 'delivery.log');
const fakeCli = path.join(tempDir, 'fake-openclaw.js');
const logDir = path.join(tempDir, 'logs');

fs.writeFileSync(configFile, JSON.stringify({
  timezone: 'America/New_York',
  startHour: 9,
  endHourExclusive: 17,
  replyWindowMinutes: 70,
  message: 'Did you get your hourly workout in?',
}), 'utf8');
fs.writeFileSync(fakeCli, `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_DELIVERY_LOG, JSON.stringify(args) + '\\n');
if (process.env.FAKE_DELIVERY_FAIL === '1') {
  process.stderr.write('fake delivery failure');
  process.exit(1);
}
process.stdout.write(JSON.stringify({ ok: true, messageId: 'fake-id' }));
`, { encoding: 'utf8', mode: 0o700 });

function run(command, now, extraEnv = {}) {
  const result = spawnSync(process.execPath, [SCRIPT, command], {
    encoding: 'utf8',
    env: {
      ...process.env,
      OPENCLAW_HOURLY_PROMPT_CONFIG: configFile,
      OPENCLAW_HOURLY_PROMPT_STATE: stateFile,
      OPENCLAW_HOURLY_PROMPT_LOG_DIR: logDir,
      OPENCLAW_HOURLY_PROMPT_NOW: now,
      OPENCLAW_NODE_PATH: process.execPath,
      OPENCLAW_CLI_PATH: fakeCli,
      FAKE_DELIVERY_LOG: deliveryLog,
      ...extraEnv,
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
  // 08:59 and 17:00 local are outside the eight prompt slots.
  let result = run('run', '2026-08-01T12:59:00.000Z');
  assert.equal(result.status, 0);
  assert.equal(result.body.reason, 'outside_window');
  assert.equal(deliveries().length, 0);

  result = run('run', '2026-08-01T13:00:00.000Z'); // 09:00 EDT
  assert.equal(result.status, 0);
  assert.equal(result.body.sent, true);
  assert.equal(result.body.slotHour, 9);
  assert.equal(deliveries().length, 1);
  assert.ok(deliveries()[0].includes('imessage'));
  assert.ok(deliveries()[0].includes('chat_id:1'));

  // A repeated launch in the same hour does not duplicate the prompt.
  result = run('run', '2026-08-01T13:30:00.000Z');
  assert.equal(result.body.reason, 'already_sent');
  assert.equal(deliveries().length, 1);

  result = run('run', '2026-08-01T14:00:00.000Z'); // 10:00 EDT
  assert.equal(result.body.sent, true);
  assert.equal(result.body.slotHour, 10);
  assert.equal(deliveries().length, 2);

  result = run('status', '2026-08-01T15:05:00.000Z'); // 65 minutes later
  assert.equal(result.body.recentPrompt, true);
  assert.equal(result.body.latest.slotHour, 10);

  result = run('status', '2026-08-01T15:11:00.000Z'); // 71 minutes later
  assert.equal(result.body.recentPrompt, false);
  assert.equal(result.body.latest.slotHour, 10);

  result = run('run', '2026-08-01T21:00:00.000Z'); // 17:00 EDT
  assert.equal(result.body.reason, 'outside_window');
  assert.equal(deliveries().length, 2);
  assert.equal(fs.statSync(stateFile).mode & 0o777, 0o600);

  // Explicit delivery failure clears the in-flight marker and can retry.
  fs.unlinkSync(stateFile);
  result = run('run', '2026-08-02T13:00:00.000Z', { FAKE_DELIVERY_FAIL: '1' });
  assert.equal(result.status, 1);
  assert.equal(result.body.sent, false);
  const failedState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.ok(!failedState.sent['9']);
  assert.ok(!failedState.sending['9']);

  result = run('run', '2026-08-02T13:01:00.000Z');
  assert.equal(result.status, 0);
  assert.equal(result.body.sent, true);

  process.stdout.write('hourly-workout-prompt tests passed\n');
} catch (error) {
  process.exitCode = 1;
  process.stderr.write(`${error.stack || error.message}\n`);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
