#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const WORKSPACE = path.resolve(__dirname, '..');
const FIN_DB = process.env.FINANCE_DB_PATH || path.join(WORKSPACE, 'finance.db');
const CONFIG_FILE = path.join(WORKSPACE, 'memory/.len_ledger_config.json');
const CONF = fs.existsSync(CONFIG_FILE) ? JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) : {};
const ENDPOINT = process.env.LEN_LEDGER_ENDPOINT || CONF.endpoint || null;
const API_SECRET = process.env.LEN_LEDGER_SECRET || CONF.secret || null;

const BILL_ITEMS = [
  { name: 'HOA', amount: 248.63 },
  { name: 'Mortgage', amount: 1343.80 },
  { name: 'DPA Loan', amount: 105.00 },
];
const MONTHLY_BILL = BILL_ITEMS.reduce((s, i) => s + i.amount, 0);

const LEN_PATTERNS = ['Lynne', 'Roeschlaub'];

function sqlEscape(v) { return String(v).replace(/'/g, "''"); }

function runSql(sql) {
  const r = spawnSync('sqlite3', ['-json', FIN_DB, sql], { encoding: 'utf8', timeout: 10_000 });
  if (r.status !== 0) throw new Error(`sqlite3: ${(r.stderr || '').slice(0, 200)}`);
  try { return JSON.parse(r.stdout || '[]'); } catch { return []; }
}

function whereClause() {
  return LEN_PATTERNS.map(p => `t.name LIKE '%${sqlEscape(p)}%'`).join(' OR ');
}

function billEntries(date) {
  return BILL_ITEMS.map(i => ({ date, description: i.name, charge: i.amount, payment: 0, type: 'bill' }));
}

function computeLedger() {
  const rows = runSql(`
    SELECT DISTINCT t.date, t.name, t.merchant_name, t.amount, t.transaction_id,
           ab.institution_name, ab.account_name, ab.account_mask
    FROM plaid_transactions t
    JOIN account_balances ab ON t.account_id = ab.account_id
    WHERE (${whereClause()}) AND t.amount < 0
    ORDER BY t.date ASC;
  `);

  const monthMap = new Map();
  for (const row of rows) {
    const [y, m] = row.date.split('-');
    const key = `${y}-${m}`;
    if (!monthMap.has(key)) {
      monthMap.set(key, { year: Number(y), month: Number(m), label: new Date(Number(y), Number(m) - 1).toLocaleDateString('en-US', { year: 'numeric', month: 'long' }), entries: [] });
    }
    const amt = Math.abs(row.amount);
    monthMap.get(key).entries.push({
      date: row.date,
      description: (row.name || '').replace(/"/g, '').trim(),
      payment: amt, charge: 0, type: 'payment',
      account: row.institution_name ? row.institution_name.replace(/ - Personal$/, '') : null,
      mask: row.account_mask || null,
    });
  }

  const sorted = [...monthMap.keys()].sort();
  const months = [];
  let running = 0;
  for (const key of sorted) {
    const m = monthMap.get(key);
    const bd = `${m.year}-${String(m.month).padStart(2, '0')}-01`;
    const paid = m.entries.reduce((s, e) => s + e.payment, 0);
    const mb = paid - MONTHLY_BILL;
    running += mb;
    months.push({
      year: m.year, month: m.month, label: m.label, bill_date: bd,
      bill_items: BILL_ITEMS, monthly_bill: MONTHLY_BILL,
      entries: [...billEntries(bd), ...m.entries],
      total_charged: MONTHLY_BILL, total_paid: paid,
      month_balance: mb, running_balance: running,
    });
  }

  const reversed = [...months].reverse();
  const now = new Date();
  const ck = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const cmd = monthMap.has(ck) ? reversed.find(m => `${m.year}-${String(m.month).padStart(2, '0')}` === ck) : null;

  return {
    updated_at: new Date().toISOString(),
    monthly_bill: MONTHLY_BILL,
    bill_items: BILL_ITEMS,
    payer_name: 'Lynne Roeschlaub',
    months: reversed,
    current_month: cmd ? {
      label: cmd.label, bill_items: cmd.bill_items, bill_date: cmd.bill_date,
      monthly_bill: cmd.monthly_bill, total_charged: cmd.total_charged,
      total_paid: cmd.total_paid, month_balance: cmd.month_balance,
      running_balance: cmd.running_balance, entries: cmd.entries,
    } : null,
    lifetime: {
      total_charged: months.length * MONTHLY_BILL,
      total_paid: months.reduce((s, m) => s + m.total_paid, 0),
      running_balance: running, month_count: months.length,
    },
  };
}

async function upload(ledger) {
  if (!ENDPOINT) throw new Error('No endpoint configured');
  if (!API_SECRET) throw new Error('No API secret configured');
  const r = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': API_SECRET },
    body: JSON.stringify(ledger),
    signal: AbortSignal.timeout(15_000),
  });
  const b = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Upload failed (HTTP ${r.status}): ${b.error || r.statusText}`);
  return b;
}

async function run() {
  const ledger = computeLedger();
  const paid = ledger.current_month ? ledger.current_month.total_paid : 0;
  const label = ledger.current_month ? ledger.current_month.label : (ledger.months[0] ? ledger.months[0].label : 'N/A');
  console.log(`[len-ledger] ${new Date().toISOString()} ${label}: $${paid} paid, balance $${ledger.lifetime.running_balance}, uploading...`);
  const result = await upload(ledger);
  console.log(`[len-ledger] Upload OK — server updated at ${result.updated_at || '?'}`);
  return { ok: true, result };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--endpoint' && args[i + 1]) { process.env.LEN_LEDGER_ENDPOINT = args[i + 1]; i++; }
    else if (args[i] === '--secret' && args[i + 1]) { process.env.LEN_LEDGER_SECRET = args[i + 1]; i++; }
  }
  run().catch(err => { console.error(`[len-ledger] ERROR: ${err.message}`); process.exitCode = 1; });
}

module.exports = { computeLedger, upload, run };