import asyncio
from contextlib import contextmanager
import json
import sqlite3
import time

import httpx
import pytest
from fastapi.testclient import TestClient

from relayguard.app import create_app
from relayguard.settings import Settings

ADMIN = "admin-test-" + "a" * 40
UPSTREAM = "upstream-test-" + "b" * 40


class Stream(httpx.AsyncByteStream):
    def __init__(self, chunks):
        self.chunks = chunks

    async def __aiter__(self):
        for chunk in self.chunks:
            yield chunk


@pytest.fixture
def rig(tmp_path):
    seen = []
    state = {}

    async def handler(request):
        seen.append(request)
        if state.get("callback"):
            return await state["callback"](request)
        headers = {"content-type": "application/json", "set-cookie": "session=SECRET; Path=/", "x-internal": "private"}
        return httpx.Response(200, headers=headers, stream=Stream([b'{"ok":true}']))

    settings = Settings(upstream_url="https://upstream.invalid", upstream_token=UPSTREAM,
                        admin_token=ADMIN, database_path=str(tmp_path / "state.db"))
    app = create_app(settings, upstream_transport=httpx.MockTransport(handler))
    with TestClient(app, client=("198.51.100.8", 12345)) as client:
        yield {"app": app, "client": client, "seen": seen, "state": state, "settings": settings}


def issue(rig, paths=("/customers",), **limits):
    policy = {"routes": [{"method": "GET", "path": p, "query_keys": ["limit"]} for p in paths], **limits}
    response = rig["client"].post("/api/credentials", headers={"Authorization": "Bearer " + ADMIN},
                                  json={"name": "Synthetic test integration", "ttl_hours": 1, "policy": policy})
    assert response.status_code == 201, response.text
    return response.json()


def auth(item):
    return {"Authorization": "Bearer " + item["token"]}


def test_admin_required_and_one_time_secret(rig):
    client = rig["client"]
    assert client.get("/api/credentials").status_code == 401
    assert client.get("/api/overview", headers={"Authorization": "Bearer " + UPSTREAM}).status_code == 401
    item = issue(rig)
    response = client.get("/api/credentials", headers={"Authorization": "Bearer " + ADMIN})
    assert response.status_code == 200
    assert item["token"] not in response.text
    assert "secret_hash" not in response.text
    assert client.get("/api/credentials", headers=auth(item)).status_code == 401
    assert client.get("/proxy/customers", headers={"Authorization": "Bearer " + ADMIN}).status_code == 401
    assert client.get("/proxy/customers", headers={"Authorization": "Bearer " + UPSTREAM}).status_code == 401


def test_success_isolated_headers_query_cookies_and_audit(rig):
    item = issue(rig)
    relay_headers = {**auth(item), "Cookie": "evil=cookie", "X-Forwarded-For": "10.1.1.1", "X-Api-Key": "NEVER_FORWARD"}
    for _ in range(2):
        response = rig["client"].get("/proxy/customers?limit=2", headers=relay_headers)
        assert response.status_code == 200
        assert "set-cookie" not in response.headers and "x-internal" not in response.headers
    for request in rig["seen"]:
        assert request.headers["authorization"] == "Bearer " + UPSTREAM
        assert "cookie" not in request.headers
        assert "x-forwarded-for" not in request.headers
        assert "x-api-key" not in request.headers
        assert request.headers["accept-encoding"] == "identity"
        assert str(request.url) == "https://upstream.invalid/customers?limit=2"
    audit = rig["app"].state.store.export_audit()
    text = json.dumps(audit)
    assert item["token"] not in text and UPSTREAM not in text and "limit=2" not in text
    assert audit["verification"]["valid"]
    assert audit["events"][-1]["peer_ip"] == "198.51.100.8"
    assert audit["events"][-1]["response_bytes"] == len(response.content)


def test_client_defaults_do_not_leak(rig):
    client = rig["app"].state.upstream_client
    client.headers["X-Default-Secret"] = "never"
    client.params = {"injected": "never"}
    client.cookies.set("default-secret", "never", domain="upstream.invalid")
    client.auth = httpx.BasicAuth("never", "never")
    item = issue(rig)
    assert rig["client"].get("/proxy/customers", headers=auth(item)).status_code == 200
    request = rig["seen"][-1]
    assert "x-default-secret" not in request.headers
    assert "cookie" not in request.headers
    assert not request.url.query
    assert request.headers["authorization"] == "Bearer " + UPSTREAM


@pytest.mark.parametrize("method,path", [("GET", "/proxy/exports"), ("POST", "/proxy/customers"),
    ("GET", "/proxy/customers?debug=true"), ("GET", "/proxy/customers?limit=1&limit=2"),
    ("GET", "/proxy/customers?%6cimit=2"), ("GET", "/proxy/customers?limit=%00"),
    ("GET", "/proxy/customers/%2e%2e/exports"), ("GET", "/proxy/customers%2fexports"),
    ("GET", "/proxy//customers"), ("GET", "/proxy/customers/"), ("HEAD", "/proxy/customers")])
def test_denies_before_upstream(rig, method, path):
    item = issue(rig)
    response = rig["client"].request(method, path, headers=auth(item))
    assert response.status_code == 403
    assert not rig["seen"]


def test_wildcard_one_segment_and_template_logging(rig):
    item = issue(rig, paths=("/customers/*",))
    assert rig["client"].get("/proxy/customers/private-identifier", headers=auth(item)).status_code == 200
    assert rig["client"].get("/proxy/customers/id/exports", headers=auth(item)).status_code == 403
    assert "private-identifier" not in json.dumps(rig["app"].state.store.all_events())
    assert rig["app"].state.store.all_events()[-2]["path"] == "/customers/*"


def test_ip_cannot_be_spoofed(rig):
    item = issue(rig, ip_allowlist=["10.0.0.0/8"])
    response = rig["client"].get("/proxy/customers", headers={**auth(item), "X-Forwarded-For": "10.0.0.1"})
    assert response.status_code == 403 and response.json()["error"]["code"] == "ip_denied"
    assert not rig["seen"]


def test_rate_limit_and_revoke(rig):
    item = issue(rig, requests_per_minute=1)
    assert rig["client"].get("/proxy/customers", headers=auth(item)).status_code == 200
    assert rig["client"].get("/proxy/customers", headers=auth(item)).status_code == 429
    response = rig["client"].post(f'/api/credentials/{item["credential"]["id"]}/revoke', headers={"Authorization": "Bearer " + ADMIN})
    assert response.status_code == 200
    assert rig["client"].get("/proxy/customers", headers=auth(item)).status_code == 401
    assert len(rig["seen"]) == 1


def test_byte_budget_withholds_entire_response(rig):
    async def handler(request):
        return httpx.Response(200, headers={"content-type": "text/plain"}, stream=Stream([b"S" * 100]))
    rig["state"]["callback"] = handler
    item = issue(rig, response_bytes_limit=128, bytes_per_minute=128)
    assert rig["client"].get("/proxy/customers", headers=auth(item)).status_code == 200
    response = rig["client"].get("/proxy/customers", headers=auth(item))
    assert response.status_code == 429 and b"SSSS" not in response.content
    assert rig["app"].state.store.stats()["bytes_forwarded"] == 100


@pytest.mark.parametrize("status,headers,chunks,code", [
    (302, {"location": "https://evil.invalid", "content-type": "text/plain"}, [b"secret"], "upstream_redirect"),
    (200, {"content-type": "text/html"}, [b"<script>secret</script>"], "upstream_content_type"),
    (200, {"content-type": "text/plain", "content-encoding": "gzip"}, [b"secret"], "upstream_encoding"),
    (500, {"content-type": "text/plain"}, [b"private upstream trace"], "upstream_rejected"),
])
def test_upstream_failure_bodies_not_exposed(rig, status, headers, chunks, code):
    async def handler(request):
        return httpx.Response(status, headers=headers, stream=Stream(chunks))
    rig["state"]["callback"] = handler
    item = issue(rig)
    response = rig["client"].get("/proxy/customers", headers=auth(item))
    assert response.status_code == 502
    assert response.json()["error"]["code"] == code
    assert b"secret" not in response.content and b"private upstream trace" not in response.content
    assert len(rig["seen"]) == 1


def test_chunked_oversized_response_is_withheld(rig):
    async def handler(request):
        return httpx.Response(200, headers={"content-type": "text/plain"}, stream=Stream([b"A" * 100, b"B" * 100]))
    rig["state"]["callback"] = handler
    item = issue(rig, response_bytes_limit=128)
    response = rig["client"].get("/proxy/customers", headers=auth(item))
    assert response.status_code == 413
    assert b"AAAA" not in response.content
    assert rig["app"].state.store.stats()["bytes_forwarded"] == 0


def test_revoked_during_upstream_withholds_response(rig):
    item = issue(rig)
    async def handler(request):
        rig["app"].state.store.revoke(item["credential"]["id"])
        return httpx.Response(200, headers={"content-type": "text/plain"}, stream=Stream([b"SECRET-DATA"]))
    rig["state"]["callback"] = handler
    response = rig["client"].get("/proxy/customers", headers=auth(item))
    assert response.status_code == 401 and b"SECRET-DATA" not in response.content


def test_audit_failure_fails_closed(rig, monkeypatch):
    item = issue(rig)
    def fail(**kwargs):
        raise sqlite3.OperationalError("private database path")
    monkeypatch.setattr(rig["app"].state.store, "audit", fail)
    response = rig["client"].get("/proxy/customers", headers=auth(item))
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "audit_unavailable"
    assert b'"ok"' not in response.content and "private database" not in response.text


def test_request_limit_before_json_parse(rig):
    response = rig["client"].post("/api/credentials", headers={"Authorization": "Bearer " + ADMIN, "content-type": "application/json"}, content=b"x" * 65537)
    assert response.status_code == 413
    assert not rig["seen"]


def test_security_headers_and_export(rig):
    client = rig["client"]
    issue(rig)
    response = client.get("/api/audit/export", headers={"Authorization": "Bearer " + ADMIN})
    data = response.json()
    assert data["verification"]["valid"]
    assert len(data["events"]) == data["verification"]["event_count"]
    assert "attachment" in response.headers["content-disposition"]
    assert response.headers["cache-control"] == "no-store"
    assert "frame-ancestors 'none'" in response.headers["content-security-policy"]
    assert client.post("/api/demo/run", headers={"Authorization": "Bearer " + ADMIN}).status_code == 404
    assert client.get("/healthz").json()["demo_mode"] is False


@pytest.mark.parametrize("url", ["https://upstream.invalid?", "https://upstream.invalid#",
    "https://upstream.invalid\\other", "https://upstream.invalid\n", " https://upstream.invalid",
    "https://upstream.invalid:0", "https://up_stream.invalid", "https://%75pstream.invalid"])
def test_origin_aliases_rejected(tmp_path, url):
    with pytest.raises(ValueError):
        Settings(upstream_url=url, upstream_token=UPSTREAM, admin_token=ADMIN,
                 database_path=str(tmp_path / "state.db"))


def test_proxy_body_limit_is_audited(rig):
    item = issue(rig)
    response = rig["client"].request("GET", "/proxy/customers", headers={**auth(item), "Content-Type": "text/plain"}, content=b"X" * 65537)
    assert response.status_code == 413
    event = rig["app"].state.store.all_events()[-1]
    assert event["kind"] == "proxy" and event["reason"] == "request_too_large"
    assert response.headers["x-request-id"]
    assert not rig["seen"]


def test_upstream_total_deadline(rig):
    object.__setattr__(rig["settings"], "upstream_timeout_seconds", 0.1)
    async def handler(request):
        await asyncio.sleep(0.3)
        return httpx.Response(200, headers={"content-type": "text/plain"}, stream=Stream([b"SHOULD-NOT-RELEASE"]))
    rig["state"]["callback"] = handler
    item = issue(rig)
    started = time.monotonic()
    response = rig["client"].get("/proxy/customers", headers=auth(item))
    assert response.status_code == 502 and response.json()["error"]["code"] == "upstream_timeout"
    assert time.monotonic() - started < 1
    assert b"SHOULD-NOT-RELEASE" not in response.content
