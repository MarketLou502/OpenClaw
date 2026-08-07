#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const SCRIPT = path.join(__dirname, 'plaid_hosted_link.js');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'plaid-hosted-link-'));
const credentials = path.join(temp, 'credentials.json');
const state = path.join(temp, 'state.json');
const access = path.join(temp, 'access.json');
const user = path.join(temp, 'user.json');
fs.writeFileSync(credentials, JSON.stringify({ client_id: 'client-secret-value', secret: 'production-secret-value', environment: 'production' }), { mode: 0o600 });

const requests = [];
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    requests.push({ url: req.url, headers: req.headers, body: JSON.parse(raw || '{}') });
    let body;
    if (req.url === '/user/create') {
      body = { user_id: 'user-private' };
    } else if (req.url === '/link/token/create') {
      body = { link_token: 'link-production-private', hosted_link_url: 'https://secure.plaid.test/session', expiration: '2099-01-01T00:00:00Z' };
    } else if (req.url === '/link/token/get') {
      body = { results: { item_add_results: [
        { public_token: 'public-production-capital-one', institution: { institution_id: 'ins_128026', name: 'Capital One' } },
        { public_token: 'public-production-venmo', institution: { institution_id: 'ins_132083', name: 'Venmo' } },
      ] } };
    } else if (req.url === '/item/public_token/exchange') {
      const suffix = requests.at(-1).body.public_token.endsWith('venmo') ? 'venmo' : 'capital-one';
      body = { access_token: `access-production-${suffix}`, item_id: `item-${suffix}` };
    } else if (req.url === '/accounts/balance/get') {
      const venmo = requests.at(-1).body.access_token.endsWith('venmo');
      body = { accounts: [{
        account_id: venmo ? 'acct-venmo' : 'acct-capital-one',
        name: venmo ? 'Venmo Balance' : '360 Checking',
        mask: venmo ? null : '3102',
        type: 'depository', subtype: 'checking',
        balances: { available: venmo ? 15 : -19.94, current: venmo ? 15 : 20, iso_currency_code: 'USD' },
      }] };
    } else {
      res.writeHead(404); res.end('{}'); return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });
});

function run(command, port) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, command], {
    env: {
      ...process.env,
      PLAID_API_BASE: `http://127.0.0.1:${port}`,
      PLAID_CREDENTIALS_FILE: credentials,
      PLAID_LINK_STATE_FILE: state,
      PLAID_ACCESS_FILE: access,
      PLAID_USER_FILE: user,
    },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port;
  try {
    const created = await run('create', port);
    assert.equal(created.status, 0, created.stderr);
    assert.match(created.stdout, /secure\.plaid\.test/);
    assert.equal(fs.statSync(state).mode & 0o777, 0o600);
    assert.equal(fs.statSync(user).mode & 0o777, 0o600);
    assert(!created.stdout.includes('client-secret-value'));
    assert(!created.stdout.includes('production-secret-value'));
    assert(!created.stdout.includes('link-production-private'));

    const finalized = await run('finalize', port);
    assert.equal(finalized.status, 0, finalized.stderr);
    assert.match(finalized.stdout, /360 Checking/);
    assert.match(finalized.stdout, /Venmo Balance/);
    assert.match(finalized.stdout, /-19\.94/);
    assert(!finalized.stdout.includes('access-production-capital-one'));
    assert(!finalized.stdout.includes('public-production-capital-one'));
    assert.equal(fs.statSync(access).mode & 0o777, 0o600);

    const saved = JSON.parse(fs.readFileSync(access, 'utf8'));
    assert.equal(saved.items.length, 2);
    assert.equal(saved.items[0].accounts[0].mask, '3102');
    assert.deepEqual(requests.map((request) => request.url), [
      '/user/create',
      '/link/token/create',
      '/link/token/get',
      '/item/public_token/exchange',
      '/accounts/balance/get',
      '/item/public_token/exchange',
      '/accounts/balance/get',
    ]);
    assert.equal(requests[1].body.products[0], 'transactions');
    assert.equal(requests[1].body.enable_multi_item_link, true);
    assert.equal(requests[1].body.user_id, 'user-private');
    assert.equal(requests[0].headers['plaid-client-id'], 'client-secret-value');
    process.stdout.write('Plaid Hosted Link test passed\n');
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  } finally {
    server.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
