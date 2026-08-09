'use strict';

// Clusters recent user utterances into near-duplicate phrase groups (for the
// "what should we fast-track next" view) and cross-references the router's
// grammar files against voice-fastpath match history (for the "what's gone
// stale" view). Both views feed the Fast Router Proposals left column.
//
// No structured "every utterance + outcome" dataset exists anywhere in
// OpenClaw today, so this reuses TraceStore's existing aggregation of session
// transcripts + logs/voice-fastpath.jsonl rather than adding new logging.
// See workspace-systems-qa/state/phrase-flags.json for persisted flag state.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { routeToAgent } = require('./trace-store');

const SIMILARITY_THRESHOLD = 0.6; // bigram Dice coefficient, greedy single-linkage
const FREQ_WINDOW_DAYS_DEFAULT = 30;
const FREQ_MAX_SOURCE_TEXTS = 2000; // recency cap applied before clustering
const REMOVAL_CUTOFF_DAYS = 7;
const MATCH_CONFIDENCE_FLOOR = 0.4; // min vocab-overlap score to target an existing intent
const MATCH_CONFIDENCE_MARGIN = 0.15; // required lead over the runner-up intent
const MAX_TEXT_LEN_FOR_CLUSTERING = 200; // longer turns are unlikely to be short command phrasings

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
  'dashboard-list': { file: 'dashboard.yaml', intents: ['ListBoard', 'ListAllBoards'] },
  'dashboard-complete': { file: 'dashboard.yaml', intents: ['CompleteItem'] },
  'dashboard-complete-any': { file: 'dashboard.yaml', intents: ['CompleteItem', 'CompleteAnyFree'] },
  'dashboard-remove': { file: 'dashboard.yaml', intents: ['RemoveFromBoard'] },
  'dashboard-list-habits': { file: 'dashboard.yaml', intents: ['ListHabits'] },
  'dashboard-complete-habit': { file: 'dashboard.yaml', intents: ['CompleteHabit'] },
  'dashboard-list-lists': { file: 'dashboard.yaml', intents: ['ListLists'] },
  'dashboard-create-list': { file: 'dashboard.yaml', intents: ['CreateList'] },
  'dashboard-add-list-item': { file: 'dashboard.yaml', intents: ['AddListItem'] },
  'dashboard-show-list': { file: 'dashboard.yaml', intents: ['ShowList'] },
  'dashboard-complete-list-item': { file: 'dashboard.yaml', intents: ['CompleteListItem'] },
  'dashboard-schedule': { file: 'dashboard.yaml', intents: ['ScheduleItem'] },
  'dashboard-reschedule': { file: 'dashboard.yaml', intents: ['RescheduleItem'] },
  'dashboard-unschedule': { file: 'dashboard.yaml', intents: ['UnscheduleItem'] },
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
};

// Generalizes "a sub-agent has its own local fast-path shortcut, entirely
// outside shared-routine-router, backed by a discrete-value data store."
// Food logging is the first entry: services/ha-voice-adapter/server.js has a
// hardcoded regex (parseFoodReport) that checks a recipes table before ever
// involving an LLM. checkKnown/add shell out to health-workflow.js rather
// than touching its SQLite file directly — that script owns the real
// normalization/validation/duplicate-checking logic (NFKD normalize, exact
// match against recipes+aliases, calorie/protein bounds), and trace-noc runs
// as a separate process that shouldn't need to duplicate any of that or
// depend on node:sqlite being available in its own runtime. Add a new entry
// here (not new bespoke logic) when a second sub-agent gets its own fast path.
const HEALTH_WORKFLOW_SCRIPT = process.env.HEALTH_WORKFLOW_SCRIPT ||
  '/Users/aaronmacmini/.openclaw/workspace-health-tracker/scripts/health-workflow.js';
const NUTRITION_INDEX_SCRIPT = process.env.NUTRITION_INDEX_SCRIPT ||
  '/Users/aaronmacmini/.openclaw/workspace-health-tracker/scripts/nutrition-index.js';
const DOMAIN_NODE_BIN = process.env.OPENCLAW_NODE_BIN || '/opt/homebrew/opt/node@22/bin/node';

function runDomainScript(scriptPath, args) {
  const { spawnSync } = require('node:child_process');
  const result = spawnSync(DOMAIN_NODE_BIN, [scriptPath, ...args], { encoding: 'utf8', timeout: 5_000 });
  try {
    return JSON.parse(result.stdout || '');
  } catch {
    return null; // spawn/parse failure — callers degrade gracefully, never throw
  }
}

const DOMAIN_FASTPATHS = [
  {
    id: 'food-recipe',
    label: 'Food logging',
    agent: 'health-tracker',
    // Literal copy of ha-voice-adapter/server.js's parseFoodReport — kept
    // in sync by hand since the two services don't share a lib today. If
    // that regex changes, this one needs the same edit.
    detect(text) {
      const normalized = String(text || '').trim();
      const match = normalized.match(/^i\s+(?:just\s+)?(?:had|ate)\s+(.+?)(?:\s+(?:for\s+)?(?:breakfast|lunch|dinner|snack))?[.!?]?$/i)
        || normalized.match(/^log\s+(.+?)(?:\s+for\s+(?:breakfast|lunch|dinner|snack))?[.!?]?$/i);
      const description = match?.[1]?.trim();
      return description || null;
    },
    checkKnown(slotText) {
      // Tier 1: exact personal-recipe match.
      const recipeResult = runDomainScript(HEALTH_WORKFLOW_SCRIPT, ['find-recipe', '--query', slotText]);
      if (recipeResult && recipeResult.ok === true && recipeResult.found) {
        return { known: true, record: { source: 'recipe', ...recipeResult.recipe } };
      }
      // Tier 2: USDA index match. Kept synchronous via spawnSync (same as
      // the recipe check above) — the nutrition-index's BM25 search is fast
      // enough (< 1s) that the 5s timeout is never an issue.
      const usdaResult = runDomainScript(NUTRITION_INDEX_SCRIPT, ['search', '--query', slotText, '--limit', '1']);
      if (usdaResult && usdaResult.ok === true && Array.isArray(usdaResult.matches) && usdaResult.matches.length) {
        const match = usdaResult.matches[0];
        return { known: true, record: { source: 'usda', fdcId: match.fdcId, description: match.description, caloriesPer100g: match.caloriesPer100g, proteinPer100g: match.proteinPer100g } };
      }
      return { known: false, record: null };
    },
    add(fields) {
      const args = ['add-recipe', '--name', fields.name, '--serving', fields.serving,
        '--calories', String(fields.calories), '--protein', String(fields.protein)];
      if (fields.aliases?.length) args.push('--aliases', fields.aliases.join(','));
      const result = runDomainScript(HEALTH_WORKFLOW_SCRIPT, args);
      if (!result) return { ok: false, error: 'add-recipe: no response from health-workflow.js' };
      return result;
    },
    // Powers the "link to existing food" dropdown on domain-candidate
    // phrases — lets a repeated phrase get aliased onto an already-known
    // recipe instead of spawning a near-duplicate record.
    list() {
      const result = runDomainScript(HEALTH_WORKFLOW_SCRIPT, ['list-recipes']);
      if (!result || result.ok !== true) return [];
      return result.recipes || [];
    },
    addAlias(recipeId, aliases) {
      const args = ['add-recipe-alias', '--recipe-id', recipeId, '--aliases', aliases.join(',')];
      const result = runDomainScript(HEALTH_WORKFLOW_SCRIPT, args);
      if (!result) return { ok: false, error: 'add-recipe-alias: no response from health-workflow.js' };
      return result;
    },
    formFields: [
      { key: 'name', label: 'Name', type: 'text', required: true },
      { key: 'serving', label: 'Serving', type: 'text', required: true, placeholder: 'e.g. 1 cup' },
      { key: 'calories', label: 'Calories', type: 'number', required: true, max: 10000 },
      { key: 'protein', label: 'Protein (g)', type: 'number', required: true, max: 1000 },
      { key: 'aliases', label: 'Aliases (comma-separated)', type: 'text', required: false },
    ],
  },
];

// ─── Text helpers ────────────────────────────────────────────────────────────

function normalizePhraseText(value) {
  return String(value || '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[.!?]+$/, '');
}

function bigrams(text) {
  const set = new Set();
  const s = text.replace(/\s+/g, ' ');
  for (let i = 0; i < s.length - 1; i += 1) set.add(s.slice(i, i + 2));
  return set;
}

function diceSimilarity(a, b) {
  if (a === b) return 1;
  const A = bigrams(a);
  const B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let overlap = 0;
  for (const gram of A) if (B.has(gram)) overlap += 1;
  return (2 * overlap) / (A.size + B.size);
}

function wordsOf(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 2 && !STOPWORDS.has(w));
}

// ─── Frequency-view clustering ───────────────────────────────────────────────

// Greedy single-linkage against each cluster's representative (not full
// pairwise) — cheap and scales fine at this data volume: distinct texts are
// already capped by an exact-dedup pass before this runs.
function clusterTexts(distinctGroups) {
  const clusters = [];
  for (const group of distinctGroups) {
    let best = null;
    let bestScore = 0;
    for (const cluster of clusters) {
      const score = diceSimilarity(group.normalizedText, cluster.representative.normalizedText);
      if (score > bestScore) { bestScore = score; best = cluster; }
    }
    if (best && bestScore >= SIMILARITY_THRESHOLD) {
      best.members.push(group);
      if (group.count > best.representative.count) best.representative = group;
    } else {
      clusters.push({ representative: group, members: [group] });
    }
  }
  return clusters;
}

function getFrequencyGroups(requests, { windowDays = FREQ_WINDOW_DAYS_DEFAULT, routerDir } = {}) {
  const cutoffMs = Date.now() - windowDays * 86_400_000;
  const candidates = requests
    .filter((r) => r.channel !== 'kiosk' && r.channel !== 'voice-fastpath' && r.channel !== 'heartbeat')
    .filter((r) => r.startedAtMs >= cutoffMs)
    .filter((r) => {
      const text = String(r.text || '').trim();
      return text && !text.startsWith('[') && text.length <= MAX_TEXT_LEN_FOR_CLUSTERING;
    })
    .slice(0, FREQ_MAX_SOURCE_TEXTS);

  const distinct = new Map(); // normalizedText -> group
  for (const request of candidates) {
    const normalizedText = normalizePhraseText(request.text);
    if (!normalizedText) continue;
    let group = distinct.get(normalizedText);
    if (!group) {
      group = { normalizedText, rawText: request.text.trim(), count: 0, firstSeenAt: request.startedAtMs, lastSeenAt: request.startedAtMs, agentCounts: new Map() };
      distinct.set(normalizedText, group);
    }
    group.count += 1;
    group.firstSeenAt = Math.min(group.firstSeenAt, request.startedAtMs);
    group.lastSeenAt = Math.max(group.lastSeenAt, request.startedAtMs);
    for (const agent of request.agents || []) {
      group.agentCounts.set(agent, (group.agentCounts.get(agent) || 0) + 1);
    }
  }

  const clusters = clusterTexts([...distinct.values()]);

  // Populated lazily (at most once per domain per call) the first time a
  // domain-candidate group needs it, rather than once per group — the
  // record list doesn't vary per phrase.
  const domainRecordsCache = new Map();

  return clusters.map((cluster) => {
    const variants = cluster.members
      .map((m) => ({ text: m.rawText, count: m.count, firstSeenAt: m.firstSeenAt, lastSeenAt: m.lastSeenAt }))
      .sort((a, b) => b.count - a.count);
    const totalCount = cluster.members.reduce((sum, m) => sum + m.count, 0);
    const firstSeenAt = Math.min(...cluster.members.map((m) => m.firstSeenAt));
    const lastSeenAt = Math.max(...cluster.members.map((m) => m.lastSeenAt));
    const canonicalText = cluster.representative.rawText;

    // Computed eagerly (not just at flag time) so the UI can show what
    // "Push to Router" would actually target before it's clicked — this is
    // the same lookup draftAdditionDiff uses, just surfaced read-only.
    const match = routerDir ? pickBestIntentForPhrase(routerDir, canonicalText) : null;
    const predictedTarget = match
      ? { route: match.route, intentName: match.intentName, file: match.file, score: match.score, agent: routeToAgent(match.route) }
      : null;

    // Domain fast-paths (see DOMAIN_FASTPATHS) only get checked when no
    // router intent matched, and only for a domain whose own cheap regex
    // matches this text at all. checkKnown() is per-group I/O; list() (for
    // the "link to existing" dropdown) is memoized above, so at most one
    // extra call per domain happens here.
    let domainMatch = null;
    if (!predictedTarget) {
      for (const domain of DOMAIN_FASTPATHS) {
        const slotText = domain.detect(canonicalText);
        if (!slotText) continue;
        const { known, record } = domain.checkKnown(slotText) || {};
        let existingRecords = [];
        if (!known && domain.list) {
          if (!domainRecordsCache.has(domain.id)) domainRecordsCache.set(domain.id, domain.list());
          existingRecords = domainRecordsCache.get(domain.id);
        }
        domainMatch = { domainId: domain.id, domainLabel: domain.label, agent: domain.agent, slotText, known: Boolean(known), record: record || null, formFields: domain.formFields, existingRecords };
        break;
      }
    }

    const classification = predictedTarget ? 'router-match'
      : domainMatch?.known ? 'domain-known'
      : domainMatch ? 'domain-candidate'
      : 'new-capability';

    // Actual agent(s) that handled these utterances historically, regardless
    // of classification — surfaced so Aaron can eyeball misrouting (e.g. a
    // router-match phrase whose real traffic actually went to the wrong
    // sub-agent) rather than only when nothing else explains the phrase.
    const mergedAgentCounts = new Map();
    for (const member of cluster.members) {
      for (const [agent, n] of member.agentCounts) mergedAgentCounts.set(agent, (mergedAgentCounts.get(agent) || 0) + n);
    }
    const agentBreakdown = [...mergedAgentCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([agent, count]) => ({ agent, count }));

    // "Who currently deals with this" banner text is only useful context
    // when nothing else already states an explicit target (router intent or
    // domain) — kept narrow (top 2) for that inline sentence.
    const currentHandlers = classification === 'new-capability' && agentBreakdown.length
      ? agentBreakdown.slice(0, 2).map((h) => h.agent)
      : null;

    return {
      id: `phrase:${crypto.createHash('sha1').update(normalizePhraseText(canonicalText)).digest('hex').slice(0, 8)}`,
      canonicalText,
      count: totalCount,
      variantCount: variants.length,
      firstSeenAt: new Date(firstSeenAt).toISOString(),
      lastSeenAt: new Date(lastSeenAt).toISOString(),
      variants,
      predictedTarget,
      domainMatch,
      classification,
      currentHandlers,
      agentBreakdown,
    };
  }).sort((a, b) => b.count - a.count);
}

// ─── Removal-view staleness ───────────────────────────────────────────────────

function getRemovalIntents(requests, { cutoffDays = REMOVAL_CUTOFF_DAYS, routerDir } = {}) {
  const now = Date.now();
  const byRoute = new Map();
  for (const request of requests) {
    if (request.channel !== 'voice-fastpath') continue;
    const intent = request.spans?.[0]?.evidence?.intent;
    if (!intent || !ROUTE_TO_YAML[intent]) continue;
    const entry = byRoute.get(intent) || { count: 0, lastUsedMs: 0 };
    entry.count += 1;
    entry.lastUsedMs = Math.max(entry.lastUsedMs, request.startedAtMs);
    byRoute.set(intent, entry);
  }

  const results = [];
  for (const [route, mapping] of Object.entries(ROUTE_TO_YAML)) {
    const usage = byRoute.get(route);
    const lastUsedMs = usage ? usage.lastUsedMs : null;
    const daysSinceUsed = lastUsedMs ? (now - lastUsedMs) / 86_400_000 : Infinity;
    if (daysSinceUsed < cutoffDays) continue;

    const grammar = loadGrammarFile(routerDir, mapping.file);
    const patterns = mapping.intents.flatMap((intentName) => {
      const intent = grammar?.intents.find((i) => i.name === intentName);
      return (intent?.sentenceLines || []).map((s) => s.text);
    });

    results.push({
      id: `intent:${route}`,
      route,
      intentNames: mapping.intents,
      file: mapping.file,
      usageCount: usage ? usage.count : 0,
      lastUsedAt: lastUsedMs ? new Date(lastUsedMs).toISOString() : null,
      daysSinceUsed: Number.isFinite(daysSinceUsed) ? Math.floor(daysSinceUsed) : null,
      neverUsed: !lastUsedMs,
      patterns,
    });
  }

  return results.sort((a, b) => (b.daysSinceUsed ?? Infinity) - (a.daysSinceUsed ?? Infinity));
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

// ─── Diff drafting ────────────────────────────────────────────────────────────
// Deliberately narrow: only ever appends one literal sentence line to an
// existing intent's pattern list. Never invents a new intent or file — the
// existing apply script (qa-apply-diff.sh) requires the target file to
// already exist, and hand-authoring new hassil grammar shapes from a raw
// phrase is a much harder, much riskier generation task than this covers.
function draftAdditionDiff(routerDir, proposedDir, candidateText) {
  const match = pickBestIntentForPhrase(routerDir, candidateText);
  if (!match) return { ok: false, reason: 'no-confident-match' };

  const grammar = loadGrammarFile(routerDir, match.file);
  const intent = grammar.intents.find((i) => i.name === match.intentName);
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

  // Only voice or text channels
  const candidates = requests
    .filter((r) => r.channel === 'voice-fastpath' || r.channel === 'voice' || r.channel === 'imessage')
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
    group.channels.add(request.channel);
    group.requests.push(request);
  }

  // Cross-reference with frequency clusters so the UI can show cluster membership
  const freqGroups = getFrequencyGroups(requests, { windowDays, routerDir });
  const textToClusterMap = new Map();
  for (const cluster of freqGroups) {
    for (const variant of cluster.variants) {
      const norm = normalizePhraseText(variant.text);
      if (norm) {
        textToClusterMap.set(norm, {
          clusteredWith: cluster.canonicalText,
          clusterCount: cluster.count,
          clusterVariants: cluster.variantCount,
        });
      }
    }
  }

  const entries = [...distinct.values()]
    .map((group) => {
      const clusterInfo = textToClusterMap.get(group.normalizedText);
      return {
        id: `utterance:${crypto.createHash('sha1').update(group.normalizedText).digest('hex').slice(0, 8)}`,
        text: group.rawText,
        count: group.count,
        firstSeenAt: new Date(group.firstSeenAt).toISOString(),
        lastSeenAt: new Date(group.lastSeenAt).toISOString(),
        channels: [...group.channels],
        clusteredWith: clusterInfo ? clusterInfo.clusteredWith : null,
        clusterCount: clusterInfo ? clusterInfo.clusterCount : null,
        clusterVariants: clusterInfo ? clusterInfo.clusterVariants : null,
      };
    })
    .sort((a, b) => new Date(b.lastSeenAt) - new Date(a.lastSeenAt)); // most recent first

  return entries;
}

// ─── Public API ───────────────────────────────────────────────────────────────

async function getPhraseTrackerView(store, view, opts = {}) {
  const { stateDir, routerDir } = opts;
  const snapshot = await store.snapshot();
  const flags = loadFlags(stateDir);

  if (view === 'removal') {
    const intents = getRemovalIntents(snapshot.requests, { routerDir })
      .map((entry) => ({ ...entry, flag: flags[entry.id] || null }));
    return { view: 'removal', generatedAt: new Date().toISOString(), cutoffDays: REMOVAL_CUTOFF_DAYS, intents };
  }

  if (view === 'recency') {
    const entries = getRecencyView(snapshot.requests, { routerDir })
      .map((entry) => ({ ...entry, flag: flags[entry.id] || null }))
      .filter((entry) => entry.flag?.status !== 'dismissed'); // dismissed entries excluded (parity with frequency view)
    return { view: 'recency', generatedAt: new Date().toISOString(), windowDays: FREQ_WINDOW_DAYS_DEFAULT, entries };
  }

  const groups = getFrequencyGroups(snapshot.requests, { routerDir })
    .map((entry) => ({ ...entry, flag: flags[entry.id] || null }))
    .filter((entry) => entry.flag?.status !== 'dismissed') // dismissed phrases are trashed, not just hidden-by-flag
    .filter((entry) => entry.classification !== 'domain-known'); // domain-known entries are already handled — no action needed
  return { view: 'frequency', generatedAt: new Date().toISOString(), windowDays: FREQ_WINDOW_DAYS_DEFAULT, groups };
}

async function flagPhrase(store, id, action, opts = {}) {
  const { stateDir, routerDir, proposedDir, fields } = opts;
  const flags = loadFlags(stateDir);
  const view = id.startsWith('intent:') ? 'removal' : 'frequency';

  if (action === 'clear') {
    delete flags[id];
    saveFlags(stateDir, flags);
    return { ok: true, id, status: null };
  }

  if (action === 'removal-review') {
    flags[id] = { id, view, status: 'removal-review', flaggedAt: new Date().toISOString() };
    saveFlags(stateDir, flags);
    return { ok: true, id, status: flags[id].status };
  }

  // Trashes the phrase group — it's excluded from future frequency-view and
  // recency-view responses (see getPhraseTrackerView's dismissed filter)
  // rather than just carrying a visible status badge.
  if (action === 'dismiss') {
    flags[id] = { id, view, status: 'dismissed', flaggedAt: new Date().toISOString() };
    saveFlags(stateDir, flags);
    return { ok: true, id, status: 'dismissed' };
  }

  if (action === 'addition') {
    if (view !== 'frequency') {
      return { ok: false, error: 'addition flag only applies to frequency-view phrases' };
    }
    const snapshot = await store.snapshot();
    const groups = getFrequencyGroups(snapshot.requests);
    const group = groups.find((g) => g.id === id);
    if (!group) return { ok: false, error: 'phrase group not found (may have shifted since last refresh)' };

    const drafted = draftAdditionDiff(routerDir, proposedDir, group.canonicalText);
    if (!drafted.ok) {
      flags[id] = { id, view, status: 'no-match', flaggedAt: new Date().toISOString() };
      saveFlags(stateDir, flags);
      return { ok: true, id, status: 'no-match', message: 'Couldn\'t confidently match this phrase to an existing grammar intent — nothing was changed.' };
    }

    // Caller (server.js) runs the diff through the apply-and-validate
    // pipeline immediately and overwrites this with a final applied/failed
    // status via updateFlagStatus — this intermediate state exists only so a
    // crash between drafting and applying doesn't lose the diffSlug.
    flags[id] = { id, view, status: 'addition-pending', diffSlug: drafted.slug, flaggedAt: new Date().toISOString() };
    saveFlags(stateDir, flags);
    return { ok: true, id, status: 'addition-pending', diffSlug: drafted.slug };
  }

  if (action === 'domain-add') {
    if (view !== 'frequency') {
      return { ok: false, error: 'domain-add flag only applies to frequency-view phrases' };
    }
    const domain = DOMAIN_FASTPATHS.find((d) => d.id === fields?.domainId);
    if (!domain) return { ok: false, error: `unknown domain: ${fields?.domainId}` };

    const missing = domain.formFields.filter((f) => f.required && !String(fields[f.key] || '').trim());
    if (missing.length) return { ok: false, error: `missing required field(s): ${missing.map((f) => f.key).join(', ')}` };

    const aliases = String(fields.aliases || '').split(',').map((a) => a.trim()).filter(Boolean);
    const result = domain.add({ ...fields, aliases });
    if (!result.ok) {
      // Validation failure (e.g. DUPLICATE_RECIPE) — nothing changed, no flag written.
      return { ok: false, error: result.error || 'Failed to add.' };
    }

    updateFlagStatus(stateDir, id, {
      view, status: 'domain-added', domainId: domain.id,
      addedRecordId: result.recipe?.id || null, flaggedAt: new Date().toISOString(),
    });
    return { ok: true, id, status: 'domain-added', message: result.reply || `Added to ${domain.label}.` };
  }

  // Aliases a domain-candidate phrase onto an already-known record (the
  // "link to existing" dropdown) instead of creating a near-duplicate.
  if (action === 'domain-link') {
    if (view !== 'frequency') {
      return { ok: false, error: 'domain-link flag only applies to frequency-view phrases' };
    }
    const domain = DOMAIN_FASTPATHS.find((d) => d.id === fields?.domainId);
    if (!domain) return { ok: false, error: `unknown domain: ${fields?.domainId}` };
    if (!domain.addAlias) return { ok: false, error: `domain '${domain.id}' does not support linking` };

    const recipeId = String(fields?.recipeId || '').trim();
    if (!recipeId) return { ok: false, error: 'recipeId is required' };
    const aliases = String(fields?.aliases || '').split(',').map((a) => a.trim()).filter(Boolean);
    if (!aliases.length) return { ok: false, error: 'at least one alias is required' };

    const result = domain.addAlias(recipeId, aliases);
    if (!result.ok) return { ok: false, error: result.error || 'Failed to link.' };

    updateFlagStatus(stateDir, id, {
      view, status: 'domain-linked', domainId: domain.id,
      linkedRecordId: recipeId, flaggedAt: new Date().toISOString(),
    });
    return { ok: true, id, status: 'domain-linked', message: result.reply || `Linked to ${domain.label}.` };
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
  // exported for testing
  bigrams,
  diceSimilarity,
  clusterTexts,
  normalizePhraseText,
  loadGrammarFile,
  extractLiteralVocabulary,
  pickBestIntentForPhrase,
  draftAdditionDiff,
  loadFlags,
  saveFlags,
  ROUTE_TO_YAML,
};
