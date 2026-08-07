#!/usr/bin/env python3
"""Pre-commit safety net: block commits containing raw secrets or known PII.

Scans the *staged* content of every file about to be committed (not the
working tree) for API-key-shaped strings, and separately checks for the
live iMessage phone numbers from openclaw.json leaking into any staged
file verbatim. This is a backstop, not the primary control - the primary
control is that openclaw.json stays gitignored and secrets flow through
${VAR} env-var refs (see scripts/sanitize-openclaw-config.py).

Keep these patterns in sync with SECRET_VALUE_PATTERNS in
sanitize-openclaw-config.py.
"""
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

SECRET_LINE_PATTERNS = [
    re.compile(r"sk-(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9_-]{12,}"),
    re.compile(r"AIza[A-Za-z0-9_-]{20,}"),
    re.compile(r"xox[baprs]-[A-Za-z0-9-]+"),
    re.compile(r"ghp_[A-Za-z0-9]{20,}"),
    re.compile(r"[0-9]{9,}:[A-Za-z0-9_-]{30,}"),
]


def live_pii_values():
    live = ROOT / "openclaw.json"
    if not live.exists():
        return []
    try:
        cfg = json.loads(live.read_text())
    except Exception:
        return []
    imsg = cfg.get("channels", {}).get("imessage", {})
    values = list(imsg.get("allowFrom", [])) + list(imsg.get("groupAllowFrom", []))
    return [v for v in values if isinstance(v, str) and len(v) >= 7]


def staged_files():
    out = subprocess.run(
        ["git", "diff", "--cached", "--name-only", "--diff-filter=ACM"],
        cwd=ROOT, capture_output=True, text=True, check=True,
    ).stdout
    return [line for line in out.splitlines() if line.strip()]


def staged_content(path):
    result = subprocess.run(
        ["git", "show", f":{path}"], cwd=ROOT, capture_output=True, check=True,
    )
    try:
        return result.stdout.decode("utf-8")
    except UnicodeDecodeError:
        return None  # binary file, skip


def main():
    pii_values = live_pii_values()
    problems = []

    for path in staged_files():
        content = staged_content(path)
        if content is None:
            continue
        for lineno, line in enumerate(content.splitlines(), start=1):
            for pattern in SECRET_LINE_PATTERNS:
                if pattern.search(line):
                    problems.append(f"{path}:{lineno}: looks like a live secret ({pattern.pattern})")
            for pii in pii_values:
                if pii in line:
                    problems.append(f"{path}:{lineno}: contains a live iMessage phone number")

    if problems:
        print("COMMIT BLOCKED: possible secret or personal data in staged changes:\n", file=sys.stderr)
        for p in problems:
            print(f"  - {p}", file=sys.stderr)
        print(
            "\nIf this is a false positive, fix the underlying regex in "
            "scripts/check-staged-for-secrets.py rather than bypassing with --no-verify.",
            file=sys.stderr,
        )
        sys.exit(1)


if __name__ == "__main__":
    main()
