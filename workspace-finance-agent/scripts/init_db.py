#!/usr/bin/env python3
"""
init_db.py — Create the finance.db SQLite schema for finance-agent.
Safe to run multiple times (CREATE TABLE IF NOT EXISTS).
"""

import sqlite3
from pathlib import Path

DB_PATH = Path("/Users/aaronmacmini/.openclaw/workspace-finance-agent/finance.db")


def init():
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()

    c.executescript("""
        -- Successful debit purchases captured from Capital One emails
        CREATE TABLE IF NOT EXISTS transactions (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            account_last4   TEXT,           -- last 4 of card or account shown in email
            type            TEXT NOT NULL,  -- active ingestion stores debit only
            amount          REAL NOT NULL,
            date            TEXT NOT NULL,  -- YYYY-MM-DD
            merchant_raw    TEXT,           -- exactly as seen in email
            merchant_clean  TEXT,           -- human-readable, set by agent
            category        TEXT,           -- set by agent after reviewing with Aaron
            notes           TEXT,           -- Aaron's notes
            needs_review    INTEGER DEFAULT 1,  -- 1 = agent has not yet reviewed with Aaron
            source_event_id TEXT,           -- exact email/message identity for idempotency
            source          TEXT DEFAULT 'email',
            created_at      TEXT DEFAULT (datetime('now'))
        );

        -- Known recurring or upcoming bills
        CREATE TABLE IF NOT EXISTS expenses (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            name            TEXT NOT NULL,
            amount_est      REAL,           -- estimated amount (NULL if variable)
            due_day         INTEGER,        -- day of month (1-31), NULL if not monthly
            recurrence      TEXT,           -- monthly | annual | one-time | irregular
            is_negotiable   INTEGER DEFAULT 1,  -- 0 = must pay (rent, utilities, etc.)
            last_paid_date  TEXT,
            active          INTEGER DEFAULT 1,
            notes           TEXT
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_source_event_id
        ON transactions(source_event_id)
        WHERE source_event_id IS NOT NULL;

        CREATE INDEX IF NOT EXISTS idx_transactions_pending_review
        ON transactions(needs_review, id)
        WHERE needs_review = 1;

        -- Plaid transaction history maintained incrementally by /transactions/sync.
        -- Kept separate from the email-derived review queue above.
        CREATE TABLE IF NOT EXISTS plaid_transactions (
            transaction_id TEXT PRIMARY KEY,
            account_id      TEXT NOT NULL,
            date            TEXT,
            authorized_date TEXT,
            name            TEXT,
            merchant_name   TEXT,
            amount          REAL NOT NULL,
            pending         INTEGER NOT NULL DEFAULT 0,
            category        TEXT,
            currency        TEXT,
            updated_at      TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_plaid_transactions_account_date
        ON plaid_transactions(account_id, date DESC);

        -- Cached balance snapshots returned alongside Transactions updates.
        -- No paid real-time Balance request is used by the active system.
        CREATE TABLE IF NOT EXISTS account_balances (
            id                INTEGER PRIMARY KEY AUTOINCREMENT,
            account_id        TEXT NOT NULL,
            institution_name  TEXT,
            account_name      TEXT,
            account_mask      TEXT,
            balance_current   REAL,
            balance_available REAL,
            currency          TEXT DEFAULT 'USD',
            fetched_at        TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_account_balances_account_fetched
        ON account_balances(account_id, fetched_at DESC);

        PRAGMA optimize;
    """)

    conn.commit()
    conn.close()
    print(f"finance.db initialized at {DB_PATH}")


if __name__ == "__main__":
    init()
