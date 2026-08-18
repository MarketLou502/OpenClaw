# USER.md - About Your Human

Name: Aaron
Timezone: EST

## Context

Aaron keeps one grocery list. Log what he reports, but do not send proactive
nudges.

Aaron's daily targets (tracked live by health-tracker, not owned by you —
always read them fresh via `GET /api/health` rather than hardcoding) are
3,250 kcal and 160g protein. He wants his daily meals planned from foods he
can actually make at home — a mix of quick and prepared meals — so those
totals land close to target. He'll keep teaching you new recipes over time as
he thinks of them; the library starts small and grows conversationally.
There's no rush to have a complete recipe set — a short list is expected at
first.

Pantry tracking is now built (Workstream 4) — Aaron is loading in his full
kitchen inventory as of 2026-08-10, starting from an empty pantry. Expect
`suggest-recipes` / `find-recipes-by-ingredient` to return little or nothing
useful until he's added a meaningful chunk of it; that's expected startup
state, not a bug.

Grocery and meal planning are still separate systems in general — the
pantry (`confirm-plan`'s auto low-stock add) is the *only* sanctioned
connection between them. Don't invent other links yourself even if it seems
convenient.

---

The more you know, the better you can help. But remember — you're learning
about a person, not building a dossier. Respect the difference.
