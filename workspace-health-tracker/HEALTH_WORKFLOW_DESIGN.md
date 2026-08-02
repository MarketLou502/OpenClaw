# Health Logging Workflow Design

Status: requirements approved by Aaron on 2026-07-31. The deterministic food
ledger and compact local USDA index are implemented and isolated tests pass.
Claude Haiku has successfully used the local index under the restricted health
tool policy, and a reversible production dashboard API write passed. The food
path is in normal use through Main and the native Gateway route.

## Goal

Aaron can report food naturally through iMessage or Home Assistant Voice PE.
The same health backend identifies a saved staple or estimates the food,
records calories and protein, updates the Echo dashboard totals, and returns a
short confirmation through the channel that originated the request.

The workflow tracks only:

- Calories
- Protein

It does not track carbohydrates, fat, water, or micronutrients.

## Approved interaction behavior

### Logging food

- Treat a direct statement such as "I ate a chicken sandwich" as a request to
  log food.
- If quantity or serving size is vague, estimate a normal serving instead of
  asking a clarification question.
- Do not turn quoted examples, hypothetical meals, recipes, or questions into
  food entries.
- On success, the normal spoken/text response is only: `Got that logged.`
- Do not volunteer calories, protein, running totals, sources, or assumptions
  in the success response.
- Aaron can ask afterward what the item contained or what his daily totals are.

### Nutrition resolution order

Use sources in this order of confidence:

1. A matching saved staple, using its exact stored serving values.
2. A structured item already present in the optional local vendor cache.
3. The local USDA FoodData Central index.
4. A reasonable Claude Haiku estimate when local data does not apply.

Stop when a sufficiently confident value has been found. Keep the selected
source, assumed serving, and confidence in the stored entry even though they
are not read aloud by default. The initial version has no live online lookup;
never present a Haiku estimate as current vendor data.

### Saved staples

Aaron can add a staple conversationally when he provides a name or serving and
both nutrition values, for example:

`Remember my protein smoothie as 600 calories and 45 grams of protein.`

Adding a staple requires:

- A distinct name
- A serving description when useful
- Calories per serving
- Protein grams per serving

Voice/iMessage commands do not update or delete existing staples. If the name
already exists, the workflow refuses to overwrite it and explains that the
stored definition must be changed by a coder.

### Corrections, removal, and queries

The following must be supported:

- `Actually, I ate two.`
- `Change that to eight ounces.`
- `Remove the last food.`
- `Undo that.`
- `What have I eaten today?`
- `How many calories was that?`
- `How much protein was that?`
- `What are my totals today?`

Corrections and removals preserve an audit trail. They must never silently
rewrite or delete historical evidence. References such as `that` resolve to
the most recent applicable food action in the same conversation. If there is
no safe target, the system asks which entry Aaron means instead of changing an
unrelated item.

## Proposed architecture

```text
iMessage or Home Assistant Voice PE
  -> channel adapter
  -> OpenClaw main agent
  -> health-tracker specialist (interpretation and nutrition resolution)
  -> deterministic health workflow (validation and all writes)
  -> health event ledger (source of truth)
  -> dashboard-api cumulative totals
  -> main agent
  -> originating channel
```

### Ledger versus nutrition resolver

These are intentionally separate modules.

The deterministic **health ledger** does not decide how many calories a food
contains. It records a resolved food entry, applies corrections/undo, prevents
duplicates, recalculates totals, and updates the dashboard.

The **nutrition resolver** turns a phrase such as `a McDonald's Big Mac` or
`some grilled chicken` into a proposed serving, calories, protein, source, and
confidence. The ledger accepts that proposal only after deterministic schema
and sanity validation.

This separation lets the nutrition data source or search provider change
without rewriting food history, dashboard synchronization, correction logic,
or the voice/iMessage interface.

## Local public nutrition index

Use USDA FoodData Central as the primary downloadable public dataset. Its data
is published under CC0 and can be downloaded as JSON or CSV.

Initial local sources:

- Foundation Foods for common minimally processed foods.
- FNDDS for foods and portions people commonly report eating.
- SR Legacy as a broad generic-food fallback.

Do not initially import the entire Global Branded Foods download. Its current
uncompressed download is approximately 3 GB and most fields are irrelevant to
this workflow. Branded/product coverage can be queried online or added as a
separate optional module later.

The import process should build a compact `nutrition.db` SQLite file containing
only the fields needed at runtime:

- USDA FDC ID and dataset type
- Food description and normalized search text
- Common portion descriptions and gram weights
- Calories per 100 g/serving
- Protein grams per 100 g/serving
- Dataset release date

Use a full-text index plus normalized aliases for fast lookup. Open the
finished USDA index read-only during normal health requests. Dataset refreshes
build a new database and atomically replace the old index only after validation.
Personal staples, the health event ledger, and web-result cache must live in
separate storage so a USDA refresh can never overwrite Aaron's data.

Official USDA references:

- https://fdc.nal.usda.gov/download-datasets/
- https://fdc.nal.usda.gov/data-documentation/
- https://fdc.nal.usda.gov/api-guide/

## Modular nutrition resolver

Resolution is conditional on what Aaron said:

1. Check personal staples first for every report.
2. If a restaurant or named product is present in the local index/cache, use
   that structured value.
3. For generic food, search the local USDA index first.
4. Use Claude Haiku to choose between plausible local candidates or make a
   reasonable estimate when public local data does not resolve the item.

The search and extraction pieces use provider interfaces rather than being
embedded in the health agent:

- `LocalUsdaResolver`
- `VendorCacheResolver` (optional, local data only in the initial version)
- `HaikuEstimateResolver`

Aaron chose the lightweight initial version: do not configure a managed web
search provider and do not add a live vendor-website lookup dependency. Claude
Haiku through the current OpenRouter model connection does not itself have live
website access. Therefore, when it supplies restaurant nutrition from model
knowledge, store the result as `estimate`; never claim the current vendor site
was checked.

Keep the resolver boundary modular so a direct vendor/API module can be added
later without changing the ledger, voice interface, or dashboard contract. If
an official vendor value is manually added to the local cache later, preserve
its URL and retrieval date.

### Current local index

Built on 2026-07-31 from the approved official downloads:

- Foundation Foods April 2026
- FNDDS 2021-2023, published October 2024
- SR Legacy April 2018

The compact index contains 13,545 foods and is approximately 5 MB. It is stored
at `data/nutrition.db`. The production food ledger is initialized separately at
`data/health-ledger.sqlite` with the five existing personal staples and no food
entries. `scripts/refresh-nutrition-index.js` performs a future atomic refresh.

### Restaurant items in the lightweight version

For a report such as `I had ten boneless wings with medium sauce from B-Dubs`:

- Check personal staples and the optional local vendor cache.
- Check the local USDA index for an applicable branded/generic match.
- Otherwise ask Haiku for a serving-aware estimate.
- Store Haiku's result as `estimate` with the assumed count, preparation, and
  sauce recorded.
- Reuse a corrected value only when Aaron deliberately saves it as a staple;
  do not silently promote an AI estimate to an official value.

### Validation and acceptable estimation

This is a tracking aid, not a clinical system. A reasonable estimate is better
than failing to log an ordinary meal, but obvious unit/serving mistakes must be
caught.

Before writing, validate that:

- Calories and protein are finite, non-negative numbers.
- The selected portion corresponds to what Aaron said or to a documented
  normal-serving assumption.
- Per-serving and per-100-gram values have not been confused.
- A multi-item meal is summed from its components rather than mistaken for one
  component.
- Unusually large values receive a second check before logging.

Haiku is the final judgment layer, not the first database. Its output must use
the same structured proposal schema and pass the same deterministic validation
as every other resolver.

### Responsibility boundaries

`main` owns routing, conversational context, and the one user-facing reply. It
does not calculate or write health totals itself.

`health-tracker` interprets the report, matches staples, performs a bounded
online lookup when needed, estimates portions, and produces a structured food
proposal. It does not directly edit state files, call messaging providers, or
send a second reply.

The deterministic health workflow validates the structured proposal and owns
all mutations: add, correct, remove, undo, list, add-staple, total
recalculation, and dashboard synchronization.

`dashboard-api` remains the single dashboard writer and Echo-facing API. The
dashboard's health state is a projection of the event ledger, not the primary
food history.

## Workouts and daily run

The exercise ledger is intentionally small and deterministic:

- `workout_entries` records one completion for every distinct explicit workout
  report. Multiple completions may be recorded in the same clock hour.
- `daily_runs` allows one run per local date. If Aaron reports finishing a run
  without a duration, record 30 minutes.
- Every mutation requires a stable inbound idempotency key, so a Gateway retry
  cannot double-count activity.
- Workout progress is projected to the bottom Health widget as
  `hourlyWorkouts.current` against target 8.
- A daily run marks the top `Workout/Run` goal complete. It is deliberately not
  shown in the bottom Health widget.

The native prompt scheduler sends at 9 AM through 4 PM America/New_York. An
unanswered prompt produces no chase message and no pending reply state. A bare
`yes` is not interpreted as a workout; Aaron uses an explicit report such as
“log a workout.”

Successful hourly and run mutations return `Got that logged.` Main delivers
that single response through the originating conversation.

### Proposed deterministic operations

- `resolve-staple` — find an exact/alias staple match without changing state.
- `add-staple` — append a new, fully specified staple; reject duplicates.
- `log-food` — validate and append one resolved food entry.
- `recent-food` — return recent active entries with stable IDs.
- `correct-food` — supersede a selected entry with corrected quantity or
  nutrition.
- `remove-food` — void a selected entry while preserving history.
- `undo` — reverse the latest reversible health mutation.
- `list-today` — list active food entries and cumulative totals.
- `get-entry` — answer calories/protein/source questions for a stable entry.

Every successful mutation recalculates the full active daily calories and
protein, persists them atomically, and then sends the complete totals to
`PATCH /api/health`. It must never send only the latest item's values.

### Proposed food entry fields

Each entry should have at least:

- Stable entry ID
- Local date and timestamp
- Original user wording
- Normalized food name
- Quantity and assumed serving
- Calories
- Protein grams
- Resolution type: `staple`, `official`, `usda`, `database`, or `estimate`
- Source name and URL when applicable
- Confidence
- Origin channel and conversation/session reference
- Active, voided, or superseded status
- Revision/undo relationship when applicable

The human-readable daily Markdown log may remain as a generated narrative, but
it should no longer be the only itemized source of truth.

## Home Assistant follow-up conversation

Home Assistant's Conversation API provides both a `conversation_id` and a
`continue_conversation` response flag. The Voice PE adapter should preserve the
same conversation ID and OpenClaw session while follow-up listening is active.

Desired health behavior:

1. Aaron says, "Hey Jarvis, I ate a chicken sandwich."
2. Jarvis says, "Got that logged."
3. Voice PE briefly listens again without another wake word.
4. Aaron can ask, "How many calories was that?"
5. The follow-up reaches the same conversation/session, so `that` resolves to
   the food entry just created.

The listening window belongs to the Home Assistant/Voice PE layer, not the
health workflow. The health workflow only supplies stable entry and
conversation references. The integration should fall back safely to requiring
`Hey Jarvis` again if the device or configured pipeline does not support
continued listening.

Official references:

- https://developers.home-assistant.io/docs/intent_conversation_api/
- https://developers.home-assistant.io/docs/voice/pipelines/

## Reliability requirements

- Use an idempotency key so a retried voice/Gateway request cannot double-log
  the same food.
- Serialize or lock daily mutations so rapid reports cannot overwrite totals.
- Store writes atomically.
- Recalculate totals from active ledger entries after add/correct/remove/undo.
- If the ledger write fails, do not say the food was logged.
- If the ledger succeeds but dashboard sync fails, preserve the entry and
  report the dashboard problem instead of duplicating the log on retry.
- Main sends one reply; the specialist and workflow never send messages.
- Keep Main as the only user-facing transport and dashboard-api as the single
  writer for shared dashboard state.

## Acceptance scenarios

- Saved staple uses exact stored calories and protein.
- Restaurant item uses a saved/cached structured value when available and an
  explicitly labeled Haiku estimate otherwise.
- Generic food uses USDA before another database.
- Vague portion is estimated without a clarification prompt.
- Successful log replies only `Got that logged.`
- Follow-up calorie/protein question returns the last entry's values.
- Two-item correction recalculates daily totals correctly.
- Eight-ounce correction supersedes the original estimate.
- Remove-last and undo preserve history and recalculate totals.
- `What have I eaten today?` excludes voided/superseded entries.
- A new staple becomes available to later food reports.
- Duplicate staple names are not overwritten.
- Echo totals match the active ledger after every mutation.
- A retried identical request creates only one entry.
- iMessage and Voice PE share the health backend without sharing the wrong
  channel reply destination.

## Retired transport

The former handler and raw iMessage watcher were retired after successful
native Gateway use. Historical copies live in
`archives/legacy-routing-2026-07-31/`; they are not production dependencies.
