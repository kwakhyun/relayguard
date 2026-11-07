# Changelog

## Unreleased

Operations and console improvements on top of the v0.2.0 preview. Existing databases are migrated in place on first start (new event indexes, pruning of unreachable minute windows); back up as for v0.2.0 and stop older workers first.

Gateway and API

- Every audit event records `request_id` (matching `X-Request-ID`) and the provider's `upstream_status`; rotation events record `related_credential_id`.
- Optional `forward_error_statuses` policy field returns 400/404/409/410/412/422 provider statuses without their body instead of 502.
- `POST /api/credentials/{id}/rotate` issues a replacement and revokes the old key or shortens it to a grace period in one transaction.
- `POST /api/policy/check` runs the CLI's static decision rules from the console or automation.
- Failed admin authentication is audited; `RELAYGUARD_ADMIN_TOKEN_NEXT` allows a second admin secret during rotation.
- `/metrics` Prometheus endpoint with an optional scrape-only `RELAYGUARD_METRICS_TOKEN`.
- Optional alert webhook for lifetime budget exhaustion, revoked-key use, admin auth failures, storage/audit failures and deny spikes.
- `RELAYGUARD_UPSTREAM_AUTH_HEADER` and `RELAYGUARD_UPSTREAM_AUTH_SCHEME` for providers that do not use `Authorization: Bearer`.
- Event filters by kind, key and period with cursor pagination, backed by expression indexes; 24-hour hourly statistics; current-minute key usage.
- Overview and metrics verify the audit chain incrementally from an in-process anchor that also reports truncation or rewrites behind it; full verification stays explicit.
- Minute budget rows older than the previous window are pruned; lifetime totals are unaffected.

Console

- English translation with a language toggle, and a dark theme that follows the system or a manual choice. Only these two display preferences are stored in the browser.
- Activity shows the key, client IP, request ID and provider status for each event, with server-side filters, older-page loading, optional 10 s auto refresh and CSV export.
- Relay keys list active keys first by default with current-minute and lifetime usage meters, relative expiry and lifetime-scaled expiry warnings.
- Key details link to the key's activity, export the policy as JSON and start a rotation with a grace period.
- Issuance has a per-route method/path/query editor, byte units, TTL presets, JSON import, pass-through status selection and a pre-issuance request test.
- Overview adds 24-hour stats with an hourly chart and table view, keys that need attention, the injected auth header and alert status; the demo banner sits next to the hero.
- Every server reason has a label; tests keep the labels and the English catalog in sync.

## 0.2.0 — 2026-10-30

Public preview for bounded HTTP integrations. Stop all older workers and back up the database before upgrading; see [upgrade instructions](docs/deployment.md#v020으로-업그레이드).

- Optional persistent lifetime request and response-byte caps, with atomic legacy usage migration.
- Offline policy checks against explicit allow/deny cases, configuration validation and storage readiness.
- Mounted secret-file support and configurable request size and upstream deadline.
- SQLite operations off the async event loop and expiry checked after acquiring the write lock.
- English onboarding, an explicit comparison with existing tools and documented adoption limits.
- Console async regression tests and actual installed-wheel smoke checks in CI.

- Task-focused Korean console with separate overview, key management, activity and audit views.
- Two-step key creation, readable data limits, complete policy details and searchable key lists.
- Explicit one-time key storage confirmation and revocation target identification.
- Responsive mobile cards, keyboard focus management, accessible labels and local Lucide icons.
- Recoverable section errors, bounded requests and protection against stale responses and duplicate actions.

## 0.1.1 — 2026-10-23

- GHCR container images for `linux/amd64` and `linux/arm64`, with version, `latest` and commit tags.
- Native architecture builds and container smoke checks before publishing through GitHub Actions.
- Container demo support through `demo --host` and `demo --db`, with the synthetic upstream kept on loopback.
- Digest-pinned Python base image, non-root execution and persistent SQLite storage.
- Prebuilt-image Docker Compose setup and copyable Docker instructions for demo and production use.

## 0.1.0 — 2026-10-23

Initial public release of RelayGuard, a self-hosted credential boundary for HTTP integrations.

- One-time scoped relay keys with hashed storage, expiry and persistent revocation.
- Explicit method/path/query policies and actual peer IP/CIDR restrictions.
- Atomic SQLite request and response-byte budgets with complete response withholding before approval.
- Fixed-origin HTTPS forwarding, isolated upstream credentials, no redirect or cookie replay, bounded request and response bodies.
- Hash-chained audit metadata, integrity verification and JSON export.
- Korean operations console and a synthetic CRM demonstration with twelve real HTTP scenarios.
- 185 automated tests, source and wheel packaging, pinned dependency versions and a Python 3.11–3.13 CI matrix.
- Research, API documentation, threat model, deployment instructions and Docker Compose example.

This release is a defensive reference implementation. It is not a completed independent security audit, an object authorization engine, or a provider-token revocation service. See the threat model for the limits of fixed-window budgets, audit integrity and in-flight request revocation. Docker execution has not been validated in the local development environment.
