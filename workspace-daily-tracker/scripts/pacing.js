#!/usr/bin/env node
'use strict';

// Due-date pacing for Work/Personal/Market Lou tasks that carry an
// estimatedBlocks (30-min unit) effort estimate and a due date (schedule).
// Deterministic, no LLM. Applies only to due-dated + estimated tasks —
// everything else returns null pacing (no pressure).
//
// blocksRemaining / daysRemaining recomputed fresh every call is what makes
// "missed a day -> today's target goes up" fall out naturally: there's no
// separate miss-detection step, the shrinking denominator does it.

const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');

const WORKSPACE = path.join(__dirname, '..');
const API_BASE = process.env.OPENCLAW_DASHBOARD_API_BASE || 'http://127.0.0.1:18795';
const TOKEN_FILE = process.env.OPENCLAW_DASHBOARD_TOKEN_FILE ||
  '/Users/aaronmacmini/.openclaw/service-env/dashboard-api.token';
const TASK_PROGRESS_FILE = process.env.OPENCLAW_TASK_PROGRESS_FILE ||
  path.join(WORKSPACE, 'memory', 'task-progress.json');

const BOARDS = {
  work: '/api/tasks/work',
  'market-lou': '/api/tasks/market-lou',
  personal: '/api/tasks/personal',
};
const TASK_BOARD_ORDER = ['work', 'market-lou', 'personal'];

// ── minimal HTTP client, mirrors dashboard-workflow.js's apiCall (kept
//    self-contained rather than required, since that file executes its CLI
//    unconditionally on require and isn't meant to be imported) ──

function readToken() {
  try {
    const token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (!token) throw new Error('token file is empty');
    return token;
  } catch (error) {
    throw new Error(`Cannot read dashboard API token: ${error.message}`);
  }
}

function apiCall(method, pathname, body = undefined) {
  const target = new URL(pathname, API_BASE);
  const payload = body === undefined ? null : JSON.stringify(body);
  const headers = { Authorization: `Bearer ${readToken()}`, Accept: 'application/json' };
  if (payload !== null) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = Buffer.byteLength(payload);
  }
  return new Promise((resolve, reject) => {
    const req = http.request(target, { method, headers, timeout: 10_000 }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        let parsed = {};
        if (raw.trim()) {
          try { parsed = JSON.parse(raw); }
          catch { reject(new Error('Dashboard API returned invalid JSON')); return; }
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(parsed.error || `Dashboard API returned HTTP ${res.statusCode}`));
          return;
        }
        resolve(parsed);
      });
    });
    req.on('timeout', () => req.destroy(new Error('request timed out')));
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

// ── task-progress.json (append-only, half-block granularity) ──

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temp, file);
  } finally { try { fs.unlinkSync(temp); } catch {} }
}

function readProgressEntries() {
  const data = readJson(TASK_PROGRESS_FILE, { entries: [] });
  return Array.isArray(data.entries) ? data.entries : [];
}

function todayInNewYork() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
}

// Multiple check-ins in a day each append their own entry — summed by
// computePacing, never overwritten — so "half a block done" can be logged
// more than once without clobbering an earlier log from the same day.
function logProgress({ board, taskId, blocks, date }) {
  const amount = Number(blocks);
  if (!(amount > 0) || Math.round(amount * 2) !== amount * 2) {
    throw new Error('blocks must be a positive number in 0.5 increments');
  }
  const targetDate = date || todayInNewYork();
  const entries = readProgressEntries();
  entries.push({ taskId, board, date: targetDate, blocksLogged: amount, loggedAt: new Date().toISOString() });
  atomicWriteJson(TASK_PROGRESS_FILE, { entries });
  return { ok: true, taskId, board, date: targetDate, blocksLogged: amount };
}

function daysUntil(isoDate, todayDate) {
  const due = new Date(`${String(isoDate).slice(0, 10)}T00:00:00`);
  const today = new Date(`${todayDate}T00:00:00`);
  const diffDays = Math.round((due.getTime() - today.getTime()) / 86_400_000);
  return Math.max(diffDays, 0);
}

// status thresholds:
//  - at-risk: due today/tomorrow and can't realistically finish today alone
//  - behind:  today's required pace is meaningfully above the flat pace the
//             task would have needed if worked evenly since it was created
//  - on-track: everything else
function computePacing(task, progressEntries, today = todayInNewYork()) {
  if (!task || task.done) return null;
  if (!task.schedule || !task.schedule.startsAt) return null;
  if (!Number.isInteger(task.estimatedBlocks) || task.estimatedBlocks <= 0) return null;

  const totalLogged = progressEntries
    .filter((e) => e.taskId === task.id)
    .reduce((sum, e) => sum + Number(e.blocksLogged || 0), 0);
  const blocksRemaining = Math.max(task.estimatedBlocks - totalLogged, 0);
  const daysRemaining = Math.max(daysUntil(task.schedule.startsAt, today), 1); // due-today still gets a same-day target
  const targetBlocksPerDay = blocksRemaining / daysRemaining;

  const createdDays = Math.max(daysUntil(task.schedule.startsAt, task.added || today), 1);
  const flatPacePerDay = task.estimatedBlocks / createdDays;

  let status = 'on-track';
  if (daysRemaining <= 1 && blocksRemaining > 1) status = 'at-risk';
  else if (targetBlocksPerDay > flatPacePerDay * 1.25 && blocksRemaining > 0) status = 'behind';

  return {
    taskId: task.id, board: task.board, text: task.text,
    estimatedBlocks: task.estimatedBlocks, totalLogged, blocksRemaining,
    daysRemaining, targetBlocksPerDay: Math.round(targetBlocksPerDay * 100) / 100,
    dueDate: String(task.schedule.startsAt).slice(0, 10), status,
  };
}

const STATUS_URGENCY = { 'at-risk': 2, behind: 1, 'on-track': 0 };

async function computeAllPacing(today = todayInNewYork()) {
  const progressEntries = readProgressEntries();
  const boardData = await Promise.all(TASK_BOARD_ORDER.map((board) => apiCall('GET', BOARDS[board])));
  const results = [];
  TASK_BOARD_ORDER.forEach((board, i) => {
    const items = Array.isArray(boardData[i] && boardData[i].items) ? boardData[i].items : [];
    for (const item of items) {
      const pacing = computePacing({ ...item, board }, progressEntries, today);
      if (pacing) results.push(pacing);
    }
  });
  results.sort((a, b) => (STATUS_URGENCY[b.status] - STATUS_URGENCY[a.status]) || (a.daysRemaining - b.daysRemaining));
  return results;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i].startsWith('--')) { options[rest[i].slice(2)] = rest[i + 1]; i += 1; }
  }
  try {
    if (command === 'status') {
      const pacing = await computeAllPacing();
      process.stdout.write(`${JSON.stringify({ ok: true, pacing }, null, 2)}\n`);
      return;
    }
    if (command === 'log') {
      if (!options.board || !options['task-id'] || !options.blocks) {
        throw new Error('log requires --board --task-id --blocks');
      }
      const result = logProgress({ board: options.board, taskId: options['task-id'], blocks: Number(options.blocks), date: options.date });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }
    throw new Error(`Unknown command '${command}'. Usage: pacing.js status | log --board B --task-id ID --blocks N [--date YYYY-MM-DD]`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: error.message }, null, 2)}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  apiCall, TASK_BOARD_ORDER, BOARDS, TASK_PROGRESS_FILE,
  logProgress, computePacing, computeAllPacing, daysUntil, todayInNewYork,
};
