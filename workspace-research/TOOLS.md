# TOOLS.md — Research

## Web tools

`web_search` and `web_fetch` are the point of this agent — use them freely
for any question that benefits from current information. This agent has no
filesystem write access and no messaging access; it can only look things up
and hand a result back to Main.

## TikTok links — `exec` via `tiktok_transcribe.py`

When Main forwards a message containing a TikTok URL (`tiktok.com/...` or a
`vm.tiktok.com` / `vt.tiktok.com` short link), run:

```bash
/Users/aaronmacmini/.openclaw/services/whisper-mlx/venv/bin/python3 \
  /Users/aaronmacmini/.openclaw/workspace-research/scripts/tiktok_transcribe.py \
  "<the tiktok url>"
```

This is the one `exec` use case this agent has. The script auto-detects
which kind of post the URL is — you never need to guess or branch on this
yourself:

**Video posts:** downloads audio with `yt-dlp` (`--impersonate chrome` —
needed or some posts fail with a bot-detection error; `-f
download/bestaudio/best` — needed because yt-dlp's auto-picked "best" format
sometimes lands on an audio-stripped CDN mirror), transcribes it against the
local `whisper-mlx` Wyoming server (127.0.0.1:10300 — the same STT engine
the kitchen voice assistant uses), and prints:

```json
{"post_type": "video", "url", "title", "uploader", "caption",
 "duration_seconds", "transcript"}
```

**Photo/slideshow posts** (an image carousel, no video stream — `yt-dlp` has
no extractor for these at all): the script falls back automatically to a
headless-browser fetch (Playwright + Chromium) that loads the real page,
saves each carousel image to disk, and transcribes the background-audio
track if there is one. Prints:

```json
{"post_type": "photo", "url", "title", "uploader", "caption",
 "image_paths": [...], "transcript": "" or spoken/lyric audio if present}
```

For a photo post, use the `read` tool on each path in `image_paths` (same
field name as always — `path`) before writing your summary. The images are
often the entire content — tool names, links, or steps shown as on-screen
text/graphics that never appear in the caption or any audio track. Don't
summarize a photo post from the caption alone; look at the images.
`image_paths` all point into `workspace-research/tmp/latest-photo-post/`,
which the script overwrites in place on every call — read them in the same
turn you get them, don't expect them to still be there later. **Unverified
as of 2026-08-16:** this agent's `image` tool is denied in config — that's
believed to be a separate thing from the generic `read` tool's ability to
show you an image file's contents (untested), but if `read` on one of these
paths errors or comes back as unusable, say that plainly rather than
summarizing from the caption alone as if you'd actually seen the slides.

Either way: `{"error": "..."}` on failure (bad URL, video over the 10-minute
cap, `yt-dlp`/whisper/browser unreachable). On error, say plainly what
failed — don't retry silently and don't fabricate a summary from the caption
alone.

On success, do not just relay the raw JSON. Turn `caption` + `transcript` +
(for photo posts) what the images actually show into a short summary aimed
at "what would I actually build from this" — what the post is about, and if
it's presenting a technique, tool, workflow, or product, name it plainly and
pull out the concrete steps/settings/links shown. This agent does not
implement anything from it — the summary is so Aaron can come back later and
decide what to build. See `SOUL.md` for the full behavior contract.

Then log it — this agent's `write`/`file_write`/`edit` tools are denied, so
persist it via `exec` instead:

```bash
echo '{"url": "<url>", "title": "<title>", "uploader": "<uploader>", "summary": "<your summary>"}' \
  | /Users/aaronmacmini/.openclaw/services/whisper-mlx/venv/bin/python3 \
    /Users/aaronmacmini/.openclaw/workspace-research/scripts/log_tiktok_summary.py
```

This appends to `memory/YYYY-MM-DD.md` (any python3 works here — this script
doesn't touch `wyoming`, the venv path is just used for consistency). Do
this even though most lookups this agent handles are one-off and don't get
logged — see `AGENTS.md`'s Memory and safety section for why TikToks are the
exception.

## Notes

- Other than the two TikTok scripts above, no other OpenClaw script or
  service is owned by this agent — it has no other data of its own, unlike
  the other specialists.
- If a request turns out to actually be about Aaron's own tasks, health,
  finances, calendar, or grocery list rather than the outside world, say so
  in your reply to Main rather than trying to answer it — that belongs to a
  different specialist (`scheduler`, `goals`, `lists`, `boards`,
  `meal-planner`, `health-tracker`, or `finance-agent`).
