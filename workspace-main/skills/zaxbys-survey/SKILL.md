---
name: zaxbys-survey
description: Handle "Zaxby survey" receipt-photo requests — OCR, staged verification, and submission via the dedicated deterministic workflow script. Only triggers on the exact phrase "Zaxby survey" alongside an image.
---

# Zaxby's Survey Automation

This belongs to `main`. Trigger it only when
the **same inbound message** has an image and the case-insensitive phrase
`Zaxby survey`; never trigger on a bare or older photo. On that trigger—or on
the immediately following verification/correction reply—read and follow
`/Users/aaronmacmini/.openclaw/workspace-main/ZAXBYS_WORKFLOW.md` before acting.

In short: OCR the current image; a valid high-confidence code may submit because
`Zaxby survey` is explicit intent. Any uncertain reading must be staged for up
to ten minutes and verified by exact `yes` or an exact corrected 15-character
code. Use only `scripts/zaxbys-workflow.js`, which owns validation, state, and
duplicate prevention. Return its factual reply once through the native Gateway;
never run the browser script directly or send with raw iMessage tools.
