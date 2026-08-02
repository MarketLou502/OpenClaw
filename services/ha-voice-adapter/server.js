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
const GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL || 'ws://127.0.0.1:18789';
const GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || 'openclaw-local-relay';
const VOICE_MAIN_MODEL = process.env.HA_VOICE_MAIN_MODEL ||
  'mlx-local/mlx-community/Meta-Llama-3.1-8B-Instruct-4bit';

const MLX_URL = process.env.MLX_SERVER_URL || 'http://127.0.0.1:8080/v1/chat/completions';
const MLX_MODEL = process.env.MLX_MODEL_ID || 'mlx-community/Meta-Llama-3.1-8B-Instruct-4bit';
const MLX_TIMEOUT_MS = Number(process.env.MLX_TIMEOUT_MS || 12000);
// Unmatched requests belong to Main. Voice selects the faster local MLX
// backend, but Main still supplies the identity, instructions, memory, tools,
// and conversation ownership. The model is execution infrastructure, not a
// second assistant or router.
const ESCALATE_SENTINEL = 'ESCALATE';

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

const DASHBOARD_SCRIPT = process.env.DASHBOARD_WORKFLOW_SCRIPT ||
  '/Users/aaronmacmini/.openclaw/workspace-main/scripts/dashboard-workflow.js';
const ECHO_APP_SCRIPT = process.env.ECHO_APP_WORKFLOW_SCRIPT ||
  '/Users/aaronmacmini/.openclaw/workspace-main/scripts/echo-app-workflow.js';
const CALENDAR_SCRIPT = process.env.CALENDAR_WORKFLOW_SCRIPT ||
  '/Users/aaronmacmini/.openclaw/workspace-main/scripts/calendar-workflow.js';
const HEALTH_SCRIPT = process.env.HEALTH_WORKFLOW_SCRIPT ||
  '/Users/aaronmacmini/.openclaw/workspace-health-tracker/scripts/health-workflow.js';
const NUTRITION_SCRIPT = process.env.NUTRITION_INDEX_SCRIPT ||
  '/Users/aaronmacmini/.openclaw/workspace-health-tracker/scripts/nutrition-index.js';
const DASHBOARD_NODE_BIN = process.env.OPENCLAW_NODE_BIN || '/opt/homebrew/opt/node@22/bin/node';
const CALENDAR_TIMEZONE = process.env.OPENCLAW_CALENDAR_TIMEZONE || 'America/New_York';

// Board keys used only if dashboard-workflow.js's own `list-boards` can't be
// reached at startup (e.g. dashboard-api is down) — matches today's real
// board set so the adapter can still start, but should never silently go
// stale, hence the loud warning wherever this is used.
const FALLBACK_BOARD_KEYS = ['work', 'market-lou', 'personal', 'grocery'];

function fetchBoardKeys() {
  return new Promise((resolve) => {
    const child = spawn(DASHBOARD_NODE_BIN, [DASHBOARD_SCRIPT, 'list-boards'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (c) => { stdout += c; });
    const fallback = () => {
      logErr('ha-voice-adapter: could not read board list from dashboard-workflow.js at startup — using fallback board list, which may be stale');
      resolve(FALLBACK_BOARD_KEYS);
    };
    child.on('close', () => {
      try {
        const parsed = JSON.parse(stdout);
        if (parsed.ok && Array.isArray(parsed.boards) && parsed.boards.length) {
          resolve(parsed.boards.map((b) => b.key));
          return;
        }
      } catch (_err) { /* fall through to fallback() below */ }
      fallback();
    });
    child.on('error', fallback);
  });
}

// Board names are generated from dashboard-workflow.js's own board list
// (the same source main's dashboard tools use) instead of a hand-typed
// literal here, so a board rename can't leave this enum stale the way
// 'accenture' did after the Work board was renamed.
function buildLocalTools(boardKeys) {
  return [
  {
    type: 'function',
    function: {
      name: 'list_items',
      description: "List open items on a task board, the grocery list, or the household's daily habits.",
      parameters: {
        type: 'object',
        properties: {
          board: { type: 'string', enum: [...boardKeys, 'habits'] },
        },
        required: ['board'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_item',
      description: 'Add a new item to a task board or the grocery list. Never use this for daily habits — habits are a fixed list and cannot be added to.',
      parameters: {
        type: 'object',
        properties: {
          board: { type: 'string', enum: boardKeys },
          text: { type: 'string', description: 'The item or task text' },
        },
        required: ['board', 'text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'complete_any',
      description: "Mark something done — a task, a grocery item, or a daily habit — by name. Use this for phrasing like 'I just did X', 'I finished X', 'mark X done', 'add X to the grocery list' after it's been bought, etc. It searches everything and asks for clarification itself if the name is ambiguous, so just pass the name as said.",
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The name of the habit, task, or item to mark done' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_custom_lists',
      description: "List Aaron's custom named lists (his own open-ended collections like 'Songs I Want to Learn' or 'Books' — NOT the Work/Personal/Market Lou task boards or the grocery list).",
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'show_custom_list',
      description: "Show what's on one of Aaron's custom named lists by name.",
      parameters: {
        type: 'object',
        properties: {
          list: { type: 'string', description: "The custom list's name, e.g. 'Songs I Want to Learn'" },
        },
        required: ['list'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_custom_list_item',
      description: "Add an item to one of Aaron's custom named lists. Use this whenever Aaron names a list that ISN'T Work, Personal, Market Lou, or the grocery list — e.g. 'add Wonderwall to my Songs I Want to Learn list'. If the list doesn't exist yet this will fail — that's expected, don't retry with a different tool.",
      parameters: {
        type: 'object',
        properties: {
          list: { type: 'string', description: "The custom list's name" },
          text: { type: 'string', description: 'The item to add' },
        },
        required: ['list', 'text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'complete_custom_list_item',
      description: 'Mark an item done on one of Aaron\'s custom named lists.',
      parameters: {
        type: 'object',
        properties: {
          list: { type: 'string', description: "The custom list's name" },
          item: { type: 'string', description: 'The item to mark done' },
        },
        required: ['list', 'item'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_calendar_events',
      description: "List what's on Aaron's calendar for a specific date. Resolve relative dates ('tomorrow', 'Friday') to a real date using today's date given above.",
      parameters: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'The date to check, as YYYY-MM-DD' },
        },
        required: ['date'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_calendar_event',
      description: "Add a new event to Aaron's calendar. Resolve relative dates/times to real values using today's date given above. Only for creating new events — never for moving or canceling an existing one.",
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'The event title' },
          date: { type: 'string', description: 'YYYY-MM-DD' },
          time: { type: 'string', description: '24-hour HH:MM' },
          durationMinutes: { type: 'integer', description: "Only include this if Aaron actually stated a length. Leave it out otherwise — don't guess a number, it defaults to 60 on its own." },
        },
        required: ['title', 'date', 'time'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'log_food',
      description: "Log something Aaron ate. Pass what he said he ate as plain text and the quantity if he gave one — don't estimate or state calories/protein yourself, the tool resolves that.",
      parameters: {
        type: 'object',
        properties: {
          description: { type: 'string', description: "What Aaron ate, e.g. 'protein shake' or 'chicken tortilla soup'" },
          quantity: { type: 'number', description: 'How many/much, defaults to 1 if not said' },
        },
        required: ['description'],
      },
    },
  },
  // First entry in what's meant to grow into a small set of "live external
  // data" tools (real HTTP lookups, not the model's own memory) — starting
  // with weather since it's a plain, unambiguous data fetch. Anything added
  // here later (e.g. real current-events/search) should follow the same
  // shape: a real fetch, not model judgment standing in for one.
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: 'Get real current weather conditions and today\'s forecast (high/low) for Aaron\'s location — an actual live lookup, not a guess. Use for any weather, temperature, rain, or forecast question.',
      parameters: { type: 'object', properties: {} },
    },
  },
  ];
}

let LOCAL_TOOLS;

// Computed fresh per-request (cheap) rather than cached at module load, so
// it's always accurate — needed for the local model to resolve relative
// dates/times ("tomorrow", "6pm tonight") into the literal YYYY-MM-DD /
// HH:MM calendar-workflow.js requires, in the same timezone it uses.
// Deliberately date-only, no clock time: this string is rebuilt fresh into
// the system prompt on every request, and mlx_lm.server's prompt cache is
// keyed on exact prefix match. Including HH:MM meant the prompt changed
// every single minute, defeating the cache and forcing a ~10-15s full
// reprocess on any two requests that didn't land in the same clock-minute —
// observed directly in mlx-server.log (2081/2081 tokens reprocessed) on a
// real "I just did a workout" request. Date-only changes once per day, so
// the prompt — and the cache hit — stays stable all day.
function currentDateTimeContext() {
  const now = new Date();
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: CALENDAR_TIMEZONE, weekday: 'long' }).format(now);
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: CALENDAR_TIMEZONE }).format(now); // en-CA gives YYYY-MM-DD
  return `Today is ${weekday}, ${date} (${CALENDAR_TIMEZONE}).`;
}

function buildLocalSystemPrompt() {
  return `You are a fast local assistant for a home voice speaker. Answer briefly and naturally in one or two short spoken sentences — no markdown, no lists, nothing that isn't speakable out loud.

${currentDateTimeContext()}

You have tools for the household's task boards, grocery list, daily habits, Aaron's own custom named lists, his calendar, and logging food he's eaten — use them whenever the request is about adding, checking, or completing anything in those. Don't narrate what you're going to do, just call the tool.

Work, Personal, and Market Lou are the only three task boards — they're fixed, and Aaron calls them "boards", not "lists" (e.g. "add X to my Market Lou board", or just "add X to Market Lou" with no word after it at all). Whenever you hear one of those three specific names — with or without the word "board" after it, or no trailing word at all — that's always this tool, never a custom list. If Aaron names something that ISN'T one of those three, isn't "grocery", and isn't a daily habit, THAT's when it's a custom list he made himself (e.g. "Songs I Want to Learn", "Books") — those get called "lists". Use the custom-list tools for it, don't force it into a task board and don't assume it doesn't exist.

For calendar requests: use today's date above to compute the actual date for anything relative ("tomorrow", "Friday", "next week") — always pass a real YYYY-MM-DD and 24-hour HH:MM, never the relative words themselves. Only handle checking what's on the calendar and adding new events this way — for moving or canceling an existing event, escalate instead, since picking the wrong event among similarly-named ones is a bigger mistake than being slow.

For "I had/ate X" or "log X for lunch/dinner/breakfast" — call the food-logging tool with just what Aaron said he ate and the quantity if he gave one. Don't try to guess or state calories/protein yourself — the tool resolves that for you.

For weather, temperature, rain, or forecast questions — use the weather tool. It's a real live lookup, not a guess.

For anything else you cannot help with — respond with EXACTLY the single word ${ESCALATE_SENTINEL} and nothing else:
- Rescheduling or canceling a calendar event (picking the wrong event among similarly-named ones is a bigger mistake than declining)
- Logging exercise or workouts, or any health information that isn't food eaten
- Anything that doesn't cleanly fit one of your tools

Otherwise — pure general knowledge, current events, or conversation — just answer directly and naturally, using what you know. If you're genuinely unsure or don't have current information on something, say so briefly rather than guessing with false confidence — but don't refuse just because it's about something recent; do your best.`;
}

function runDashboardWorkflow(args) {
  return new Promise((resolve) => {
    const child = spawn(DASHBOARD_NODE_BIN, [DASHBOARD_SCRIPT, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('close', () => {
      try {
        resolve(JSON.parse(stdout));
      } catch (err) {
        logErr(`ha-voice-adapter: dashboard-workflow parse failed: ${err.message}\n${stderr.slice(-500)}`);
        resolve({ ok: false, reply: null });
      }
    });
    child.on('error', (err) => {
      logErr(`ha-voice-adapter: dashboard-workflow spawn failed: ${err.message}`);
      resolve({ ok: false, reply: null });
    });
  });
}

// Shared spawn helper for the three new deterministic scripts below — unlike
// runDashboardWorkflow/runEchoAppWorkflow (left as-is to keep this diff
// focused), these three are new enough to share one implementation.
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

function runCalendarWorkflow(args) {
  return runWorkflowScript(CALENDAR_SCRIPT, args, 'calendar-workflow');
}

function runHealthWorkflow(args) {
  return runWorkflowScript(HEALTH_SCRIPT, args, 'health-workflow');
}

// Resolves a free-text food description to real calories/protein and logs
// it, trying three local tiers in order of trust before giving up. This is a
// deliberately isolated fast path; ordinary conversation is owned by Main.
//
// Tier 1 — exact staple match, confidence 1. Unchanged from before.
//
// Tier 2 — local USDA index search (nutrition-index.js), taking the
// top-ranked result deterministically, confidence 0.65. This is the same
// index health-tracker's own subagent protocol uses, just without a model
// picking between candidates. A prior version of this function tried this
// and reverted it after a bare "banana" query matched "Bananas, dehydrated,
// or banana powder" over "Bananas, raw" with nothing to catch the wrong
// pick — that risk is real and unfixed here too, it's just now an accepted
// tradeoff rather than an escalation trigger.
//
// Tier 3 — ask the local MLX model directly for a rough serving-aware
// estimate (confidence 0.4), same fallback health-tracker's protocol
// documents for restaurant items with no database match. Costs a second
// local inference call, so it's slower, but only fires on a full miss.
//
// Any tier that produces something writes it immediately — no tier here
// silently declines a resolvable food the way the old staple-only version
// did.
async function resolveAndLogFood(description, quantity, rawText) {
  const qty = quantity && quantity > 0 ? quantity : 1;

  const staple = await runHealthWorkflow(['find-staple', '--query', description]);
  if (staple.found && staple.staple) {
    return runHealthWorkflow([
      'log-food',
      '--idempotency-key', crypto.randomUUID(),
      '--resolution-type', 'staple',
      '--name', staple.staple.name,
      '--serving', staple.staple.serving,
      '--calories', String(staple.staple.calories * qty),
      '--protein', String(staple.staple.protein * qty),
      '--quantity', String(qty),
      '--confidence', '1',
      '--source-id', staple.staple.id,
      '--original', rawText,
      '--origin-channel', 'voice-pe-kitchen',
    ]);
  }
  log(`ha-voice-adapter: log_food no staple match for ${JSON.stringify(description)} — trying local USDA index`);

  const indexResult = await runWorkflowScript(NUTRITION_SCRIPT, ['search', '--query', description, '--limit', '5'], 'nutrition-index');
  const topMatch = indexResult.ok && Array.isArray(indexResult.matches) ? indexResult.matches[0] : null;
  if (topMatch) {
    const portion = topMatch.portions.find((p) => p.description !== 'Quantity not specified') || topMatch.portions[0];
    if (portion) {
      return runHealthWorkflow([
        'log-food',
        '--idempotency-key', crypto.randomUUID(),
        '--resolution-type', 'usda',
        '--name', topMatch.description,
        '--serving', portion.description,
        '--calories', String(Math.round(portion.calories * qty)),
        '--protein', String(Math.round(portion.protein * qty * 10) / 10),
        '--quantity', String(qty),
        '--confidence', '0.65',
        '--source-id', String(topMatch.fdcId),
        '--source-name', 'USDA FoodData Central (local index)',
        '--original', rawText,
        '--origin-channel', 'voice-pe-kitchen',
      ]);
    }
  }
  log(`ha-voice-adapter: log_food no USDA index match for ${JSON.stringify(description)} either — trying local model estimate`);

  const estimate = await estimateFoodLocally(description, qty);
  if (estimate) {
    return runHealthWorkflow([
      'log-food',
      '--idempotency-key', crypto.randomUUID(),
      '--resolution-type', 'estimate',
      '--name', description,
      '--serving', estimate.serving,
      '--calories', String(Math.round(estimate.calories * qty)),
      '--protein', String(Math.round(estimate.protein * qty * 10) / 10),
      '--quantity', String(qty),
      '--confidence', '0.4',
      '--original', rawText,
      '--origin-channel', 'voice-pe-kitchen',
    ]);
  }

  log(`ha-voice-adapter: log_food could not resolve ${JSON.stringify(description)} at any tier`);
  return { ok: false, reply: null };
}

// Tier 3 of resolveAndLogFood: a second, separate local MLX completion
// (non-streaming, no tools) asking only for a compact JSON nutrition
// estimate. Deliberately narrow and defensively parsed — a malformed or
// out-of-range response is treated the same as no estimate at all rather
// than logged, since a bad guess here writes directly to the health ledger.
async function estimateFoodLocally(description, qty) {
  try {
    const res = await fetch(MLX_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(MLX_TIMEOUT_MS),
      body: JSON.stringify({
        model: MLX_MODEL,
        messages: [
          {
            role: 'system',
            content: 'You estimate nutrition for a food log. Respond with ONLY a JSON object, no other text: {"serving": "<short serving description>", "calories": <number>, "protein": <number>}. Use typical/standard values for one serving of the described food.',
          },
          { role: 'user', content: description },
        ],
        max_tokens: 100,
        temperature: 0.2,
        stream: false,
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const content = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || '').trim();
    const jsonText = content.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    const parsed = JSON.parse(jsonText);
    const calories = Number(parsed.calories);
    const protein = Number(parsed.protein);
    const serving = String(parsed.serving || '').trim();
    if (!serving || !Number.isFinite(calories) || !Number.isFinite(protein) || calories <= 0 || calories > 3000 || protein < 0 || protein > 200) {
      logErr(`ha-voice-adapter: local food estimate out of range or malformed: ${jsonText}`);
      return null;
    }
    return { serving, calories, protein };
  } catch (err) {
    logErr(`ha-voice-adapter: local food estimate failed: ${err.message}`);
    return null;
  }
}

function runEchoAppWorkflow(args) {
  return new Promise((resolve) => {
    const child = spawn(DASHBOARD_NODE_BIN, [ECHO_APP_SCRIPT, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('close', () => {
      try {
        resolve(JSON.parse(stdout));
      } catch (err) {
        logErr(`ha-voice-adapter: echo-app-workflow parse failed: ${err.message}\n${stderr.slice(-500)}`);
        resolve({ ok: false, reply: null });
      }
    });
    child.on('error', (err) => {
      logErr(`ha-voice-adapter: echo-app-workflow spawn failed: ${err.message}`);
      resolve({ ok: false, reply: null });
    });
  });
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
// existing deterministic staple/USDA/local-estimate workflow. Questions
// about food do not match and therefore remain Main's responsibility.
function parseFoodReport(text) {
  const normalized = String(text || '').trim();
  const match = normalized.match(/^i\s+(?:just\s+)?(?:had|ate)\s+(.+?)(?:\s+(?:for\s+)?(?:breakfast|lunch|dinner|snack))?[.!?]?$/i)
    || normalized.match(/^log\s+(.+?)(?:\s+for\s+(?:breakfast|lunch|dinner|snack))?[.!?]?$/i);
  if (!match) return null;
  const description = match[1].trim();
  return description || null;
}

// Executes a real tool call against the actual deterministic scripts — never
// the model narrating a result, always a genuine script invocation.
// The local model has been observed appending stray text to otherwise-
// correct dates/times (e.g. "2026-08-02 00:00" instead of "2026-08-02") —
// extract the well-formed substring rather than trusting its formatting
// verbatim, since calendar-workflow.js's strict validation would otherwise
// bounce every request like this to escalation and defeat the point.
function normalizeDateArg(value) {
  const match = String(value || '').match(/\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : value;
}
function normalizeTimeArg(value) {
  const match = String(value || '').match(/([01]\d|2[0-3]):[0-5]\d/);
  return match ? match[0] : value;
}

async function executeLocalTool(name, args, rawText) {
  if (name === 'list_items') {
    const argv = args.board === 'habits' ? ['list-habits'] : ['list', '--board', args.board];
    return runDashboardWorkflow(argv);
  }
  if (name === 'add_item') {
    return runDashboardWorkflow(['add', '--board', args.board, '--text', args.text]);
  }
  if (name === 'complete_any') {
    return runDashboardWorkflow(['complete-any', '--query', args.query]);
  }
  if (name === 'list_custom_lists') {
    return runDashboardWorkflow(['list-lists']);
  }
  if (name === 'show_custom_list') {
    return runDashboardWorkflow(['show-list', '--list', args.list]);
  }
  if (name === 'add_custom_list_item') {
    return runDashboardWorkflow(['add-list-item', '--list', args.list, '--text', args.text]);
  }
  if (name === 'complete_custom_list_item') {
    return runDashboardWorkflow(['complete-list-item', '--list', args.list, '--item', args.item]);
  }
  if (name === 'list_calendar_events') {
    return runCalendarWorkflow(['list', '--date', normalizeDateArg(args.date)]);
  }
  if (name === 'add_calendar_event') {
    const argv = ['add', '--title', args.title, '--date', normalizeDateArg(args.date), '--time', normalizeTimeArg(args.time)];
    if (args.durationMinutes) argv.push('--duration', String(args.durationMinutes));
    return runCalendarWorkflow(argv);
  }
  if (name === 'log_food') {
    return resolveAndLogFood(args.description, args.quantity, rawText || args.description);
  }
  if (name === 'get_weather') {
    return getWeather();
  }
  return { ok: false, reply: null };
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

// Parses a tool call out of the model's response. mlx_lm.server doesn't
// populate the standard OpenAI `tool_calls` field for Llama 3.1's native
// tool-call format — it comes back as raw text prefixed with
// `<|python_tag|>` — so we check both shapes.
function parseToolCall(message) {
  if (message.tool_calls && message.tool_calls[0]) {
    const call = message.tool_calls[0].function;
    try {
      return { name: call.name, args: JSON.parse(call.arguments) };
    } catch (_err) {
      return null;
    }
  }
  const content = (message.content || '').trim();
  const tagged = content.startsWith('<|python_tag|>') ? content.slice('<|python_tag|>'.length) : content;
  try {
    const parsed = JSON.parse(tagged);
    if (parsed && typeof parsed.name === 'string') {
      return { name: parsed.name, args: parsed.parameters || {} };
    }
  } catch (_err) {
    // not a tool call
  }
  return null;
}

// Tries the local MLX server first, with real function-calling against the
// same deterministic scripts main uses. Returns { handled: true, reply } if
// it either answered directly or executed a real tool successfully, or
// { handled: false } if it escalated, errored, or timed out — the caller
// should fall through to main via the Gateway in that case.
// Streams the completion instead of waiting for one blocking JSON response.
// This exists purely for visibility: mlx_lm.server's own file logging only
// ever shows prompt-processing (prefill) progress, never anything about
// generation (decode) — so a request that starts responding immediately but
// rambles through most of its token budget looks identical, from outside,
// to one that's genuinely stuck. Streaming gives us time-to-first-token
// (prefill+queueing latency) separately from decode time, and — critically —
// a live chunk count even on a request we ultimately abort at the timeout,
// so a future slow/aborted case tells us "it had generated 240 tokens" vs
// "it had generated 0" instead of just "it took too long."
async function streamLocalMLXCompletion(text) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MLX_TIMEOUT_MS);
  const start = Date.now();
  let firstByteMs = null;
  let firstTokenMs = null;
  let chunkCount = 0;
  let content = '';
  let buffer = '';

  try {
    const res = await fetch(MLX_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: MLX_MODEL,
        messages: [
          { role: 'system', content: buildLocalSystemPrompt() },
          { role: 'user', content: text },
        ],
        tools: LOCAL_TOOLS,
        max_tokens: 300,
        temperature: 0.2,
        stream: true,
      }),
    });
    if (!res.ok) {
      return { ok: false, content, chunkCount, firstByteMs, firstTokenMs, totalMs: Date.now() - start, error: `HTTP ${res.status}` };
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (firstByteMs === null) firstByteMs = Date.now() - start;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep any incomplete trailing line for next read
      for (const line of lines) {
        if (!line || line.startsWith(':')) continue; // SSE keepalive/comment (sent during prefill)
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        let parsed;
        try { parsed = JSON.parse(payload); } catch (_e) { continue; }
        const delta = parsed.choices && parsed.choices[0] && parsed.choices[0].delta;
        if (delta && delta.content) {
          if (firstTokenMs === null) firstTokenMs = Date.now() - start;
          content += delta.content;
          chunkCount += 1;
        }
      }
    }
    return { ok: true, content, chunkCount, firstByteMs, firstTokenMs, totalMs: Date.now() - start };
  } catch (err) {
    return { ok: false, content, chunkCount, firstByteMs, firstTokenMs, totalMs: Date.now() - start, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

async function tryLocal(text, rt) {
  const stream = await streamLocalMLXCompletion(text);
  rt.mark(`local MLX stream ${stream.ok ? 'done' : 'aborted'}: total ${stream.totalMs}ms, first byte +${stream.firstByteMs}ms, first token +${stream.firstTokenMs}ms, ${stream.chunkCount} chunks, ${stream.content.length} chars${stream.error ? ` — ${stream.error}` : ''}`);
  if (!stream.ok) {
    logErr(`ha-voice-adapter: local MLX call failed: ${stream.error} (had streamed ${stream.chunkCount} chunks / ${JSON.stringify(stream.content.slice(0, 200))})`);
    return { handled: false };
  }
  try {
    const message = { content: stream.content };
    log(`ha-voice-adapter: local model raw response: ${JSON.stringify(message.content)}`);

    const toolCall = parseToolCall(message);
    if (toolCall) {
      log(`ha-voice-adapter: local tool call: ${toolCall.name} ${JSON.stringify(toolCall.args)}`);
      const toolStart = Date.now();
      const result = await executeLocalTool(toolCall.name, toolCall.args, text);
      rt.mark(`local tool exec (${toolCall.name}) done (took ${Date.now() - toolStart}ms)`);
      if (!result.reply) {
        // The script itself failed/couldn't parse — don't guess, escalate.
        return { handled: false };
      }
      return { handled: true, reply: result.reply };
    }

    const content = (message.content || '').trim();
    // Anything this short and single-word-ish is far more likely to be a
    // garbled attempt at the sentinel (typos happen — "EXCALATE" showed up
    // in testing) than a genuine final answer. Don't trust it either way;
    // escalating on a false positive costs a bit more, but returning
    // garbage text as a confident answer is worse.
    const looksLikeSentinelAttempt = !content.includes(' ') && content.length < 20;
    if (!content || looksLikeSentinelAttempt || content.toUpperCase().includes(ESCALATE_SENTINEL)) {
      return { handled: false };
    }
    return { handled: true, reply: content };
  } catch (err) {
    logErr(`ha-voice-adapter: local tool handling failed: ${err.message}`);
    return { handled: false };
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
    .replace(/\n+/g, '. ')
    .replace(/\s{2,}/g, ' ')
    .trim();
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
function runAgentTurn({ text, deviceSlug, model, rt }) {
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
            // Voice fast paths already own mutations and live lookups. Main's
            // unmatched path is conversation/general judgment, so use the
            // gateway's lean prompt modes instead of sending the local model
            // the full 30+ tool schemas and every bootstrap document.
            promptMode: 'none',
            modelRun: true,
            bootstrapContextMode: 'lightweight',
            extraSystemPrompt: 'This is a Home Assistant voice turn. Reply with one or two concise, natural spoken sentences. Answer general knowledge directly. Do not use markdown.',
            ...(model ? { model } : {}),
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
    if (routine.handled) {
      rt.mark(`shared routine (${routine.route}) done, total ${rt.elapsed()}ms`);
      sendJson(res, 200, { reply: stripForSpeech(routine.reply) });
      return;
    }

    if (isWeatherRequest(text)) {
      const result = await getWeather();
      rt.mark(`weather workflow done, total ${rt.elapsed()}ms`);
      const reply = result.reply || 'Sorry, I could not get the weather right now.';
      sendJson(res, 200, { reply: stripForSpeech(reply) });
      return;
    }

    const foodDescription = parseFoodReport(text);
    if (foodDescription) {
      const result = await resolveAndLogFood(foodDescription, null, text);
      rt.mark(`food workflow done, total ${rt.elapsed()}ms`);
      const reply = result.reply || 'Sorry, I could not log that food right now.';
      sendJson(res, 200, { reply: stripForSpeech(reply) });
      return;
    }

    rt.mark(`no deterministic fast path matched; forwarding to Main`);
    await resetEscalationSessionIfIdle(deviceSlug, rt);
    const result = await runAgentTurn({ text, deviceSlug, model: VOICE_MAIN_MODEL, rt });
    rt.mark(`Main turn done, total ${rt.elapsed()}ms`);
    sendJson(res, 200, { reply: stripForSpeech(result.reply) });
  });
});

server.listen(PORT, '0.0.0.0', () => {
  log(`ha-voice-adapter listening on 0.0.0.0:${PORT} (deterministic fast paths; unmatched requests go to Main)`);
});
