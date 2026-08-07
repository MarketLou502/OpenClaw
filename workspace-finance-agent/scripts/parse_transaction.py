#!/usr/bin/env python3
"""
parse_transaction.py — Parse Capital One transaction emails and write to finance.db.

Called by the launchd Apple Mail poller. Receives email text on stdin and
writes one silent transaction row to the database. It never sends a message.

Usage:
    echo "<email plain text>" | python3 parse_transaction.py
    python3 parse_transaction.py < /tmp/email.txt
"""

import re
import sys
import email
import sqlite3
import logging
import html.parser
import os
import urllib.request
from datetime import datetime
from pathlib import Path

DB_PATH    = Path(os.environ.get("FINANCE_DB_PATH", "/Users/aaronmacmini/.openclaw/workspace-finance-agent/finance.db"))
LOG_PATH   = Path(os.environ.get("FINANCE_LOG_PATH", "/Users/aaronmacmini/.openclaw/workspace-finance-agent/scripts/parse.log"))
DASHBOARD_URL = os.environ.get("DASHBOARD_API_URL", "http://127.0.0.1:18795")
DASHBOARD_TOKEN_FILE = Path(os.environ.get(
    "DASHBOARD_API_TOKEN_FILE", "/Users/aaronmacmini/.openclaw/service-env/dashboard-api.token"
))

logging.basicConfig(
    filename=str(LOG_PATH),
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s"
)


class _HTMLStripper(html.parser.HTMLParser):
    """Minimal HTML-to-text converter — strips tags, decodes entities."""
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self._parts = []
    def handle_data(self, data):
        stripped = data.strip()
        if stripped:
            self._parts.append(stripped)
    def get_text(self):
        return "\n".join(self._parts)


def extract_text_from_mime(raw: str) -> str:
    """
    Parse a raw MIME email string (from AppleScript `source of m`).
    Prefer text/plain part; fall back to stripping HTML from text/html part.
    """
    try:
        msg = email.message_from_string(raw)
        plain, html_body = None, None
        for part in msg.walk():
            ct = part.get_content_type()
            if ct == "text/plain" and plain is None:
                plain = part.get_payload(decode=True).decode(part.get_content_charset("utf-8"), errors="replace")
            elif ct == "text/html" and html_body is None:
                html_body = part.get_payload(decode=True).decode(part.get_content_charset("utf-8"), errors="replace")
        if plain and plain.strip():
            return plain
        if html_body:
            s = _HTMLStripper()
            s.feed(html_body)
            return s.get_text()
    except Exception:
        pass
    return raw  # last resort: use as-is


def parse_amount(text):
    m = re.search(r'\$([0-9,]+\.\d{2})', text)
    return float(m.group(1).replace(",", "")) if m else None


def parse_date(text):
    # "Date: March 16, 2026"  or  "Deposited on: March 16, 2026"
    m = re.search(r'(?:Date|Deposited on):\s*([A-Za-z]+ \d{1,2},?\s*\d{4})', text)
    if not m:
        # Declined emails have no date line — use today
        return datetime.now().strftime("%Y-%m-%d")
    raw = m.group(1).replace(",", "").strip()
    for fmt in ("%B %d %Y", "%B %d, %Y"):
        try:
            return datetime.strptime(raw, fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    return raw  # fallback: return as-is


def parse_email(text):
    t = text.lower()

    # Determine transaction type from subject / body keywords
    if "declined" in t or "purchase exceeds" in t or "isn't enough to cover" in t:
        tx_type = "declined"
    elif "card transaction" in t or "debit card purchase" in t:
        tx_type = "debit"
    elif "deposit" in t:
        tx_type = "deposit"
    elif "refund" in t or "credit" in t:
        tx_type = "refund"
    else:
        tx_type = "unknown"

    amount = parse_amount(text)
    date   = parse_date(text)

    # Merchant — prefer "Appears on your statement as:" line, fall back to Description,
    # fall back to declined-email inline format "cover your $X.XX MERCHANT purchase"
    merchant_raw = None
    statement_m = re.search(r'Appears on your statement as:\s*(.+)', text, re.IGNORECASE)
    if statement_m:
        raw = statement_m.group(1).strip()
        merchant_raw = re.sub(r'^Debit Card Purchase\s*[-–]\s*', '', raw, flags=re.IGNORECASE).strip()
    else:
        desc_m = re.search(r'Description:\s*(.+)', text, re.IGNORECASE)
        if desc_m:
            merchant_raw = desc_m.group(1).strip()
        else:
            # Declined email: "cover your $90.75 MERCHANT NAME CITY purchase"
            declined_m = re.search(r'cover your \$[0-9,.]+\s+(.+?)\s+purchase', text, re.IGNORECASE)
            if declined_m:
                merchant_raw = declined_m.group(1).strip()

    # Last 4 digits shown in email (card or account)
    account_m = re.search(r'360 Checking[.\u2026]+(\d{4})', text)
    account_last4 = account_m.group(1) if account_m else None

    return {
        "type":         tx_type,
        "amount":       amount,
        "date":         date,
        "merchant_raw": merchant_raw,
        "account_last4": account_last4,
    }


def source_identity(raw):
    """Return a stable identity for one source email.

    Mail's rule handler and the fallback AppleScript can serialize the same
    MIME message with different line endings/encoding details, so hashing the
    entire raw source is not stable across both ingestion paths. Message-ID is
    assigned by the sender and remains unchanged between those serializations.
    """
    msg = email.message_from_string(raw)
    message_id = (msg.get("Message-ID") or "").strip().strip("<>").lower()
    if not message_id:
        raise ValueError("email has no Message-ID header")
    return f"email-message-id:{message_id}"


def is_duplicate(source_event_id):
    """Use the source event identity; same-day same-amount purchases are valid."""
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    columns = {row[1] for row in c.execute("PRAGMA table_info(transactions)")}
    if "source_event_id" not in columns:
        c.execute("ALTER TABLE transactions ADD COLUMN source_event_id TEXT")
        c.execute("ALTER TABLE transactions ADD COLUMN source TEXT DEFAULT 'email'")
        c.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_source_event_id ON transactions(source_event_id) WHERE source_event_id IS NOT NULL")
        conn.commit()
    c.execute("SELECT id FROM transactions WHERE source_event_id=? LIMIT 1", (source_event_id,))
    row = c.fetchone()
    conn.close()
    return row is not None


def write_to_db(tx, source_event_id):
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("""
        INSERT OR IGNORE INTO transactions
          (account_last4, type, amount, date, merchant_raw, needs_review, source_event_id, source)
        VALUES (?, ?, ?, ?, ?, 1, ?, 'email')
    """, (tx["account_last4"], tx["type"], tx["amount"], tx["date"], tx["merchant_raw"], source_event_id))
    row_id = c.lastrowid if c.rowcount == 1 else None

    conn.commit()
    conn.close()
    return row_id


def notify_dashboard():
    """Best-effort ping so dashboard-api recomputes financials and pushes
    the update over SSE. Never allowed to fail the actual DB write above
    it — a missed notification just means the dashboard catches up on its
    next slow reconciliation poll instead of immediately."""
    try:
        token = DASHBOARD_TOKEN_FILE.read_text().strip()
        req = urllib.request.Request(
            f"{DASHBOARD_URL}/api/notify/financials",
            method="POST",
            headers={"Authorization": f"Bearer {token}"},
        )
        urllib.request.urlopen(req, timeout=3)
    except Exception as e:
        logging.info(f"dashboard notify failed (non-fatal): {e}")


def main():
    raw = sys.stdin.read()
    if not raw.strip():
        logging.warning("Empty email received — skipping.")
        sys.exit(0)

    # Extract readable text from raw MIME source (handles HTML-only emails)
    email_text = extract_text_from_mime(raw)

    tx = parse_email(email_text)
    try:
        source_event_id = source_identity(raw)
    except ValueError as e:
        logging.error(f"Cannot establish source identity: {e}")
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)
    logging.info(f"Parsed: {tx}")

    # Successful debit-card purchases are the only active Finance email data.
    # Other event types are not retained or used to infer available funds.
    if tx["type"] != "debit":
        logging.info(f"Ignoring out-of-scope transaction type: {tx['type']}")
        print(f"SKIP (out-of-scope type: {tx['type']})")
        sys.exit(0)

    if tx["amount"] is None:
        logging.warning(f"Could not parse amount. Extracted text snippet: {email_text[:300]}")
        sys.exit(1)

    if is_duplicate(source_event_id):
        logging.info("Duplicate source email detected, skipping.")
        print("SKIP (duplicate source email)")
        sys.exit(0)

    row_id = write_to_db(tx, source_event_id)
    if row_id is None:
        logging.info("Duplicate source email detected during insert, skipping.")
        print("SKIP (duplicate source email)")
        sys.exit(0)
    logging.info(f"Written to DB row {row_id}")
    notify_dashboard()

    print(f"OK: tx_id={row_id} type={tx['type']} amount={tx['amount']} date={tx['date']}")


if __name__ == "__main__":
    main()
