import asyncio
from contextlib import asynccontextmanager
from pathlib import Path
import secrets
import sqlite3
import time
import uuid
from typing import Literal

import httpx
from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool

from . import __version__
from .alerts import AlertDispatcher
from .db import Store, timestamp
from .demo import run_scenarios
from .gateway import _peer_address, proxy_request
from .models import CredentialCreate, CredentialRotate, PolicyCheck
from .operations import storage_ready
from .policy_cli import decide
from .settings import Settings

STATIC = Path(__file__).parent / "static"
SECURITY_HEADERS = {
    "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "cache-control": "no-store",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
}


def error(status, code, message):
    return JSONResponse(status_code=status, content={"error": {"code": code, "message": message}})


class BoundaryMiddleware:
    """Bound inbound bodies before framework JSON parsing and add safe headers."""
    def __init__(self, app, max_bytes, store):
        self.app, self.max_bytes, self.store = app, max_bytes, store

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        is_proxy = scope.get("path", "").startswith("/proxy/")

        async def safe_send(message):
            if message["type"] == "http.response.start":
                replaced = {k.encode() for k in SECURITY_HEADERS}
                message["headers"] = [(k, v) for k, v in message.get("headers", []) if k.lower() not in replaced]
                headers = dict(SECURITY_HEADERS)
                if is_proxy:
                    headers["content-security-policy"] = "default-src 'none'; sandbox; frame-ancestors 'none'"
                message["headers"].extend((k.encode(), v.encode()) for k, v in headers.items())
            await send(message)

        if sum(len(k) + len(v) for k, v in scope.get("headers", [])) > 16384:
            status, code = 431, "headers_too_large"
            if is_proxy:
                try:
                    await run_in_threadpool(self.store.audit, kind="proxy", credential_id=None,
                                            decision="deny", reason=code, path="[unmatched]", status=status)
                except Exception:
                    status, code = 503, "audit_unavailable"
            response = error(status, code, "Request rejected.")
            response.headers["X-Request-ID"] = uuid.uuid4().hex
            return await response(scope, receive, safe_send)
        if is_proxy:
            # Gateway has its own streamed body limit, deadline, and audit path.
            return await self.app(scope, receive, safe_send)
        chunks, size = [], 0
        try:
            async with asyncio.timeout(10):
                while True:
                    message = await receive()
                    if message["type"] == "http.disconnect":
                        return
                    body = message.get("body", b"")
                    size += len(body)
                    if size > self.max_bytes:
                        return await error(413, "request_too_large", "Request body exceeds the limit.")(scope, receive, safe_send)
                    chunks.append(body)
                    if not message.get("more_body", False):
                        break
        except TimeoutError:
            return await error(408, "request_timeout", "Request body timed out.")(scope, receive, safe_send)
        first = True

        async def bounded_receive():
            nonlocal first
            if first:
                first = False
                return {"type": "http.request", "body": b"".join(chunks), "more_body": False}
            return await receive()

        await self.app(scope, bounded_receive, safe_send)


_UUID = r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"


def _label(value):
    return str(value).replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")


def render_metrics(data, *, audit, demo_mode, alerts=None):
    """Prometheus text exposition (version 0.0.4)."""
    lines = [
        "# HELP relayguard_build_info RelayGuard version and mode.",
        "# TYPE relayguard_build_info gauge",
        f'relayguard_build_info{{version="{_label(__version__)}",demo="{str(demo_mode).lower()}"}} 1',
        "# HELP relayguard_credentials Relay keys by lifecycle state.",
        "# TYPE relayguard_credentials gauge",
    ]
    for state in ("active", "expired", "revoked"):
        lines.append(f'relayguard_credentials{{state="{state}"}} {data["credentials"].get(state, 0)}')
    lines += ["# HELP relayguard_proxy_requests_total Audited proxy decisions by decision and reason.",
              "# TYPE relayguard_proxy_requests_total counter"]
    released = 0
    for row in data["proxy"]:
        lines.append(f'relayguard_proxy_requests_total{{decision="{_label(row["decision"])}",reason="{_label(row["reason"])}"}} {row["n"]}')
        if row["decision"] == "allow":
            released += row["bytes"]
    lines += ["# HELP relayguard_proxy_response_bytes_total Response bytes approved for release.",
              "# TYPE relayguard_proxy_response_bytes_total counter",
              f"relayguard_proxy_response_bytes_total {released}",
              "# HELP relayguard_admin_auth_failures_total Admin API requests with an invalid admin token.",
              "# TYPE relayguard_admin_auth_failures_total counter",
              f"relayguard_admin_auth_failures_total {data['admin_auth_failures']}",
              "# HELP relayguard_audit_events_total Audit events in the hash chain.",
              "# TYPE relayguard_audit_events_total counter",
              f"relayguard_audit_events_total {data['events']}",
              "# HELP relayguard_audit_chain_valid 1 when the incremental chain check passed.",
              "# TYPE relayguard_audit_chain_valid gauge",
              f"relayguard_audit_chain_valid {1 if audit.get('valid') else 0}"]
    if alerts is not None:
        lines += ["# HELP relayguard_alerts_total Webhook alerts handled by this process.",
                  "# TYPE relayguard_alerts_total counter",
                  f'relayguard_alerts_total{{result="sent"}} {alerts.sent}',
                  f'relayguard_alerts_total{{result="failed"}} {alerts.failed}',
                  f'relayguard_alerts_total{{result="dropped"}} {alerts.dropped}']
    return "\n".join(lines) + "\n"


def create_app(settings: Settings, *, upstream_transport=None, alert_transport=None):
    store = Store(settings.database_path)
    if not store.verify_audit()["valid"]:
        raise ValueError("Audit chain verification failed; preserve database and investigate")
    alerts = (AlertDispatcher(settings.alert_webhook_url, deny_threshold=settings.alert_deny_threshold,
                              cooldown_seconds=settings.alert_cooldown_seconds, transport=alert_transport)
              if settings.alert_webhook_url else None)

    @asynccontextmanager
    async def lifespan(app):
        if alerts is not None:
            await alerts.start()
        try:
            async with httpx.AsyncClient(timeout=settings.upstream_timeout_seconds, trust_env=False,
                                         follow_redirects=False, transport=upstream_transport,
                                         limits=httpx.Limits(max_connections=50, max_keepalive_connections=20)) as client:
                app.state.upstream_client = client
                yield
        finally:
            if alerts is not None:
                await alerts.stop()

    app = FastAPI(title="RelayGuard", version=__version__, lifespan=lifespan,
                  docs_url=None, redoc_url=None, openapi_url=None, redirect_slashes=False)
    app.state.store, app.state.settings, app.state.alerts = store, settings, alerts
    app.state.demo_lock = asyncio.Lock()
    app.add_middleware(BoundaryMiddleware, max_bytes=settings.max_request_bytes, store=store)

    def bearer_matches(request, tokens):
        values = request.headers.getlist("authorization")
        if len(values) != 1:
            return False
        supplied = values[0].encode()
        # Compare against every accepted secret so timing does not reveal which one matched.
        results = [secrets.compare_digest(supplied, ("Bearer " + token).encode()) for token in tokens]
        return any(results)

    async def reject_admin(request):
        route = request.scope.get("route")
        address = _peer_address(request.client.host if request.client else None)
        try:
            # The same unauthenticated audit path exists for /proxy; a failed
            # write must not turn a rejected request into a different answer.
            await run_in_threadpool(store.audit, kind="admin_auth", credential_id=None, decision="deny",
                                    reason="admin_auth_failed", method=request.method,
                                    path=getattr(route, "path", "[unmatched]"), status=401,
                                    peer_ip=str(address) if address is not None else None)
        except Exception:
            pass
        if alerts is not None:
            alerts.observe(reason="admin_auth_failed", decision="deny", path=getattr(route, "path", None),
                           method=request.method)
        raise HTTPException(401, "admin_auth_required")

    async def admin(request: Request):
        if not bearer_matches(request, settings.admin_tokens()):
            await reject_admin(request)

    async def metrics_reader(request: Request):
        tokens = settings.admin_tokens() + ((settings.metrics_token,) if settings.metrics_token else ())
        if not bearer_matches(request, tokens):
            await reject_admin(request)

    protected = [Depends(admin)]

    @app.exception_handler(HTTPException)
    async def http_error(request, exc):
        return error(exc.status_code, str(exc.detail), "Request rejected.")

    @app.exception_handler(RequestValidationError)
    async def validation_error(request, exc):
        return JSONResponse(status_code=422, content={"error": {"code": "validation_error", "message": "Check request fields."},
            "fields": [{"field": ".".join(str(x) for x in e["loc"]), "message": e["msg"]} for e in exc.errors()]})

    @app.exception_handler(sqlite3.Error)
    async def storage_error(request, exc):
        return error(503, "storage_unavailable", "Storage is unavailable; request was not completed.")

    @app.get("/healthz")
    async def health():
        return {"status": "ok", "service": "relayguard", "demo_mode": settings.demo_mode}

    @app.get("/readyz")
    def ready():
        if not storage_ready(settings.database_path):
            return error(503, "storage_not_ready", "Storage is not ready.")
        return {"status": "ready", "service": "relayguard"}

    @app.get("/")
    async def index():
        return FileResponse(STATIC / "index.html")

    app.mount("/static", StaticFiles(directory=STATIC), name="static")

    @app.get("/api/overview", dependencies=protected)
    def overview():
        # Full-chain hashing stays on the explicit verify endpoint; the overview
        # checks this process's verified head and hashes only newer events.
        return {"demo_mode": settings.demo_mode, "version": __version__, "upstream_origin": settings.upstream_url,
                "upstream_auth": {"header": settings.upstream_auth_header, "scheme": settings.upstream_auth_scheme or None},
                "alerts": {"enabled": alerts is not None}, "admin_token_rotation": bool(settings.admin_token_next),
                "stats": store.stats(), "audit": store.verify_audit(incremental=True), "recent_events": store.recent_events(20)}

    @app.get("/api/credentials", dependencies=protected)
    def credentials():
        return {"items": store.list_credentials()}

    @app.post("/api/credentials", status_code=201, dependencies=protected)
    def create_credential(data: CredentialCreate):
        return store.create_credential(data)

    @app.post("/api/credentials/{credential_id}/rotate", status_code=201, dependencies=protected)
    def rotate(credential_id: str, data: CredentialRotate):
        result = store.rotate_credential(credential_id, data.credential, data.grace_hours)
        if result is None:
            raise HTTPException(404, "credential_not_found")
        if result == "credential_inactive":
            raise HTTPException(409, "credential_inactive")
        return result

    @app.post("/api/policy/check", dependencies=protected)
    def policy_check(data: PolicyCheck):
        results = []
        for case in data.cases:
            code, rule = decide(data.policy, case.method, case.path, case.peer_ip)
            results.append({
                "method": case.method, "path": case.path, "peer_ip": case.peer_ip,
                "decision": "allow" if code == "allowed" else "deny", "code": code,
                "matched_route": {"method": rule.method, "path": rule.path} if rule else None,
                "ip_checked": case.peer_ip is not None or not data.policy.ip_allowlist,
            })
        return {"scope": "static_request_policy", "results": results}

    @app.post("/api/credentials/{credential_id}/revoke", dependencies=protected)
    def revoke(credential_id: str):
        result = store.revoke(credential_id)
        if result is None:
            raise HTTPException(404, "credential_not_found")
        return result

    @app.get("/api/events", dependencies=protected)
    def events(limit: int = Query(default=100, ge=1, le=1000),
               decision: Literal["allow", "deny", "error"] | None = None,
               kind: Literal["proxy", "admin"] | None = None,
               credential_id: str | None = Query(default=None, pattern=_UUID),
               before_id: int | None = Query(default=None, ge=1),
               since_hours: int | None = Query(default=None, ge=1, le=8760)):
        since = timestamp(time.time() - since_hours * 3600) if since_hours else None
        items = store.recent_events(limit, decision, kind=kind, credential_id=credential_id,
                                    before_id=before_id, since=since)
        return {"items": items, "next_before_id": items[-1]["id"] if len(items) == limit else None}

    @app.get("/api/audit/verify", dependencies=protected)
    def verify():
        return store.verify_audit()

    @app.get("/metrics", dependencies=[Depends(metrics_reader)])
    def metrics():
        body = render_metrics(store.metrics(), audit=store.verify_audit(incremental=True),
                              demo_mode=settings.demo_mode, alerts=alerts)
        return Response(body, media_type="text/plain; version=0.0.4; charset=utf-8")

    @app.get("/api/audit/export", dependencies=protected)
    def export():
        return JSONResponse({"exported_at": timestamp(), **store.export_audit()},
                            headers={"Content-Disposition": 'attachment; filename="relayguard-audit.json"'})

    @app.post("/api/demo/run", dependencies=protected)
    async def demo():
        if not settings.demo_mode:
            raise HTTPException(404, "not_found")
        if app.state.demo_lock.locked():
            raise HTTPException(409, "demo_already_running")
        async with app.state.demo_lock:
            try:
                return await run_scenarios(store, settings.demo_gateway_url)
            except httpx.HTTPError:
                return error(502, "demo_unavailable", "Local demo services could not be reached.")

    @app.api_route("/proxy/{upstream_path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"])
    async def proxy(request: Request, upstream_path: str):
        return await proxy_request(request, upstream_path, store, settings, app.state.upstream_client, alerts)

    return app
