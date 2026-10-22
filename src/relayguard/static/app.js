"use strict";

(() => {
  const $ = (id) => document.getElementById(id);
  const state = { token: "", connected: false, generation: 0, controllers: new Set(), credentials: [], decision: "", filterGeneration: 0, revokeId: null, demoMode: false };
  const numberFormat = new Intl.NumberFormat("ko-KR");
  const dateFormat = new Intl.DateTimeFormat("ko-KR", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  const expiryFormat = new Intl.DateTimeFormat("ko-KR", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
  const reasons = {
    allowed: "정책 허용", forwarded: "응답 전달", policy_allowed: "정책 허용", success: "요청 허용", token_created: "키 발급", credential_created: "키 발급", created: "키 발급",
    token_revoked: "폐기된 키", credential_revoked: "키 폐기", revoked: "키 폐기", token_expired: "만료된 키", rate_limit: "분당 요청 수 초과", byte_budget: "분당 응답량 초과",
    invalid_token: "유효하지 않은 키", missing_token: "인증 정보 없음", missing_authorization: "인증 정보 없음", invalid_authorization: "인증 형식 오류", invalid_path: "안전하지 않은 경로",
    route_denied: "허용되지 않은 경로", route_not_allowed: "허용되지 않은 경로", policy_denied: "정책 위반", method_not_allowed: "허용되지 않은 메서드",
    query_denied: "허용되지 않은 쿼리", query_not_allowed: "허용되지 않은 쿼리", invalid_query: "쿼리 형식 오류", ip_denied: "허용되지 않은 IP", ip_not_allowed: "허용되지 않은 IP",
    request_too_large: "요청 크기 초과", response_too_large: "응답 크기 초과", upstream_error: "업스트림 오류", upstream_timeout: "업스트림 시간 초과",
    upstream_redirect: "업스트림 리디렉션", upstream_compression: "압축 응답 거부", audit_failure: "감사 기록 실패", invalid_content_type: "허용되지 않은 콘텐츠 유형"
  };
  let toastTimer;

  function node(tag, className, content) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (content !== undefined && content !== null) element.textContent = String(content);
    return element;
  }
  function badge(content, kind) { return node("span", `badge badge-${kind}`, content); }
  function date(value, format = dateFormat) {
    const parsed = new Date(value);
    return value && Number.isFinite(parsed.getTime()) ? format.format(parsed) : "—";
  }
  function count(value) { return Number.isFinite(value) ? numberFormat.format(value) : "—"; }
  function bytes(value) {
    if (!Number.isFinite(value)) return "—";
    if (value < 1024) return `${count(value)} B`;
    if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / 1024 ** 2).toFixed(1)} MB`;
  }
  function setNotice(id, message) { $(id).textContent = message || ""; $(id).hidden = !message; }
  function toast(message) {
    clearTimeout(toastTimer);
    $("toast").textContent = message;
    $("toast").hidden = false;
    toastTimer = setTimeout(() => { $("toast").hidden = true; }, 4500);
  }
  function busy(button, value, label) {
    if (value) {
      button.dataset.idleLabel = button.textContent;
      button.textContent = label;
      button.classList.add("busy-text");
      button.disabled = true;
      button.setAttribute("aria-busy", "true");
    } else {
      if (button.dataset.idleLabel) button.textContent = button.dataset.idleLabel;
      button.classList.remove("busy-text");
      button.removeAttribute("aria-busy");
      button.disabled = false;
    }
  }
  function aborted(error) { return error && error.name === "AbortError"; }
  function setConnectionUI() {
    $("connect-button").hidden = state.connected;
    $("disconnect-button").hidden = !state.connected;
    $("session-gate").hidden = state.connected;
    const indicator = $("connection-status");
    indicator.classList.toggle("connected", state.connected);
    indicator.replaceChildren(node("span", "status-dot"), document.createTextNode(state.connected ? "관리자 연결됨" : "연결 안 됨"));
    for (const id of ["refresh-button", "create-key-button", "verify-button", "export-button"]) $(id).disabled = !state.connected;
    $("demo-button").disabled = !state.connected || !state.demoMode;
    document.querySelectorAll(".filter-button").forEach((button) => { button.disabled = !state.connected; });
  }
  function clearSession() {
    state.generation += 1;
    for (const controller of state.controllers) controller.abort();
    state.controllers.clear();
    state.token = "";
    state.connected = false;
    state.credentials = [];
    state.revokeId = null;
    $("admin-token").value = "";
    for (const id of ["create-dialog", "key-dialog", "revoke-dialog"]) if ($(id).open) $(id).close();
    $("new-key").textContent = "";
    $("credentials-body").replaceChildren();
    $("events-body").replaceChildren();
    for (const key of ["active", "total", "allowed", "blocked", "bytes"]) $("stat-" + key).textContent = "—";
    $("credential-count").textContent = "—";
    $("event-count").textContent = "기록 0건";
    $("upstream-origin").textContent = "연결 후 업스트림 표시";
    $("last-updated").textContent = "연결 후 데이터를 불러옵니다";
    $("demo-results").hidden = true;
    $("scenario-list").replaceChildren();
    setEmpty("credentials", "연결 후 릴레이 키를 확인할 수 있습니다", "발급한 키의 권한과 유효 기간이 이곳에 표시됩니다.");
    setEmpty("events", "아직 표시할 활동이 없습니다", "관리자 연결 후 실제 기록을 불러옵니다.");
    $("audit-badge").className = "badge badge-neutral";
    $("audit-badge").textContent = "확인 전";
    $("audit-description").textContent = "기록을 해시 체인으로 연결해 저장된 로그의 일관성을 검증합니다.";
    $("audit-hash").textContent = "관리자 연결 후 표시됩니다";
    setConnectionUI();
  }
  function setEmpty(type, title, description) {
    const empty = $(type + "-empty");
    empty.hidden = false;
    empty.querySelector("strong").textContent = title;
    empty.querySelector("p").textContent = description;
  }
  async function api(path, options = {}) {
    if (!state.token) throw new Error("관리자 연결이 필요합니다.");
    const generation = state.generation;
    const controller = new AbortController();
    state.controllers.add(controller);
    try {
      const response = await fetch(path, {
        ...options,
        headers: { Accept: "application/json", ...(options.body ? { "Content-Type": "application/json" } : {}), Authorization: `Bearer ${state.token}` },
        credentials: "omit", cache: "no-store", redirect: "error", signal: controller.signal
      });
      if (generation !== state.generation) throw new DOMException("Session changed", "AbortError");
      let result;
      try { result = await response.json(); } catch { throw new Error("서버가 올바른 JSON 응답을 반환하지 않았습니다."); }
      if (generation !== state.generation) throw new DOMException("Session changed", "AbortError");
      if (!response.ok) {
        if (response.status === 401) {
          clearSession();
          setNotice("global-error", "관리자 인증에 실패했습니다. 토큰을 확인하고 다시 연결하세요.");
          throw new Error("관리자 토큰이 올바르지 않습니다.");
        }
        if (response.status === 422) throw new Error("입력한 정책이 유효하지 않습니다. 경로, IP 주소와 사용량 범위를 확인하세요.");
        if (response.status === 404 && path === "/api/demo/run") throw new Error("이 서버에서는 데모 시나리오를 사용할 수 없습니다.");
        throw new Error(result?.error?.message || `요청을 처리하지 못했습니다. HTTP ${response.status}`);
      }
      return result;
    } catch (error) {
      if (error instanceof TypeError) throw new Error("서버에 연결할 수 없습니다. 서버 실행 상태와 네트워크를 확인하세요.");
      throw error;
    } finally { state.controllers.delete(controller); }
  }
  function renderAudit(audit) {
    const valid = audit.valid === true;
    $("audit-badge").className = `badge badge-${valid ? "allow" : "error"}`;
    $("audit-badge").textContent = valid ? "검증 통과" : "검증 실패";
    $("audit-description").textContent = valid ? `${count(audit.event_count)}개 기록의 해시 연결이 일치합니다.` : `감사 로그에서 불일치가 발견되었습니다. ${audit.error || "외부 보관 기록과 비교하세요."}`;
    $("audit-hash").textContent = audit.head_hash || "아직 저장된 기록이 없습니다";
    $("audit-hash").title = audit.head_hash || "";
  }
  function renderOverview(data) {
    state.demoMode = data.demo_mode === true;
    $("demo-banner").hidden = !state.demoMode;
    $("environment-label").textContent = state.demoMode ? "로컬 데모 환경" : "설정된 업스트림";
    $("stat-active").textContent = count(data.stats.active_credentials);
    $("stat-total").textContent = count(data.stats.total_requests);
    $("stat-allowed").textContent = count(data.stats.allowed);
    $("stat-blocked").textContent = count(data.stats.blocked);
    $("stat-bytes").textContent = bytes(data.stats.bytes_forwarded);
    $("upstream-origin").textContent = data.upstream_origin;
    $("upstream-origin").title = data.upstream_origin;
    renderAudit(data.audit);
    $("last-updated").textContent = `업데이트 ${new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date())}`;
  }
  function renderCredentials(items) {
    state.credentials = items;
    $("credential-count").textContent = count(items.length);
    $("credentials-body").replaceChildren();
    $("credentials-empty").hidden = items.length > 0;
    if (!items.length) setEmpty("credentials", "아직 발급한 키가 없습니다", "키 발급 버튼으로 필요한 권한만 담은 첫 릴레이 키를 만드세요.");
    for (const credential of items) {
      const row = node("tr");
      const nameCell = node("td");
      const name = node("span", "credential-name", credential.name);
      name.title = credential.name;
      nameCell.append(name, node("code", "credential-prefix", credential.prefix + "…"));
      const routeCell = node("td");
      const routes = node("div", "route-tags");
      for (const rule of credential.policy.routes) routes.append(node("span", "route-tag", `${rule.method} ${rule.path}`));
      routeCell.append(routes);
      const quota = node("td");
      quota.append(node("span", "quota-primary", `${count(credential.policy.requests_per_minute)}회 / 분`), node("span", "quota-secondary", `${bytes(credential.policy.response_bytes_limit)} / 응답 · ${bytes(credential.policy.bytes_per_minute)} / 분`));
      const expired = new Date(credential.expires_at).getTime() <= Date.now();
      const status = credential.revoked_at ? "폐기됨" : expired ? "만료됨" : "활성";
      const statusCell = node("td");
      statusCell.append(badge(status, status === "활성" ? "allow" : "neutral"));
      const actionCell = node("td");
      if (status === "활성") {
        const revoke = node("button", "revoke-button", "폐기");
        revoke.type = "button";
        revoke.setAttribute("aria-label", `${credential.name} 키 폐기`);
        revoke.addEventListener("click", () => {
          state.revokeId = credential.id;
          $("revoke-name").textContent = credential.name;
          setNotice("revoke-error", "");
          $("revoke-dialog").showModal();
        });
        actionCell.append(revoke);
      } else actionCell.textContent = "—";
      row.append(nameCell, routeCell, quota, node("td", "", date(credential.expires_at, expiryFormat)), statusCell, actionCell);
      $("credentials-body").append(row);
    }
  }
  function renderEvents(items) {
    $("events-body").replaceChildren();
    $("events-empty").hidden = items.length > 0;
    $("event-count").textContent = `기록 ${count(items.length)}건`;
    if (!items.length) setEmpty("events", state.decision ? "이 결과에 해당하는 활동이 없습니다" : "아직 기록된 활동이 없습니다", state.demoMode ? "데모 시나리오를 실행하거나 릴레이 키를 발급하면 기록이 쌓입니다." : "릴레이 요청과 키 변경 이력이 이곳에 표시됩니다.");
    const decisions = { allow: "허용", deny: "차단", error: "오류" };
    for (const event of items) {
      const row = node("tr");
      const time = node("td", "event-time", date(event.ts));
      time.title = String(event.ts || "");
      const decision = node("td");
      decision.append(badge(decisions[event.decision] || event.decision, decisions[event.decision] ? event.decision : "neutral"));
      const request = node("td");
      const requestText = node("div", "event-path");
      if (event.method) requestText.append(node("span", "method", event.method));
      const action = event.kind === "credential_created" ? "릴레이 키 발급" : event.kind === "credential_revoked" ? "릴레이 키 폐기" : event.path || "프록시 요청";
      const path = node("span", "path-label", action);
      path.title = action;
      requestText.append(path);
      request.append(requestText);
      const reason = node("td", "event-reason", reasons[event.reason] || event.reason || "—");
      reason.title = event.reason || "";
      row.append(time, decision, request, reason, node("td", "event-status", event.status || "—"), node("td", "", bytes(event.response_bytes)));
      $("events-body").append(row);
    }
  }
  async function loadAll() {
    const decision = state.decision;
    const generation = state.generation;
    const [overview, credentials, events] = await Promise.all([
      api("/api/overview"), api("/api/credentials"), api("/api/events?limit=100" + (decision ? `&decision=${encodeURIComponent(decision)}` : ""))
    ]);
    if (generation !== state.generation) throw new DOMException("Session changed", "AbortError");
    renderOverview(overview);
    renderCredentials(credentials.items);
    if (decision === state.decision) renderEvents(events.items);
  }
  async function refresh() {
    const button = $("refresh-button");
    busy(button, true, "불러오는 중");
    $("main").setAttribute("aria-busy", "true");
    setNotice("global-error", "");
    try { await loadAll(); } catch (error) { if (!aborted(error)) setNotice("global-error", error.message); }
    finally { busy(button, false); $("main").removeAttribute("aria-busy"); setConnectionUI(); }
  }
  function openConnect() {
    setNotice("connect-error", "");
    $("admin-token").value = "";
    $("connect-dialog").showModal();
  }
  $("connect-button").addEventListener("click", openConnect);
  $("gate-connect-button").addEventListener("click", openConnect);
  $("disconnect-button").addEventListener("click", () => { clearSession(); setNotice("global-error", ""); toast("연결을 해제하고 관리자 토큰을 지웠습니다."); });
  $("connect-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const token = $("admin-token").value.trim();
    $("admin-token").value = "";
    if (!token) return;
    state.token = token;
    state.generation += 1;
    busy($("connect-submit"), true, "연결 중");
    setNotice("connect-error", "");
    try {
      await loadAll();
      state.connected = true;
      setConnectionUI();
      setNotice("global-error", "");
      $("connect-dialog").close();
      toast("관리자 연결을 완료했습니다.");
    } catch (error) {
      if (!aborted(error)) { clearSession(); setNotice("connect-error", error.message); }
    } finally { busy($("connect-submit"), false); }
  });
  $("connect-dialog").addEventListener("close", () => {
    $("admin-token").value = "";
    if (!state.connected && state.token) clearSession();
  });
  $("refresh-button").addEventListener("click", refresh);
  document.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", () => $(button.dataset.close).close()));

  $("create-key-button").addEventListener("click", () => { $("create-form").reset(); setNotice("create-error", ""); $("create-dialog").showModal(); });
  $("create-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const queries = [...new Set($("key-query").value.split(/[,\n]/).map((item) => item.trim()).filter(Boolean))];
    const ips = [...new Set($("key-ips").value.split(/[,\n]/).map((item) => item.trim()).filter(Boolean))];
    let routes;
    try {
      routes = $("key-routes").value.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
        const match = line.match(/^(GET|POST|PUT|PATCH|DELETE)\s+(\/\S*)$/i);
        if (!match) throw new Error("허용 경로를 'GET /customers' 형식으로 한 줄에 하나씩 입력하세요.");
        return { method: match[1].toUpperCase(), path: match[2], query_keys: queries };
      });
      if (!routes.length) throw new Error("허용 경로를 하나 이상 입력하세요.");
      if (!$("key-name").value.trim()) throw new Error("키 이름을 입력하세요.");
    } catch (error) { setNotice("create-error", error.message); return; }
    const body = { name: $("key-name").value.trim(), ttl_hours: Number($("key-ttl").value), policy: { routes, ip_allowlist: ips, requests_per_minute: Number($("key-rate").value), response_bytes_limit: Number($("key-response").value), bytes_per_minute: Number($("key-budget").value) } };
    busy($("create-submit"), true, "발급 중");
    setNotice("create-error", "");
    try {
      const result = await api("/api/credentials", { method: "POST", body: JSON.stringify(body) });
      $("create-dialog").close();
      $("new-key").textContent = result.token;
      result.token = "";
      $("copy-feedback").textContent = "";
      $("key-dialog").showModal();
      await refresh();
    } catch (error) { if (!aborted(error)) setNotice("create-error", error.message); }
    finally { busy($("create-submit"), false); }
  });
  $("key-dialog").addEventListener("close", () => { $("new-key").textContent = ""; $("copy-feedback").textContent = ""; });
  $("copy-key-button").addEventListener("click", async () => {
    try {
      if (!navigator.clipboard || !window.isSecureContext) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText($("new-key").textContent);
      $("copy-feedback").textContent = "클립보드에 복사했습니다. 사용 후 클립보드도 정리하세요.";
    } catch { $("copy-feedback").textContent = "자동 복사를 사용할 수 없습니다. 위 키를 직접 선택해 복사하세요."; }
  });
  $("revoke-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!state.revokeId) return;
    busy($("revoke-submit"), true, "폐기 중");
    setNotice("revoke-error", "");
    try {
      await api(`/api/credentials/${encodeURIComponent(state.revokeId)}/revoke`, { method: "POST" });
      $("revoke-dialog").close();
      toast("릴레이 키를 폐기했습니다.");
      await refresh();
    } catch (error) { if (!aborted(error)) setNotice("revoke-error", error.message); }
    finally { busy($("revoke-submit"), false); }
  });
  $("revoke-dialog").addEventListener("close", () => { state.revokeId = null; });

  document.querySelectorAll(".filter-button").forEach((button) => button.addEventListener("click", async () => {
    state.decision = button.dataset.decision;
    const generation = ++state.filterGeneration;
    document.querySelectorAll(".filter-button").forEach((item) => { const selected = item === button; item.classList.toggle("selected", selected); item.setAttribute("aria-pressed", String(selected)); });
    $("events-body").classList.add("is-loading");
    $("activity").setAttribute("aria-busy", "true");
    try {
      const result = await api("/api/events?limit=100" + (state.decision ? `&decision=${encodeURIComponent(state.decision)}` : ""));
      if (generation === state.filterGeneration) renderEvents(result.items);
    } catch (error) { if (!aborted(error)) setNotice("global-error", error.message); }
    finally { if (generation === state.filterGeneration) { $("events-body").classList.remove("is-loading"); $("activity").removeAttribute("aria-busy"); } }
  }));

  $("verify-button").addEventListener("click", async () => {
    const button = $("verify-button");
    busy(button, true, "검증 중");
    try { const result = await api("/api/audit/verify"); renderAudit(result); toast(result.valid ? "감사 로그의 해시 연결이 일치합니다." : "감사 로그 검증에 실패했습니다."); }
    catch (error) { if (!aborted(error)) setNotice("global-error", error.message); }
    finally { busy(button, false); button.disabled = !state.connected; }
  });
  $("export-button").addEventListener("click", async () => {
    const button = $("export-button");
    busy(button, true, "내보내는 중");
    try {
      const result = await api("/api/audit/export");
      const blob = new Blob([JSON.stringify(result, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const download = node("a");
      download.href = url;
      download.download = `relayguard-audit-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.append(download);
      download.click();
      download.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast("감사 로그 JSON 다운로드를 시작했습니다.");
    } catch (error) { if (!aborted(error)) setNotice("global-error", error.message); }
    finally { busy(button, false); button.disabled = !state.connected; }
  });
  $("demo-button").addEventListener("click", async () => {
    const button = $("demo-button");
    busy(button, true, "시나리오 실행 중");
    $("demo-results").hidden = true;
    setNotice("global-error", "");
    try {
      const result = await api("/api/demo/run", { method: "POST" });
      $("scenario-list").replaceChildren();
      for (const scenario of result.scenarios) {
        const item = node("article", "scenario-item");
        const top = node("div", "scenario-top");
        top.append(node("strong", "", scenario.name), badge(scenario.passed ? "통과" : "실패", scenario.passed ? "allow" : "error"));
        item.append(top, node("p", "scenario-detail", `기대 HTTP ${scenario.expected_status} / 실제 HTTP ${scenario.actual_status}`), node("p", "scenario-reason", scenario.reason || ""));
        $("scenario-list").append(item);
      }
      $("demo-result-badge").className = `badge badge-${result.passed ? "allow" : "error"}`;
      $("demo-result-badge").textContent = result.passed ? "모든 시나리오 통과" : "실패한 시나리오 있음";
      $("demo-results").hidden = false;
      toast(result.passed ? "실제 프록시를 통한 데모 검증이 완료되었습니다." : "일부 데모 시나리오의 결과가 예상과 다릅니다.");
      await refresh();
    } catch (error) { if (!aborted(error)) setNotice("global-error", error.message); }
    finally { busy(button, false); button.disabled = !state.connected || !state.demoMode; }
  });

  document.querySelectorAll(".nav-link").forEach((link) => link.addEventListener("click", () => { document.querySelectorAll(".nav-link").forEach((item) => item.classList.toggle("active", item === link)); }));
  window.addEventListener("pagehide", clearSession);
  fetch("/healthz", { credentials: "omit", cache: "no-store", redirect: "error" })
    .then((response) => { if (!response.ok) throw new Error("Unavailable"); return response.json(); })
    .then((data) => {
      state.demoMode = data.demo_mode === true;
      $("demo-banner").hidden = !state.demoMode;
      $("environment-label").textContent = state.demoMode ? "로컬 데모 환경" : "설정된 업스트림";
    })
    .catch(() => { $("environment-label").textContent = "서버 연결 확인 필요"; setNotice("global-error", "서버 상태를 확인할 수 없습니다. 서버가 실행 중인지 확인하세요."); });
})();
