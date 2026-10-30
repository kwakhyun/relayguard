"""End-to-end enforcement of persistent credential lifetime allowances."""

import time

import httpx
import pytest
from fastapi.testclient import TestClient

from relayguard.app import create_app
from relayguard.settings import Settings


@pytest.fixture
def rig(tmp_path):
    seen = []

    async def upstream(request):
        seen.append(request)
        return httpx.Response(200, content=b"S" * 100, headers={"Content-Type": "text/plain"})

    settings = Settings(upstream_url="https://synthetic.invalid", upstream_token="synthetic-upstream",
                        admin_token="synthetic-admin-" + "a" * 32, database_path=str(tmp_path / "state.db"))
    app = create_app(settings, upstream_transport=httpx.MockTransport(upstream))
    with TestClient(app) as client:
        yield app, client, seen, {"Authorization": "Bearer " + settings.admin_token}


def issue(rig, **limits):
    _, client, _, admin = rig
    response = client.post("/api/credentials", headers=admin, json={
        "name": "Bounded synthetic integration", "policy": {
            "routes": [{"method": "GET", "path": "/customers"}], **limits,
        },
    })
    assert response.status_code == 201
    return response.json()


def test_lifetime_request_limit_blocks_upstream_after_minute_changes(rig, monkeypatch):
    app, client, seen, admin = rig
    created = issue(rig, max_total_requests=1)
    assert created["credential"]["usage"] == {"total_requests": 0, "total_bytes": 0}
    headers = {"Authorization": "Bearer " + created["token"]}
    first = client.get("/proxy/customers", headers=headers)
    assert first.status_code == 200
    later = time.time() + 60
    monkeypatch.setattr("relayguard.db.time.time", lambda: later)
    second = client.get("/proxy/customers", headers=headers)
    assert second.status_code == 429
    assert second.json()["error"]["code"] == "lifetime_request_limit"
    assert len(seen) == 1
    listed = client.get("/api/credentials", headers=admin)
    assert created["token"] not in listed.text
    assert "secret_hash" not in listed.text
    assert listed.json()["items"][0]["usage"] == {"total_requests": 1, "total_bytes": 100}
    assert app.state.store.all_events()[-1]["reason"] == "lifetime_request_limit"


def test_lifetime_byte_limit_withholds_whole_response_after_minute_changes(rig, monkeypatch):
    app, client, seen, admin = rig
    created = issue(rig, max_total_bytes=128)
    headers = {"Authorization": "Bearer " + created["token"]}
    assert client.get("/proxy/customers", headers=headers).status_code == 200
    later = time.time() + 60
    monkeypatch.setattr("relayguard.db.time.time", lambda: later)
    response = client.get("/proxy/customers", headers=headers)
    assert response.status_code == 429
    assert response.json()["error"]["code"] == "lifetime_byte_budget"
    assert b"SSSS" not in response.content
    assert len(seen) == 2
    usage = client.get("/api/credentials", headers=admin).json()["items"][0]["usage"]
    assert usage == {"total_requests": 2, "total_bytes": 100}
    event = app.state.store.all_events()[-1]
    assert event["reason"] == "lifetime_byte_budget" and event["response_bytes"] == 0


@pytest.mark.parametrize("column,upstream_calls", [("total_requests", 0), ("total_bytes", 1)])
def test_lifetime_counter_storage_failures_are_fail_closed(rig, column, upstream_calls):
    app, client, seen, _ = rig
    created = issue(rig, max_total_requests=5, max_total_bytes=512)
    with app.state.store.connection() as conn:
        conn.executescript(f"""
            CREATE TRIGGER reject_lifetime BEFORE UPDATE OF {column} ON credentials
            BEGIN SELECT RAISE(ABORT, 'private storage error'); END;
        """)
    response = client.get("/proxy/customers", headers={"Authorization": "Bearer " + created["token"]})
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "storage_unavailable"
    assert b"SSSS" not in response.content and b"private storage" not in response.content
    assert len(seen) == upstream_calls
    assert app.state.store.find_credential(created["token"])["usage"][column] == 0
