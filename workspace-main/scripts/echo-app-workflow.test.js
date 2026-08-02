#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-app-test-'));
const fakeAdb = path.join(temp, 'adb');
const log = path.join(temp, 'calls.log');
fs.writeFileSync(fakeAdb, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\ncase "$*" in\n  devices) printf 'List of devices attached\\nadb-G0916D0994730JW6._adb-tls-connect._tcp\\tdevice\\n' ;;\n  *'pm list packages com.spotify.music'*) printf 'package:com.spotify.music\\n' ;;\n  *monkey*) printf 'Events injected: 1\\n' ;;\nesac\n`, { mode: 0o700 });
const script = path.join(__dirname, 'echo-app-workflow.js');
let result = spawnSync(process.execPath, [script, 'open', '--app', 'spotify'], {
  encoding: 'utf8', env: { ...process.env, OPENCLAW_ADB_PATH: fakeAdb },
});
assert.equal(result.status, 0);
assert.equal(JSON.parse(result.stdout).app, 'spotify');
assert.match(fs.readFileSync(log, 'utf8'), /monkey -p com\.spotify\.music/);
result = spawnSync(process.execPath, [script, 'connect'], {
  encoding: 'utf8', env: { ...process.env, OPENCLAW_ADB_PATH: fakeAdb },
});
assert.equal(result.status, 0);
assert.equal(JSON.parse(result.stdout).action, 'echo-connect');
result = spawnSync(process.execPath, [script, 'open', '--app', 'calculator'], {
  encoding: 'utf8', env: { ...process.env, OPENCLAW_ADB_PATH: fakeAdb },
});
assert.equal(result.status, 1);
assert.equal(JSON.parse(result.stdout).error.code, 'APP_NOT_ALLOWED');
fs.rmSync(temp, { recursive: true, force: true });
process.stdout.write('echo app workflow tests passed\n');
