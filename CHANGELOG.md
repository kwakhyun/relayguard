# Changelog

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
