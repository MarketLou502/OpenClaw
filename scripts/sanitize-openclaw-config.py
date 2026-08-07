#!/usr/bin/env python3
"""Regenerate the git-committed sanitized snapshot of openclaw.json.

The real openclaw.json is gitignored because it contains personal data
(iMessage phone allow-lists) that has no config-level env-var equivalent.
This script copies it, redacts known/likely secret and PII values, and
writes the result to "AI handoff files/openclaw.sanitized.json" so a DR
restore always has an accurate, current template to work from.

Run automatically by the pre-commit hook (see .git/hooks/pre-commit) -
no need to run this by hand before pushing.
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
    re.compile(r"^sk-(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9_-]{12,}$"),
    re.compile(r"^AIza[A-Za-z0-9_-]{20,}$"),
    re.compile(r"^xox[baprs]-[A-Za-z0-9-]+$"),
    re.compile(r"^ghp_[A-Za-z0-9]{20,}$"),
    re.compile(r"^[0-9]{9,}:[A-Za-z0-9_-]{30,}$"),
]

# Value shapes that indicate personal data (not a "secret" the app resolves
# from an env var, but still not safe to publish) - e.g. phone numbers in
# iMessage allow-lists. Redacted the same way as secrets.
PII_VALUE_PATTERNS = [
    re.compile(r"^\+?[0-9][0-9\-\s]{6,14}[0-9]$"),  # phone numbers (E.164-ish)
]

REDACTED_PII = "<REDACTED: personal data, see AI handoff files/RESTORE.md>"

# Known field paths (dot/bracket notation) that hold live secrets today.
# (Empty for now - gateway.auth.token was converted to a ${VAR} env-var ref,
# so it's already caught by the generic env-ref passthrough below. Keep this
# set around as a place to pin any future field that can't use ${VAR}.)
KNOWN_SECRET_PATHS = set()


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
        if any(p.match(node) for p in PII_VALUE_PATTERNS):
            print(f"WARNING: value at {path} looks like personal data (phone number), redacting")
            return REDACTED_PII
    return node


def main():
    config = json.loads(LIVE.read_text())
    sanitized = redact(config)
    OUT.write_text(json.dumps(sanitized, indent=2) + "\n")
    print(f"Wrote {OUT}")


if __name__ == "__main__":
    main()
