// Run the shipped application, not a second implementation of its state model.
// JSDOM verifies state and async response ordering; it does not test geometry,
// browser rendering, real clipboard permissions or native dialog accessibility.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM, VirtualConsole } from "jsdom";

const html = readFileSync(new URL("../src/relayguard/static/index.html", import.meta.url), "utf8");
const script = readFileSync(new URL("../src/relayguard/static/app.js", import.meta.url), "utf8");
const flush = async () => { for (let i = 0; i < 3; i += 1) await new Promise(setImmediate); };
const overview = (overrides = {}) => ({
  demo_mode: true, upstream_origin: "http://127.0.0.1:8811",
  stats: { active_credentials: 0, total_requests: 0, allowed: 0, blocked: 0, bytes_forwarded: 0 },
  audit: { valid: true, event_count: 0, head_hash: "initial-hash" }, recent_events: [], ...overrides,
});

function harness(t) {
  const requests = [];
  const errors = [];
  const console = new VirtualConsole();
  console.on("jsdomError", (error) => errors.push(error));
  const dom = new JSDOM(html, {
    url: "http://localhost:8810/", runScripts: "outside-only", virtualConsole: console,
  });
  const { window } = dom;
  window.scrollTo = () => {};
  // Model only native dialog opening/closing. Application event handlers run
  // unchanged, including cancel prevention and secret wiping.
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () {
    if (!this.open) return;
    this.open = false;
    window.setTimeout(() => this.dispatchEvent(new window.Event("close")), 0);
  };
  window.fetch = (url, options = {}) => {
    if (url === "/healthz") return Promise.resolve({ ok: true, status: 200, json: async () => ({ demo_mode: true }) });
    return new Promise((resolve, reject) => {
      const request = {
        url, options, taken: false,
        reply(body, status = 200) { resolve({ ok: status >= 200 && status < 300, status, json: async () => body }); },
        reject,
      };
      // Deliberately do not auto-reject on AbortSignal: even a response already
      // queued when cancellation occurs must not update the new session.
      requests.push(request);
    });
  };
  window.eval(script);
  const element = (id) => {
    const found = window.document.getElementById(id);
    assert.ok(found, `Missing production DOM element: ${id}`);
    return found;
  };
  const take = (url, method = "GET") => {
    const request = requests.find((item) => !item.taken && item.url === url && (item.options.method || "GET") === method);
    assert.ok(request, `Expected pending ${method} ${url}`);
    request.taken = true;
    return request;
  };
  const submit = (id) => element(id).dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  const click = (id) => element(id).click();
  const startConnect = (token = "synthetic-admin-token") => {
    click("gate-connect-button");
    element("admin-token").value = token;
    submit("connect-form");
    return take("/api/overview");
  };
  const finishResources = () => {
    take("/api/credentials").reply({ items: [] });
    take("/api/events?limit=100").reply({ items: [] });
  };
  const connect = async (token) => {
    startConnect(token).reply(overview());
    await flush();
    finishResources();
    await flush();
    assert.equal(window.document.body.dataset.connected, "true");
  };
  const startCreate = () => {
    click("create-key-button");
    element("key-name").value = "Synthetic integration";
    click("create-next-button");
    assert.equal(element("create-step-2").hidden, false);
    submit("create-form");
    return take("/api/credentials", "POST");
  };
  t.after(() => {
    window.close();
    assert.deepEqual(errors, [], "Application raised an uncaught DOM error");
  });
  return { window, requests, element, take, submit, click, startConnect, finishResources, connect, startCreate };
}

test("cancelled connection ignores a late successful response", async (t) => {
  const ui = harness(t);
  const pending = ui.startConnect();
  ui.element("connect-dialog").dispatchEvent(new ui.window.Event("cancel", { cancelable: true }));
  assert.equal(pending.options.signal.aborted, true);
  pending.reply(overview());
  await flush();
  assert.equal(ui.window.document.body.dataset.connected, "false");
  assert.equal(ui.element("connect-dialog").open, false);
  assert.equal(ui.element("admin-token").value, "");
  assert.equal(ui.requests.length, 1, "Cancelled connection must not load private resources");
});

test("logout clears visible state and ignores an already queued overview", async (t) => {
  const ui = harness(t);
  await ui.connect();
  ui.click("refresh-button");
  const pending = ui.take("/api/overview");
  ui.click("disconnect-button");
  assert.equal(pending.options.signal.aborted, true);
  pending.reply(overview({ upstream_origin: "https://stale.example.invalid" }));
  ui.finishResources();
  await flush();
  assert.equal(ui.window.document.body.dataset.connected, "false");
  assert.equal(ui.element("workspace-content").hidden, true);
  assert.equal(ui.element("stat-total").textContent, "—");
  assert.doesNotMatch(ui.element("upstream-origin").textContent, /stale/);
});

test("an old session's delayed 401 cannot log out a new session", async (t) => {
  const ui = harness(t);
  await ui.connect("first-synthetic-token");
  ui.click("refresh-button");
  const old = ui.take("/api/overview");
  const oldCredentials = ui.take("/api/credentials");
  const oldEvents = ui.take("/api/events?limit=100");
  ui.click("disconnect-button");
  await ui.connect("second-synthetic-token");
  old.reply({ error: { code: "admin_auth_required" } }, 401);
  oldCredentials.reply({ items: [] }); oldEvents.reply({ items: [] });
  await flush();
  assert.equal(ui.window.document.body.dataset.connected, "true");
  assert.equal(ui.element("global-error").hidden, true);
  ui.click("refresh-button");
  assert.equal(ui.take("/api/overview").options.headers.Authorization, "Bearer second-synthetic-token");
});

test("a slower prior activity filter cannot overwrite the current filter", async (t) => {
  const ui = harness(t);
  await ui.connect();
  ui.window.document.querySelector('.filter-button[data-decision="deny"]').click();
  const denied = ui.take("/api/events?limit=100&decision=deny");
  ui.window.document.querySelector('.filter-button[data-decision="allow"]').click();
  const allowed = ui.take("/api/events?limit=100&decision=allow");
  const item = (decision, path) => ({ ts: "2026-01-01T00:00:00Z", kind: "proxy", decision, reason: "allowed", method: "GET", path, status: 200, response_bytes: 128 });
  allowed.reply({ items: [item("allow", "/current-filter")] });
  await flush();
  denied.reply({ items: [item("deny", "/obsolete-filter")] });
  await flush();
  assert.match(ui.element("events-body").textContent, /current-filter/);
  assert.doesNotMatch(ui.element("events-body").textContent, /obsolete-filter/);
});

test("repeated creation submits issue one request while the first is pending", async (t) => {
  const ui = harness(t);
  await ui.connect();
  const pending = ui.startCreate();
  ui.submit("create-form"); ui.submit("create-form");
  assert.equal(ui.requests.filter((request) => request.url === "/api/credentials" && request.options.method === "POST").length, 1);
  assert.equal(ui.element("create-submit").disabled, true);
  pending.reply({ token: "rg_synthetic_one_time_secret", credential: { id: "synthetic-id" } }, 201);
  await flush();
  assert.equal(ui.element("key-dialog").open, true);
  assert.equal(ui.element("new-key").value, "rg_synthetic_one_time_secret");
});

test("closing an unsaved key requires a choice and clears its raw DOM value", async (t) => {
  const ui = harness(t);
  await ui.connect();
  ui.startCreate().reply({ token: "rg_synthetic_secret_to_wipe", credential: { id: "synthetic-id" } }, 201);
  await flush();
  ui.click("key-close-button");
  assert.equal(ui.element("key-dialog").open, true);
  assert.equal(ui.element("key-discard-warning").hidden, false);
  ui.click("key-discard-button");
  await flush();
  assert.equal(ui.element("key-dialog").open, false);
  assert.equal(ui.element("new-key").value, "");
  assert.equal(ui.element("new-key").textContent, "");
  assert.equal(ui.window.localStorage.length, 0);
  assert.equal(ui.window.sessionStorage.length, 0);
});

test("overview and explicit audit checks obey newest request order without stale success notices", async (t) => {
  const ui = harness(t);
  await ui.connect();
  ui.click("verify-button");
  const oldVerify = ui.take("/api/audit/verify");
  ui.click("refresh-button");
  ui.take("/api/overview").reply(overview({ audit: { valid: false, event_count: 2, head_hash: "newer-overview" } }));
  ui.finishResources();
  await flush();
  oldVerify.reply({ valid: true, event_count: 1, head_hash: "old-verification" });
  await flush();
  assert.equal(ui.element("audit-hash").textContent, "newer-overview");
  assert.match(ui.element("audit-badge").textContent, /확인 필요/);
  assert.doesNotMatch(ui.element("toast").textContent, /무결성을 확인/);

  ui.click("refresh-button");
  const oldOverview = ui.take("/api/overview");
  ui.finishResources();
  ui.click("verify-button");
  ui.take("/api/audit/verify").reply({ valid: true, event_count: 3, head_hash: "latest-verification" });
  await flush();
  oldOverview.reply(overview({ audit: { valid: false, event_count: 2, head_hash: "old-overview" } }));
  await flush();
  assert.equal(ui.element("audit-hash").textContent, "latest-verification");
  assert.match(ui.element("audit-badge").textContent, /무결성 확인/);
});

test("optional lifetime budgets send null when blank and exact integers when set", async (t) => {
  const ui = harness(t);
  await ui.connect();
  const blank = ui.startCreate();
  const unlimited = JSON.parse(blank.options.body).policy;
  assert.equal(unlimited.max_total_requests, null);
  assert.equal(unlimited.max_total_bytes, null);
  blank.reply({ error: { code: "validation_error" }, fields: [] }, 422);
  await flush();
  ui.element("key-total-requests").value = "25";
  ui.element("key-total-bytes").value = "32768";
  ui.submit("create-form");
  const bounded = JSON.parse(ui.take("/api/credentials", "POST").options.body).policy;
  assert.equal(bounded.max_total_requests, 25);
  assert.equal(bounded.max_total_bytes, 32768);
});

test("invalid lifetime budgets stay in the form and server errors identify the field", async (t) => {
  const ui = harness(t);
  await ui.connect();
  ui.click("create-key-button");
  ui.element("key-name").value = "Limited integration";
  ui.click("create-next-button");
  ui.element("key-total-requests").value = "0";
  ui.element("key-total-bytes").value = "127";
  ui.submit("create-form");
  assert.equal(ui.requests.some((request) => request.options.method === "POST"), false);
  assert.equal(ui.element("key-total-requests").getAttribute("aria-invalid"), "true");
  assert.equal(ui.element("key-total-bytes").getAttribute("aria-invalid"), "true");
  assert.equal(ui.window.document.activeElement, ui.element("key-total-requests"));
  ui.element("key-total-requests").value = "25";
  ui.element("key-total-bytes").value = "32768";
  ui.submit("create-form");
  ui.take("/api/credentials", "POST").reply({
    error: { code: "validation_error" }, fields: [{ field: "body.policy.max_total_bytes" }],
  }, 422);
  await flush();
  assert.equal(ui.element("create-step-2").hidden, false);
  assert.equal(ui.element("key-total-bytes").getAttribute("aria-invalid"), "true");
  assert.equal(ui.window.document.activeElement, ui.element("key-total-bytes"));
  assert.equal(ui.element("create-submit").disabled, false);
});

test("lifetime usage shows remaining budgets and exhaustion without changing key lifecycle status", async (t) => {
  const ui = harness(t);
  await ui.connect();
  ui.click("refresh-button");
  ui.take("/api/overview").reply(overview());
  ui.take("/api/events?limit=100").reply({ items: [] });
  ui.take("/api/credentials").reply({ items: [{
    id: "limited-key", name: "Limited integration", prefix: "rg_synthetic", revoked_at: null,
    created_at: "2026-01-01T00:00:00Z", expires_at: "2099-01-01T00:00:00Z",
    policy: { routes: [{ method: "GET", path: "/customers", query_keys: ["limit"] }],
      ip_allowlist: [], requests_per_minute: 30, response_bytes_limit: 16384, bytes_per_minute: 65536,
      max_total_requests: 10, max_total_bytes: 4096 },
    usage: { total_requests: 10, total_bytes: 1024 },
  }] });
  await flush();
  assert.match(ui.element("credentials-body").textContent, /총 요청 한도 도달/);
  ui.window.document.querySelector(".credential-detail-button").click();
  assert.equal(ui.element("detail-status").textContent, "활성");
  assert.equal(ui.element("detail-total-requests-remaining").textContent, "잔여 0건");
  assert.match(ui.element("detail-total-bytes-remaining").textContent, /잔여 3,072바이트/);
  assert.equal(ui.element("detail-budget-status").textContent, "총 요청 한도 도달");
  assert.equal(ui.element("detail-revoke-button").disabled, false);
});
