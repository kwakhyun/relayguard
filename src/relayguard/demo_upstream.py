"""Loopback-only synthetic CRM; never contains real customer records."""
import secrets
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import PlainTextResponse, RedirectResponse


def create_demo_upstream(token: str):
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

    def authorize(authorization):
        if not secrets.compare_digest((authorization or "").encode(), ("Bearer " + token).encode()):
            raise HTTPException(401, "upstream_auth_required")

    @app.get("/customers")
    def customers(limit: int = 2, authorization: str | None = Header(default=None)):
        authorize(authorization)
        return {"items": [{"id": f"demo-{i:03}", "name": f"Synthetic customer {i}", "plan": "trial"}
                          for i in range(1, max(0, min(limit, 20)) + 1)], "synthetic": True}

    @app.get("/exports")
    @app.get("/bulk")
    def bulk(authorization: str | None = Header(default=None)):
        authorize(authorization)
        return {"items": [{"id": i, "note": "SYNTHETIC-DATA-" * 8} for i in range(100)]}

    @app.get("/payload")
    def payload(authorization: str | None = Header(default=None)):
        authorize(authorization)
        return PlainTextResponse("X" * 100)

    @app.get("/redirect")
    def redirect(authorization: str | None = Header(default=None)):
        authorize(authorization)
        return RedirectResponse("http://127.0.0.1:9/never-follow", status_code=302)

    return app
