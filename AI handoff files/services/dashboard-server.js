#!/usr/bin/env node
// dashboard-api — single writer for goals/tasks/grocery/health data, and
// static host for the dashboard-web frontend itself.
//
// Serves the Echo Show dashboard's /api/* contract (see the Computer repo's
// README/app.js for the client-side shape). Also called internally, over
// localhost, by Main's deterministic workflows and delegated health logging
// turns — see the integration plan for why: this process is
// the ONLY thing that writes the underlying JSON files, so two callers can
// never race on the same file.
//
// dashboard-web's index.html/app.js/style.css are served from here too
// (public/) rather than from a separate process — confirmed necessary, not
// just simpler, by the kiosk-app team: app.js's API_BASE defaults to
// same-origin unless a `?api=` param is present, and MainActivity.kt's
// loadDashboard() never adds one, so the static files and this API must
// share an origin/port or every fetch() silently targets the wrong host.
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const store = require('../../lib/taskstore');

const PORT = Number(process.env.DASHBOARD_API_PORT || 18795);
const HOST = process.env.DASHBOARD_API_HOST || '0.0.0.0'; // LAN-reachable by default; tests use loopback.

const PUBLIC_DIR = path.join(__dirname, 'public');
const STATIC_FILES = {
  '/':          { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js':    { file: 'app.js', type: 'application/javascript; charset=utf-8' },
  '/style.css': { file: 'style.css', type: 'text/css; charset=utf-8' },
};

const TOKEN_FILE = process.env.DASHBOARD_API_TOKEN_FILE || '/Users/aaronmacmini/.openclaw/service-env/dashboard-api.token';
const DT_WORKSPACE = '/Users/aaronmacmini/.openclaw/workspace-daily-tracker';
const HT_WORKSPACE = '/Users/aaronmacmini/.openclaw/workspace-health-tracker';
const FIN_DB = process.env.FINANCE_DB_PATH || '/Users/aaronmacmini/.openclaw/workspace-finance-agent/finance.db';
const CAL_READ = process.env.CALENDAR_READ_SCRIPT || path.join(DT_WORKSPACE, 'scripts/cal-read.sh');
const CAL_READ_RANGE = process.env.CALENDAR_READ_RANGE_SCRIPT || path.join(DT_WORKSPACE, 'scripts/cal-read-range.js');

const TASKS_DIR = path.join(DT_WORKSPACE, 'tasks');
const BOARDS = ['accenture', 'personal', 'market-lou'];
const boardFile = (board) => path.join(TASKS_DIR, `${board}.json`);
const GROCERY_FILE = path.join(TASKS_DIR, 'grocery.json');
const HABITS_FILE = path.join(TASKS_DIR, 'daily-habits.json');
const TODAY_HABITS_FILE = path.join(DT_WORKSPACE, 'memory/today-habits.json');
const GOALS_HISTORY_FILE = path.join(TASKS_DIR, 'goals-history.json');
const TODAY_HEALTH_FILE = path.join(HT_WORKSPACE, 'memory/today-state.json');

// Real targets from health-tracker's own MEMORY.md (3,250 kcal / 160g protein),
// not the dashboard repo's mock data (which shows 180g and includes water —
// water was explicitly dropped from this contract).
const HEALTH_DEFAULTS = {
  calories: { current: 0, target: 3250, unit: '' },
  protein: { current: 0, target: 160, unit: 'g' },
  hourlyWorkouts: { current: 0, target: 8, unit: '' },
};

function log(msg) { process.stdout.write(`[dashboard-api] ${new Date().toISOString()} ${msg}\n`); }

let TOKEN;
try {
  TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  if (!TOKEN) throw new Error('empty token file');
} catch (e) {
  console.error(`Cannot start: failed to read bearer token from ${TOKEN_FILE} (${e.message})`);
  process.exit(1);
}

// ── HTTP helpers ─────────────────────────────────────────────────────────

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 1_000_000) req.destroy(); });
    req.on('end', () => {
      if (!raw.trim()) { resolve({}); return; }
      try { resolve(JSON.parse(raw)); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// Reads straight off disk per request (no in-memory cache) so editing
// public/*.html/js/css takes effect on the WebView's next reload with no
// need to restart this process — matches the whole "edit and reload, no
// rebuild" point of the kiosk being a WebView instead of native.
function serveStatic(res, pathname) {
  const entry = STATIC_FILES[pathname];
  fs.readFile(path.join(PUBLIC_DIR, entry.file), (err, data) => {
    if (err) {
      log(`static file read failed for ${pathname}: ${err.message}`);
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': entry.type, 'Content-Length': data.length });
    res.end(data);
  });
}

// ── Domain handlers ──────────────────────────────────────────────────────

function getGoals() {
  const habits = store.readHabitLabels(HABITS_FILE);
  const state = store.readTodayHabits(TODAY_HABITS_FILE, habits);
  return { goals: habits.map((h) => ({ id: h.id, label: h.label, done: !!state.done[h.id] })) };
}

function patchGoal(id, done) {
  const habits = store.readHabitLabels(HABITS_FILE);
  const state = store.toggleHabit(TODAY_HABITS_FILE, habits, id, done, GOALS_HISTORY_FILE);
  return state; // null if id unknown
}

function getGoalsHistoryBuckets() {
  return { months: store.getHabitHistoryBuckets(GOALS_HISTORY_FILE) };
}

function getGoalsHistoryMonth(year, month) {
  const habits = store.readHabitLabels(HABITS_FILE);
  return { items: store.getHabitHistoryMonth(GOALS_HISTORY_FILE, habits, year, month) };
}

function listItems(filePath) {
  return { items: store.readItems(filePath) };
}

function addItem(filePath, text) {
  if (!text || !String(text).trim()) return null;
  return store.addItem(filePath, text);
}

function patchItem(filePath, id, done) {
  return store.toggleItem(filePath, id, done);
}

function removeItem(filePath, id) {
  return store.removeItem(filePath, id);
}

function getItemHistoryBuckets(filePath) {
  return { months: store.getItemHistoryBuckets(filePath) };
}

function getItemHistoryMonth(filePath, year, month) {
  return { items: store.getItemHistoryMonth(filePath, year, month) };
}

function getHealth() {
  const state = store.readTodayHealth(TODAY_HEALTH_FILE, HEALTH_DEFAULTS);
  return Object.fromEntries(Object.keys(HEALTH_DEFAULTS).map((key) => [key, state[key]]));
}

function patchHealthState(patch) {
  const { date, ...rest } = store.patchHealth(TODAY_HEALTH_FILE, HEALTH_DEFAULTS, patch);
  return rest;
}

// ── Financials — spending today and upcoming recurring transactions ─────
// Everything below is computed fresh on every request straight from
// finance.db (no cached/persisted state), so it self-corrects as new
// transactions get parsed — same spawnSync-sqlite3 approach as spent_today.

function runFinSql(sql) {
  const result = spawnSync('sqlite3', ['-json', FIN_DB, sql], { encoding: 'utf8', timeout: 10000 });
  if (result.status !== 0) {
    log(`financials query failed: ${(result.stderr || '').slice(0, 200)}`);
    return [];
  }
  try { return JSON.parse(result.stdout || '[]'); } catch { return []; }
}

function parseYMD(str) {
  const [y, m, d] = str.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function toYMD(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getActiveMonthlyExpenses() {
  return runFinSql(`
    SELECT name, amount_est AS amount, due_day, is_negotiable
    FROM expenses
    WHERE active=1 AND recurrence='monthly' AND amount_est IS NOT NULL AND due_day IS NOT NULL;
  `);
}

// Walks [start, endExclusive) day by day and expands monthly due_day entries.
function expensesInWindow(expenses, start, endExclusive) {
  const out = [];
  const d = new Date(start);
  while (d < endExclusive) {
    for (const e of expenses) {
      if (d.getDate() === e.due_day) {
        out.push({ name: e.name, amount: e.amount, due_date: toYMD(d), is_negotiable: !!e.is_negotiable });
      }
    }
    d.setDate(d.getDate() + 1);
  }
  return out;
}

function getPendingReview() {
  return runFinSql(`
    SELECT id, date, type, amount, merchant_raw
    FROM transactions
    WHERE needs_review=1 AND type='debit'
    ORDER BY date ASC, id ASC;
  `);
}

function markReviewed(id) {
  const rows = runFinSql(`
    UPDATE transactions SET needs_review=0
    WHERE id=${id} AND needs_review=1 AND type='debit';
    SELECT changes() AS n;
  `);
  return !!(rows[0] && rows[0].n === 1);
}

function getFinancials() {
  const todayString = store.todayStr();
  const today = parseYMD(todayString);

  const spentRows = runFinSql(`SELECT COALESCE(SUM(amount), 0) AS spent_today FROM transactions WHERE type = 'debit' AND date = '${todayString}';`);
  const spent = spentRows[0] && typeof spentRows[0].spent_today === 'number' ? spentRows[0].spent_today : 0;

  const nextMonth = new Date(today.getFullYear(), today.getMonth() + 1, 1);
  const upcomingTransactions = expensesInWindow(getActiveMonthlyExpenses(), today, nextMonth)
    .sort((left, right) => left.due_date.localeCompare(right.due_date) || left.name.localeCompare(right.name));

  return {
    spent_today: Math.round(spent * 100) / 100,
    currency: 'USD',
    upcoming_transactions: upcomingTransactions,
    pending_review: getPendingReview(),
  };
}

function getCalendar(dateStr) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(dateStr || '') ? dateStr : store.todayStr();
  const result = spawnSync('/bin/bash', [CAL_READ, date], { encoding: 'utf8', timeout: 45000 });
  if (result.status !== 0) {
    log(`calendar read failed for ${date}: ${(result.stderr || '').slice(0, 200)}`);
    return { events: [] };
  }
  const events = [];
  for (const line of (result.stdout || '').split('\n')) {
    const m = line.match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})\|(.*)$/);
    if (!m) continue;
    const [, sh, sm, eh, em, title] = m;
    const pad = (n) => n.padStart(2, '0');
    events.push({
      id: store.newId(),
      title: title.trim(),
      start: `${pad(sh)}:${sm}`,
      end: `${pad(eh)}:${em}`,
    });
  }
  return { events };
}

const calendarMonthCache = new Map();
const CALENDAR_MONTH_CACHE_MS = 60 * 1000;

function getCalendarMonth(monthStr) {
  const now = new Date();
  const fallbackMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const month = /^\d{4}-(?:0[1-9]|1[0-2])$/.test(monthStr || '') ? monthStr : fallbackMonth;
  const cached = calendarMonthCache.get(month);
  if (cached && Date.now() - cached.loadedAt < CALENDAR_MONTH_CACHE_MS) return cached.value;

  const result = spawnSync(process.execPath, [CAL_READ_RANGE, month], { encoding: 'utf8', timeout: 45000 });
  if (result.status !== 0) {
    log(`calendar month read failed for ${month}: ${(result.stderr || '').slice(0, 200)}`);
    return { month, events: [] };
  }
  try {
    const parsed = JSON.parse(result.stdout || '{}');
    const value = {
      month,
      events: Array.isArray(parsed.events) ? parsed.events.map((event) => ({
        id: String(event.id || store.newId()),
        date: String(event.date || ''),
        title: String(event.title || '').trim(),
        start: String(event.start || '00:00').padStart(5, '0'),
        end: String(event.end || '23:59').padStart(5, '0'),
        allDay: event.allDay === true,
      })).filter((event) => /^\d{4}-\d{2}-\d{2}$/.test(event.date)) : [],
    };
    calendarMonthCache.set(month, { loadedAt: Date.now(), value });
    return value;
  } catch (error) {
    log(`calendar month parse failed for ${month}: ${error.message}`);
    return { month, events: [] };
  }
}

// ── Router ───────────────────────────────────────────────────────────────

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const segments = url.pathname.split('/').filter(Boolean);

  if (segments[0] !== 'api') return sendJson(res, 404, { error: 'not found' });

  const [, resource, a, b, c, d] = segments;

  // "/history" and "/history/:year/:month" branches below sit alongside each
  // resource's normal GET/POST/PATCH routes — 'history' can never collide
  // with a real item id (tasks/grocery ids are random hex; goal ids are
  // slugified habit labels).
  function parseYearMonth(year, month) {
    const y = Number(year);
    const m = Number(month);
    if (!Number.isInteger(y) || !Number.isInteger(m) || m < 1 || m > 12) return null;
    return { y, m };
  }

  try {
    // ── /api/goals, /api/goals/:id, /api/goals/history[/:year/:month] ──
    if (resource === 'goals') {
      if (!a && req.method === 'GET') return sendJson(res, 200, getGoals());
      if (a === 'history' && !b && req.method === 'GET') return sendJson(res, 200, getGoalsHistoryBuckets());
      if (a === 'history' && b && c && req.method === 'GET') {
        const ym = parseYearMonth(b, c);
        return ym ? sendJson(res, 200, getGoalsHistoryMonth(ym.y, ym.m)) : sendJson(res, 400, { error: 'invalid year/month' });
      }
      if (a && a !== 'history' && req.method === 'PATCH') {
        const body = await readBody(req);
        const result = patchGoal(a, !!body.done);
        return result ? sendJson(res, 200, {}) : sendJson(res, 404, { error: `unknown goal id '${a}'` });
      }
      return sendJson(res, 405, { error: 'method not allowed' });
    }

    // ── /api/tasks/:board, /api/tasks/:board/:id, /api/tasks/:board/history[/:year/:month] ──
    if (resource === 'tasks') {
      if (!a || !BOARDS.includes(a)) return sendJson(res, 404, { error: `unknown board '${a || ''}'` });
      const file = boardFile(a);
      if (!b && req.method === 'GET') return sendJson(res, 200, listItems(file));
      if (!b && req.method === 'POST') {
        const body = await readBody(req);
        const item = addItem(file, body.text);
        return item ? sendJson(res, 201, item) : sendJson(res, 400, { error: 'text is required' });
      }
      if (b === 'history' && !c && req.method === 'GET') return sendJson(res, 200, getItemHistoryBuckets(file));
      if (b === 'history' && c && d && req.method === 'GET') {
        const ym = parseYearMonth(c, d);
        return ym ? sendJson(res, 200, getItemHistoryMonth(file, ym.y, ym.m)) : sendJson(res, 400, { error: 'invalid year/month' });
      }
      if (b && b !== 'history' && req.method === 'PATCH') {
        const body = await readBody(req);
        const item = patchItem(file, b, !!body.done);
        return item ? sendJson(res, 200, item) : sendJson(res, 404, { error: `unknown task id '${b}'` });
      }
      if (b && b !== 'history' && req.method === 'DELETE') {
        const item = removeItem(file, b);
        return item ? sendJson(res, 200, { ok: true, removed: item }) : sendJson(res, 404, { error: `unknown task id '${b}'` });
      }
      return sendJson(res, 405, { error: 'method not allowed' });
    }

    // ── /api/grocery, /api/grocery/:id, /api/grocery/history[/:year/:month] ──
    if (resource === 'grocery') {
      if (!a && req.method === 'GET') return sendJson(res, 200, listItems(GROCERY_FILE));
      if (!a && req.method === 'POST') {
        const body = await readBody(req);
        const item = addItem(GROCERY_FILE, body.text);
        return item ? sendJson(res, 201, item) : sendJson(res, 400, { error: 'text is required' });
      }
      if (a === 'history' && !b && req.method === 'GET') return sendJson(res, 200, getItemHistoryBuckets(GROCERY_FILE));
      if (a === 'history' && b && c && req.method === 'GET') {
        const ym = parseYearMonth(b, c);
        return ym ? sendJson(res, 200, getItemHistoryMonth(GROCERY_FILE, ym.y, ym.m)) : sendJson(res, 400, { error: 'invalid year/month' });
      }
      if (a && a !== 'history' && req.method === 'PATCH') {
        const body = await readBody(req);
        const item = patchItem(GROCERY_FILE, a, !!body.done);
        return item ? sendJson(res, 200, item) : sendJson(res, 404, { error: `unknown grocery id '${a}'` });
      }
      return sendJson(res, 405, { error: 'method not allowed' });
    }

    // ── /api/health (GET: dashboard read. PATCH: internal-only, health-tracker writes) ──
    if (resource === 'health') {
      if (!a && req.method === 'GET') return sendJson(res, 200, getHealth());
      if (!a && req.method === 'PATCH') {
        const body = await readBody(req);
        return sendJson(res, 200, patchHealthState(body));
      }
      return sendJson(res, 405, { error: 'method not allowed' });
    }

    // ── /api/financials (read), /api/financials/review/:id (confirm) ──
    if (resource === 'financials') {
      if (!a && req.method === 'GET') return sendJson(res, 200, getFinancials());
      if (a === 'review' && b && req.method === 'PATCH') {
        if (!/^\d+$/.test(b)) return sendJson(res, 400, { error: 'invalid transaction id' });
        const ok = markReviewed(Number(b));
        return ok ? sendJson(res, 200, { ok: true }) : sendJson(res, 404, { error: `no pending transaction with id '${b}'` });
      }
      return sendJson(res, 405, { error: 'method not allowed' });
    }

    // ── /api/calendar?date=YYYY-MM-DD or ?month=YYYY-MM (read-only) ──
    if (resource === 'calendar') {
      if (!a && req.method === 'GET') {
        const month = url.searchParams.get('month');
        return sendJson(res, 200, month ? getCalendarMonth(month) : getCalendar(url.searchParams.get('date')));
      }
      return sendJson(res, 405, { error: 'method not allowed' });
    }

    return sendJson(res, 404, { error: 'not found' });
  } catch (e) {
    log(`error handling ${req.method} ${url.pathname}: ${e.stack || e.message}`);
    return sendJson(res, e instanceof SyntaxError ? 400 : 500, { error: e instanceof SyntaxError ? 'invalid JSON body' : 'internal error' });
  }
}

// ── Server ───────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  // Permissive CORS: this is a bearer-token-gated, LAN-only service (see the
  // README's "Auth: shared LAN token" reasoning) — the token, not CORS, is
  // the trust boundary, so this just avoids foot-guns if the dashboard's
  // static files end up served from a different origin/port than this API.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const { pathname } = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // Static dashboard-web assets are unauthenticated on purpose: the WebView's
  // very first request (loading index.html) has no way to carry the bearer
  // token yet — app.js is what attaches it to later fetch() calls, and it
  // can't run before it's loaded. The token protects the data behind
  // /api/*; the page shell itself isn't sensitive, and this is already a
  // LAN-only trust model per the README.
  if (req.method === 'GET' && Object.prototype.hasOwnProperty.call(STATIC_FILES, pathname)) {
    serveStatic(res, pathname);
    return;
  }

  const auth = req.headers.authorization || '';
  const provided = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (provided !== TOKEN) { sendJson(res, 401, { error: 'unauthorized' }); return; }

  handle(req, res);
});

server.listen(PORT, HOST, () => {
  log(`listening on http://${HOST}:${PORT}`);
});
