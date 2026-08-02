#!/usr/bin/env node
'use strict';

// Deterministic task/grocery/habit workflow for the main OpenClaw agent.
//
// This program deliberately does not classify natural language and does not
// send messages. The agent chooses a structured operation, this program calls
// dashboard-api (the single writer), and the Gateway delivers the agent's
// resulting reply through the originating channel.

const fs = require('fs');
const http = require('http');
const path = require('path');

const API_BASE = process.env.OPENCLAW_DASHBOARD_API_BASE || 'http://127.0.0.1:18795';
const TOKEN_FILE = process.env.OPENCLAW_DASHBOARD_TOKEN_FILE ||
  '/Users/aaronmacmini/.openclaw/service-env/dashboard-api.token';
const HABIT_LOG_DIR = process.env.OPENCLAW_DAILY_LOG_DIR ||
  '/Users/aaronmacmini/.openclaw/workspace-daily-tracker/memory';

const BOARDS = {
  work: { label: 'Work', apiPath: '/api/tasks/work' },
  'market-lou': { label: 'Market Lou', apiPath: '/api/tasks/market-lou' },
  personal: { label: 'Personal', apiPath: '/api/tasks/personal' },
  grocery: { label: 'Grocery', apiPath: '/api/grocery' },
};

const TASK_BOARD_ORDER = ['work', 'market-lou', 'personal'];
const SEARCH_BOARD_ORDER = [...TASK_BOARD_ORDER, 'grocery'];

class WorkflowError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'WorkflowError';
    this.code = code;
    this.details = details;
  }
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token.startsWith('--')) {
      throw new WorkflowError('INVALID_ARGUMENT', `Unexpected argument '${token}'`);
    }
    const key = token.slice(2);
    const value = rest[i + 1];
    if (!value || value.startsWith('--')) {
      throw new WorkflowError('INVALID_ARGUMENT', `Missing value for --${key}`);
    }
    options[key] = value;
    i += 1;
  }
  return { command, options };
}

function requireText(value, label) {
  const text = String(value || '').trim();
  if (!text) throw new WorkflowError('INVALID_ARGUMENT', `${label} is required`);
  return text;
}

function normalizeBoard(value, fallback = null) {
  const raw = String(value || fallback || '').trim().toLowerCase();
  const compact = raw.replace(/[_\s]+/g, '-');
  if (compact === 'market' || compact === 'marketlou') return 'market-lou';
  if (compact === 'groceries') return 'grocery';
  if (compact === 'acc' || compact === 'accenture') return 'work';
  if (BOARDS[compact]) return compact;
  throw new WorkflowError(
    'INVALID_BOARD',
    `Unknown board '${value || ''}'`,
    { allowed: Object.keys(BOARDS) },
  );
}

function readToken() {
  try {
    const token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (!token) throw new Error('token file is empty');
    return token;
  } catch (error) {
    throw new WorkflowError('AUTH_CONFIG', `Cannot read dashboard API token: ${error.message}`);
  }
}

function apiCall(method, pathname, body = undefined) {
  const target = new URL(pathname, API_BASE);
  const payload = body === undefined ? null : JSON.stringify(body);
  const headers = {
    Authorization: `Bearer ${readToken()}`,
    Accept: 'application/json',
  };
  if (payload !== null) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = Buffer.byteLength(payload);
  }

  return new Promise((resolve, reject) => {
    const req = http.request(target, { method, headers, timeout: 10_000 }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        raw += chunk;
        if (raw.length > 1_000_000) req.destroy(new Error('response exceeded 1 MB'));
      });
      res.on('end', () => {
        let parsed = {};
        if (raw.trim()) {
          try { parsed = JSON.parse(raw); }
          catch {
            reject(new WorkflowError('BACKEND_RESPONSE', 'Dashboard API returned invalid JSON'));
            return;
          }
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new WorkflowError(
            'BACKEND_HTTP',
            parsed.error || `Dashboard API returned HTTP ${res.statusCode}`,
            { status: res.statusCode },
          ));
          return;
        }
        resolve(parsed);
      });
    });
    req.on('timeout', () => req.destroy(new Error('request timed out')));
    req.on('error', (error) => {
      reject(error instanceof WorkflowError
        ? error
        : new WorkflowError('BACKEND_UNREACHABLE', `Dashboard API unavailable: ${error.message}`));
    });
    if (payload !== null) req.write(payload);
    req.end();
  });
}

function openItems(data) {
  const items = Array.isArray(data && data.items) ? data.items : [];
  return items.filter((item) => !item.done);
}

function formatBoard(board, items) {
  const label = BOARDS[board].label;
  if (items.length === 0) return `📋 ${label}: all done! ✅`;
  return `📋 ${label}:\n${items.map((item) => `• ${item.text}`).join('\n')}`;
}

async function listBoard(boardValue) {
  if (String(boardValue || '').toLowerCase() === 'all') {
    const results = await Promise.all(TASK_BOARD_ORDER.map(async (board) => {
      const data = await apiCall('GET', BOARDS[board].apiPath);
      return { board, items: openItems(data) };
    }));
    return {
      ok: true,
      action: 'list',
      board: 'all',
      boards: results,
      reply: results.map(({ board, items }) => formatBoard(board, items)).join('\n\n'),
    };
  }

  const board = normalizeBoard(boardValue);
  const data = await apiCall('GET', BOARDS[board].apiPath);
  const items = openItems(data);
  return { ok: true, action: 'list', board, items, reply: formatBoard(board, items) };
}

async function addItem(boardValue, textValue) {
  const board = normalizeBoard(boardValue, 'personal');
  const text = requireText(textValue, 'Task text');
  const item = await apiCall('POST', BOARDS[board].apiPath, { text });
  return {
    ok: true,
    action: 'add',
    board,
    item,
    reply: `✅ Added '${text}' to ${BOARDS[board].label}`,
  };
}

function chooseUniqueMatch(candidates, query, noun) {
  const needle = query.toLocaleLowerCase();
  const exact = candidates.filter((candidate) => candidate.text.toLocaleLowerCase() === needle);
  const matches = exact.length ? exact : candidates.filter(
    (candidate) => candidate.text.toLocaleLowerCase().includes(needle),
  );

  if (matches.length === 0) {
    throw new WorkflowError('NOT_FOUND', `No open ${noun} found matching '${query}'`);
  }
  if (matches.length > 1) {
    throw new WorkflowError(
      'AMBIGUOUS_MATCH',
      `More than one open ${noun} matches '${query}'`,
      { matches: matches.map(({ board, id, text }) => ({ board, id, text })) },
    );
  }
  return matches[0];
}

async function completeItem(queryValue, boardValue = null) {
  const query = requireText(queryValue, 'Task query');
  const boards = boardValue ? [normalizeBoard(boardValue)] : SEARCH_BOARD_ORDER;
  const loaded = await Promise.all(boards.map(async (board) => {
    const data = await apiCall('GET', BOARDS[board].apiPath);
    return openItems(data).map((item) => ({ ...item, board }));
  }));
  const match = chooseUniqueMatch(loaded.flat(), query, 'task or grocery item');
  const item = await apiCall('PATCH', `${BOARDS[match.board].apiPath}/${encodeURIComponent(match.id)}`, { done: true });
  return {
    ok: true,
    action: 'complete',
    board: match.board,
    item,
    reply: `✅ Marked '${match.text}' done`,
  };
}

async function removeItem(queryValue, boardValue = null) {
  const query = requireText(queryValue, 'Task query');
  const boards = boardValue ? [normalizeBoard(boardValue)] : TASK_BOARD_ORDER;
  const loaded = await Promise.all(boards.map(async (board) => {
    const data = await apiCall('GET', BOARDS[board].apiPath);
    const items = Array.isArray(data && data.items) ? data.items : [];
    return items.map((item) => ({ ...item, board }));
  }));
  const match = chooseUniqueMatch(loaded.flat(), query, 'task');
  await apiCall('DELETE', `${BOARDS[match.board].apiPath}/${encodeURIComponent(match.id)}`);
  return {
    ok: true,
    action: 'remove',
    board: match.board,
    removed: { id: match.id, text: match.text },
    reply: `🗑️ Removed '${match.text}' from ${match.board}`,
  };
}

// Machine-readable board list for other services (e.g. the Home Assistant
// voice adapter) that need to build a tool-call enum from the real board
// set instead of hand-copying it, so a board rename here can't leave a
// stale enum somewhere else.
function listBoards() {
  const boards = Object.keys(BOARDS).map((key) => ({ key, label: BOARDS[key].label }));
  return { ok: true, action: 'list-boards', boards };
}

async function listHabits() {
  const data = await apiCall('GET', '/api/goals');
  const habits = Array.isArray(data && data.goals) ? data.goals : [];
  const open = habits.filter((habit) => !habit.done);
  const reply = habits.length === 0
    ? 'No daily habits are configured.'
    : `🎯 Daily habits:\n${habits.map((habit) => `${habit.done ? '✅' : '⬜'} ${habit.label}`).join('\n')}`;
  return { ok: true, action: 'list-habits', habits, openCount: open.length, reply };
}

function todayInNewYork() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function timeInNewYork() {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date());
}

function appendHabitNarrative(label) {
  const date = todayInNewYork();
  const logFile = path.join(HABIT_LOG_DIR, `${date}.md`);
  try {
    fs.mkdirSync(HABIT_LOG_DIR, { recursive: true });
    if (!fs.existsSync(logFile)) fs.writeFileSync(logFile, `# ${date} — Daily Log\n\n`, 'utf8');
    fs.appendFileSync(logFile, `${timeInNewYork()} — ✅ Habit done: ${label}\n`, 'utf8');
    return null;
  } catch (error) {
    return `Habit was updated, but the narrative log could not be written: ${error.message}`;
  }
}

async function completeHabit(queryValue) {
  const query = requireText(queryValue, 'Habit query');
  const data = await apiCall('GET', '/api/goals');
  const habits = (Array.isArray(data && data.goals) ? data.goals : [])
    .filter((habit) => !habit.done)
    .map((habit) => ({ ...habit, text: habit.label, board: 'goals' }));
  const match = chooseUniqueMatch(habits, query, 'daily habit');
  await apiCall('PATCH', `/api/goals/${encodeURIComponent(match.id)}`, { done: true });
  const warning = appendHabitNarrative(match.label);
  return {
    ok: true,
    action: 'complete-habit',
    habit: { id: match.id, label: match.label, done: true },
    warning,
    reply: `✅ ${match.label} — done for today! 🎯${warning ? `\n⚠️ ${warning}` : ''}`,
  };
}

// Cross-category completion: "I just did X" could mean a daily habit or a
// task, and the same/similar name can exist in both places at once (this
// happened for real — a "Golf" task and a "Golf" habit coexisted, and the
// wrong one kept getting marked done). This resolves that deterministically
// instead of relying on a caller's judgment: search habits and task boards
// together, and only act when exactly one open item matches.
async function completeAny(queryValue) {
  const query = requireText(queryValue, 'Query');
  const [habitsData, ...boardData] = await Promise.all([
    apiCall('GET', '/api/goals'),
    ...TASK_BOARD_ORDER.map((board) => apiCall('GET', BOARDS[board].apiPath)),
  ]);
  const habits = (Array.isArray(habitsData && habitsData.goals) ? habitsData.goals : [])
    .filter((habit) => !habit.done)
    .map((habit) => ({ kind: 'habit', id: habit.id, text: habit.label, board: 'habit' }));
  const tasks = TASK_BOARD_ORDER.flatMap((board, i) => openItems(boardData[i])
    .map((item) => ({ kind: 'task', board, id: item.id, text: item.text })));
  const match = chooseUniqueMatch([...habits, ...tasks], query, 'habit or task');

  if (match.kind === 'habit') {
    await apiCall('PATCH', `/api/goals/${encodeURIComponent(match.id)}`, { done: true });
    const warning = appendHabitNarrative(match.text);
    return {
      ok: true,
      action: 'complete-any',
      kind: 'habit',
      habit: { id: match.id, label: match.text, done: true },
      warning,
      reply: `✅ ${match.text} — done for today! 🎯${warning ? `\n⚠️ ${warning}` : ''}`,
    };
  }
  const item = await apiCall('PATCH', `${BOARDS[match.board].apiPath}/${encodeURIComponent(match.id)}`, { done: true });
  return {
    ok: true,
    action: 'complete-any',
    kind: 'task',
    board: match.board,
    item,
    reply: `✅ Marked '${match.text}' done`,
  };
}

async function loadGoalLists() {
  const data = await apiCall('GET', '/api/lists');
  return Array.isArray(data && data.lists) ? data.lists : [];
}

async function resolveGoalList(queryValue) {
  const query = requireText(queryValue, 'List query');
  const lists = (await loadGoalLists()).map((list) => ({ ...list, text: list.name, board: 'goal-lists' }));
  return chooseUniqueMatch(lists, query, 'goal list');
}

function resolveGoalListItem(list, queryValue) {
  const query = requireText(queryValue, 'Item query');
  return chooseUniqueMatch((list.items || []).map((item) => ({ ...item, board: list.id })), query, 'goal-list item');
}

async function listGoalLists() {
  const lists = await loadGoalLists();
  return { ok: true, action: 'list-lists', lists,
    reply: lists.length ? `🗂 Lists:\n${lists.map((list) => `• ${list.name} (${list.items.length})`).join('\n')}` : 'No lists are configured.' };
}

async function showGoalList(queryValue) {
  const list = await resolveGoalList(queryValue);
  const open = (list.items || []).filter((item) => !item.done);
  return { ok: true, action: 'show-list', list, items: open,
    reply: open.length ? `🗂 ${list.name}:\n${open.map((item) => `• ${item.text}`).join('\n')}` : `🗂 ${list.name}: empty.` };
}

async function createGoalList(nameValue) {
  const name = requireText(nameValue, 'List name');
  const list = await apiCall('POST', '/api/lists', { name });
  return { ok: true, action: 'create-list', list, reply: `✅ Created list '${list.name}'` };
}

async function renameGoalList(queryValue, nameValue) {
  const list = await resolveGoalList(queryValue);
  const name = requireText(nameValue, 'New list name');
  const updated = await apiCall('PATCH', `/api/lists/${encodeURIComponent(list.id)}`, { name });
  return { ok: true, action: 'rename-list', list: updated, reply: `✅ Renamed '${list.name}' to '${updated.name}'` };
}

async function deleteGoalList(queryValue) {
  const list = await resolveGoalList(queryValue);
  await apiCall('DELETE', `/api/lists/${encodeURIComponent(list.id)}`);
  return { ok: true, action: 'delete-list', removed: list, reply: `🗑️ Deleted list '${list.name}'` };
}

async function addGoalListItem(listValue, textValue) {
  const list = await resolveGoalList(listValue);
  const text = requireText(textValue, 'Item text');
  const item = await apiCall('POST', `/api/lists/${encodeURIComponent(list.id)}/items`, { text });
  return { ok: true, action: 'add-list-item', list: { id: list.id, name: list.name }, item,
    reply: `✅ Added '${text}' to ${list.name}` };
}

async function patchGoalListItem(listValue, itemValue, patch, action) {
  const list = await resolveGoalList(listValue);
  const item = resolveGoalListItem(list, itemValue);
  const updated = await apiCall('PATCH', `/api/lists/${encodeURIComponent(list.id)}/items/${encodeURIComponent(item.id)}`, patch);
  const replies = {
    'edit-goal-list-item': `✅ Changed '${item.text}' to '${updated.text}' in ${list.name}`,
    'complete-goal-list-item': `✅ Marked '${item.text}' done in ${list.name}`,
  };
  return { ok: true, action, list: { id: list.id, name: list.name }, item: updated, reply: replies[action] };
}

async function removeGoalListItem(listValue, itemValue) {
  const list = await resolveGoalList(listValue);
  const item = resolveGoalListItem(list, itemValue);
  await apiCall('DELETE', `/api/lists/${encodeURIComponent(list.id)}/items/${encodeURIComponent(item.id)}`);
  return { ok: true, action: 'remove-list-item', list: { id: list.id, name: list.name }, removed: item,
    reply: `🗑️ Removed '${item.text}' from ${list.name}` };
}

function help() {
  return {
    ok: true,
    action: 'help',
    usage: [
      'dashboard-workflow.js list-boards',
      'dashboard-workflow.js list --board work|market-lou|personal|grocery|all',
      'dashboard-workflow.js add [--board personal] --text "task"',
      'dashboard-workflow.js complete [--board board] --query "task fragment"',
      'dashboard-workflow.js remove [--board board] --query "task fragment"',
      'dashboard-workflow.js list-habits',
      'dashboard-workflow.js complete-habit --query "habit name"',
      'dashboard-workflow.js complete-any --query "habit or task name" (searches both, asks if ambiguous)',
      'dashboard-workflow.js list-lists',
      'dashboard-workflow.js show-list --list "list name"',
      'dashboard-workflow.js create-list --name "list name"',
      'dashboard-workflow.js rename-list --list "old name" --name "new name"',
      'dashboard-workflow.js delete-list --list "list name"',
      'dashboard-workflow.js add-list-item --list "list name" --text "item"',
      'dashboard-workflow.js edit-list-item --list "list name" --item "item query" --text "new text"',
      'dashboard-workflow.js complete-list-item --list "list name" --item "item query"',
      'dashboard-workflow.js remove-list-item --list "list name" --item "item query"',
    ],
  };
}

async function run(argv) {
  const { command, options } = parseArgs(argv);
  switch (command) {
    case 'list-boards': return listBoards();
    case 'list': return listBoard(options.board);
    case 'add': return addItem(options.board, options.text);
    case 'complete': return completeItem(options.query, options.board);
    case 'remove': return removeItem(options.query, options.board);
    case 'list-habits': return listHabits();
    case 'complete-habit': return completeHabit(options.query);
    case 'complete-any': return completeAny(options.query);
    case 'list-lists':
    case 'list-goal-lists': return listGoalLists();
    case 'show-list':
    case 'show-goal-list': return showGoalList(options.list);
    case 'create-list':
    case 'create-goal-list': return createGoalList(options.name);
    case 'rename-list':
    case 'rename-goal-list': return renameGoalList(options.list, options.name);
    case 'delete-list':
    case 'delete-goal-list': return deleteGoalList(options.list);
    case 'add-list-item':
    case 'add-goal-list-item': return addGoalListItem(options.list, options.text);
    case 'edit-list-item':
    case 'edit-goal-list-item': return patchGoalListItem(options.list, options.item, { text: requireText(options.text, 'New item text') }, 'edit-goal-list-item');
    case 'complete-list-item':
    case 'complete-goal-list-item': return patchGoalListItem(options.list, options.item, { done: true }, 'complete-goal-list-item');
    case 'remove-list-item':
    case 'remove-goal-list-item': return removeGoalListItem(options.list, options.item);
    case 'help':
    case '--help':
    case undefined: return help();
    default: throw new WorkflowError('INVALID_COMMAND', `Unknown command '${command}'`, { usage: help().usage });
  }
}

run(process.argv.slice(2))
  .then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  })
  .catch((error) => {
    const body = {
      ok: false,
      error: {
        code: error.code || 'UNEXPECTED',
        message: error.message || String(error),
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    };
    process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
    process.exitCode = 1;
  });
