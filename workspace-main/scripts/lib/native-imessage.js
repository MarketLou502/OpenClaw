'use strict';

const { spawnSync } = require('child_process');

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function sendNativeIMessage(message, options = {}) {
  const nodePath = options.nodePath || process.env.OPENCLAW_NODE_PATH || '/opt/homebrew/opt/node@22/bin/node';
  const cliPath = options.cliPath || process.env.OPENCLAW_CLI_PATH ||
    '/Users/aaronmacmini/.npm/_npx/8718c3904bb5fece/node_modules/openclaw/dist/index.js';
  const account = options.account || process.env.OPENCLAW_IMESSAGE_ACCOUNT || 'default';
  const target = options.target || process.env.OPENCLAW_IMESSAGE_TARGET || 'chat_id:1';
  const timeout = positiveInteger(options.timeoutMs || process.env.OPENCLAW_NOTIFICATION_TIMEOUT_MS, 30000);
  const result = spawnSync(nodePath, [
    cliPath,
    'message', 'send',
    '--channel', 'imessage',
    '--account', account,
    '--target', target,
    '--message', message,
    '--json',
  ], {
    encoding: 'utf8',
    timeout,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let body = null;
  try { body = JSON.parse((result.stdout || '').trim()); } catch {}
  if (result.status !== 0) {
    const detail = String(body?.error || result.stderr || result.error?.message || 'OpenClaw delivery failed')
      .replace(/\s+/g, ' ').trim().slice(0, 240);
    return { ok: false, error: detail };
  }
  return { ok: true, receipt: body };
}

module.exports = { sendNativeIMessage };
