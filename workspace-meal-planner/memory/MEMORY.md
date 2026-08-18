# MEMORY.md - Long-Term Memory

Memory rule: keep this file under 150 lines. Detailed daily logs go in
`memory/YYYY-MM-DD.md`.

---

## Proactive notifications

- Meal Planner sends no proactive messages and has no model heartbeat.
- No "here's today's plan" morning nudges are wanted.

## Daily Targets (owned by health-tracker, not here — read live via GET /api/health)

- **Calories:** 3,250 kcal
- **Protein:** 160g

## Recipe library

The actual recipe data (names, macros, ingredients, tags) lives in
`workspace-meal-planner/data/meal-planner.sqlite`, managed exclusively
through `meal-planner-workflow.js` — not in this file. Use `list-recipes` to
see what's currently taught.

Seeded 2026-08-02 with health-tracker's 5 existing staples as a starting
library (same macros as health-tracker's own saved staples, so a food logged
against one should match a planned meal of the same name): Custom Tuna Salad
Sandwich (315 kcal/19g, lunch), Custom Frozen Burrito (520 kcal/28g, dinner),
Boost Protein Shake (530 kcal/22g, breakfast), Kirkland Breakfast Sandwich
(510 kcal/17g, breakfast), Daily Coffee (50 kcal/1g, breakfast). This is a
deliberately small starting set — expect Aaron to keep teaching more meals
(especially lunch/dinner/snack variety) over time.

This section is for *soft* facts about Aaron's food preferences that don't
fit the structured schema — dislikes, patterns, context behind a recipe, etc.
Nothing recorded yet.

## Grocery / meal-plan separation

Grocery and meal planning are separate systems, with one sanctioned
exception: the pantry bridge (Workstream 4) — `confirm-plan` can auto-add
low-stock items to the grocery board. Don't invent any other link.

## Pantry (Workstream 4)

Live as of 2026-08-09. Tracks `pantry_stock` in meal-planner.sqlite;
`confirm-plan` deducts ingredients on plan confirmation and auto-adds
below-threshold items to the grocery board. Aaron is loading his full
kitchen inventory starting 2026-08-10 — pantry starts empty, so
`suggest-recipes` will return little until stock is populated.

## Food log & preferences (Workstreams 2–3)

Live as of 2026-08-09. `health-workflow.js` mirrors every food entry Aaron
logs with health-tracker into this workspace's `food_log` table
(meal-planner.sqlite) — meal planner never writes it directly, only reads it
via `get-food-log` / `get-food-stats` / `analyze-preferences`. As of
2026-08-09 the log has 0 entries, so preference analysis returns
zeroed/empty output; expected while history builds up.

## Dashboard messages (Workstream 5)

Live as of 2026-08-09. `list-messages` / `post-message` / `update-message`
manage a kiosk message area (`agent_messages` table, `/api/meal-planner/messages`
on dashboard-api). `generate-messages` synthesizes a suggested nudge but has
no scheduler (heartbeat off, no cron) — only call it on explicit delegation
from Main, never on your own initiative.

---
