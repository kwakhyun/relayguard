# HTTP API

All `/api/*` requests require one `Authorization: Bearer <admin token>` header. `/proxy/*` requires a **different scoped relay key**. There are no session cookies, CORS grants, public API docs, or query-string credentials. `/healthz`, `/readyz` and local static assets are public. All responses are `Cache-Control: no-store`.

| Method and path | Input | Output |
| --- | --- | --- |
| `GET /healthz` | none | `status`, `service`, `demo_mode` (process liveness) |
| `GET /readyz` | none | 200 `status: ready`, `service`; 503 `storage_not_ready` if local storage cannot accept a write transaction |
| `GET /api/overview` | admin | `demo_mode`, `upstream_origin`, `stats`, `audit`, `recent_events` |
| `GET /api/credentials` | admin | `{items: [credential]}` without token or hash |
| `POST /api/credentials` | `name`, `ttl_hours`, `policy` | 201 `{credential, token}`; token shown once |
| `POST /api/credentials/{id}/revoke` | admin | updated credential; repeated revocation is idempotent |
| `GET /api/events` | optional `limit=1..1000`, `decision=allow\|deny\|error` | newest-first `{items: [event]}` |
| `GET /api/audit/verify` | admin | `valid`, `event_count`, `head_hash`, optional `error` |
| `GET /api/audit/export` | admin | JSON attachment containing `exported_at`, `verification`, `events` from one DB snapshot |
| `POST /api/demo/run` | admin, demo only | real HTTP `scenarios` and overall `passed`; normal mode returns 404 |
| `GET/POST/PUT/PATCH/DELETE /proxy/{path}` | scoped relay key | bounded upstream 2xx JSON or plain text, otherwise safe error |

Credential creation example: `examples/read-only-policy.json`. TTL is 1–720 hours. No token refresh endpoint is provided: issue a new scoped key and revoke the old one. Policies cannot be silently widened after creation; replace the credential.

## Policy semantics

- 1–32 routes. Each has `method`, absolute `path`, and 0–20 `query_keys`. Unknown fields and duplicate routes are rejected.
- A `*` path segment matches exactly one nonempty segment. It is not recursive and is not a string glob. Exact/specific rules win; equal-specificity ties use declaration order.
- Request paths have one canonical ASCII spelling. Encoded path aliases, dot segments, repeated/trailing slashes and backslashes are denied. Root `/` is supported explicitly.
- Query keys are unique ASCII identifiers. Unknown or repeated keys, encoded aliases, malformed escapes, controls, ambiguous separators, and excessively long queries are rejected. UTF-8 values are re-encoded canonically. Values are **not** a data-level authorization policy.
- `ip_allowlist` is optional. Empty means no IP restriction. Entries are strict CIDRs. The socket peer is used; forwarded headers are never trusted. IPv4-mapped IPv6 is normalized for IPv4 CIDRs.
- `requests_per_minute`: 1–10,000; `response_bytes_limit`: 128–1,048,576; `bytes_per_minute`: 128–104,857,600.
- Optional `max_total_requests`: 1–1,000,000,000; `max_total_bytes`: 128–1,000,000,000,000. Omitted or `null` means no lifetime cap. They persist across minute boundaries and restarts; keys do not share a global budget. Public credentials include `usage.total_requests` and `usage.total_bytes`.
- Requests are charged when a valid policy reserves a call, before the body/upstream finishes. Failed calls are not refunded. Bytes are charged after a complete bounded upstream response is received and before it is released. Failed client delivery is not refunded. Audit stats count admitted responses, not proof of bytes received by a client.
- Budgets use separate **fixed UTC minute windows** for reservation and release. A request crossing a minute boundary charges the response in its release window. A byte denial occurs after fetching upstream data; it does not prevent upstream read cost or write side effects.

## Proxy protocol

Only server-injected Bearer auth, a constrained `Accept`, a validated JSON/text `Content-Type`, and `Accept-Encoding: identity` are sent. HTTPX constructs normal transport headers. Client cookies, custom auth, Host and forwarded headers are dropped; upstream cookies are not sent on later calls. Upstream redirects are not followed.

Only 2xx `application/json`, `application/*+json`, or `text/plain` bodies are released; JSON MIME is normalized. Empty 204/205 responses are supported. There is no streaming, WebSocket, multipart upload, compressed/binary response, redirect, or application-cookie support. Non-2xx upstream bodies are withheld and mapped to 502. These choices intentionally trade general proxy compatibility for a smaller credential boundary.

Proxy errors have `{error: {code, message}, request_id}` and `X-Request-ID`. No upstream error message or body is included. Common status codes:

| Status | Meaning |
| --- | --- |
| 401 | missing, unknown, expired or revoked credential |
| 403 | route, query, IP, path or request-header policy violation |
| 408 | request body deadline exceeded |
| 413 | request or upstream response exceeds size cap |
| 429 | minute or lifetime budget exhausted (`lifetime_request_limit`, `lifetime_byte_budget` for lifetime caps) |
| 431 | inbound headers exceed the application cap |
| 502 | upstream error, timeout, redirect, compression or unsafe response |
| 503 | storage or audit failure; upstream data withheld |

Transport-level failures rejected by the HTTP server before ASGI execution are outside the application audit. Application task cancellation is best-effort audited and re-raised. Process termination, disk failure and network failures cannot guarantee a final record.

## Audit format

Events contain `id`, `ts`, `kind`, `credential_id`, `decision`, `reason`, `method`, matched policy `path`, `status`, `response_bytes`, `peer_ip`, `prev_hash`, `hash`. No raw request path identifier, query value, request/response body or authorization header is persisted by the gateway.

Hash calculation: `SHA256(previous_hash + "\n" + canonical_json(payload))`. Canonical JSON uses Python `json.dumps(ensure_ascii=False, sort_keys=True, separators=(',', ':'))`; payload includes every event field except `prev_hash` and `hash`. The genesis hash is 64 zeros. This is a consistency chain, not a digital signature or immutable storage.

## Preflight and readiness

`relayguard policy check examples/read-only-policy.json --cases examples/policy-cases.json` runs the same static route, query and IP checks as the gateway. It does not authenticate, spend quotas or call upstream. See [examples](../examples/README.md). `relayguard check-config` validates environment settings and secret files without creating a database or probing the provider.

`/readyz` opens the existing SQLite database, checks required tables and acquires then rolls back a write transaction with a 100 ms lock timeout. It can return 503 during write contention. It does not verify the entire audit chain, test upstream availability or promise a global filesystem deadline. Use `/healthz` for liveness and `/api/audit/verify` for explicit chain verification.
