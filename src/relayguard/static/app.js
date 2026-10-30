"use strict";

(() => {
  const $ = (id) => document.getElementById(id);
  const on = (id, event, handler) => $(id)?.addEventListener(event, handler);
  const list = (value) => Array.isArray(value) ? value : [];
  const state = {
    token: "", phase: "disconnected", epoch: 0, view: "overview", demoMode: false,
    controllers: new Set(), pending: new Map(), sequence: 0, auditSequence: 0, resources: {},
    credentials: [], events: [], decision: "", credentialSearch: "", credentialStatus: "all", eventSearch: "",
    detailId: null, revokeId: null, createStep: 1, secretVersion: 0, headHash: "", returnFocus: new Map()
  };
  const views = {
    overview: ["보안 개요", "키의 접근 범위와 요청 처리 현황을 한눈에 확인하세요."],
    credentials: ["릴레이 키", "필요한 권한만 부여하고, 사용이 끝난 키는 폐기하세요."],
    activity: ["활동 기록", "허용과 차단의 이유를 확인하고 필요한 기록을 찾아보세요."],
    audit: ["감사 무결성", "기록의 무결성을 검증하고 별도 보관할 사본을 내려받으세요."]
  };
  const reasons = {
    allowed: "정책 허용", forwarded: "응답 전달", policy_allowed: "정책 허용", success: "요청 허용",
    token_created: "키 발급", credential_created: "키 발급", created: "키 발급", credential_revoked: "키 폐기", revoked: "키 폐기",
    token_revoked: "폐기된 키", token_expired: "만료된 키", rate_limit: "분당 요청 수 초과", byte_budget: "분당 응답량 초과",
    lifetime_request_limit: "키의 총 요청 한도 도달", lifetime_byte_budget: "키의 총 응답 사용량 초과",
    invalid_token: "유효하지 않은 키", missing_token: "인증 정보 없음", missing_authorization: "인증 정보 없음", invalid_authorization: "인증 형식 오류",
    invalid_path: "안전하지 않은 경로", route_denied: "허용되지 않은 경로", route_not_allowed: "허용되지 않은 경로", policy_denied: "정책 위반",
    method_not_allowed: "허용되지 않은 메서드", query_denied: "허용되지 않은 쿼리", query_not_allowed: "허용되지 않은 쿼리", invalid_query: "쿼리 형식 오류",
    ip_denied: "허용되지 않은 IP", ip_not_allowed: "허용되지 않은 IP", request_too_large: "요청 크기 초과", response_too_large: "응답 크기 초과",
    upstream_error: "업스트림 오류", upstream_timeout: "업스트림 시간 초과", upstream_redirect: "업스트림 리디렉션 차단", upstream_compression: "압축 응답 거부",
    audit_failure: "감사 기록 실패", invalid_content_type: "허용되지 않은 콘텐츠 유형"
  };
  const decisions = { "": "전체", allow: "허용", deny: "차단", error: "오류" };
  const numberFormat = new Intl.NumberFormat("ko-KR");
  const dateFormat = new Intl.DateTimeFormat("ko-KR", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  const fullDateFormat = new Intl.DateTimeFormat("ko-KR", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
  const timeFormat = new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  const formFields = {
    "key-name": 1, "key-ttl": 1, "key-routes": 1, "key-query": 1,
    "key-rate": 2, "key-response": 2, "key-budget": 2, "key-total-requests": 2, "key-total-bytes": 2, "key-ips": 2
  };
  const buttonLabels = new Map();
  let toastTimer;

  function node(tag, className, content) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (content !== undefined && content !== null) element.textContent = String(content);
    return element;
  }
  function text(id, value) { if ($(id)) $(id).textContent = String(value ?? ""); }
  function hide(id, hidden) { if ($(id)) $(id).hidden = hidden; }
  function badge(content, kind = "neutral") { return node("span", `badge badge-${kind}`, content); }
  function count(value) { return Number.isFinite(value) ? numberFormat.format(value) : "—"; }
  function date(value, full = false) {
    const parsed = new Date(value);
    return value && Number.isFinite(parsed.getTime()) ? (full ? fullDateFormat : dateFormat).format(parsed) : "—";
  }
  function bytes(value) {
    if (!Number.isFinite(value)) return "—";
    if (value < 1024) return `${count(value)} B`;
    const units = ["B", "KB", "MB", "GB", "TB"];
    const unit = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
    return `${numberFormat.format(Math.round(value / 1024 ** unit * 10) / 10)} ${units[unit]}`;
  }
  function notice(id, message) { text(id, message); hide(id, !message); }
  function globalError(message) { notice("global-error", message); hide("retry-button", !message || state.phase !== "connected"); }
  function toast(message) {
    clearTimeout(toastTimer);
    text("toast", message);
    hide("toast", false);
    toastTimer = setTimeout(() => hide("toast", true), 4500);
  }
  function focus(id) { $(id)?.focus(); }
  function connected() { return state.phase === "connected"; }
  function current(epoch) { return epoch === state.epoch; }
  function cancelled(error) { return error?.name === "AbortError" || error?.kind === "auth"; }
  function buttonState(id, disabled, loading = false, label = "처리 중") {
    const button = $(id);
    if (!button) return;
    let labelNode = button.querySelector(".button-label");
    if (!labelNode) {
      labelNode = node("span", "button-label");
      const textNodes = Array.from(button.childNodes).filter((child) => child.nodeType === Node.TEXT_NODE);
      button.insertBefore(labelNode, textNodes[0] || null);
      for (const child of textNodes) labelNode.append(child);
    }
    if (!buttonLabels.has(id)) buttonLabels.set(id, labelNode.textContent.trim());
    labelNode.textContent = loading ? label : buttonLabels.get(id);
    button.disabled = disabled;
    button.classList.toggle("is-busy", loading);
    if (loading) button.setAttribute("aria-busy", "true"); else button.removeAttribute("aria-busy");
  }
  function renderControls() {
    const auth = connected();
    const busy = (key) => state.pending.has(key);
    document.body.dataset.connected = String(auth);
    hide("workspace-content", !auth);
    hide("session-gate", auth);
    hide("connect-button", auth);
    hide("disconnect-button", !auth);
    hide("last-updated", !auth);
    hide("refresh-button", !auth);
    const status = $("connection-status");
    if (status) {
      status.classList.toggle("connected", auth);
      const dot = node("span", "status-dot");
      dot.setAttribute("aria-hidden", "true");
      status.replaceChildren(dot, document.createTextNode(auth ? "관리자 연결됨" : state.phase === "connecting" ? "연결 중" : "연결 안 됨"));
    }
    buttonState("connect-submit", busy("connect"), busy("connect"), "연결 중");
    for (const id of ["connect-button", "gate-connect-button"]) buttonState(id, busy("connect"));
    buttonState("refresh-button", !auth || busy("refresh"), busy("refresh"), "새로고침 중");
    for (const id of ["create-key-button", "overview-create-button", "empty-create-button"]) buttonState(id, !auth || busy("create"));
    buttonState("demo-button", !auth || !state.demoMode || busy("demo"), busy("demo"), "검증 중");
    buttonState("verify-button", !auth || busy("verify"), busy("verify"), "검증 중");
    buttonState("export-button", !auth || busy("export"), busy("export"), "내보내는 중");
    buttonState("copy-hash-button", !auth || !state.headHash || busy("copyHash"), busy("copyHash"), "복사 중");
    buttonState("create-submit", busy("create"), busy("create"), "발급 중");
    buttonState("create-next-button", busy("create"));
    buttonState("create-back-button", busy("create"));
    for (const id of Object.keys(formFields)) if ($(id)) $(id).disabled = busy("create");
    buttonState("revoke-submit", busy("revoke"), busy("revoke"), "폐기 중");
    buttonState("revoke-cancel-button", busy("revoke"));
    buttonState("copy-key-button", !$("new-key")?.value || busy("copyKey"), busy("copyKey"), "복사 중");
    buttonState("key-done-button", !$("key-saved")?.checked);
    for (const kind of ["create", "revoke"]) {
      document.querySelectorAll(`[data-close="${kind}-dialog"]`).forEach((button) => { button.disabled = busy(kind); });
    }
    buttonState("create-close-button", busy("create"));
    document.querySelectorAll(".filter-button").forEach((button) => { button.disabled = !auth; });
    for (const id of ["credential-search", "credential-status", "event-search"]) if ($(id)) $(id).disabled = !auth;
    const detail = state.credentials.find((item) => item.id === state.detailId);
    buttonState("detail-revoke-button", !auth || !detail || credentialStatus(detail) !== "active" || busy("revoke"));
  }
  function begin(key) {
    if (state.pending.has(key)) return null;
    const operation = { key, epoch: state.epoch, id: ++state.sequence };
    state.pending.set(key, operation);
    renderControls();
    return operation;
  }
  function active(operation) { return operation && current(operation.epoch) && state.pending.get(operation.key) === operation; }
  function finish(operation) {
    if (active(operation)) { state.pending.delete(operation.key); renderControls(); }
  }
  function setView(moveFocus = false) {
    const requested = location.hash.slice(1);
    state.view = Object.hasOwn(views, requested) ? requested : "overview";
    if (requested && requested !== state.view) history.replaceState(null, "", "#overview");
    document.querySelectorAll("[data-view]").forEach((element) => { element.hidden = element.dataset.view !== state.view; });
    document.querySelectorAll("[data-view-link]").forEach((link) => {
      const selected = link.dataset.viewLink === state.view;
      link.classList.toggle("active", selected);
      if (selected) link.setAttribute("aria-current", "page"); else link.removeAttribute("aria-current");
    });
    text("page-title", connected() ? views[state.view][0] : "워크스페이스 연결");
    text("page-description", connected() ? views[state.view][1] : "관리자 토큰으로 연결하고 서비스의 접근 범위를 관리하세요.");
    text("breadcrumb-current", connected() ? views[state.view][0] : "시작하기");
    if (moveFocus) { focus("page-title"); window.scrollTo(0, 0); }
  }
  function openDialog(id, initialFocus, trigger = document.activeElement) {
    const dialog = $(id);
    if (!dialog || dialog.open) return;
    state.returnFocus.set(id, trigger);
    dialog.showModal();
    if (initialFocus) focus(initialFocus);
  }
  function wipeSecret() {
    state.secretVersion += 1;
    state.pending.delete("copyKey");
    if ($("new-key")) { $("new-key").value = ""; $("new-key").textContent = ""; }
    if ($("key-saved")) $("key-saved").checked = false;
    text("copy-feedback", "");
    hide("key-discard-warning", true);
    hide("key-discard-button", true);
  }
  function requestClose(id, force = false) {
    if (!force && id === "connect-dialog" && state.phase === "connecting") {
      resetSession();
      return;
    }
    if (!force && ((id === "create-dialog" && state.pending.has("create")) || (id === "revoke-dialog" && state.pending.has("revoke")))) return;
    if (id === "key-dialog" && !force && !$("key-saved")?.checked) {
      hide("key-discard-warning", false);
      hide("key-discard-button", false);
      focus("key-saved");
      return;
    }
    if (id === "key-dialog") wipeSecret();
    if ($(id)?.open) $(id).close();
  }
  function resetSession({ keepConnect = false } = {}) {
    state.epoch += 1;
    for (const controller of state.controllers) controller.abort();
    state.controllers.clear();
    state.token = "";
    state.phase = "disconnected";
    state.pending.clear();
    state.resources = {};
    state.credentials = [];
    state.events = [];
    state.decision = "";
    state.credentialSearch = "";
    state.credentialStatus = "all";
    state.eventSearch = "";
    state.detailId = null;
    state.revokeId = null;
    state.headHash = "";
    state.auditSequence = 0;
    wipeSecret();
    for (const id of ["create-dialog", "key-dialog", "detail-dialog", "revoke-dialog", ...(!keepConnect ? ["connect-dialog"] : [])]) requestClose(id, true);
    for (const id of ["admin-token", "credential-search", "event-search"]) if ($(id)) $(id).value = "";
    if ($("credential-status")) $("credential-status").value = "all";
    for (const id of ["credentials-body", "events-body", "overview-recent", "scenario-list", "detail-routes"]) $(id)?.replaceChildren();
    for (const name of ["active", "total", "allowed", "blocked", "bytes"]) text(`stat-${name}`, "—");
    for (const id of ["credential-count", "audit-event-count"]) text(id, "—");
    for (const id of ["upstream-origin", "audit-hash"]) { text(id, "연결 후 표시됩니다"); $(id)?.removeAttribute("title"); }
    for (const id of ["credentials-error", "events-error", "audit-error", "create-error", "revoke-error", "connect-error"]) notice(id, "");
    for (const id of ["credentials-retry", "events-retry", "demo-results"]) hide(id, true);
    globalError("");
    clearTimeout(toastTimer);
    hide("toast", true);
    text("last-updated", "");
    text("audit-checked-at", "아직 검증하지 않았습니다");
    text("audit-description", "연결 후 감사 로그를 검증할 수 있습니다.");
    text("audit-badge", "확인 전");
    if ($("audit-badge")) $("audit-badge").className = "badge badge-neutral";
    renderCredentials();
    renderEvents();
    renderControls();
    setView();
  }
  function apiError(message, kind, extra = {}) { return Object.assign(new Error(message), { kind, ...extra }); }
  async function api(path, { method = "GET", body, timeout = method === "GET" ? 12000 : 30000 } = {}) {
    const epoch = state.epoch;
    if (!state.token) throw new DOMException("No active session", "AbortError");
    const controller = new AbortController();
    state.controllers.add(controller);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeout);
    try {
      const response = await fetch(path, {
        method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        headers: { Accept: "application/json", ...(body !== undefined ? { "Content-Type": "application/json" } : {}), Authorization: `Bearer ${state.token}` },
        credentials: "omit", redirect: "error", cache: "no-store", signal: controller.signal
      });
      if (!current(epoch)) throw new DOMException("Session changed", "AbortError");
      if (response.status === 401) {
        const connecting = state.phase === "connecting";
        resetSession({ keepConnect: connecting });
        if (connecting) { notice("connect-error", "관리자 토큰이 올바르지 않습니다. 토큰을 확인하고 다시 입력하세요."); focus("admin-token"); }
        else { globalError("관리자 인증이 만료되었거나 변경되었습니다. 다시 연결해 주세요."); focus("gate-connect-button"); }
        throw apiError("관리자 인증이 필요합니다.", "auth");
      }
      let result;
      try { result = await response.json(); }
      catch (error) {
        if (controller.signal.aborted || !current(epoch)) throw error;
        throw apiError("서버 응답을 읽지 못했습니다. 잠시 후 다시 시도하세요.", "response", { uncertain: method !== "GET" });
      }
      if (!current(epoch)) throw new DOMException("Session changed", "AbortError");
      if (!response.ok) {
        if (response.status === 422) throw apiError("입력한 값을 확인해 주세요.", "validation", { fields: list(result.fields) });
        const message = response.status === 404 && path === "/api/demo/run" ? "이 서버에서는 데모를 실행할 수 없습니다." : response.status === 403 ? "이 작업을 수행할 권한이 없습니다." : response.status === 429 ? "요청이 많습니다. 잠시 후 다시 시도하세요." : "서버가 요청을 완료하지 못했습니다. 잠시 후 다시 시도하세요.";
        throw apiError(message, "server", { status: response.status, uncertain: method !== "GET" && response.status >= 500 });
      }
      return result;
    } catch (error) {
      if (!current(epoch) && error.kind !== "auth") throw new DOMException("Session changed", "AbortError");
      if (timedOut) throw apiError("서버 응답이 늦어지고 있습니다. 잠시 후 다시 시도하세요.", "timeout", { uncertain: method !== "GET" });
      if (error instanceof TypeError) throw apiError("서버에 연결할 수 없습니다. 서버와 네트워크 상태를 확인하세요.", "network", { uncertain: method !== "GET" });
      throw error;
    } finally { clearTimeout(timer); state.controllers.delete(controller); }
  }
  async function loadResource(name, path, render, errorId) {
    if (!connected()) return;
    const request = { id: ++state.sequence, epoch: state.epoch, status: "loading", error: "" };
    state.resources[name] = request;
    if (name === "overview") state.auditSequence = request.id;
    if (errorId === "global-error") globalError(""); else notice(errorId, "");
    if (name === "credentials") renderCredentials();
    if (name === "events") renderEvents();
    try {
      const result = await api(path);
      if (!current(request.epoch) || state.resources[name] !== request) return;
      request.status = "ready";
      render(result, request);
    } catch (error) {
      if (!current(request.epoch) || state.resources[name] !== request || cancelled(error)) return;
      request.status = "error";
      request.error = error.message;
      if (errorId === "global-error") globalError(error.message); else notice(errorId, error.message);
      if (name === "credentials") renderCredentials();
      if (name === "events") renderEvents();
    }
  }
  function renderAudit(audit = {}, sequence = ++state.sequence) {
    if (sequence < state.auditSequence) return;
    state.auditSequence = sequence;
    const valid = audit.valid === true;
    const label = valid ? "무결성 확인" : "확인 필요";
    const message = valid ? `${count(audit.event_count)}개 기록의 해시 연결이 일치합니다.` : "감사 기록의 연결이 일치하지 않습니다. 외부 보관 기록과 비교해 주세요.";
    text("audit-badge", label);
    if ($("audit-badge")) $("audit-badge").className = `badge badge-${valid ? "allow" : "error"}`;
    text("overview-audit-status", label);
    const auditDot = $("overview-audit-status")?.parentElement.querySelector(".status-dot");
    auditDot?.classList.toggle("success", valid);
    auditDot?.classList.toggle("error", !valid);
    text("audit-description", message);
    text("overview-audit-copy", message);
    text("audit-event-count", count(audit.event_count));
    state.headHash = typeof audit.head_hash === "string" ? audit.head_hash : "";
    text("audit-hash", state.headHash || "저장된 기록이 없습니다");
    if ($("audit-hash")) $("audit-hash").title = state.headHash;
    text("audit-checked-at", `${date(new Date().toISOString(), true)} 확인`);
    renderControls();
  }
  function renderOverview(data, request) {
    state.demoMode = data.demo_mode === true;
    hide("demo-banner", !state.demoMode);
    text("environment-label", state.demoMode ? "로컬 데모" : "운영 환경");
    text("overview-mode", state.demoMode ? "데모 환경" : "운영 환경");
    const stats = data.stats || {};
    for (const [id, value] of Object.entries({ active: stats.active_credentials, total: stats.total_requests, allowed: stats.allowed, blocked: stats.blocked })) text(`stat-${id}`, count(value));
    text("stat-bytes", bytes(stats.bytes_forwarded));
    text("overview-active-summary", `만료되거나 폐기되지 않은 키가 ${count(stats.active_credentials)}개 있습니다. 사용량 한도는 각 키에서 확인하세요.`);
    text("upstream-origin", data.upstream_origin || "—");
    if ($("upstream-origin")) $("upstream-origin").title = data.upstream_origin || "";
    renderAudit(data.audit, request?.id);
    text("last-updated", `${timeFormat.format(new Date())} 업데이트`);
    const recent = list(data.recent_events).filter((event) => event.kind === "proxy").slice(0, 5);
    $("overview-recent")?.replaceChildren();
    hide("overview-recent-empty", recent.length > 0);
    for (const event of recent) {
      const item = node("li", "recent-item");
      const main = node("div", "recent-main");
      main.append(badge(decisions[event.decision] || "기록", decisions[event.decision] ? event.decision : "neutral"), node("span", "path-label", `${event.method || ""} ${event.path || "프록시 요청"}`.trim()));
      const meta = node("div", "recent-meta");
      meta.append(node("span", "", reasons[event.reason] || event.reason || "—"), node("time", "", date(event.ts)));
      item.append(main, meta);
      $("overview-recent")?.append(item);
    }
    renderControls();
  }
  function credentialStatus(credential) { return credential.revoked_at ? "revoked" : new Date(credential.expires_at).getTime() <= Date.now() ? "expired" : "active"; }
  function statusLabel(status) { return { active: "활성", expired: "만료", revoked: "폐기" }[status] || "확인 필요"; }
  function lifetimeBudget(credential) {
    const policy = credential.policy || {};
    const usage = credential.usage || {};
    const requests = Math.max(0, Number.isFinite(usage.total_requests) ? usage.total_requests : 0);
    const responseBytes = Math.max(0, Number.isFinite(usage.total_bytes) ? usage.total_bytes : 0);
    const requestLimit = Number.isFinite(policy.max_total_requests) ? policy.max_total_requests : null;
    const byteLimit = Number.isFinite(policy.max_total_bytes) ? policy.max_total_bytes : null;
    const requestRemaining = requestLimit === null ? null : Math.max(0, requestLimit - requests);
    const byteRemaining = byteLimit === null ? null : Math.max(0, byteLimit - responseBytes);
    const exhausted = [];
    if (requestRemaining === 0) exhausted.push("총 요청 한도 도달");
    if (byteRemaining === 0) exhausted.push("총 응답 한도 도달");
    return { requests, responseBytes, requestLimit, byteLimit, requestRemaining, byteRemaining, exhausted };
  }
  function cell(label, content, className = "") {
    const element = node("td", className);
    element.dataset.label = label;
    if (content instanceof Node) element.append(content); else element.textContent = String(content ?? "—");
    return element;
  }
  function emptyState(id, heading, description) {
    const element = $(id);
    if (!element) return;
    element.hidden = false;
    const strong = element.querySelector("strong");
    const paragraph = element.querySelector("p");
    if (strong) strong.textContent = heading;
    if (paragraph) paragraph.textContent = description;
  }
  function renderCredentials() {
    const resource = state.resources.credentials;
    const loading = resource?.status === "loading";
    const failed = resource?.status === "error";
    $("credentials")?.setAttribute("aria-busy", String(loading));
    hide("credentials-retry", !failed);
    text("credential-count", connected() ? count(state.credentials.length) : "—");
    $("credentials-body")?.replaceChildren();
    const query = state.credentialSearch.toLocaleLowerCase("ko-KR");
    const items = state.credentials.filter((item) => {
      const haystack = [item.name, item.prefix, ...list(item.policy?.routes).map((route) => `${route.method} ${route.path}`)].join(" ").toLocaleLowerCase("ko-KR");
      return (!query || haystack.includes(query)) && (state.credentialStatus === "all" || credentialStatus(item) === state.credentialStatus);
    });
    const filtered = Boolean(query) || state.credentialStatus !== "all";
    hide("empty-create-button", true);
    hide("clear-key-filters", !filtered);
    if (!connected() || (loading && !state.credentials.length) || failed) {
      text("credential-visible-count", loading ? "키를 불러오는 중입니다" : failed ? "목록을 불러오지 못했습니다" : "");
      hide("credentials-empty", failed);
      if (!failed) emptyState("credentials-empty", loading ? "키를 불러오고 있습니다" : "연결 후 키를 확인할 수 있습니다", loading ? "잠시만 기다려 주세요." : "관리자 토큰으로 연결해 주세요.");
      return;
    }
    text("credential-visible-count", filtered ? `전체 ${count(state.credentials.length)}개 중 ${count(items.length)}개` : `전체 ${count(items.length)}개${loading ? " · 업데이트 중" : ""}`);
    hide("credentials-empty", items.length > 0);
    if (!items.length) {
      emptyState("credentials-empty", filtered ? "조건에 맞는 키가 없습니다" : "첫 번째 릴레이 키를 만들어 보세요", filtered ? "이름, 접두사 또는 경로를 다시 검색하거나 필터를 초기화하세요." : "필요한 경로와 사용량을 정하면 키를 발급할 수 있습니다.");
      hide("empty-create-button", filtered);
    }
    for (const credential of items) {
      const row = node("tr");
      const name = node("div");
      const detailButton = node("button", "credential-detail-button credential-name", credential.name);
      detailButton.type = "button";
      detailButton.addEventListener("click", () => openCredential(credential.id, detailButton));
      name.append(detailButton, node("code", "credential-prefix", `${credential.prefix}…`));
      const routes = list(credential.policy?.routes);
      const route = node("div", "route-tags");
      route.append(node("span", "route-tag", routes[0] ? `${routes[0].method} ${routes[0].path}` : "허용 경로 없음"));
      if (routes.length > 1) route.append(node("span", "quota-secondary", `외 ${count(routes.length - 1)}개 경로`));
      const quota = node("div");
      quota.append(node("span", "quota-primary", `${count(credential.policy?.requests_per_minute)}회 / 분`), node("span", "quota-secondary", `${bytes(credential.policy?.bytes_per_minute)} / 분`));
      const budget = lifetimeBudget(credential);
      const lifetime = node("div", "lifetime-summary");
      if (budget.requestLimit !== null) lifetime.append(node("span", "", `총 요청 ${count(budget.requests)} / ${count(budget.requestLimit)}건`));
      if (budget.byteLimit !== null) lifetime.append(node("span", "", `총 응답 ${bytes(budget.responseBytes)} / ${bytes(budget.byteLimit)}`));
      if (budget.requestLimit === null && budget.byteLimit === null) lifetime.append(node("span", "", "총량 제한 없음"));
      quota.append(lifetime);
      const status = credentialStatus(credential);
      const statusContent = node("div", "credential-state");
      statusContent.append(badge(statusLabel(status), status === "active" ? "allow" : "neutral"));
      for (const label of budget.exhausted) statusContent.append(badge(label, "deny"));
      const actions = node("div", "row-actions");
      if (status === "active") {
        const revoke = node("button", "revoke-button", "폐기");
        revoke.type = "button";
        revoke.setAttribute("aria-label", `${credential.name}, ${credential.prefix} 키 폐기`);
        revoke.addEventListener("click", () => openRevoke(credential.id, revoke));
        actions.append(revoke);
      }
      row.append(cell("이름", name), cell("허용 경로", route), cell("사용량 제한", quota), cell("만료", date(credential.expires_at, true)), cell("상태", statusContent), cell("작업", actions));
      $("credentials-body")?.append(row);
    }
    if (state.detailId && $("detail-dialog")?.open) populateDetail();
  }
  function populateDetail() {
    const credential = state.credentials.find((item) => item.id === state.detailId);
    if (!credential) { requestClose("detail-dialog", true); return; }
    const policy = credential.policy || {};
    const status = credentialStatus(credential);
    text("detail-name", credential.name);
    text("detail-prefix", `${credential.prefix}…`);
    text("detail-status", statusLabel(status));
    if ($("detail-status")) $("detail-status").className = `badge badge-${status === "active" ? "allow" : "neutral"}`;
    text("detail-expiry", date(credential.expires_at, true));
    text("detail-created", date(credential.created_at, true));
    $("detail-routes")?.replaceChildren();
    const queryKeys = new Set();
    for (const route of list(policy.routes)) {
      const item = node("li", "detail-route");
      const keys = list(route.query_keys);
      keys.forEach((key) => queryKeys.add(key));
      item.append(node("code", "route-tag", `${route.method} ${route.path}`), node("span", "field-help", keys.length ? `허용 쿼리: ${keys.join(", ")}` : "쿼리 매개변수 허용 안 함"));
      $("detail-routes")?.append(item);
    }
    text("detail-queries", queryKeys.size ? [...queryKeys].join(", ") : "허용된 쿼리 없음");
    text("detail-ips", list(policy.ip_allowlist).length ? policy.ip_allowlist.join(", ") : "IP 주소 제한 없음");
    text("detail-rate", `${count(policy.requests_per_minute)}회 / 분`);
    text("detail-response", `${bytes(policy.response_bytes_limit)} (${count(policy.response_bytes_limit)}바이트)`);
    text("detail-budget", `${bytes(policy.bytes_per_minute)} / 분 (${count(policy.bytes_per_minute)}바이트)`);
    const budget = lifetimeBudget(credential);
    text("detail-total-requests", budget.requestLimit === null ? `${count(budget.requests)}건 사용 / 제한 없음` : `${count(budget.requests)} / ${count(budget.requestLimit)}건`);
    text("detail-total-requests-remaining", budget.requestRemaining === null ? "총 요청 수 제한이 없습니다." : `잔여 ${count(budget.requestRemaining)}건`);
    text("detail-total-bytes", budget.byteLimit === null ? `${bytes(budget.responseBytes)} 사용 / 제한 없음` : `${bytes(budget.responseBytes)} / ${bytes(budget.byteLimit)}`);
    text("detail-total-bytes-remaining", budget.byteRemaining === null ? `누적 사용량 ${count(budget.responseBytes)}바이트. 총 응답 사용량 제한이 없습니다.` : `사용 ${count(budget.responseBytes)}바이트 / 한도 ${count(budget.byteLimit)}바이트 / 잔여 ${count(budget.byteRemaining)}바이트`);
    text("detail-budget-status", budget.exhausted.join(" / "));
    hide("detail-budget-status", budget.exhausted.length === 0);
    hide("detail-revoke-button", status !== "active");
    renderControls();
  }
  function openCredential(id, trigger) {
    state.detailId = id;
    populateDetail();
    openDialog("detail-dialog", "detail-name", trigger);
  }
  function openRevoke(id, trigger = document.activeElement) {
    const credential = state.credentials.find((item) => item.id === id);
    if (!credential || credentialStatus(credential) !== "active" || state.pending.has("revoke")) return;
    state.revokeId = id;
    text("revoke-name", credential.name);
    text("revoke-prefix", `${credential.prefix}…`);
    notice("revoke-error", "");
    requestClose("detail-dialog", true);
    openDialog("revoke-dialog", "revoke-cancel-button", trigger);
  }
  function renderEvents() {
    const resource = state.resources.events;
    const loading = resource?.status === "loading";
    const failed = resource?.status === "error";
    $("activity")?.setAttribute("aria-busy", String(loading));
    hide("events-retry", !failed);
    document.querySelectorAll(".filter-button").forEach((button) => {
      const selected = button.dataset.decision === state.decision;
      button.classList.toggle("selected", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
    $("events-body")?.replaceChildren();
    hide("clear-event-filters", !state.eventSearch && !state.decision);
    if (!connected() || loading || failed) {
      text("event-count", loading ? "불러오는 중" : failed ? "조회 실패" : "기록 0건");
      hide("events-empty", failed);
      if (!failed) emptyState("events-empty", loading ? `${decisions[state.decision]} 기록을 불러오고 있습니다` : "연결 후 기록을 확인할 수 있습니다", loading ? "잠시만 기다려 주세요." : "관리자 토큰으로 연결해 주세요.");
      text("events-announcement", failed ? `${decisions[state.decision]} 기록을 불러오지 못했습니다. 다시 시도해 주세요.` : loading ? "기록을 불러오는 중입니다." : "");
      return;
    }
    const query = state.eventSearch.toLocaleLowerCase("ko-KR");
    const items = state.events.filter((event) => !query || [event.path, event.method, event.reason, reasons[event.reason], event.credential_id, event.status, event.kind === "credential_created" ? "릴레이 키 발급" : event.kind === "credential_revoked" ? "릴레이 키 폐기" : ""].join(" ").toLocaleLowerCase("ko-KR").includes(query));
    text("event-count", query ? `${count(state.events.length)}건 중 ${count(items.length)}건` : `기록 ${count(items.length)}건`);
    text("events-announcement", `${decisions[state.decision]} 기록 ${count(items.length)}건을 표시합니다.`);
    hide("events-empty", items.length > 0);
    if (!items.length) emptyState("events-empty", query ? "검색 결과가 없습니다" : "해당하는 기록이 없습니다", query || state.decision ? "검색어나 결과 필터를 변경해 보세요." : state.demoMode ? "데모를 실행하거나 릴레이 키를 발급하면 기록이 쌓입니다." : "릴레이 요청과 키 변경 이력이 이곳에 표시됩니다.");
    for (const event of items) {
      const row = node("tr");
      const request = node("div", "event-path");
      if (event.method) request.append(node("span", "method", event.method));
      const action = event.kind === "credential_created" ? "릴레이 키 발급" : event.kind === "credential_revoked" ? "릴레이 키 폐기" : event.path || "프록시 요청";
      const path = node("span", "path-label", action);
      path.title = action;
      request.append(path);
      const time = cell("시간", date(event.ts), "event-time");
      time.title = event.ts || "";
      row.append(time, cell("결과", badge(event.kind !== "proxy" && event.decision === "allow" ? "완료" : decisions[event.decision] || event.decision, decisions[event.decision] ? event.decision : "neutral")), cell("요청 / 작업", request), cell("사유", reasons[event.reason] || event.reason || "—", "event-reason"), cell("HTTP", event.status || "—", "event-status"), cell("응답 크기", bytes(event.response_bytes)));
      $("events-body")?.append(row);
    }
  }
  const loadOverview = () => loadResource("overview", "/api/overview", renderOverview, "global-error");
  const loadCredentials = () => loadResource("credentials", "/api/credentials", (data) => { state.credentials = list(data.items); renderCredentials(); }, "credentials-error");
  function loadEvents(decision = state.decision) {
    state.decision = Object.hasOwn(decisions, decision) ? decision : "";
    return loadResource("events", `/api/events?limit=100${state.decision ? `&decision=${state.decision}` : ""}`, (data) => { state.events = list(data.items); renderEvents(); }, "events-error");
  }
  async function syncResources() { await Promise.all([loadOverview(), loadCredentials(), loadEvents()]); }
  async function refresh() {
    if (!connected()) return;
    const operation = begin("refresh");
    if (!operation) return;
    globalError("");
    try { await syncResources(); } finally { finish(operation); }
  }
  function splitValues(value) { return value.split(/[,\n]/).map((item) => item.trim()).filter(Boolean); }
  function fieldError(id, message = "") {
    const input = $(id);
    if (!input) return;
    notice(`${id}-error`, message);
    input.setAttribute("aria-invalid", String(Boolean(message)));
    input.setCustomValidity(message);
    const described = new Set((input.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean));
    if ($(`${id}-help`)) described.add(`${id}-help`);
    if (message) described.add(`${id}-error`); else described.delete(`${id}-error`);
    if (described.size) input.setAttribute("aria-describedby", [...described].join(" ")); else input.removeAttribute("aria-describedby");
  }
  function showCreateStep(step, moveFocus = true) {
    state.createStep = step;
    hide("create-step-1", step !== 1);
    hide("create-step-2", step !== 2);
    hide("create-next-button", step !== 1);
    hide("create-submit", step !== 2);
    hide("create-back-button", step !== 2);
    text("create-step-label", `${step}/2`);
    text("create-title", step === 1 ? "어떤 접근을 허용할까요?" : "사용량과 접근 조건을 정하세요");
    for (const number of [1, 2]) {
      const marker = $(`create-progress-${number}`);
      marker?.classList.toggle("active", number === step);
      if (number === step) marker?.setAttribute("aria-current", "step"); else marker?.removeAttribute("aria-current");
    }
    updateCreatePreview();
    if ($("create-dialog")) $("create-dialog").scrollTop = 0;
    if (moveFocus) focus(step === 1 ? "key-name" : "key-rate");
  }
  function optionalNumber(id) { const value = $(id)?.value.trim() || ""; return value === "" ? null : Number(value); }
  function updateCreatePreview() {
    for (const [input, preview] of [["key-response", "response-preview"], ["key-budget", "budget-preview"]]) {
      const value = Number($(input)?.value);
      text(preview, Number.isFinite(value) && value >= 0 && $(input)?.value !== "" ? `${bytes(value)} (${count(value)}바이트)` : "바이트 수를 입력하세요");
    }
    const routes = ($("key-routes")?.value || "").split("\n").map((line) => line.trim()).filter(Boolean);
    const ips = splitValues($("key-ips")?.value || "");
    const totalRequests = optionalNumber("key-total-requests");
    const totalBytes = optionalNumber("key-total-bytes");
    text("total-bytes-preview", totalBytes === null ? "총량 제한 없음" : Number.isFinite(totalBytes) && totalBytes >= 0 ? `${bytes(totalBytes)} (${count(totalBytes)}바이트)` : "바이트 수를 확인하세요");
    const lifetime = `키 전체 유효 기간: 총 요청 ${totalRequests === null ? "제한 없음" : `${count(totalRequests)}건`}, 총 응답 ${totalBytes === null ? "제한 없음" : bytes(totalBytes)}`;
    text("create-summary", `${$("key-name")?.value.trim() || "이름 없는 키"}\n${$("key-ttl")?.value || "—"}시간 동안 ${count(routes.length)}개 경로 허용\n분당 ${$("key-rate")?.value || "—"}회, 응답당 ${bytes(Number($("key-response")?.value))}, 분당 ${bytes(Number($("key-budget")?.value))}\n${lifetime}\n${ips.length ? `${count(ips.length)}개 IP 대역만 허용` : "IP 주소 제한 없음"}`);
  }
  function networkKey(value) {
    const parts = value.split("/");
    if (parts.length > 2) return null;
    const address = parts[0];
    const ipv6 = address.includes(":");
    const bits = ipv6 ? 128 : 32;
    const prefix = parts.length === 1 ? bits : /^\d+$/.test(parts[1]) ? Number(parts[1]) : -1;
    if (prefix < 0 || prefix > bits || !Number.isInteger(prefix)) return null;
    let numeric = 0n;
    if (ipv6) {
      if (!/^[0-9a-fA-F:.]+$/.test(address)) return null;
      let normalized;
      try { normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1); } catch { return null; }
      const halves = normalized.split("::");
      const left = halves[0] ? halves[0].split(":") : [];
      const right = halves[1] ? halves[1].split(":") : [];
      const groups = halves.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right] : left;
      if (groups.length !== 8 || groups.some((part) => !/^[0-9a-f]{1,4}$/i.test(part))) return null;
      for (const group of groups) numeric = (numeric << 16n) | BigInt(parseInt(group, 16));
    } else {
      const octets = address.split(".");
      if (octets.length !== 4 || octets.some((part) => !/^(0|[1-9]\d{0,2})$/.test(part) || Number(part) > 255)) return null;
      for (const octet of octets) numeric = (numeric << 8n) | BigInt(octet);
    }
    const hostMask = (1n << BigInt(bits - prefix)) - 1n;
    return (numeric & hostMask) === 0n ? `${bits}:${numeric}:${prefix}` : null;
  }
  function validateCreate(steps = [1, 2]) {
    const errors = {};
    const add = (id, message) => { if (!errors[id]) errors[id] = message; };
    for (const [id, step] of Object.entries(formFields)) if (steps.includes(step)) fieldError(id);
    const name = $("key-name").value.trim();
    const query = splitValues($("key-query").value);
    const ips = splitValues($("key-ips").value);
    const rawRoutes = $("key-routes").value.split("\n").map((line) => line.trim()).filter(Boolean);
    const routes = [];
    if (steps.includes(1)) {
      if (!name || name.length > 80 || /[\x00-\x1F\x7F]/.test(name)) add("key-name", "키 이름을 1~80자의 일반 문자로 입력하세요.");
      if (!query.every((key) => /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)) || query.length > 20 || new Set(query).size !== query.length) add("key-query", "중복 없이 최대 20개까지 입력하세요. 영문자로 시작하고 영문, 숫자, 밑줄만 사용할 수 있습니다.");
      if (!rawRoutes.length || rawRoutes.length > 32) add("key-routes", "허용 경로를 1~32개 입력하세요.");
    }
    for (const line of rawRoutes) {
      const match = line.match(/^(GET|POST|PUT|PATCH|DELETE)\s+(\/\S*)$/i);
      if (!match) { if (steps.includes(1)) add("key-routes", "한 줄에 하나씩 'GET /customers' 형식으로 입력하세요."); continue; }
      const path = match[2];
      const safe = path.length <= 256 && (path === "/" || path.slice(1).split("/").every((part) => part === "*" || (part !== "." && part !== ".." && /^[A-Za-z0-9._~-]+$/.test(part))));
      if (!safe && steps.includes(1)) add("key-routes", "경로에는 영문, 숫자, 점, 밑줄, 물결표, 하이픈을 사용할 수 있습니다. *는 경로 한 단계만 허용합니다.");
      routes.push({ method: match[1].toUpperCase(), path, query_keys: query });
    }
    if (steps.includes(1) && new Set(routes.map((route) => `${route.method} ${route.path}`)).size !== routes.length) add("key-routes", "같은 메서드와 경로를 중복 입력하지 마세요.");
    const numericFields = { "key-ttl": [1, 720, "유효 시간을 1~720시간의 정수로 입력하세요."], "key-rate": [1, 10000, "분당 요청 수를 1~10,000회의 정수로 입력하세요."], "key-response": [128, 1048576, "응답당 제한을 128~1,048,576바이트의 정수로 입력하세요."], "key-budget": [128, 104857600, "분당 제한을 128~104,857,600바이트의 정수로 입력하세요."], "key-total-requests": [1, 1000000000, "총 요청 수를 1~1,000,000,000건의 정수로 입력하거나 비워 두세요.", true], "key-total-bytes": [128, 1000000000000, "총 응답 사용량을 128~1,000,000,000,000바이트의 정수로 입력하거나 비워 두세요.", true] };
    for (const [id, [min, max, message, optional = false]] of Object.entries(numericFields)) {
      if (optional && !$(id).value.trim() && !$(id).validity.badInput) continue;
      const value = Number($(id).value);
      if (steps.includes(formFields[id]) && (!$(id).value.trim() || !Number.isInteger(value) || value < min || value > max)) add(id, message);
    }
    if (steps.includes(2)) {
      const keys = ips.map(networkKey);
      if (ips.length > 32 || keys.some((key) => key === null)) add("key-ips", "올바른 IP 주소 또는 네트워크 CIDR을 최대 32개 입력하세요. 예: 127.0.0.1/32, 10.0.0.0/24, ::1/128");
      else if (new Set(keys).size !== keys.length) add("key-ips", "같은 IP 대역을 중복 입력하지 마세요.");
    }
    if (Object.keys(errors).length) {
      for (const [id, message] of Object.entries(errors)) fieldError(id, message);
      const first = Object.keys(formFields).find((id) => errors[id]);
      showCreateStep(formFields[first], false);
      focus(first);
      $(first).reportValidity();
      return null;
    }
    return { name, ttl_hours: Number($("key-ttl").value), policy: { routes, ip_allowlist: ips, requests_per_minute: Number($("key-rate").value), response_bytes_limit: Number($("key-response").value), bytes_per_minute: Number($("key-budget").value), max_total_requests: optionalNumber("key-total-requests"), max_total_bytes: optionalNumber("key-total-bytes") } };
  }
  function showServerValidation(error) {
    const mapping = { name: "key-name", ttl_hours: "key-ttl", routes: "key-routes", query_keys: "key-query", ip_allowlist: "key-ips", requests_per_minute: "key-rate", response_bytes_limit: "key-response", bytes_per_minute: "key-budget", max_total_requests: "key-total-requests", max_total_bytes: "key-total-bytes" };
    const messages = { "key-name": "키 이름을 1~80자의 일반 문자로 입력하세요.", "key-ttl": "유효 시간은 1~720시간이어야 합니다.", "key-routes": "허용 경로의 형식과 중복 여부를 확인하세요.", "key-query": "허용할 쿼리 키의 형식과 중복 여부를 확인하세요.", "key-ips": "IP 주소와 CIDR의 네트워크 주소를 확인하세요. 예: 10.0.0.0/24", "key-rate": "분당 요청 수의 허용 범위를 확인하세요.", "key-response": "응답당 바이트 제한의 허용 범위를 확인하세요.", "key-budget": "분당 바이트 제한의 허용 범위를 확인하세요.", "key-total-requests": "총 요청 수는 1~1,000,000,000건의 정수여야 합니다. 제한하지 않으려면 비워 두세요.", "key-total-bytes": "총 응답 사용량은 128~1,000,000,000,000바이트의 정수여야 합니다. 제한하지 않으려면 비워 두세요." };
    const invalid = new Set();
    for (const field of error.fields || []) {
      const parts = String(field.field || "").split(".");
      const key = [...parts].reverse().find((part) => mapping[part]);
      if (key) { const id = mapping[key]; invalid.add(id); fieldError(id, messages[id]); }
    }
    notice("create-error", invalid.size ? "표시된 입력 항목을 확인해 주세요." : "서버가 정책을 승인하지 않았습니다. 입력한 경로, IP 주소와 제한 값을 확인해 주세요.");
    const first = Object.keys(formFields).find((id) => invalid.has(id));
    if (first) { showCreateStep(formFields[first], false); focus(first); $(first).reportValidity(); }
  }
  function openCreate(trigger = document.activeElement) {
    if (!connected() || state.pending.has("create")) return;
    $("create-form")?.reset();
    for (const id of Object.keys(formFields)) fieldError(id);
    notice("create-error", "");
    showCreateStep(1, false);
    openDialog("create-dialog", "key-name", trigger);
  }

  for (const id of ["connect-button", "gate-connect-button"]) on(id, "click", () => { notice("connect-error", ""); $("admin-token").value = ""; openDialog("connect-dialog", "admin-token"); });
  on("connect-form", "submit", async (event) => {
    event.preventDefault();
    if (state.pending.has("connect")) return;
    const token = $("admin-token").value.trim();
    if (!token) { notice("connect-error", "관리자 토큰을 입력하세요."); focus("admin-token"); return; }
    state.epoch += 1;
    state.token = token;
    state.phase = "connecting";
    $("admin-token").value = "";
    const operation = begin("connect");
    notice("connect-error", "");
    try {
      const overview = await api("/api/overview");
      if (!active(operation)) return;
      state.phase = "connected";
      renderOverview(overview, operation);
      renderControls();
      setView();
      globalError("");
      requestClose("connect-dialog", true);
      toast("워크스페이스에 연결했습니다.");
      await Promise.all([loadCredentials(), loadEvents()]);
    } catch (error) {
      if (!active(operation) || cancelled(error)) return;
      resetSession({ keepConnect: true });
      notice("connect-error", error.message);
      focus("admin-token");
    } finally { finish(operation); }
  });
  on("disconnect-button", "click", () => { resetSession(); toast("연결을 해제하고 관리자 토큰을 지웠습니다."); focus("gate-connect-button"); });
  for (const id of ["refresh-button", "retry-button"]) on(id, "click", refresh);
  on("credentials-retry", "click", loadCredentials);
  on("events-retry", "click", () => loadEvents());
  for (const id of ["create-key-button", "overview-create-button", "empty-create-button"]) on(id, "click", (event) => openCreate(event.currentTarget));
  on("credential-search", "input", (event) => { state.credentialSearch = event.target.value.trim(); renderCredentials(); });
  on("credential-status", "change", (event) => { state.credentialStatus = event.target.value; renderCredentials(); });
  on("clear-key-filters", "click", () => { state.credentialSearch = ""; state.credentialStatus = "all"; $("credential-search").value = ""; $("credential-status").value = "all"; renderCredentials(); focus("credential-search"); });
  on("detail-revoke-button", "click", (event) => openRevoke(state.detailId, event.currentTarget));
  on("create-next-button", "click", () => { if (validateCreate([1])) showCreateStep(2); });
  on("create-back-button", "click", () => { if (!state.pending.has("create")) showCreateStep(1); });
  for (const id of Object.keys(formFields)) on(id, "input", () => { fieldError(id); notice("create-error", ""); updateCreatePreview(); });
  on("create-form", "submit", async (event) => {
    event.preventDefault();
    if (!connected() || state.pending.has("create")) return;
    if (state.createStep === 1) { if (validateCreate([1])) showCreateStep(2); return; }
    const body = validateCreate();
    if (!body) return;
    const operation = begin("create");
    notice("create-error", "");
    try {
      const result = await api("/api/credentials", { method: "POST", body });
      if (!active(operation)) return;
      requestClose("create-dialog", true);
      wipeSecret();
      $("new-key").value = result.token;
      result.token = "";
      openDialog("key-dialog", "new-key", $("create-key-button"));
      renderControls();
      await syncResources();
    } catch (error) {
      if (!active(operation) || cancelled(error)) return;
      finish(operation);
      if (error.kind === "validation") showServerValidation(error);
      else notice("create-error", error.uncertain ? "발급 결과를 확인하지 못했습니다. 키가 생성되었을 수 있으니 다시 발급하기 전에 키 목록을 확인해 주세요. 원문을 받지 못한 키는 폐기 후 새로 발급하세요." : error.message);
      if (error.uncertain) await loadCredentials();
    } finally { finish(operation); }
  });
  on("key-saved", "change", () => {
    if ($("key-saved").checked) { hide("key-discard-warning", true); hide("key-discard-button", true); }
    renderControls();
  });
  on("key-done-button", "click", () => { if ($("key-saved")?.checked) requestClose("key-dialog"); });
  on("key-close-button", "click", () => requestClose("key-dialog"));
  on("key-discard-button", "click", () => requestClose("key-dialog", true));
  on("copy-key-button", "click", async () => {
    if (!$("new-key")?.value || !$("key-dialog")?.open) return;
    const operation = begin("copyKey");
    if (!operation) return;
    const version = state.secretVersion;
    try {
      if (!navigator.clipboard || !window.isSecureContext) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText($("new-key").value);
      if (active(operation) && version === state.secretVersion && $("key-dialog").open) text("copy-feedback", "키를 복사했습니다. 안전한 비밀 저장소에 보관한 뒤 아래 항목을 확인하세요.");
    } catch {
      if (active(operation) && version === state.secretVersion && $("key-dialog").open) {
        text("copy-feedback", "자동 복사를 사용할 수 없습니다. 선택된 키를 키보드의 복사 명령으로 복사하세요.");
        focus("new-key"); $("new-key").select();
      }
    } finally { finish(operation); }
  });
  on("revoke-form", "submit", async (event) => {
    event.preventDefault();
    if (!connected() || !state.revokeId) return;
    const operation = begin("revoke");
    if (!operation) return;
    const id = state.revokeId;
    notice("revoke-error", "");
    try {
      await api(`/api/credentials/${encodeURIComponent(id)}/revoke`, { method: "POST" });
      if (!active(operation)) return;
      requestClose("revoke-dialog", true);
      toast("릴레이 키를 폐기했습니다.");
      await syncResources();
      if (active(operation)) {
        if (location.hash !== "#credentials") history.pushState(null, "", "#credentials");
        setView();
        focus("credentials-title");
      }
    } catch (error) {
      if (!active(operation) || cancelled(error)) return;
      finish(operation);
      notice("revoke-error", error.uncertain ? "폐기 결과를 확인하지 못했습니다. 다시 시도하거나 창을 닫고 목록에서 키 상태를 확인하세요." : error.message);
      if (error.uncertain) await loadCredentials();
    } finally { finish(operation); }
  });
  document.querySelectorAll(".filter-button").forEach((button) => button.addEventListener("click", () => { if (connected()) loadEvents(button.dataset.decision); }));
  on("event-search", "input", (event) => { state.eventSearch = event.target.value.trim(); renderEvents(); });
  on("clear-event-filters", "click", () => { state.eventSearch = ""; $("event-search").value = ""; loadEvents(""); focus("event-search"); });
  on("verify-button", "click", async () => {
    const operation = begin("verify");
    if (!operation || !connected()) { finish(operation); return; }
    notice("audit-error", "");
    state.auditSequence = operation.id;
    try {
      const result = await api("/api/audit/verify");
      if (active(operation) && operation.id === state.auditSequence) {
        renderAudit(result, operation.id);
        toast(result.valid ? "감사 로그의 무결성을 확인했습니다." : "감사 로그 검증에 실패했습니다. 기록을 확인해 주세요.");
      }
    } catch (error) {
      if (active(operation) && operation.id === state.auditSequence && !cancelled(error)) notice("audit-error", error.message);
    }
    finally { finish(operation); }
  });
  on("export-button", "click", async () => {
    const operation = begin("export");
    if (!operation || !connected()) { finish(operation); return; }
    notice("audit-error", "");
    try {
      const result = await api("/api/audit/export");
      if (!active(operation)) return;
      const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: "application/json" }));
      const download = node("a");
      download.href = url;
      download.download = `relayguard-audit-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.append(download); download.click(); download.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast("감사 로그 다운로드를 시작했습니다.");
    } catch (error) { if (active(operation) && !cancelled(error)) notice("audit-error", error.message); }
    finally { finish(operation); }
  });
  on("copy-hash-button", "click", async () => {
    if (!state.headHash || !connected()) return;
    const operation = begin("copyHash");
    if (!operation) return;
    try { await navigator.clipboard.writeText(state.headHash); if (active(operation)) toast("현재 해시를 복사했습니다."); }
    catch { if (active(operation)) notice("audit-error", "자동 복사를 사용할 수 없습니다. 표시된 해시를 직접 선택해 복사하세요."); }
    finally { finish(operation); }
  });
  on("demo-button", "click", async () => {
    if (!connected() || !state.demoMode) return;
    const operation = begin("demo");
    if (!operation) return;
    globalError("");
    try {
      const result = await api("/api/demo/run", { method: "POST", timeout: 45000 });
      if (!active(operation)) return;
      const scenarios = list(result.scenarios);
      $("scenario-list")?.replaceChildren();
      for (const scenario of scenarios) {
        const item = node("article", "scenario-item");
        const top = node("div", "scenario-top");
        top.append(node("strong", "", scenario.name), badge(scenario.passed ? "통과" : "실패", scenario.passed ? "allow" : "error"));
        item.append(top, node("p", "scenario-detail", `기대 HTTP ${scenario.expected_status} · 실제 HTTP ${scenario.actual_status}`), node("p", "scenario-reason", reasons[scenario.reason] || scenario.reason || ""));
        $("scenario-list")?.append(item);
      }
      const passed = scenarios.filter((scenario) => scenario.passed).length;
      text("demo-result-badge", `${count(passed)} / ${count(scenarios.length)}개 통과`);
      if ($("demo-result-badge")) $("demo-result-badge").className = `badge badge-${result.passed ? "allow" : "error"}`;
      if ($("scenario-details")) $("scenario-details").open = !result.passed;
      hide("demo-results", false);
      toast(result.passed ? "모든 검증 시나리오를 통과했습니다." : "실패한 시나리오가 있습니다. 결과를 확인해 주세요.");
      await syncResources();
    } catch (error) { if (active(operation) && !cancelled(error)) globalError(error.uncertain ? "데모 실행 결과를 확인하지 못했습니다. 요청 기록을 확인한 뒤 다시 실행해 주세요." : error.message); }
    finally { finish(operation); }
  });

  document.querySelectorAll("[data-close]").forEach((button) => {
    if (button.id !== "key-close-button" && button.id !== "key-done-button" && button.id !== "key-discard-button") button.addEventListener("click", () => requestClose(button.dataset.close));
  });
  document.querySelectorAll("dialog").forEach((dialog) => {
    dialog.addEventListener("cancel", (event) => { event.preventDefault(); requestClose(dialog.id); });
    dialog.addEventListener("close", () => {
      if (dialog.open) return;
      if (dialog.id === "key-dialog") wipeSecret();
      if (dialog.id === "revoke-dialog") state.revokeId = null;
      if (dialog.id === "detail-dialog") state.detailId = null;
      if (dialog.id === "connect-dialog") {
        $("admin-token").value = "";
        if (state.phase === "connecting") resetSession();
      }
      const trigger = state.returnFocus.get(dialog.id);
      state.returnFocus.delete(dialog.id);
      if (!document.querySelector("dialog[open]")) {
        if (trigger?.isConnected && !trigger.disabled && trigger.getClientRects().length) trigger.focus();
        else focus(connected() ? state.view === "credentials" ? "credentials-title" : "page-title" : "gate-connect-button");
      }
      renderControls();
    });
  });
  document.querySelectorAll("[data-view-link]").forEach((link) => link.addEventListener("click", (event) => {
    const view = link.dataset.viewLink;
    if (!Object.hasOwn(views, view)) return;
    event.preventDefault();
    if (location.hash === `#${view}`) setView(true); else location.hash = view;
  }));
  window.addEventListener("hashchange", () => setView(true));
  window.addEventListener("pagehide", () => resetSession());
  renderControls();
  setView();
  const healthController = new AbortController();
  const healthTimeout = setTimeout(() => healthController.abort(), 12000);
  fetch("/healthz", { credentials: "omit", cache: "no-store", redirect: "error", signal: healthController.signal })
    .then((response) => { if (!response.ok) throw new Error("Unavailable"); return response.json(); })
    .then((data) => { if (connected()) return; state.demoMode = data.demo_mode === true; hide("demo-banner", !state.demoMode); text("environment-label", state.demoMode ? "로컬 데모" : "운영 환경"); renderControls(); })
    .catch(() => { if (!connected()) { text("environment-label", "서버 확인 필요"); globalError("서버 상태를 확인하지 못했습니다. 서버가 실행 중인지 확인한 뒤 연결해 주세요."); } })
    .finally(() => clearTimeout(healthTimeout));
})();
