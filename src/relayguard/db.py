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
import threading
import time
import uuid

from .models import CredentialCreate

GENESIS = "0" * 64
# Expression indexes keep event filters off full payload scans.  The query
# expressions below must stay structurally identical for SQLite to use them.
_EVENT_INDEXES = {
    "events_kind": "json_extract(payload,'$.kind')",
    "events_decision": "json_extract(payload,'$.decision')",
    "events_credential": "json_extract(payload,'$.credential_id')",
    "events_ts": "json_extract(payload,'$.ts')",
}
_KIND, _DECISION, _CREDENTIAL, _TS = (_EVENT_INDEXES[name] for name in
                                      ("events_kind", "events_decision", "events_credential", "events_ts"))


def timestamp(epoch=None):
    return datetime.fromtimestamp(time.time() if epoch is None else epoch, timezone.utc).isoformat(timespec="milliseconds")


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def event_hash(previous, payload):
    return hashlib.sha256((previous + "\n" + canonical(payload)).encode()).hexdigest()


class Store:
    def __init__(self, path):
        self.path = str(path)
        # Last chain position this process verified: (event_count, head_hash).
        # It is an in-memory anchor, so history rewritten or truncated behind
        # it is reported even when the rewritten chain is self-consistent.
        self._anchor = None
        self._anchor_lock = threading.Lock()
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
            for name, expression in _EVENT_INDEXES.items():
                conn.execute(f"CREATE INDEX IF NOT EXISTS {name} ON events({expression})")
            # Lifetime totals live on credentials, so only the current and the
            # previous fixed window are needed.  Older rows only grow the file.
            conn.execute("DELETE FROM budgets WHERE window < ?", (int(time.time() // 60) - 1,))

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
        if "minute_requests" in result:
            result["usage"].update(minute_requests=result.pop("minute_requests") or 0,
                                   minute_bytes=result.pop("minute_bytes") or 0,
                                   minute_window_start=result.pop("minute_window_start"))
        return result

    def _insert_credential(self, conn, data: CredentialCreate, now):
        token = "rg_" + secrets.token_urlsafe(32)
        cred = {
            "id": str(uuid.uuid4()), "name": data.name, "prefix": token[:11],
            "created_at": timestamp(now), "expires_at": timestamp(now + data.ttl_hours * 3600),
            "revoked_at": None, "policy": data.policy.model_dump(),
            "usage": {"total_requests": 0, "total_bytes": 0},
        }
        conn.execute(
            """INSERT INTO credentials
               (id,name,secret_hash,prefix,created_at,expires_at,revoked_at,policy)
               VALUES (?,?,?,?,?,?,?,?)""",
            (cred["id"], cred["name"], hashlib.sha256(token.encode()).hexdigest(), cred["prefix"],
             cred["created_at"], cred["expires_at"], None, canonical(cred["policy"])),
        )
        return cred, token

    def create_credential(self, data: CredentialCreate):
        with self.connection(write=True) as conn:
            cred, token = self._insert_credential(conn, data, time.time())
            self._audit(conn, kind="credential_created", credential_id=cred["id"], decision="allow", reason="credential_created")
        return {"credential": cred, "token": token}

    def rotate_credential(self, credential_id, data: CredentialCreate, grace_hours):
        """Issue a replacement and end or shorten the old key atomically.

        Returns None for an unknown key and "credential_inactive" for one that
        can no longer be used.  The old key's expiry is never extended.
        """
        with self.connection(write=True) as conn:
            now = time.time()
            old = conn.execute("SELECT * FROM credentials WHERE id=?", (credential_id,)).fetchone()
            if old is None:
                return None
            if self.credential_error(old, now):
                return "credential_inactive"
            cred, token = self._insert_credential(conn, data, now)
            self._audit(conn, kind="credential_created", credential_id=cred["id"], decision="allow",
                        reason="credential_created", related_credential_id=credential_id)
            if grace_hours == 0:
                conn.execute("UPDATE credentials SET revoked_at=? WHERE id=?", (timestamp(now), credential_id))
            else:
                expiry = min(datetime.fromisoformat(old["expires_at"]).timestamp(), now + grace_hours * 3600)
                conn.execute("UPDATE credentials SET expires_at=? WHERE id=?", (timestamp(expiry), credential_id))
            self._audit(conn, kind="credential_rotated", credential_id=credential_id, decision="allow",
                        reason="credential_rotated", related_credential_id=cred["id"])
            if grace_hours == 0:
                self._audit(conn, kind="credential_revoked", credential_id=credential_id, decision="allow",
                            reason="credential_revoked")
            replaced = self.public(conn.execute("SELECT * FROM credentials WHERE id=?", (credential_id,)).fetchone())
        return {"credential": cred, "token": token, "replaced": replaced}

    def list_credentials(self, now=None):
        window = int((time.time() if now is None else now) // 60)
        with self.connection() as conn:
            rows = conn.execute("""
                SELECT c.*, b.requests AS minute_requests, b.bytes AS minute_bytes, ? AS minute_window_start
                FROM credentials c LEFT JOIN budgets b ON b.credential_id=c.id AND b.window=?
                ORDER BY c.created_at DESC
            """, (timestamp(window * 60), window))
            return [self.public(r) for r in rows]

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
            created = conn.execute("INSERT OR IGNORE INTO budgets(credential_id,window) VALUES (?,?)",
                                   (credential_id, window)).rowcount
            if created:
                # A new window makes older ones unreachable for this key.  Keep
                # one previous window to tolerate a small backwards clock step.
                conn.execute("DELETE FROM budgets WHERE credential_id=? AND window < ?", (credential_id, window - 1))
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
               status=None, response_bytes=0, peer_ip=None, request_id=None, upstream_status=None,
               related_credential_id=None):
        previous = conn.execute("SELECT id,hash FROM events ORDER BY id DESC LIMIT 1").fetchone()
        prev_hash = previous["hash"] if previous else GENESIS
        payload = {
            "id": previous["id"] + 1 if previous else 1, "ts": timestamp(), "kind": kind,
            "credential_id": credential_id, "decision": decision, "reason": reason,
            "method": method, "path": path, "status": status, "response_bytes": response_bytes,
            "peer_ip": peer_ip, "request_id": request_id, "upstream_status": upstream_status,
        }
        if related_credential_id is not None:
            payload["related_credential_id"] = related_credential_id
        digest = event_hash(prev_hash, payload)
        conn.execute("INSERT INTO events VALUES (?,?,?,?)", (payload["id"], canonical(payload), prev_hash, digest))

    def audit(self, **kwargs):
        with self.connection(write=True) as conn:
            self._audit(conn, **kwargs)

    @staticmethod
    def _event(row):
        return dict(json.loads(row["payload"]), prev_hash=row["prev_hash"], hash=row["hash"])

    def all_events(self):
        with self.connection() as conn:
            return [self._event(r) for r in conn.execute("SELECT * FROM events ORDER BY id")]

    def recent_events(self, limit=100, decision=None, *, kind=None, credential_id=None, before_id=None, since=None):
        """Newest first.  kind is "proxy" or "admin" (every non-proxy event)."""
        clauses, params = [], []
        if decision:
            clauses.append(f"{_DECISION}=?")
            params.append(decision)
        if kind == "proxy":
            clauses.append(f"{_KIND}='proxy'")
        elif kind == "admin":
            clauses.append(f"{_KIND}!='proxy'")
        if credential_id:
            clauses.append(f"{_CREDENTIAL}=?")
            params.append(credential_id)
        if before_id is not None:
            clauses.append("id<?")
            params.append(before_id)
        if since:
            clauses.append(f"{_TS}>=?")
            params.append(since)
        where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
        with self.connection() as conn:
            rows = conn.execute(f"SELECT * FROM events {where} ORDER BY id DESC LIMIT ?", (*params, limit))
            return [self._event(r) for r in rows]

    def verify_audit(self, incremental=False):
        """Verify the hash chain, optionally only past this process's anchor.

        Both modes first check that the previously verified head still exists
        with the same hash.  Incremental mode then hashes only newer rows.
        """
        with self._anchor_lock:
            anchor = self._anchor
        with self.connection() as conn:
            if anchor and anchor[0]:
                count, head = anchor
                row = conn.execute("SELECT hash FROM events WHERE id=?", (count,)).fetchone()
                if row is None:
                    total = conn.execute("SELECT count(*) FROM events").fetchone()[0]
                    return {"valid": False, "event_count": total, "head_hash": head, "error": f"events_missing_after_{total}",
                            "mode": "incremental" if incremental else "full"}
                if row["hash"] != head:
                    return {"valid": False, "event_count": count, "head_hash": head, "error": f"chain_changed_at_{count}",
                            "mode": "incremental" if incremental else "full"}
            if incremental and anchor:
                result = self._verify_rows(conn.execute("SELECT * FROM events WHERE id>? ORDER BY id", (anchor[0],)),
                                           previous=anchor[1], count=anchor[0])
                result["mode"] = "incremental"
            else:
                result = self._verify_rows(conn.execute("SELECT * FROM events ORDER BY id"))
                result["mode"] = "full"
        if result["valid"]:
            with self._anchor_lock:
                if self._anchor is None or result["event_count"] >= self._anchor[0]:
                    self._anchor = (result["event_count"], result["head_hash"])
        return result

    @staticmethod
    def _verify_rows(rows, previous=GENESIS, count=0):
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
            events = [self._event(r) for r in rows]
        except (ValueError, TypeError):
            events = []
        return {"verification": verification, "events": events}

    def stats(self, now=None):
        now = time.time() if now is None else now
        current_hour = int(now // 3600)
        since = timestamp((current_hour - 23) * 3600)
        with self.connection() as conn:
            active = conn.execute("SELECT count(*) FROM credentials WHERE revoked_at IS NULL AND expires_at>?", (timestamp(now),)).fetchone()[0]
            row = conn.execute(f"""
                SELECT count(*) AS total,
                    coalesce(sum({_DECISION}='allow'),0) AS allowed,
                    coalesce(sum({_DECISION}!='allow'),0) AS blocked,
                    coalesce(sum(json_extract(payload,'$.response_bytes')),0) AS bytes
                FROM events WHERE {_KIND}='proxy'
            """).fetchone()
            # The ts index bounds this scan to the last 24 hourly buckets.
            hourly = {r["hour"]: r for r in conn.execute(f"""
                SELECT substr({_TS},1,13) AS hour,
                    coalesce(sum({_DECISION}='allow'),0) AS allowed,
                    coalesce(sum({_DECISION}!='allow'),0) AS blocked,
                    coalesce(sum(json_extract(payload,'$.response_bytes')),0) AS bytes
                FROM events WHERE {_TS}>=? AND {_KIND}='proxy' GROUP BY hour
            """, (since,))}
        buckets = []
        for hour in range(current_hour - 23, current_hour + 1):
            label = timestamp(hour * 3600)
            found = hourly.get(label[:13])
            buckets.append({"hour": label, "allowed": found["allowed"] if found else 0,
                            "blocked": found["blocked"] if found else 0, "bytes": found["bytes"] if found else 0})
        day = {"total": sum(b["allowed"] + b["blocked"] for b in buckets),
               "allowed": sum(b["allowed"] for b in buckets), "blocked": sum(b["blocked"] for b in buckets),
               "bytes_forwarded": sum(b["bytes"] for b in buckets), "since": since}
        return {"active_credentials": active, "total_requests": row["total"], "allowed": row["allowed"],
                "blocked": row["blocked"], "bytes_forwarded": row["bytes"], "last_24h": day, "hourly": buckets}

    def metrics(self, now=None):
        """Aggregate counters for Prometheus.  Derived from storage, so every
        worker reports the same values."""
        now = time.time() if now is None else now
        with self.connection() as conn:
            credentials = {r["state"]: r["n"] for r in conn.execute("""
                SELECT CASE WHEN revoked_at IS NOT NULL THEN 'revoked'
                            WHEN expires_at<=? THEN 'expired' ELSE 'active' END AS state, count(*) AS n
                FROM credentials GROUP BY state
            """, (timestamp(now),))}
            reasons = [dict(r) for r in conn.execute(f"""
                SELECT {_DECISION} AS decision, json_extract(payload,'$.reason') AS reason, count(*) AS n,
                    coalesce(sum(json_extract(payload,'$.response_bytes')),0) AS bytes
                FROM events WHERE {_KIND}='proxy' GROUP BY decision, reason
            """)]
            admin_failures = conn.execute(f"SELECT count(*) FROM events WHERE {_KIND}='admin_auth'").fetchone()[0]
            events = conn.execute("SELECT coalesce(max(id),0) FROM events").fetchone()[0]
        return {"credentials": credentials, "proxy": reasons, "admin_auth_failures": admin_failures, "events": events}
