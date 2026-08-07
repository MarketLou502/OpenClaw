# Plan: Tool Catalog + Generic Phrase→Tool Matching for the QA Dashboard

Handoff doc for whichever coding agent picks this up. Read fully before
touching code — this documents decisions made in a long planning
conversation with Aaron, including some corrections to earlier assumptions.
Don't skip the "Non-goals" section; it's there because an earlier version of
this plan scoped in something Aaron explicitly does not want.

## Background — how routing actually works today (confirmed, not assumed)

`services/shared-routine-router/` is a plain phrase-matcher (hassil grammar +
regex, no LLM). When `services/ha-voice-adapter/server.js` gets an utterance,
it calls the router first. If the router matches a known intent, it runs a
**local script** (e.g. `workspace-health-tracker/scripts/health-workflow.js`)
and returns immediately — fast, no AI involved at any point. If nothing
matches, the request falls through to a real agent turn (Main, via the
Gateway WebSocket), which is slow because an LLM has to think.

**Important terminology correction from this conversation:** the router
never invokes a live "agent" (no LLM, no session). It calls a *script* that
happens to live inside that agent's workspace folder. When the dashboard's
network map shows "router → health agent," that's shorthand for "router →
health-tracker's own script" — nothing wakes up an actual health-tracker
agent process. Keep this distinction precise in any new UI copy this plan
produces; don't imply the router "asks" or "sends to" an agent when it
mechanically runs one of that agent's scripts.

The one existing example of a phrase bypassing the router's hassil grammar
entirely: food logging. `ha-voice-adapter/server.js` has its own hardcoded
regex (`parseFoodReport`) checked before the router even runs, backed by
`health-workflow.js`'s `find-recipe`/`add-recipe`. `trace-noc`'s
`DOMAIN_FASTPATHS` array in `lib/phrase-tracker.js` mirrors this one example
today — it's the only populated entry.

## What this plan is actually for

Aaron doesn't want AGI-style auto-invention. He self-limits what he asks the
bot for to things he already knows map to *some* existing capability. So the
valuable thing to build is not "detect any recurring phrase and improvise a
new capability for it" — it's:

> **Given a phrase Aaron actually says, recognize that it matches a tool
> that already exists somewhere in the codebase, and make hitting that tool
> fast (skip Main) with the least amount of new backend logic possible.**

Concretely, this replaces "hand-write one `DOMAIN_FASTPATHS` entry per
domain, from scratch, every time" with "look a phrase up against a real
catalog of what already exists, and only write the thin trigger-matching
layer."

## Non-goals (do not build these without stopping and asking Aaron)

- **Do not auto-author brand-new backend scripts, data models, or validation
  logic.** If a phrase doesn't match anything in the tool catalog, that's a
  true new-capability case — flag it for manual review same as today, don't
  try to invent a script for it. Aaron confirmed this case is rare in
  practice; it is explicitly not the target of this work.
- **Do not auto-apply a brand-new router intent (new YAML block + new
  `case` in `shared-routine-router/index.js`).** This is categorically
  riskier than the existing "append a sentence to an existing intent" auto-
  apply flow, because nothing today tests whether a newly invented pattern
  accidentally matches phrases it shouldn't — the existing test-and-rollback
  safety net doesn't cover that failure mode. A brand-new intent must go
  through a human-reviewed apply step, not the one-click green button that
  sentence-appends get. (A future increment could close this gap by
  auto-generating negative test cases from every other intent's existing
  sentences — worth keeping in mind, but out of scope for this plan.)
- Don't touch `qa-apply-diff.sh`'s existing safety behavior (patch → test →
  auto-rollback) for the sentence-append case — it's correct as-is.

## Phase 1 — Build the tool catalog

Goal: one source of truth listing every script/subcommand that already
exists across agents, so matching stops being "hand-write a detector per
domain" and becomes "look it up."

Known workflow scripts to inventory (confirm current owning agent against
`CURRENT_ARCHITECTURE.md` — some of these workspace names are historical and
the roster has shifted before, e.g. `boards` was absorbed into `lists`):

- `workspace-health-tracker/scripts/health-workflow.js` (recipes, workouts, runs)
- `workspace-main/scripts/dashboard-workflow.js` (boards/lists/habits — full
  subcommand list is much larger than what the router currently exposes:
  `add`, `complete`, `remove`, `reschedule`, `rename-list`, `delete-list`,
  `edit-list-item`, etc.)
- `workspace-main/scripts/calendar-workflow.js` (`add`, `delete`, `list`,
  `reschedule`)
- `workspace-finance-agent/scripts/finance-workflow.js` (`add-expense`,
  `remove-expense`, `balance`, `budget-forecast`, `review` — currently zero
  router coverage)
- `workspace-meal-planner/scripts/meal-planner-workflow.js`
- `workspace-goals/scripts/dashboard-workflow.js`,
  `workspace-lists/scripts/dashboard-workflow.js`,
  `workspace-boards/scripts/dashboard-workflow.js` — likely copies/forks of
  the same tool; confirm which is canonical before cataloging duplicates.

For each subcommand, capture (this becomes the catalog schema):
- `tool id` (e.g. `health.add-recipe`)
- owning agent
- script path + subcommand name + required/optional args
- whether it's a "check-then-act" tool (has a lookup like `find-recipe`
  before the write, like recipes) or a plain one-shot action
- whether it's already reachable via the router today (cross-reference
  `ROUTE_TO_YAML` in `phrase-tracker.js` — most of `dashboard-workflow.js`'s
  subcommands are NOT currently wired into the router grammar at all, e.g.
  `reschedule`, `rename-list`, `edit-list-item`)

Discovery approach: scripts don't share one consistent argument-parsing
style (some use `switch/case`, some don't) — don't try to auto-introspect
this blindly. Read each script's own `--help`/argument list by hand and
write the catalog entries deliberately. This is a one-time, careful pass,
not something to automate on a schedule.

Store it as a plain data file (`services/trace-noc/lib/tool-catalog.js`,
exporting an array), same style as `DOMAIN_FASTPATHS` today — no external
schema/DB needed for a single-user local tool.

## Phase 2 — Generalize phrase→tool matching

Replace the single hardcoded `DOMAIN_FASTPATHS` food entry with matching
driven by the Phase 1 catalog. Reuse the scoring approach already built for
router-intent matching (`pickBestIntentForPhrase` in `phrase-tracker.js` —
vocabulary overlap + confidence margin) rather than inventing a second
matching algorithm.

Keep the existing three-way split per cluster, now catalog-driven instead of
hardcoded:
- matches a tool **already wired into the router grammar** → today's
  `router-match` path, unchanged (safe, auto-appliable).
- matches a **catalog tool not yet wired into the router** → new middle
  case (see Phase 4 below on how to actually make these fast, not just
  labeled).
- matches nothing in the catalog → `new-capability`, unchanged, flagged for
  manual review, low priority per Aaron.

Preserve the existing "check known before offering to add" behavior
(`checkKnown`/`add` split) generically — it should come from a catalog
entry's `check-then-act` flag, not be hand-coded per domain the way food is
today.

## Phase 3 — Generic widget generation

Frontend already does most of this correctly: `renderDomainAddForm` in
`public/app.js` builds its form from `entry.domainMatch.formFields` without
hardcoding field names. Phase 3 is mostly backend — make sure every catalog
tool entry declares its own `formFields` (label/type/required/max) the same
shape food's does today, so no frontend changes are needed for new tools.
Only build new frontend widget code if a tool needs an input type the
current generic form doesn't support (today: text/number).

## Phase 4 — Making a matched-but-unwired tool actually fast

This is the part that needs a real decision, not just detection. A phrase
matching a catalog tool doesn't make it fast by itself — it still hits Main
every time unless something bypasses the grammar. Two paths, pick per case:

1. **The tool's action already has a router intent, just missing this
   phrasing** (e.g. dashboard actions largely already exist in
   `ROUTE_TO_YAML`) → this is just today's sentence-append flow. No new
   category needed.
2. **The tool has no router intent at all** (e.g. anything in
   `finance-workflow.js`, or `dashboard-workflow.js`'s `reschedule`/
   `rename-list`/etc.) → two sub-options, in order of preference:
   - **Prefer:** a small dedicated local regex fast-path in
     `ha-voice-adapter`, same shape as `parseFoodReport` — appropriate when
     the phrasing is low-variety and a single regex covers it well. This has
     real precedent and is low-risk.
   - **Fallback:** a genuinely new router intent (new YAML + new `case` in
     `index.js`) — only when the phrasing has enough natural variation that
     a single regex is a bad fit. This is the higher-risk, human-reviewed,
     manual-apply path described in Non-goals — surface it as a proposal on
     the dashboard, do not wire an auto-apply button for it.

## Phase 5 — Dashboard representation

This is the part Aaron explicitly wants to look good, not just function.

- Keep the existing Phrase Tracker classification badges/banner styling
  (`.phrase-target-banner.match/.no-match/.domain-candidate` in
  `style.css`) — extend the color/label set rather than inventing new visual
  language, per the existing dark-theme-only, single-user constraint.
- For a cluster matched against the catalog, the detail panel should show:
  tool name, owning agent, whether it's already fast (router-wired) or would
  need Phase 4 work to become fast, and — reusing what already shipped this
  session — the **Agent Path** panel showing who *actually* handled it
  historically, so a mismatch between "proposed tool" and "actual handler"
  is visible immediately (this already exists, don't rebuild it).
- Add a standalone **Tool Catalog** view/tab (new, browsable list of
  everything in Phase 1's catalog, filterable by agent) — this doubles as
  living documentation of "what can the bot already do," independent of
  phrase clustering, and is the natural place to eyeball catalog coverage
  gaps.
- New-capability clusters keep their current "flagged for manual review"
  treatment — don't add urgency/visual weight disproportionate to how rare
  Aaron expects them to be.

## Suggested delivery order (checkpoint with Aaron after each)

1. Phase 1 catalog (data only, no UI change) — show Aaron the catalog
   contents before building anything on top of it, since accuracy here
   determines everything downstream.
2. Phase 2 + 3 (matching + generic widgets) — should make food logging keep
   working unchanged, plus light up 1-2 new real examples (e.g. "add the
   recipe ___" via existing `add-recipe`, or a dashboard action not yet in
   the router grammar) as a concrete demo.
3. Phase 5 catalog browser tab — cheap, high visibility, good checkpoint.
4. Phase 4 — do last and case-by-case; each new fast-path (regex or new
   intent) is its own small reviewed change, not a batch.
