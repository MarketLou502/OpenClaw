#!/usr/bin/env node
'use strict';

// Deterministic state and submission workflow for Main's native-iMessage
// Zaxby's receipt flow. Natural-language intent and receipt OCR stay with Main;
// this program validates codes, persists verification state, prevents duplicate
// submissions, and invokes the existing Playwright runner. It never sends a
// message itself.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const DEFAULT_STATE_FILE = path.join(__dirname, '..', 'memory', 'zaxbys-workflow-state.json');
const DEFAULT_RUNNER = path.join(__dirname, 'zaxbys-survey.sh');
const STATE_FILE = process.env.OPENCLAW_ZAXBYS_STATE_FILE || DEFAULT_STATE_FILE;
const RUNNER = process.env.OPENCLAW_ZAXBYS_RUNNER || DEFAULT_RUNNER;
const PENDING_TTL_MS = positiveInteger(process.env.OPENCLAW_ZAXBYS_PENDING_TTL_MS, 10 * 60 * 1000);
const RUNNER_TIMEOUT_MS = positiveInteger(process.env.OPENCLAW_ZAXBYS_RUNNER_TIMEOUT_MS, 120 * 1000);
const MAX_REQUEST_RESULTS = 500;

class WorkflowError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function nowMs() {
  const injected = Number(process.env.OPENCLAW_ZAXBYS_NOW_MS);
  return Number.isFinite(injected) ? injected : Date.now();
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith('--')) throw new WorkflowError('INVALID_ARGUMENT', `Unexpected argument '${token}'`);
    const key = token.slice(2);
    const value = rest[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new WorkflowError('INVALID_ARGUMENT', `Missing value for --${key}`);
    }
    options[key] = value;
    index += 1;
  }
  return { command, options };
}

function required(value, name, maxLength = 300) {
  const text = String(value || '').trim();
  if (!text) throw new WorkflowError('INVALID_ARGUMENT', `${name} is required`);
  if (text.length > maxLength) throw new WorkflowError('INVALID_ARGUMENT', `${name} is too long`);
  return text;
}

function normalizeCode(value) {
  if (value === undefined || value === null) return null;
  const code = String(value).trim().replace(/\s+/g, '').toUpperCase();
  return /^[A-Z0-9]{15}$/.test(code) ? code : null;
}

function normalizeConfidence(value) {
  const confidence = String(value || '').trim().toLowerCase();
  if (!['high', 'uncertain'].includes(confidence)) {
    throw new WorkflowError('INVALID_ARGUMENT', 'Confidence must be high or uncertain');
  }
  return confidence;
}

function emptyState() {
  return { version: 1, pending: {}, requestResults: {}, submissions: {} };
}

function readState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (!parsed || parsed.version !== 1) throw new Error('unsupported state version');
    parsed.pending ||= {};
    parsed.requestResults ||= {};
    parsed.submissions ||= {};
    return parsed;
  } catch (error) {
    if (error.code === 'ENOENT') return emptyState();
    throw new WorkflowError('STATE_READ_FAILED', `Could not read Zaxby's workflow state: ${error.message}`);
  }
}

function writeState(state) {
  const directory = path.dirname(STATE_FILE);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${STATE_FILE}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, STATE_FILE);
    fs.chmodSync(STATE_FILE, 0o600);
  } finally {
    try { fs.unlinkSync(temporary); } catch {}
  }
}

function requestKey(conversation, requestId) {
  return crypto.createHash('sha256').update(`${conversation}\0${requestId}`, 'utf8').digest('hex');
}

function cachedResult(state, conversation, requestId) {
  return state.requestResults[requestKey(conversation, requestId)]?.result || null;
}

function rememberResult(state, conversation, requestId, result, timestamp) {
  state.requestResults[requestKey(conversation, requestId)] = { timestamp, result };
  const keys = Object.keys(state.requestResults);
  if (keys.length > MAX_REQUEST_RESULTS) {
    keys.sort((left, right) => state.requestResults[left].timestamp - state.requestResults[right].timestamp);
    for (const key of keys.slice(0, keys.length - MAX_REQUEST_RESULTS)) delete state.requestResults[key];
  }
}

function boundedMessage(value) {
  const text = String(value || 'Unknown survey error').replace(/\s+/g, ' ').trim();
  return text.slice(0, 240);
}

function runSurvey(state, code, conversation, requestId, timestamp) {
  const previous = state.submissions[code];
  if (previous) {
    if (previous.status === 'in_progress') {
      const result = {
        ok: false,
        action: 'submission_status_unknown',
        code,
        error: {
          code: 'SUBMISSION_STATUS_UNKNOWN',
          message: 'A prior submission started but did not record a final result. It will not be run again automatically.',
        },
        reply: `I started the survey for ${code}, but I cannot verify whether it finished. I did not submit it a second time.`,
      };
      rememberResult(state, conversation, requestId, result, timestamp);
      writeState(state);
      return result;
    }
    const result = { ...previous.result, idempotent: true };
    rememberResult(state, conversation, requestId, result, timestamp);
    writeState(state);
    return result;
  }

  // Persist intent before the external browser action. If the process crashes,
  // a retry reports an unknown result instead of possibly submitting twice.
  state.submissions[code] = { status: 'in_progress', startedAt: timestamp };
  delete state.pending[conversation];
  writeState(state);

  const execution = spawnSync(RUNNER, [code], {
    encoding: 'utf8',
    timeout: RUNNER_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let runnerResult = null;
  try { runnerResult = JSON.parse((execution.stdout || '').trim()); } catch {}

  let result;
  if (execution.status === 0 && runnerResult?.success === true) {
    result = {
      ok: true,
      action: 'submitted',
      code,
      reply: `Survey done! Coupon is on its way to aaron143574@icloud.com 🍗`,
    };
    state.submissions[code] = { status: 'complete', completedAt: nowMs(), result };
  } else {
    const detail = execution.error?.code === 'ETIMEDOUT'
      ? 'The survey runner timed out.'
      : boundedMessage(runnerResult?.message || execution.stderr || execution.error?.message);
    result = {
      ok: false,
      action: 'submission_failed',
      code,
      error: { code: 'SURVEY_FAILED', message: detail },
      reply: `The Zaxby's survey did not finish: ${detail}`,
    };
    state.submissions[code] = { status: 'failed', completedAt: nowMs(), result };
  }

  rememberResult(state, conversation, requestId, result, timestamp);
  writeState(state);
  return result;
}

function stageVerification(state, conversation, requestId, code, timestamp) {
  const expiresAt = timestamp + PENDING_TTL_MS;
  state.pending[conversation] = {
    code,
    sourceRequestId: requestId,
    createdAt: timestamp,
    expiresAt,
  };
  const result = code
    ? {
        ok: true,
        action: 'verification_required',
        code,
        expiresAt,
        reply: `I read the code as ${code}. Reply “yes” to use it, or send the corrected 15-character code.`,
      }
    : {
        ok: true,
        action: 'code_required',
        code: null,
        expiresAt,
        reply: `I couldn't reliably read the survey code. Reply with the 15-character code printed on the receipt.`,
      };
  rememberResult(state, conversation, requestId, result, timestamp);
  writeState(state);
  return result;
}

function ingest(options) {
  const conversation = required(options.conversation, 'Conversation');
  const requestId = required(options['request-id'], 'Request ID');
  const confidence = normalizeConfidence(options.confidence);
  const code = normalizeCode(options.code);
  const timestamp = nowMs();
  const state = readState();
  const cached = cachedResult(state, conversation, requestId);
  if (cached) return { ...cached, idempotent: true };

  // "Zaxby survey" is the user's explicit instruction to run this automation.
  // A high-confidence, structurally valid OCR result can therefore submit at
  // once; uncertain or malformed readings must be verified first.
  if (confidence === 'high' && code) return runSurvey(state, code, conversation, requestId, timestamp);
  return stageVerification(state, conversation, requestId, code, timestamp);
}

function respond(options) {
  const conversation = required(options.conversation, 'Conversation');
  const requestId = required(options['request-id'], 'Request ID');
  const response = required(options.response, 'Response', 500);
  const timestamp = nowMs();
  const state = readState();
  const cached = cachedResult(state, conversation, requestId);
  if (cached) return { ...cached, idempotent: true };

  const pending = state.pending[conversation];
  if (!pending) throw new WorkflowError('NO_PENDING_CODE', 'There is no Zaxby survey code waiting for verification');
  if (timestamp >= pending.expiresAt) {
    delete state.pending[conversation];
    writeState(state);
    throw new WorkflowError('PENDING_EXPIRED', 'The pending Zaxby survey code expired. Send the receipt again with “Zaxby survey.”');
  }

  const trimmed = response.trim();
  if (/^(?:cancel|no)$/i.test(trimmed)) {
    delete state.pending[conversation];
    const result = { ok: true, action: 'cancelled', reply: `Okay, I didn't submit the Zaxby's survey.` };
    rememberResult(state, conversation, requestId, result, timestamp);
    writeState(state);
    return result;
  }

  if (/^yes$/i.test(trimmed)) {
    if (!pending.code) {
      const result = {
        ok: false,
        action: 'code_required',
        error: { code: 'CODE_REQUIRED', message: 'No readable code is pending' },
        reply: 'I still need the 15-character code from the receipt.',
      };
      rememberResult(state, conversation, requestId, result, timestamp);
      writeState(state);
      return result;
    }
    return runSurvey(state, pending.code, conversation, requestId, timestamp);
  }

  const correctedCode = normalizeCode(trimmed);
  if (correctedCode) return runSurvey(state, correctedCode, conversation, requestId, timestamp);

  const result = {
    ok: false,
    action: 'not_confirmation',
    error: { code: 'NOT_CONFIRMATION', message: 'The response was neither exact “yes” nor a 15-character code' },
    reply: pending.code
      ? `I still have ${pending.code} waiting. Reply exactly “yes,” send the corrected 15-character code, or say “cancel.”`
      : 'Reply with the 15-character code, or say “cancel.”',
  };
  rememberResult(state, conversation, requestId, result, timestamp);
  writeState(state);
  return result;
}

function status(options) {
  const conversation = required(options.conversation, 'Conversation');
  const timestamp = nowMs();
  const state = readState();
  const pending = state.pending[conversation];
  if (!pending) return { ok: true, action: 'status', pending: false };
  if (timestamp >= pending.expiresAt) {
    delete state.pending[conversation];
    writeState(state);
    return { ok: true, action: 'status', pending: false, expired: true };
  }
  return {
    ok: true,
    action: 'status',
    pending: true,
    code: pending.code,
    expiresAt: pending.expiresAt,
  };
}

function help() {
  return {
    ok: true,
    action: 'help',
    usage: [
      'zaxbys-workflow.js ingest --conversation <id> --request-id <id> --confidence <high|uncertain> [--code <15 chars>]',
      'zaxbys-workflow.js respond --conversation <id> --request-id <id> --response <yes|cancel|15-char code>',
      'zaxbys-workflow.js status --conversation <id>',
    ],
  };
}

function main() {
  try {
    const { command, options } = parseArgs(process.argv.slice(2));
    let result;
    if (command === 'ingest') result = ingest(options);
    else if (command === 'respond') result = respond(options);
    else if (command === 'status') result = status(options);
    else if (!command || command === 'help') result = help();
    else throw new WorkflowError('INVALID_COMMAND', `Unknown command '${command}'`);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.ok === false ? 1 : 0;
  } catch (error) {
    const body = {
      ok: false,
      error: {
        code: error instanceof WorkflowError ? error.code : 'INTERNAL_ERROR',
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    };
    process.stdout.write(`${JSON.stringify(body)}\n`);
    process.exitCode = 1;
  }
}

main();
