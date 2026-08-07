# TOOLS.md — Boards

Your `exec` tool is scoped to your own workspace (`workspace-boards/`)
via `tools.fs.workspaceOnly: true`. Run the script in your own workspace:

```
node /Users/aaronmacmini/.openclaw/workspace-boards/scripts/dashboard-workflow.js list --board work
node /Users/aaronmacmini/.openclaw/workspace-boards/scripts/dashboard-workflow.js add --board personal --text "Call dentist"
node /Users/aaronmacmini/.openclaw/workspace-boards/scripts/dashboard-workflow.js complete --board work --query "report"
node /Users/aaronmacmini/.openclaw/workspace-boards/scripts/dashboard-workflow.js remove --board market-lou --query "old task"
node /Users/aaronmacmini/.openclaw/workspace-boards/scripts/dashboard-workflow.js schedule --board personal --query "dentist" --date 2026-08-04 --time 14:00
node /Users/aaronmacmini/.openclaw/workspace-boards/scripts/dashboard-workflow.js reschedule --board personal --query "dentist" --date 2026-08-05 --time 15:30
node /Users/aaronmacmini/.openclaw/workspace-boards/scripts/dashboard-workflow.js unschedule --board personal --query "dentist"
```

Only `work`, `personal`, and `market-lou` are in scope. Time must be on a
30-minute boundary. The workflow returns JSON; use `reply` when `ok` is true.
Return `AMBIGUOUS_MATCH`, `NOT_FOUND`, stale-version, and backend failures
honestly instead of claiming success.

Data is owned by Dashboard API. Do not edit these files:

- `workspace-daily-tracker/tasks/work.json`
- `workspace-daily-tracker/tasks/personal.json`
- `workspace-daily-tracker/tasks/market-lou.json`
