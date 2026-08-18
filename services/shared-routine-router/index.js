'use strict';

const crypto = require('crypto');
const path = require('path');
const { spawn } = require('child_process');

const NODE_BIN = process.env.OPENCLAW_NODE_BIN || '/opt/homebrew/opt/node@22/bin/node';
const DASHBOARD_SCRIPT = process.env.DASHBOARD_WORKFLOW_SCRIPT ||
  '/Users/aaronmacmini/.openclaw/workspace-main/scripts/dashboard-workflow.js';
const CALENDAR_SCRIPT = process.env.CALENDAR_WORKFLOW_SCRIPT ||
  '/Users/aaronmacmini/.openclaw/workspace-main/scripts/calendar-workflow.js';
const HEALTH_SCRIPT = process.env.HEALTH_WORKFLOW_SCRIPT ||
  '/Users/aaronmacmini/.openclaw/workspace-health-tracker/scripts/health-workflow.js';
const FINANCE_SCRIPT = process.env.FINANCE_WORKFLOW_SCRIPT ||
  '/Users/aaronmacmini/.openclaw/workspace-finance-agent/scripts/finance-workflow.js';
const NUTRITION_INDEX_SCRIPT = process.env.NUTRITION_INDEX_SCRIPT ||
  '/Users/aaronmacmini/.openclaw/workspace-health-tracker/scripts/nutrition-index.js';
const QUANTITY_PARSER = process.env.QUANTITY_PARSER_SCRIPT ||
  '/Users/aaronmacmini/.openclaw/workspace-health-tracker/scripts/lib/quantity-parser.js';
const CALENDAR_TIMEZONE = process.env.OPENCLAW_CALENDAR_TIMEZONE || 'America/New_York';

const PYTHON_BIN = process.env.ROUTINE_ROUTER_PYTHON_BIN || path.join(__dirname, 'venv', 'bin', 'python3');
const RECOGNIZE_SCRIPT = path.join(__dirname, 'recognize.py');

function boardKey(value) {
  const normalized = String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (normalized === 'work' || normalized === 'accenture') return 'work';
  if (normalized === 'personal') return 'personal';
  if (normalized === 'market lou' || normalized === 'market') return 'market-lou';
  if (normalized === 'grocery' || normalized === 'groceries') return 'grocery';
  return null;
}

function zonedDateParts(now, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (type) => Number(parts.find((part) => part.type === type).value);
  return { year: get('year'), month: get('month'), day: get('day') };
}

function relativeDate(offsetDays, now, timeZone) {
  const { year, month, day } = zonedDateParts(now, timeZone);
  const shifted = new Date(Date.UTC(year, month - 1, day + offsetDays));
  return shifted.toISOString().slice(0, 10);
}

function parseClockTime(hourText, minuteText, meridiem) {
  let hour = Number(hourText);
  const minute = Number(minuteText || 0);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || minute > 59) return null;
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    if (meridiem.toLowerCase() === 'pm' && hour !== 12) hour += 12;
    if (meridiem.toLowerCase() === 'am' && hour === 12) hour = 0;
  } else if (hour > 23) {
    return null;
  }
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

// Resolves a date phrase to a day offset from `now`, or null if the phrase
// isn't one of the forms we understand. Kept separate from the "no date
// phrase at all" case in parseCalendarWhen — those are handled differently
// (see the comment above parseCalendarWhen).
function resolveDateOffset(value, now, timeZone) {
  if (/\btoday\b/i.test(value)) return 0;
  if (/\btomorrow\b/i.test(value)) return 1;

  const inDays = value.match(/\bin\s+(\d+)\s+days?\b/i);
  if (inDays) return Number(inDays[1]);

  if (/\bnext\s+week\b/i.test(value)) return 7;

  const weekdayMatch = value.match(/\b(next\s+|this\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i);
  if (weekdayMatch) {
    const targetDow = WEEKDAYS.indexOf(weekdayMatch[2].toLowerCase());
    const currentDow = new Date(`${zonedDateISO(now, timeZone)}T12:00:00Z`).getUTCDay();
    let offset = (targetDow - currentDow + 7) % 7;
    // A bare or "this"-prefixed weekday name that lands on today is treated
    // as next week's occurrence rather than today — "on Tuesday" said on a
    // Tuesday almost never means "right now", and staying consistent with
    // "next <weekday>" avoids a second ambiguous special case.
    if (offset === 0) offset = 7;
    return offset;
  }

  const monthDayMatch = value.match(new RegExp(
    `\\b(${MONTH_NAMES.join('|')})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'i',
  ));
  if (monthDayMatch) {
    const monthIdx = monthIndexFromText(monthDayMatch[1]);
    const day = Number(monthDayMatch[2]);
    if (monthIdx >= 0 && day >= 1 && day <= 31) return offsetForMonthDay(monthIdx, day, now, timeZone);
  }

  // A bare ordinal day of month ("the 24th", "on the 3rd") with no month
  // named — resolve to the nearest occurrence, this month if it hasn't
  // passed yet, otherwise next month. This was the actual gap behind the
  // reported bug: "schedule a doctor's appointment on the 24th for 8:30 AM"
  // has no "next"/weekday/month word at all, so it matched none of the
  // patterns above and silently fell back to today.
  const ordinalDayMatch = value.match(/\bthe\s+(\d{1,2})(?:st|nd|rd|th)\b/i);
  if (ordinalDayMatch) {
    const day = Number(ordinalDayMatch[1]);
    if (day >= 1 && day <= 31) return offsetForDayOfMonth(day, now, timeZone);
  }

  const slashDateMatch = value.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (slashDateMatch) {
    const monthIdx = Number(slashDateMatch[1]) - 1;
    const day = Number(slashDateMatch[2]);
    if (monthIdx >= 0 && monthIdx <= 11 && day >= 1 && day <= 31) {
      return offsetForMonthDay(monthIdx, day, now, timeZone, slashDateMatch[3] ? Number(slashDateMatch[3]) : null);
    }
  }

  return null;
}

const MONTH_NAMES = [
  'jan(?:uary)?', 'feb(?:ruary)?', 'mar(?:ch)?', 'apr(?:il)?', 'may', 'jun(?:e)?',
  'jul(?:y)?', 'aug(?:ust)?', 'sep(?:tember)?', 'oct(?:ober)?', 'nov(?:ember)?', 'dec(?:ember)?',
];
const MONTH_FULL_NAMES = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

function monthIndexFromText(text) {
  const normalized = text.toLowerCase().replace(/\.$/, '');
  return MONTH_FULL_NAMES.findIndex((name) => name.startsWith(normalized));
}

// Returns a day offset from `now` for a specific month/day, choosing the
// nearest future occurrence (this year, or next year if that date already
// passed) when no explicit year is given.
function offsetForMonthDay(monthIdx, day, now, timeZone, explicitYear = null) {
  const { year, month: curMonth, day: curDay } = zonedDateParts(now, timeZone);
  const todayUTC = Date.UTC(year, curMonth - 1, curDay);
  let targetYear = explicitYear === null ? year : (explicitYear < 100 ? 2000 + explicitYear : explicitYear);
  let targetUTC = Date.UTC(targetYear, monthIdx, day);
  if (explicitYear === null && targetUTC < todayUTC) {
    targetYear += 1;
    targetUTC = Date.UTC(targetYear, monthIdx, day);
  }
  return Math.round((targetUTC - todayUTC) / 86400000);
}

// Returns a day offset from `now` for a bare day-of-month, using this month
// if the day hasn't passed yet, otherwise next month.
function offsetForDayOfMonth(day, now, timeZone) {
  const { year, month: curMonth, day: curDay } = zonedDateParts(now, timeZone);
  const todayUTC = Date.UTC(year, curMonth - 1, curDay);
  let targetMonth = curMonth;
  let targetYear = year;
  if (day < curDay) {
    targetMonth += 1;
    if (targetMonth > 12) { targetMonth = 1; targetYear += 1; }
  }
  const targetUTC = Date.UTC(targetYear, targetMonth - 1, day);
  return Math.round((targetUTC - todayUTC) / 86400000);
}

function zonedDateISO(now, timeZone) {
  const { year, month, day } = zonedDateParts(now, timeZone);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// Words that signal the phrase is trying to name a date, even if none of
// our patterns above matched it. Used to tell "no date word at all" (safe
// to default to today) apart from "a date word we don't understand yet"
// (unsafe to guess — better to fall through to Main than silently pick the
// wrong day).
const DATE_INDICATOR_RE = new RegExp(
  `\\b(next|this|coming|in\\s+\\d+\\s+(?:day|week|month)s?|week|month|the\\s+\\d{1,2}(?:st|nd|rd|th)?|\\d{1,2}(?:st|nd|rd|th)|\\d{1,2}\\/\\d{1,2}|${WEEKDAYS.join('|')}|${MONTH_NAMES.join('|')})\\b`,
  'i',
);

// The {when} slot is a wildcard (hassil recognizes the AddCalendar sentence
// shape, not free-form dates) — date/time extraction stays regex-based here
// because it's arithmetic, not phrasing variety, and gains nothing from a
// sentence grammar. A missing date word (e.g. "for 9am") defaults to today —
// that's the natural reading of a bare time, and how most people actually
// phrase a same-day request. Confirmed via reproduction on 2026-08-03: a real
// same-day request ("add a morning meeting to my calendar for 9am") silently
// fell through to Main instead of the deterministic calendar workflow
// because this used to require an explicit "today"/"tomorrow" — see
// project-calendar-when-missing-date-word-bug-2026-08-03.
//
// Extended 2026-08-17 to also resolve "next week", weekday names ("Tuesday",
// "next Friday"), and "in N days" locally (see resolveDateOffset) — these
// are still pure date arithmetic, not phrasing variety, so they don't need
// an LLM. But a date phrase we *don't* recognize (e.g. "next month", "in
// three weeks") must not silently fall back to today the way a truly absent
// date word does — that's what caused a "next week" request to get scheduled
// for today. DATE_INDICATOR_RE distinguishes the two: if the text looks like
// it's trying to name a date but resolveDateOffset couldn't parse it, this
// returns null so the caller falls through to Main instead of guessing.
//
// The am/pm branch accepts "." as well as ":" between hour and minutes
// (e.g. "11.30 PM") — fixed 2026-08-08 after a real request with a period
// separator matched the wrong hour digits and silently failed. The bare
// 24h branch (no am/pm) intentionally stays colon-only: without a meridiem
// to anchor it, a period there risks misreading unrelated decimals (prices,
// versions) as clock times.
function parseCalendarWhen(when, options = {}) {
  const value = String(when || '').trim();
  const timeMatch = value.match(/\b(?:at\s+)?(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?m\.?|p\.?m\.?)\b/i)
    || value.match(/\b(?:at\s+)?([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (!timeMatch) return null;

  const meridiem = timeMatch[3] ? timeMatch[3].replace(/\./g, '') : null;
  const time = parseClockTime(timeMatch[1], timeMatch[2], meridiem);
  if (!time) return null;
  const now = options.now || new Date();
  const timeZone = options.timeZone || CALENDAR_TIMEZONE;

  let offsetDays = resolveDateOffset(value, now, timeZone);
  if (offsetDays === null) {
    if (DATE_INDICATOR_RE.test(value)) return null;
    offsetDays = 0;
  }

  const date = relativeDate(offsetDays, now, timeZone);
  return { date, time };
}

function matchIntent(text) {
  return new Promise((resolve) => {
    const child = spawn(PYTHON_BIN, [RECOGNIZE_SCRIPT, text], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.on('error', () => resolve({ intent: null, slots: {}, cleaned: '' }));
    child.on('close', () => {
      try {
        const parsed = JSON.parse(stdout);
        resolve({ intent: parsed.intent || null, slots: parsed.slots || {}, cleaned: parsed.cleaned || '' });
      } catch (error) {
        resolve({ intent: null, slots: {}, cleaned: '' });
      }
    });
  });
}

function runWorkflow(script, args, label) {
  return new Promise((resolve) => {
    const child = spawn(NODE_BIN, [script, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => resolve({ ok: false, reply: null, error: { message: `${label}: ${error.message}` } }));
    child.on('close', () => {
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        resolve({ ok: false, reply: null, error: { message: `${label}: ${error.message}; ${stderr.slice(-300)}` } });
      }
    });
  });
}

// ─── Food logging fast path ────────────────────────────────────────────────
// Moved here from services/ha-voice-adapter/server.js on 2026-08-08 so it's
// a real part of the shared grammar router (available to iMessage as well as
// Voice) instead of being voice-only logic that the dashboard merely
// documented as if it were part of this router. Checked after grammar-match
// fails, before falling through to Main — same position it occupied in
// ha-voice-adapter's own pipeline.

function runFoodWorkflow(args) {
  return runWorkflow(HEALTH_SCRIPT, args, 'health-workflow');
}

function searchUsda(query, limit = 3) {
  return runWorkflow(NUTRITION_INDEX_SCRIPT, ['search', '--query', query, '--limit', String(limit)], 'nutrition-index');
}

// Food reports are a frequent, explicit action. The matcher only accepts
// first-person logging phrasing, then passes the food phrase to the
// deterministic recipe/USDA workflow below. Questions about food do not
// match and therefore remain Main's responsibility.
function parseFoodReport(text) {
  const normalized = String(text || '').trim();
  const match = normalized.match(/^i\s+(?:just\s+)?(?:had|ate)\s+(.+?)(?:\s+(?:for\s+)?(?:breakfast|lunch|dinner|snack))?[.!?]?$/i)
    || normalized.match(/^log\s+(.+?)(?:\s+for\s+(?:breakfast|lunch|dinner|snack))?[.!?]?$/i);
  if (!match) return null;
  const description = match[1].trim();
  return description || null;
}

// Fast local path for food reports: exact personal-recipe match only,
// confidence 1, no judgment required. Recipes are shared with meal-planner
// in the unified recipe database. Anything else — no recipe match, an
// ambiguous quantity, an unrecognized food — needs real interpretation,
// which is Main -> health-tracker's job (HEALTH_ROUTING.md).
async function tryRecipeFood(description, rawText, context) {
  const recipe = await runFoodWorkflow(['find-recipe', '--query', description]);
  if (!recipe.found || !recipe.recipe) {
    return { hit: false, trace: { reason: 'no personal recipe matched this description', description } };
  }
  const result = await runFoodWorkflow([
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
    '--origin-channel', context.channel || 'unknown',
  ]);
  return { hit: true, result, trace: { recipeName: recipe.recipe.name, description } };
}

// ─── USDA fast path (Tier 2) ─────────────────────────────────────────────────
//
// Checked between the recipe tier and Main. Only works because the quantity
// parser strips the leading quantity and unit ("half a cup of yogurt" ->
// food "yogurt", ~122g) before searching the USDA index. The USDA data is
// per-100g, so the parsed gram weight scales it proportionally.
//
// Confidence is computed from two signals (food-name match quality and
// whether the portion weight came from a real USDA portion vs a hardcoded
// default), per plans/USDA_TIER_2_PLAN.md. Matches below MIN_USDA_CONFIDENCE
// fall through to Main rather than being logged on a guess.
const MIN_USDA_CONFIDENCE = 0.5;

// Token-overlap score between the parsed food name and a USDA description.
// Returns a 0..1 fraction of the food-name's own tokens that also appear in
// the description (so "yogurt" vs "Yogurt, NFS" scores 1 even though the
// strings differ). Uses singularization so "banana" -> "Bananas, raw" scores
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

// Crude singularization for matching: "egg" -> "eggs", "cookies" -> "cookie".
// Only strips a trailing s/es — good enough for food-name matching without a
// real stemmer.
function singularize(word) {
  return String(word || '').toLowerCase().replace(/es$/, '').replace(/s$/, '');
}

// Decides whether a USDA description is a reliable match for the parsed food
// name, beyond just sharing a token. The BM25 index surfaces generic foods
// poorly ("soda" -> "Bread, Irish soda bread"; "oatmeal" -> "Bread, oatmeal";
// "rice" -> "Snacks, rice cracker"), so we demand the food name be the
// PRIMARY noun of the hit, not a trailing flavor/modifier:
//   * single-token food name: its singularized form must be the ENTIRE head
//     phrase before USDA's first descriptor comma ("yogurt" -> "Yogurt,
//     NFS"; "oatmeal" ↛ "Bread, oatmeal"). This used to check only the
//     FIRST WORD, which let compounds like "Spaghetti sauce" pass as a
//     match for "spaghetti" — the first word matches, but "sauce" (not
//     spaghetti) is the actual food identity, and it beat the real
//     "Spaghetti, spinach, dry" entry on the shortest-description tiebreak
//     below. Fixed 2026-08-10 after "a bowl of spaghetti" resolved to
//     Spaghetti sauce. Requiring the whole head phrase (not just its first
//     word) to equal the food token rejects "Spaghetti sauce" (head phrase
//     is two words) while still accepting "Spaghetti, spinach, dry" (head
//     phrase is exactly "Spaghetti") — and as a side effect also rejects
//     "Spaghetti squash, cooked" for the same query, which is correct.
//   * multi-token food name: >= 0.5 token overlap ("chicken breast" ->
//     "Chicken breast tenders").
function isReliableFoodMatch(foodName, description) {
  const foodTokens = String(foodName || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (foodTokens.length === 0) return false;
  const desc = String(description || '');
  if (desc.trim() === '') return false;

  if (foodTokens.length === 1) {
    const headPhrase = desc.split(',')[0].toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    return headPhrase.length === 1 && singularize(headPhrase[0]) === singularize(foodTokens[0]);
  }
  return foodNameMatchScore(foodName, description) >= 0.5;
}

// Confidence table from plans/USDA_TIER_2_PLAN.md. `exactFood` = the parsed
// food name's tokens appear in the match description; `exactPortion` = the
// gram weight was refined from a real USDA portion (not a hardcoded default).
// `searchFuzzy` = the candidate came from nutrition-index.js's character-
// trigram fallback (a typo/near-miss the strict FTS5 search couldn't find at
// all), not from token-overlap evidence — that's a different, weaker kind of
// signal than the exactFood table below measures, so it caps the result
// regardless of how the table scores it. Added 2026-08-10 alongside the
// fuzzy fallback so a lucky token overlap on a typo-matched food doesn't get
// treated as if it were an exact hit.
function computeUsdaConfidence({ foodName, description, refinedFromUsda, matchCount, searchFuzzy }) {
  const exactFood = foodNameMatchScore(foodName, description) >= 0.5;
  let confidence;
  if (exactFood && refinedFromUsda) confidence = 0.95;
  else if (exactFood && !refinedFromUsda) confidence = 0.85;
  else if (!exactFood && refinedFromUsda) confidence = 0.75;
  // Fuzzy + generic portion: multiple close candidates makes it weaker.
  else if (!exactFood && !refinedFromUsda && matchCount > 1) confidence = 0.50;
  else confidence = 0.60;
  if (searchFuzzy) confidence = Math.min(confidence, 0.55);
  return confidence;
}

// Full per-candidate detail (not just the description string) for every
// USDA hit the router considered but didn't auto-log. Included in the
// deferred-to-Main trace so health-tracker gets a head start — the nutrition
// numbers it would otherwise have to look up again itself — instead of
// starting from the raw food name with none of this router's work reused.
// Added 2026-08-17 per Aaron: a deferred fuzzy/no-match result was silently
// dropping the candidates the USDA search already found.
function candidateSummaries(matches) {
  return matches.map((c) => ({
    description: c.description,
    fdcId: c.fdcId,
    caloriesPer100g: c.caloriesPer100g,
    proteinPer100g: c.proteinPer100g,
    similarity: c.similarity,
    fuzzyMatch: Boolean(c.fuzzyMatch),
  }));
}

// Searches the USDA index, parses the quantity, scales the per-100g nutrition
// to the spoken portion, and logs with --resolution-type usda. Returns the
// log-food result, or null when nothing confident was found (falls through
// to Main). Mirrors the flow in plans/USDA_TIER_2_PLAN.md's tryUSDAFood
// pseudocode.
async function tryUSDAFood(description, rawText, context) {
  // 1. Parse the quantity (with USDA portion refinement so "a cup of yogurt"
  //    uses the yogurt database's own 245g/cup rather than the 240g default).
  let parsed;
  try {
    const { parseQuantity } = require(QUANTITY_PARSER);
    parsed = await parseQuantity(description, { usdaSearch: searchUsda });
  } catch (err) {
    return { hit: false, trace: { reason: `quantity parser threw: ${err.message}`, description } };
  }
  if (!parsed.foodName || parsed.grams <= 0) {
    return { hit: false, trace: { reason: 'quantity parser found no food name in this description', description } };
  }

  // 2a. Strip size/container adjectives from the parsed food name before USDA
  //     search and matching. These words describe the serving-container size,
  //     not the food identity, and their presence in the food-name tokens causes
  //     isReliableFoodMatch to fail (inflating the token count) even though the
  //     USDA BM25 search already treats them as stop words and correctly finds
  //     the matching entries. Reported against "large" ("a large Sweet Tea") on
  //     2026-08-10: sweet-tea-glycemic-index-request that silently fell through
  //     to Main after the fast path rejected it at 1/3 < 0.5 token overlap.
  const SIZE_ADJECTIVES = new Set(['large', 'small', 'medium', 'petite', 'grande', 'venti']);
  const adjTokens = String(parsed.foodName).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const strippedSizeWords = adjTokens.filter((t) => SIZE_ADJECTIVES.has(t));
  const cleanedAdj = adjTokens.filter((t) => !SIZE_ADJECTIVES.has(t)).join(' ');
  // Included on every outcome below so the dashboard can always show what the
  // quantity parser actually extracted (grams/unit/quantity, and which size
  // words it recognized and stripped) — not just the final USDA search
  // query. Requested 2026-08-10 after "was it the 'large' that broke this?"
  // came up with no way to check without reading source.
  const quantityParse = {
    parsedFoodName: parsed.foodName,
    strippedSizeWords,
    grams: parsed.grams,
    quantity: parsed.quantity,
    unit: parsed.unit,
    refinedFromUsda: Boolean(parsed.refinedFromUsda),
  };
  if (!cleanedAdj) {
    return { hit: false, trace: { reason: 'food name was only size adjectives, nothing left to search', quantityParse } };
  }
  parsed.foodName = cleanedAdj;

  // 2. Search the USDA index on the stripped food name.
  const search = await searchUsda(parsed.foodName, 3);
  if (!search || !search.ok || !Array.isArray(search.matches) || search.matches.length === 0) {
    return { hit: false, trace: { reason: 'USDA index returned no candidates', searchQuery: parsed.foodName, quantityParse } };
  }

  // 3. Pick the best match: the highest-ranked candidate that is a reliable
  //    food-name match, preferring the most generic (shortest) description —
  //    but preferring a "cooked" preparation state over "dry"/"raw"/
  //    "uncooked" first, ahead of word count. A spoken food report describes
  //    something already eaten, so the dry/raw ingredient state is almost
  //    never the right one even when it's the shorter description — e.g.
  //    "Spaghetti, spinach, dry" (~370 kcal/100g) used to beat "Spaghetti,
  //    spinach, cooked" (~120 kcal/100g) on a word-count tie alone, a ~3x
  //    logging error. Fixed 2026-08-10 alongside the head-phrase match fix.
  //    Fuzzy-fallback candidates (from nutrition-index.js's trigram search —
  //    the strict FTS5 search found nothing at all) are pre-vetted by
  //    similarity, not token overlap, so isReliableFoodMatch's token-overlap
  //    check doesn't apply to them; computeUsdaConfidence caps their score
  //    instead so a fuzzy hit is never treated as strong as an exact one.
  const prepStateRank = (description) => {
    const d = String(description).toLowerCase();
    if (/\bcooked\b/.test(d)) return 0;
    if (/\b(dry|raw|uncooked)\b/.test(d)) return 2;
    return 1;
  };
  let match = null;
  let matchScore = null; // [prepStateRank, wordCount]
  const searchWasFuzzy = search.matches.some((c) => c.fuzzyMatch);
  for (const candidate of search.matches) {
    if (!candidate.fuzzyMatch && !isReliableFoodMatch(parsed.foodName, candidate.description)) continue;
    const wordCount = String(candidate.description).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).length;
    const score = [prepStateRank(candidate.description), wordCount];
    if (!match || score[0] < matchScore[0] || (score[0] === matchScore[0] && score[1] < matchScore[1])) {
      match = candidate;
      matchScore = score;
    }
  }
  if (!match) {
    return {
      hit: false,
      trace: {
        reason: 'no USDA candidate was a reliable match for the parsed food name',
        searchQuery: parsed.foodName,
        candidates: candidateSummaries(search.matches),
        searchFuzzy: searchWasFuzzy,
        quantityParse,
      },
    };
  }

  // 3a. No unit specified -> portion is a guess, defer. The "no unit ->
  //     100g default" convention (quantity-parser.js) exists to make bare
  //     staple reports like "a banana" or "yogurt" instant, but it can't
  //     tell a banana from a single cashew — both hit the same 100g
  //     default. Real staples are expected to be caught earlier by the
  //     personal-recipe tier (tryRecipeFood) with a real known weight, kept
  //     up to date by Aaron; anything that falls through to the USDA tier
  //     with no unit is, by design, not a maintained staple, so 100g is a
  //     guess rather than a reasonable default (e.g. "I had a Cashew" ->
  //     100g instead of ~1g). Fixed 2026-08-17 after that exact case logged
  //     100g of cashews on a non-fuzzy, otherwise-correct identity match.
  if (!parsed.unit) {
    return {
      hit: false,
      trace: {
        reason: 'no quantity/unit was specified — the 100g default is a guess for a non-staple food, deferring to Main/health-tracker',
        searchQuery: parsed.foodName,
        candidates: candidateSummaries(search.matches),
        quantityParse,
      },
    };
  }

  // 3b. Fuzzy-fallback matches never get auto-logged, no matter what score
  //     they'd receive — they're pre-vetted by character-trigram similarity,
  //     not real food-identity evidence (isReliableFoodMatch's token-overlap
  //     check is skipped for them entirely, see the loop above). That's how
  //     "cashews" matched "Nut butter, cashew" and got logged as cashew
  //     butter: the trigram overlap between the two was enough to clear
  //     MIN_USDA_CONFIDENCE. This router is deterministic JS/SQL lookups
  //     only — it has no business guessing on weak evidence. Deferring here
  //     sends the request through the normal grammar-miss path to Main,
  //     which delegates to health-tracker (a real model) for judgment.
  //     Fixed 2026-08-17 per Aaron: the router should never call an LLM
  //     itself; ambiguity is Main/health-tracker's job, not this router's.
  if (match.fuzzyMatch) {
    return {
      hit: false,
      trace: {
        reason: 'best match came only from the fuzzy-text fallback (no reliable token-overlap evidence) — deferring to Main/health-tracker instead of guessing',
        searchQuery: parsed.foodName,
        // All candidates the fuzzy fallback surfaced (up to 3), not just the
        // top-ranked one — health-tracker gets the full shortlist plus each
        // one's already-looked-up nutrition, not just a single guess to
        // second-guess from scratch.
        candidates: candidateSummaries(search.matches),
        searchFuzzy: true,
        quantityParse,
      },
    };
  }

  const confidence = computeUsdaConfidence({
    foodName: parsed.foodName,
    description: match.description,
    refinedFromUsda: parsed.refinedFromUsda,
    matchCount: search.matches.length,
    searchFuzzy: false,
  });
  if (confidence < MIN_USDA_CONFIDENCE) {
    return {
      hit: false,
      trace: {
        reason: `best match confidence ${confidence} was below the ${MIN_USDA_CONFIDENCE} threshold`,
        searchQuery: parsed.foodName,
        candidate: match.description,
        confidence,
        searchFuzzy: false,
        similarity: match.similarity,
        quantityParse,
      },
    };
  }

  // 4. Scale per-100g nutrition to the spoken portion.
  const scaleFactor = parsed.grams / 100;
  const calories = Math.round(match.caloriesPer100g * scaleFactor);
  const protein = Math.round(match.proteinPer100g * scaleFactor * 10) / 10;

  // 5. Log it with the USDA resolution type so the audit trail shows the
  //    source. Serving is the parsed gram weight; quantity is the parsed count.
  const result = await runFoodWorkflow([
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
    '--origin-channel', context.channel || 'unknown',
  ]);
  return {
    hit: true,
    result,
    trace: {
      searchQuery: parsed.foodName,
      candidate: match.description,
      confidence,
      searchFuzzy: false,
      similarity: match.similarity,
      quantityParse,
    },
  };
}

// Tries the food-logging fast path (recipe, then USDA). Returns a
// routeRoutineRequest-shaped result on a hit, or null to let the caller fall
// through to grammar-match's own "no match" handling.
async function tryFoodFastPath(text, context, stages) {
  const description = parseFoodReport(text);
  if (!description) {
    stages.push({
      stage: 'food-report-parse',
      status: 'skip',
      detail: { reason: 'text doesn\'t look like first-person food-logging phrasing ("I had...", "I just ate...", "log ...")' },
    });
    return null;
  }
  stages.push({ stage: 'food-report-parse', status: 'pass', detail: { description } });

  const recipe = await tryRecipeFood(description, text, context);
  if (recipe.hit) {
    stages.push({ stage: 'food-recipe-tier', status: 'pass', detail: { recipeName: recipe.trace.recipeName } });
    return { handled: true, route: 'food-log-recipe', ok: Boolean(recipe.result.ok), reply: recipe.result.reply || 'Logged.', stages };
  }
  stages.push({ stage: 'food-recipe-tier', status: 'fail', detail: recipe.trace });

  const usda = await tryUSDAFood(description, text, context);
  if (usda.hit) {
    stages.push({ stage: 'food-usda-tier', status: 'pass', detail: usda.trace });
    return { handled: true, route: 'usda', ok: Boolean(usda.result.ok), reply: usda.result.reply || 'Logged.', stages };
  }
  stages.push({ stage: 'food-usda-tier', status: 'fail', detail: usda.trace });

  return null;
}

function stableIdempotencyKey(context, text, route) {
  const source = [context.channel, context.accountId, context.conversationId, context.messageId, route, text].join('|');
  return crypto.createHash('sha256').update(source).digest('hex');
}

// "Never mind" cancels the whole turn, no matter where it falls in the
// phrase (leading — e.g. an accidental wake word followed by "never mind,
// ignore that" — trailing, or standalone) — this is a global escape hatch.
// It's checked first in routeRoutineRequest, before matchIntent spawns the
// recognizer subprocess, so saying it is always the fast path out of a
// call, never the slow one. Was anchored to end-of-string only until
// 2026-08-10, when a leading "never mind" fell through to grammar-match
// and got misrouted to the research agent instead of being cancelled.
const NEVERMIND_RE = /\bnever\s*mind\b/i;

// `stages` is a per-request trace of the places a request can die:
// input -> escape-hatch -> grammar-match -> slot-parse -> dispatch, with
// grammar-match failures branching into the food fast path's own
// food-report-parse -> food-recipe-tier -> food-usda-tier chain. It's
// returned alongside `handled`/`route`/`reply` on every outcome (not just
// failures) so a caller can log it verbatim and a dashboard can render it
// as a pipeline instead of a single opaque true/false. Added 2026-08-08
// after "11.30 PM" silently died in slot-parse with no trace of why — see
// project-calendar-period-time-separator-bug-2026-08-08. The food-fastpath
// stages were split from one opaque pass/fail into three on 2026-08-10 after
// a McDonald's Coke report failed silently — see the dashboard investigation
// that added per-stage detail rendering for these three stages.
async function routeRoutineRequest(context) {
  const stages = [];
  const text = String(context.text || '').trim();
  if (!text) {
    stages.push({ stage: 'input', status: 'fail', detail: { reason: 'empty text' } });
    return { handled: false, stages };
  }
  stages.push({ stage: 'input', status: 'pass', detail: { text } });

  if (NEVERMIND_RE.test(text)) {
    stages.push({ stage: 'escape-hatch', status: 'matched', detail: { pattern: 'trailing "never mind"' } });
    return {
      handled: true,
      route: 'nevermind-cancel',
      ok: true,
      reply: 'OK, never mind.',
      stages,
    };
  }
  stages.push({ stage: 'escape-hatch', status: 'skip' });

  const { intent, slots, cleaned } = await matchIntent(text);
  if (!intent) {
    stages.push({
      stage: 'grammar-match',
      status: 'fail',
      detail: { cleaned, reason: 'no sentence grammar matched the cleaned text' },
    });
    const foodResult = await tryFoodFastPath(text, context, stages);
    if (foodResult) return foodResult;
    return { handled: false, stages };
  }
  stages.push({ stage: 'grammar-match', status: 'pass', detail: { cleaned, intent, slots } });

  const bail = (reason, detail) => {
    stages.push({ stage: 'slot-parse', status: 'fail', detail: { reason, ...detail } });
    return { handled: false, stages };
  };

  let route;
  let result;

  switch (intent) {
    case 'WorkoutLog':
      route = 'workout-log';
      result = await runWorkflow(HEALTH_SCRIPT, [
        'log-workout', '--idempotency-key', stableIdempotencyKey(context, text, route),
        '--original', text, '--origin-channel', context.channel || 'unknown',
      ], 'health-workflow');
      break;

    case 'DailyRunLog':
      route = 'daily-run-log';
      result = await runWorkflow(DASHBOARD_SCRIPT, [
        'complete-habit', '--query', 'Run',
      ], 'dashboard-workflow');
      break;

    case 'AddCalendar': {
      if (!slots.title) return bail('missing event title', { slot: 'title' });
      const parsed = parseCalendarWhen(slots.when, { timeZone: CALENDAR_TIMEZONE });
      if (!parsed) return bail(`could not parse a date/time from "${slots.when || ''}"`, { slot: 'when', value: slots.when || null });
      route = 'calendar-add';
      result = await runWorkflow(CALENDAR_SCRIPT, [
        'add', '--title', slots.title, '--date', parsed.date, '--time', parsed.time,
      ], 'calendar-workflow');
      break;
    }

    case 'AddToBoard': {
      const board = boardKey(slots.board);
      if (!board) return bail(`unrecognized board "${slots.board || ''}"`, { slot: 'board', value: slots.board || null });
      if (!slots.item) return bail('missing item text', { slot: 'item' });
      route = 'dashboard-add';
      result = await runWorkflow(DASHBOARD_SCRIPT, ['add', '--board', board, '--text', slots.item], 'dashboard-workflow');
      break;
    }

    case 'ListBoard': {
      const board = boardKey(slots.board);
      if (!board) return bail(`unrecognized board "${slots.board || ''}"`, { slot: 'board', value: slots.board || null });
      route = 'dashboard-list';
      result = await runWorkflow(DASHBOARD_SCRIPT, ['list', '--board', board], 'dashboard-workflow');
      break;
    }

    case 'CompleteItem': {
      if (!slots.item) return bail('missing item text to complete', { slot: 'item' });
      const board = boardKey(slots.board);
      route = board ? 'dashboard-complete' : 'dashboard-complete-any';
      const args = board
        ? ['complete', '--query', slots.item, '--board', board]
        : ['complete-any', '--query', slots.item];
      result = await runWorkflow(DASHBOARD_SCRIPT, args, 'dashboard-workflow');
      break;
    }

    case 'CompleteAnyFree':
      if (!slots.item) return bail('missing item text to complete', { slot: 'item' });
      route = 'dashboard-complete-any';
      result = await runWorkflow(DASHBOARD_SCRIPT, ['complete-any', '--query', slots.item], 'dashboard-workflow');
      break;

    case 'RemoveFromBoard': {
      const board = boardKey(slots.board);
      if (!board) return bail(`unrecognized board "${slots.board || ''}"`, { slot: 'board', value: slots.board || null });
      if (!slots.item) return bail('missing item text', { slot: 'item' });
      route = 'dashboard-remove';
      result = await runWorkflow(DASHBOARD_SCRIPT, ['remove', '--board', board, '--query', slots.item], 'dashboard-workflow');
      break;
    }

    case 'CompleteHabit':
      if (!slots.item) return bail('missing habit name', { slot: 'item' });
      route = 'dashboard-complete-habit';
      result = await runWorkflow(DASHBOARD_SCRIPT, ['complete-habit', '--query', slots.item], 'dashboard-workflow');
      break;

    case 'AddListItem': {
      // {list} covers Work/Personal/Market Lou as well as custom lists —
      // dashboard-workflow.js's resolveListTarget decides which, so no
      // board-name guard here (unlike the list-management cases below).
      if (!slots.list) return bail('missing list name', { slot: 'list' });
      if (!slots.item) return bail('missing item text', { slot: 'item' });
      route = 'dashboard-add-list-item';
      result = await runWorkflow(DASHBOARD_SCRIPT, ['add-list-item', '--list', slots.list, '--text', slots.item], 'dashboard-workflow');
      break;
    }

    case 'CompleteListItem':
      if (!slots.list) return bail('missing list name', { slot: 'list' });
      if (!slots.item) return bail('missing item text', { slot: 'item' });
      route = 'dashboard-complete-list-item';
      result = await runWorkflow(DASHBOARD_SCRIPT, ['complete-list-item', '--list', slots.list, '--item', slots.item], 'dashboard-workflow');
      break;

    // ─── Calendar list / delete / reschedule ────────────────────────
    case 'ListCalendar': {
      const listParsed = parseCalendarWhen(slots.when, { timeZone: CALENDAR_TIMEZONE });
      const listDate = listParsed ? listParsed.date : relativeDate(0, new Date(), CALENDAR_TIMEZONE);
      route = 'calendar-list';
      result = await runWorkflow(CALENDAR_SCRIPT, ['list', '--date', listDate], 'calendar-workflow');
      break;
    }

    case 'DeleteCalendar': {
      if (!slots.title) return bail('missing event title', { slot: 'title' });
      const delParsed = parseCalendarWhen(slots.when, { timeZone: CALENDAR_TIMEZONE });
      if (!delParsed) return bail(`could not parse a date/time from "${slots.when || ''}"`, { slot: 'when', value: slots.when || null });
      route = 'calendar-delete';
      result = await runWorkflow(CALENDAR_SCRIPT, [
        'delete', '--title', slots.title, '--date', delParsed.date,
      ], 'calendar-workflow');
      break;
    }

    case 'RescheduleCalendar': {
      if (!slots.title) return bail('missing event title', { slot: 'title' });
      const oldParsed = parseCalendarWhen(slots.when, { timeZone: CALENDAR_TIMEZONE });
      if (!oldParsed) return bail(`could not parse the original date/time from "${slots.when || ''}"`, { slot: 'when', value: slots.when || null });
      const newWhenText = [slots.new_when, slots.new_time].filter(Boolean).join(' ');
      const newParsed = parseCalendarWhen(newWhenText, { timeZone: CALENDAR_TIMEZONE });
      if (!newParsed) return bail(`could not parse the new date/time from "${newWhenText}"`, { slot: 'new_when/new_time', value: { new_when: slots.new_when || null, new_time: slots.new_time || null } });
      route = 'calendar-reschedule';
      result = await runWorkflow(CALENDAR_SCRIPT, [
        'reschedule', '--title', slots.title, '--date', oldParsed.date,
        '--new-date', newParsed.date, '--new-time', newParsed.time,
      ], 'calendar-workflow');
      break;
    }

    // ─── Finance ────────────────────────────────────────────────────
    case 'AddExpense': {
      if (!slots.name) return bail('missing expense name', { slot: 'name' });
      if (!slots.amount) return bail('missing expense amount', { slot: 'amount' });
      if (!slots.due_day) return bail('missing due day', { slot: 'due_day' });
      const amountMatch = String(slots.amount).match(/(\d+(?:\.\d+)?)/);
      if (!amountMatch) return bail(`could not extract a number from amount "${slots.amount}"`, { slot: 'amount', value: slots.amount });
      const dueDayMatch = String(slots.due_day).match(/(\d+)/);
      if (!dueDayMatch) return bail(`could not extract a number from due day "${slots.due_day}"`, { slot: 'due_day', value: slots.due_day });
      const amount = Number(amountMatch[1]);
      const dueDay = Number(dueDayMatch[1]);
      if (dueDay < 1 || dueDay > 31) return bail(`due day ${dueDay} is out of range (1-31)`, { slot: 'due_day', value: dueDay });
      route = 'finance-add-expense';
      const expenseArgs = ['add-expense', '--name', slots.name, '--amount', String(amount), '--due-day', String(dueDay)];
      if (slots.notes) expenseArgs.push('--notes', slots.notes);
      result = await runWorkflow(FINANCE_SCRIPT, expenseArgs, 'finance-workflow');
      break;
    }

    // ─── Health tracker ─────────────────────────────────────────────
    case 'ListToday': {
      const todayParsed = parseCalendarWhen(slots.when, { timeZone: CALENDAR_TIMEZONE });
      route = 'health-list-today';
      const todayArgs = ['list-today'];
      if (todayParsed && todayParsed.date) todayArgs.push('--date', todayParsed.date);
      result = await runWorkflow(HEALTH_SCRIPT, todayArgs, 'health-workflow');
      break;
    }

    case 'ActivityToday': {
      const activityParsed = parseCalendarWhen(slots.when, { timeZone: CALENDAR_TIMEZONE });
      route = 'health-activity-today';
      const activityArgs = ['activity-today'];
      if (activityParsed && activityParsed.date) activityArgs.push('--date', activityParsed.date);
      result = await runWorkflow(HEALTH_SCRIPT, activityArgs, 'health-workflow');
      break;
    }

    case 'CorrectFood': {
      route = 'health-correct-food';
      const correctArgs = ['correct-food', '--idempotency-key', stableIdempotencyKey(context, text, route)];
      if (slots.when) {
        const cfParsed = parseCalendarWhen(slots.when, { timeZone: CALENDAR_TIMEZONE });
        if (cfParsed && cfParsed.date) correctArgs.push('--date', cfParsed.date);
      }
      result = await runWorkflow(HEALTH_SCRIPT, correctArgs, 'health-workflow');
      break;
    }

    case 'RemoveFood': {
      route = 'health-remove-food';
      const removeArgs = ['remove-food', '--idempotency-key', stableIdempotencyKey(context, text, route)];
      if (slots.when) {
        const rfParsed = parseCalendarWhen(slots.when, { timeZone: CALENDAR_TIMEZONE });
        if (rfParsed && rfParsed.date) removeArgs.push('--date', rfParsed.date);
      }
      result = await runWorkflow(HEALTH_SCRIPT, removeArgs, 'health-workflow');
      break;
    }

    case 'UndoFood': {
      route = 'health-undo';
      const undoArgs = ['undo', '--idempotency-key', stableIdempotencyKey(context, text, route)];
      if (slots.when) {
        const ufParsed = parseCalendarWhen(slots.when, { timeZone: CALENDAR_TIMEZONE });
        if (ufParsed && ufParsed.date) undoArgs.push('--date', ufParsed.date);
      }
      result = await runWorkflow(HEALTH_SCRIPT, undoArgs, 'health-workflow');
      break;
    }

    // Meal-planner grammar intents (GetPlan/ListRecipes/FindRecipe/
    // ConfirmPlan/AssemblePlan/AddPlanItem) were disabled 2026-08-08 —
    // sentences/en/meal-planner.yaml.disabled is no longer loaded, so these
    // intent names can never actually be produced by matchIntent(). Main
    // still delegates meal-planning requests to `meal-planner` conversationally.

    // ListAllBoards/ListHabits/ListLists/CreateList/ShowList/ScheduleItem/
    // RescheduleItem/UnscheduleItem were cut from dashboard.yaml on
    // 2026-08-10 at Aaron's request — voice is only for the binary daily
    // habits and adding items to Work/Personal/Market Lou; read-backs,
    // list creation, and due-date scheduling all go through the kiosk
    // instead. These intent names can no longer be produced by matchIntent().

    case 'GetBalance':
    case 'GetBudgetForecast':
    case 'EditListItem':
    case 'RemoveListItem':
    case 'RenameList':
    case 'DeleteList':
      // These intents have been removed from the router — they were
      // low-frequency operations better handled by the model-based agent.
      return bail(`"${intent}" was intentionally removed from the router — handled by the model-based agent instead`, { removedIntent: intent });

    default:
      // Intent was recognized by the grammar but has no wired case in the
      // router — likely a Phase-4 tool that was deliberately deferred or
      // an ask-Aaron-first item. Fall through to the model-based agent.
      return bail(`intent "${intent}" was recognized by the grammar but has no wired case in the router`, { unwiredIntent: intent });
  }

  stages.push({ stage: 'slot-parse', status: 'pass', detail: { route } });

  const reply = result.reply || (result.error && (result.error.message || result.error.code)) ||
    (result.ok ? 'Done.' : 'Sorry, that command was routed correctly but the action failed.');
  stages.push({
    stage: 'dispatch',
    status: result.ok ? 'pass' : 'fail',
    detail: {
      route,
      ok: Boolean(result.ok),
      error: result.error ? (result.error.message || result.error.code || String(result.error)) : null,
    },
  });
  return { handled: true, route, ok: Boolean(result.ok), reply, stages };
}

module.exports = {
  routeRoutineRequest,
  matchIntent,
  boardKey,
  parseCalendarWhen,
  // Pure food-fastpath helpers, exported for unit testing without spawning
  // the real health-tracker/USDA subprocesses (see food-fastpath.test.js).
  parseFoodReport,
  foodNameMatchScore,
  singularize,
  isReliableFoodMatch,
  computeUsdaConfidence,
};
