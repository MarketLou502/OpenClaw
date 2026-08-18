#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { routeRoutineRequest } = require('../shared-routine-router');

const PORT = process.env.HA_VOICE_ADAPTER_PORT || 18796;
const TOKEN_FILE = process.env.HA_VOICE_ADAPTER_TOKEN_FILE ||
  '/Users/aaronmacmini/.openclaw/service-env/ha-voice-adapter.token';
const AGENT_TIMEOUT_MS = Number(process.env.HA_VOICE_ADAPTER_TIMEOUT_MS || 45000);
// Budget for Main to poll session_status on a delegated subagent before
// giving up and reporting "still working on it" instead of a real result.
// Leaves 15s of headroom under AGENT_TIMEOUT_MS for connection handshake
// and Main's own reasoning time — not measured yet, a starting estimate.
const VOICE_POLL_BUDGET_SECONDS = Math.max(5, Math.floor(AGENT_TIMEOUT_MS / 1000) - 15);
const GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL || 'ws://127.0.0.1:18789';
const GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || 'openclaw-local-relay';

// 2026-08-07: this adapter used to keep its own hand-typed copy of Main's
// delegation routing table in extraSystemPrompt below, then switched to
// extracting just the block between TOOLS.md's DELEGATION_TABLE markers.
// That fixed three prior drifts (stale sessions_spawn, a missing
// health-tracker route, a missing agentId/sessionKey warning that caused
// Main to message itself in a loop instead of reaching health-tracker) —
// but extraction was itself the same bug shape one level up: TOOLS.md's
// Role section ("I am the delegator... I do NOT... answer general-knowledge
// questions myself") lives outside those markers, so it was never included
// here. Main runs this turn under bootstrapContextMode:'lightweight' (no
// workspace docs at all, see below), so with only the routing table and no
// "delegation is mandatory, not informational" framing, it had nothing
// telling it not to just answer a food-log message conversationally
// instead of calling sessions_send — which is exactly what happened
// (2026-08-08). Fix: stop extracting a subset of TOOLS.md. Read the whole
// file. No hand-curated copy left to drift out of sync.
//
// No caching — TOOLS.md is a few KB, a sync read is sub-millisecond, and
// this way an edit to TOOLS.md takes effect on the very next voice request
// with no adapter restart needed.
const TOOLS_MD_PATH = '/Users/aaronmacmini/.openclaw/workspace-main/TOOLS.md';
// Only used if TOOLS.md is unreadable (e.g. deleted or a permissions
// error) — degrades voice delegation rather than hanging every request until
// AGENT_TIMEOUT_MS. Logged loudly each time so it doesn't go unnoticed.
const TOOLS_DOC_FALLBACK = 'Delegate via sessions_send with an explicit agentId — never sessionKey, never "current" as a value. If unsure which specialist owns this request, ask Aaron rather than guessing.';

function loadToolsDoc() {
  try {
    return fs.readFileSync(TOOLS_MD_PATH, 'utf8').trim();
  } catch (err) {
    logErr(`ha-voice-adapter: failed to read ${TOOLS_MD_PATH}: ${err.message} — using fallback delegation rule`);
    return TOOLS_DOC_FALLBACK;
  }
}

// Main turns share one long-lived session per device
// (agent:main:home_assistant:<deviceSlug>) so back-to-back commands keep
// conversational context. But voice commands are typically minutes apart,
// well past Anthropic's ~5min prompt-cache TTL, so that session's history
// just accumulates all day as pure dead weight: every escalation re-sends
// the full growing transcript as an uncached (full-price, full-latency)
// prefill. Observed 2026-08-01: 26.5K input tokens at 12:17pm growing to
// 35K+ tokens by 3:45pm on one voice-logged "cup of rice", costing several
// cents and multi-second latency for what should be a trivial call. Reset
// the session after enough idle time that cache locality was already lost,
// so escalations stay small and cheap instead of dragging the whole day.
const SESSION_IDLE_RESET_MS = Number(process.env.HA_VOICE_SESSION_IDLE_RESET_MS || 10 * 60 * 1000);
const lastEscalationAtByDevice = new Map();

// Main's specific reasoning for these exact values (lean prompt shape, no
// modelRun override, extraSystemPrompt = voice formatting + full TOOLS.md
// verbatim, and the incident history behind all of it) lives in the block
// comment this replaced — preserved here since runAgentTurn is now generic.
function buildMainTurnParams() {
  return {
    agentId: 'main',
    promptMode: 'minimal',
    bootstrapContextMode: 'lightweight',
    extraSystemPrompt: `This is a Home Assistant voice turn — reply in one or two concise, natural spoken sentences with no markdown. Do not attempt delegated actions directly yourself. Use timeoutSeconds: ${VOICE_POLL_BUDGET_SECONDS} on every sessions_send call.\n\n${loadToolsDoc()}`,
  };
}

function resetEscalationSessionIfIdle(deviceSlug, rt) {
  const now = Date.now();
  const last = lastEscalationAtByDevice.get(deviceSlug);
  lastEscalationAtByDevice.set(deviceSlug, now);
  if (last !== undefined && now - last < SESSION_IDLE_RESET_MS) return Promise.resolve();

  const sessionKey = `agent:main:home_assistant:${deviceSlug}`;
  rt.mark(`session idle >= ${SESSION_IDLE_RESET_MS}ms, resetting ${sessionKey} before Main turn`);
  return new Promise((resolve) => {
    let settled = false;
    let ws;
    const done = () => {
      if (settled) return;
      settled = true;
      try { ws && ws.close(); } catch (_e) { /* ignore */ }
      resolve();
    };
    const timer = setTimeout(done, 5000);
    try {
      ws = new WebSocket(GATEWAY_URL);
    } catch (err) {
      clearTimeout(timer);
      logErr(`ha-voice-adapter: session reset connect failed: ${err.message}`);
      done();
      return;
    }
    let sentConnect = false;
    ws.addEventListener('message', (event) => {
      let frame;
      try { frame = JSON.parse(event.data); } catch (_err) { return; }
      if (frame.type === 'event' && frame.event === 'connect.challenge' && !sentConnect) {
        sentConnect = true;
        ws.send(JSON.stringify({
          type: 'req',
          id: crypto.randomUUID(),
          method: 'connect',
          params: {
            minProtocol: 4,
            maxProtocol: 4,
            client: { id: 'gateway-client', version: '1.0.0', platform: 'node', mode: 'backend' },
            role: 'operator',
            scopes: ['operator.read', 'operator.write', 'operator.admin'],
            auth: { token: GATEWAY_TOKEN },
          },
        }));
        return;
      }
      if (frame.type !== 'res') return;
      if (frame.payload && frame.payload.type === 'hello-ok') {
        ws.send(JSON.stringify({
          type: 'req',
          id: crypto.randomUUID(),
          method: 'sessions.reset',
          params: { key: sessionKey, reason: 'reset' },
        }));
        return;
      }
      if (!frame.ok) logErr(`ha-voice-adapter: session reset failed: ${JSON.stringify(frame.error).slice(-500)}`);
      clearTimeout(timer);
      done();
    });
    ws.addEventListener('error', (event) => {
      clearTimeout(timer);
      logErr(`ha-voice-adapter: session reset websocket error: ${event.message || event}`);
      done();
    });
  });
}

// Every console.log/error line gets an ISO timestamp prefix so
// ~/Library/Logs/openclaw/ha-voice-adapter.log can actually be used to
// compute elapsed time between pipeline stages — previously it had none.
function log(...args) { console.log(new Date().toISOString(), ...args); }
function logErr(...args) { console.error(new Date().toISOString(), ...args); }

// Per-request stage timer. `mark()` logs elapsed-since-request-start (not
// since the last mark) so every line is directly comparable, which is what
// you want when hunting for "which stage ate the time" across a log.
function requestTimer(id) {
  const start = Date.now();
  return {
    id,
    mark(label) { log(`[voice:${id}] ${label} (+${Date.now() - start}ms since request start)`); },
    elapsed() { return Date.now() - start; },
  };
}

const VOICE_FASTPATH_LOG = process.env.HA_VOICE_FASTPATH_LOG ||
  '/Users/aaronmacmini/.openclaw/logs/voice-fastpath.jsonl';

// Weather and router-dispatch are the only two fast paths that speak a
// reply without leaving any queryable record of what was actually asked
// (food logging and Main escalations both already persist elsewhere).
// This fire-and-forget append is read nightly by systems-qa's routing QA
// job and then truncated, so it never grows past ~1 day of traffic. Always
// called AFTER sendJson() so it cannot add response latency, and a failed
// write is logged once here rather than retried.
function appendVoiceFastPathLog(entry) {
  const line = JSON.stringify({ timestamp: Date.now(), ...entry }) + '\n';
  fs.promises.appendFile(VOICE_FASTPATH_LOG, line)
    .catch((err) => logErr(`ha-voice-adapter: voice fast-path log append failed: ${err.message}`));
}

function readToken() {
  return fs.readFileSync(TOKEN_FILE, 'utf8').trim();
}

const TOKEN = readToken();
if (!TOKEN) {
  logErr(`ha-voice-adapter: empty token at ${TOKEN_FILE}`);
  process.exit(1);
}

// Script/main replies are written for iMessage and the kiosk display, where
// something like "✅ Added 'juice' to Grocery" is fine — but Piper doesn't
// skip emoji for TTS, it reads their literal Unicode name out loud (which is
// exactly what happened: "✅" got spoken as "white check mark"). Strip them
// here, once, right before anything goes back to Home Assistant, rather than
// touching the scripts' own reply text which is still correct elsewhere.
function stripForSpeech(text) {
  return String(text || '')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}️]/gu, '')
    // Smart quotes read fine visually but can trip up Piper TTS mid-word
    // (e.g. "Added "Basketball" on..." reported as jumbled speech,
    // 2026-08-08) — drop them rather than round-trip through straight
    // quotes, since spoken text doesn't need quote marks at all.
    .replace(/[‘’“”]/g, '')
    .replace(/\n+/g, '. ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// Whether the caller (the future HA conversation agent) should keep the mic
// open for a follow-up without the wake word. Deterministic routine replies
// only expect one when they explicitly say so (routine.expectsReply — e.g.
// the DeleteList confirmation prompt); Main's free-form replies have no such
// flag, so a trailing "?" is the same heuristic HA's own chat_log.
// continue_conversation property uses for LLM-backed conversation agents.
function expectsFollowUp(text) {
  return /[?？]\s*$/.test(String(text || '').trim());
}

// When the food fast-path defers (fuzzy match, no reliable candidate, or low
// confidence), it already ran real USDA-index lookups — passing Main only
// the raw text throws that work away. This surfaces the fast-path's own
// candidate shortlist (nutrition per 100g already looked up) as context
// appended to what Main/health-tracker actually reasons over, so
// health-tracker gets a head start instead of re-deriving it from scratch.
// See HEALTH_ROUTING.md's "Food and drink" section for how Main is expected
// to forward this along. Added 2026-08-17 per Aaron.
function buildFoodFastPathHint(stages) {
  const usdaStage = (stages || []).find((s) => s.stage === 'food-usda-tier' && s.status === 'fail');
  if (!usdaStage) return null;
  const detail = usdaStage.detail || {};
  const candidates = detail.candidates ||
    (detail.candidate ? [{ description: detail.candidate, similarity: detail.similarity }] : null);
  if (!candidates || candidates.length === 0) return null;

  const lines = candidates.map((c, i) => {
    const parts = [`${i + 1}. "${c.description}"`];
    if (c.fuzzyMatch) parts.push('fuzzy match');
    if (typeof c.similarity === 'number') parts.push(`similarity ${c.similarity.toFixed(2)}`);
    if (typeof c.caloriesPer100g === 'number') parts.push(`${c.caloriesPer100g} kcal/100g`);
    if (typeof c.proteinPer100g === 'number') parts.push(`${c.proteinPer100g}g protein/100g`);
    if (c.fdcId) parts.push(`fdcId ${c.fdcId}`);
    return parts.join(', ');
  });

  return [
    '[USDA fast-path context — not auto-logged, did not clear the confidence bar]',
    `search query: "${detail.searchQuery || ''}"`,
    ...lines,
  ].join('\n');
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}

// Talks directly to the OpenClaw Gateway's WebSocket JSON-RPC protocol
// (docs/gateway/protocol.md) instead of spawning `openclaw agent` as a
// subprocess. A fresh connection per request matches the Gateway's own
// reference CLI behavior (it doesn't hold a persistent connection across
// calls either) — the win here is skipping the whole-CLI process
// start + module-load cost, not skipping the connect handshake.
function runAgentTurn({ text, deviceSlug, rt, agentId = 'main', sessionKey, extraSystemPrompt, promptMode, bootstrapContextMode }) {
  return new Promise((resolve) => {
    sessionKey = sessionKey || `home_assistant:${deviceSlug}`;
    let settled = false;
    let ws;
    const wsOpenStart = Date.now();
    let turnSendStart = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws && ws.close(); } catch (_e) { /* ignore */ }
      resolve(result);
    };

    const timer = setTimeout(() => {
      rt.mark(`escalation timed out after ${AGENT_TIMEOUT_MS}ms`);
      finish({ ok: false, reply: "Sorry, that's taking longer than expected. Try again in a moment." });
    }, AGENT_TIMEOUT_MS);

    try {
      ws = new WebSocket(GATEWAY_URL);
    } catch (err) {
      clearTimeout(timer);
      logErr(`ha-voice-adapter: failed to open gateway connection: ${err.message}`);
      resolve({ ok: false, reply: "Sorry, I couldn't reach the gateway." });
      return;
    }

    let requestId = null;
    let runId = null;
    let sentConnect = false;

    ws.addEventListener('message', (event) => {
      let frame;
      try {
        frame = JSON.parse(event.data);
      } catch (_err) {
        return;
      }

      // Server pushes an unsolicited connect.challenge event right after
      // open; our first request frame in response is `connect`.
      if (frame.type === 'event' && frame.event === 'connect.challenge' && !sentConnect) {
        sentConnect = true;
        rt.mark(`gateway connect.challenge received (handshake open took ${Date.now() - wsOpenStart}ms)`);
        ws.send(JSON.stringify({
          type: 'req',
          id: crypto.randomUUID(),
          method: 'connect',
          params: {
            minProtocol: 4,
            maxProtocol: 4,
            client: { id: 'gateway-client', version: '1.0.0', platform: 'node', mode: 'backend' },
            role: 'operator',
            scopes: ['operator.read', 'operator.write', 'operator.admin'],
            auth: { token: GATEWAY_TOKEN },
          },
        }));
        return;
      }

      if (frame.type !== 'res') return;

      // hello-ok response to our connect request -> now send the actual turn.
      // promptMode/bootstrapContextMode/extraSystemPrompt are caller-supplied
      // (see buildMainTurnParams below) — Main's own reasoning for its
      // specific values (lean 'minimal'/'lightweight' prompt, no modelRun
      // override, extraSystemPrompt = voice formatting + full TOOLS.md
      // verbatim) lives there, not here.
      if (frame.payload && frame.payload.type === 'hello-ok') {
        rt.mark('gateway hello-ok received, sending agent turn');
        turnSendStart = Date.now();
        requestId = crypto.randomUUID();
        ws.send(JSON.stringify({
          type: 'req',
          id: requestId,
          method: 'agent',
          params: {
            message: text,
            agentId,
            sessionKey,
            deliver: false,
            timeout: Math.ceil(AGENT_TIMEOUT_MS / 1000),
            idempotencyKey: crypto.randomUUID(),
            ...(promptMode !== undefined ? { promptMode } : {}),
            ...(bootstrapContextMode !== undefined ? { bootstrapContextMode } : {}),
            ...(extraSystemPrompt !== undefined ? { extraSystemPrompt } : {}),
          },
        }));
        return;
      }

      // The Gateway sends two "res" frames with the SAME request id:
      // first an immediate "accepted" ack (no result yet), then later
      // the real final one once the turn completes.
      if (requestId && frame.id === requestId) {
        if (!frame.ok) {
          rt.mark(`gateway agent call failed after ${Date.now() - turnSendStart}ms`);
          logErr(`ha-voice-adapter: gateway agent call failed: ${JSON.stringify(frame.error).slice(-2000)}`);
          finish({ ok: false, reply: "Sorry, I ran into a problem reaching main." });
          return;
        }
        if (frame.payload && frame.payload.status === 'accepted') {
          runId = frame.payload.runId;
          rt.mark(`agent run accepted (runId ${runId}), awaiting completion`);
          return;
        }
        rt.mark(`agent turn completed (model turn took ${Date.now() - turnSendStart}ms)`);
        const payloads = (frame.payload && frame.payload.result && frame.payload.result.payloads) || [];
        const replyText = payloads
          .map((p) => p.text)
          .filter(Boolean)
          .join(' ')
          .trim();
        finish({ ok: true, reply: replyText || 'Done.' });
      }
    });

    ws.addEventListener('error', (event) => {
      logErr(`ha-voice-adapter: gateway websocket error: ${event.message || event}`);
      finish({ ok: false, reply: "Sorry, I couldn't reach the gateway." });
    });

    ws.addEventListener('close', () => {
      finish({ ok: false, reply: "Sorry, the connection to main closed unexpectedly." });
    });
  });
}

const server = http.createServer((req, res) => {
  const rt = requestTimer(crypto.randomUUID().slice(0, 8));
  log(`ha-voice-adapter: [voice:${rt.id}] ${req.method} ${req.url} from ${req.socket.remoteAddress}`);

  if (req.method !== 'POST' || req.url !== '/voice') {
    sendJson(res, 404, { error: 'not_found' });
    return;
  }

  const auth = req.headers.authorization || '';
  const provided = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (provided !== TOKEN) {
    sendJson(res, 401, { error: 'unauthorized' });
    return;
  }

  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', async () => {
    let parsed;
    try {
      parsed = JSON.parse(body || '{}');
    } catch (err) {
      sendJson(res, 400, { error: 'invalid_json' });
      return;
    }

    const text = typeof parsed.text === 'string' ? parsed.text.trim() : '';
    const deviceSlug = typeof parsed.deviceSlug === 'string' ? parsed.deviceSlug.trim() : '';

    if (!text || !deviceSlug) {
      sendJson(res, 400, { error: 'missing_text_or_deviceSlug' });
      return;
    }

    rt.mark(`request body parsed, text: ${JSON.stringify(text)}`);

    // Voice and iMessage share this exact deterministic command router.
    // Only commands it recognizes are claimed; everything else remains Main's.
    const routine = await routeRoutineRequest({
      text,
      channel: 'voice-pe-kitchen',
      conversationId: deviceSlug,
      messageId: parsed.messageId || crypto.randomUUID(),
    });
    // Logged on both outcomes (previously only success) so a request that
    // silently died mid-pipeline (e.g. the router matched a grammar but
    // couldn't parse a slot) still leaves a trace instead of vanishing —
    // see project-calendar-period-time-separator-bug-2026-08-08.
    appendVoiceFastPathLog({
      route: routine.handled ? 'router' : 'router-unhandled',
      intent: routine.route || null,
      request: text,
      reply: routine.reply || null,
      deviceSlug,
      stages: routine.stages || [],
    });
    if (routine.handled) {
      rt.mark(`shared routine (${routine.route}) done, total ${rt.elapsed()}ms`);
      sendJson(res, 200, { reply: stripForSpeech(routine.reply), expectsReply: Boolean(routine.expectsReply) });
      return;
    }

    // Weather and food-logging fast paths used to live here as separate
    // regex/logic tiers. Weather was removed 2026-08-08 (unneeded); food
    // logging (recipe + USDA + portion parsing) moved into
    // routeRoutineRequest itself the same day, so a food report that the
    // grammar router doesn't match already got a food-fastpath attempt
    // above (reflected in routine.handled/routine.route) before falling
    // through to here.
    rt.mark(`no deterministic fast path matched; forwarding to Main`);

    const foodHint = buildFoodFastPathHint(routine.stages);
    const messageForMain = foodHint ? `${text}\n\n${foodHint}` : text;

    await resetEscalationSessionIfIdle(deviceSlug, rt);
    const result = await runAgentTurn({ text: messageForMain, deviceSlug, rt, ...buildMainTurnParams() });
    rt.mark(`Main turn done, total ${rt.elapsed()}ms`);
    sendJson(res, 200, { reply: stripForSpeech(result.reply), expectsReply: expectsFollowUp(result.reply) });
  });
});

server.listen(PORT, '0.0.0.0', () => {
  log(`ha-voice-adapter listening on 0.0.0.0:${PORT} (deterministic fast paths; unmatched requests go to Main)`);
});
