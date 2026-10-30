# RelayGuard

[한국어](README.md) · English

**Give an integration a scoped key and a data budget instead of your provider token.**

RelayGuard is a small, self-hosted HTTP credential gateway. It keeps one upstream Bearer token on the server, issues expiring relay keys, and checks the entire response against byte limits before releasing it. It uses Python, FastAPI, HTTPX and SQLite, with no external control plane or telemetry.

This is an early-stage MIT project for bounded JSON/text integrations. It has not undergone an independent security audit. See the [threat model](docs/threat-model.md) before connecting a real service.

## Try the v0.2.0 public preview

Install the source with Python 3.11+ and internet access for the first installation. Packaged downloads are on the [v0.2.0 release](https://github.com/kwakhyun/relayguard/releases/tag/v0.2.0).

```bash
git clone https://github.com/kwakhyun/relayguard.git
cd relayguard
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.lock
python -m pip install --no-deps --no-build-isolation -e .
python -m relayguard demo
```

Open [the local console](http://127.0.0.1:8810), paste the demo admin token printed in the terminal, and run the verification scenarios. The console is currently in Korean; the JSON API and CLI are documented in English. The demo starts a synthetic CRM on port 8811 and makes no calls to a real provider. It stores state in `.relayguard/demo.db`. Press `Ctrl+C` to stop; the admin token changes on restart.

Use the public image for `linux/amd64` or `linux/arm64`:

```bash
docker run --rm -it --name relayguard-demo \
  -p 127.0.0.1:8810:8810 \
  --read-only --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --cap-drop ALL --security-opt no-new-privileges:true \
  --mount type=volume,source=relayguard-demo-data,target=/data \
  ghcr.io/kwakhyun/relayguard:0.2.0 \
  relayguard demo --host 0.0.0.0 --db /data/demo.db
```

## What it enforces

| Control | Behavior |
| --- | --- |
| Credential separation | Relay keys are shown once; only their SHA-256 hashes are stored. The gateway injects the provider's Bearer token. |
| Request scope | Default deny by method, canonical path, query-key allowlist and optional socket-peer CIDRs. |
| Persistent budgets | Transactional limits for requests and bytes per UTC minute. v0.2.0 also supports optional lifetime limits, `max_total_requests` and `max_total_bytes`. |
| Response gate | The whole response is buffered and checked before release; a denied response does not leak an initial chunk. |
| Expiry and revocation | Checked at request reservation and byte approval. Already executed upstream writes cannot be undone. |
| Audit trail | Decision metadata and policy templates, without request/response bodies, query values or raw tokens. Hash-chain verification and JSON export are available. |

One deployment serves one upstream origin and one provider account. Use it when you control the client's base URL and Authorization header and need small, revocable integration credentials. A general API gateway, OAuth integration platform or LLM cost gateway may fit better if those are the actual requirements. See the [comparison and market assessment](docs/market-assessment.ko.md) (Korean).

## Check a policy, then issue a key

From the source checkout, validate a complete credential creation request and synthetic expected decisions without a running server, database or credentials:

```bash
python -m relayguard policy check examples/read-only-policy.json \
  --cases examples/policy-cases.json
```

Exit status `0` means the schema is valid and all expected static decisions match; `1` means validation or a decision failed. This does not simulate live quota, authentication, expiry, request bodies or provider behavior. See [policy examples](examples/README.md).

In another terminal, set `RELAYGUARD_ADMIN_TOKEN` to the current local demo token through your preferred secret-handling workflow. Issue the checked policy:

```bash
curl -sS http://127.0.0.1:8810/api/credentials \
  -H "Authorization: Bearer $RELAYGUARD_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  --data-binary @examples/read-only-policy.json
```

Save the returned `token` securely; it cannot be retrieved again. With that value in `RELAY_TOKEN`, make a request:

```bash
curl -sS 'http://127.0.0.1:8810/proxy/customers?limit=2' \
  -H "Authorization: Bearer $RELAY_TOKEN"
```

The example's CIDRs are for a gateway that sees a loopback peer, such as the Python demo. For the loopback-published synthetic Docker demo, use `examples/docker-demo-policy.json` instead. Docker port forwarding may present a bridge peer; review the [IP policy explanation](examples/README.md#docker-and-ip-policies) before reusing the example there. An empty allowlist means unrestricted peer IPs.

The example caps a whole key's use with `"max_total_requests": 100` and `"max_total_bytes": 1048576` inside its `policy`. These optional fields are available in v0.2.0; omitting them or using `null` leaves the lifetime limit unset. The counters persist across process restarts and minute boundaries. A request reservation consumes request budget even if later upstream work fails. Byte usage measures responses approved for release, not confirmation that the client received every byte. See the [API contract](docs/api.md) for details and bounds.

## Connect a real service

Configure `RELAYGUARD_UPSTREAM_URL` as an HTTPS origin and inject distinct `RELAYGUARD_UPSTREAM_TOKEN` and `RELAYGUARD_ADMIN_TOKEN` secrets. v0.2.0 also accepts the corresponding `_FILE` variables for mounted secret files; do not set both sources for a secret.

```bash
python -m relayguard check-config
python -m relayguard serve --host 127.0.0.1 --port 8810
```

`check-config` validates configuration without creating a database or contacting the provider. `/healthz` is liveness; `/readyz` in v0.2.0 checks local database write readiness. It does not probe the provider or verify the entire audit chain. Use TLS and access controls before exposing a deployment. See the [deployment guide](docs/deployment.md) for environment variables, Docker, backup and upgrades.

## Boundaries to understand

- Clients must not retain the provider token; that would let them bypass the gateway.
- Allowed data can still be extracted within the configured budgets. Query keys are checked, not their values. Object/tenant authorization and body semantics belong to the upstream.
- Only successful 2xx JSON or plain-text responses are relayed. Upstream errors are withheld and mapped to gateway errors. Redirects, compressed responses, HTML, binary downloads, SSE and WebSockets are outside the supported contract.
- Per-minute windows are fixed, so bursts can straddle a minute boundary. Lifetime limits bound the key as a whole; there is no shared organization budget.
- Local SQLite serializes writers. This is not a distributed quota store or a demonstrated high-availability deployment. There is no automatic retention policy.
- The audit chain detects some modifications but cannot prove that the whole database was not rewritten, truncated or rolled back without a separately trusted checkpoint.
- There is no provider-token rotation, OAuth refresh, SSO/RBAC or DLP content inspection. Protect the gateway host and back up its state.

## Reproduce checks and contribute

```bash
python -m pip install -r requirements-dev.lock
python -m pytest -q
python scripts/e2e.py
python -m build --no-isolation
python scripts/wheel_smoke.py
npm ci
npm test
```

Use Node.js 24 for console regression tests. The production console ships as static assets and needs no Node runtime. The HTTP scenario script uses local sockets. [Verification notes](docs/verification.md) distinguish local results from remote CI and release-image checks.

Start with the demo or a non-sensitive read-only integration. Useful issue reports describe the API shape, a synthetic policy, the expected decision and the observed result, with all secrets removed. See [contributing](CONTRIBUTING.md), [security reporting](SECURITY.md), and the [MIT license](LICENSE).
