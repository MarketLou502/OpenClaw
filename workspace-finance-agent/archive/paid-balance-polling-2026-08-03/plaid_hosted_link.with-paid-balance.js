#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const WORKSPACE = path.resolve(__dirname, '..');
const API_BASE = (process.env.PLAID_API_BASE || 'https://production.plaid.com').replace(/\/$/, '');
const CREDENTIALS_FILE = process.env.PLAID_CREDENTIALS_FILE || path.join(WORKSPACE, 'memory/.plaid_credentials.json');
const LINK_STATE_FILE = process.env.PLAID_LINK_STATE_FILE || path.join(WORKSPACE, 'memory/.plaid_link_session.json');
const ACCESS_FILE = process.env.PLAID_ACCESS_FILE || path.join(WORKSPACE, 'memory/.plaid_access.json');
const USER_FILE = process.env.PLAID_USER_FILE || path.join(WORKSPACE, 'memory/.plaid_user.json');

class PlaidError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'PlaidError';
    this.details = details;
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writePrivateJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(temporary, 'w', 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
}

function credentials() {
  const value = readJson(CREDENTIALS_FILE);
  if (!value.client_id || !value.secret || value.environment !== 'production') {
    throw new Error('Plaid Production credentials are incomplete');
  }
  return value;
}

async function plaidPost(endpoint, body) {
  const creds = credentials();
  const response = await fetch(`${API_BASE}${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'PLAID-CLIENT-ID': creds.client_id,
      'PLAID-SECRET': creds.secret,
      'Plaid-Version': '2020-09-14',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45_000),
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new PlaidError(
      value.error_message || `Plaid returned HTTP ${response.status}`,
      {
        status: response.status,
        error_type: value.error_type,
        error_code: value.error_code,
        request_id: value.request_id,
      },
    );
  }
  return value;
}

async function createHostedLink() {
  const user = await ensurePlaidUser();
  const response = await plaidPost('/link/token/create', {
    client_name: 'Jarvis Finance Dashboard',
    language: 'en',
    country_codes: ['US'],
    user_id: user.user_id,
    // Balance is not passed here. Plaid requires Balance to accompany another
    // product and documents Transactions as the companion for a PFM use case.
    products: ['transactions'],
    enable_multi_item_link: true,
    hosted_link: { url_lifetime_seconds: 1800 },
  });
  if (!response.link_token || !response.hosted_link_url) {
    throw new PlaidError('Plaid did not return a Hosted Link URL');
  }
  writePrivateJson(LINK_STATE_FILE, {
    link_token: response.link_token,
    hosted_link_url: response.hosted_link_url,
    expiration: response.expiration || null,
    created_at: new Date().toISOString(),
  });
  return {
    hosted_link_url: response.hosted_link_url,
    expiration: response.expiration || null,
  };
}

async function ensurePlaidUser() {
  if (fs.existsSync(USER_FILE)) {
    const user = readJson(USER_FILE);
    if (user.user_id) return user;
  }
  const response = await plaidPost('/user/create', {
    client_user_id: 'aaron-openclaw-finance',
  });
  if (!response.user_id) throw new PlaidError('Plaid did not return a user ID');
  const user = { user_id: response.user_id, created_at: new Date().toISOString() };
  writePrivateJson(USER_FILE, user);
  return user;
}

function findPublicTokens(value, found = []) {
  if (!value || typeof value !== 'object') return found;
  if (typeof value.public_token === 'string' && value.public_token) found.push(value.public_token);
  if (Array.isArray(value.public_tokens)) {
    found.push(...value.public_tokens.filter((entry) => typeof entry === 'string' && entry));
  }
  for (const child of Object.values(value)) {
    findPublicTokens(child, found);
  }
  return [...new Set(found)];
}

function findInstitution(value) {
  if (!value || typeof value !== 'object') return null;
  if (value.institution && typeof value.institution === 'object') {
    const institution = value.institution;
    if (institution.institution_id || institution.name) {
      return {
        institution_id: institution.institution_id || null,
        institution_name: institution.name || null,
      };
    }
  }
  for (const child of Object.values(value)) {
    const institution = findInstitution(child);
    if (institution) return institution;
  }
  return null;
}

function publicAccount(account) {
  return {
    account_id: account.account_id,
    name: account.name || null,
    official_name: account.official_name || null,
    mask: account.mask || null,
    type: account.type || null,
    subtype: account.subtype || null,
    available: account.balances?.available ?? null,
    current: account.balances?.current ?? null,
    currency: account.balances?.iso_currency_code || account.balances?.unofficial_currency_code || null,
  };
}

async function getLinkResult() {
  const state = readJson(LINK_STATE_FILE);
  if (!state.link_token) throw new Error('No Plaid Hosted Link session exists');
  const response = await plaidPost('/link/token/get', { link_token: state.link_token });
  return { state, response, publicTokens: findPublicTokens(response) };
}

function collectDiagnostics(value, pathName = '$', output = []) {
  if (!value || typeof value !== 'object') return output;
  const allowed = new Set([
    'status', 'exit_status', 'error_code', 'error_message', 'event_name',
    'view_name', 'institution_id', 'link_session_id', 'started_at', 'finished_at',
  ]);
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${pathName}.${key}`;
    if (allowed.has(key) && ['string', 'number', 'boolean'].includes(typeof child)) {
      output.push({ field: childPath, value: child });
    }
    if (child && typeof child === 'object') collectDiagnostics(child, childPath, output);
  }
  return output;
}

async function getStatus() {
  const { state, response, publicTokens } = await getLinkResult();
  return {
    complete: publicTokens.length > 0,
    item_count: publicTokens.length,
    expiration: state.expiration,
    session_count: Array.isArray(response.link_sessions) ? response.link_sessions.length : null,
    diagnostics: collectDiagnostics(response),
  };
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function readAccessStore() {
  if (!fs.existsSync(ACCESS_FILE)) return { version: 2, items: [] };
  const value = readJson(ACCESS_FILE);
  if (Array.isArray(value.items)) return value;
  if (value.access_token) return { version: 2, items: [value] };
  return { version: 2, items: [] };
}

function itemResults(linkResult) {
  const results = [];
  const sessions = Array.isArray(linkResult.link_sessions) ? linkResult.link_sessions : [];
  for (const session of sessions) {
    const additions = session?.results?.item_add_results;
    if (Array.isArray(additions)) results.push(...additions);
  }
  const topLevel = linkResult?.results?.item_add_results;
  if (Array.isArray(topLevel)) results.push(...topLevel);
  const byToken = new Map();
  for (const result of results) {
    if (result?.public_token) byToken.set(result.public_token, result);
  }
  for (const token of findPublicTokens(linkResult)) {
    if (!byToken.has(token)) byToken.set(token, { public_token: token });
  }
  return [...byToken.values()];
}

async function finalizeHostedLink() {
  const { response: linkResult, publicTokens } = await getLinkResult();
  if (!publicTokens.length) {
    throw new PlaidError('Capital One authorization is not complete yet');
  }
  const store = readAccessStore();
  const additions = itemResults(linkResult);
  for (const addition of additions) {
    const hash = tokenHash(addition.public_token);
    let item = store.items.find((entry) => entry.public_token_hash === hash);
    if (!item) {
      const exchanged = await plaidPost('/item/public_token/exchange', { public_token: addition.public_token });
      if (!exchanged.access_token || !exchanged.item_id) {
        throw new PlaidError('Plaid did not return an access token after authorization');
      }
      const institution = findInstitution(addition) || {};
      item = {
        access_token: exchanged.access_token,
        item_id: exchanged.item_id,
        public_token_hash: hash,
        institution_id: institution.institution_id || null,
        institution_name: institution.institution_name || null,
        linked_at: new Date().toISOString(),
        accounts: [],
      };
      store.items.push(item);
      writePrivateJson(ACCESS_FILE, store);
    }
    const balance = await plaidPost('/accounts/balance/get', { access_token: item.access_token });
    item.accounts = Array.isArray(balance.accounts) ? balance.accounts.map(publicAccount) : [];
    item.balance_fetched_at = new Date().toISOString();
    writePrivateJson(ACCESS_FILE, store);
  }
  return {
    items: store.items.map((item) => ({
      institution_id: item.institution_id,
      institution_name: item.institution_name,
      accounts: item.accounts,
    })),
  };
}

async function getBalance() {
  const store = readAccessStore();
  if (!store.items.length) throw new Error('No Plaid access token exists');
  const output = [];
  for (const item of store.items) {
    const response = await plaidPost('/accounts/balance/get', { access_token: item.access_token });
    item.accounts = Array.isArray(response.accounts) ? response.accounts.map(publicAccount) : [];
    item.balance_fetched_at = new Date().toISOString();
    output.push({
      institution_id: item.institution_id,
      institution_name: item.institution_name,
      request_id: response.request_id || null,
      accounts: item.accounts,
      fetched_at: item.balance_fetched_at,
    });
  }
  writePrivateJson(ACCESS_FILE, store);
  return { items: output };
}

async function searchInstitutions(query) {
  if (!query || !query.trim()) throw new Error('Search query is required');
  const response = await plaidPost('/institutions/search', {
    query: query.trim(),
    products: ['transactions'],
    country_codes: ['US'],
    options: { include_optional_metadata: false },
  });
  return {
    institutions: (response.institutions || []).map((institution) => ({
      institution_id: institution.institution_id,
      name: institution.name,
      products: institution.products || [],
      oauth: !!institution.oauth,
    })),
  };
}

async function main(argv) {
  const command = argv[2];
  let result;
  if (command === 'create') result = await createHostedLink();
  else if (command === 'status') result = await getStatus();
  else if (command === 'finalize') result = await finalizeHostedLink();
  else if (command === 'balance') result = await getBalance();
  else if (command === 'search') result = await searchInstitutions(argv.slice(3).join(' '));
  else throw new Error('Usage: plaid_hosted_link.js create|status|finalize|balance|search <institution>');
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (require.main === module) {
  main(process.argv).catch((error) => {
    const details = error instanceof PlaidError ? error.details : {};
    process.stderr.write(`${JSON.stringify({ error: error.message, ...details })}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  createHostedLink,
  collectDiagnostics,
  finalizeHostedLink,
  findPublicTokens,
  getBalance,
  getStatus,
  publicAccount,
  searchInstitutions,
  writePrivateJson,
};
