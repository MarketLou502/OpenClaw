'use strict';

// Requests a non-delivering agent turn (compose only, no channel send) via
// the OpenClaw CLI's `agent` command — the deterministic-caller side of the
// "script sends, LLM only composes" boundary used for Task Tracker's
// due-date check-ins (see reassess.js / calendar-notification-workflow.js).
// The agent's tools.deny already blocks it from sending iMessage itself;
// this just gets its composed text back for the caller to deliver.

const { spawnSync } = require('child_process');

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function requestAgentReply(agentId, message, options = {}) {
  const nodePath = options.nodePath || process.env.OPENCLAW_NODE_PATH || '/opt/homebrew/opt/node@22/bin/node';
  const cliPath = options.cliPath || process.env.OPENCLAW_CLI_PATH ||
    '/Users/aaronmacmini/.npm/_npx/8718c3904bb5fece/node_modules/openclaw/dist/index.js';
  const timeoutSeconds = positiveInteger(options.timeoutSeconds, 30);
  const args = [cliPath, 'agent', '--agent', agentId, '--message', message, '--json', '--timeout', String(timeoutSeconds)];
  if (options.sessionKey) args.push('--session-key', options.sessionKey);

  const result = spawnSync(nodePath, args, {
    encoding: 'utf8',
    timeout: (timeoutSeconds + 10) * 1000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let body = null;
  try { body = JSON.parse((result.stdout || '').trim()); } catch {}

  if (result.error) return { ok: false, error: `agent turn spawn failed: ${result.error.message}` };
  if (result.status !== 0 || !body || body.status !== 'ok') {
    const detail = String(body?.error || result.stderr || 'agent turn failed').replace(/\s+/g, ' ').trim().slice(0, 240);
    return { ok: false, error: detail };
  }
  const text = body.result?.payloads?.[0]?.text;
  if (!text) return { ok: false, error: 'agent turn returned no text payload' };
  return { ok: true, text, runId: body.runId };
}

module.exports = { requestAgentReply };
