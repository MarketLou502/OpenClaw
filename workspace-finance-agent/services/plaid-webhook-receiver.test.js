#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'plaid-webhook-test-'));
const credentials = path.join(temporary, 'credentials.json');
fs.writeFileSync(credentials, JSON.stringify({ client_id: 'client', secret: 'secret' }));
process.env.PLAID_CREDENTIALS_FILE = credentials;
process.env.PLAID_API_BASE = 'https://mock.plaid.test';

const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const jwk = publicKey.export({ format: 'jwk' });
Object.assign(jwk, { kid: 'test-key', alg: 'ES256', use: 'sig', created_at: 1, expired_at: null });
global.fetch = async () => ({ ok: true, async json() { return { key: jwk }; } });

const { verifyWebhook } = require('./plaid-webhook-receiver.js');

function signedWebhook(rawBody, iat) {
  const headerPart = Buffer.from(JSON.stringify({ alg: 'ES256', kid: 'test-key', typ: 'JWT' })).toString('base64url');
  const payloadPart = Buffer.from(JSON.stringify({
    iat,
    request_body_sha256: crypto.createHash('sha256').update(rawBody).digest('hex'),
  })).toString('base64url');
  const signature = crypto.sign(
    'sha256',
    Buffer.from(`${headerPart}.${payloadPart}`),
    { key: privateKey, dsaEncoding: 'ieee-p1363' },
  ).toString('base64url');
  return `${headerPart}.${payloadPart}.${signature}`;
}

(async () => {
  const now = 1_785_800_000;
  const body = Buffer.from(JSON.stringify({ webhook_type: 'TRANSACTIONS', webhook_code: 'SYNC_UPDATES_AVAILABLE' }));
  await verifyWebhook(body, signedWebhook(body, now), now);
  await assert.rejects(() => verifyWebhook(Buffer.from('{}'), signedWebhook(body, now), now), /hash mismatch/);
  await assert.rejects(() => verifyWebhook(body, signedWebhook(body, now - 301), now), /stale/);
  process.stdout.write('Plaid webhook verification test passed\n');
})().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
