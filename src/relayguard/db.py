"""SQLite-backed credentials, atomic fixed-window budgets, and audit hash chain.

No raw credentials, payloads or query strings are persisted. SQLite serializes
writes across workers; a successful reservation is never refunded on failure.
"""
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import secrets
import sqlite3
import time
import uuid

from .models import CredentialCreate

GENESIS = "0" * 64


def timestamp(epoch=None):
    return datetime.fromtimestamp(time.time() if epoch is None else epoch, timezone.utc).isoformat(timespec="milliseconds")


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def event_hash(previous, payload):
    return hashlib.sha256((previous + "\n" + canonical(payload)).encode()).hexdigest()


class Store:
    def __init__(self, path):
        self.path = str(path)
        target = Path(path)
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        if target.is_symlink():
            raise ValueError("Database cannot be a symlink")
        try:
            fd = os.open(target, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            os.close(fd)
        except FileExistsError:
            pass
        with self.connection() as conn:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.executescript("""
                CREATE TABLE IF NOT EXISTS credentials (
                    id TEXT PRIMARY KEY, name TEXT NOT NULL,
                    secret_hash TEXT UNIQUE NOT NULL, prefix TEXT NOT NULL,
                    created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
                    revoked_at TEXT, policy TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS budgets (
                    credential_id TEXT NOT NULL, window INTEGER NOT NULL,
                    requests INTEGER NOT NULL DEFAULT 0,
                    bytes INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY (credential_id, window),
                    FOREIGN KEY (credential_id) REFERENCES credentials(id)
                );
                CREATE TABLE IF NOT EXISTS events (
                    id INTEGER PRIMARY KEY, payload TEXT NOT NULL,
                    prev_hash TEXT NOT NULL, hash TEXT NOT NULL
                );
            """)
        # Serialize schema inspection with migration so concurrent workers do
        # not both ALTER the same existing database.  Historical fixed-window
        # rows are retained and become the initial lifetime usage, never zero.
        with self.connection(write=True) as conn:
            columns = {row["name"] for row in conn.execute("PRAGMA table_info(credentials)")}
            for total, window_column in (("total_requests", "requests"), ("total_bytes", "bytes")):
                if total not in columns:
                    conn.execute(f"ALTER TABLE credentials ADD COLUMN {total} INTEGER NOT NULL DEFAULT 0")
                    conn.execute(f"""UPDATE credentials SET {total}=coalesce(
                        (SELECT sum({window_column}) FROM budgets WHERE credential_id=credentials.id), 0)
                    """)

    @contextmanager
    def connection(self, write=False):
        conn = sqlite3.connect(self.path, timeout=5, isolation_level=None)
        conn.row_factory = sqlite3.Row
        try:
            conn.execute("PRAGMA foreign_keys=ON")
            conn.execute("PRAGMA synchronous=FULL")
            if write:
                conn.execute("BEGIN IMMEDIATE")
            yield conn
            if write:
                conn.commit()
        except BaseException:
            if write:
                conn.rollback()
            raise
        finally:
            conn.close()

    @staticmethod
    def public(row):
        if row is None:
            return None
        result = dict(row)
        result.pop("secret_hash", None)
        result["policy"] = json.loads(result["policy"])
        result["usage"] = {"total_requests": result.pop("total_requests"),
                           "total_bytes": result.pop("total_bytes")}
        return result

    def create_credential(self, data: CredentialCreate):
        token = "rg_" + secrets.token_urlsafe(32)
        now = time.time()
        cred = {
            "id": str(uuid.uuid4()), "name": data.name, "prefix": token[:11],
            "created_at": timestamp(now), "expires_at": timestamp(now + data.ttl_hours * 3600),
            "revoked_at": None, "policy": data.policy.model_dump(),
            "usage": {"total_requests": 0, "total_bytes": 0},
        }
        with self.connection(write=True) as conn:
            conn.execute(
                """INSERT INTO credentials
                   (id,name,secret_hash,prefix,created_at,expires_at,revoked_at,policy)
                   VALUES (?,?,?,?,?,?,?,?)""",
                (cred["id"], cred["name"], hashlib.sha256(token.encode()).hexdigest(), cred["prefix"],
                 cred["created_at"], cred["expires_at"], None, canonical(cred["policy"])),
            )
            self._audit(conn, kind="credential_created", credential_id=cred["id"], decision="allow", reason="credential_created")
        return {"credential": cred, "token": token}

    def list_credentials(self):
        with self.connection() as conn:
            return [self.public(r) for r in conn.execute("SELECT * FROM credentials ORDER BY created_at DESC")]

    def find_credential(self, token):
        digest = hashlib.sha256(token.encode()).hexdigest()
        with self.connection() as conn:
            return self.public(conn.execute("SELECT * FROM credentials WHERE secret_hash=?", (digest,)).fetchone())

    def revoke(self, credential_id):
        with self.connection(write=True) as conn:
            row = conn.execute("SELECT * FROM credentials WHERE id=?", (credential_id,)).fetchone()
            if row is None:
                return None
            if row["revoked_at"] is None:
                conn.execute("UPDATE credentials SET revoked_at=? WHERE id=?", (timestamp(), credential_id))
                self._audit(conn, kind="credential_revoked", credential_id=credential_id, decision="allow", reason="credential_revoked")
            return self.public(conn.execute("SELECT * FROM credentials WHERE id=?", (credential_id,)).fetchone())

    @staticmethod
    def credential_error(row, now):
        if row is None or row["revoked_at"] is not None:
            return "token_revoked"
        if datetime.fromisoformat(row["expires_at"]).timestamp() <= now:
            return "token_expired"
        return None

    def _spend(self, credential_id, now, column, amount, limit_key):
        # column/limit_key come only from the two fixed methods below, never input.
        with self.connection(write=True) as conn:
            # Sample live request time only after obtaining the writer lock.
            # A queued call must not use a pre-lock clock to bypass expiry or
            # charge a stale minute.  Explicit times remain for deterministic
            # callers/tests; the gateway always requests live transaction time.
            now = time.time() if now is None else now
            row = conn.execute("SELECT * FROM credentials WHERE id=?", (credential_id,)).fetchone()
            error = self.credential_error(row, now)
            if error:
                return error
            policy = json.loads(row["policy"])
            total_column = "total_requests" if column == "requests" else "total_bytes"
            lifetime_key = "max_total_requests" if column == "requests" else "max_total_bytes"
            lifetime_limit = policy.get(lifetime_key)
            if lifetime_limit is not None and row[total_column] + amount > lifetime_limit:
                return "lifetime_request_limit" if column == "requests" else "lifetime_byte_budget"
            window = int(now // 60)
            conn.execute("INSERT OR IGNORE INTO budgets(credential_id,window) VALUES (?,?)", (credential_id, window))
            used = conn.execute(f"SELECT {column} FROM budgets WHERE credential_id=? AND window=?", (credential_id, window)).fetchone()[0]
            limit = policy[limit_key]
            if used + amount > limit:
                return "rate_limit" if column == "requests" else "byte_budget"
            conn.execute(f"UPDATE budgets SET {column}={column}+? WHERE credential_id=? AND window=?", (amount, credential_id, window))
            conn.execute(f"UPDATE credentials SET {total_column}={total_column}+? WHERE id=?", (amount, credential_id))
        return None

    def reserve_request(self, credential_id, now=None):
        return self._spend(credential_id, now, "requests", 1, "requests_per_minute")

    def spend_bytes(self, credential_id, amount, now=None):
        if isinstance(amount, bool) or not isinstance(amount, int) or amount < 0:
            raise ValueError("Invalid byte charge")
        return self._spend(credential_id, now, "bytes", amount, "bytes_per_minute")

    def _audit(self, conn, *, kind, credential_id, decision, reason, method=None, path=None,
               status=None, response_bytes=0, peer_ip=None):
        previous = conn.execute("SELECT id,hash FROM events ORDER BY id DESC LIMIT 1").fetchone()
        prev_hash = previous["hash"] if previous else GENESIS
        payload = {
            "id": previous["id"] + 1 if previous else 1, "ts": timestamp(), "kind": kind,
            "credential_id": credential_id, "decision": decision, "reason": reason,
            "method": method, "path": path, "status": status, "response_bytes": response_bytes,
            "peer_ip": peer_ip,
        }
        digest = event_hash(prev_hash, payload)
        conn.execute("INSERT INTO events VALUES (?,?,?,?)", (payload["id"], canonical(payload), prev_hash, digest))

    def audit(self, **kwargs):
        with self.connection(write=True) as conn:
            self._audit(conn, **kwargs)

    def all_events(self):
        with self.connection() as conn:
            return [dict(json.loads(r["payload"]), prev_hash=r["prev_hash"], hash=r["hash"]) for r in conn.execute("SELECT * FROM events ORDER BY id")]

    def recent_events(self, limit=100, decision=None):
        with self.connection() as conn:
            if decision:
                rows = conn.execute("SELECT * FROM events WHERE json_extract(payload, '$.decision')=? ORDER BY id DESC LIMIT ?", (decision, limit))
            else:
                rows = conn.execute("SELECT * FROM events ORDER BY id DESC LIMIT ?", (limit,))
            return [dict(json.loads(r["payload"]), prev_hash=r["prev_hash"], hash=r["hash"]) for r in rows]

    def verify_audit(self):
        with self.connection() as conn:
            return self._verify_rows(conn.execute("SELECT * FROM events ORDER BY id"))

    @staticmethod
    def _verify_rows(rows):
        previous = GENESIS
        count = 0
        for row in rows:
            count += 1
            try:
                payload = json.loads(row["payload"])
                valid = (row["id"] == count and payload["id"] == count and
                         row["prev_hash"] == previous and event_hash(previous, payload) == row["hash"])
            except (ValueError, KeyError, TypeError):
                valid = False
            if not valid:
                return {"valid": False, "event_count": count, "head_hash": previous, "error": f"chain_mismatch_at_{count}"}
            previous = row["hash"]
        return {"valid": True, "event_count": count, "head_hash": previous}

    def export_audit(self):
        # Both verification and data use one SELECT snapshot, including during writes.
        with self.connection() as conn:
            rows = conn.execute("SELECT * FROM events ORDER BY id").fetchall()
        verification = self._verify_rows(rows)
        try:
            events = [dict(json.loads(r["payload"]), prev_hash=r["prev_hash"], hash=r["hash"]) for r in rows]
        except (ValueError, TypeError):
            events = []
        return {"verification": verification, "events": events}

    def stats(self):
        with self.connection() as conn:
            active = conn.execute("SELECT count(*) FROM credentials WHERE revoked_at IS NULL AND expires_at>?", (timestamp(),)).fetchone()[0]
            row = conn.execute("""
                SELECT count(*) AS total,
                    coalesce(sum(json_extract(payload,'$.decision')='allow'),0) AS allowed,
                    coalesce(sum(json_extract(payload,'$.decision')!='allow'),0) AS blocked,
                    coalesce(sum(json_extract(payload,'$.response_bytes')),0) AS bytes
                FROM events WHERE json_extract(payload,'$.kind')='proxy'
            """).fetchone()
        return {"active_credentials": active, "total_requests": row["total"], "allowed": row["allowed"],
                "blocked": row["blocked"], "bytes_forwarded": row["bytes"]}
