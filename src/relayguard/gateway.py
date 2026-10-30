"""A fail-closed relay for one configured origin and explicit capability grants.

No request URL, query value, credential, response header or exception text is
ever copied into an audit event.  Only the selected policy template is logged.
"""

from __future__ import annotations

import asyncio
import ipaddress
import re
import unicodedata
import uuid
from collections.abc import Sequence
from contextlib import asynccontextmanager
from urllib.parse import parse_qsl

import httpx
from fastapi import Request
from starlette.requests import ClientDisconnect
from starlette.responses import JSONResponse, Response

from .db import Store
from .models import Policy, RouteRule
from .settings import Settings


_SEGMENT = re.compile(r"[A-Za-z0-9._~-]+\Z")
_QUERY_KEY = re.compile(r"[A-Za-z][A-Za-z0-9_]{0,63}\Z")
_BEARER = re.compile(r"(?i:Bearer) ([A-Za-z0-9_-]{20,256})\Z")
_METHODS = frozenset({"GET", "POST", "PUT", "PATCH", "DELETE"})
_JSON_MEDIA = re.compile(r"application/(?:json|[a-z0-9][a-z0-9.+-]*\+json)\Z")
_ACCEPT_ITEM = re.compile(
    r"(?:application/json|application/\*\+json|text/plain|\*/\*)"
    r"(?:\s*;\s*q=(?:0(?:\.[0-9]{1,3})?|1(?:\.0{1,3})?))?\Z"
)
_ERROR_MESSAGES = {
    "invalid_token": "A valid relay credential is required.",
    "token_revoked": "This relay credential is inactive.",
    "token_expired": "This relay credential is inactive.",
    "invalid_path": "The request path is not permitted.",
    "route_denied": "The method and path are not permitted.",
    "query_denied": "The query is not permitted.",
    "ip_denied": "The connection address is not permitted.",
    "invalid_headers": "The request headers are not permitted.",
    "request_too_large": "The request exceeds the allowed size.",
    "invalid_request": "The request could not be read.",
    "request_timeout": "The request body deadline was exceeded.",
    "rate_limit": "The request budget is exhausted for this minute.",
    "byte_budget": "The response byte budget is exhausted for this minute.",
    "lifetime_request_limit": "The lifetime request budget for this relay credential is exhausted.",
    "lifetime_byte_budget": "The lifetime response byte budget for this relay credential is exhausted.",
    "response_too_large": "The upstream response exceeds the allowed size.",
    "upstream_redirect": "The upstream response is not permitted.",
    "upstream_encoding": "The upstream response is not permitted.",
    "upstream_content_type": "The upstream response is not permitted.",
    "upstream_invalid_response": "The upstream response is not permitted.",
    "upstream_rejected": "The upstream service rejected the request.",
    "upstream_timeout": "The upstream service deadline was exceeded.",
    "upstream_unavailable": "The upstream service is unavailable.",
    "storage_unavailable": "The relay is temporarily unavailable.",
    "audit_unavailable": "The relay is temporarily unavailable.",
}


class _ProxyRejection(Exception):
    """Defer audit I/O until the body/upstream timeout context has exited."""

    def __init__(self, status: int, reason: str, *, decision: str = "deny"):
        self.status = status
        self.reason = reason
        self.decision = decision


def canonical_path(raw_path: bytes, upstream_path: str) -> str | None:
    """Reject normalization aliases before httpx or the upstream can see them.

    ASGI's decoded ``path`` is insufficient: %2f, %2e and double decoding can
    disagree across routers.  The raw bytes must match this single spelling.
    """
    path = "/" + upstream_path
    if len(path) > 256 or not isinstance(raw_path, bytes):
        return None
    try:
        expected = ("/proxy" + path).encode("ascii")
    except UnicodeEncodeError:
        return None
    if raw_path != expected:
        return None
    if path == "/":
        return path
    if any(segment in ("", ".", "..") or not _SEGMENT.fullmatch(segment)
           for segment in path[1:].split("/")):
        return None
    return path


def match_rule(method: str, path: str, routes: Sequence[RouteRule]) -> RouteRule | None:
    """Match whole segments; more specific rules win over wildcard rules."""
    segments = path.split("/")
    matches = [
        rule for rule in routes
        if rule.method == method
        and len(rule.path.split("/")) == len(segments)
        and all(wanted == actual or (wanted == "*" and bool(actual))
                for wanted, actual in zip(rule.path.split("/"), segments))
    ]
    return min(matches, key=lambda rule: rule.path.split("/").count("*"), default=None)


def parse_query(raw_query: bytes, allowed_keys: Sequence[str]) -> list[tuple[str, str]] | None:
    """Require unambiguous identifier keys and return pairs for re-encoding.

    A value may be UTF-8 text.  Keys must be literal ASCII: percent-encoded
    aliases, semicolon separators, repeated keys and invalid escapes fail.
    """
    if not isinstance(raw_query, bytes) or len(raw_query) > 2048:
        return None
    if not raw_query:
        return []
    try:
        query = raw_query.decode("ascii")
    except UnicodeDecodeError:
        return None
    if any(ord(char) < 33 or ord(char) > 126 for char in query) or ";" in query or "#" in query:
        return None
    if re.search(r"%(?![0-9A-Fa-f]{2})", query):
        return None
    pieces = query.split("&")
    if len(pieces) > 20:
        return None
    literal_keys = [piece.partition("=")[0] for piece in pieces]
    if any(not _QUERY_KEY.fullmatch(key) for key in literal_keys):
        return None
    if len(set(literal_keys)) != len(literal_keys) or not set(literal_keys).issubset(allowed_keys):
        return None
    try:
        pairs = parse_qsl(query, keep_blank_values=True, strict_parsing=True,
                          encoding="utf-8", errors="strict", max_num_fields=20,
                          separator="&")
    except (ValueError, UnicodeError):
        return None
    if any(len(value) > 512 or any(unicodedata.category(char).startswith("C") for char in value)
           for _, value in pairs):
        return None
    return pairs


def _peer_address(peer_host: str | None):
    try:
        # Socket peers should be numeric and unscoped.  A zone identifier is
        # never needed for a CIDR decision and is not safe audit metadata.
        if not peer_host or "%" in peer_host:
            return None
        return ipaddress.ip_address(peer_host)
    except ValueError:
        return None


def peer_allowed(peer_host: str | None, cidrs: Sequence[str]) -> bool:
    if not cidrs:
        return True
    address = _peer_address(peer_host)
    if address is None:
        return False
    # Some dual-stack listeners expose an IPv4 peer as IPv4-mapped IPv6.
    candidates = [address]
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped:
        candidates.append(address.ipv4_mapped)
    try:
        return any(candidate in ipaddress.ip_network(cidr, strict=True)
                   for candidate in candidates for cidr in cidrs)
    except ValueError:
        return False


def _content_type(value: str) -> str | None:
    """Only JSON or inert UTF-8 text.  Never reflect a raw MIME header."""
    if len(value) > 160 or any(ord(char) < 32 or ord(char) > 126 for char in value):
        return None
    parts = [part.strip().lower() for part in value.split(";")]
    if len(parts) > 2 or (len(parts) == 2 and parts[1] not in ("charset=utf-8", 'charset="utf-8"')):
        return None
    if _JSON_MEDIA.fullmatch(parts[0]):
        return "application/json; charset=utf-8"
    if parts[0] == "text/plain":
        return "text/plain; charset=utf-8"
    return None


def _safe_headers(request_id: str) -> dict[str, str]:
    return {
        "X-Request-ID": request_id,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
    }


def _error_response(status: int, code: str, request_id: str) -> Response:
    return JSONResponse(
        {"error": {"code": code, "message": _ERROR_MESSAGES[code]}, "request_id": request_id},
        status_code=status,
        headers=_safe_headers(request_id),
    )


@asynccontextmanager
async def _send_stream(client: httpx.AsyncClient, request: httpx.Request):
    # An explicit Request intentionally bypasses the client's default headers,
    # query parameters and cookie jar.  A shared upstream Set-Cookie must never
    # turn into authority carried by another relay credential's next request.
    upstream = await client.send(request, stream=True, follow_redirects=False, auth=None)
    cancelled = False
    try:
        yield upstream
    except asyncio.CancelledError:
        cancelled = True
        raise
    finally:
        if cancelled:
            try:
                await upstream.aclose()
            except BaseException:
                # A cleanup failure or another cancellation must not replace
                # the original cancellation with a normal upstream error.
                pass
        else:
            await upstream.aclose()


async def proxy_request(
    request: Request,
    upstream_path: str,
    store: Store,
    settings: Settings,
    client: httpx.AsyncClient,
) -> Response:
    request_id = uuid.uuid4().hex
    credential_id: str | None = None
    audit_path = "[unmatched]"
    method = request.method if request.method in _METHODS else None
    peer_host = request.client.host if request.client else None
    address = _peer_address(peer_host)
    peer_ip = str(address) if address is not None else None
    cancellation_audit_started = False

    async def fail(status: int, reason: str, *, decision: str = "deny") -> Response:
        try:
            await call_store(store.audit, kind="proxy", credential_id=credential_id, decision=decision,
                             reason=reason, method=method, path=audit_path, status=status,
                             response_bytes=0, peer_ip=peer_ip)
        except Exception:
            # Returning data without durable audit is prohibited, including
            # after a successful upstream request or byte-budget reservation.
            return _error_response(503, "audit_unavailable", request_id)
        return _error_response(status, reason, request_id)

    async def audit_cancellation() -> None:
        # Cancellation can happen after an upstream write has started.  Leave
        # a safe record when storage is available, then preserve cancellation;
        # never convert it into a normal HTTP response or refund its budget.
        nonlocal cancellation_audit_started
        if cancellation_audit_started:
            return
        cancellation_audit_started = True
        try:
            await asyncio.to_thread(store.audit, kind="proxy", credential_id=credential_id, decision="error",
                                    reason="request_cancelled", method=method, path=audit_path,
                                    status=None, response_bytes=0, peer_ip=peer_ip)
        except BaseException:
            # This cleanup must preserve the cancellation already in flight.
            pass

    async def call_store(operation, *args, **kwargs):
        # SQLite opens/closes its connection inside each operation.  A worker
        # may finish a transaction after cancellation; its allowance remains
        # spent, while the cancelled coroutine never releases response data.
        try:
            return await asyncio.to_thread(operation, *args, **kwargs)
        except asyncio.CancelledError:
            await audit_cancellation()
            raise

    authorizations = request.headers.getlist("authorization")
    match = _BEARER.fullmatch(authorizations[0]) if len(authorizations) == 1 else None
    if match is None:
        return await fail(401, "invalid_token")
    try:
        credential = await call_store(store.find_credential, match.group(1))
    except Exception:
        return await fail(503, "storage_unavailable", decision="error")
    if credential is None:
        return await fail(401, "invalid_token")
    try:
        credential_id = credential["id"]
        policy = Policy.model_validate(credential["policy"])
    except Exception:
        return await fail(503, "storage_unavailable", decision="error")

    path = canonical_path(request.scope.get("raw_path", b""), upstream_path)
    if path is None:
        return await fail(403, "invalid_path")
    rule = match_rule(request.method, path, policy.routes)
    if rule is None:
        return await fail(403, "route_denied")
    audit_path = rule.path
    if not peer_allowed(peer_host, policy.ip_allowlist):
        return await fail(403, "ip_denied")
    query = parse_query(request.scope.get("query_string", b""), rule.query_keys)
    if query is None:
        return await fail(403, "query_denied")

    # Start from an empty header set.  In particular, never copy relay auth,
    # cookies, Host, proxy headers, connection headers or client API keys.
    upstream_headers = {"Authorization": "Bearer " + settings.upstream_token,
                        "Accept-Encoding": "identity"}
    accepts = request.headers.getlist("accept")
    if len(accepts) > 1:
        return await fail(403, "invalid_headers")
    accept = accepts[0].lower() if accepts else "application/json, text/plain"
    if (len(accept) > 256 or any(ord(char) < 32 or ord(char) > 126 for char in accept)
        or not all(_ACCEPT_ITEM.fullmatch(item.strip()) for item in accept.split(","))):
        return await fail(403, "invalid_headers")
    upstream_headers["Accept"] = ", ".join(item.strip() for item in accept.split(","))
    content_types = request.headers.getlist("content-type")
    if len(content_types) > 1:
        return await fail(403, "invalid_headers")
    if content_types:
        content_type = _content_type(content_types[0])
        if content_type is None:
            return await fail(403, "invalid_headers")
        upstream_headers["Content-Type"] = content_type
    lengths = request.headers.getlist("content-length")
    if len(lengths) > 1 or (lengths and not re.fullmatch(r"[0-9]{1,10}", lengths[0])):
        return await fail(403, "invalid_headers")
    if lengths and int(lengths[0]) > settings.max_request_bytes:
        return await fail(413, "request_too_large")

    try:
        reservation = await call_store(store.reserve_request, credential_id, None)
    except Exception:
        return await fail(503, "storage_unavailable", decision="error")
    if reservation is not None:
        if reservation not in {"token_revoked", "token_expired", "rate_limit", "lifetime_request_limit"}:
            return await fail(503, "storage_unavailable", decision="error")
        return await fail(429 if reservation in {"rate_limit", "lifetime_request_limit"} else 401, reservation)

    body = bytearray()
    try:
        async with asyncio.timeout(settings.upstream_timeout_seconds):
            async for chunk in request.stream():
                if len(body) + len(chunk) > settings.max_request_bytes:
                    raise _ProxyRejection(413, "request_too_large")
                body.extend(chunk)
    except _ProxyRejection as rejection:
        return await fail(rejection.status, rejection.reason, decision=rejection.decision)
    except asyncio.CancelledError:
        await audit_cancellation()
        raise
    except TimeoutError:
        return await fail(408, "request_timeout")
    except ClientDisconnect:
        return await fail(400, "invalid_request")
    except Exception:
        return await fail(400, "invalid_request")
    if lengths and int(lengths[0]) != len(body):
        return await fail(400, "invalid_request")
    if body and not content_types:
        return await fail(403, "invalid_headers")

    buffered = bytearray()
    response_type = "text/plain; charset=utf-8"
    response_status = 200
    try:
        # This overall deadline also defeats a server that sends one byte just
        # before every individual httpx read timeout.
        async with asyncio.timeout(settings.upstream_timeout_seconds):
            upstream_request = httpx.Request(
                request.method, settings.upstream_url.rstrip("/") + path,
                params=query, headers=upstream_headers, content=bytes(body),
            )
            async with _send_stream(client, upstream_request) as upstream:
                response_status = upstream.status_code
                if 300 <= response_status < 400:
                    raise _ProxyRejection(502, "upstream_redirect", decision="error")
                if not 200 <= response_status < 300:
                    raise _ProxyRejection(502, "upstream_rejected", decision="error")
                encodings = upstream.headers.get_list("content-encoding")
                if len(encodings) > 1 or (encodings and encodings[0].strip().lower() != "identity"):
                    raise _ProxyRejection(502, "upstream_encoding", decision="error")
                response_lengths = upstream.headers.get_list("content-length")
                if (len(response_lengths) > 1 or
                    (response_lengths and not re.fullmatch(r"[0-9]{1,12}", response_lengths[0]))):
                    raise _ProxyRejection(502, "upstream_invalid_response", decision="error")
                if response_lengths and int(response_lengths[0]) > policy.response_bytes_limit:
                    raise _ProxyRejection(413, "response_too_large")
                upstream_types = upstream.headers.get_list("content-type")
                if len(upstream_types) > 1:
                    raise _ProxyRejection(502, "upstream_content_type", decision="error")
                if response_status not in (204, 205):
                    response_type = _content_type(upstream_types[0]) if upstream_types else None
                    if response_type is None:
                        raise _ProxyRejection(502, "upstream_content_type", decision="error")
                # Compression is rejected before iteration.  aiter_bytes also
                # supports pre-buffered mock transports without re-decoding.
                async for chunk in upstream.aiter_bytes(chunk_size=8192):
                    if len(buffered) + len(chunk) > policy.response_bytes_limit:
                        raise _ProxyRejection(413, "response_too_large")
                    buffered.extend(chunk)
                if ((response_lengths and int(response_lengths[0]) != len(buffered)) or
                    (response_status in (204, 205) and buffered)):
                    raise _ProxyRejection(502, "upstream_invalid_response", decision="error")
    except _ProxyRejection as rejection:
        return await fail(rejection.status, rejection.reason, decision=rejection.decision)
    except asyncio.CancelledError:
        await audit_cancellation()
        raise
    except TimeoutError:
        return await fail(502, "upstream_timeout", decision="error")
    except httpx.TimeoutException:
        return await fail(502, "upstream_timeout", decision="error")
    except Exception:
        return await fail(502, "upstream_unavailable", decision="error")

    try:
        budget = await call_store(store.spend_bytes, credential_id, len(buffered), None)
    except Exception:
        return await fail(503, "storage_unavailable", decision="error")
    if budget is not None:
        if budget not in {"token_revoked", "token_expired", "byte_budget", "lifetime_byte_budget"}:
            return await fail(503, "storage_unavailable", decision="error")
        return await fail(429 if budget in {"byte_budget", "lifetime_byte_budget"} else 401, budget)
    try:
        await call_store(store.audit, kind="proxy", credential_id=credential_id, decision="allow", reason="forwarded",
                    method=method, path=audit_path, status=response_status,
                    response_bytes=len(buffered), peer_ip=peer_ip)
    except Exception:
        return _error_response(503, "audit_unavailable", request_id)
    headers = _safe_headers(request_id)
    headers["Content-Type"] = response_type
    return Response(bytes(buffered), status_code=response_status, headers=headers)
