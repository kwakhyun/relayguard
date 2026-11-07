"""Best-effort operator alerts sent to one configured webhook.

Alerts never block or change a gateway decision.  Delivery runs on a bounded
in-process queue; a full queue, a slow receiver or a failed POST drops the
alert.  Payloads carry the same safe metadata as audit events: no relay key,
upstream token, query value, request body or response body.
"""
from __future__ import annotations

import asyncio
from collections import deque
import time

import httpx

from . import __version__
from .db import timestamp

# Reasons worth an immediate alert, independent of any deny-rate spike.
IMMEDIATE = {
    "lifetime_request_limit": "A relay key reached its lifetime request limit.",
    "lifetime_byte_budget": "A relay key reached its lifetime response byte budget.",
    "token_revoked": "A revoked relay key was used.",
    "admin_auth_failed": "An admin API request used an invalid admin token.",
    "storage_unavailable": "Storage was unavailable; requests were rejected.",
    "audit_unavailable": "Audit writes failed; responses were withheld.",
}
SPIKE_WINDOW_SECONDS = 60


class AlertDispatcher:
    def __init__(self, url: str, *, deny_threshold: int = 20, cooldown_seconds: int = 600,
                 transport: httpx.AsyncBaseTransport | None = None, clock=time.monotonic, queue_size: int = 100):
        self.url = url
        self.deny_threshold = deny_threshold
        self.cooldown_seconds = cooldown_seconds
        self.transport = transport
        self.clock = clock
        self.queue: asyncio.Queue | None = None
        self.queue_size = queue_size
        self._denies: dict[str | None, deque] = {}
        self._last_sent: dict[tuple, float] = {}
        self._worker: asyncio.Task | None = None
        self._client: httpx.AsyncClient | None = None
        self.dropped = 0
        self.sent = 0
        self.failed = 0

    async def start(self):
        self.queue = asyncio.Queue(maxsize=self.queue_size)
        self._client = httpx.AsyncClient(timeout=3.0, trust_env=False, follow_redirects=False,
                                         transport=self.transport)
        self._worker = asyncio.create_task(self._run())

    async def stop(self):
        if self._worker is not None:
            # Give already queued alerts a short chance to leave.
            try:
                await asyncio.wait_for(self.queue.join(), timeout=2)
            except (TimeoutError, asyncio.TimeoutError):
                pass
            self._worker.cancel()
            try:
                await self._worker
            except BaseException:
                pass
        if self._client is not None:
            await self._client.aclose()

    def observe(self, *, reason: str, decision: str, credential_id: str | None = None,
                path: str | None = None, method: str | None = None, request_id: str | None = None):
        """Record one decision.  Never raises into the request path."""
        try:
            now = self.clock()
            if reason in IMMEDIATE:
                self._emit(reason, reason, credential_id, now, path=path, method=method, request_id=request_id)
            if decision == "deny":
                window = self._denies.setdefault(credential_id, deque())
                window.append(now)
                while window and window[0] <= now - SPIKE_WINDOW_SECONDS:
                    window.popleft()
                if len(window) >= self.deny_threshold:
                    self._emit("deny_spike", reason, credential_id, now, count=len(window), path=path,
                               method=method, request_id=request_id)
                if len(self._denies) > 10000:
                    # Bound memory under a flood of distinct unauthenticated keys.
                    self._denies.clear()
        except Exception:
            pass

    def _emit(self, alert_type, reason, credential_id, now, **details):
        key = (alert_type, credential_id)
        last = self._last_sent.get(key)
        if last is not None and now - last < self.cooldown_seconds:
            return
        if self.queue is None:
            return
        self._last_sent[key] = now
        if len(self._last_sent) > 10000:
            self._last_sent.clear()
        message = (f"{self.deny_threshold}+ denied requests within {SPIKE_WINDOW_SECONDS}s for one relay key."
                   if alert_type == "deny_spike" else IMMEDIATE[alert_type])
        payload = {
            "source": "relayguard", "version": __version__, "type": alert_type, "reason": reason,
            "message": message, "credential_id": credential_id, "ts": timestamp(),
            **{k: v for k, v in details.items() if v is not None},
        }
        if alert_type == "deny_spike":
            payload["window_seconds"] = SPIKE_WINDOW_SECONDS
        # Slack/Mattermost-compatible summary line; other receivers use the fields.
        payload["text"] = f"RelayGuard alert: {message} (reason: {reason})"
        try:
            self.queue.put_nowait(payload)
        except asyncio.QueueFull:
            self.dropped += 1

    async def _run(self):
        while True:
            payload = await self.queue.get()
            try:
                response = await self._client.post(self.url, json=payload)
                if 200 <= response.status_code < 300:
                    self.sent += 1
                else:
                    self.failed += 1
            except Exception:
                self.failed += 1
            finally:
                self.queue.task_done()
