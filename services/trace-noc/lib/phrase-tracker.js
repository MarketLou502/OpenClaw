'use strict';

// Surfaces recent voice/text utterances that didn't get a deterministic fast
// path, so a human can decide whether to add them to the router's grammar.
// Feeds the Fast Router Proposals left column (Recent).
//
// No structured "every utterance + outcome" dataset exists anywhere in
// OpenClaw today, so this reuses TraceStore's existing aggregation of session
// transcripts + logs/voice-fastpath.jsonl rather than adding new logging.
// See workspace-systems-qa/state/phrase-flags.json for persisted flag state.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { routeToAgent } = require('./trace-store');

const FREQ_WINDOW_DAYS_DEFAULT = 30;
const MATCH_CONFIDENCE_FLOOR = 0.4; // min vocab-overlap score to target an existing intent
const MATCH_CONFIDENCE_MARGIN = 0.15; // required lead over the runner-up intent

const STOPWORDS = new Set([
  'a', 'an', 'the', 'my', 'me', 'is', 'it', 'to', 'for', 'of', 'on', 'in', 'at',
  'do', 'does', 'did', 'i', 'im', "i'm", 'just', 'please', 'can', 'you', 'and',
  'or', 'that', 'this', 'be', 'am', 'are', 'was', 'were', 'with', 'from', 'all',
]);

// Mirrors services/shared-routine-router/index.js's routeRoutineRequest switch
// (the route string it returns per matched intent) and the YAML intent keys
// that back each one. Must be updated by hand if that switch changes.
// 'nevermind-cancel' is intentionally omitted — it's special-cased before
// matchIntent runs and has no grammar YAML backing it.
const ROUTE_TO_YAML = {
  'workout-log': { file: 'health.yaml', intents: ['WorkoutLog'] },
  'daily-run-log': { file: 'health.yaml', intents: ['DailyRunLog'] },
  'calendar-add': { file: 'calendar.yaml', intents: ['AddCalendar'] },
  'dashboard-add': { file: 'dashboard.yaml', intents: ['AddToBoard'] },
  'dashboard-list': { file: 'dashboard.yaml', intents: ['ListBoard'] },
  'dashboard-complete': { file: 'dashboard.yaml', intents: ['CompleteItem'] },
  'dashboard-complete-any': { file: 'dashboard.yaml', intents: ['CompleteItem', 'CompleteAnyFree'] },
  'dashboard-remove': { file: 'dashboard.yaml', intents: ['RemoveFromBoard'] },
  'dashboard-complete-habit': { file: 'dashboard.yaml', intents: ['CompleteHabit'] },
  'dashboard-add-list-item': { file: 'dashboard.yaml', intents: ['AddListItem'] },
  'dashboard-complete-list-item': { file: 'dashboard.yaml', intents: ['CompleteListItem'] },
  'calendar-list': { file: 'calendar.yaml', intents: ['ListCalendar'] },
  'calendar-delete': { file: 'calendar.yaml', intents: ['DeleteCalendar'] },
  'calendar-reschedule': { file: 'calendar.yaml', intents: ['RescheduleCalendar'] },
  'finance-add-expense': { file: 'finance.yaml', intents: ['AddExpense'] },
  'health-list-today': { file: 'health.yaml', intents: ['ListToday'] },
  'health-activity-today': { file: 'health.yaml', intents: ['ActivityToday'] },
  'health-correct-food': { file: 'health.yaml', intents: ['CorrectFood'] },
  'health-remove-food': { file: 'health.yaml', intents: ['RemoveFood'] },
  'health-undo': { file: 'health.yaml', intents: ['UndoFood'] },
  // meal-planner-* routes removed 2026-08-08 — sentences/en/meal-planner.yaml
  // was disabled (renamed .disabled) and the matching switch cases dropped
  // from routeRoutineRequest, so those routes can no longer be produced.
  // dashboard-list-habits/dashboard-list-lists/dashboard-create-list/
  // dashboard-show-list/dashboard-schedule/dashboard-reschedule/
  // dashboard-unschedule removed 2026-08-10 along with their YAML intents
  // (ListHabits/ListLists/CreateList/ShowList/ScheduleItem/RescheduleItem/
  // UnscheduleItem/ListAllBoards) — see index.js's routeRoutineRequest for
  // the removal note.
};

// ─── Text helpers ────────────────────────────────────────────────────────────

function normalizePhraseText(value) {
  return String(value || '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[.!?]+$/, '');
}

function wordsOf(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 2 && !STOPWORDS.has(w));
}

// ─── Grammar-file line extractor (regex-based — this service has zero npm
// dependencies and the three sentence files share one consistent indent
// style, so a general YAML parser isn't worth adding) ───────────────────────

const _grammarCache = new Map();

function loadGrammarFile(routerDir, filename) {
  const key = filename;
  const filePath = path.join(routerDir, 'sentences', 'en', filename);
  let stat;
  try { stat = fs.statSync(filePath); } catch { return null; }
  const cached = _grammarCache.get(key);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.data;

  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split('\n');
  const intents = [];
  let current = null;
  let inIntentsBlock = false;

  lines.forEach((line, lineIndex) => {
    if (/^intents:\s*$/.test(line)) { inIntentsBlock = true; return; }
    if (/^\w/.test(line) && line.trim()) { inIntentsBlock = false; current = null; return; } // any other top-level key (e.g. "lists:") ends the intents block
    if (!inIntentsBlock) return;
    const intentHeader = line.match(/^ {2}(\w+):\s*$/);
    if (intentHeader) {
      current = { name: intentHeader[1], headerLine: lineIndex, sentenceLines: [] };
      intents.push(current);
      return;
    }
    const sentenceLine = line.match(/^( {10,})- "(.*)"\s*$/);
    if (sentenceLine && current) {
      current.sentenceLines.push({ lineIndex, indent: sentenceLine[1], text: sentenceLine[2] });
    }
  });

  const data = { path: filePath, lines, intents };
  _grammarCache.set(key, { mtimeMs: stat.mtimeMs, data });
  return data;
}

function extractLiteralVocabulary(patternText) {
  const stripped = String(patternText || '')
    .replace(/\{[^}]*\}/g, ' ') // {slot} placeholders
    .replace(/[()[\]|]/g, ' '); // hassil alternation/optional syntax
  return new Set(wordsOf(stripped));
}

function pickBestIntentForPhrase(routerDir, candidateText) {
  const candidateWords = wordsOf(candidateText);
  if (!candidateWords.length) return null;
  const candidateSet = new Set(candidateWords);

  const scored = [];
  for (const [route, mapping] of Object.entries(ROUTE_TO_YAML)) {
    const grammar = loadGrammarFile(routerDir, mapping.file);
    if (!grammar) continue;
    for (const intentName of mapping.intents) {
      const intent = grammar.intents.find((i) => i.name === intentName);
      if (!intent) continue;
      const vocab = new Set();
      for (const sentence of intent.sentenceLines) {
        for (const word of extractLiteralVocabulary(sentence.text)) vocab.add(word);
      }
      let overlap = 0;
      for (const word of candidateSet) if (vocab.has(word)) overlap += 1;
      const score = overlap / candidateSet.size;
      scored.push({ route, file: mapping.file, intentName, score });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  const top = scored[0];
  const runnerUp = scored[1];
  if (!top || top.score < MATCH_CONFIDENCE_FLOOR) return null;
  if (runnerUp && top.score - runnerUp.score < MATCH_CONFIDENCE_MARGIN) return null;
  return top;
}

// ─── Router target catalog ──────────────────────────────────────────────────
// Powers the "link to an existing fast route" picker: every {route,
// intentName} pair ROUTE_TO_YAML already knows about, grouped by the agent
// that actually handles it, with a couple of sample sentences so a human can
// recognize the right target without opening the grammar file. Deliberately
// reuses ROUTE_TO_YAML/routeToAgent as the single source of truth rather than
// inventing a parallel catalog — anything added there shows up here for free.
function listRouterTargets(routerDir) {
  const targets = [];
  for (const [route, mapping] of Object.entries(ROUTE_TO_YAML)) {
    const grammar = loadGrammarFile(routerDir, mapping.file);
    if (!grammar) continue;
    for (const intentName of mapping.intents) {
      const intent = grammar.intents.find((i) => i.name === intentName);
      if (!intent) continue;
      targets.push({
        route,
        intentName,
        file: mapping.file,
        agent: routeToAgent(route) || 'main',
        sampleSentences: intent.sentenceLines.slice(-3).map((s) => s.text),
        patternCount: intent.sentenceLines.length,
      });
    }
  }
  return targets.sort((a, b) => a.agent.localeCompare(b.agent) || a.intentName.localeCompare(b.intentName));
}

// Only ROUTE_TO_YAML entries are ever accepted as a manual target — this is
// the sole gate against a client-supplied file/intentName pair pointing
// draftAdditionDiffForTarget at an arbitrary path.
function resolveRouterTarget(route, intentName, file) {
  const mapping = ROUTE_TO_YAML[route];
  if (!mapping || mapping.file !== file || !mapping.intents.includes(intentName)) return null;
  return { route, file, intentName };
}

// ─── Diff drafting ────────────────────────────────────────────────────────────
// Deliberately narrow: only ever appends one literal sentence line to an
// existing intent's pattern list. Never invents a new intent or file — the
// existing apply script (qa-apply-diff.sh) requires the target file to
// already exist, and hand-authoring new hassil grammar shapes from a raw
// phrase is a much harder, much riskier generation task than this covers.
function draftAdditionDiff(routerDir, proposedDir, candidateText) {
  const match = pickBestIntentForPhrase(routerDir, candidateText);
  if (!match) return { ok: false, reason: 'no-confident-match' };
  return writeAdditionDiff(routerDir, proposedDir, candidateText, match);
}

// Same output as draftAdditionDiff, but the target intent is chosen by a
// human via the router-target picker instead of guessed from vocabulary
// overlap — for phrases (like "I just studied Spanish") that describe a
// capability a fast path already covers under different wording than
// pickBestIntentForPhrase's word-overlap heuristic can find.
function draftAdditionDiffForTarget(routerDir, proposedDir, candidateText, target) {
  const resolved = resolveRouterTarget(target?.route, target?.intentName, target?.file);
  if (!resolved) return { ok: false, reason: 'unknown-target' };
  return writeAdditionDiff(routerDir, proposedDir, candidateText, resolved);
}

function writeAdditionDiff(routerDir, proposedDir, candidateText, match) {
  const grammar = loadGrammarFile(routerDir, match.file);
  const intent = grammar?.intents.find((i) => i.name === match.intentName);
  if (!intent || !intent.sentenceLines.length) return { ok: false, reason: 'no-confident-match' };

  const lastSentence = intent.sentenceLines[intent.sentenceLines.length - 1];
  const newLineText = normalizePhraseText(candidateText).replace(/"/g, '\\"');
  const newLine = `${lastSentence.indent}- "${newLineText}"`;

  const contextBefore = grammar.lines.slice(Math.max(0, lastSentence.lineIndex - 2), lastSentence.lineIndex + 1);
  const contextAfter = grammar.lines.slice(lastSentence.lineIndex + 1, lastSentence.lineIndex + 3);
  const origStart = Math.max(0, lastSentence.lineIndex - 2) + 1; // 1-indexed
  const origLen = contextBefore.length + 1 + contextAfter.length;
  const newLen = origLen + 1;

  const hunkLines = [
    ...contextBefore.map((l) => ` ${l}`),
    `+${newLine}`,
    ...contextAfter.map((l) => ` ${l}`),
  ];
  const relPath = `services/shared-routine-router/sentences/en/${match.file}`;
  const patch = [
    `--- a/${relPath}`,
    `+++ b/${relPath}`,
    `@@ -${origStart},${origLen} +${origStart},${newLen} @@`,
    ...hunkLines,
    '',
  ].join('\n');

  const dateStr = new Date().toISOString().slice(0, 10);
  const phraseHash = crypto.createHash('sha1').update(newLineText).digest('hex').slice(0, 4);
  let slug = `${match.intentName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-variant-${phraseHash}`;
  let filename = `${dateStr}-${slug}.patch`;
  let attempt = 2;
  while (fs.existsSync(path.join(proposedDir, filename))) {
    filename = `${dateStr}-${slug}-${attempt}.patch`;
    attempt += 1;
  }

  fs.mkdirSync(proposedDir, { recursive: true });
  fs.writeFileSync(path.join(proposedDir, filename), patch, 'utf8');

  return { ok: true, slug: filename.replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/\.patch$/, ''), filename };
}

// ─── Flag persistence ─────────────────────────────────────────────────────────

function loadFlags(stateDir) {
  const filePath = path.join(stateDir, 'phrase-flags.json');
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed.flags || {};
  } catch {
    return {};
  }
}

function saveFlags(stateDir, flags) {
  fs.mkdirSync(stateDir, { recursive: true });
  const filePath = path.join(stateDir, 'phrase-flags.json');
  const tmpPath = `${filePath}.tmp`;
  const body = JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), flags }, null, 2);
  fs.writeFileSync(tmpPath, body, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

// ─── Recency view (voice/text utterances ordered by recency) ──────────────────

function getRecencyView(requests, { windowDays = FREQ_WINDOW_DAYS_DEFAULT, routerDir } = {}) {
  const cutoffMs = Date.now() - windowDays * 86_400_000;

  // Only voice or text channels — includes requests that fell through to
  // Main and got merged into a 'webchat'-tagged trace by TraceStore's
  // unhandled-fastpath merge (see req.hasVoiceOrigin there), so a voice
  // utterance that missed the deterministic router doesn't just disappear
  // from this view because Main's own session channel isn't 'voice'.
  //
  // Explicitly excludes phrases the shared router already matched
  // successfully (spans[0].evidence.route === 'router', set by
  // TraceStore.loadVoiceFastpath from the 'router' entry in
  // voice-fastpath.jsonl) — this view exists to surface things that *didn't*
  // get a deterministic fast path, not to re-offer an already-working match
  // for linking (which would just append a redundant/confusing duplicate
  // sentence line to a grammar file that's already correct). Bypasses that
  // never touch the router at all (e.g. spanish-tutor's sticky-mode forward)
  // are not 'router' and stay included, since they're still candidates for
  // a real fast path.
  const candidates = requests
    .filter((r) => r.channel === 'voice-fastpath' || r.channel === 'voice' || r.channel === 'imessage' || r.hasVoiceOrigin)
    .filter((r) => r.spans?.[0]?.evidence?.route !== 'router')
    .filter((r) => r.startedAtMs >= cutoffMs)
    .filter((r) => {
      const text = String(r.text || '').trim();
      return text && !text.startsWith('[');
    });

  // Group by exact normalized text
  const distinct = new Map();
  for (const request of candidates) {
    const normalizedText = normalizePhraseText(request.text);
    if (!normalizedText) continue;
    let group = distinct.get(normalizedText);
    if (!group) {
      group = {
        normalizedText,
        rawText: request.text.trim(),
        count: 0,
        firstSeenAt: request.startedAtMs,
        lastSeenAt: request.startedAtMs,
        channels: new Set(),
        requests: [],
      };
      distinct.set(normalizedText, group);
    }
    group.count += 1;
    group.firstSeenAt = Math.min(group.firstSeenAt, request.startedAtMs);
    group.lastSeenAt = Math.max(group.lastSeenAt, request.startedAtMs);
    // request.channel alone would read as e.g. 'webchat' for a voice
    // utterance Main ended up handling — surface the true origin too.
    group.channels.add(request.hasVoiceOrigin ? 'voice (fell through to Main)' : request.channel);
    group.requests.push(request);
  }

  const entries = [...distinct.values()]
    .map((group) => ({
      id: `utterance:${crypto.createHash('sha1').update(group.normalizedText).digest('hex').slice(0, 8)}`,
      text: group.rawText,
      count: group.count,
      firstSeenAt: new Date(group.firstSeenAt).toISOString(),
      lastSeenAt: new Date(group.lastSeenAt).toISOString(),
      channels: [...group.channels],
    }))
    .sort((a, b) => new Date(b.lastSeenAt) - new Date(a.lastSeenAt)); // most recent first

  return entries;
}

// ─── Public API ───────────────────────────────────────────────────────────────

async function getPhraseTrackerView(store, opts = {}) {
  const { stateDir, routerDir } = opts;
  const snapshot = await store.snapshot();
  const flags = loadFlags(stateDir);

  const entries = getRecencyView(snapshot.requests, { routerDir })
    .map((entry) => ({ ...entry, flag: flags[entry.id] || null }))
    .filter((entry) => entry.flag?.status !== 'dismissed');
  return { view: 'recency', generatedAt: new Date().toISOString(), windowDays: FREQ_WINDOW_DAYS_DEFAULT, entries };
}

async function flagPhrase(store, id, action, opts = {}) {
  const { stateDir, routerDir, proposedDir, fields } = opts;
  const flags = loadFlags(stateDir);
  const view = 'recency';

  if (action === 'clear') {
    delete flags[id];
    saveFlags(stateDir, flags);
    return { ok: true, id, status: null };
  }

  // Trashes the utterance — it's excluded from future recency-view
  // responses (see getPhraseTrackerView's dismissed filter) rather than
  // just carrying a visible status badge.
  if (action === 'dismiss') {
    flags[id] = { id, view, status: 'dismissed', flaggedAt: new Date().toISOString() };
    saveFlags(stateDir, flags);
    return { ok: true, id, status: 'dismissed' };
  }

  if (action === 'addition') {
    const snapshot = await store.snapshot();
    const entries = getRecencyView(snapshot.requests, { routerDir });
    const entry = entries.find((e) => e.id === id);
    if (!entry) return { ok: false, error: 'utterance not found (may have shifted since last refresh)' };
    const candidateText = entry.text;

    // fields.target lets a human override the auto-match (e.g. "I just
    // studied Spanish" has no confident vocabulary overlap with any grammar
    // intent, but a human knows it's the same fast path as CompleteHabit).
    const drafted = fields?.target
      ? draftAdditionDiffForTarget(routerDir, proposedDir, candidateText, fields.target)
      : draftAdditionDiff(routerDir, proposedDir, candidateText);
    if (!drafted.ok) {
      const message = drafted.reason === 'unknown-target'
        ? 'That target route no longer exists — nothing was changed.'
        : 'Couldn\'t confidently match this phrase to an existing grammar intent — nothing was changed.';
      flags[id] = { id, view, status: 'no-match', flaggedAt: new Date().toISOString() };
      saveFlags(stateDir, flags);
      return { ok: true, id, status: 'no-match', message };
    }

    // Caller (server.js) runs the diff through the apply-and-validate
    // pipeline immediately and overwrites this with a final applied/failed
    // status via updateFlagStatus — this intermediate state exists only so a
    // crash between drafting and applying doesn't lose the diffSlug.
    flags[id] = { id, view, status: 'addition-pending', diffSlug: drafted.slug, flaggedAt: new Date().toISOString() };
    saveFlags(stateDir, flags);
    return { ok: true, id, status: 'addition-pending', diffSlug: drafted.slug };
  }

  return { ok: false, error: `unknown action: ${action}` };
}

function updateFlagStatus(stateDir, id, patch) {
  const flags = loadFlags(stateDir);
  flags[id] = { ...(flags[id] || { id }), ...patch, updatedAt: new Date().toISOString() };
  saveFlags(stateDir, flags);
  return flags[id];
}

module.exports = {
  getPhraseTrackerView,
  flagPhrase,
  updateFlagStatus,
  listRouterTargets,
  // exported for testing
  normalizePhraseText,
  loadGrammarFile,
  extractLiteralVocabulary,
  pickBestIntentForPhrase,
  draftAdditionDiff,
  draftAdditionDiffForTarget,
  resolveRouterTarget,
  loadFlags,
  saveFlags,
  ROUTE_TO_YAML,
};
