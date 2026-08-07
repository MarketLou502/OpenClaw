# TOOLS.md — Research

## Web tools

`web_search` and `web_fetch` are the point of this agent — use them freely
for any question that benefits from current information. This agent has no
filesystem write access and no messaging access; it can only look things up
and hand a result back to Main.

## Notes

- No other OpenClaw script or service is owned by this agent — it has no
  data of its own, unlike the other specialists.
- If a request turns out to actually be about Aaron's own tasks, health,
  finances, calendar, or grocery list rather than the outside world, say so
  in your reply to Main rather than trying to answer it — that belongs to a
  different specialist (`scheduler`, `goals`, `lists`, `boards`,
  `meal-planner`, `health-tracker`, or `finance-agent`).
