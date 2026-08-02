# Zaxby's Native iMessage Workflow

This workflow belongs to `main`; it is not a separate agent. The native Gateway
owns image intake and the reply to the originating conversation.

## Trigger

Trigger only when the **same current inbound message** contains an image and
the case-insensitive phrase `Zaxby survey`. Do not infer intent from a bare
photo, `receipt`, `survey` by itself, or an older image in history. A photo plus
`Zaxby survey` is Aaron's explicit instruction to OCR and, when the result is
high confidence, submit the survey.

Native iMessage attachment staging validates paths and size, converts HEIC to
JPEG when necessary, and exposes the staged current-turn image. Do not create a
second watcher or copy an attachment from an arbitrary path.

## OCR

Use the current inbound image with the `image` tool. Ask for a best candidate
and whether the **entire** result is `high` confidence or `uncertain`. The code
must be exactly 15 uppercase alphanumeric characters.

Include these thermal-receipt cautions:

- `Z` and `2` can look alike; when ambiguous it is more often `Z`.
- `T` and `1` can look alike; when ambiguous it is more often `T`.
- `O` and `0` can look alike; when ambiguous it is more often `0`.
- `I` and `1` can look alike; inspect the glyph carefully.

Do not call a result high confidence merely because it has 15 characters. If
any character is unclear, use `uncertain`. If no valid candidate exists, omit
`--code` and use `uncertain`.

## State and submission

Use only:
`/Users/aaronmacmini/.openclaw/workspace-main/scripts/zaxbys-workflow.js`

Use the originating conversation/session ID for `--conversation` and native
message GUID/request ID for `--request-id`. Reuse the same request ID on retry.

```bash
node /Users/aaronmacmini/.openclaw/workspace-main/scripts/zaxbys-workflow.js ingest --conversation "<origin>" --request-id "<message-guid>" --confidence high --code "2JZALBL6K2Z4GWF"
node /Users/aaronmacmini/.openclaw/workspace-main/scripts/zaxbys-workflow.js ingest --conversation "<origin>" --request-id "<message-guid>" --confidence uncertain --code "2JZALBL6K2Z4GWF"
node /Users/aaronmacmini/.openclaw/workspace-main/scripts/zaxbys-workflow.js ingest --conversation "<origin>" --request-id "<message-guid>" --confidence uncertain
node /Users/aaronmacmini/.openclaw/workspace-main/scripts/zaxbys-workflow.js respond --conversation "<origin>" --request-id "<reply-guid>" --response "yes"
node /Users/aaronmacmini/.openclaw/workspace-main/scripts/zaxbys-workflow.js status --conversation "<origin>"
```

- Valid `high` submits through the existing runner immediately.
- `uncertain` is stored for ten minutes. Return the program's `reply` asking
  Aaron to verify the candidate or send the corrected code.
- Exact `yes` verifies a readable pending candidate. An exact 15-character
  code corrects and verifies it. `no` or `cancel` cancels. Vague agreement does
  not submit.
- If no candidate was readable, `yes` is insufficient; require the exact code.
- Route an immediately following verification/correction reply through
  `respond` before normal routing. If unclear, call `status` rather than guess.
- Use the returned JSON `reply`; surface failures honestly. Do not invoke
  `zaxbys-survey.sh` directly because the workflow owns idempotency and
  crash-safe duplicate prevention.
- Reply exactly once through the originating native channel. Do not use raw
  `imsg` or the message tool.

The browser implementation remains at
`/Users/aaronmacmini/.openclaw/workspace-main/scripts/zaxbys-survey/run-survey.js`
and sends coupons to `aaron143574@icloud.com`. Only the deterministic workflow
may invoke it.
