// Run the shipped application, not a second implementation of its state model.
// JSDOM verifies state and async response ordering; it does not test geometry,
// browser rendering, real clipboard permissions or native dialog accessibility.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM, VirtualConsole } from "jsdom";

const html = readFileSync(new URL("../src/relayguard/static/index.html", import.meta.url), "utf8");
const script = readFileSync(new URL("../src/relayguard/static/app.js", import.meta.url), "utf8");
const catalogScript = readFileSync(new URL("../src/relayguard/static/i18n.js", import.meta.url), "utf8");
const flush = async () => { for (let i = 0; i < 3; i += 1) await new Promise(setImmediate); };
const overview = (overrides = {}) => ({
  demo_mode: true, upstream_origin: "http://127.0.0.1:8811",
  stats: { active_credentials: 0, total_requests: 0, allowed: 0, blocked: 0, bytes_forwarded: 0 },
  audit: { valid: true, event_count: 0, head_hash: "initial-hash" }, recent_events: [], ...overrides,
});

function harness(t, { language = "ko-KR", storage = {} } = {}) {
  const requests = [];
  const errors = [];
  const console = new VirtualConsole();
  console.on("jsdomError", (error) => errors.push(error));
  const dom = new JSDOM(html, {
    url: "http://localhost:8810/", runScripts: "outside-only", virtualConsole: console,
  });
  const { window } = dom;
  window.scrollTo = () => {};
  Object.defineProperty(window.navigator, "language", { value: language, configurable: true });
  for (const [name, value] of Object.entries(storage)) window.localStorage.setItem(name, value);
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
  window.eval(catalogScript);
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
  const credentialsReply = (items) => {
    ui_refresh();
    take("/api/overview").reply(overview());
    take("/api/events?limit=100").reply({ items: [] });
    take("/api/credentials").reply({ items });
  };
  const ui_refresh = () => click("refresh-button");
  return { window, requests, element, take, submit, click, startConnect, finishResources, connect, startCreate, credentialsReply };
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
  ui.element("key-total-bytes-unit").value = "1";
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
  ui.element("key-total-bytes-unit").value = "1";
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

const activeKey = (overrides = {}) => ({
  id: "11111111-2222-4333-8444-555555555555", name: "Billing sync", prefix: "rg_billing1", revoked_at: null,
  created_at: "2026-01-01T00:00:00Z", expires_at: "2099-01-01T00:00:00Z",
  policy: { routes: [{ method: "GET", path: "/invoices/*", query_keys: ["page"] }], ip_allowlist: [], requests_per_minute: 30,
    response_bytes_limit: 16384, bytes_per_minute: 65536, max_total_requests: null, max_total_bytes: null, forward_error_statuses: [404] },
  usage: { total_requests: 3, total_bytes: 512, minute_requests: 2, minute_bytes: 300 }, ...overrides,
});

test("default issuance converts units and keeps per-route query keys", async (t) => {
  const ui = harness(t);
  await ui.connect();
  ui.click("create-key-button");
  ui.element("key-name").value = "Per-route integration";
  const rows = ui.window.document.querySelectorAll("#route-list .route-row");
  assert.equal(rows.length, 2);
  rows[1].querySelector(".route-query").value = "";
  ui.click("add-route-button");
  const added = ui.window.document.querySelectorAll("#route-list .route-row")[2];
  added.querySelector(".route-method").value = "POST";
  added.querySelector(".route-path").value = "/customers/*/notes";
  added.querySelector(".route-query").value = "draft, notify";
  ui.click("create-next-button");
  ui.window.document.querySelector('#forward-statuses input[value="404"]').checked = true;
  ui.submit("create-form");
  const body = JSON.parse(ui.take("/api/credentials", "POST").options.body);
  assert.deepEqual(body.policy.routes, [
    { method: "GET", path: "/customers", query_keys: ["limit"] },
    { method: "GET", path: "/customers/*", query_keys: [] },
    { method: "POST", path: "/customers/*/notes", query_keys: ["draft", "notify"] },
  ]);
  assert.equal(body.policy.response_bytes_limit, 16384);
  assert.equal(body.policy.bytes_per_minute, 65536);
  assert.deepEqual(body.policy.forward_error_statuses, [404]);
});

test("an invalid route stays in step one and focuses the offending row", async (t) => {
  const ui = harness(t);
  await ui.connect();
  ui.click("create-key-button");
  ui.element("key-name").value = "Broken path";
  const path = ui.window.document.querySelector("#route-list .route-path");
  path.value = "/customers/../admin";
  ui.click("create-next-button");
  assert.equal(ui.element("create-step-1").hidden, false);
  assert.equal(path.getAttribute("aria-invalid"), "true");
  assert.equal(ui.window.document.activeElement, path);
  assert.equal(ui.element("key-routes-error").hidden, false);
});

test("rotating an active key posts one atomic rotation and reports the old key's grace period", async (t) => {
  const ui = harness(t);
  await ui.connect();
  ui.credentialsReply([activeKey()]);
  await flush();
  ui.window.document.querySelector(".credential-detail-button").click();
  assert.equal(ui.element("detail-reissue-button").textContent.trim(), "키 교체하기");
  ui.click("detail-reissue-button");
  await flush();
  assert.equal(ui.element("create-dialog").open, true);
  assert.equal(ui.element("key-name").value, "Billing sync (교체)");
  assert.equal(ui.window.document.querySelector("#route-list .route-path").value, "/invoices/*");
  ui.click("create-next-button");
  assert.equal(ui.element("rotation-fields").hidden, false);
  assert.equal(ui.window.document.querySelector('#forward-statuses input[value="404"]').checked, true);
  ui.element("rotation-mode").value = "24";
  ui.submit("create-form");
  const request = ui.take("/api/credentials/11111111-2222-4333-8444-555555555555/rotate", "POST");
  const body = JSON.parse(request.options.body);
  assert.equal(body.grace_hours, 24);
  assert.deepEqual(body.credential.policy.routes, [{ method: "GET", path: "/invoices/*", query_keys: ["page"] }]);
  request.reply({ token: "rg_rotated_secret", credential: { id: "new" }, replaced: activeKey() }, 201);
  await flush();
  assert.equal(ui.element("new-key").value, "rg_rotated_secret");
  assert.match(ui.element("key-replaced-note").textContent, /24시간 뒤 만료/);
});

test("activity shows key names and request ids, and filters are applied on the server", async (t) => {
  const ui = harness(t);
  await ui.connect();
  ui.credentialsReply([activeKey()]);
  await flush();
  ui.click("refresh-button");
  ui.take("/api/overview").reply(overview());
  ui.take("/api/credentials").reply({ items: [activeKey()] });
  ui.take("/api/events?limit=100").reply({ items: [{ id: 9, ts: "2026-01-01T00:00:00Z", kind: "proxy", decision: "error", reason: "upstream_rejected",
    method: "GET", path: "[unmatched]", status: 502, upstream_status: 404, response_bytes: 0, peer_ip: "198.51.100.8",
    request_id: "abcdef0123456789abcdef0123456789", credential_id: "11111111-2222-4333-8444-555555555555" }], next_before_id: 9 });
  await flush();
  const body = ui.element("events-body").textContent;
  assert.match(body, /Billing sync/);
  assert.match(body, /원본 API 오류 응답/);
  assert.match(body, /원본 404/);
  assert.match(body, /정책에 없는 경로/);
  assert.match(body, /요청 ID abcdef012345/);
  assert.match(body, /198\.51\.100\.8/);
  assert.equal(ui.element("events-more-button").hidden, false);
  ui.element("event-kind").value = "proxy";
  ui.element("event-kind").dispatchEvent(new ui.window.Event("change"));
  ui.take("/api/events?limit=100&kind=proxy").reply({ items: [] });
  ui.element("event-key").value = "11111111-2222-4333-8444-555555555555";
  ui.element("event-key").dispatchEvent(new ui.window.Event("change"));
  ui.element("event-period").value = "24";
  ui.element("event-period").dispatchEvent(new ui.window.Event("change"));
  ui.take("/api/events?limit=100&kind=proxy&credential_id=11111111-2222-4333-8444-555555555555&since_hours=24");
});

test("loading older activity appends pages and ignores a page from a replaced filter", async (t) => {
  const ui = harness(t);
  await ui.connect();
  const item = (id) => ({ id, ts: "2026-01-01T00:00:00Z", kind: "proxy", decision: "allow", reason: "forwarded", method: "GET", path: `/p${id}`, status: 200, response_bytes: 1 });
  ui.click("refresh-button");
  ui.take("/api/overview").reply(overview());
  ui.take("/api/credentials").reply({ items: [] });
  ui.take("/api/events?limit=100").reply({ items: [item(200), item(150)], next_before_id: 150 });
  await flush();
  ui.click("events-more-button");
  ui.take("/api/events?limit=100&before_id=150").reply({ items: [item(120)], next_before_id: null });
  await flush();
  assert.match(ui.element("events-body").textContent, /\/p120/);
  assert.equal(ui.element("events-more-button").hidden, true);
  ui.click("refresh-button");
  ui.take("/api/overview").reply(overview());
  ui.take("/api/credentials").reply({ items: [] });
  ui.take("/api/events?limit=100").reply({ items: [item(300)], next_before_id: 300 });
  await flush();
  ui.click("events-more-button");
  const stale = ui.take("/api/events?limit=100&before_id=300");
  ui.window.document.querySelector('.filter-button[data-decision="deny"]').click();
  ui.take("/api/events?limit=100&decision=deny").reply({ items: [{ ...item(5), decision: "deny", path: "/current" }] });
  await flush();
  stale.reply({ items: [item(1)], next_before_id: null });
  await flush();
  assert.match(ui.element("events-body").textContent, /\/current/);
  assert.doesNotMatch(ui.element("events-body").textContent, /\/p1\b/);
});

test("policy test uses the server rules without issuing a key", async (t) => {
  const ui = harness(t);
  await ui.connect();
  ui.click("create-key-button");
  ui.element("key-name").value = "Tested";
  ui.click("create-next-button");
  ui.element("test-requests").value = "get /customers/5?limit=1\nGET /exports";
  ui.element("test-ip").value = "198.51.100.7";
  ui.click("test-button");
  const request = ui.take("/api/policy/check", "POST");
  const body = JSON.parse(request.options.body);
  assert.deepEqual(body.cases, [{ method: "GET", path: "/customers/5?limit=1", peer_ip: "198.51.100.7" }, { method: "GET", path: "/exports", peer_ip: "198.51.100.7" }]);
  request.reply({ results: [
    { method: "GET", path: "/customers/5?limit=1", decision: "allow", code: "allowed", matched_route: { method: "GET", path: "/customers/*" }, ip_checked: true },
    { method: "GET", path: "/exports", decision: "deny", code: "route_denied", matched_route: null, ip_checked: true },
  ] });
  await flush();
  const results = ui.element("test-results").textContent;
  assert.match(results, /적용 규칙: GET \/customers\/\*/);
  assert.match(results, /허용되지 않은 경로/);
  assert.equal(ui.requests.some((item) => item.url === "/api/credentials" && item.options.method === "POST"), false);
});

test("imported JSON fills every policy field", async (t) => {
  const ui = harness(t);
  await ui.connect();
  ui.click("create-key-button");
  ui.element("import-json").value = JSON.stringify({ policy: { routes: [{ method: "GET", path: "/" }], surprise: true } });
  ui.click("import-apply");
  assert.match(ui.element("import-error").textContent, /surprise/);
  ui.element("import-json").value = JSON.stringify({ name: "Imported", ttl_hours: 6, policy: {
    routes: [{ method: "DELETE", path: "/sessions/*" }], ip_allowlist: ["10.0.0.0/8"], requests_per_minute: 5,
    response_bytes_limit: 2048, bytes_per_minute: 1048576, max_total_requests: 50, max_total_bytes: 3145728, forward_error_statuses: [409] } });
  ui.click("import-apply");
  assert.equal(ui.element("import-error").hidden, true);
  assert.equal(ui.element("key-name").value, "Imported");
  assert.equal(ui.window.document.querySelector("#route-list .route-method").value, "DELETE");
  ui.click("create-next-button");
  assert.equal(ui.element("key-response").value, "2");
  assert.equal(ui.element("key-response-unit").value, "1024");
  assert.equal(ui.element("key-budget-unit").value, "1048576");
  ui.submit("create-form");
  const policy = JSON.parse(ui.take("/api/credentials", "POST").options.body).policy;
  assert.equal(policy.max_total_bytes, 3145728);
  assert.deepEqual(policy.ip_allowlist, ["10.0.0.0/8"]);
  assert.deepEqual(policy.forward_error_statuses, [409]);
});

test("inactive keys are hidden by default and attention lists keys that expire soon", async (t) => {
  const ui = harness(t);
  await ui.connect();
  const soon = new Date(Date.now() + 3 * 3600e3).toISOString();
  ui.credentialsReply([activeKey({ id: "aaaaaaaa-2222-4333-8444-555555555555", name: "Soon", expires_at: soon }),
    activeKey({ id: "bbbbbbbb-2222-4333-8444-555555555555", name: "Old demo", revoked_at: "2026-01-02T00:00:00Z" })]);
  await flush();
  assert.match(ui.element("credentials-body").textContent, /Soon/);
  assert.doesNotMatch(ui.element("credentials-body").textContent, /Old demo/);
  assert.match(ui.element("credentials-body").textContent, /곧 만료/);
  assert.match(ui.element("attention-list").textContent, /Soon/);
  ui.element("credential-status").value = "all";
  ui.element("credential-status").dispatchEvent(new ui.window.Event("change"));
  assert.match(ui.element("credentials-body").textContent, /Old demo/);
});

test("CSV export neutralizes spreadsheet formulas", async (t) => {
  const ui = harness(t);
  await ui.connect();
  let blob;
  ui.window.URL.createObjectURL = (value) => { blob = value; return "blob:synthetic"; };
  ui.window.URL.revokeObjectURL = () => {};
  ui.window.HTMLAnchorElement.prototype.click = () => {};
  ui.click("refresh-button");
  ui.take("/api/overview").reply(overview());
  ui.take("/api/credentials").reply({ items: [activeKey({ name: "=HYPERLINK(\"x\")" })] });
  ui.take("/api/events?limit=100").reply({ items: [{ id: 1, ts: "2026-01-01T00:00:00Z", kind: "proxy", decision: "allow", reason: "forwarded",
    method: "GET", path: "/invoices/*", status: 200, response_bytes: 10, credential_id: "11111111-2222-4333-8444-555555555555" }] });
  await flush();
  ui.click("event-export-button");
  const csv = await blob.text();
  assert.match(csv, /^id,ts,kind,decision/);
  assert.match(csv, /"'=HYPERLINK\(""x""\)"/);
});

test("the console renders in English and switches language without storing secrets", async (t) => {
  const ui = harness(t, { language: "en-US" });
  assert.equal(ui.window.document.documentElement.lang, "en");
  assert.equal(ui.element("page-title").textContent, "Connect workspace");
  assert.equal(ui.element("gate-connect-button").textContent.trim(), "Connect as admin");
  assert.equal(ui.element("admin-token").getAttribute("placeholder"), "Paste the admin token");
  assert.match(ui.element("connect-description").textContent, /RELAYGUARD_ADMIN_TOKEN/);
  await ui.connect();
  assert.equal(ui.element("page-title").textContent, "Overview");
  assert.equal(ui.window.localStorage.length, 0);
  ui.click("language-button");
  assert.equal(ui.window.document.documentElement.lang, "ko");
  assert.equal(ui.element("page-title").textContent, "보안 개요");
  assert.equal(ui.element("gate-title").textContent, "필요한 권한만 주고, 모든 접근을 확인하세요.");
  assert.equal(ui.window.localStorage.getItem("relayguard.lang"), "ko");
  ui.click("language-button");
  assert.equal(ui.element("refresh-button").textContent.trim(), "Refresh");
  assert.equal(ui.window.localStorage.length, 1);
});

test("a stored theme preference is applied and cycles through system, light and dark", (t) => {
  const ui = harness(t, { storage: { "relayguard.theme": "dark" } });
  assert.equal(ui.window.document.documentElement.dataset.theme, "dark");
  ui.click("theme-button");
  assert.equal(ui.window.document.documentElement.dataset.theme, undefined);
  ui.click("theme-button");
  assert.equal(ui.window.document.documentElement.dataset.theme, "light");
  assert.equal(ui.window.localStorage.getItem("relayguard.theme"), "light");
});

test("the 24 hour chart and stats render from overview data", async (t) => {
  const ui = harness(t);
  const hourly = Array.from({ length: 24 }, (_, index) => ({ hour: new Date(Date.UTC(2026, 0, 1, index)).toISOString(), allowed: index === 23 ? 7 : 0, blocked: index === 23 ? 2 : 0, bytes: 0 }));
  ui.startConnect().reply(overview({ stats: { active_credentials: 1, total_requests: 50, allowed: 40, blocked: 10, bytes_forwarded: 2048,
    last_24h: { total: 9, allowed: 7, blocked: 2, bytes_forwarded: 1024 }, hourly } }));
  await flush();
  ui.finishResources();
  await flush();
  assert.equal(ui.element("stat-day-total").textContent, "9");
  assert.equal(ui.element("stat-total").textContent, "50건");
  const columns = ui.element("traffic-chart").querySelectorAll(".chart-column");
  assert.equal(columns.length, 24);
  assert.match(columns[23].getAttribute("aria-label"), /허용 7건, 차단·오류 2건/);
  assert.equal(columns[23].querySelectorAll(".chart-segment").length, 2);
  assert.equal(ui.element("traffic-table-body").children.length, 24);
  assert.equal(ui.element("traffic-empty").hidden, true);
});

test("every visible Korean string has an English translation", () => {
  const dom = new JSDOM(html);
  const { document, NodeFilter } = dom.window;
  const sandbox = new JSDOM("", { runScripts: "outside-only" }).window;
  sandbox.eval(catalogScript);
  const catalog = sandbox.RelayGuardI18n.en;
  const hangul = /[ㄱ-힝]/;
  const needed = new Set();
  document.querySelectorAll("[data-i18n]").forEach((element) => needed.add(element.dataset.i18n));
  const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_TEXT, { acceptNode(textNode) {
    const parent = textNode.parentElement;
    if (!parent || parent.closest("[data-i18n], [data-no-i18n], script, style, code, textarea")) return NodeFilter.FILTER_REJECT;
    return hangul.test(textNode.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
  } });
  for (let textNode = walker.nextNode(); textNode; textNode = walker.nextNode()) needed.add(textNode.nodeValue.trim());
  for (const attribute of ["placeholder", "aria-label", "title"]) {
    document.querySelectorAll(`[${attribute}]`).forEach((element) => {
      if (!element.closest("[data-no-i18n]") && hangul.test(element.getAttribute(attribute))) needed.add(element.getAttribute(attribute));
    });
  }
  for (const match of script.matchAll(/"((?:[^"\\\n]|\\.)*)"/g)) if (hangul.test(match[1])) needed.add(JSON.parse(`"${match[1]}"`));
  const allowedUntranslated = new Set(["한국어", "Language: 한국어. Switch to English", "언어: English. 한국어로 바꾸기"]);
  const missing = [...needed].filter((key) => !allowedUntranslated.has(key) && !Object.hasOwn(catalog, key));
  assert.deepEqual(missing, []);
});
