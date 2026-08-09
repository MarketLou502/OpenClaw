# MEMORY.md - Long-Term Memory

Memory rule: keep this file under 150 lines. Detailed daily logs go in `memory/YYYY-MM-DD.md`.

---

## Proactive notifications

- Health Tracker sends no proactive messages and has no model heartbeat.
- Main sends eight deterministic native-iMessage workout prompts, hourly from
  9:00 AM through 4:00 PM.
- No calorie, protein, missed-run, or end-of-day health nudges are wanted.

## Daily Targets

- **Calories:** 3,250 kcal
- **Protein:** 160g
- **Cardio:** 1 run per day (~30 min). Non-negotiable.
- **Strength:** Hourly micro-workout tracking, with a daily dashboard target of
  5 completed prompts out of 8 opportunities.

---

## Dashboard sync (dashboard-api)

Health data feeds three surfaces that must agree: the deterministic health
ledger, the Echo Show wall dashboard, and the originating conversation. Native
iMessage reaches `main`, which delegates health work here through an allowlisted
internal OpenClaw subagent turn. Main owns all user-facing delivery through the
native Gateway route.

- Token: `cat /Users/aaronmacmini/.openclaw/service-env/dashboard-api.token`
- Base URL: `http://127.0.0.1:18795`
- The deterministic food workflow is the only food writer and sends full
  cumulative calorie/protein totals to `dashboard-api`. Do not append a food
  to Markdown or PATCH `/api/health` separately after running it.
- If the call fails (backend unreachable, non-2xx), don't block on it — log
  normally and just mention in your reply that the dashboard might be a beat
  behind. Never let a failed API call stop you from replying to Aaron.

## Calorie Logging Protocol

When Aaron reports food eaten, follow the complete deterministic protocol in
`TOOLS.md`:

1. Exact personal staple.
2. Local USDA Foundation/FNDDS/SR Legacy SQLite match and portion.
3. Claude Haiku serving-aware estimate when local data does not apply.
4. One `health-workflow.js log-food` mutation with a stable idempotency key.

The initial version intentionally has no live web-search provider. Haiku does
not claim it checked a current vendor website. Normal successful confirmation
is only `Got that logged.` Nutrition values and totals are returned when Aaron
asks for them.

---

## Workout Logging Protocol

When Aaron reports a workout through an internal delegation from main (for
example, "ran 3 miles," "hit the gym," or "did 50 pushups"):
1. Estimate minutes spent (cardio) the same way you estimate calories —
   reasonable assumption, state it if it's a guess (e.g. "assuming ~30 min
   for a 3-mile run"). Don't overthink strength-only sessions that don't map
   cleanly to minutes — a sane estimate is enough.
2. Log it to `memory/YYYY-MM-DD.md`, same as food.
3. Push today's updated cumulative cardio minutes:
   ```
   exec: curl -s -X PATCH \
     -H "Authorization: Bearer $(cat /Users/aaronmacmini/.openclaw/service-env/dashboard-api.token)" \
     -H "Content-Type: application/json" \
     -d '{"workout":{"current":<today's total cardio minutes>}}' \
     http://127.0.0.1:18795/api/health
   ```
4. Reply to Aaron confirming what got logged — normal conversational tone,
   not a receipt.

---

## Saved Nutritional Staples

### Custom Tuna Salad
- Batch: 2 cans tuna + 3 eggs + 1/4 cup mayo ≈ 450g total
- **Standard serving: 75g scoop**
- The Sandwich (75g scoop + 2 slices white bread): **315 kcal | 19g protein**

### Custom Frozen Burrito
- 278g total. Equal parts Spanish rice, chicken, guacamole, cheese.
- Estimate per burrito: ~520 kcal | ~28g protein

### Boost Protein Shake
- **530 kcal | 22g protein**

### Kirkland Breakfast Sandwich
- **510 kcal | 17g protein**

### Daily Coffee
- Splash of cream + splash of milk + 1 tbsp sugar
- **~50 kcal | 1g protein**

---
