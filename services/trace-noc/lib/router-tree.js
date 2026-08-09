'use strict';

// Builds a static reference tree of the shared-routine-router's full tiered
// dispatch logic, for the investigations view's "Routine router" node panel.
// Lets Aaron browse every phrase rule the router actually has (grouped by
// tier and domain) rather than only seeing the one route/intent that matched
// a given trace. Deliberately static/reference-only: it does not attempt to
// reconstruct why a specific request missed a given rule (see phrase-tracker.js's
// pickBestIntentForPhrase for that, used elsewhere in the "Fast Router
// Proposals" view) — here the user visually scans the tree themselves.

const fs = require('node:fs');
const path = require('node:path');
const { loadGrammarFile, ROUTE_TO_YAML } = require('./phrase-tracker');

// Fixed domain order — dashboard first since task/list phrasing is the most
// frequently reworked grammar and the thing Aaron most often comes here to
// check.
const DOMAIN_FILES = ['dashboard.yaml', 'calendar.yaml', 'health.yaml', 'finance.yaml'];
const DOMAIN_LABELS = {
  'dashboard.yaml': 'Task boards & lists',
  'calendar.yaml': 'Calendar',
  'health.yaml': 'Health & food logging',
  'finance.yaml': 'Finance',
};
// meal-planner.yaml was disabled 2026-08-08 (renamed to
// meal-planner.yaml.disabled, no longer loaded by recognize.py) — Main still
// delegates meal-planning requests to `meal-planner` conversationally.

// route -> intentName is a 1:1 or 1:many mapping in ROUTE_TO_YAML; invert it
// so a tree node built from a YAML intent name can look up which route(s)
// resolve to it (used by the frontend to highlight the matched leaf).
function buildIntentToRoutes() {
  const map = {};
  for (const [route, mapping] of Object.entries(ROUTE_TO_YAML)) {
    for (const intentName of mapping.intents) {
      const key = `${mapping.file}:${intentName}`;
      if (!map[key]) map[key] = [];
      map[key].push(route);
    }
  }
  return map;
}

// Food logging moved from ha-voice-adapter/server.js into
// shared-routine-router/index.js itself on 2026-08-08 (tryFoodFastPath,
// checked right after grammar-match fails) — this is real logic living in
// the router now, not hand-mirrored documentation of a separate service's
// regex. Kept as a small static description (not derived from the grammar
// YAML, since this tier is plain JS pattern matching, not hassil) for the
// grammar-router tile's detail panel.
const FOOD_LOGGING_SUBTIER = {
  label: 'Food logging fast path',
  description: 'Checked after the grammar templates find no match. Only matches first-person logging phrasing ("I had/ate ...", "log ..."); food questions fall through to Main.',
  steps: [
    { label: 'Pattern match', detail: '"I (just) had/ate {food}" or "log {food}", optionally followed by "for breakfast/lunch/dinner/snack"' },
    { label: 'Recipe lookup', detail: 'Exact match against your personal recipe library' },
    { label: 'USDA fallback', detail: 'If no recipe match, parses the portion size and fuzzy-searches the USDA nutrition index' },
  ],
};

// Read live off workspace-main/TOOLS.md's marked delegation block — this is
// the actual canonical source ha-voice-adapter itself reads on every voice
// turn (see ha-voice-adapter/server.js:36-52), so no hand-mirroring needed
// here, unlike FOOD_LOGGING_SUBTIER above.
const TOOLS_MD_PATH = '/Users/aaronmacmini/.openclaw/workspace-main/TOOLS.md';

function loadMainDelegationRules() {
  try {
    const raw = fs.readFileSync(TOOLS_MD_PATH, 'utf8');
    const match = raw.match(/<!-- DELEGATION_TABLE_START -->([\s\S]*?)<!-- DELEGATION_TABLE_END -->/);
    if (!match) return [];
    return match[1]
      .split('\n')
      .map((line) => line.match(/^-\s+(.*?)\s*→\s*`([^`]+)`\s*(\(.*\))?\s*$/))
      .filter(Boolean)
      .map((m) => ({ description: m[1].trim(), agent: m[2].trim(), note: m[3] ? m[3].trim() : null }));
  } catch {
    return [];
  }
}

let _cache = null;
let _cacheKey = null;

function buildRouterTree(routerDir) {
  // Cache keyed by the grammar files' mtimes (loadGrammarFile already caches
  // per-file) plus a check that TOOLS.md hasn't changed, so an edit to
  // either takes effect on next request without a server restart.
  const cacheKeyParts = [];
  try { cacheKeyParts.push(fs.statSync(TOOLS_MD_PATH).mtimeMs); } catch { cacheKeyParts.push(0); }
  for (const file of DOMAIN_FILES) {
    try { cacheKeyParts.push(fs.statSync(path.join(routerDir, 'sentences', 'en', file)).mtimeMs); } catch { cacheKeyParts.push(0); }
  }
  const cacheKey = cacheKeyParts.join(',');
  if (_cache && _cacheKey === cacheKey) return _cache;

  const intentToRoutes = buildIntentToRoutes();

  const domains = DOMAIN_FILES.map((file) => {
    const grammar = loadGrammarFile(routerDir, file);
    const intents = (grammar?.intents || []).map((intent) => ({
      name: intent.name,
      routes: intentToRoutes[`${file}:${intent.name}`] || [],
      phrases: intent.sentenceLines.map((s) => s.text),
    }));
    return { file, label: DOMAIN_LABELS[file] || file, intentCount: intents.length, intents };
  }).filter((d) => d.intentCount > 0);

  const intentCount = domains.reduce((sum, d) => sum + d.intentCount, 0);

  _cache = {
    generatedAt: new Date().toISOString(),
    tiers: [
      {
        id: 'tier-nevermind',
        label: 'Escape hatch',
        description: '"Never mind" (or similar trailing cancel phrasing) is checked before anything else and unconditionally cancels the request.',
      },
      {
        id: 'tier-grammar',
        label: `Grammar router (${intentCount} intents)`,
        description: 'Deterministic sentence-template matching (hassil) against the router\'s YAML grammar files, plus a food-logging fast path (recipe match, then USDA lookup with portion parsing) for first-person food/drink reports that don\'t match a grammar template. Checked first — if nothing matches, falls through to Main.',
        domains,
        foodLogging: FOOD_LOGGING_SUBTIER,
      },
      {
        id: 'tier-main',
        label: 'Main (LLM fallback)',
        description: 'Catch-all: forwards to Main, which delegates by broad category per its own routing table.',
        rules: loadMainDelegationRules(),
      },
    ],
  };
  _cacheKey = cacheKey;
  return _cache;
}

module.exports = { buildRouterTree };
