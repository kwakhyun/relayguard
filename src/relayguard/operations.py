"""Bounded local readiness checks. These never contact the provider API."""
from pathlib import Path
import sqlite3


def storage_ready(path):
    # mode=rw avoids silently creating a replacement if an operator removes the DB.
    # BEGIN IMMEDIATE probes the write lock; rollback leaves all state untouched.
    connection = None
    try:
        uri = Path(path).resolve().as_uri() + "?mode=rw"
        connection = sqlite3.connect(uri, uri=True, timeout=0.1, isolation_level=None)
        connection.execute("BEGIN IMMEDIATE")
        connection.execute("SELECT id, total_requests, total_bytes FROM credentials LIMIT 1").fetchone()
        connection.execute("SELECT credential_id, window, requests, bytes FROM budgets LIMIT 1").fetchone()
        connection.execute("SELECT id FROM events LIMIT 1").fetchone()
        connection.execute("UPDATE credentials SET name=name WHERE 0")
        return True
    except (OSError, sqlite3.Error):
        return False
    finally:
        if connection is not None:
            try:
                connection.rollback()
            finally:
                connection.close()
