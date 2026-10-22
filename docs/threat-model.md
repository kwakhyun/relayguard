# Threat model

## Assets and trust

The assets are upstream credentials, returned business data, the administrator credential, scoped relay credentials, quota state, and audit records. Trusted components are the operator, gateway host/process, configured upstream origin and TLS trust store, local SQLite storage, and the browser executing the local console. A relay-key holder and their request headers, bodies, paths and query strings are untrusted.

This design helps when a client with a limited **relay** credential is compromised. It does not control a client holding the actual upstream credential. Give clients only relay credentials; reduce provider scopes; restrict provider access to the gateway network/workload where possible. A fixed host setting is not a defense against a compromised DNS resolver, CA, or trusted operator. Use egress network policies for production.

## Threats and evidence

| Threat | Defense | Verification |
| --- | --- | --- |
| Key theft and broader API use | per-key route/method/query allowlist, TTL and revocation | API and policy tests, live forbidden export |
| Path normalization bypass | raw ASGI path comparison, canonical origin, whole-segment patterns | encoded paths, empty query/fragment origin, nested wildcard tests |
| Forged client IP | peer address only, `proxy_headers=False` in CLI | forged X-Forwarded-For test |
| Cross-client credential carryover | explicit HTTPX Request, no shared cookies/default auth/params | shared-client isolation test |
| Bulk reads and concurrent budget races | atomic persisted request and byte spending, response buffering | 40–50 concurrent reservation tests and live byte rejection |
| Redirect credential exfiltration | fixed origin, HTTPS, no redirect following | 302 target never requested |
| Slow or oversized response | total deadline, strict MIME/encoding, bounded body before release | chunked response and timeout tests |
| Log secret leakage | safe metadata, policy templates, no access logging in CLI | token/query/body absence tests |
| Missing audit due to storage failure | no successful body release without audit write | injected audit failure and transaction rollback tests |
| Dashboard script injection | textContent, local assets, CSP, no token storage/cookies | browser smoke and source checks |
| Accidental record editing | hash chain, startup verification, export checkpoint | mutation and concurrent audit tests |

## Explicit non-goals and residual risk

- **Object and tenant authorization:** `/customers/*` can still reach every ID that the upstream credential can read. The upstream must implement object-level authorization. Prefer narrowly scoped upstream accounts and exact routes. Do not allow debug/echo/credential/admin endpoints or unrestricted RPC/GraphQL/SQL endpoints. Upstream JSON can contain sensitive data or reflect its own Authorization header; RelayGuard does not inspect semantic fields or promise to redact provider secrets from arbitrary response bodies.
- **Permitted exfiltration:** an attacker can use the allowed paths within quota. Fixed windows allow bursts around boundaries. Multiple credentials have independent budgets. There is no lifetime quota or automatic anomaly model.
- **Write effects and revocation:** a completed upstream write cannot be undone by later response rejection. Revocation is checked at request reservation and response release approval. After final approval, the response may still complete while a concurrent revocation occurs. Network response delivery and database writes are not one atomic transaction. No stronger revocation guarantee is claimed.
- **Partial failures:** a reserved call or byte allowance may be spent even if the request fails, audit fails or the client disconnects. This is conservative for confidentiality. An allowed audit event records approval to deliver; it is not proof that a client received the bytes. Crashes between quota updates and audit can leave accounting without a final event.
- **Log integrity:** the database owner can rewrite the chain, truncate its tail, replace it with an older valid copy or delete all events. Export to external immutable storage and save a trusted head hash; the product has no automatic external anchoring. An application hash chain is not a signed ledger.
- **Host/admin compromise:** a process or administrator compromise bypasses this boundary. Upstream secrets are environment-injected, not encrypted in a local vault. Admin authentication is one high-entropy secret; SSO, MFA, RBAC and admin rotation orchestration are not implemented. Rotate the admin secret and restart after exposure.
- **Availability:** SQLite is for modest single-node deployments. Writes are synchronous and serialized. Audit and budget tables grow until an operator archives/replaces the deployment. Header/body/concurrency bounds reduce per-request load but are not a complete unauthenticated rate limiter, disk quota, internet DDoS service or performance SLA. Do not expose an unauthenticated public edge without external limits.
- **Application input:** request bodies are size-limited and typed by MIME but are not schema-authorized or scanned for injection. The upstream must validate them. The gateway does not patch vulnerable upstream software or detect malware.

## Failure behavior

Unsafe policy inputs fail at issuance. Unmatched proxy routes fail before contacting upstream. Oversized or disallowed upstream bodies are fully withheld. Persistent quota or audit failure returns a generic 503. The gateway never retries upstream operations automatically. Do not add retries for non-idempotent requests without an upstream idempotency design.

An independent review found and fixed empty `?`/`#` origin delimiters changing the actual URL target, shared HTTPX cookie/default-authority leakage, and missing cancellation audit handling. This review and the tests are not an external security certification.
