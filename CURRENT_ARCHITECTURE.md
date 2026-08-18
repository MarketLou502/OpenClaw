# Current OpenClaw Architecture

Last updated: 2026-08-18

## User-facing routes

1. Native iMessage → OpenClaw Gateway (port 18789) → `inbound_claim` plugin
   chain: `shared-routine-router` (priority 100, grammar router +
   food-logging fast path, see below), then `task-tracker-checkin-reply`
   (priority 90, added 2026-08-17 — claims a reply to a pending
   `task-tracker` due-date check-in, see the `task-tracker` entry below) →
   unclaimed messages fall through to Main → native Gateway reply to the
   originating iMessage thread.
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
5. Browser, anywhere → `https://aaronsagent.online` (Hostinger VPS,
   `2.24.96.114`, nginx + Let's Encrypt) → a picker page linking to two
   independent Gemini Live voice/chat orbs, each its own Node process on the
   VPS, each a **standalone project living entirely outside this repo** (not
   an OpenClaw agent, not routed through the Gateway):
   - `/orb/spanish/` (port 18798) — the Spanish tutor. Native speech-to-speech
     via Gemini Live, reading/writing its own `progress.db`. **Moved off the
     Mac Mini and off loopback-only entirely as of 2026-08-17/18** — the
     previous "`http://localhost:18798`, Mac Mini only" description is
     stale. Source of truth for the deployed code:
     `~/Vscode/Spanish Tutor/services/voice-orb/`. This is now the **only**
     Spanish-practice path — the OpenClaw-side `spanish-tutor` agent and its
     HA Voice PE hands-free fallback were fully removed 2026-08-18 (archived
     to `archives/spanish-tutor-agent-2026-08-18/`, see "Internal work"
     below) once the split-`progress.db` risk this move created was
     understood; rather than sync three diverging copies, the simpler path
     that had already gone stale was retired.
   - `/orb/meal/` (port 18799) — the meal planner. Added 2026-08-18. A
     ChatGPT-style interface (text chat by default, full-screen photo
     capture, full-screen live voice call) backed by the same
     `meal-planner` data Main delegates to conversationally — reached over
     HTTP through `dashboard-api`, not a local database of its own. Source:
     `~/Vscode/Meal Planner Orb/services/voice-orb-meal/`. Full detail in
     "Internal work" below and `SYSTEM_WALKTHROUGH.html` §3.5.

   Both orbs are unauthenticated at the HTTP layer (no login page) — the
   only access control is that the VPS's URL isn't publicized. Neither orb
   is reachable through, known to, or gated by the OpenClaw Gateway; they
   are a second, fully separate product surface that happens to read/write
   some of the same underlying data.

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
  calendar work, task-board/due-date work, and Daily Goals/habit work all
  go to `task-tracker` (`workspace-main/CALENDAR_ROUTING.md`) — merged
  2026-08-10 from three former specialists, `scheduler`/`boards`/`goals`,
  see below — health work to `health-tracker`
  (`workspace-main/HEALTH_ROUTING.md`), custom saved-list work to `lists`,
  grocery and meal-planning work to `meal-planner`, finance questions to
  `finance-agent`, and all knowledge questions to `research`.
  Added 2026-08-14: any TikTok link (unconditional, fixed routing rule, not
  a knowledge-question judgment call) also goes to `research`. It is
  `research`'s one `exec` use case — it runs `yt-dlp` (Homebrew, installed
  2026-08-14) to pull the video's audio, transcribes it against the same
  local `whisper-mlx` Wyoming server the kitchen voice assistant uses
  (127.0.0.1:10300), and returns a summary of what the video shows/says for
  Aaron to act on later — it never implements anything from a TikTok itself.
  Scripts: `workspace-research/scripts/tiktok_transcribe.py` and
  `log_tiktok_summary.py` (the latter exists only because `research`'s
  `write`/`file_write`/`edit` tools are denied; it's the one exec-based
  workaround to persist the summary to `memory/YYYY-MM-DD.md`).
  Revised 2026-08-16 after auditing real usage against session transcripts
  (not just the memory log — most of what actually happened never made it
  there): fixed two silent failure modes found this way — (1) some videos
  were failing with a TikTok bot-detection error; fixed via `curl_cffi` +
  `yt-dlp --impersonate chrome`, plus a separate fix where yt-dlp's
  auto-picked "best" format sometimes lands on an audio-stripped CDN mirror
  (now forces `-f download/bestaudio/best`); (2) `research` was silently
  choosing not to reply on any of these failures (`ANNOUNCE_SKIP`), so Aaron
  got no error and just re-sent the same link — `SOUL.md` now makes
  replying, success or failure, an absolute rule, never silence. Also added:
  automatic support for TikTok photo/slideshow posts (image carousels —
  `yt-dlp` has no extractor for these at all), via a Playwright + Chromium
  headless-browser fallback inside the same script — loads the real page
  (plain HTTP fetch, even with correct browser impersonation, only returns a
  bot-detection shell page with no item data), clicks through nothing since
  TikTok's Swiper carousel renders all real slides into the DOM upfront, and
  saves each unique slide image to `workspace-research/tmp/latest-photo-post/`
  (overwritten per call) for `research` to view via the `read` tool before
  summarizing — the images are frequently the entire payload (tool names/
  links shown as on-screen graphics, absent from caption or audio). Backfilled
  20 previously-unprocessed/failed TikToks (18 sent before this pipeline
  existed at all, 2 that hit the bot-detection bug) into the correct dated
  memory files after re-running them for real. **Not fully verified:**
  whether `research`'s denied `image` tool blocks the `read` tool from
  actually returning image content to the model — believed to be unrelated,
  untested live.
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
- `task-tracker` (merged 2026-08-10 from `scheduler`/`boards`/`goals` — see
  `plans/TaskTracker_Unified_Agent_Design.md`; its workspace directory is
  still physically named `workspace-daily-tracker`, reused from `scheduler`
  formerly "Daily Tracker", to avoid breaking hardcoded script paths in
  `dashboard-api`, launchd, and Main's routing) is the internal specialist
  for calendar events, Work/Personal/Market Lou task boards + due dates +
  effort estimates, due-date pacing, and the Daily Goals habit bar, with no
  channel binding of its own. **2026-08-17 redesign** (see
  `workspace-daily-tracker/PACING.md`): the fixed 7:30 AM habit planner
  (`task-tracker-planner.js`, "not smart" in Aaron's words — no due-date
  awareness) is retired (`archives/task-tracker-planner-2026-08-17/`) in
  favor of `scripts/reassess.js`, called reactively off the existing
  `ai.openclaw.daily-tracker-heartbeat` job — no new cron. It still seeds
  the habit-cue queue (`message-cues.json`) the same way (free-slot logic
  extracted unchanged into `scripts/lib/slot-finder.js`), and additionally
  computes due-date pacing (`scripts/pacing.js`) for any task carrying both
  a due date and an `estimatedBlocks` (30-min unit) effort estimate —
  falling behind or missing a day raises the day's target automatically.
  When pacing goes `behind`/`at-risk`, `calendar-notification-workflow.js`
  asks `task-tracker` for a compose-only turn (facts in, text out; it still
  never sends), then delivers it itself. A new `inbound_claim` plugin,
  `plugins/task-tracker-checkin-reply/`, routes an iMessage reply to one of
  these check-ins back to `task-tracker` before Main's normal routing sees
  it — purpose-built, not a reactivation of the retired
  `archives/legacy-routing-2026-07-31/` watcher. Task-linked due-date
  events still go on the calendar as before; habits still never do.
- The dashboard's general Lists library is independent from Daily Goals. It
  reads and writes the extensible `tasks/lists.json` store (still physically
  under `workspace-daily-tracker/tasks/`) through dashboard-api; `lists` has
  deterministic commands for list and item creation, editing, completion, and
  removal.
- `task-tracker`/`lists` remain "thin" specialists — they share one underlying
  deterministic CLI (`dashboard-workflow.js`, physically in
  `workspace-daily-tracker/scripts/` and `workspace-lists/scripts/`) and one
  backing service (`dashboard-api`, the single writer), not separate data
  stores. Splitting out the *agents* did not split the *data layer*, which
  remains centralized on purpose (merging `scheduler`/`boards`/`goals` back
  into one agent on 2026-08-10 didn't change this either — same script, same
  backing service, only the agent-level split changed). `meal-planner`
  (renamed from `chef`
  2026-08-02, when it also gained meal-planning) still uses
  `dashboard-workflow.js` for its grocery list, but has its own dedicated
  data layer for recipes/meal plans — `workspace-meal-planner/scripts/meal-planner-workflow.js`
  against its own `meal-planner.sqlite`, mirroring `health-tracker`'s
  architecture rather than the thin-specialist pattern. Grocery and
  meal-planning are deliberately kept fully separate within that one agent —
  no code path connects them.
- **Meal Planner voice/chat/photo orb, built 2026-08-17/18.** Standalone
  project at `~/Vscode/Meal Planner Orb/` (sibling of the already-extracted
  `~/Vscode/Spanish Tutor/`), deployed to the same Hostinger VPS as a second
  systemd service (`voice-orb-meal`, port 18799). Reuses the Spanish tutor's
  transport layer (`server.js`, browser mic/AudioWorklet plumbing, the
  Gemini Live WebSocket client) but with two real differences:
  - **No local database.** `lib/dashboard-client.js` replaces the tutor's
    direct-`better-sqlite3` pattern with an async HTTP client against
    `dashboard-api`'s existing `/api/meal-planner/*` and `/api/grocery`
    routes — the exact same routes `meal-planner`'s own
    `dashboard-workflow.js` and the Echo Show kiosk already use. No new
    data store, no new writer; the orb is just a fourth caller of an
    already-shared API.
  - **A Tailscale tunnel connects the VPS back to the Mac Mini**, since
    `dashboard-api` (port 18795) only ever bound to the LAN, not the public
    internet, and the VPS isn't on that LAN. Both machines joined the same
    existing tailnet (Aaron's Mac Mini was already on it via the Tailscale
    macOS app; the VPS was newly enrolled). `dashboard-api` needed no code
    change — it already binds `0.0.0.0`, so Tailscale's virtual interface
    was sufficient. Verified specifically that no home-router port-forward
    exposes 18795 to the raw public internet (the whole point of the
    tunnel), and that the VPS-to-Mac path survives repeated real requests,
    not just one.
  - **Gemini Live protocol addition:** the tutor only ever used
    `realtimeInput` (streamed mic audio). The meal orb's chat composer
    needed a second message shape — `clientContent` turns (`{turns:
    [{role:'user', parts}], turnComplete: true}`, where `parts` can mix a
    `{text}` part and an `{inlineData}` JPEG part in one message) — plus
    `inputAudioTranscription`/`outputAudioTranscription` enabled in the
    session `setup`, since the session's output modality stays
    audio-only for the whole connection (fixed at setup, not switchable
    per-turn) and typed replies need a text representation of that audio
    to display as chat bubbles. One persistent Gemini Live connection
    handles both the typed-chat flow and the live voice-call flow — verified
    against Google's current API reference rather than assumed, since the
    model in use (`gemini-3.1-flash-live-preview`) postdates this
    assistant's training data.
  - **UI**: a chat thread by default (no permission prompts until the user
    acts), a composer with a camera button (opens a full-screen live camera
    view; capturing attaches a removable thumbnail above the input, sent
    together with any typed caption on the next message — the
    iMessage/WhatsApp attach-then-send pattern, not an old-style flat
    "Take Photo" button) and a dynamic send/call button, and a full-screen
    voice-call overlay (the original pulsing-orb UI) that summarizes what
    was said back into the chat thread as a bubble pair when the call ends.
  - Persona (`SOUL.md`, new content, not copied) has one absolute rule: a
    photo's calorie/protein estimate or pantry read is never logged without
    Aaron verbally/textually confirming it first.
  - Real bugs hit and fixed during this build, worth knowing before
    touching either orb's front end again: (1) setting `display: flex`
    directly on a full-screen overlay's `#id` selector silently defeats the
    browser's default `[hidden] { display: none }` rule via specificity —
    both overlays rendered on top of the chat thread at all times until
    fixed with an explicit `#id[hidden] { display: none }` override; (2) a
    composer `<textarea>` under 16px font-size triggers an unwanted
    page-zoom on focus in iOS Safari; (3) port 18799 (the meal orb's
    default) is free on the Mac Mini for local dev — `services/core-chat`,
    the previous occupant of that port, was removed 2026-08-17 (see below).
  - **Data-divergence caveat that led to a follow-up removal (2026-08-18):**
    moving the Spanish tutor's orb off the Mac Mini onto the VPS
    (2026-08-17) had turned `progress.db` into three on-disk copies — the
    `spanish-tutor` OpenClaw agent's copy (stale since 2026-08-10), a local
    dev copy under `~/Vscode/Spanish Tutor/`, and the VPS's live copy —
    with the OpenClaw agent's copy confirmed diverged from the other two
    via file hash. Rather than build a sync mechanism between three copies,
    Aaron chose to retire the OpenClaw-side agent (and with it, the HA
    Voice PE hands-free Spanish path) entirely, leaving the deployed web
    orb as the single source of truth. See the `spanish-tutor` removal
    entry below for what that involved.

- `spanish-tutor` (the OpenClaw agent, distinct from the still-live standalone
  web orb in route 5) was **fully removed 2026-08-18**, once the
  `progress.db` divergence above made clear its data could no longer be
  trusted to match the deployed orb's. Removed: the agent entry from
  `openclaw.json`'s `agents.list` and from `tools.agentToAgent.allow`; the
  entire sticky per-device "Spanish mode" enter/exit regex + routing branch
  in `services/ha-voice-adapter/server.js` (it existed only to route Home
  Assistant Voice PE utterances to this agent — nothing else in that file
  depended on it); and the agent's workspace + runtime session state,
  archived (not deleted) to `archives/spanish-tutor-agent-2026-08-18/`,
  restore instructions included. Both the Gateway and `ha-voice-adapter`
  were restarted for the changes to take effect (neither hot-reloads
  config). Net effect: Spanish practice now has exactly one path — the web
  orb at `/orb/spanish/` — not two with a silent inconsistency risk between
  them. There is no more hands-free, away-from-a-browser way to practice.
- `deep-think` (the long-horizon-recall/pattern-analysis agent, reachable via
  the `services/core-chat` web chat page on port 18799) was **deleted
  2026-08-17**, at Aaron's request, as part of an abandoned-feature audit —
  it was a real, working feature (not the never-built `deep-mode.sh`
  Main-model-swap plan it's sometimes confused with in older planning docs),
  but Aaron decided he doesn't use it. Removed outright (not archived):
  `workspace-deep-think/`, `agents/deep-think/`, `services/core-chat/`, the
  `ai.openclaw.core-chat` launchd job + plist, the `deep-think` entries in
  `openclaw.json`'s `agents.list`, Main's `subagents.allowAgents`, and
  `tools.agentToAgent.allow`, and its delegation row in
  `workspace-main/TOOLS.md`/`SOUL.md`.
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
  default for every sub-agent and for Main itself. `task-tracker`,
  `meal-planner`, `research`, and `health-tracker` still run on OpenRouter
  with the local model as an automatic fallback — `research` because its
  whole purpose is not relying on the local model, `task-tracker`/
  `meal-planner` because their local-model tool-calling proved unreliable
  (`SYSTEM_WALKTHROUGH.html` §3.7), `health-tracker` for the same reason.
  `task-tracker` ran `openrouter/deepseek/deepseek-v3.2` (inherited from
  `scheduler` at the 2026-08-10 merge) until **2026-08-17**, when Aaron had
  it switched to `openrouter/deepseek/deepseek-v4-flash-0731` as part of
  the due-date pacing redesign above — the older text describing it as
  already on "deepseek-v4-flash" at the 2026-08-10 merge was stale/wrong,
  confirmed against `openclaw.json` before making this change; don't trust
  that framing if you see it repeated elsewhere. Main no longer uses
  OpenRouter; it runs purely on
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
- `lists` uses `ollama/qwen3.5:9b` (as did `boards`, before its 2026-08-10
  merge into `task-tracker` moved it onto OpenRouter, see above); this was
  originally switched on 2026-08-02 as a live reliability
  test after it hit the `host`-field tool-arg hallucination bug on Llama 3.1
  8B (§3.7). Revert `lists` by restoring `model.primary` to
  `ollama/llama3.1:8b` if quality regresses; pre-change config is saved at
  `openclaw.json.bak-20260802-213902`.
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
- Retired `spanish-tutor` OpenClaw agent (workspace + runtime session
  state), superseded by the standalone web orb at
  `https://aaronsagent.online/orb/spanish/`:
  `archives/spanish-tutor-agent-2026-08-18/`

FBB is not active. Its old Discord token is intentionally not stored in its
restore manifest; restoring FBB requires a newly issued token and an explicit
agent/account/binding config change.

`spanish-tutor` is not active. Its archived `progress.db` is stale relative
to the deployed web orb's copy; restoring this agent as-is would reintroduce
the divergence problem that led to its removal, not fix it — see the
archive's own README for what to consider first.
