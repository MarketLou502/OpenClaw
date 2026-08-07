#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'configure-plaid-webhook-'));
const credentials = path.join(temporary, 'credentials.json');
const access = path.join(temporary, 'access.json');
fs.writeFileSync(credentials, JSON.stringify({ client_id: 'client', secret: 'secret' }));
fs.writeFileSync(access, JSON.stringify({ items: [{ item_id: 'item-1', access_token: 'access', institution_name: 'Bank' }] }));
process.env.PLAID_CREDENTIALS_FILE = credentials;
process.env.PLAID_ACCESS_FILE = access;
process.env.PLAID_API_BASE = 'https://mock.plaid.test';

global.fetch = async (url, options) => {
  assert.equal(url, 'https://mock.plaid.test/item/webhook/update');
  const body = JSON.parse(options.body);
  assert.equal(body.access_token, 'access');
  assert.equal(body.webhook, 'https://hooks.example.com/plaid/webhook');
  return { ok: true, async json() { return { item: { item_id: 'item-1', institution_name: 'Bank', webhook: body.webhook } }; } };
};

const { run, validateWebhookUrl } = require('./configure_plaid_webhook.js');

(async () => {
  assert.throws(() => validateWebhookUrl('http://hooks.example.com/plaid/webhook'), /HTTPS/);
  assert.throws(() => validateWebhookUrl('https://hooks.example.com/wrong'), /end with/);
  const result = await run('https://hooks.example.com/plaid/webhook');
  assert.equal(result.configured.length, 1);
  process.stdout.write('Plaid webhook configuration test passed\n');
})().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
