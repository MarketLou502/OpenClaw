#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'zaxbys-workflow.js');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaxbys-workflow-test-'));
const stateFile = path.join(tempDir, 'state.json');
const runner = path.join(tempDir, 'fake-runner.js');
const runnerLog = path.join(tempDir, 'runner.log');

fs.writeFileSync(runner, `#!/usr/bin/env node
const fs = require('fs');
const code = process.argv[2];
fs.appendFileSync(process.env.FAKE_RUNNER_LOG, code + '\\n');
if (code === 'FAILFAILFAILFAI') {
  process.stdout.write(JSON.stringify({ success: false, message: 'Fake rejection' }));
  process.exit(1);
}
process.stdout.write(JSON.stringify({ success: true, message: 'Fake success' }));
`, { encoding: 'utf8', mode: 0o700 });

function run(args, now = 1000) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      OPENCLAW_ZAXBYS_STATE_FILE: stateFile,
      OPENCLAW_ZAXBYS_RUNNER: runner,
      OPENCLAW_ZAXBYS_PENDING_TTL_MS: '600000',
      OPENCLAW_ZAXBYS_NOW_MS: String(now),
      FAKE_RUNNER_LOG: runnerLog,
    },
  });
  let body;
  try { body = JSON.parse(result.stdout); }
  catch { throw new Error(`Invalid output: ${result.stdout}; stderr=${result.stderr}`); }
  return { status: result.status, body };
}

function args(command, requestId, extra = []) {
  return [command, '--conversation', 'imessage:chat_id:1', '--request-id', requestId, ...extra];
}

function submissions() {
  try { return fs.readFileSync(runnerLog, 'utf8').trim().split('\n').filter(Boolean); }
  catch { return []; }
}

try {
  // High-confidence OCR is authorized by the explicit "Zaxby survey" intent
  // and submits once.
  let result = run(args('ingest', 'photo-high', ['--confidence', 'high', '--code', '2JZALBL6K2Z4GWF']));
  assert.equal(result.status, 0);
  assert.equal(result.body.action, 'submitted');
  assert.deepEqual(submissions(), ['2JZALBL6K2Z4GWF']);

  // Replaying the same inbound request cannot submit again.
  result = run(args('ingest', 'photo-high', ['--confidence', 'high', '--code', '2JZALBL6K2Z4GWF']));
  assert.equal(result.body.idempotent, true);
  assert.deepEqual(submissions(), ['2JZALBL6K2Z4GWF']);

  // Uncertain OCR stages a per-conversation code and a vague reply cannot
  // approve it.
  result = run(args('ingest', 'photo-low', ['--confidence', 'uncertain', '--code', 'AAAAAAAAAAAAAAA']), 2000);
  assert.equal(result.status, 0);
  assert.equal(result.body.action, 'verification_required');

  result = run(args('respond', 'reply-vague', ['--response', 'looks good']), 3000);
  assert.equal(result.status, 1);
  assert.equal(result.body.error.code, 'NOT_CONFIRMATION');
  assert.equal(submissions().length, 1);

  // An exact corrected code is both the correction and explicit verification.
  result = run(args('respond', 'reply-corrected', ['--response', 'BBBBBBBBBBBBBBB']), 4000);
  assert.equal(result.status, 0);
  assert.equal(result.body.action, 'submitted');
  assert.deepEqual(submissions(), ['2JZALBL6K2Z4GWF', 'BBBBBBBBBBBBBBB']);

  // Replaying the correction response is idempotent.
  result = run(args('respond', 'reply-corrected', ['--response', 'BBBBBBBBBBBBBBB']), 5000);
  assert.equal(result.body.idempotent, true);
  assert.equal(submissions().length, 2);

  // A malformed OCR result cannot auto-submit and requires the typed code.
  result = run(args('ingest', 'photo-invalid', ['--confidence', 'high', '--code', 'TOO-SHORT']), 6000);
  assert.equal(result.status, 0);
  assert.equal(result.body.action, 'code_required');
  result = run(args('respond', 'reply-empty-yes', ['--response', 'yes']), 7000);
  assert.equal(result.status, 1);
  assert.equal(result.body.error.code, 'CODE_REQUIRED');
  assert.equal(submissions().length, 2);

  // Pending verification expires after ten minutes.
  result = run(args('ingest', 'photo-expiring', ['--confidence', 'uncertain', '--code', 'CCCCCCCCCCCCCCC']), 10000);
  assert.equal(result.body.action, 'verification_required');
  result = run(args('respond', 'reply-expired', ['--response', 'yes']), 610001);
  assert.equal(result.status, 1);
  assert.equal(result.body.error.code, 'PENDING_EXPIRED');
  assert.equal(submissions().length, 2);

  // Cancellation clears pending state without a submission.
  result = run(args('ingest', 'photo-cancel', ['--confidence', 'uncertain', '--code', 'DDDDDDDDDDDDDDD']), 700000);
  assert.equal(result.body.action, 'verification_required');
  result = run(args('respond', 'reply-cancel', ['--response', 'cancel']), 700001);
  assert.equal(result.status, 0);
  assert.equal(result.body.action, 'cancelled');
  result = run(['status', '--conversation', 'imessage:chat_id:1'], 700002);
  assert.equal(result.body.pending, false);

  // Runner failures are bounded and remembered, so the same code is not
  // resubmitted on a new request.
  result = run(args('ingest', 'photo-fail', ['--confidence', 'high', '--code', 'FAILFAILFAILFAI']), 800000);
  assert.equal(result.status, 1);
  assert.equal(result.body.error.code, 'SURVEY_FAILED');
  assert.match(result.body.reply, /Fake rejection/);
  const countAfterFailure = submissions().length;
  result = run(args('ingest', 'photo-fail-new-request', ['--confidence', 'high', '--code', 'FAILFAILFAILFAI']), 800001);
  assert.equal(result.body.idempotent, true);
  assert.equal(submissions().length, countAfterFailure);

  assert.equal(fs.statSync(stateFile).mode & 0o777, 0o600);
  process.stdout.write('zaxbys-workflow tests passed\n');
} catch (error) {
  process.exitCode = 1;
  process.stderr.write(`${error.stack || error.message}\n`);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
