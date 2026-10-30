import asyncio
from contextlib import asynccontextmanager
from pathlib import Path
import secrets
import sqlite3
import uuid
from typing import Literal

import httpx
from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool

from . import __version__
from .db import Store, timestamp
from .demo import run_scenarios
from .gateway import proxy_request
from .models import CredentialCreate
from .operations import storage_ready
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


def create_app(settings: Settings, *, upstream_transport=None):
    store = Store(settings.database_path)
    if not store.verify_audit()["valid"]:
        raise ValueError("Audit chain verification failed; preserve database and investigate")

    @asynccontextmanager
    async def lifespan(app):
        async with httpx.AsyncClient(timeout=settings.upstream_timeout_seconds, trust_env=False,
                                     follow_redirects=False, transport=upstream_transport,
                                     limits=httpx.Limits(max_connections=50, max_keepalive_connections=20)) as client:
            app.state.upstream_client = client
            yield

    app = FastAPI(title="RelayGuard", version=__version__, lifespan=lifespan,
                  docs_url=None, redoc_url=None, openapi_url=None, redirect_slashes=False)
    app.state.store, app.state.settings = store, settings
    app.state.demo_lock = asyncio.Lock()
    app.add_middleware(BoundaryMiddleware, max_bytes=settings.max_request_bytes, store=store)

    async def admin(request: Request):
        values = request.headers.getlist("authorization")
        expected = ("Bearer " + settings.admin_token).encode()
        if len(values) != 1 or not secrets.compare_digest(values[0].encode(), expected):
            raise HTTPException(401, "admin_auth_required")

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
        return {"demo_mode": settings.demo_mode, "upstream_origin": settings.upstream_url,
                "stats": store.stats(), "audit": store.verify_audit(), "recent_events": store.recent_events(20)}

    @app.get("/api/credentials", dependencies=protected)
    def credentials():
        return {"items": store.list_credentials()}

    @app.post("/api/credentials", status_code=201, dependencies=protected)
    def create_credential(data: CredentialCreate):
        return store.create_credential(data)

    @app.post("/api/credentials/{credential_id}/revoke", dependencies=protected)
    def revoke(credential_id: str):
        result = store.revoke(credential_id)
        if result is None:
            raise HTTPException(404, "credential_not_found")
        return result

    @app.get("/api/events", dependencies=protected)
    def events(limit: int = Query(default=100, ge=1, le=1000), decision: Literal["allow", "deny", "error"] | None = None):
        return {"items": store.recent_events(limit, decision)}

    @app.get("/api/audit/verify", dependencies=protected)
    def verify():
        return store.verify_audit()

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
        return await proxy_request(request, upstream_path, store, settings, app.state.upstream_client)

    return app
