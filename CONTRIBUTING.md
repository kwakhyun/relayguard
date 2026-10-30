# Contributing

Use Python 3.11 or newer. Install `requirements.lock` and `requirements-dev.lock`, then install the project with `pip install --no-deps --no-build-isolation -e .`.

Run `python -m pytest -q`, `python scripts/e2e.py`, `python -m build --no-isolation`, and `python scripts/wheel_smoke.py` before proposing a change. Keep upstream fixtures synthetic. Never include real tokens or customer data in a test, screenshot, issue or log.

Security-sensitive changes should include a threat scenario and a regression test showing the rejected request does not reach the upstream, or showing the response is fully withheld. Cover concurrent quota changes and fail-closed storage behavior. Keep credentials, headers, query values and bodies out of audit records.

The dashboard ships without a runtime build step. For its regression tests, use Node.js 24, `npm ci`, and `npm test`. These tests execute the actual browser script in JSDOM and cover stale responses, secret cleanup and lifetime quota forms; they do not replace responsive browser checks. Use semantic HTML, local assets, and `textContent` for untrusted values. Do not introduce browser token persistence or inline scripts. Keep Korean UI text concise.

Describe limitations honestly: RelayGuard is not an OAuth authorization server, WAF, object authorization engine, or immutable log service. Update research-to-requirement mapping when scope changes.
