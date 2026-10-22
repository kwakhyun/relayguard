"""Cancellation must retain audit evidence without swallowing cancellation."""

import asyncio
import sqlite3

import httpx
import pytest
from starlette.requests import Request

from relayguard.gateway import proxy_request
from relayguard.settings import Settings


class RecordingStore:
    def __init__(self, fail_audit=False):
        self.events = []
        self.fail_audit = fail_audit
        self.reservations = 0
        self.byte_charges = 0
        self.audit_attempts = 0

    def find_credential(self, token):
        return {"id": "synthetic-id", "policy": {
            "routes": [{"method": "POST", "path": "/customers/*"}],
        }}

    def reserve_request(self, credential_id, now):
        self.reservations += 1
        return None

    def spend_bytes(self, credential_id, amount, now):
        self.byte_charges += 1
        return None

    def audit(self, **event):
        self.audit_attempts += 1
        if self.fail_audit:
            raise sqlite3.OperationalError("private storage diagnostic")
        self.events.append(event)


def request(receive):
    return Request({
        "type": "http", "method": "POST", "path": "/proxy/customers/private-id",
        "raw_path": b"/proxy/customers/private-id", "query_string": b"",
        "client": ("192.0.2.1", 1234),
        "headers": [(b"authorization", b"Bearer rg_abcdefghijklmnopqrstuvwxyz012345"),
                    (b"content-type", b"application/json")],
    }, receive)


def settings():
    return Settings(upstream_url="https://synthetic.invalid", upstream_token="synthetic-upstream",
                    admin_token="synthetic-admin-" + "x" * 32)


def assert_cancellation_record(store):
    assert store.reservations == 1
    assert store.byte_charges == 0
    assert store.audit_attempts == 1
    if store.fail_audit:
        assert not store.events
    else:
        assert store.events == [{
            "kind": "proxy", "credential_id": "synthetic-id", "decision": "error",
            "reason": "request_cancelled", "method": "POST", "path": "/customers/*",
            "status": None, "response_bytes": 0, "peer_ip": "192.0.2.1",
        }]


@pytest.mark.parametrize("fail_audit", [False, True])
def test_cancelled_request_body_is_audited_and_reraised(fail_audit):
    async def scenario():
        entered = asyncio.Event()
        store = RecordingStore(fail_audit)
        upstream_calls = []

        async def receive():
            entered.set()
            await asyncio.Event().wait()

        async def upstream(req):
            upstream_calls.append(req)
            return httpx.Response(200, json={"ok": True})

        async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client:
            task = asyncio.create_task(proxy_request(request(receive), "customers/private-id", store, settings(), client))
            await asyncio.wait_for(entered.wait(), 1)
            task.cancel("original cancellation")
            with pytest.raises(asyncio.CancelledError, match="original cancellation"):
                await task
        assert not upstream_calls
        assert_cancellation_record(store)

    asyncio.run(scenario())


@pytest.mark.parametrize("fail_audit", [False, True])
@pytest.mark.parametrize("stage,cleanup_error", [("headers", False), ("body", False), ("body", True)])
def test_cancelled_upstream_is_audited_closed_and_reraised(stage, cleanup_error, fail_audit):
    async def scenario():
        entered = asyncio.Event()
        store = RecordingStore(fail_audit)
        upstream_calls = []
        closed = []

        async def receive():
            return {"type": "http.request", "body": b"{}", "more_body": False}

        class WaitingStream(httpx.AsyncByteStream):
            async def __aiter__(self):
                yield b'{"private":"withheld'
                entered.set()
                await asyncio.Event().wait()

            async def aclose(self):
                closed.append(True)
                if cleanup_error:
                    raise OSError("private transport diagnostic")

        async def upstream(req):
            upstream_calls.append(req)
            if stage == "headers":
                entered.set()
                await asyncio.Event().wait()
            return httpx.Response(200, headers={"content-type": "application/json"}, stream=WaitingStream())

        async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client:
            task = asyncio.create_task(proxy_request(request(receive), "customers/private-id", store, settings(), client))
            await asyncio.wait_for(entered.wait(), 1)
            task.cancel("original cancellation")
            with pytest.raises(asyncio.CancelledError, match="original cancellation"):
                await task
        assert len(upstream_calls) == 1
        if stage == "body":
            assert closed == [True]
        assert_cancellation_record(store)

    asyncio.run(scenario())
