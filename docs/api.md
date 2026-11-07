# HTTP API

All `/api/*` requests require one `Authorization: Bearer <admin token>` header. During admin rotation the optional `RELAYGUARD_ADMIN_TOKEN_NEXT` is accepted too. `/proxy/*` requires a **different scoped relay key**. `/metrics` accepts the admin token or the optional scrape-only `RELAYGUARD_METRICS_TOKEN`. There are no session cookies, CORS grants, public API docs, or query-string credentials. `/healthz`, `/readyz` and local static assets are public. All responses are `Cache-Control: no-store`.

A rejected admin token on `/api/*` or `/metrics` is audited as `kind: "admin_auth"`, `reason: "admin_auth_failed"`, with the matched route template and socket peer; the supplied value is never recorded.

| Method and path | Input | Output |
| --- | --- | --- |
| `GET /healthz` | none | `status`, `service`, `demo_mode` (process liveness) |
| `GET /readyz` | none | 200 `status: ready`, `service`; 503 `storage_not_ready` if local storage cannot accept a write transaction |
| `GET /api/overview` | admin | `demo_mode`, `version`, `upstream_origin`, `upstream_auth` (`header`, `scheme`), `alerts.enabled`, `admin_token_rotation`, `stats`, incremental `audit`, `recent_events` |
| `GET /api/credentials` | admin | `{items: [credential]}` without token or hash; `usage` includes current-minute counters |
| `POST /api/credentials` | `name`, `ttl_hours`, `policy` | 201 `{credential, token}`; token shown once |
| `POST /api/credentials/{id}/rotate` | `credential` (as above), `grace_hours=0..168` | 201 `{credential, token, replaced}`; 404 unknown, 409 `credential_inactive` |
| `POST /api/credentials/{id}/revoke` | admin | updated credential; repeated revocation is idempotent |
| `POST /api/policy/check` | `policy`, 1–50 `cases` of `{method, path, peer_ip?}` | static `results` with `decision`, `code`, `matched_route`, `ip_checked`; no key, quota or upstream call |
| `GET /api/events` | optional `limit=1..1000`, `decision=allow\|deny\|error`, `kind=proxy\|admin`, `credential_id`, `since_hours=1..8760`, `before_id` | newest-first `{items: [event], next_before_id}` |
| `GET /api/audit/verify` | admin | full chain check: `valid`, `event_count`, `head_hash`, `mode: "full"`, optional `error` |
| `GET /metrics` | admin or metrics token | Prometheus text exposition (see below) |
| `GET /api/audit/export` | admin | JSON attachment containing `exported_at`, `verification`, `events` from one DB snapshot |
| `POST /api/demo/run` | admin, demo only | real HTTP `scenarios` and overall `passed`; normal mode returns 404 |
| `GET/POST/PUT/PATCH/DELETE /proxy/{path}` | scoped relay key | bounded upstream 2xx JSON or plain text, otherwise safe error |

Credential creation example: `examples/read-only-policy.json`. TTL is 1–720 hours. No token refresh endpoint is provided: rotate the key. Policies cannot be silently widened after creation; replace the credential.

**Rotation** issues the replacement and updates the old key in one SQLite transaction. `grace_hours: 0` revokes the old key immediately. A positive value sets the old key's expiry to the earlier of its current expiry and now plus the grace period; expiry is never extended. Only an active key can be rotated. Audit records a `credential_created` event for the new key and a `credential_rotated` event for the old one, each with `related_credential_id`, plus `credential_revoked` when the grace period is zero.

**Credential usage** has `total_requests` and `total_bytes` (lifetime) on every credential. The list endpoint also returns `minute_requests`, `minute_bytes` and `minute_window_start` for the current UTC minute at the time of the call.

## Policy semantics

- 1–32 routes. Each has `method`, absolute `path`, and 0–20 `query_keys`. Unknown fields and duplicate routes are rejected.
- A `*` path segment matches exactly one nonempty segment. It is not recursive and is not a string glob. Exact/specific rules win; equal-specificity ties use declaration order.
- Request paths have one canonical ASCII spelling. Encoded path aliases, dot segments, repeated/trailing slashes and backslashes are denied. Root `/` is supported explicitly.
- Query keys are unique ASCII identifiers. Unknown or repeated keys, encoded aliases, malformed escapes, controls, ambiguous separators, and excessively long queries are rejected. UTF-8 values are re-encoded canonically. Values are **not** a data-level authorization policy.
- `ip_allowlist` is optional. Empty means no IP restriction. Entries are strict CIDRs. The socket peer is used; forwarded headers are never trusted. IPv4-mapped IPv6 is normalized for IPv4 CIDRs.
- `requests_per_minute`: 1–10,000; `response_bytes_limit`: 128–1,048,576; `bytes_per_minute`: 128–104,857,600.
- Optional `max_total_requests`: 1–1,000,000,000; `max_total_bytes`: 128–1,000,000,000,000. Omitted or `null` means no lifetime cap. They persist across minute boundaries and restarts; keys do not share a global budget. Public credentials include `usage.total_requests` and `usage.total_bytes`.
- Optional `forward_error_statuses`: up to six unique values from 400, 404, 409, 410, 412, 422. When the upstream returns one of them, the client receives that status with the gateway's `upstream_rejected` error body; the upstream body is never read or released. Every other non-2xx upstream status still becomes 502. Statuses that overlap relay authentication (401), policy (403) or budgets (429) cannot be forwarded.
- Requests are charged when a valid policy reserves a call, before the body/upstream finishes. Failed calls are not refunded. Bytes are charged after a complete bounded upstream response is received and before it is released. Failed client delivery is not refunded. Audit stats count admitted responses, not proof of bytes received by a client.
- Budgets use separate **fixed UTC minute windows** for reservation and release. A request crossing a minute boundary charges the response in its release window. A byte denial occurs after fetching upstream data; it does not prevent upstream read cost or write side effects.

## Proxy protocol

Only server-injected Bearer auth, a constrained `Accept`, a validated JSON/text `Content-Type`, and `Accept-Encoding: identity` are sent. HTTPX constructs normal transport headers. Client cookies, custom auth, Host and forwarded headers are dropped; upstream cookies are not sent on later calls. Upstream redirects are not followed.

The upstream credential is sent as `Authorization: Bearer <token>` by default. `RELAYGUARD_UPSTREAM_AUTH_HEADER` and `RELAYGUARD_UPSTREAM_AUTH_SCHEME` change the header name and prefix (`none` sends the raw token), for APIs such as `X-API-Key`. Transport and content headers the gateway builds itself cannot be chosen.

Only 2xx `application/json`, `application/*+json`, or `text/plain` bodies are released; JSON MIME is normalized. Empty 204/205 responses are supported. There is no streaming, WebSocket, multipart upload, compressed/binary response, redirect, or application-cookie support. Non-2xx upstream bodies are withheld and mapped to 502 unless the status is listed in the key's `forward_error_statuses`. These choices intentionally trade general proxy compatibility for a smaller credential boundary.

Proxy errors have `{error: {code, message}, request_id}` and `X-Request-ID`. No upstream error message or body is included. Common status codes:

| Status | Meaning |
| --- | --- |
| 401 | missing, unknown, expired or revoked credential |
| 403 | route, query, IP, path or request-header policy violation |
| 408 | request body deadline exceeded |
| 413 | request or upstream response exceeds size cap |
| 429 | minute or lifetime budget exhausted (`lifetime_request_limit`, `lifetime_byte_budget` for lifetime caps) |
| 431 | inbound headers exceed the application cap |
| 400, 404, 409, 410, 412, 422 | upstream status passed through by `forward_error_statuses`; body withheld |
| 502 | upstream error, timeout, redirect, compression or unsafe response |
| 503 | storage or audit failure; upstream data withheld |

Transport-level failures rejected by the HTTP server before ASGI execution are outside the application audit. Application task cancellation is best-effort audited and re-raised. Process termination, disk failure and network failures cannot guarantee a final record.

## Audit format

Events contain `id`, `ts`, `kind`, `credential_id`, `decision`, `reason`, `method`, matched policy `path`, `status`, `response_bytes`, `peer_ip`, `request_id`, `upstream_status`, `prev_hash`, `hash`, and on rotation events `related_credential_id`. `request_id` equals the `X-Request-ID` header and error-body `request_id` returned to the client, so a reported failure can be found in the log. `upstream_status` is the provider's HTTP status when a response was received, including withheld errors. Events written before this version lack the two new fields; consumers must treat them as optional. No raw request path identifier, query value, request/response body or authorization header is persisted by the gateway.

Kinds are `proxy`, `credential_created`, `credential_revoked`, `credential_rotated` and `admin_auth`. The `kind=admin` filter returns every non-proxy kind.

Hash calculation: `SHA256(previous_hash + "\n" + canonical_json(payload))`. Canonical JSON uses Python `json.dumps(ensure_ascii=False, sort_keys=True, separators=(',', ':'))`; payload includes every event field except `prev_hash` and `hash`. The genesis hash is 64 zeros. This is a consistency chain, not a digital signature or immutable storage.

## Preflight and readiness

`relayguard policy check examples/read-only-policy.json --cases examples/policy-cases.json` runs the same static route, query and IP checks as the gateway. It does not authenticate, spend quotas or call upstream. See [examples](../examples/README.md). `relayguard check-config` validates environment settings and secret files without creating a database or probing the provider.

`/readyz` opens the existing SQLite database, checks required tables and acquires then rolls back a write transaction with a 100 ms lock timeout. It can return 503 during write contention. It does not verify the entire audit chain, test upstream availability or promise a global filesystem deadline. Use `/healthz` for liveness and `/api/audit/verify` for explicit chain verification.

## Verification modes

Each process keeps the last head it verified, `(event_count, head_hash)`, in memory. Startup and `GET /api/audit/verify` hash the whole chain (`mode: "full"`). The overview and `/metrics` hash only events after that anchor (`mode: "incremental"`), so their cost no longer grows with the log. Both modes first check that the anchored event still exists with the same hash. A deletion behind the anchor reports `events_missing_after_<n>`, and a rewrite reports `chain_changed_at_<n>`, even when the rewritten chain is self-consistent. The anchor is lost on restart, so an external checkpoint is still required for tamper evidence across restarts.

## Metrics

`GET /metrics` returns Prometheus text format 0.0.4, derived from the database so every worker reports the same values: `relayguard_credentials{state}`, `relayguard_proxy_requests_total{decision,reason}`, `relayguard_proxy_response_bytes_total`, `relayguard_admin_auth_failures_total`, `relayguard_audit_events_total`, `relayguard_audit_chain_valid` (incremental check) and `relayguard_build_info`. With alerts enabled, `relayguard_alerts_total{result}` counts this process's sent, failed and dropped alerts. Counting requests scans the audit table, so keep scrape intervals at 30 s or more on large logs.

## Alerts

When `RELAYGUARD_ALERT_WEBHOOK_URL` is set, the gateway POSTs JSON to that URL for lifetime budget exhaustion, use of a revoked key, failed admin authentication, storage or audit failures, and a deny spike (`RELAYGUARD_ALERT_DENY_THRESHOLD` denials for one key within 60 s, default 20). Each `(type, credential)` pair is sent at most once per `RELAYGUARD_ALERT_COOLDOWN_SECONDS` (default 600). The payload has `source`, `version`, `type`, `reason`, `message`, `credential_id`, `ts`, optional `path`, `method`, `request_id`, `count`, `window_seconds`, and a `text` summary for Slack-compatible receivers. It never contains relay keys, upstream tokens, query values or bodies.

Delivery is best effort: a bounded in-process queue, a 3 s timeout, no retries and no redirects. Alerts never change a gateway decision. The URL must be HTTPS (HTTP only on loopback) without credentials, query or fragment.
