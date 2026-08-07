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

These two systems are intentionally disconnected. Do not record or act on
anything that would link them.

---
