#!/usr/bin/env python3
"""Append a TikTok summary to today's memory/YYYY-MM-DD.md.

Exists because this agent's `write`/`file_write`/`edit` tools are denied
(see TOOLS.md) but `exec` is not — this is the one sanctioned way it can
persist something to disk. Reads a single JSON object from stdin:

    {"url", "title", "uploader", "summary"}

Usage:
    echo '{"url": "...", "title": "...", "uploader": "...", "summary": "..."}' \
      | python3 log_tiktok_summary.py
"""
import json
import sys
from datetime import date
from pathlib import Path

MEMORY_DIR = Path("/Users/aaronmacmini/.openclaw/workspace-research/memory")


def main() -> None:
    entry = json.load(sys.stdin)
    url = entry.get("url", "")
    title = entry.get("title", "")
    uploader = entry.get("uploader", "")
    summary = entry.get("summary", "")

    if not url or not summary:
        print(json.dumps({"error": "url and summary are required"}))
        sys.exit(1)

    MEMORY_DIR.mkdir(parents=True, exist_ok=True)
    log_path = MEMORY_DIR / f"{date.today().isoformat()}.md"

    is_new = not log_path.exists()
    with log_path.open("a") as f:
        if is_new:
            f.write(f"# {date.today().isoformat()}\n\n")
        f.write(f"## TikTok — {title or url}\n")
        f.write(f"- URL: {url}\n")
        if uploader:
            f.write(f"- Uploader: @{uploader}\n")
        f.write(f"- Summary: {summary}\n\n")

    print(json.dumps({"logged": str(log_path)}))


if __name__ == "__main__":
    main()
