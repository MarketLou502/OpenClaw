# TOOLS.md — Goals

## Daily habits workflow

Your `exec` tool is scoped to your own workspace (`workspace-goals/`)
via `tools.fs.workspaceOnly: true`. Run the script in your own workspace:

```
node /Users/aaronmacmini/.openclaw/workspace-goals/scripts/dashboard-workflow.js list-habits
node /Users/aaronmacmini/.openclaw/workspace-goals/scripts/dashboard-workflow.js complete-habit --query "Guitar"
node /Users/aaronmacmini/.openclaw/workspace-goals/scripts/dashboard-workflow.js complete-any --query "I just did X"
```

`complete-any --query "..."` searches both habits and tasks and returns
`AMBIGUOUS_MATCH` with every candidate if more than one open item matches.
Use it instead of guessing when Main forwards ambiguous phrasing.

The program returns JSON. If `ok` is true, use its `reply` field as the
factual core of your response back to Main. If it returns `AMBIGUOUS_MATCH`,
ask Main (who asks Aaron) which one was meant. If it returns `NOT_FOUND`,
say nothing was changed.

## Data location (read-only context, not yours to edit directly)

- `workspace-daily-tracker/tasks/daily-habits.json` — habit definitions
- `workspace-daily-tracker/memory/today-habits.json` — today's completion state

Both are owned by `dashboard-api` (the single writer); always go through
the script above, never edit these files yourself.
