#!/usr/bin/env node
'use strict';

// Narrow public receiver for Plaid notifications. It verifies Plaid's signed
// JWT against the exact raw request body, acknowledges quickly, and then runs
// Transactions Sync for the affected Item. It never serves dashboard data.

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const WORKSPACE = path.resolve(__dirname, '..');
const HOST = process.env.PLAID_WEBHOOK_HOST || '127.0.0.1';
const PORT = Number(process.env.PLAID_WEBHOOK_PORT || 18797);
const API_BASE = (process.env.PLAID_API_BASE || 'https://production.plaid.com').replace(/\/$/, '');
const CREDENTIALS_FILE = process.env.PLAID_CREDENTIALS_FILE || path.join(WORKSPACE, 'memory/.plaid_credentials.json');
const ACCESS_FILE = process.env.PLAID_ACCESS_FILE || path.join(WORKSPACE, 'memory/.plaid_access.json');
const SYNC_SCRIPT = process.env.PLAID_SYNC_SCRIPT || path.join(WORKSPACE, 'scripts/sync_plaid_transactions.js');
const MAX_BODY_BYTES = 128 * 1024;
const MAX_TOKEN_AGE_SECONDS = 5 * 60;
const keyCache = new Map();
const syncQueue = new Set();
let syncWorkerRunning = false;

function log(message) {
  process.stdout.write(`[plaid-webhook] ${new Date().toISOString()} ${message}\n`);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function decodeBase64Url(value) {
  return Buffer.from(value, 'base64url');
}

function decodeJsonPart(value, label) {
  try { return JSON.parse(decodeBase64Url(value).toString('utf8')); }
  catch { throw new Error(`invalid webhook JWT ${label}`); }
}

async function verificationKey(kid) {
  if (keyCache.has(kid)) return keyCache.get(kid);
  const credentials = readJson(CREDENTIALS_FILE);
  const response = await fetch(`${API_BASE}/webhook_verification_key/get`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'PLAID-CLIENT-ID': credentials.client_id,
      'PLAID-SECRET': credentials.secret,
      'Plaid-Version': '2020-09-14',
    },
    body: JSON.stringify({ key_id: kid }),
    signal: AbortSignal.timeout(10_000),
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok || !value.key) throw new Error('unable to retrieve Plaid webhook verification key');
  const key = value.key;
  if (key.kid !== kid || key.alg !== 'ES256' || key.kty !== 'EC' || key.crv !== 'P-256' || key.use !== 'sig') {
    throw new Error('Plaid returned an unexpected webhook verification key');
  }
  if (key.expired_at && key.expired_at <= Math.floor(Date.now() / 1000)) {
    throw new Error('Plaid webhook verification key is expired');
  }
  keyCache.set(kid, key);
  return key;
}

async function verifyWebhook(rawBody, signedJwt, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!signedJwt) throw new Error('missing Plaid-Verification header');
  const parts = signedJwt.split('.');
  if (parts.length !== 3) throw new Error('invalid webhook JWT');
  const header = decodeJsonPart(parts[0], 'header');
  const payload = decodeJsonPart(parts[1], 'payload');
  if (header.alg !== 'ES256' || !header.kid) throw new Error('unsupported webhook JWT');
  if (!Number.isInteger(payload.iat)
      || payload.iat < nowSeconds - MAX_TOKEN_AGE_SECONDS
      || payload.iat > nowSeconds + 30) {
    throw new Error('stale webhook JWT');
  }
  const jwk = await verificationKey(header.kid);
  const publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const validSignature = crypto.verify(
    'sha256',
    Buffer.from(`${parts[0]}.${parts[1]}`),
    { key: publicKey, dsaEncoding: 'ieee-p1363' },
    decodeBase64Url(parts[2]),
  );
  if (!validSignature) throw new Error('invalid webhook signature');

  const actualHash = crypto.createHash('sha256').update(rawBody).digest();
  let claimedHash;
  try { claimedHash = Buffer.from(payload.request_body_sha256, 'hex'); }
  catch { throw new Error('invalid webhook body hash'); }
  if (claimedHash.length !== actualHash.length || !crypto.timingSafeEqual(claimedHash, actualHash)) {
    throw new Error('webhook body hash mismatch');
  }
  return payload;
}

function knownItem(itemId) {
  const value = readJson(ACCESS_FILE);
  const items = Array.isArray(value.items) ? value.items : (value.access_token ? [value] : []);
  return items.some((item) => item.item_id === itemId);
}

function runSyncWorker() {
  if (syncWorkerRunning || syncQueue.size === 0) return;
  syncWorkerRunning = true;
  const itemId = syncQueue.values().next().value;
  syncQueue.delete(itemId);
  const child = spawn(process.execPath, [SYNC_SCRIPT, '--item-id', itemId], {
    cwd: WORKSPACE,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  child.on('error', (error) => log(`sync spawn failed for Item ${itemId}: ${error.message}`));
  child.on('close', (code) => {
    log(`sync ${code === 0 ? 'completed' : 'failed'} for Item ${itemId}${output.trim() ? `: ${output.trim().slice(-600)}` : ''}`);
    syncWorkerRunning = false;
    runSyncWorker();
  });
}

function queueSync(itemId) {
  syncQueue.add(itemId);
  runSyncWorker();
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  response.end(body);
}

async function readRawBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function handle(request, response) {
  if (request.method === 'GET' && request.url === '/health') {
    return sendJson(response, 200, { ok: true });
  }
  if (request.method !== 'POST' || request.url !== '/plaid/webhook') {
    return sendJson(response, 404, { error: 'not found' });
  }
  try {
    const rawBody = await readRawBody(request);
    await verifyWebhook(rawBody, request.headers['plaid-verification']);
    const event = JSON.parse(rawBody.toString('utf8'));
    if (event.environment !== 'production') return sendJson(response, 200, { ok: true, ignored: true });
    if (!event.item_id || !knownItem(event.item_id)) return sendJson(response, 200, { ok: true, ignored: true });
    if (event.webhook_type === 'TRANSACTIONS' && event.webhook_code === 'SYNC_UPDATES_AVAILABLE') {
      queueSync(event.item_id);
      log(`accepted SYNC_UPDATES_AVAILABLE for Item ${event.item_id}`);
    } else {
      log(`accepted ${event.webhook_type || 'UNKNOWN'}/${event.webhook_code || 'UNKNOWN'} for Item ${event.item_id}`);
    }
    return sendJson(response, 200, { ok: true });
  } catch (error) {
    log(`rejected webhook: ${error.message}`);
    return sendJson(response, 401, { error: 'invalid webhook' });
  }
}

function createServer() {
  return http.createServer((request, response) => {
    handle(request, response).catch((error) => {
      log(`handler failure: ${error.message}`);
      if (!response.headersSent) sendJson(response, 500, { error: 'internal error' });
      else response.end();
    });
  });
}

if (require.main === module) {
  createServer().listen(PORT, HOST, () => log(`listening on http://${HOST}:${PORT}`));
}

module.exports = { createServer, verifyWebhook };
