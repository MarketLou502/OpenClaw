#!/usr/bin/env node
'use strict';

// Sends one native iMessage prompt per configured hourly slot. It records
// enough deterministic state for Main to correlate a later short "yes" with
// the most recent prompt instead of relying on LLM conversation inference.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { sendNativeIMessage } = require('./lib/native-imessage');

const WORKSPACE = path.join(__dirname, '..');
const CONFIG_FILE = process.env.OPENCLAW_HOURLY_PROMPT_CONFIG ||
  path.join(WORKSPACE, 'config', 'hourly-workout-prompts.json');
const STATE_FILE = process.env.OPENCLAW_HOURLY_PROMPT_STATE ||
  path.join(WORKSPACE, 'memory', 'hourly-workout-prompt-state.json');
const LOG_DIR = process.env.OPENCLAW_HOURLY_PROMPT_LOG_DIR ||
  path.join(WORKSPACE, 'memory', 'hourly-workout-prompts');

class WorkflowError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw new WorkflowError('STATE_READ_FAILED', `Could not read ${file}: ${error.message}`);
  }
}

function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${crypto.randomBytes(5).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temp, file);
    fs.chmodSync(file, 0o600);
  } finally {
    try { fs.unlinkSync(temp); } catch {}
  }
}

function loadConfig() {
  const config = readJson(CONFIG_FILE);
  if (!config?.timezone || !config?.message) throw new WorkflowError('CONFIG_INVALID', 'Prompt config is invalid');
  if (!Number.isInteger(config.startHour) || !Number.isInteger(config.endHourExclusive) ||
      config.startHour < 0 || config.endHourExclusive > 24 || config.endHourExclusive <= config.startHour) {
    throw new WorkflowError('CONFIG_INVALID', 'Prompt hour range is invalid');
  }
  if (!Number.isInteger(config.replyWindowMinutes) || config.replyWindowMinutes < 1) {
    throw new WorkflowError('CONFIG_INVALID', 'Reply window is invalid');
  }
  return config;
}

function currentDate() {
  const override = process.env.OPENCLAW_HOURLY_PROMPT_NOW;
  const date = override ? new Date(override) : new Date();
  if (!Number.isFinite(date.getTime())) throw new WorkflowError('INVALID_TIME', 'Current time override is invalid');
  return date;
}

function zoned(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    hour: Number(values.hour),
    minute: Number(values.minute),
  };
}

function loadState(date) {
  const state = readJson(STATE_FILE, null);
  if (!state || state.version !== 1 || state.date !== date) {
    return { version: 1, date, sent: {}, sending: {} };
  }
  state.sent ||= {};
  state.sending ||= {};
  return state;
}

function appendLog(date, line) {
  fs.mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
  fs.appendFileSync(path.join(LOG_DIR, `${date}.log`), `${new Date().toISOString()} ${line}\n`, 'utf8');
}

function status(config, nowDate, local, state) {
  const slots = Object.entries(state.sent)
    .map(([hour, sentAt]) => ({ hour: Number(hour), sentAt, ageMinutes: (nowDate - new Date(sentAt)) / 60000 }))
    .filter((entry) => Number.isFinite(entry.ageMinutes) && entry.ageMinutes >= 0)
    .sort((left, right) => new Date(right.sentAt) - new Date(left.sentAt));
  const latest = slots[0] || null;
  return {
    ok: true,
    action: 'status',
    date: local.date,
    recentPrompt: !!latest && latest.ageMinutes <= config.replyWindowMinutes,
    latest: latest ? {
      slotHour: latest.hour,
      sentAt: latest.sentAt,
      ageMinutes: Math.round(latest.ageMinutes * 10) / 10,
    } : null,
  };
}

function run() {
  const config = loadConfig();
  const nowDate = currentDate();
  const local = zoned(nowDate, config.timezone);
  const state = loadState(local.date);
  if (local.hour < config.startHour || local.hour >= config.endHourExclusive) {
    if (!fs.existsSync(STATE_FILE)) atomicWrite(STATE_FILE, state);
    return { ok: true, action: 'run', sent: false, reason: 'outside_window', slotHour: null };
  }
  const key = String(local.hour);
  if (state.sent[key]) return { ok: true, action: 'run', sent: false, reason: 'already_sent', slotHour: local.hour };
  if (state.sending[key]) {
    return { ok: false, action: 'run', sent: false, reason: 'prior_delivery_status_unknown', slotHour: local.hour };
  }
  state.sending[key] = { startedAt: nowDate.toISOString() };
  atomicWrite(STATE_FILE, state);
  const delivery = sendNativeIMessage(config.message);
  if (!delivery.ok) {
    delete state.sending[key];
    atomicWrite(STATE_FILE, state);
    appendLog(local.date, `Delivery failed for slot ${key}: ${delivery.error}`);
    return { ok: false, action: 'run', sent: false, slotHour: local.hour, error: delivery.error };
  }
  delete state.sending[key];
  state.sent[key] = nowDate.toISOString();
  atomicWrite(STATE_FILE, state);
  appendLog(local.date, `Prompt sent for slot ${key}`);
  return { ok: true, action: 'run', sent: true, slotHour: local.hour };
}

function main() {
  try {
    const command = process.argv[2] || 'run';
    const config = loadConfig();
    const nowDate = currentDate();
    const local = zoned(nowDate, config.timezone);
    const state = loadState(local.date);
    let result;
    if (command === 'run') result = run();
    else if (command === 'status') result = status(config, nowDate, local, state);
    else throw new WorkflowError('INVALID_COMMAND', `Unknown command '${command}'`);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: { code: error.code || 'INTERNAL_ERROR', message: error.message } })}\n`);
    process.exitCode = 1;
  }
}

main();
