# Weekly OpenClaw update check

## Architecture

`launchd` (`ai.openclaw.weekly-update`, label installed 2026-08-02) runs
`scripts/weekly-update.sh` every Sunday at 3:00 AM. The script never invokes
an LLM or agent — it's pure deterministic infrastructure, the same category
as `calendar-notification-workflow.js`.

## Behavior

1. Runs the real `openclaw update --yes --json` (not `--dry-run` — dry-run
   only previews the plan, it doesn't test whether an install would
   actually succeed). The tool's own staged-install-then-verify design is
   the actual safety net: a broken/corrupt fetch is never swapped into the
   live install, so a failed run leaves the previously-running version
   untouched.
2. On success, verifies the Gateway is actually listening on port 18789.
   Observed 2026-08-02: the Gateway's LaunchAgent didn't always come back up
   on its own after a real update and needed an explicit `gateway restart`
   — the script does that automatically if the port isn't listening after
   the update.
3. Logs every run to `~/Library/Logs/openclaw/weekly-update.log`. No
   proactive notification is sent — a failed or skipped update just means
   next Sunday's run tries again; check the log if you want to know what
   happened. `raw launchd stdout/stderr` (mostly redundant with the above)
   goes to `weekly-update-launchd.log`.

## Known limitation

This only protects against a *failed install*. It cannot detect a new
version that installs and passes `openclaw doctor` cleanly but has an actual
behavioral regression — no automated check can fully rule that out. If
something feels off after a Sunday-night update, check
`~/Library/Logs/openclaw/weekly-update.log` for the version it moved to.

## Manual run / verification

```bash
/bin/bash /Users/aaronmacmini/.openclaw/workspace-main/scripts/weekly-update.sh
tail -50 /Users/aaronmacmini/Library/Logs/openclaw/weekly-update.log
launchctl print gui/501/ai.openclaw.weekly-update
```

## Follow-up candidate

This is a plain system-level launchd job today, not owned by any agent. Once
`systems-qa`'s real job is designed, this is a natural candidate for it to
own/monitor (e.g. summarizing the weekly log, flagging repeated failures) —
see `workspace-systems-qa/SOUL.md`'s follow-up list.
