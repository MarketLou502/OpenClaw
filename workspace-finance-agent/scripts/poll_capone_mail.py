#!/usr/bin/env python3
"""
poll_capone_mail.py — Poll Apple Mail inbox for unprocessed Capital One emails.

Called by launchd every 60 seconds. Uses osascript to read inbox, checks
processed_emails table to skip already-handled messages, then pipes each
new email through parse_transaction.py.

No AI/LLM involved — pure Python + AppleScript + SQLite.
"""

import subprocess
import sqlite3
import logging
import sys
from pathlib import Path

DB_PATH     = Path("/Users/aaronmacmini/.openclaw/workspace-finance-agent/finance.db")
PARSE_SCRIPT = Path("/Users/aaronmacmini/.openclaw/workspace-finance-agent/scripts/parse_transaction.py")
LOG_PATH    = Path("/Users/aaronmacmini/.openclaw/workspace-finance-agent/scripts/parse.log")

logging.basicConfig(
    filename=str(LOG_PATH),
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s"
)

FETCH_SCRIPT = """
tell application "Mail"
    set result to {}
    set allMessages to (messages of inbox whose sender contains "capitalone.com")
    repeat with m in allMessages
        set msgId to message id of m
        set msgSource to (source of m) as text
        set end of result to {msgId, msgSource}
    end repeat
    return result
end tell
"""


def get_inbox_emails():
    """Returns list of (message_id, source) tuples from Mail inbox."""
    result = subprocess.run(
        ["osascript", "-e", FETCH_SCRIPT],
        capture_output=True, text=True, timeout=30
    )
    if result.returncode != 0:
        logging.error(f"osascript error: {result.stderr.strip()}")
        return []

    # osascript returns a flat comma-separated list of alternating id, source pairs
    # We write each to a temp file approach instead — see below
    return result.stdout.strip()


def get_processed_ids():
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("SELECT message_id FROM processed_emails")
    ids = {row[0] for row in c.fetchall()}
    conn.close()
    return ids


def mark_processed(message_id):
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("INSERT OR IGNORE INTO processed_emails (message_id) VALUES (?)", (message_id,))
    conn.commit()
    conn.close()


# Use a per-message osascript approach to reliably extract source
FETCH_ONE_SCRIPT = """
tell application "Mail"
    set cutoff to (current date) - (3 * days)
    set allMessages to (messages of inbox whose sender contains "capitalone.com" and date received >= cutoff)
    set msgIds to {}
    repeat with m in allMessages
        set msgIds to msgIds & {message id of m}
    end repeat
    return msgIds
end tell
"""

FETCH_SOURCE_SCRIPT = """
tell application "Mail"
    set cutoff to (current date) - (3 * days)
    set allMessages to (messages of inbox whose sender contains "capitalone.com" and date received >= cutoff)
    repeat with m in allMessages
        if (message id of m) is equal to "{MSG_ID}" then
            return (source of m) as text
        end if
    end repeat
    return ""
end tell
"""



def get_message_ids():
    result = subprocess.run(
        ["osascript", "-e", FETCH_ONE_SCRIPT],
        capture_output=True, text=True, timeout=30
    )
    if result.returncode != 0:
        logging.error(f"osascript fetch IDs error: {result.stderr.strip()}")
        return []
    raw = result.stdout.strip()
    if not raw:
        return []
    return [x.strip() for x in raw.split(",") if x.strip()]


def get_message_source(message_id):
    script = FETCH_SOURCE_SCRIPT.replace("{MSG_ID}", message_id.replace('"', '\\"'))
    tmp = Path("/tmp/capone_source.applescript")
    tmp.write_text(script)
    result = subprocess.run(
        ["osascript", str(tmp)],
        capture_output=True, text=True, timeout=30
    )
    tmp.unlink(missing_ok=True)
    if result.returncode != 0:
        logging.error(f"osascript fetch source error: {result.stderr.strip()}")
        return None
    return result.stdout.strip() or None


def process_email(source):
    result = subprocess.run(
        [sys.executable, str(PARSE_SCRIPT)],
        input=source, capture_output=True, text=True, timeout=60
    )
    if result.returncode != 0:
        logging.error(f"parse_transaction failed: {result.stderr.strip()}")
        return False
    logging.info(f"parse_transaction: {result.stdout.strip()}")
    return True


def main():
    message_ids = get_message_ids()
    if not message_ids:
        return

    processed = get_processed_ids()
    new_ids = [mid for mid in message_ids if mid not in processed]

    if not new_ids:
        return

    logging.info(f"Found {len(new_ids)} new Capital One email(s) to process.")

    for mid in new_ids:
        source = get_message_source(mid)
        if not source:
            logging.warning(f"Could not fetch source for message {mid}, skipping.")
            continue
        success = process_email(source)
        if success:
            mark_processed(mid)


if __name__ == "__main__":
    main()
