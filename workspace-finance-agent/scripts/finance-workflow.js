#!/usr/bin/env node
'use strict';

// Deterministic financials mutation workflow for the finance-agent.
//
// This program deliberately does not classify natural language and does not
// send messages. The agent chooses a structured operation, this program calls
// dashboard-api (the single writer), and Main delivers the agent's returned
// result through the originating channel. Mirrors
// workspace-main/scripts/dashboard-workflow.js's pattern for other widgets.
//
// Read-only queries the agent makes directly (spent today, upcoming
// transactions, pending review) still bypass this script — TOOLS.md
// documents querying finance.db directly with sqlite3 for those, since
// dashboard-api has no dedicated read endpoint beyond the full
// /api/financials payload. The two read commands below (balance,
// budget-forecast) are the exception: they exist for the voice router,
// which needs a single script invocation returning one spoken `reply`
// string, so they call GET /api/financials (reusing apiCall(), the same
// authenticated client the mutation commands use) rather than duplicating
// dashboard-api's balance/forecast math in a second place.

const fs = require('fs');
const http = require('http');

const API_BASE = process.env.OPENCLAW_DASHBOARD_API_BASE || 'http://127.0.0.1:18795';
const TOKEN_FILE = process.env.OPENCLAW_DASHBOARD_TOKEN_FILE ||
  '/Users/aaronmacmini/.openclaw/service-env/dashboard-api.token';

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

function requireId(value, label) {
  if (!/^\d+$/.test(String(value || ''))) {
    throw new WorkflowError('INVALID_ARGUMENT', `${label} must be a positive integer`);
  }
  return Number(value);
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

async function reviewTransaction(idValue) {
  const id = requireId(idValue, '--id');
  await apiCall('PATCH', `/api/financials/review/${id}`);
  return { ok: true, action: 'review', id, reply: `✅ Marked transaction ${id} reviewed` };
}

async function addExpense(options) {
  const name = requireText(options.name, '--name');
  const amount = Number(options.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new WorkflowError('INVALID_ARGUMENT', '--amount must be a positive number');
  }
  const dueDay = requireId(options['due-day'], '--due-day');
  if (dueDay < 1 || dueDay > 31) {
    throw new WorkflowError('INVALID_ARGUMENT', '--due-day must be between 1 and 31');
  }
  const expense = await apiCall('POST', '/api/financials/expenses', {
    name,
    amount_est: amount,
    due_day: dueDay,
    notes: options.notes || '',
  });
  return {
    ok: true,
    action: 'add-expense',
    expense,
    reply: `✅ Added recurring expense '${name}' — $${amount.toFixed(2)} due day ${dueDay}`,
  };
}

async function removeExpense(idValue) {
  const id = requireId(idValue, '--id');
  await apiCall('DELETE', `/api/financials/expenses/${id}`);
  return { ok: true, action: 'remove-expense', id, reply: `✅ Removed expense ${id}` };
}

async function getBalance() {
  const financials = await apiCall('GET', '/api/financials');
  const budget = financials.budget || {};
  if (!budget.accounts || !budget.accounts.length) {
    return { ok: true, action: 'balance', reply: "I don't have a balance on file yet — the next Plaid sync hasn't run." };
  }
  const parts = budget.accounts.map((a) => `${a.name || 'an account'}: $${a.balance.toFixed(2)}`);
  return {
    ok: true,
    action: 'balance',
    budget,
    reply: `You have $${budget.current_balance.toFixed(2)} total — ${parts.join(', ')}.`,
  };
}

async function getBudgetForecast() {
  const financials = await apiCall('GET', '/api/financials');
  const budget = financials.budget || {};
  if (!budget.accounts || !budget.accounts.length) {
    return { ok: true, action: 'budget-forecast', reply: "I don't have balance data yet, so I can't forecast — the next Plaid sync hasn't run." };
  }
  const reply = budget.warning
    ? `Yes — you're projected to dip to $${budget.projected_min_balance.toFixed(2)} around ${budget.projected_min_date}${budget.projected_min_cause ? `, when ${budget.projected_min_cause} is due` : ''}. ${budget.note}`
    : `You should be fine — lowest projected balance is $${budget.projected_min_balance.toFixed(2)} around ${budget.projected_min_date}. ${budget.note}`;
  return { ok: true, action: 'budget-forecast', budget, reply };
}

function help() {
  return [
    'Usage: finance-workflow.js <command> [options]',
    '',
    'Commands:',
    '  review --id <transactionId>',
    '  add-expense --name "Rent" --amount 1500 --due-day 1 [--notes "..."]',
    '  remove-expense --id <expenseId>',
    '  balance',
    '  budget-forecast',
  ].join('\n');
}

async function run() {
  const { command, options } = parseArgs(process.argv.slice(2));
  switch (command) {
    case 'review': return reviewTransaction(options.id);
    case 'add-expense': return addExpense(options);
    case 'remove-expense': return removeExpense(options.id);
    case 'balance': return getBalance();
    case 'budget-forecast': return getBudgetForecast();
    case 'help':
    case '--help':
    case undefined:
      process.stdout.write(`${help()}\n`);
      return { ok: true, action: 'help' };
    default:
      throw new WorkflowError('UNKNOWN_COMMAND', `Unknown command '${command}'`, { help: help() });
  }
}

run()
  .then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exit(result.ok === false ? 1 : 0);
  })
  .catch((error) => {
    const payload = {
      ok: false,
      error: {
        code: error.code || 'UNKNOWN_ERROR',
        message: error.message || String(error),
        details: error.details,
      },
    };
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    process.exit(1);
  });
