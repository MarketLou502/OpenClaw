#!/usr/bin/env python3

import os
import sqlite3
import subprocess
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("parse_transaction.py")


class ParseTransactionTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.db = root / "finance.db"
        self.log = root / "parse.log"
        conn = sqlite3.connect(self.db)
        conn.executescript("""
          CREATE TABLE transactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            account_last4 TEXT, type TEXT NOT NULL, amount REAL NOT NULL,
            date TEXT NOT NULL, merchant_raw TEXT, merchant_clean TEXT,
            category TEXT, notes TEXT, needs_review INTEGER DEFAULT 1,
            source_event_id TEXT, source TEXT DEFAULT 'email',
            created_at TEXT DEFAULT (datetime('now'))
          );
          CREATE UNIQUE INDEX idx_transactions_source_event_id
          ON transactions(source_event_id) WHERE source_event_id IS NOT NULL;
          CREATE TABLE monthly_summary (
            year INTEGER, month INTEGER, spending REAL DEFAULT 0,
            PRIMARY KEY(year,month)
          );
        """)
        conn.commit()
        conn.close()

    def tearDown(self):
        self.temp.cleanup()

    def run_email(self, message_id, body):
        raw = f"Message-ID: <{message_id}>\nContent-Type: text/plain; charset=utf-8\n\n{body}"
        result = subprocess.run(
            [os.environ.get("PYTHON", "python3"), str(SCRIPT)],
            input=raw,
            text=True,
            capture_output=True,
            env={**os.environ, "FINANCE_DB_PATH": str(self.db), "FINANCE_LOG_PATH": str(self.log)},
            timeout=10,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout

    def test_exact_source_dedup_but_same_amount_purchase_allowed(self):
        body = "$12.34\nDate: July 31, 2026\nCard transaction\nDescription: TEST STORE"
        self.run_email("one", body)
        self.assertIn("SKIP", self.run_email("one", body))
        self.run_email("two", body)
        conn = sqlite3.connect(self.db)
        rows = conn.execute("SELECT type,amount,needs_review,source FROM transactions ORDER BY id").fetchall()
        self.assertEqual(rows, [("debit", 12.34, 1, "email"), ("debit", 12.34, 1, "email")])
        conn.close()

    def test_non_debit_email_is_not_retained(self):
        conn = sqlite3.connect(self.db)
        conn.execute("INSERT INTO monthly_summary(year,month,spending) VALUES(2026,7,50)")
        conn.commit()
        conn.close()
        self.run_email("refund", "$10.00\nDate: July 31, 2026\nRefund\nDescription: TEST STORE")
        conn = sqlite3.connect(self.db)
        self.assertEqual(conn.execute("SELECT spending FROM monthly_summary WHERE year=2026 AND month=7").fetchone()[0], 50)
        self.assertEqual(conn.execute("SELECT COUNT(*) FROM transactions").fetchone()[0], 0)
        conn.close()


if __name__ == "__main__":
    unittest.main()
