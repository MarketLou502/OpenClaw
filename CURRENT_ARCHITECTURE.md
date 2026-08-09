# Current OpenClaw Architecture

Last updated: 2026-08-08

## User-facing routes

1. Native iMessage → OpenClaw Gateway (port 18789) → `shared-routine-router`
   (grammar router + food-logging fast path, see below) → Main → native
   Gateway reply to the originating iMessage thread.
2. Home Assistant Voice PE → voice adapter → `shared-routine-router`
   (same deterministic router iMessage uses — narrow grammar-matched
   commands, plus a food-logging fast path: exact personal-recipe match,
   then a USDA nutrition-index lookup with portion-size parsing for
   quantity phrasing like "half a cup of yogurt") or isolated Main session
   → spoken response through Home Assistant. Unmatched requests, and any
   food/drink report past both the recipe and USDA tiers, always go to
   Main; the adapter does not act as a second general-purpose assistant.
   The adapter's own weather shortcut (wttr.in lookup) was removed
   2026-08-08 — weather questions now go to Main/`research` like any other
   knowledge question. Voice Main turns run Main's own normal configured
   model (ollama/llama3.1:8b) while retaining Main's identity, context,
   tools, and conversation ownership.
3. OpenClaw Control UI → Main.
4. Sports Betting Discord account → Sports Betting agent. This is the only
   active Discord account and binding.

The adapter handles routine dashboard language programmatically before Main:
reading, adding, completing, and removing fixed-board items; reading and
completing daily habits; and reading, creating, renaming, deleting, and
updating custom lists. These routes call the existing deterministic workflows,
which remain the only writers and retain their unique-match safety checks.

## Internal work

As of 2026-08-02, every dashboard widget has its own specialist agent that
Main delegates to conversationally (i.e. for requests the deterministic
router in the previous section didn't already catch). This did **not**
require any change to that deterministic router — it dispatches by
intent+slot to scripts, never by agent identity, so it works unchanged
regardless of how many agents sit above it.

- Main is a pure task delegator/router with only three tools:
  `sessions_send`, `session_status`, and `sessions_history`. It does not
  answer questions or execute tasks itself. All knowledge questions go to
  `research`. Main delegates via `sessions_send` (never `sessions_spawn` —
  that tool is denied for main on purpose: it caps a spawned child at
  main's own restrictive tool policy instead of the target's real one):
  calendar work to
  `scheduler` (`workspace-main/CALENDAR_ROUTING.md`), health work to
  `health-tracker` (`workspace-main/HEALTH_ROUTING.md`), Daily Goals/habit
  work to `goals`, task-board and task-linked due-date work to `boards`,
  custom saved-list work to `lists`, grocery and meal-planning work to
  `meal-planner`, finance questions to `finance-agent`, and all knowledge
  questions to `research`.
  `systems-qa` has two narrow, designed jobs now; the rest of its eventual
  "keep OpenClaw healthy" role remains undesigned. Job one: diagnosing a
  delegated call that didn't resolve within Main's poll budget
  (`workspace-systems-qa/SOUL.md`'s "one designed job"). Job two, added
  2026-08-02: a nightly `openclaw cron` job
  (`systems-qa-nightly-routing-review`, 05:00, isolated session, a per-job
  `openrouter/anthropic/claude-haiku-4-5` override — not systems-qa's usual
  local model) that reviews the prior day's iMessage and voice traffic
  against `shared-routine-router`'s grammar, classifies each turn as
  fast-pathed or escalated to Main, and proposes — never applies —
  validated grammar diffs for gaps it finds, plus flags recurring verbatim
  phrasings as candidates for a new dedicated fast path (the
  `resolveAndLogFood` pattern). All reads/writes for this job go through
  two whitelisted wrapper scripts
  (`workspace-systems-qa/scripts/qa-read.sh`/`qa-propose.sh`); it has no
  path to write to `shared-routine-router` itself. Two of the voice
  adapter's fast paths that previously left no queryable record of what
  was said — weather and router-matched turns — gained a fire-and-forget
  capture write the same day (`~/.openclaw/logs/voice-fastpath.jsonl`,
  after the reply is already sent) purely to feed this job; the job
  truncates that file itself each run. Both of `systems-qa`'s jobs are
  logged, not proactively surfaced — Main only reports job one back to
  Aaron if asked, and job two's cron delivery mode is `none` by the same
  convention. Full detail, including three real bugs its first live run
  surfaced, in `SYSTEM_WALKTHROUGH.html` §3.6/§3.7.
- Food/drink reports ("I had X", "I just ate X"): as of 2026-08-08 this
  logic lives inside `shared-routine-router/index.js` itself (moved from
  `services/ha-voice-adapter/server.js`, which previously ran it as
  voice-only regex/logic that the QA dashboard merely *documented* as if it
  were part of the router). It's checked right after grammar-match fails:
  first an exact personal-recipe match (recipes are shared with
  meal-planner in the unified recipe database), then a USDA nutrition-index
  search — with a real quantity/portion parser (`workspace-health-tracker/
  scripts/lib/quantity-parser.js`, "half a cup of yogurt" → ~122g) — scored
  against a confidence table (`plans/USDA_TIER_2_PLAN.md`). Anything below
  that confidence, or with no candidate at all (e.g. a branded item like
  "a large sweet tea from McDonald's" that isn't in the generic USDA
  database), falls through to Main, which delegates to `health-tracker` the
  same as any other channel. Being inside the shared router means this fast
  path now also covers iMessage food reports, not just voice — previously
  voice-only. See `SYSTEM_WALKTHROUGH.html` §3.7 for the tier's own history
  (a staple-only fast path, removed 2026-08-07 for breaking on quantity
  phrasing, then rebuilt as the USDA tier described here, then moved into
  the shared router 2026-08-08).
- Meal-planner grammar (`GetPlan`/`ListRecipes`/`FindRecipe`/`ConfirmPlan`/
  `AssemblePlan`/`AddPlanItem`) was disabled 2026-08-08 —
  `sentences/en/meal-planner.yaml` was renamed `.disabled` and the matching
  switch cases removed from `routeRoutineRequest`. Main still delegates
  meal-planning requests to `meal-planner` conversationally; only the
  deterministic grammar fast path is gone, and only "for now."
- `scheduler` (formerly "Daily Tracker" — renamed and rescoped 2026-08-02;
  its workspace directory is still physically named
  `workspace-daily-tracker` to avoid breaking hardcoded script paths) is an
  internal calendar-only specialist with no channel binding. Its deterministic
  goal scheduler places unfinished daily habits (definitions owned by
  `goals`) into open 30-minute calendar blocks from 8:00 AM to 5:00 PM each
  day.
- The dashboard's general Lists library is independent from Daily Goals. It
  reads and writes the extensible `tasks/lists.json` store (still physically
  under `workspace-daily-tracker/tasks/`) through dashboard-api; `lists` has
  deterministic commands for list and item creation, editing, completion, and
  removal.
- `goals`/`boards`/`lists` remain "thin" specialists — they share one underlying
  deterministic CLI (`workspace-main/scripts/dashboard-workflow.js`) and one
  backing service (`dashboard-api`, the single writer), not separate data
  stores. Splitting the *agents* did not split the *data layer*, which
  remains centralized on purpose. `meal-planner` (renamed from `chef`
  2026-08-02, when it also gained meal-planning) still uses
  `dashboard-workflow.js` for its grocery list, but has its own dedicated
  data layer for recipes/meal plans — `workspace-meal-planner/scripts/meal-planner-workflow.js`
  against its own `meal-planner.sqlite`, mirroring `health-tracker`'s
  architecture rather than the thin-specialist pattern. Grocery and
  meal-planning are deliberately kept fully separate within that one agent —
  no code path connects them.
- `finance-agent` was revived as a live conversational specialist on
  2026-08-02 (previously silent/deterministic-only), and the same day gained
  balance tracking + a 45-day expense-only shortfall forecast. On 2026-08-03
  the original twice-daily paid Plaid Balance polling was archived after the
  account was confirmed as Pay As You Go (`/accounts/balance/get` costs $0.10
  per successful request). The active path is event-driven Transactions Sync:
  Plaid sends signed `SYNC_UPDATES_AVAILABLE` webhooks through a Tailscale
  Funnel to `com.openclaw.finance.plaid-webhook` on loopback port 18797; the
  receiver verifies Plaid's ES256 JWT, timestamp, and raw-body hash, then runs
  `sync_plaid_transactions.js --item-id ...`. That script stores incremental
  added/modified/removed rows in `plaid_transactions` and cached balances in
  `account_balances`. `com.openclaw.finance.transactions-sync` remains only as
  a 03:15 daily reconciliation fallback. Neither active path calls the paid
  Balance endpoint or separately priced `/transactions/refresh`. This is a
  narrower rebuild of balance
  tracking that had been fully retired 2026-07-31 (that fuller version also
  had debt/portfolio/income-schedule tracking and an execApprovals flow,
  none of which came back). Surfaces on a new Budget tab on the dashboard's
  Financials overlay and two `shared-routine-router` voice phrases. The
  original Capital One Mail poll ingestion pipeline is unchanged and
  continues running independently via `launchd`, same as before. Full
  detail in `SYSTEM_WALKTHROUGH.html` §3.5/§3.7 and
  `workspace-finance-agent/FINANCE_ARCHITECTURE.md`.
- Deterministic calendar, dashboard, health, finance-spend/review/balance,
  and Zaxby's workflows update their existing stores/services; the Echo
  dashboard reads those services and files.
- Proactive calendar and hourly-workout messages use the native Gateway
  iMessage action. There is no raw iMessage watcher.
- Model policy: the local Ollama model (`ollama/llama3.1:8b`) is the
  default for every sub-agent and for Main itself. `scheduler`,
  `meal-planner`, `research`, and `health-tracker` still run on Haiku (via
  OpenRouter) with the local model as an automatic fallback — `research`
  because its whole purpose is not relying on the local model,
  `scheduler`/`meal-planner` because their local-model tool-calling proved
  unreliable (`SYSTEM_WALKTHROUGH.html` §3.7), `health-tracker` for the
  same reason. Main no longer uses OpenRouter; it runs purely on
  `ollama/llama3.1:8b` with no cloud dependency. A same-day attempt to
  also give these five agents
  `contextPruning: {mode: "cache-ttl", ttl: "1h"}` (pairing with the
  pre-existing `cacheRetention: "long"` on the Haiku model entry) crashed the
  Gateway's full-restart config validation and was reverted by
  `openclaw doctor --fix` the same evening — **`contextPruning` is not
  currently set on any agent**; see `SYSTEM_WALKTHROUGH.html` §3.7 before
  re-adding it. Whether OpenRouter actually honors `cache_control` for
  cached reads was separately still **unverified** even before the revert
  (open upstream OpenClaw issue as of this writing) — check real usage via
  OpenRouter's own Activity dashboard or the `session-logs` skill's cost
  calculation before trusting it's saving anything, if it comes back.
- `boards` and `lists` use `ollama/qwen3.5:9b`; Lists was originally switched
  on 2026-08-02 as a live reliability test after it hit the
  `host`-field tool-arg hallucination bug on Llama 3.1 8B (§3.7). Revert by
  restoring `model.primary` to `ollama/llama3.1:8b` if quality regresses;
  pre-change config is saved at `openclaw.json.bak-20260802-213902`.
- Also 2026-08-02: two of the 40 bundled-but-disabled skills in
  `openclaw.json`'s `skills.entries` catalog were turned on — `github`
  (natural-language GitHub issue/PR access via the already-authenticated
  local `gh` CLI, account `MarketLou502`, no extra token config needed) and
  `session-logs` (queries historical session/conversation data and
  calculates usage cost across sessions — the practical way to check
  whether `cacheRetention`/`contextPruning` are actually saving anything,
  if that's retried per the note above). Confirmed live via the gateway
  log (`skills snapshot invalidated by config change` →
  `config change detected; evaluating reload`) — skill toggles hot-reload
  with no Gateway restart, unlike the agent-shape schema error above. Every
  agent except `sports-betting` (its own explicit empty `skills: []`
  allowlist) can use both. Left disabled: `gh-issues`, a related but more
  autonomous bundled skill that auto-spawns fix agents and opens PRs on its
  own with no review gate — not enabled pending a deliberate decision on
  how much autonomy to grant it on a personal repo.
- Sub-agents never *initiate* contact with Aaron — they have no channel
  binding of their own, on iMessage or voice. iMessage is bound to `main`
  only in `openclaw.json`, and the Home Assistant voice adapter hardcodes
  `agentId: 'main'` for every turn in `services/ha-voice-adapter/server.js`.
  As of 2026-08-02, every non-`main` agent also has `imsg` added to its
  `tools.deny` list in `openclaw.json`, closing off the CLI as a direct
  route too. Main's own `imsg` tool is also now denied — it routes requests
  entirely through `sessions_send` and never sends messages directly.
  **However**, a delegated sub-agent's own reply text does reach Aaron
  directly and unreviewed: the Gateway's built-in "delivery-mirror"/announce
  mechanism pushes the child's final text straight to the requester's origin
  channel (iMessage or voice) the moment the child finishes, tagged
  internally as `provider: "openclaw"`, `model: "delivery-mirror"` — Main
  does not compose or filter that message. No identifying prefix
  distinguishes a mirrored sub-agent reply from a Main-authored one. Net
  effect: the *inbound* side and the *deliberate, proactive* outbound side
  (a sub-agent choosing to text Aaron) are both closed off; the *passive*
  outbound side (the framework relaying a sub-agent's own confirmation text
  as "the reply") is open by design and was not something this repo could
  disable.

## Secrets

OpenRouter is still active. `openclaw.json` references environment variables;
the actual OpenRouter key and retained Sports Betting token are stored in the
private, mode-600 `~/.openclaw/.env` file.

## Archives

- FBB recovery archive: `archives/fbb-agent-2026-07-31/`
- Retired raw-iMessage routing archive:
  `archives/legacy-routing-2026-07-31/`

FBB is not active. Its old Discord token is intentionally not stored in its
restore manifest; restoring FBB requires a newly issued token and an explicit
agent/account/binding config change.
