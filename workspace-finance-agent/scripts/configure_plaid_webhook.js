#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const WORKSPACE = path.resolve(__dirname, '..');
const API_BASE = (process.env.PLAID_API_BASE || 'https://production.plaid.com').replace(/\/$/, '');
const CREDENTIALS_FILE = process.env.PLAID_CREDENTIALS_FILE || path.join(WORKSPACE, 'memory/.plaid_credentials.json');
const ACCESS_FILE = process.env.PLAID_ACCESS_FILE || path.join(WORKSPACE, 'memory/.plaid_access.json');

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

function validateWebhookUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.pathname !== '/plaid/webhook') {
    throw new Error('Webhook URL must use HTTPS and end with /plaid/webhook');
  }
  return url.toString();
}

async function plaidPost(endpoint, body, credentials) {
  const response = await fetch(`${API_BASE}${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'PLAID-CLIENT-ID': credentials.client_id,
      'PLAID-SECRET': credentials.secret,
      'Plaid-Version': '2020-09-14',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error_message || `Plaid returned HTTP ${response.status}`);
  return value;
}

async function run(webhookArg) {
  const webhook = validateWebhookUrl(webhookArg);
  const credentials = readJson(CREDENTIALS_FILE);
  const access = readJson(ACCESS_FILE);
  const items = Array.isArray(access.items) ? access.items : (access.access_token ? [access] : []);
  if (!items.length) throw new Error('No Plaid Items are stored');
  const configured = [];
  for (const item of items) {
    const result = await plaidPost('/item/webhook/update', { access_token: item.access_token, webhook }, credentials);
    configured.push({
      item_id: result.item?.item_id || item.item_id,
      institution_name: result.item?.institution_name || item.institution_name || null,
      webhook: result.item?.webhook || webhook,
    });
  }
  const output = { ok: true, configured };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  return output;
}

if (require.main === module) {
  run(process.argv[2]).catch((error) => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
    process.exitCode = 1;
  });
}

module.exports = { run, validateWebhookUrl };
