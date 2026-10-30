import asyncio
import os
import sqlite3
import subprocess
import sys
import threading
import time

import httpx
import pytest
from fastapi.testclient import TestClient

from relayguard.app import create_app
from relayguard.operations import storage_ready
from relayguard.settings import Settings


ADMIN = "admin-" + "a" * 40
PROVIDER = "provider-" + "b" * 40


def configured(tmp_path):
    return Settings(upstream_url="https://provider.invalid", upstream_token=PROVIDER,
                    admin_token=ADMIN, database_path=str(tmp_path / "state.db"))


@pytest.fixture
def clean_env(monkeypatch):
    for name in list(os.environ):
        if name.startswith("RELAYGUARD_"):
            monkeypatch.delenv(name)
    monkeypatch.setenv("RELAYGUARD_UPSTREAM_URL", "https://provider.invalid")
    monkeypatch.setenv("RELAYGUARD_UPSTREAM_TOKEN", PROVIDER)
    monkeypatch.setenv("RELAYGUARD_ADMIN_TOKEN", ADMIN)


def test_secret_files_accept_single_line_and_never_appear_in_repr(tmp_path, monkeypatch, clean_env):
    for name, value in [("ADMIN", ADMIN), ("UPSTREAM", PROVIDER)]:
        path = tmp_path / name
        path.write_bytes((value + "\r\n").encode())
        monkeypatch.delenv(f"RELAYGUARD_{name}_TOKEN")
        monkeypatch.setenv(f"RELAYGUARD_{name}_TOKEN_FILE", str(path))
    settings = Settings.from_env()
    assert settings.admin_token == ADMIN and settings.upstream_token == PROVIDER
    assert ADMIN not in repr(settings) and PROVIDER not in repr(settings)


def test_secret_sources_cannot_be_ambiguous(tmp_path, monkeypatch, clean_env):
    monkeypatch.setenv("RELAYGUARD_ADMIN_TOKEN_FILE", str(tmp_path / "unused"))
    with pytest.raises(ValueError, match="not both") as exc:
        Settings.from_env()
    assert ADMIN not in str(exc.value)


@pytest.mark.parametrize("content", [b"", b"x" * 8193, b"x" * 8193 + b"\n", b"\xff", b"line\nbreak", b"a" * 40 + b"\n\n"])
def test_invalid_secret_files_fail_closed(tmp_path, monkeypatch, clean_env, content):
    path = tmp_path / "private-secret"
    path.write_bytes(content)
    monkeypatch.delenv("RELAYGUARD_ADMIN_TOKEN")
    monkeypatch.setenv("RELAYGUARD_ADMIN_TOKEN_FILE", str(path))
    with pytest.raises(ValueError) as exc:
        Settings.from_env()
    assert str(path) not in str(exc.value)
    assert "line\nbreak" not in str(exc.value)


def test_missing_secret_file_does_not_fall_back(tmp_path, monkeypatch, clean_env):
    monkeypatch.delenv("RELAYGUARD_ADMIN_TOKEN")
    monkeypatch.setenv("RELAYGUARD_ADMIN_TOKEN_FILE", str(tmp_path / "absent"))
    with pytest.raises(ValueError, match="ADMIN_TOKEN_FILE"):
        Settings.from_env()


@pytest.mark.skipif(not hasattr(os, "mkfifo"), reason="POSIX named pipe")
def test_secret_file_rejects_fifo_without_waiting(tmp_path, monkeypatch, clean_env):
    path = tmp_path / "private-pipe"
    os.mkfifo(path)
    monkeypatch.delenv("RELAYGUARD_ADMIN_TOKEN")
    monkeypatch.setenv("RELAYGUARD_ADMIN_TOKEN_FILE", str(path))
    with pytest.raises(ValueError, match="ADMIN_TOKEN_FILE"):
        Settings.from_env()


def test_resource_limits_can_be_configured(monkeypatch, clean_env):
    monkeypatch.setenv("RELAYGUARD_MAX_REQUEST_BYTES", "4096")
    monkeypatch.setenv("RELAYGUARD_UPSTREAM_TIMEOUT_SECONDS", "2.5")
    settings = Settings.from_env()
    assert settings.max_request_bytes == 4096
    assert settings.upstream_timeout_seconds == 2.5


@pytest.mark.parametrize("name,value", [("MAX_REQUEST_BYTES", "garbage-secret"), ("MAX_REQUEST_BYTES", "0"), ("UPSTREAM_TIMEOUT_SECONDS", "nan"), ("UPSTREAM_TIMEOUT_SECONDS", "infinity")])
def test_bad_resource_limits_do_not_echo_values(monkeypatch, clean_env, name, value):
    monkeypatch.setenv("RELAYGUARD_" + name, value)
    with pytest.raises(ValueError) as exc:
        Settings.from_env()
    assert "garbage-secret" not in str(exc.value)


def test_readiness_checks_storage_without_mutation_or_provider_call(tmp_path):
    settings = configured(tmp_path)
    app = create_app(settings)
    before = app.state.store.export_audit()
    with TestClient(app) as client:
        assert client.get("/readyz").json() == {"status": "ready", "service": "relayguard"}
        assert client.get("/api/overview").status_code == 401
        assert client.get("/readyz").headers["cache-control"] == "no-store"
    assert app.state.store.export_audit() == before


def test_locked_storage_is_not_ready_but_process_is_live(tmp_path):
    settings = configured(tmp_path)
    app = create_app(settings)
    with TestClient(app) as client, sqlite3.connect(settings.database_path) as lock:
        lock.execute("BEGIN IMMEDIATE")
        start = time.monotonic()
        response = client.get("/readyz")
        assert response.status_code == 503
        assert response.json()["error"]["code"] == "storage_not_ready"
        assert time.monotonic() - start < 1.0
        assert str(tmp_path) not in response.text
        assert client.get("/healthz").status_code == 200
        lock.rollback()
        assert client.get("/readyz").status_code == 200


def test_readiness_does_not_create_missing_database(tmp_path):
    path = tmp_path / "missing.db"
    assert not storage_ready(path)
    assert not path.exists()


def test_readiness_rejects_incomplete_database(tmp_path):
    path = tmp_path / "incomplete.db"
    with sqlite3.connect(path) as conn:
        conn.execute("CREATE TABLE unrelated (id INTEGER)")
    assert not storage_ready(path)


def test_readiness_rejects_missing_budget_table(tmp_path):
    settings = configured(tmp_path)
    create_app(settings)
    with sqlite3.connect(settings.database_path) as conn:
        conn.execute("DROP TABLE budgets")
    assert not storage_ready(settings.database_path)


def test_check_config_has_no_database_side_effect(tmp_path, monkeypatch, clean_env):
    path = tmp_path / "should-not-exist.db"
    monkeypatch.setenv("RELAYGUARD_DB", str(path))
    result = subprocess.run([sys.executable, "-m", "relayguard", "check-config"], text=True, capture_output=True)
    assert result.returncode == 0, result.stderr
    assert "No database was created" in result.stdout
    assert not path.exists()
    assert ADMIN not in result.stdout + result.stderr
    assert PROVIDER not in result.stdout + result.stderr


@pytest.mark.asyncio
async def test_admin_verification_does_not_block_the_http_event_loop(tmp_path, monkeypatch):
    app = create_app(configured(tmp_path))
    started, release = threading.Event(), threading.Event()

    def slow_verify():
        started.set()
        release.wait(timeout=2)
        return {"valid": True, "event_count": 0, "head_hash": "0" * 64}

    monkeypatch.setattr(app.state.store, "verify_audit", slow_verify)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test") as client:
        pending = asyncio.create_task(client.get("/api/audit/verify", headers={"Authorization": "Bearer " + ADMIN}))
        try:
            assert await asyncio.to_thread(started.wait, 1)
            assert not pending.done(), "Blocking DB work must not run on the event loop"
            assert (await asyncio.wait_for(client.get("/healthz"), timeout=0.5)).status_code == 200
        finally:
            release.set()
            await pending
