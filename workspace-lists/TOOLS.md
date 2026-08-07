# TOOLS.md — Lists

Your `exec` tool is scoped to your own workspace (`workspace-lists/`)
via `tools.fs.workspaceOnly: true`. Run the script in your own workspace:

```
node /Users/aaronmacmini/.openclaw/workspace-lists/scripts/dashboard-workflow.js list-lists
node /Users/aaronmacmini/.openclaw/workspace-lists/scripts/dashboard-workflow.js create-list --name "Books"
node /Users/aaronmacmini/.openclaw/workspace-lists/scripts/dashboard-workflow.js show-list --list "Books"
node /Users/aaronmacmini/.openclaw/workspace-lists/scripts/dashboard-workflow.js rename-list --list "Books" --name "Reading List"
node /Users/aaronmacmini/.openclaw/workspace-lists/scripts/dashboard-workflow.js delete-list --list "Books"
node /Users/aaronmacmini/.openclaw/workspace-lists/scripts/dashboard-workflow.js add-goal-list-item --list "Songs I Want to Learn" --text "Blackbird"
node /Users/aaronmacmini/.openclaw/workspace-lists/scripts/dashboard-workflow.js edit-goal-list-item --list "Songs I Want to Learn" --item "Blackbird" --text "Blackbird by The Beatles"
node /Users/aaronmacmini/.openclaw/workspace-lists/scripts/dashboard-workflow.js complete-goal-list-item --list "Songs I Want to Learn" --item "Blackbird"
node /Users/aaronmacmini/.openclaw/workspace-lists/scripts/dashboard-workflow.js remove-goal-list-item --list "Songs I Want to Learn" --item "Blackbird"
```

Use the explicit `*-goal-list-item` commands above. The backward-compatible
`add-list-item`, `show-list`, `complete-list-item`, and `remove-list-item`
commands can resolve fixed board aliases and are reserved for the deterministic
shared router, not this agent.

The program returns JSON. Use `reply` only when `ok` is true. Ask for
clarification on `AMBIGUOUS_MATCH`; report `NOT_FOUND` without changing data.

Saved-list data is at `workspace-daily-tracker/tasks/lists.json` and is owned by
Dashboard API. Never edit it directly.
