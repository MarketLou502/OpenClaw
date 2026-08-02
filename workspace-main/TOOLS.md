# TOOLS.md - Machine & Environment

This is a sandbox Mac mini. Aaron has granted full system control.

## File System

- Full read/write access across the entire file system
- Preferred: use `trash` over `rm` — recoverable beats gone forever
- OpenClaw config lives at: `~/.openclaw/`
- Agent workspaces:
  - Main (me): `~/.openclaw/workspace-main/`
  - daily-tracker: `~/.openclaw/workspace-daily-tracker/`
  - health-tracker: `~/.openclaw/workspace-health-tracker/`
  - sports-betting: `~/.openclaw/workspace-sports-betting/`
- Retained Finance services/data (not an active agent):
  `~/.openclaw/workspace-finance-agent/`
- I have direct read/write access to any of these. When Aaron asks me to give
  another agent a new feature or change its behavior (e.g. "add a new daily
  habit," "have health-tracker do X"), I edit that agent's files myself
  (SOUL.md, HEARTBEAT.md, task lists, etc.) rather than relaying the request.
  Day-to-day *data* entries that agent owns (logging a meal, marking a habit
  done) still go through that agent — it knows its own format and is the
  source of truth for its own logs.

## iMessage (texting Aaron)

Aaron texts with me as his day-to-day secretary. Native Gateway replies and
approved deterministic notifications share his saved iMessage conversation.

### Transport rules

- **When the current turn arrived through OpenClaw's native `imessage`
  channel:** return the reply as normal assistant text. The Gateway owns
  delivery to the originating iMessage conversation. Do **not** call
  raw `imsg send`, or the `message` tool for the same reply.
  No textual agent prefix is required in this single-main-agent conversation;
  the iMessage contact/thread supplies the identity.
- **For proactive messages:** only the deterministic calendar-notification and
  hourly-workout workflows are approved. Both call OpenClaw's native iMessage
  action through `scripts/lib/native-imessage.js`. Do not use raw `imsg send`,
  Discord, or an agent heartbeat for proactive delivery.
- Read the existing thread history if useful: `imsg history --chat-id 1 --limit 10 --json`

## Calendar

Use the deterministic workflow below for calendar reads and changes. It talks
directly to the Google Calendar API and is fixed to `aaron@marketlou.com`, the
same calendar the Echo dashboard reads. Do not use Calendar.app, AppleScript,
for native iMessage calendar requests.

Script:
`/Users/aaronmacmini/.openclaw/workspace-main/scripts/calendar-workflow.js`

```bash
node /Users/aaronmacmini/.openclaw/workspace-main/scripts/calendar-workflow.js list --date 2026-08-01
node /Users/aaronmacmini/.openclaw/workspace-main/scripts/calendar-workflow.js add --title "Dentist" --date 2026-08-01 --time 14:00 --duration 60
node /Users/aaronmacmini/.openclaw/workspace-main/scripts/calendar-workflow.js delete --title "Dentist" --date 2026-08-01
node /Users/aaronmacmini/.openclaw/workspace-main/scripts/calendar-workflow.js reschedule --title "Dentist" --date 2026-08-01 --new-date 2026-08-02 --new-time 15:30
```

For any add, delete, or reschedule, resolve and restate the exact title, date,
time, duration, and timezone (`America/New_York`) before making the change when
Aaron's request leaves any of those details ambiguous. Never invent missing
dates or times. The workflow rejects ambiguous same-title matches and updates
one stable Google event ID when rescheduling; do not fall back to deleting all
events by title. Use the returned `reply` as the factual core of the response,
and surface errors honestly.

## Dashboard task, grocery, daily-habit, and custom-list workflow

For task boards, groceries, daily habit status, and Aaron's custom lists, use
the deterministic workflow below. It talks to `dashboard-api`, which is the
single writer for the same state shown by the Echo dashboard. Do not edit the
backing JSON files directly.

Script:
`/Users/aaronmacmini/.openclaw/workspace-main/scripts/dashboard-workflow.js`

### Four different things are all called "a list" — know which one Aaron means

This has caused real confusion before (a request to add a song to "Songs I
Want to Learn" wasn't handled correctly), so check this before picking a
command:

1. **Task boards** — fixed set: Work, Personal, Market Lou. Actual to-dos/
   errands. Aaron calls these "boards", not "lists" — e.g. "add X to my
   Market Lou board", or just "add X to Market Lou" with no trailing word at
   all. Hearing one of these three exact names is enough on its own; it's
   always this tool, regardless of whether "board" follows it or nothing
   does. Commands: `list`/`add`/`complete`/`remove` with `--board`.
2. **Grocery list** — one fixed list, groceries only. Same commands with
   `--board grocery`.
3. **Daily habits** — a fixed, small set that resets every day (Guitar, Golf,
   Spanish, etc.). Commands: `list-habits`/`complete-habit`, or
   `complete-any` when the phrasing doesn't say which of habit/task Aaron
   means (see below).
4. **Custom lists** (the "library")— open-ended, Aaron creates these himself
   for anything that isn't a to-do, a grocery item, or a daily habit — "Songs
   I Want to Learn," "Books," etc. Commands: `list-lists`, `show-list`,
   `create-list`, `rename-list`, `delete-list`, `add-list-item`,
   `edit-list-item`, `complete-list-item`, `remove-list-item` — all take
   `--list "name"` to identify which one.

**Decision rule:** if Aaron names a list that isn't Work/Personal/Market
Lou/grocery/a habit, it's almost certainly a custom list (#4), not a
nonexistent task board. Run `list-lists` and match against it before
assuming anything — don't guess it doesn't exist, and don't silently fold it
into a task board just because the word "list" was in the sentence. Only use
`create-list` if it genuinely doesn't exist yet and Aaron's phrasing sounds
like he wants to start one, not as a fallback when a name doesn't match.

Commands:

```bash
node /Users/aaronmacmini/.openclaw/workspace-main/scripts/dashboard-workflow.js list --board work
node /Users/aaronmacmini/.openclaw/workspace-main/scripts/dashboard-workflow.js list --board market-lou
node /Users/aaronmacmini/.openclaw/workspace-main/scripts/dashboard-workflow.js list --board personal
node /Users/aaronmacmini/.openclaw/workspace-main/scripts/dashboard-workflow.js list --board grocery
node /Users/aaronmacmini/.openclaw/workspace-main/scripts/dashboard-workflow.js list --board all
node /Users/aaronmacmini/.openclaw/workspace-main/scripts/dashboard-workflow.js add --board personal --text "Call dentist"
node /Users/aaronmacmini/.openclaw/workspace-main/scripts/dashboard-workflow.js complete --query "dentist"
node /Users/aaronmacmini/.openclaw/workspace-main/scripts/dashboard-workflow.js complete --board grocery --query "milk"
node /Users/aaronmacmini/.openclaw/workspace-main/scripts/dashboard-workflow.js remove --board personal --query "duplicate item"
node /Users/aaronmacmini/.openclaw/workspace-main/scripts/dashboard-workflow.js list-habits
node /Users/aaronmacmini/.openclaw/workspace-main/scripts/dashboard-workflow.js complete-habit --query "Guitar"
node /Users/aaronmacmini/.openclaw/workspace-main/scripts/dashboard-workflow.js list-lists
node /Users/aaronmacmini/.openclaw/workspace-main/scripts/dashboard-workflow.js show-list --list "Songs I Want to Learn"
node /Users/aaronmacmini/.openclaw/workspace-main/scripts/dashboard-workflow.js create-list --name "Books"
node /Users/aaronmacmini/.openclaw/workspace-main/scripts/dashboard-workflow.js rename-list --list "Books" --name "Reading List"
node /Users/aaronmacmini/.openclaw/workspace-main/scripts/dashboard-workflow.js add-list-item --list "Songs I Want to Learn" --text "Blackbird"
node /Users/aaronmacmini/.openclaw/workspace-main/scripts/dashboard-workflow.js edit-list-item --list "Songs I Want to Learn" --item "Blackbird" --text "Blackbird by The Beatles"
node /Users/aaronmacmini/.openclaw/workspace-main/scripts/dashboard-workflow.js complete-list-item --list "Songs I Want to Learn" --item "Blackbird"
node /Users/aaronmacmini/.openclaw/workspace-main/scripts/dashboard-workflow.js remove-list-item --list "Songs I Want to Learn" --item "Blackbird"
```

The program returns JSON. If `ok` is true, use its `reply` field as the factual
core of the response. If it returns `AMBIGUOUS_MATCH`, ask Aaron which returned
item he meant; never choose one. If it returns `NOT_FOUND`, say nothing was
changed. Surface backend errors honestly. An unspecified normal task board
defaults to Personal, but never infer that a grocery request belongs on
Personal. New *task boards* (Work/Personal/Market Lou are the only three) are
not supported and must not be created as hidden files — but custom lists
(#4 above) are exactly the supported way to create an arbitrary named list,
via `create-list`. `remove` (any board, including grocery, and
`remove-list-item` for custom lists) permanently deletes the item — fine for
"take X off my grocery list" or cleaning up mistaken duplicates, just don't
use it interchangeably with `complete`/`complete-list-item` for routine
done-marking.

### Habit vs. task completion — use complete-any, don't judge it yourself

"I just did X" / "I did X today" / "done with X" can mean either a daily
habit or a task — they're tracked separately, and the same or a similar name
can exist in both places at once (this has actually happened: a "Golf" task
and a "Golf" habit coexisted, and the wrong one kept getting marked done
while the real habit silently stayed unfinished).

Use `complete-any --query "..."` for this phrasing instead of manually
checking `list-habits` plus a task board yourself — it searches habits and
tasks together and resolves the same way `AMBIGUOUS_MATCH` already works:
exact-name matches win outright, and if more than one *open* item still
matches, it returns `AMBIGUOUS_MATCH` with every candidate rather than
guessing. Use its `reply` field directly; if it comes back `AMBIGUOUS_MATCH`,
ask Aaron which one he meant instead of picking one.

The workflow never sends a message itself. The native iMessage Gateway remains
the sole reply transport for an inbound iMessage turn.

## Health logging delegation

For any food, drink, calorie, protein, hourly workout, exercise, or run request,
read and follow
`/Users/aaronmacmini/.openclaw/workspace-main/HEALTH_ROUTING.md`. Health work is
delegated to the allowlisted `health-tracker`; Main owns the conversation and
the only user-facing reply.

## Notes

- Sandbox device — Aaron wants this machine used fully and boldly for agent work
- No SSH hosts configured yet — update this file as infrastructure grows
- External services include OpenRouter, Google Calendar, native iMessage, and
  the intentionally retained Sports Betting Discord account.
