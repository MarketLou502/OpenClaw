#!/usr/bin/env node
'use strict';

// Allowlisted Android app launcher for the Echo Show. Conversational input
// can select only app keys defined in config; it cannot supply shell commands.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const CONFIG_FILE = process.env.OPENCLAW_ECHO_APPS_CONFIG || path.join(__dirname, '..', 'config', 'echo-apps.json');
const ADB = process.env.OPENCLAW_ADB_PATH || '/opt/homebrew/bin/adb';

class WorkflowError extends Error {
  constructor(code, message, details) { super(message); this.code = code; this.details = details; }
}

function adb(args, timeout = 10000) {
  const result = spawnSync(ADB, args, { encoding: 'utf8', timeout });
  if (result.error) throw new WorkflowError('ADB_FAILED', result.error.message);
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

function connectedDevices() {
  return adb(['devices']).stdout.split('\n').slice(1).map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length >= 2 && parts[1] === 'device').map((parts) => parts[0]);
}

function discoverEndpoint(deviceId) {
  const rows = adb(['mdns', 'services']).stdout.split('\n');
  for (const row of rows) {
    const parts = row.trim().split(/\s+/);
    const isConnectService = parts[1] === '_adb-tls-connect._tcp' || parts[1] === '_adb._tcp';
    if (parts.length >= 3 && parts[0].includes(deviceId) && isConnectService) return parts[2];
  }
  return null;
}

function ensureDevice(config) {
  let devices = connectedDevices();
  let device = devices.find((serial) => serial.includes(config.deviceId));
  // Wireless ADB identifies the device as "ip:port", which never contains the
  // USB serial in config.deviceId. With only one Echo Show in play, a lone
  // connected device is unambiguous even when its serial format doesn't match.
  if (!device && devices.length === 1) device = devices[0];
  if (!device) {
    if (config.endpoint) {
      adb(['connect', config.endpoint], 15000);
      devices = connectedDevices();
      device = devices.find((serial) => serial === config.endpoint || serial.includes(config.deviceId));
    }
  }
  if (!device) {
    const endpoint = discoverEndpoint(config.deviceId);
    if (endpoint) {
      adb(['connect', endpoint], 15000);
      devices = connectedDevices();
      device = devices.find((serial) => serial.includes(config.deviceId) || serial === endpoint);
    }
  }
  if (!device) throw new WorkflowError('ECHO_NOT_CONNECTED',
    'Echo Show is not connected over wireless ADB. Confirm Wireless debugging is enabled and retry.');
  return device;
}

function loadConfig() {
  const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  if (!config.deviceId || !config.apps || typeof config.apps !== 'object') throw new WorkflowError('CONFIG_INVALID', 'Echo apps config is invalid');
  return config;
}

function openApp(appName) {
  const config = loadConfig();
  const key = String(appName || '').trim().toLocaleLowerCase();
  const app = config.apps[key];
  if (!app) throw new WorkflowError('APP_NOT_ALLOWED', `Unknown Echo app '${appName || ''}'`, { allowed: Object.keys(config.apps) });
  const device = ensureDevice(config);
  const installed = adb(['-s', device, 'shell', 'pm', 'list', 'packages', app.package]);
  if (!installed.stdout.split('\n').some((line) => line.trim() === `package:${app.package}`)) {
    throw new WorkflowError('APP_NOT_INSTALLED', `${app.label} is not installed on the Echo Show.`);
  }
  const launch = adb(['-s', device, 'shell', 'monkey', '-p', app.package, '-c', 'android.intent.category.LAUNCHER', '1'], 15000);
  if (launch.status !== 0 || /No activities found/i.test(`${launch.stdout}\n${launch.stderr}`)) {
    throw new WorkflowError('APP_LAUNCH_FAILED', `Could not open ${app.label} on the Echo Show.`);
  }
  return { ok: true, action: 'open-echo-app', app: key, device, reply: `Opened ${app.label} on the Echo Show.` };
}

function run(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    if (!rest[index].startsWith('--') || !rest[index + 1]) throw new WorkflowError('INVALID_ARGUMENT', 'Arguments must use --name value');
    options[rest[index].slice(2)] = rest[index + 1];
  }
  if (command === 'open') return openApp(options.app);
  if (command === 'connect') {
    const config = loadConfig();
    const device = ensureDevice(config);
    return { ok: true, action: 'echo-connect', device, reply: 'Echo Show ADB connection is ready.' };
  }
  if (command === 'status') {
    const config = loadConfig();
    return { ok: true, action: 'echo-status', devices: connectedDevices(), apps: Object.keys(config.apps) };
  }
  throw new WorkflowError('INVALID_COMMAND', "Use 'open --app spotify', 'connect', or 'status'");
}

try { process.stdout.write(`${JSON.stringify(run(process.argv.slice(2)), null, 2)}\n`); }
catch (error) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: { code: error.code || 'UNEXPECTED', message: error.message,
    ...(error.details === undefined ? {} : { details: error.details }) } }, null, 2)}\n`);
  process.exitCode = 1;
}
