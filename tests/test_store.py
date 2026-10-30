"""Persistence and adversarial concurrency checks for the security boundary."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
import hashlib
import json
import sqlite3
from threading import Barrier
import time

import pytest

from relayguard.db import Store
from relayguard.models import CredentialCreate, Policy, RouteRule


def issue(store, **policy_overrides):
    policy = Policy(routes=[RouteRule(method="GET", path="/customers")], **policy_overrides)
    return store.create_credential(CredentialCreate(name="CRM integration", policy=policy))


@pytest.fixture
def store(tmp_path):
    return Store(tmp_path / "state" / "guard.db")


def concurrently(count, action):
    barrier = Barrier(count)

    def worker(_):
        barrier.wait(timeout=10)
        return action()

    with ThreadPoolExecutor(max_workers=count) as pool:
        return list(pool.map(worker, range(count)))


def test_concurrent_request_reservations_never_exceed_quota(store):
    credential = issue(store, requests_per_minute=7)["credential"]
    now = time.time()
    results = concurrently(40, lambda: store.reserve_request(credential["id"], now))
    assert results.count(None) == 7
    assert results.count("rate_limit") == 33
    with store.connection() as conn:
        assert conn.execute("SELECT sum(requests) FROM budgets").fetchone()[0] == 7


def test_concurrent_response_charges_never_exceed_budget(store):
    credential = issue(store, bytes_per_minute=1024)["credential"]
    now = time.time()
    results = concurrently(50, lambda: store.spend_bytes(credential["id"], 128, now))
    assert results.count(None) == 8
    assert results.count("byte_budget") == 42
    with store.connection() as conn:
        assert conn.execute("SELECT sum(bytes) FROM budgets").fetchone()[0] == 1024


def test_restart_preserves_tokens_budgets_revocation_and_audit(store):
    created = issue(store, requests_per_minute=1, bytes_per_minute=128)
    credential_id = created["credential"]["id"]
    now = time.time()
    assert store.reserve_request(credential_id, now) is None
    assert store.spend_bytes(credential_id, 128, now) is None
    head = store.verify_audit()

    reopened = Store(store.path)
    assert reopened.find_credential(created["token"])["id"] == credential_id
    assert reopened.reserve_request(credential_id, now) == "rate_limit"
    assert reopened.spend_bytes(credential_id, 1, now) == "byte_budget"
    assert reopened.verify_audit() == head
    reopened.revoke(credential_id)

    again = Store(store.path)
    assert again.reserve_request(credential_id, now) == "token_revoked"
    assert again.spend_bytes(credential_id, 1, now) == "token_revoked"
    assert again.verify_audit()["valid"] is True
    assert [event["kind"] for event in again.all_events()] == ["credential_created", "credential_revoked"]


def test_expired_credential_cannot_reserve_or_release_data(store):
    created = issue(store)
    credential = created["credential"]
    expires = datetime.fromisoformat(credential["expires_at"]).timestamp()
    assert store.reserve_request(credential["id"], expires) == "token_expired"
    assert store.spend_bytes(credential["id"], 1, expires + 1) == "token_expired"
    with store.connection() as conn:
        assert conn.execute("SELECT count(*) FROM budgets").fetchone()[0] == 0


def test_revocation_is_idempotent_and_missing_ids_do_not_add_events(store):
    created = issue(store)
    credential_id = created["credential"]["id"]
    first = store.revoke(credential_id)
    second = store.revoke(credential_id)
    assert first["revoked_at"] == second["revoked_at"]
    assert store.revoke("missing-id") is None
    assert store.find_credential("rg_unknown") is None
    assert store.reserve_request("missing-id", time.time()) == "token_revoked"
    assert len(store.all_events()) == 2
    assert store.stats()["active_credentials"] == 0


def test_only_token_digest_and_short_prefix_are_persisted(store):
    from pathlib import Path

    created = issue(store)
    token = created["token"]
    digest = hashlib.sha256(token.encode()).hexdigest()
    with store.connection() as conn:
        row = conn.execute("SELECT * FROM credentials").fetchone()
        assert row["secret_hash"] == digest
        assert row["prefix"] == token[:11]
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    for database_file in Path(store.path).parent.iterdir():
        if database_file.is_file():
            assert token.encode() not in database_file.read_bytes()
    assert "secret_hash" not in store.find_credential(token)
    assert "secret_hash" not in store.list_credentials()[0]
    assert token not in json.dumps(store.all_events())


def reject_audit_inserts(store):
    with store.connection() as conn:
        conn.executescript("""
            CREATE TRIGGER reject_audit BEFORE INSERT ON events
            BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END;
        """)


def test_credential_creation_rolls_back_if_audit_insert_fails(store):
    reject_audit_inserts(store)
    with pytest.raises(sqlite3.IntegrityError, match="audit unavailable"):
        issue(store)
    assert store.list_credentials() == []
    assert store.all_events() == []


def test_revocation_rolls_back_if_audit_insert_fails(store):
    created = issue(store)
    reject_audit_inserts(store)
    with pytest.raises(sqlite3.IntegrityError, match="audit unavailable"):
        store.revoke(created["credential"]["id"])
    assert store.find_credential(created["token"])["revoked_at"] is None
    assert len(store.all_events()) == 1
    assert store.verify_audit()["valid"] is True


def test_concurrent_audit_writes_form_one_complete_chain(store):
    credential = issue(store)["credential"]
    results = concurrently(40, lambda: store.audit(
        kind="proxy", credential_id=credential["id"], decision="deny", reason="route_denied",
        method="GET", path="/export", status=403,
    ))
    assert results == [None] * 40
    verification = store.verify_audit()
    assert verification["valid"] is True
    assert verification["event_count"] == 41
    assert [event["id"] for event in store.all_events()] == list(range(1, 42))


@pytest.mark.parametrize("mutation", [
    "UPDATE events SET payload=json_set(payload, '$.reason', 'forged') WHERE id=1",
    "UPDATE events SET hash='forged' WHERE id=1",
    "UPDATE events SET prev_hash='forged' WHERE id=2",
    "DELETE FROM events WHERE id=1",
])
def test_audit_verification_detects_record_changes(store, mutation):
    created = issue(store)
    store.revoke(created["credential"]["id"])
    with store.connection() as conn:
        conn.execute(mutation)
    result = store.verify_audit()
    assert result["valid"] is False
    assert result["error"].startswith("chain_mismatch_at_")


def test_audit_tail_truncation_requires_external_checkpoint(store):
    """A hash chain alone cannot detect deletion of its final records."""
    created = issue(store)
    store.revoke(created["credential"]["id"])
    checkpoint = store.verify_audit()
    with store.connection() as conn:
        conn.execute("DELETE FROM events WHERE id=2")
    shortened = store.verify_audit()
    assert shortened["valid"] is True
    assert shortened["event_count"] < checkpoint["event_count"]
    assert shortened["head_hash"] != checkpoint["head_hash"]


def test_budget_resets_only_at_next_fixed_minute(store):
    credential = issue(store, requests_per_minute=1, bytes_per_minute=128)["credential"]
    start = int(time.time() // 60) * 60
    assert store.reserve_request(credential["id"], start + 59.99) is None
    assert store.reserve_request(credential["id"], start + 59.999) == "rate_limit"
    assert store.reserve_request(credential["id"], start + 60) is None
    assert store.spend_bytes(credential["id"], 128, start + 59.99) is None
    assert store.spend_bytes(credential["id"], 1, start + 59.999) == "byte_budget"
    assert store.spend_bytes(credential["id"], 128, start + 60) is None


@pytest.mark.parametrize("amount", [-1, True, 1.5, "128"])
def test_invalid_byte_charges_cannot_refund_budget(store, amount):
    credential = issue(store)["credential"]
    with pytest.raises(ValueError, match="Invalid byte charge"):
        store.spend_bytes(credential["id"], amount, time.time())


def test_lifetime_usage_does_not_reset_with_minute_or_restart(store):
    created = issue(store, requests_per_minute=1, bytes_per_minute=128,
                    max_total_requests=2, max_total_bytes=256)
    identifier = created["credential"]["id"]
    now = int(time.time() // 60) * 60
    assert created["credential"]["usage"] == {"total_requests": 0, "total_bytes": 0}
    for moment in (now, now + 60):
        assert store.reserve_request(identifier, moment) is None
        assert store.spend_bytes(identifier, 128, moment) is None
    reopened = Store(store.path)
    assert reopened.reserve_request(identifier, now + 120) == "lifetime_request_limit"
    assert reopened.spend_bytes(identifier, 1, now + 120) == "lifetime_byte_budget"
    assert reopened.find_credential(created["token"])["usage"] == {"total_requests": 2, "total_bytes": 256}
    assert reopened.list_credentials()[0]["usage"] == {"total_requests": 2, "total_bytes": 256}
    assert reopened.revoke(identifier)["usage"] == {"total_requests": 2, "total_bytes": 256}


def test_concurrent_lifetime_limits_never_overspend(store):
    created = issue(store, requests_per_minute=100, bytes_per_minute=10000,
                    max_total_requests=7, max_total_bytes=1024)
    identifier = created["credential"]["id"]
    now = time.time()
    requests = concurrently(40, lambda: store.reserve_request(identifier, now))
    responses = concurrently(40, lambda: store.spend_bytes(identifier, 128, now))
    assert requests.count(None) == 7
    assert requests.count("lifetime_request_limit") == 33
    assert responses.count(None) == 8
    assert responses.count("lifetime_byte_budget") == 32
    assert store.find_credential(created["token"])["usage"] == {"total_requests": 7, "total_bytes": 1024}
    with store.connection() as conn:
        budget = conn.execute("SELECT sum(requests),sum(bytes) FROM budgets").fetchone()
        assert tuple(budget) == (7, 1024)


def test_minute_denials_do_not_charge_lifetime_usage(store):
    created = issue(store, requests_per_minute=1, bytes_per_minute=128,
                    max_total_requests=5, max_total_bytes=512)
    identifier = created["credential"]["id"]
    now = time.time()
    assert store.reserve_request(identifier, now) is None
    assert store.reserve_request(identifier, now) == "rate_limit"
    assert store.spend_bytes(identifier, 100, now) is None
    assert store.spend_bytes(identifier, 100, now) == "byte_budget"
    assert store.find_credential(created["token"])["usage"] == {"total_requests": 1, "total_bytes": 100}


def test_lifetime_and_minute_updates_rollback_together(store):
    created = issue(store, max_total_requests=5, max_total_bytes=512)
    identifier = created["credential"]["id"]
    with store.connection() as conn:
        conn.executescript("""
            CREATE TRIGGER reject_counters BEFORE UPDATE OF total_requests,total_bytes ON credentials
            BEGIN SELECT RAISE(ABORT, 'counter unavailable'); END;
        """)
    with pytest.raises(sqlite3.IntegrityError):
        store.reserve_request(identifier, time.time())
    with pytest.raises(sqlite3.IntegrityError):
        store.spend_bytes(identifier, 128, time.time())
    assert store.find_credential(created["token"])["usage"] == {"total_requests": 0, "total_bytes": 0}
    with store.connection() as conn:
        assert conn.execute("SELECT count(*) FROM budgets").fetchone()[0] == 0


@pytest.mark.parametrize("starting_workers", [1, 6])
def test_legacy_database_migration_preserves_history_and_is_idempotent(tmp_path, starting_workers):
    from relayguard.db import canonical, timestamp

    path = tmp_path / "legacy.db"
    token = "rg_synthetic_legacy_token"
    now = time.time()
    legacy_policy = Policy(routes=[RouteRule(method="GET", path="/customers")]).model_dump(
        exclude={"max_total_requests", "max_total_bytes"})
    with sqlite3.connect(path) as conn:
        conn.executescript("""
            CREATE TABLE credentials (id TEXT PRIMARY KEY, name TEXT NOT NULL,
                secret_hash TEXT UNIQUE NOT NULL, prefix TEXT NOT NULL, created_at TEXT NOT NULL,
                expires_at TEXT NOT NULL, revoked_at TEXT, policy TEXT NOT NULL);
            CREATE TABLE budgets (credential_id TEXT NOT NULL, window INTEGER NOT NULL,
                requests INTEGER NOT NULL DEFAULT 0, bytes INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY(credential_id,window), FOREIGN KEY(credential_id) REFERENCES credentials(id));
        """)
        conn.execute("INSERT INTO credentials VALUES (?,?,?,?,?,?,?,?)", (
            "legacy", "Synthetic legacy", hashlib.sha256(token.encode()).hexdigest(), token[:11],
            timestamp(now - 120), timestamp(now + 3600), None, canonical(legacy_policy)))
        conn.executemany("INSERT INTO budgets VALUES (?,?,?,?)", [
            ("legacy", int(now // 60) - 2, 3, 256), ("legacy", int(now // 60) - 1, 2, 384)])
    # All workers start against the same old schema.  The backfill must happen
    # once, including when independent connections race to inspect its columns.
    workers = concurrently(starting_workers, lambda: Store(path))
    assert all(worker.find_credential(token)["usage"] == {"total_requests": 5, "total_bytes": 640}
               for worker in workers)
    migrated = workers[0]
    assert migrated.find_credential(token)["usage"] == {"total_requests": 5, "total_bytes": 640}
    assert "max_total_requests" not in migrated.find_credential(token)["policy"]
    assert migrated.reserve_request("legacy", now) is None
    assert migrated.spend_bytes("legacy", 128, now) is None
    assert Store(path).find_credential(token)["usage"] == {"total_requests": 6, "total_bytes": 768}
    with migrated.connection() as conn:
        assert conn.execute("SELECT count(*) FROM budgets").fetchone()[0] == 3


def test_unlimited_lifetime_defaults_still_track_usage(store):
    created = issue(store)
    identifier = created["credential"]["id"]
    now = time.time()
    assert store.reserve_request(identifier, now) is None
    assert store.spend_bytes(identifier, 200, now) is None
    assert store.find_credential(created["token"])["usage"] == {"total_requests": 1, "total_bytes": 200}


@pytest.mark.parametrize("operation", ["request", "bytes"])
def test_live_time_is_sampled_after_writer_lock_for_expiry(store, monkeypatch, operation):
    from contextlib import contextmanager

    created = issue(store)
    expires = datetime.fromisoformat(created["credential"]["expires_at"]).timestamp()
    clock = [expires - 1]
    original = store.connection

    @contextmanager
    def after_lock(write=False):
        with original(write=write) as conn:
            if write:
                # Simulate a lock wait spanning expiration.  Sampling before
                # acquiring this transaction would incorrectly allow the call.
                clock[0] = expires + 1
            yield conn

    monkeypatch.setattr(store, "connection", after_lock)
    monkeypatch.setattr("relayguard.db.time.time", lambda: clock[0])
    result = (store.reserve_request(created["credential"]["id"]) if operation == "request"
              else store.spend_bytes(created["credential"]["id"], 128))
    assert result == "token_expired"
    assert store.find_credential(created["token"])["usage"] == {"total_requests": 0, "total_bytes": 0}
