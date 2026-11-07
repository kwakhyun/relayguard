"""Operational features: correlation, filters, rotation, metrics, alerts, auth header."""

import json
import time

import httpx
import pytest
from fastapi.testclient import TestClient

from relayguard.app import create_app
from relayguard.db import Store
from relayguard.settings import Settings

ADMIN = "admin-ops-" + "a" * 40
NEXT = "admin-next-" + "n" * 40
METRICS = "metrics-scrape-" + "m" * 40
UPSTREAM = "upstream-ops-" + "u" * 40


def make_settings(tmp_path, **overrides):
    values = dict(upstream_url="https://upstream.invalid", upstream_token=UPSTREAM, admin_token=ADMIN,
                  database_path=str(tmp_path / "state.db"))
    values.update(overrides)
    return Settings(**values)


@pytest.fixture
def rig(tmp_path):
    seen, state = [], {}

    async def upstream(request):
        seen.append(request)
        if state.get("callback"):
            return await state["callback"](request)
        return httpx.Response(200, json={"ok": True})

    hooks = []

    async def webhook(request):
        hooks.append(json.loads(request.content))
        return httpx.Response(204)

    def build(**overrides):
        settings = make_settings(tmp_path, **overrides)
        app = create_app(settings, upstream_transport=httpx.MockTransport(upstream),
                         alert_transport=httpx.MockTransport(webhook))
        return TestClient(app, client=("198.51.100.20", 4000)), app

    yield {"build": build, "seen": seen, "state": state, "hooks": hooks}


def admin(token=ADMIN):
    return {"Authorization": "Bearer " + token}


def issue(client, *, name="Synthetic ops key", **policy):
    body = {"name": name, "ttl_hours": 24, "policy": {
        "routes": [{"method": "GET", "path": "/customers"}, {"method": "GET", "path": "/customers/*"}], **policy}}
    response = client.post("/api/credentials", headers=admin(), json=body)
    assert response.status_code == 201, response.text
    return response.json()


def relay(item):
    return {"Authorization": "Bearer " + item["token"]}


def wait_for(predicate, timeout=3.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.02)
    return predicate()


def test_request_id_and_upstream_status_are_audited(rig):
    async def not_found(request):
        return httpx.Response(404, json={"detail": "private upstream detail"})

    client, app = rig["build"]()
    with client:
        item = issue(client)
        ok = client.get("/proxy/customers", headers=relay(item))
        rig["state"]["callback"] = not_found
        missing = client.get("/proxy/customers/42", headers=relay(item))
        assert missing.status_code == 502 and b"private upstream detail" not in missing.content
        events = [e for e in app.state.store.all_events() if e["kind"] == "proxy"]
    assert events[0]["request_id"] == ok.headers["x-request-id"]
    assert events[0]["upstream_status"] == 200
    assert events[1]["request_id"] == missing.headers["x-request-id"] == missing.json()["request_id"]
    assert (events[1]["status"], events[1]["upstream_status"], events[1]["reason"]) == (502, 404, "upstream_rejected")


def test_forwardable_upstream_status_is_returned_without_body(rig):
    async def not_found(request):
        return httpx.Response(404, json={"secret": "do-not-release"})

    client, app = rig["build"]()
    with client:
        item = issue(client, forward_error_statuses=[404, 422])
        rig["state"]["callback"] = not_found
        response = client.get("/proxy/customers/7", headers=relay(item))
        usage = client.get("/api/credentials", headers=admin()).json()["items"][0]["usage"]
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "upstream_rejected"
    assert b"do-not-release" not in response.content
    assert usage["total_bytes"] == 0
    assert app.state.store.all_events()[-1]["status"] == 404


@pytest.mark.parametrize("statuses", [[401], [500], [404, 404], [302]])
def test_forwardable_statuses_are_restricted(rig, statuses):
    client, _ = rig["build"]()
    with client:
        response = client.post("/api/credentials", headers=admin(), json={
            "name": "x", "policy": {"routes": [{"method": "GET", "path": "/"}], "forward_error_statuses": statuses}})
    assert response.status_code == 422


def test_event_filters_and_cursor_pagination(rig):
    client, _ = rig["build"]()
    with client:
        first, second = issue(client, name="First"), issue(client, name="Second")
        for _ in range(3):
            client.get("/proxy/customers", headers=relay(first))
        client.get("/proxy/exports", headers=relay(second))
        first_id = first["credential"]["id"]
        page = client.get(f"/api/events?limit=2&kind=proxy&credential_id={first_id}", headers=admin()).json()
        assert [e["credential_id"] for e in page["items"]] == [first_id, first_id]
        assert page["next_before_id"] == page["items"][-1]["id"]
        rest = client.get(f"/api/events?limit=2&kind=proxy&credential_id={first_id}&before_id={page['next_before_id']}",
                          headers=admin()).json()
        assert len(rest["items"]) == 1 and rest["next_before_id"] is None
        admin_events = client.get("/api/events?kind=admin", headers=admin()).json()["items"]
        assert {e["kind"] for e in admin_events} == {"credential_created"}
        denied = client.get("/api/events?kind=proxy&decision=deny&since_hours=1", headers=admin()).json()["items"]
        assert [(e["credential_id"], e["reason"]) for e in denied] == [(second["credential"]["id"], "route_denied")]
        assert client.get("/api/events?credential_id=not-a-uuid", headers=admin()).status_code == 422
        assert client.get("/api/events?since_hours=0", headers=admin()).status_code == 422


def test_overview_has_daily_series_and_incremental_audit(rig):
    client, _ = rig["build"]()
    with client:
        item = issue(client)
        client.get("/proxy/customers", headers=relay(item))
        client.get("/proxy/exports", headers=relay(item))
        data = client.get("/api/overview", headers=admin()).json()
    assert data["audit"]["mode"] == "incremental" and data["audit"]["valid"] is True
    assert len(data["stats"]["hourly"]) == 24
    assert data["stats"]["hourly"][-1]["allowed"] == 1 and data["stats"]["hourly"][-1]["blocked"] == 1
    assert data["stats"]["last_24h"] | {"since": None} == {"total": 2, "allowed": 1, "blocked": 1,
                                                          "bytes_forwarded": 11, "since": None}
    assert data["upstream_auth"] == {"header": "Authorization", "scheme": "Bearer"}
    assert data["alerts"] == {"enabled": False}


def test_credentials_report_current_minute_usage(rig):
    client, _ = rig["build"]()
    with client:
        item = issue(client)
        client.get("/proxy/customers", headers=relay(item))
        usage = client.get("/api/credentials", headers=admin()).json()["items"][0]["usage"]
    assert usage["minute_requests"] == 1 and usage["minute_bytes"] == 11
    assert usage["minute_window_start"].endswith(":00.000+00:00")


@pytest.mark.parametrize("grace_hours", [0, 2])
def test_rotation_issues_replacement_and_ends_old_key(rig, grace_hours):
    client, app = rig["build"]()
    with client:
        old = issue(client, requests_per_minute=7)
        replacement = dict(name="Rotated", ttl_hours=48, policy=old["credential"]["policy"])
        response = client.post(f"/api/credentials/{old['credential']['id']}/rotate", headers=admin(),
                               json={"credential": replacement, "grace_hours": grace_hours})
        assert response.status_code == 201, response.text
        result = response.json()
        assert result["credential"]["policy"]["requests_per_minute"] == 7
        assert client.get("/proxy/customers", headers=relay(result)).status_code == 200
        old_status = client.get("/proxy/customers", headers=relay(old)).status_code
        events = app.state.store.all_events()
    if grace_hours == 0:
        assert result["replaced"]["revoked_at"] is not None and old_status == 401
    else:
        assert result["replaced"]["revoked_at"] is None and old_status == 200
        remaining = time.mktime(time.strptime(result["replaced"]["expires_at"][:19], "%Y-%m-%dT%H:%M:%S")) - time.mktime(time.gmtime())
        assert 0 < remaining <= 2 * 3600 + 5
    rotated = [e for e in events if e["kind"] == "credential_rotated"]
    assert rotated[0]["credential_id"] == old["credential"]["id"]
    assert rotated[0]["related_credential_id"] == result["credential"]["id"]


def test_rotation_rejects_unknown_and_inactive_keys(rig):
    client, _ = rig["build"]()
    with client:
        old = issue(client)
        body = {"credential": {"name": "x", "policy": old["credential"]["policy"]}, "grace_hours": 0}
        assert client.post("/api/credentials/missing/rotate", headers=admin(), json=body).status_code == 404
        client.post(f"/api/credentials/{old['credential']['id']}/revoke", headers=admin())
        response = client.post(f"/api/credentials/{old['credential']['id']}/rotate", headers=admin(), json=body)
        assert response.status_code == 409 and response.json()["error"]["code"] == "credential_inactive"
        assert client.post(f"/api/credentials/{old['credential']['id']}/rotate", headers=admin(),
                           json={**body, "grace_hours": 169}).status_code == 422


def test_policy_check_api_matches_gateway_rules(rig):
    client, _ = rig["build"]()
    policy = {"routes": [{"method": "GET", "path": "/customers/*", "query_keys": ["limit"]}],
              "ip_allowlist": ["10.0.0.0/8"]}
    cases = [
        {"method": "GET", "path": "/customers/1?limit=2", "peer_ip": "10.1.2.3"},
        {"method": "GET", "path": "/customers/1?debug=1", "peer_ip": "10.1.2.3"},
        {"method": "GET", "path": "/customers/1/export", "peer_ip": "10.1.2.3"},
        {"method": "GET", "path": "/customers/%2e%2e", "peer_ip": "10.1.2.3"},
        {"method": "GET", "path": "/customers/1", "peer_ip": "192.0.2.1"},
        {"method": "GET", "path": "/customers/1"},
    ]
    with client:
        response = client.post("/api/policy/check", headers=admin(), json={"policy": policy, "cases": cases})
        unauthenticated = client.post("/api/policy/check", json={"policy": policy, "cases": cases})
    results = response.json()["results"]
    assert [r["code"] for r in results] == ["allowed", "query_denied", "route_denied", "invalid_path", "ip_denied", "allowed"]
    assert results[0]["matched_route"] == {"method": "GET", "path": "/customers/*"}
    assert [r["ip_checked"] for r in results] == [True] * 5 + [False]
    assert unauthenticated.status_code == 401


def test_next_admin_token_and_failed_admin_auth_are_audited(rig):
    client, app = rig["build"](admin_token_next=NEXT)
    with client:
        assert client.get("/api/credentials", headers=admin(NEXT)).status_code == 200
        assert client.get("/api/credentials", headers=admin("wrong-" + "x" * 40)).status_code == 401
        overview = client.get("/api/overview", headers=admin()).json()
    failures = [e for e in app.state.store.all_events() if e["kind"] == "admin_auth"]
    assert [(e["reason"], e["path"], e["peer_ip"], e["status"]) for e in failures] == [
        ("admin_auth_failed", "/api/credentials", "198.51.100.20", 401)]
    assert overview["admin_token_rotation"] is True
    assert overview["stats"]["total_requests"] == 0


def test_metrics_require_a_scrape_or_admin_token(rig):
    client, _ = rig["build"](metrics_token=METRICS)
    with client:
        item = issue(client)
        client.get("/proxy/customers", headers=relay(item))
        client.get("/proxy/exports", headers=relay(item))
        assert client.get("/metrics").status_code == 401
        scraped = client.get("/metrics", headers=admin(METRICS))
        assert client.get("/metrics", headers=admin()).status_code == 200
        assert client.get("/api/credentials", headers=admin(METRICS)).status_code == 401
    assert scraped.headers["content-type"].startswith("text/plain; version=0.0.4")
    body = scraped.text
    assert 'relayguard_credentials{state="active"} 1' in body
    assert 'relayguard_proxy_requests_total{decision="allow",reason="forwarded"} 1' in body
    assert 'relayguard_proxy_requests_total{decision="deny",reason="route_denied"} 1' in body
    assert "relayguard_proxy_response_bytes_total 11" in body
    assert "relayguard_admin_auth_failures_total 1" in body
    assert "relayguard_audit_chain_valid 1" in body
    assert item["token"] not in body and METRICS not in body


def test_custom_upstream_auth_header_replaces_authorization(rig):
    client, _ = rig["build"](upstream_auth_header="X-API-Key", upstream_auth_scheme="")
    with client:
        item = issue(client)
        assert client.get("/proxy/customers", headers=relay(item)).status_code == 200
    sent = rig["seen"][-1].headers
    assert sent["x-api-key"] == UPSTREAM
    assert "authorization" not in sent


def test_alerts_report_budget_exhaustion_and_deny_spikes_once_per_cooldown(rig):
    client, _ = rig["build"](alert_webhook_url="https://hooks.invalid/relayguard", alert_deny_threshold=3)
    with client:
        item = issue(client, max_total_requests=1)
        assert client.get("/proxy/customers", headers=relay(item)).status_code == 200
        assert client.get("/proxy/customers", headers=relay(item)).status_code == 429
        assert client.get("/proxy/customers", headers=relay(item)).status_code == 429
        for _ in range(4):
            client.get("/proxy/exports", headers=relay(item))
        assert wait_for(lambda: {"lifetime_request_limit", "deny_spike"} <= {h["type"] for h in rig["hooks"]})
        time.sleep(0.1)
    types = [h["type"] for h in rig["hooks"]]
    assert types.count("lifetime_request_limit") == 1 and types.count("deny_spike") == 1
    spike = next(h for h in rig["hooks"] if h["type"] == "deny_spike")
    assert spike["credential_id"] == item["credential"]["id"] and spike["count"] == 3
    assert "text" in spike and spike["source"] == "relayguard"
    assert item["token"] not in json.dumps(rig["hooks"]) and UPSTREAM not in json.dumps(rig["hooks"])


def test_failed_admin_auth_alert(rig):
    client, _ = rig["build"](alert_webhook_url="https://hooks.invalid/relayguard")
    with client:
        assert client.get("/api/overview", headers=admin("bad-" + "z" * 40)).status_code == 401
        assert wait_for(lambda: rig["hooks"])
    assert rig["hooks"][0]["type"] == "admin_auth_failed" and rig["hooks"][0]["path"] == "/api/overview"


def test_budget_windows_are_pruned_without_losing_lifetime_usage(tmp_path):
    from relayguard.models import CredentialCreate, Policy, RouteRule

    store = Store(tmp_path / "prune.db")
    created = store.create_credential(CredentialCreate(name="Prune", policy=Policy(
        routes=[RouteRule(method="GET", path="/")])))
    identifier = created["credential"]["id"]
    start = int(time.time() // 60) * 60
    for minute in range(10):
        assert store.reserve_request(identifier, start + minute * 60) is None
    with store.connection() as conn:
        windows = [r[0] for r in conn.execute("SELECT window FROM budgets ORDER BY window")]
    assert windows == [start // 60 + 8, start // 60 + 9]
    assert store.find_credential(created["token"])["usage"]["total_requests"] == 10


def test_event_filters_use_expression_indexes(tmp_path):
    store = Store(tmp_path / "index.db")
    with store.connection() as conn:
        names = {row["name"] for row in conn.execute("PRAGMA index_list(events)")}
        plan = " ".join(row[3] for row in conn.execute(
            "EXPLAIN QUERY PLAN SELECT * FROM events WHERE json_extract(payload,'$.decision')=? ORDER BY id DESC LIMIT 5",
            ("deny",)))
    assert {"events_kind", "events_decision", "events_credential", "events_ts"} <= names
    assert "events_decision" in plan


@pytest.mark.parametrize("overrides,message", [
    ({"upstream_auth_header": "Host"}, "header"),
    ({"upstream_auth_header": "Bad Header"}, "header"),
    ({"upstream_auth_scheme": "Bearer token"}, "scheme"),
    ({"admin_token_next": ADMIN}, "next admin"),
    ({"admin_token_next": "short"}, "next admin"),
    ({"metrics_token": UPSTREAM}, "metrics"),
    ({"alert_webhook_url": "http://hooks.example.com/x"}, "HTTPS"),
    ({"alert_webhook_url": "https://user:pw@hooks.example.com/x"}, "credentials"),
    ({"alert_deny_threshold": 0}, "threshold"),
])
def test_new_settings_are_validated(tmp_path, overrides, message):
    with pytest.raises(ValueError, match=message):
        make_settings(tmp_path, **overrides)


def test_settings_from_environment(tmp_path, monkeypatch):
    for name, value in {
        "RELAYGUARD_UPSTREAM_URL": "https://upstream.invalid", "RELAYGUARD_UPSTREAM_TOKEN": UPSTREAM,
        "RELAYGUARD_ADMIN_TOKEN": ADMIN, "RELAYGUARD_ADMIN_TOKEN_NEXT": NEXT, "RELAYGUARD_METRICS_TOKEN": METRICS,
        "RELAYGUARD_UPSTREAM_AUTH_HEADER": "X-API-Key", "RELAYGUARD_UPSTREAM_AUTH_SCHEME": "none",
        "RELAYGUARD_ALERT_WEBHOOK_URL": "http://127.0.0.1:9000/hook", "RELAYGUARD_DB": str(tmp_path / "e.db"),
    }.items():
        monkeypatch.setenv(name, value)
    settings = Settings.from_env()
    assert settings.upstream_auth_value() == UPSTREAM
    assert settings.admin_tokens() == (ADMIN, NEXT)
    assert settings.metrics_token == METRICS
    assert settings.alert_webhook_url.endswith("/hook")
    assert "n" * 40 not in repr(settings) and "hook" not in repr(settings)
