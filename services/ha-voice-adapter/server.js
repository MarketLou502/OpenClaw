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

const HEALTH_SCRIPT = process.env.HEALTH_WORKFLOW_SCRIPT ||
  '/Users/aaronmacmini/.openclaw/workspace-health-tracker/scripts/health-workflow.js';
const NUTRITION_INDEX_SCRIPT = process.env.NUTRITION_INDEX_SCRIPT ||
  '/Users/aaronmacmini/.openclaw/workspace-health-tracker/scripts/nutrition-index.js';
const QUANTITY_PARSER = process.env.QUANTITY_PARSER_SCRIPT ||
  '/Users/aaronmacmini/.openclaw/workspace-health-tracker/scripts/lib/quantity-parser.js';
const DASHBOARD_NODE_BIN = process.env.OPENCLAW_NODE_BIN || '/opt/homebrew/opt/node@22/bin/node';

// Shared spawn helper for deterministic script invocations.
function runWorkflowScript(script, args, label) {
  return new Promise((resolve) => {
    const child = spawn(DASHBOARD_NODE_BIN, [script, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('close', () => {
      try {
        resolve(JSON.parse(stdout));
      } catch (err) {
        logErr(`ha-voice-adapter: ${label} parse failed: ${err.message}\n${stderr.slice(-500)}`);
        resolve({ ok: false, reply: null });
      }
    });
    child.on('error', (err) => {
      logErr(`ha-voice-adapter: ${label} spawn failed: ${err.message}`);
      resolve({ ok: false, reply: null });
    });
  });
}

function runHealthWorkflow(args) {
  return runWorkflowScript(HEALTH_SCRIPT, args, 'health-workflow');
}

// The USDA nutrition-index is a separate script (same node runtime), searched
// via the same deterministic spawn helper. Returns the shape nutrition-index.js
// `search` emits: { ok, matches: [...] } or { ok:false } on failure.
function searchUsda(query, limit = 3) {
  return runWorkflowScript(NUTRITION_INDEX_SCRIPT, ['search', '--query', query, '--limit', String(limit)], 'nutrition-index');
}

// Fast local path for food reports: exact personal-recipe match only,
// confidence 1, no judgment required. Recipes are shared with meal-planner
// in the unified recipe database. Anything else — no recipe match, an
// ambiguous quantity ("half a cup"), an unrecognized food — needs real
// interpretation, which is Main -> health-tracker's job (HEALTH_ROUTING.md).
// That specialist runs the recipe -> USDA-index -> Haiku-estimate
// protocol (HEALTH_WORKFLOW_DESIGN.md) but with an actual model doing the
// quantity parsing and candidate picking this fast path can't.
//
// This used to also carry a local USDA-index tier and a local-MLX-estimate
// tier, removed 2026-08-02: the USDA tier searched on the raw, unstripped
// phrase (no quantity parsing existed here), so "a half a cup of yogurt"
// missed a match that bare "yogurt" hits cleanly; the local-estimate tier
// then depended on the local MLX server, which was intermittently
// overloaded enough to blow its own timeout mid-request. Falling through to
// Main/health-tracker for anything past a recipe hit sidesteps both.
async function tryRecipeFood(description, rawText) {
  const recipe = await runHealthWorkflow(['find-recipe', '--query', description]);
  if (!recipe.found || !recipe.recipe) return null;
  return runHealthWorkflow([
    'log-food',
    '--idempotency-key', crypto.randomUUID(),
    '--resolution-type', 'recipe',
    '--name', recipe.recipe.name,
    '--serving', recipe.recipe.serving,
    '--calories', String(recipe.recipe.calories),
    '--protein', String(recipe.recipe.protein),
    '--quantity', '1',
    '--confidence', '1',
    '--source-id', recipe.recipe.id,
    '--original', rawText,
    '--origin-channel', 'voice-pe-kitchen',
  ]);
}

// ─── USDA fast path (Tier 2) ─────────────────────────────────────────────────
//
// Adds a USDA tier between the recipe check and the Main fallthrough. This
// only works because the quantity parser now strips the leading quantity and
// unit ("half a cup of yogurt" → food "yogurt", ~122g) before searching the
// USDA index — the previous USDA tier (removed 2026-08-02) searched the raw
// unstripped phrase and missed clean matches. The USDA data is per-100g, so
// the parsed gram weight scales it proportionally.
//
// Confidence is computed from two signals (food-name match quality and whether
// the portion weight came from a real USDA portion vs a hardcoded default),
// per USDA_TIER_2_PLAN.md. Matches below MIN_USDA_CONFIDENCE fall through to
// Main rather than being logged on a guess.
const MIN_USDA_CONFIDENCE = 0.5;

// Token-overlap score between the parsed food name and a USDA description.
// Returns a 0..1 fraction of the food-name's own tokens that also appear in
// the description (so "yogurt" vs "Yogurt, NFS" scores 1 even though the
// strings differ). Uses singularization so "banana" ↦ "Bananas, raw" scores
// 1 (banana ~ bananas).
function foodNameMatchScore(foodName, description) {
  const tokens = (str) => new Set(Array.from(String(str || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean), singularize));
  const foodTokens = tokens(foodName);
  const descTokens = tokens(description);
  if (foodTokens.size === 0) return 0;
  let overlap = 0;
  for (const token of foodTokens) if (descTokens.has(token)) overlap += 1;
  return overlap / foodTokens.size;
}

// Crude singularization for matching: "egg" ↦ "eggs", "cookies" ↦ "cookie".
// Only strips a trailing s/es — good enough for food-name matching without a
// real stemmer.
function singularize(word) {
  return String(word || '').toLowerCase().replace(/es$/, '').replace(/s$/, '');
}

// Decides whether a USDA description is a reliable match for the parsed food
// name, beyond just sharing a token. The BM25 index surfaces generic foods
// poorly ("soda" → "Bread, Irish soda bread"; "oatmeal" → "Bread, oatmeal";
// "rice" → "Snacks, rice cracker"), so we demand the food name be the PRIMARY
// noun of the hit, not a trailing flavor/modifier:
//   * single-token food name: its singularized form must equal the FIRST word
//     of the description ("yogurt" ↦ "Yogurt, NFS"; "oatmeal" ↛ "Bread,
//     oatmeal").
//   * multi-token food name: >= 0.5 token overlap ("chicken breast" ↦
//     "Chicken breast tenders").
function isReliableFoodMatch(foodName, description) {
  const foodTokens = String(foodName || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (foodTokens.length === 0) return false;
  const words = String(description || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (words.length === 0) return false;

  if (foodTokens.length === 1) {
    // Single-token food names must be the primary (first) noun.
    return singularize(words[0]) === singularize(foodTokens[0]);
  }
  return foodNameMatchScore(foodName, description) >= 0.5;
}

// Confidence table from USDA_TIER_2_PLAN.md. `exactFood` = the parsed food
// name's tokens appear in the match description; `exactPortion` = the gram
// weight was refined from a real USDA portion (not a hardcoded default).
function computeUsdaConfidence({ foodName, description, refinedFromUsda, matchCount }) {
  const exactFood = foodNameMatchScore(foodName, description) >= 0.5;
  if (exactFood && refinedFromUsda) return 0.95;
  if (exactFood && !refinedFromUsda) return 0.85;
  if (!exactFood && refinedFromUsda) return 0.75;
  // Fuzzy + generic portion: multiple close candidates makes it weaker.
  if (!exactFood && !refinedFromUsda && matchCount > 1) return 0.50;
  return 0.60;
}

// Searches the USDA index, parses the quantity, scales the per-100g nutrition
// to the spoken portion, and logs with --resolution-type usda. Returns the
// log-food result, or null when nothing confident was found (falls through to
// Main). Mirrors the flow in USDA_TIER_2_PLAN.md's tryUSDAFood pseudocode.
async function tryUSDAFood(description, rawText) {
  // 1. Parse the quantity (with USDA portion refinement so "a cup of yogurt"
  //    uses the yogurt database's own 245g/cup rather than the 240g default).
  let parsed;
  try {
    const { parseQuantity } = require(QUANTITY_PARSER);
    parsed = await parseQuantity(description, { usdaSearch: searchUsda });
  } catch (err) {
    logErr(`ha-voice-adapter: quantity parse failed: ${err.message}`);
    return null;
  }
  if (!parsed.foodName || parsed.grams <= 0) return null;

  // 2. Search the USDA index on the stripped food name.
  const search = await searchUsda(parsed.foodName, 3);
  if (!search || !search.ok || !Array.isArray(search.matches) || search.matches.length === 0) return null;

  // 3. Pick the best match: the highest-ranked candidate that is a reliable
  //    food-name match, preferring the most generic (shortest) description so
  //    "a banana" lands on "Bananas, raw" not "Bananas, dehydrated, or banana
  //    powder", and "a cup of milk" on "Milk, NFS" not "Milk, producer, fluid".
  //    The top BM25 hit is often a composite/specific product ("a cup of
  //    yogurt" → "Tofu yogurt" ranks above "Yogurt, NFS"), and clear mismatches
  //    ("soda" → "Irish soda bread") fail every candidate and fall through to
  //    Main rather than logging a wrong guess.
  let match = null;
  let matchWords = Infinity;
  for (const candidate of search.matches) {
    if (!isReliableFoodMatch(parsed.foodName, candidate.description)) continue;
    const wordCount = String(candidate.description).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).length;
    if (wordCount < matchWords) {
      match = candidate;
      matchWords = wordCount;
    }
  }
  if (!match) return null;

  const confidence = computeUsdaConfidence({
    foodName: parsed.foodName,
    description: match.description,
    refinedFromUsda: parsed.refinedFromUsda,
    matchCount: search.matches.length,
  });
  if (confidence < MIN_USDA_CONFIDENCE) return null;

  // 4. Scale per-100g nutrition to the spoken portion.
  const scaleFactor = parsed.grams / 100;
  const calories = Math.round(match.caloriesPer100g * scaleFactor);
  const protein = Math.round(match.proteinPer100g * scaleFactor * 10) / 10;

  // 5. Log it with the USDA resolution type so the audit trail shows the
  //    source. Serving is the parsed gram weight; quantity is the parsed count.
  return runHealthWorkflow([
    'log-food',
    '--idempotency-key', crypto.randomUUID(),
    '--resolution-type', 'usda',
    '--name', match.description,
    '--serving', `${parsed.grams}g`,
    '--calories', String(calories),
    '--protein', String(protein),
    '--quantity', String(parsed.quantity),
    '--confidence', String(confidence),
    '--source-id', String(match.fdcId),
    '--original', rawText,
    '--origin-channel', 'voice-pe-kitchen',
  ]);
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

function isWeatherRequest(text) {
  const normalized = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return /\b(weather|forecast|temperature|rain(?:ing)?|snow(?:ing)?|humidity)\b/.test(normalized);
}

// Food reports are a frequent, explicit voice action. The matcher only
// accepts first-person logging phrasing, then passes the food phrase to the
// existing deterministic recipe/USDA/local-estimate workflow. Questions
// about food do not match and therefore remain Main's responsibility.
function parseFoodReport(text) {
  const normalized = String(text || '').trim();
  const match = normalized.match(/^i\s+(?:just\s+)?(?:had|ate)\s+(.+?)(?:\s+(?:for\s+)?(?:breakfast|lunch|dinner|snack))?[.!?]?$/i)
    || normalized.match(/^log\s+(.+?)(?:\s+for\s+(?:breakfast|lunch|dinner|snack))?[.!?]?$/i);
  if (!match) return null;
  const description = match[1].trim();
  return description || null;
}

// Real live lookup — no location param (yet): a bare wttr.in request
// geo-resolves from the Mac's own outbound IP, which is correct for a
// fixed-location home device and confirmed working (resolves to Aaron's
// actual city). Revisit if this ever needs to answer for a different
// location. Deterministically templates the reply itself rather than
// handing raw data back for a second model pass — matches every other
// local tool's shape (this adapter's local path is single-shot: one
// function call in, one reply out, no second inference round).
async function getWeather() {
  try {
    const res = await fetch('https://wttr.in/?format=j1', { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return { ok: false, reply: null };
    const data = await res.json();
    const current = data.current_condition && data.current_condition[0];
    const today = data.weather && data.weather[0];
    if (!current || !today) return { ok: false, reply: null };
    const desc = (current.weatherDesc && current.weatherDesc[0] && current.weatherDesc[0].value || 'unknown conditions').toLowerCase();
    const reply = `Right now it's ${current.temp_F}°F and ${desc}, feels like ${current.FeelsLikeF}°F. Today's high is ${today.maxtempF}°F, low ${today.mintempF}°F.`;
    return { ok: true, reply };
  } catch (err) {
    logErr(`ha-voice-adapter: weather fetch failed: ${err.message}`);
    return { ok: false, reply: null };
  }
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
function runAgentTurn({ text, deviceSlug, rt }) {
  return new Promise((resolve) => {
    const sessionKey = `home_assistant:${deviceSlug}`;
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
            agentId: 'main',
            sessionKey,
            deliver: false,
            timeout: Math.ceil(AGENT_TIMEOUT_MS / 1000),
            idempotencyKey: crypto.randomUUID(),
            // Voice fast paths already own mutations and live lookups, so
            // Main's unmatched path stays on the lean/no-bootstrap-docs
            // prompt shape (same "minimal" mode already used for ordinary
            // subagent delegation elsewhere — not the bare "none" identity
            // line this used to send). Critically, modelRun must NOT be set
            // here: it silently strips every tool (including sessions_spawn)
            // regardless of promptMode — confirmed empirically, not just
            // from its type comment ("no tools, no workspace/chat prompt
            // policy") — which is what left Main unable to delegate to
            // `lists`/`meal-planner`/etc. at all. No model override either: Main
            // runs as itself (its own configured Haiku-primary/local
            // fallback), not forced onto the local model, now that the
            // context is small enough for that to be cheap.
            promptMode: 'minimal',
            bootstrapContextMode: 'lightweight',
            // Previously told Main to spawn + immediately return a reply,
            // which raced sessions_yield ending Main's turn before the
            // subagent's real result existed — Main narrated the "accepted"
            // ack as if it were the outcome, then was changed to poll
            // session_status within a bounded budget instead.
            //
            // History of this prompt drifting from workspace-main/TOOLS.md
            // (full incident writeups there and in memory, not repeated
            // here): stale sessions_spawn instead of sessions_send
            // (2026-08-02), a missing health-tracker route once food reports
            // started falling through to Main (2026-08-02), and a missing
            // agentId/sessionKey warning that made Main message itself in a
            // loop instead of reaching health-tracker (2026-08-07). All
            // three happened because this was a second, hand-typed copy of
            // TOOLS.md's routing table with no shared source of truth.
            // 2026-08-07 fixed that by reading just the marked routing block
            // fresh off disk on every turn — but a fourth drift (2026-08-08)
            // showed a curated extract has the same failure shape as a
            // hand-typed copy: TOOLS.md's Role section governs delegation
            // being mandatory, and it lived outside the extracted block, so
            // Main had no workspace docs (bootstrapContextMode:'lightweight'
            // below) and no instruction telling it delegation wasn't
            // optional — it just answered a food-log message conversationally
            // instead of calling sessions_send. Fixed by loadToolsDoc()
            // reading TOOLS.md's full content instead of a marked subset —
            // this file only supplies the genuinely voice-specific bit
            // (reply-style formatting) prepended below; everything about
            // delegation, routing, and the hard rules comes from TOOLS.md
            // itself, verbatim, with nothing left to curate or drift.
            extraSystemPrompt: `This is a Home Assistant voice turn — reply in one or two concise, natural spoken sentences with no markdown. Do not attempt delegated actions directly yourself. Use timeoutSeconds: ${VOICE_POLL_BUDGET_SECONDS} on every sessions_send call.\n\n${loadToolsDoc()}`,
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

    if (isWeatherRequest(text)) {
      const result = await getWeather();
      rt.mark(`weather workflow done, total ${rt.elapsed()}ms`);
      const reply = result.reply || 'Sorry, I could not get the weather right now.';
      sendJson(res, 200, { reply: stripForSpeech(reply), expectsReply: false });
      appendVoiceFastPathLog({ route: 'weather', request: text, reply, deviceSlug });
      return;
    }

    const foodDescription = parseFoodReport(text);
    if (foodDescription) {
      const recipe = await tryRecipeFood(foodDescription, text);
      if (recipe) {
        rt.mark(`food recipe match done, total ${rt.elapsed()}ms`);
        const reply = recipe.reply || 'Sorry, I could not log that food right now.';
        sendJson(res, 200, { reply: stripForSpeech(reply), expectsReply: false });
        return;
      }
      // No recipe -> try the USDA tier before falling through to Main.
      const usda = await tryUSDAFood(foodDescription, text);
      if (usda) {
        rt.mark(`food USDA match done (${JSON.stringify(foodDescription)}), total ${rt.elapsed()}ms`);
        const reply = usda.reply || 'Sorry, I could not log that food right now.';
        sendJson(res, 200, { reply: stripForSpeech(reply), expectsReply: false });
        appendVoiceFastPathLog({ route: 'usda-food', intent: 'usda', request: text, reply, deviceSlug });
        return;
      }
      rt.mark(`food report ${JSON.stringify(foodDescription)} has no recipe/USDA match; forwarding to Main`);
    } else {
      rt.mark(`no deterministic fast path matched; forwarding to Main`);
    }

    await resetEscalationSessionIfIdle(deviceSlug, rt);
    const result = await runAgentTurn({ text, deviceSlug, rt });
    rt.mark(`Main turn done, total ${rt.elapsed()}ms`);
    sendJson(res, 200, { reply: stripForSpeech(result.reply), expectsReply: expectsFollowUp(result.reply) });
  });
});

server.listen(PORT, '0.0.0.0', () => {
  log(`ha-voice-adapter listening on 0.0.0.0:${PORT} (deterministic fast paths; unmatched requests go to Main)`);
});
