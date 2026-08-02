#!/usr/bin/env python3
"""Regenerate the git-committed sanitized snapshot of openclaw.json.

The real openclaw.json is gitignored because it contains a live gateway
token. This script copies it, redacts known/likely secret values, and
writes the result to "AI handoff files/openclaw.sanitized.json" so a DR
restore always has an accurate, current template to work from.

Run this manually after any meaningful change to openclaw.json, before
pushing to git.
"""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LIVE = ROOT / "openclaw.json"
OUT = ROOT / "AI handoff files" / "openclaw.sanitized.json"

REDACTED = "<REDACTED: generate a new value, see AI handoff files/RESTORE.md>"

# Value shapes that indicate a live secret rather than an env-var
# reference (${FOO}) or a benign local placeholder like "ollama-local".
SECRET_VALUE_PATTERNS = [
    re.compile(r"^sk-[A-Za-z0-9_-]{10,}$"),
    re.compile(r"^AIza[A-Za-z0-9_-]{20,}$"),
    re.compile(r"^xox[baprs]-[A-Za-z0-9-]+$"),
    re.compile(r"^ghp_[A-Za-z0-9]{20,}$"),
    re.compile(r"^[0-9]{9,}:[A-Za-z0-9_-]{30,}$"),
]

# Known field paths (dot/bracket notation) that hold live secrets today.
KNOWN_SECRET_PATHS = {"gateway.auth.token"}


def redact(node, path=""):
    if isinstance(node, dict):
        return {k: redact(v, f"{path}.{k}" if path else k) for k, v in node.items()}
    if isinstance(node, list):
        return [redact(v, f"{path}[]") for v in node]
    if isinstance(node, str):
        if path in KNOWN_SECRET_PATHS:
            return REDACTED
        if node.startswith("${") and node.endswith("}"):
            return node  # env-var reference, safe to keep as-is
        if any(p.match(node) for p in SECRET_VALUE_PATTERNS):
            print(f"WARNING: value at {path} looks like a live secret, redacting")
            return REDACTED
    return node


def main():
    config = json.loads(LIVE.read_text())
    sanitized = redact(config)
    OUT.write_text(json.dumps(sanitized, indent=2) + "\n")
    print(f"Wrote {OUT}")


if __name__ == "__main__":
    main()
