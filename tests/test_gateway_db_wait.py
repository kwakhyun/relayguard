"""A SQLite writer wait must not freeze unrelated ASGI requests."""

import asyncio
import threading
import time

import httpx

from relayguard.app import create_app
from relayguard.models import CredentialCreate, Policy, RouteRule
from relayguard.settings import Settings


def test_sqlite_writer_lock_does_not_block_health_or_event_loop(tmp_path):
    async def scenario():
        settings = Settings(upstream_url="https://synthetic.invalid", upstream_token="synthetic-upstream",
                            admin_token="synthetic-admin-" + "a" * 32, database_path=str(tmp_path / "db.sqlite"))
        upstream_calls = []

        async def upstream(request):
            upstream_calls.append(request)
            return httpx.Response(200, json={"ok": True})

        app = create_app(settings, upstream_transport=httpx.MockTransport(upstream))
        store = app.state.store
        created = store.create_credential(CredentialCreate(name="Synthetic lock test", policy=Policy(
            routes=[RouteRule(method="GET", path="/items")], max_total_requests=1)))
        locked, release = threading.Event(), threading.Event()

        def hold_writer():
            with store.connection(write=True):
                locked.set()
                release.wait(timeout=3)

        async with app.router.lifespan_context(app):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://local.test") as client:
                holder = threading.Thread(target=hold_writer)
                holder.start()
                assert await asyncio.to_thread(locked.wait, 1)
                request_task = asyncio.create_task(client.get("/proxy/items", headers={
                    "Authorization": "Bearer " + created["token"]}))
                try:
                    start = time.monotonic()
                    await asyncio.sleep(0.03)
                    assert time.monotonic() - start < 0.5, "SQLite blocked the ASGI event loop"
                    assert not request_task.done()
                    health = await asyncio.wait_for(client.get("/healthz"), timeout=0.5)
                    assert health.status_code == 200
                    assert not upstream_calls
                finally:
                    release.set()
                    await asyncio.to_thread(holder.join, 1)
                response = await asyncio.wait_for(request_task, timeout=2)
                assert response.status_code == 200
                assert len(upstream_calls) == 1
                assert store.find_credential(created["token"])["usage"]["total_requests"] == 1

    asyncio.run(scenario())


def test_slow_audit_does_not_turn_upstream_rejection_into_cancellation(tmp_path, monkeypatch):
    async def scenario():
        settings = Settings(upstream_url="https://synthetic.invalid", upstream_token="synthetic-upstream",
                            admin_token="synthetic-admin-" + "a" * 32, database_path=str(tmp_path / "db.sqlite"),
                            upstream_timeout_seconds=0.1)

        async def upstream(request):
            return httpx.Response(302, headers={"Location": "https://never-contact.invalid"})

        app = create_app(settings, upstream_transport=httpx.MockTransport(upstream))
        store = app.state.store
        created = store.create_credential(CredentialCreate(name="Synthetic audit test", policy=Policy(
            routes=[RouteRule(method="GET", path="/items")])))
        original_audit = store.audit

        def slow_audit(**event):
            time.sleep(0.15)
            return original_audit(**event)

        monkeypatch.setattr(store, "audit", slow_audit)
        async with app.router.lifespan_context(app):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://local.test") as client:
                response = await client.get("/proxy/items", headers={"Authorization": "Bearer " + created["token"]})
        assert response.status_code == 502
        assert response.json()["error"]["code"] == "upstream_redirect"
        proxy_events = [event for event in store.all_events() if event["kind"] == "proxy"]
        assert [event["reason"] for event in proxy_events] == ["upstream_redirect"]

    asyncio.run(scenario())
