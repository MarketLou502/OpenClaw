#!/usr/bin/env python3
"""Store Plaid Production API credentials without exposing them in shell history."""

from __future__ import annotations

import getpass
import json
import os
import tempfile
from pathlib import Path


WORKSPACE = Path(__file__).resolve().parent.parent
CREDENTIAL_PATH = WORKSPACE / "memory" / ".plaid_credentials.json"


def prompt_nonempty(prompt: str, *, hidden: bool = False) -> str:
    reader = getpass.getpass if hidden else input
    while True:
        value = reader(prompt).strip()
        if value:
            return value
        print("Value cannot be empty. Try again.")


def main() -> int:
    print("Plaid Production credential setup")
    print("Values stay on this Mac and are not sent to OpenClaw or Codex.")

    if CREDENTIAL_PATH.exists():
        answer = input("Credentials already exist. Replace them? [y/N]: ").strip().lower()
        if answer not in {"y", "yes"}:
            print("No changes made.")
            return 0

    client_id = prompt_nonempty("Plaid Client ID: ")
    secret = prompt_nonempty("Plaid Production secret (input hidden): ", hidden=True)

    CREDENTIAL_PATH.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "client_id": client_id,
        "secret": secret,
        "environment": "production",
    }

    fd, temporary_name = tempfile.mkstemp(
        prefix=".plaid_credentials.", suffix=".tmp", dir=CREDENTIAL_PATH.parent
    )
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_name, CREDENTIAL_PATH)
        os.chmod(CREDENTIAL_PATH, 0o600)
    except BaseException:
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass
        raise

    print(f"Saved Plaid Production credentials to {CREDENTIAL_PATH}")
    print("Permissions set to owner read/write only (0600).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
