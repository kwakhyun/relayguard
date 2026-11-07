"use strict";

(() => {
  const $ = (id) => document.getElementById(id);
  const on = (id, event, handler) => $(id)?.addEventListener(event, handler);
  const list = (value) => Array.isArray(value) ? value : [];

  /* ---------- Preferences: language and theme ---------- */
  // Browser storage holds only these two display preferences, and only after
  // the viewer changes them.  Tokens and keys never touch storage.
  function readPreference(name) {
    try { return window.localStorage.getItem(name); } catch { return null; }
  }
  function writePreference(name, value) {
    try { window.localStorage.setItem(name, value); } catch { /* storage unavailable */ }
  }
  const catalog = (window.RelayGuardI18n && window.RelayGuardI18n.en) || {};
  const reverseCatalog = new Map(Object.entries(catalog).map(([ko, en]) => [en, ko]));
  const storedLanguage = readPreference("relayguard.lang");
  let lang = storedLanguage === "ko" || storedLanguage === "en" ? storedLanguage
    : String(navigator.language || "ko").toLowerCase().startsWith("ko") ? "ko" : "en";
  const themes = ["system", "light", "dark"];
  const storedTheme = readPreference("relayguard.theme");
  let theme = themes.includes(storedTheme) ? storedTheme : "system";

  function t(key, params) {
    const template = lang === "en" && Object.hasOwn(catalog, key) ? catalog[key] : key;
    return params ? template.replace(/\{(\w+)\}/g, (match, name) => Object.hasOwn(params, name) ? String(params[name]) : match) : template;
  }
  const locale = () => lang === "en" ? "en-US" : "ko-KR";
  let numberFormat, dateFormat, fullDateFormat, timeFormat, hourFormat, relativeFormat;
  function buildFormatters() {
    numberFormat = new Intl.NumberFormat(locale());
    dateFormat = new Intl.DateTimeFormat(locale(), { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
    fullDateFormat = new Intl.DateTimeFormat(locale(), { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
    timeFormat = new Intl.DateTimeFormat(locale(), { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
    hourFormat = new Intl.DateTimeFormat(locale(), { hour: "2-digit", minute: "2-digit", hour12: false });
    relativeFormat = new Intl.RelativeTimeFormat(locale(), { numeric: "auto" });
  }
  buildFormatters();

  // Static markup is written in Korean.  Exact text nodes and a few
  // attributes are swapped through the catalog; mixed inline code uses
  // data-i18n with `code` spans.  Dynamic text always goes through t().
  const originalText = new WeakMap();
  function catalogKey(current, remembered) {
    if (remembered !== undefined && (remembered === current || t(remembered) === current)) return remembered;
    if (Object.hasOwn(catalog, current)) return current;
    return reverseCatalog.get(current);
  }
  function renderRich(element, value) {
    const parts = value.split("`");
    element.replaceChildren(...parts.map((part, index) => index % 2 ? Object.assign(document.createElement("code"), { textContent: part }) : document.createTextNode(part)));
  }
  function translateStatic(root = document.body) {
    document.documentElement.lang = lang;
    root.querySelectorAll("[data-i18n]").forEach((element) => renderRich(element, t(element.dataset.i18n)));
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(textNode) {
        const parent = textNode.parentElement;
        if (!parent || parent.closest("[data-i18n], [data-no-i18n], script, style, code, textarea")) return NodeFilter.FILTER_REJECT;
        return textNode.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });
    for (let textNode = walker.nextNode(); textNode; textNode = walker.nextNode()) {
      const raw = textNode.nodeValue;
      const trimmed = raw.trim();
      const key = catalogKey(trimmed, originalText.get(textNode));
      if (key === undefined) continue;
      originalText.set(textNode, key);
      const next = t(key);
      if (next !== trimmed) textNode.nodeValue = raw.replace(trimmed, next);
    }
    for (const [attribute, slot] of [["placeholder", "i18nPlaceholder"], ["aria-label", "i18nAriaLabel"], ["title", "i18nTitle"]]) {
      root.querySelectorAll(`[${attribute}]`).forEach((element) => {
        if (element.closest("[data-no-i18n]")) return;
        const key = catalogKey(element.getAttribute(attribute), element.dataset[slot]);
        if (key === undefined) return;
        element.dataset[slot] = key;
        element.setAttribute(attribute, t(key));
      });
    }
    const titleKey = catalogKey(document.title, document.documentElement.dataset.i18nTitle);
    if (titleKey !== undefined) { document.documentElement.dataset.i18nTitle = titleKey; document.title = t(titleKey); }
  }
  function renderPreferences() {
    const button = $("language-button");
    if (button) {
      button.textContent = lang === "ko" ? "English" : "한국어";
      button.lang = lang === "ko" ? "en" : "ko";
      button.setAttribute("aria-label", lang === "ko" ? "Language: 한국어. Switch to English" : "언어: English. 한국어로 바꾸기");
      button.dataset.noI18n = "";
    }
    if (theme === "system") delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = theme;
    const names = { system: t("시스템"), light: t("라이트"), dark: t("다크") };
    const next = themes[(themes.indexOf(theme) + 1) % themes.length];
    const label = $("theme-button")?.querySelector(".button-label");
    if (label) label.textContent = t("테마: {name}", { name: names[theme] });
    $("theme-button")?.setAttribute("aria-label", t("화면 테마: {name}. 눌러서 {next}(으)로 바꾸기", { name: names[theme], next: names[next] }));
  }

  /* ---------- State ---------- */
  const state = {
    token: "", phase: "disconnected", epoch: 0, view: "overview", demoMode: false,
    controllers: new Set(), pending: new Map(), sequence: 0, auditSequence: 0, resources: {},
    credentials: [], events: [], eventsNext: null, eventPages: 0, eventsQuery: "",
    decision: "", eventKind: "", eventCredential: "", eventPeriod: "", eventSearch: "",
    credentialSearch: "", credentialStatus: "active",
    detailId: null, revokeId: null, createStep: 1, createSource: null, secretVersion: 0, headHash: "",
    returnFocus: new Map(), overview: null, audit: null, auditMode: "", scenarios: null, autoRefresh: null, routeSequence: 0
  };
  const views = {
    overview: ["보안 개요", "키의 접근 범위와 요청 처리 현황을 한눈에 확인하세요."],
    credentials: ["릴레이 키", "필요한 권한만 부여하고, 사용이 끝난 키는 교체하거나 폐기하세요."],
    activity: ["활동 기록", "허용과 차단의 이유를 확인하고 필요한 기록을 찾아보세요."],
    audit: ["감사 무결성", "기록의 무결성을 검증하고 별도 보관할 사본을 내려받으세요."]
  };
  // Every reason the server can emit; keep in sync with gateway._ERROR_MESSAGES.
  const reasons = {
    forwarded: "응답 전달", allowed: "정책 허용", unexpected_response: "예상하지 못한 응답",
    credential_created: "키 발급", credential_revoked: "키 폐기", credential_rotated: "키 교체", admin_auth_failed: "잘못된 관리자 토큰",
    invalid_token: "유효하지 않은 키", token_revoked: "폐기된 키", token_expired: "만료된 키",
    invalid_path: "안전하지 않은 경로", route_denied: "허용되지 않은 경로", query_denied: "허용되지 않은 쿼리", ip_denied: "허용되지 않은 IP",
    invalid_headers: "허용되지 않은 요청 헤더", headers_too_large: "요청 헤더 크기 초과", request_too_large: "요청 크기 초과",
    invalid_request: "요청을 읽지 못함", request_timeout: "요청 본문 시간 초과", request_cancelled: "요청 취소됨",
    rate_limit: "분당 요청 수 초과", byte_budget: "분당 응답량 초과",
    lifetime_request_limit: "키의 총 요청 한도 도달", lifetime_byte_budget: "키의 총 응답 사용량 초과",
    response_too_large: "응답 크기 초과", upstream_redirect: "원본 리디렉션 차단", upstream_encoding: "압축 응답 거부",
    upstream_content_type: "허용되지 않은 응답 형식", upstream_invalid_response: "원본 응답 형식 오류",
    upstream_rejected: "원본 API 오류 응답", upstream_timeout: "원본 API 시간 초과", upstream_unavailable: "원본 API 연결 실패",
    storage_unavailable: "저장소 사용 불가", audit_unavailable: "감사 기록 실패"
  };
  const kinds = { credential_created: "릴레이 키 발급", credential_revoked: "릴레이 키 폐기", credential_rotated: "릴레이 키 교체", admin_auth: "관리자 인증 실패" };
  const decisions = { "": "전체", allow: "허용", deny: "차단", error: "오류" };
  const methods = ["GET", "POST", "PUT", "PATCH", "DELETE"];
  const forwardable = [400, 404, 409, 410, 412, 422];
  const formFields = {
    "key-name": 1, "key-ttl": 1, "key-routes": 1,
    "key-rate": 2, "key-response": 2, "key-budget": 2, "key-total-requests": 2, "key-total-bytes": 2, "key-ips": 2, "forward-statuses": 2, "rotation-mode": 2
  };
  let toastTimer;

  /* ---------- Small helpers ---------- */
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
  function relative(value) {
    const target = new Date(value).getTime();
    if (!Number.isFinite(target)) return "";
    const delta = target - Date.now();
    const size = Math.abs(delta);
    if (size < 3600e3) return relativeFormat.format(Math.round(delta / 60e3), "minute");
    if (size < 2 * 86400e3) return relativeFormat.format(Math.round(delta / 3600e3), "hour");
    return relativeFormat.format(Math.round(delta / 86400e3), "day");
  }
  function bytes(value) {
    if (!Number.isFinite(value)) return "—";
    if (value < 1024) return `${count(value)} B`;
    const units = ["B", "KB", "MB", "GB", "TB"];
    const unit = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
    return `${numberFormat.format(Math.round(value / 1024 ** unit * 10) / 10)} ${units[unit]}`;
  }
  function reasonLabel(code) { return reasons[code] ? t(reasons[code]) : code || "—"; }
  function notice(id, message) { text(id, message); hide(id, !message); }
  function globalError(message) { notice("global-error", message); hide("retry-button", !message || state.phase !== "connected"); }
  function toast(message) {
    clearTimeout(toastTimer);
    text("toast-message", message);
    hide("toast", false);
    toastTimer = setTimeout(() => hide("toast", true), 5000);
  }
  function focus(id) { $(id)?.focus(); }
  function connected() { return state.phase === "connected"; }
  function current(epoch) { return epoch === state.epoch; }
  function cancelled(error) { return error?.name === "AbortError" || error?.kind === "auth"; }
  function credentialById(id) { return state.credentials.find((item) => item.id === id); }
  function download(filename, content, type) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const link = node("a");
    link.href = url;
    link.download = filename;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function meter(used, limit, label) {
    const ratio = limit > 0 ? Math.min(1, Math.max(0, used / limit)) : 0;
    const element = node("span", `meter${ratio >= 1 ? " is-full" : ratio >= 0.8 ? " is-warn" : ""}`);
    element.setAttribute("role", "meter");
    element.setAttribute("aria-label", label);
    element.setAttribute("aria-valuemin", "0");
    element.setAttribute("aria-valuemax", String(limit));
    element.setAttribute("aria-valuenow", String(Math.min(used, limit)));
    element.setAttribute("aria-valuetext", t("{percent}% 사용", { percent: Math.round(ratio * 100) }));
    const fill = node("span", "meter-fill");
    fill.style.width = `${ratio * 100}%`;
    element.append(fill);
    return element;
  }

  /* ---------- Controls and operations ---------- */
  function captureButtonLabels() {
    document.querySelectorAll("button").forEach((button) => {
      const label = button.querySelector(".button-label");
      if (label && !button.dataset.labelKo) button.dataset.labelKo = label.textContent.trim();
    });
  }
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
    if (!button.dataset.labelKo) button.dataset.labelKo = labelNode.textContent.trim();
    labelNode.textContent = loading ? t(label) : t(button.dataset.labelKo);
    button.disabled = disabled;
    button.classList.toggle("is-busy", loading);
    if (loading) button.setAttribute("aria-busy", "true"); else button.removeAttribute("aria-busy");
  }
  function setButtonLabel(id, label) { const button = $(id); if (button) { button.dataset.labelKo = label; buttonState(id, button.disabled); } }
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
      status.replaceChildren(dot, document.createTextNode(auth ? t("관리자 연결됨") : state.phase === "connecting" ? t("연결 중") : t("연결 안 됨")));
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
    buttonState("test-button", busy("create") || busy("policyTest"), busy("policyTest"), "시험 중");
    const creating = busy("create");
    $("create-form")?.querySelectorAll("#create-step-1 input, #create-step-1 select, #create-step-1 textarea, #create-step-1 button, #create-step-2 input, #create-step-2 select, #create-step-2 textarea")
      .forEach((control) => { control.disabled = creating; });
    if (!creating) {
      const rows = routeRows();
      rows.forEach((row) => { row.querySelector(".route-remove").disabled = rows.length <= 1; });
      if ($("add-route-button")) $("add-route-button").disabled = rows.length >= 32;
    }
    buttonState("revoke-submit", busy("revoke"), busy("revoke"), "폐기 중");
    buttonState("revoke-cancel-button", busy("revoke"));
    buttonState("copy-key-button", !$("new-key")?.value || busy("copyKey"), busy("copyKey"), "복사 중");
    buttonState("key-done-button", !$("key-saved")?.checked);
    for (const kind of ["create", "revoke"]) {
      document.querySelectorAll(`[data-close="${kind}-dialog"]`).forEach((button) => { button.disabled = busy(kind); });
    }
    buttonState("create-close-button", busy("create"));
    document.querySelectorAll(".filter-button").forEach((button) => { button.disabled = !auth; });
    for (const id of ["credential-search", "credential-status", "event-search", "event-kind", "event-key", "event-period", "event-auto-refresh"]) if ($(id)) $(id).disabled = !auth;
    buttonState("event-export-button", !auth || !state.events.length);
    buttonState("events-more-button", !auth || busy("eventsMore") || state.resources.events?.status === "loading", busy("eventsMore"), "불러오는 중");
    const detail = credentialById(state.detailId);
    buttonState("detail-revoke-button", !auth || !detail || credentialStatus(detail) !== "active" || busy("revoke"));
    for (const id of ["detail-activity-button", "detail-export-button", "detail-reissue-button"]) buttonState(id, !auth || !detail || busy("create"));
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

  /* ---------- Navigation and dialogs ---------- */
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
    text("page-title", connected() ? t(views[state.view][0]) : t("워크스페이스 연결"));
    text("page-description", connected() ? t(views[state.view][1]) : t("관리자 토큰으로 연결하고 서비스의 접근 범위를 관리하세요."));
    text("breadcrumb-current", connected() ? t(views[state.view][0]) : t("시작하기"));
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
    notice("key-replaced-note", "");
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
  function stopAutoRefresh() {
    if (state.autoRefresh) clearInterval(state.autoRefresh);
    state.autoRefresh = null;
    if ($("event-auto-refresh")) $("event-auto-refresh").checked = false;
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
    state.eventsNext = null;
    state.eventPages = 0;
    state.eventsQuery = "";
    state.decision = "";
    state.eventKind = "";
    state.eventCredential = "";
    state.eventPeriod = "";
    state.credentialSearch = "";
    state.credentialStatus = "active";
    state.eventSearch = "";
    state.detailId = null;
    state.revokeId = null;
    state.createSource = null;
    state.headHash = "";
    state.auditSequence = 0;
    state.overview = null;
    state.audit = null;
    state.auditMode = "";
    state.scenarios = null;
    stopAutoRefresh();
    wipeSecret();
    for (const id of ["create-dialog", "key-dialog", "detail-dialog", "revoke-dialog", ...(!keepConnect ? ["connect-dialog"] : [])]) requestClose(id, true);
    for (const id of ["admin-token", "credential-search", "event-search", "event-kind", "event-period"]) if ($(id)) $(id).value = "";
    if ($("credential-status")) $("credential-status").value = "active";
    renderEventKeyOptions();
    for (const id of ["credentials-body", "events-body", "overview-recent", "scenario-list", "detail-routes", "attention-list", "traffic-chart", "traffic-y-axis", "traffic-x-axis", "traffic-grid", "traffic-table-body", "test-results"]) $(id)?.replaceChildren();
    for (const name of ["active", "total", "allowed", "blocked", "bytes", "day-total", "day-allowed", "day-blocked", "day-bytes"]) text(`stat-${name}`, "—");
    for (const id of ["credential-count", "audit-event-count", "upstream-auth", "alerts-status"]) text(id, "—");
    text("attention-count", "0");
    for (const id of ["upstream-origin", "audit-hash"]) { text(id, t("연결 후 표시됩니다")); $(id)?.removeAttribute("title"); }
    for (const id of ["credentials-error", "events-error", "audit-error", "create-error", "revoke-error", "connect-error", "admin-rotation-note"]) notice(id, "");
    for (const id of ["credentials-retry", "events-retry", "demo-results", "traffic-tooltip"]) hide(id, true);
    globalError("");
    clearTimeout(toastTimer);
    hide("toast", true);
    text("last-updated", "");
    text("version-label", "MIT");
    text("audit-checked-at", t("아직 검증하지 않았습니다"));
    text("audit-mode", "");
    text("audit-description", t("연결 후 감사 로그를 검증할 수 있습니다."));
    text("audit-badge", t("확인 전"));
    if ($("audit-badge")) $("audit-badge").className = "badge badge-neutral";
    renderCredentials();
    renderEvents();
    renderControls();
    setView();
  }

  /* ---------- API ---------- */
  const serverCodes = {
    credential_inactive: "기존 키가 이미 만료되었거나 폐기되었습니다. 기존 키 유지를 선택해 새로 발급하세요.",
    credential_not_found: "키를 찾을 수 없습니다. 목록을 새로고침하세요.",
    demo_already_running: "데모가 이미 실행 중입니다. 잠시 후 다시 시도하세요.",
    request_too_large: "요청이 너무 큽니다. 입력 크기를 줄여 주세요."
  };
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
        if (connecting) { notice("connect-error", t("관리자 토큰이 올바르지 않습니다. 토큰을 확인하고 다시 입력하세요.")); focus("admin-token"); }
        else { globalError(t("관리자 인증이 만료되었거나 변경되었습니다. 다시 연결해 주세요.")); focus("gate-connect-button"); }
        throw apiError(t("관리자 인증이 필요합니다."), "auth");
      }
      let result;
      try { result = await response.json(); }
      catch (error) {
        if (controller.signal.aborted || !current(epoch)) throw error;
        throw apiError(t("서버 응답을 읽지 못했습니다. 잠시 후 다시 시도하세요."), "response", { uncertain: method !== "GET" });
      }
      if (!current(epoch)) throw new DOMException("Session changed", "AbortError");
      if (!response.ok) {
        if (response.status === 422) throw apiError(t("입력한 값을 확인해 주세요."), "validation", { fields: list(result.fields) });
        const code = result?.error?.code;
        const message = response.status === 404 && path === "/api/demo/run" ? t("이 서버에서는 데모를 실행할 수 없습니다.")
          : serverCodes[code] ? t(serverCodes[code])
          : response.status === 403 ? t("이 작업을 수행할 권한이 없습니다.")
          : response.status === 429 ? t("요청이 많습니다. 잠시 후 다시 시도하세요.")
          : t("서버가 요청을 완료하지 못했습니다. 잠시 후 다시 시도하세요.");
        throw apiError(message, "server", { status: response.status, code, uncertain: method !== "GET" && response.status >= 500 });
      }
      return result;
    } catch (error) {
      if (!current(epoch) && error.kind !== "auth") throw new DOMException("Session changed", "AbortError");
      if (timedOut) throw apiError(t("서버 응답이 늦어지고 있습니다. 잠시 후 다시 시도하세요."), "timeout", { uncertain: method !== "GET" });
      if (error instanceof TypeError) throw apiError(t("서버에 연결할 수 없습니다. 서버와 네트워크 상태를 확인하세요."), "network", { uncertain: method !== "GET" });
      throw error;
    } finally { clearTimeout(timer); state.controllers.delete(controller); }
  }
  async function loadResource(name, path, render, errorId) {
    if (!connected()) return;
    const request = { id: ++state.sequence, epoch: state.epoch, status: "loading", error: "", path };
    state.resources[name] = request;
    if (name === "overview") state.auditSequence = request.id;
    if (errorId === "global-error") globalError(""); else notice(errorId, "");
    if (name === "credentials") renderCredentials();
    if (name === "events") renderEvents();
    renderControls();
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
    } finally { if (current(request.epoch)) renderControls(); }
  }

  /* ---------- Audit ---------- */
  function auditProblem(audit) {
    const error = String(audit.error || "");
    const position = error.match(/_(\d+)$/)?.[1];
    if (error.startsWith("events_missing_after")) return t("마지막 확인 이후 감사 기록이 삭제되었습니다. 외부 보관 기록과 비교해 주세요.");
    if (error.startsWith("chain_changed_at")) return t("마지막 확인 이후 {n}번째까지의 기록이 다시 작성되었습니다. 외부 보관 기록과 비교해 주세요.", { n: position });
    if (position) return t("{n}번째 기록의 해시 연결이 일치하지 않습니다. 외부 보관 기록과 비교해 주세요.", { n: position });
    return t("감사 기록의 연결이 일치하지 않습니다. 외부 보관 기록과 비교해 주세요.");
  }
  function renderAudit(audit = {}, sequence = ++state.sequence, checkedAt = new Date()) {
    if (sequence < state.auditSequence) return;
    state.auditSequence = sequence;
    state.audit = { data: audit, sequence, checkedAt };
    const valid = audit.valid === true;
    const label = valid ? t("무결성 확인") : t("확인 필요");
    const message = valid ? t("{n}개 기록의 해시 연결이 일치합니다.", { n: count(audit.event_count) }) : auditProblem(audit);
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
    text("audit-hash", state.headHash || t("저장된 기록이 없습니다"));
    if ($("audit-hash")) $("audit-hash").title = state.headHash;
    text("audit-checked-at", t("{time} 확인", { time: date(checkedAt.toISOString(), true) }));
    text("audit-mode", audit.mode === "full" ? t("처음부터 모든 기록을 다시 계산한 전체 검증") : audit.mode === "incremental" ? t("마지막 확인 이후 기록만 계산한 증분 확인") : "");
    renderControls();
  }

  /* ---------- Overview ---------- */
  function niceMax(value) {
    if (value <= 4) return 4;
    const scale = 10 ** Math.floor(Math.log10(value));
    for (const step of [2, 4, 5, 10]) if (step * scale >= value) return step * scale;
    return 10 * scale;
  }
  function renderTraffic(hourly) {
    const data = list(hourly).map((bucket) => ({ hour: bucket.hour, allowed: Number(bucket.allowed) || 0, blocked: Number(bucket.blocked) || 0, bytes: Number(bucket.bytes) || 0 }));
    const peak = Math.max(0, ...data.map((bucket) => bucket.allowed + bucket.blocked));
    const top = niceMax(peak);
    const chart = $("traffic-chart");
    if (!chart) return;
    hide("traffic-empty", peak > 0 || !data.length);
    $("traffic-y-axis").replaceChildren(...[top, top / 2, 0].map((tick) => node("span", "", count(tick))));
    $("traffic-grid").replaceChildren(...[0, 1, 2].map(() => node("span")));
    const columns = data.map((bucket, index) => {
      const column = node("div", "chart-column");
      column.tabIndex = 0;
      column.setAttribute("role", "img");
      const start = new Date(bucket.hour);
      const label = Number.isFinite(start.getTime()) ? hourFormat.format(start) : "—";
      const summary = t("{hour}부터 1시간: 허용 {allowed}건, 차단·오류 {blocked}건, 응답 {bytes}", { hour: label, allowed: count(bucket.allowed), blocked: count(bucket.blocked), bytes: bytes(bucket.bytes) });
      column.setAttribute("aria-label", summary);
      const stack = node("span", "chart-stack");
      for (const [kind, value] of [["blocked", bucket.blocked], ["allowed", bucket.allowed]]) {
        if (!value) continue;
        const segment = node("span", `chart-segment segment-${kind}`);
        segment.style.height = `${value / top * 100}%`;
        stack.append(segment);
      }
      column.append(stack);
      const show = () => {
        const tooltip = $("traffic-tooltip");
        tooltip.replaceChildren(node("strong", "", t("{hour}부터 1시간", { hour: label })), node("span", "tooltip-row tooltip-allowed", t("허용 {n}건", { n: count(bucket.allowed) })), node("span", "tooltip-row tooltip-blocked", t("차단·오류 {n}건", { n: count(bucket.blocked) })), node("span", "tooltip-row", t("응답 {bytes}", { bytes: bytes(bucket.bytes) })));
        tooltip.hidden = false;
        const center = column.offsetLeft + column.offsetWidth / 2;
        tooltip.style.left = `${center}px`;
        tooltip.classList.toggle("align-end", index > data.length - 5);
        tooltip.classList.toggle("align-start", index < 4);
      };
      const conceal = () => hide("traffic-tooltip", true);
      column.addEventListener("mouseenter", show);
      column.addEventListener("focus", show);
      column.addEventListener("mouseleave", conceal);
      column.addEventListener("blur", conceal);
      return column;
    });
    chart.replaceChildren(...columns);
    $("traffic-x-axis").replaceChildren(...data.map((bucket, index) => {
      const start = new Date(bucket.hour);
      return node("span", "", index % 6 === 0 && Number.isFinite(start.getTime()) ? hourFormat.format(start) : index === data.length - 1 ? t("지금") : "");
    }));
    $("traffic-table-body").replaceChildren(...data.slice().reverse().map((bucket) => {
      const row = node("tr");
      const start = new Date(bucket.hour);
      row.append(node("th", "", Number.isFinite(start.getTime()) ? date(bucket.hour) : "—"), node("td", "", count(bucket.allowed)), node("td", "", count(bucket.blocked)), node("td", "", bytes(bucket.bytes)));
      row.firstChild.scope = "row";
      return row;
    }));
  }
  function credentialLabel(id) {
    const credential = credentialById(id);
    return credential ? `${credential.name} (${credential.prefix}…)` : id ? `${String(id).slice(0, 8)}…` : "";
  }
  function renderOverview(data, request) {
    state.overview = data;
    state.demoMode = data.demo_mode === true;
    hide("demo-banner", !state.demoMode);
    text("environment-label", state.demoMode ? t("로컬 데모") : t("운영 환경"));
    text("overview-mode", state.demoMode ? t("데모 환경") : t("운영 환경"));
    text("version-label", data.version ? `v${data.version} · MIT` : "MIT");
    const stats = data.stats || {};
    const day = stats.last_24h || {};
    text("stat-active", count(stats.active_credentials));
    text("stat-total", t("{n}건", { n: count(stats.total_requests) }));
    text("stat-allowed", count(stats.allowed));
    text("stat-blocked", t("{n}건", { n: count(stats.blocked) }));
    text("stat-bytes", bytes(stats.bytes_forwarded));
    text("stat-day-total", count(day.total));
    text("stat-day-allowed", t("{n}건", { n: count(day.allowed) }));
    text("stat-day-blocked", count(day.blocked));
    text("stat-day-bytes", bytes(day.bytes_forwarded));
    text("overview-active-summary", t("만료되거나 폐기되지 않은 키가 {n}개 있습니다. 사용량 한도는 각 키에서 확인하세요.", { n: count(stats.active_credentials) }));
    renderTraffic(stats.hourly);
    text("upstream-origin", data.upstream_origin || "—");
    if ($("upstream-origin")) $("upstream-origin").title = data.upstream_origin || "";
    const auth = data.upstream_auth || {};
    text("upstream-auth", auth.header ? (auth.scheme ? `${auth.header}: ${auth.scheme} …` : t("{header}: 토큰 원문", { header: auth.header })) : "—");
    text("alerts-status", data.alerts?.enabled ? t("사용 중") : t("설정 안 됨"));
    notice("admin-rotation-note", data.admin_token_rotation ? t("다음 관리자 토큰이 함께 허용되고 있어요. 교체를 마치면 이전 토큰 설정을 지워 주세요.") : "");
    if (request) renderAudit(data.audit, request.id);
    text("last-updated", t("{time} 업데이트", { time: timeFormat.format(new Date()) }));
    const recent = list(data.recent_events).filter((event) => event.kind === "proxy").slice(0, 5);
    $("overview-recent")?.replaceChildren();
    hide("overview-recent-empty", recent.length > 0);
    for (const event of recent) {
      const item = node("li", "recent-item");
      const main = node("div", "recent-main");
      main.append(badge(decisions[event.decision] ? t(decisions[event.decision]) : t("기록"), decisions[event.decision] ? event.decision : "neutral"));
      if (event.method) main.append(node("span", "method", event.method));
      main.append(node("span", `path-label${event.path && event.path !== "[unmatched]" ? "" : " is-prose"}`, displayPath(event)));
      const meta = node("div", "recent-meta");
      meta.append(node("span", "", reasonLabel(event.reason)));
      if (event.credential_id) meta.append(node("span", "recent-key", credentialLabel(event.credential_id)));
      meta.append(node("time", "", date(event.ts)));
      item.append(main, meta);
      $("overview-recent")?.append(item);
    }
    renderControls();
  }
  function attentionItems() {
    const items = [];
    for (const credential of state.credentials) {
      if (credentialStatus(credential) !== "active") continue;
      const remaining = new Date(credential.expires_at).getTime() - Date.now();
      const budget = lifetimeBudget(credential);
      const notes = [];
      let urgency = Infinity;
      if (expiringSoon(credential)) { notes.push(t("{when} 만료", { when: relative(credential.expires_at) })); urgency = Math.min(urgency, remaining / 86400e3); }
      for (const [used, limit, label] of [[budget.requests, budget.requestLimit, "총 요청"], [budget.responseBytes, budget.byteLimit, "총 응답"]]) {
        if (limit === null || !limit) continue;
        const ratio = used / limit;
        if (ratio >= 1) { notes.push(t("{name} 한도 도달", { name: t(label) })); urgency = Math.min(urgency, -1); }
        else if (ratio >= 0.8) { notes.push(t("{name} {percent}% 사용", { name: t(label), percent: Math.round(ratio * 100) })); urgency = Math.min(urgency, 1 - ratio); }
      }
      if (notes.length) items.push({ credential, notes, urgency });
    }
    return items.sort((a, b) => a.urgency - b.urgency);
  }
  function renderAttention() {
    const items = attentionItems();
    text("attention-count", count(items.length));
    hide("attention-empty", items.length > 0);
    $("attention-list")?.replaceChildren(...items.slice(0, 5).map(({ credential, notes }) => {
      const item = node("li", "attention-item");
      const button = node("button", "credential-detail-button", credential.name);
      button.type = "button";
      button.addEventListener("click", () => openCredential(credential.id, button));
      item.append(button, node("span", "attention-note", notes.join(" · ")));
      return item;
    }));
    if (items.length > 5) $("attention-list")?.append(node("li", "attention-more", t("외 {n}개는 릴레이 키 화면에서 확인하세요.", { n: count(items.length - 5) })));
    if (connected()) text("stat-active-caption", items.length ? t("확인이 필요한 키 {n}개", { n: count(items.length) }) : t("만료되거나 폐기되지 않은 키"));
  }

  /* ---------- Credentials ---------- */
  function credentialStatus(credential) { return credential.revoked_at ? "revoked" : new Date(credential.expires_at).getTime() <= Date.now() ? "expired" : "active"; }
  function statusLabel(status) { return t({ active: "활성", expired: "만료", revoked: "폐기" }[status] || "확인 필요"); }
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
    if (requestRemaining === 0) exhausted.push(t("총 요청 한도 도달"));
    if (byteRemaining === 0) exhausted.push(t("총 응답 한도 도달"));
    return { requests, responseBytes, requestLimit, byteLimit, requestRemaining, byteRemaining, exhausted };
  }
  function soonWindow(credential) {
    const lifetime = new Date(credential.expires_at).getTime() - new Date(credential.created_at).getTime();
    return Math.min(86400e3, Number.isFinite(lifetime) && lifetime > 0 ? lifetime / 4 : 86400e3);
  }
  function expiringSoon(credential) {
    return credentialStatus(credential) === "active" && new Date(credential.expires_at).getTime() - Date.now() < soonWindow(credential);
  }
  function cell(label, content, className = "") {
    const element = node("td", className);
    element.dataset.label = t(label);
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
  function usageLine(label, value, used, limit, meterLabel) {
    const line = node("span", "usage-line");
    line.append(node("span", "usage-text", `${t(label)} ${value}`));
    if (limit) line.append(meter(used, limit, meterLabel));
    return line;
  }
  function renderCredentials() {
    const resource = state.resources.credentials;
    const loading = resource?.status === "loading";
    const failed = resource?.status === "error";
    $("credentials")?.setAttribute("aria-busy", String(loading));
    hide("credentials-retry", !failed);
    text("credential-count", connected() ? count(state.credentials.length) : "—");
    $("credentials-body")?.replaceChildren();
    const query = state.credentialSearch.toLocaleLowerCase(locale());
    const rank = { active: 0, expired: 1, revoked: 2 };
    const items = state.credentials
      .map((item, index) => ({ item, index, status: credentialStatus(item) }))
      .filter(({ item, status }) => {
        const haystack = [item.name, item.prefix, item.id, ...list(item.policy?.routes).map((route) => `${route.method} ${route.path}`)].join(" ").toLocaleLowerCase(locale());
        return (!query || haystack.includes(query)) && (state.credentialStatus === "all" || status === state.credentialStatus);
      })
      .sort((a, b) => rank[a.status] - rank[b.status] || a.index - b.index);
    const filtered = Boolean(query) || state.credentialStatus !== "active";
    hide("empty-create-button", true);
    hide("clear-key-filters", !filtered);
    hide("show-all-keys", true);
    renderAttention();
    renderEventKeyOptions();
    if (!connected() || (loading && !state.credentials.length) || failed) {
      text("credential-visible-count", loading ? t("키를 불러오는 중입니다") : failed ? t("목록을 불러오지 못했습니다") : "");
      hide("credentials-empty", failed);
      if (!failed) emptyState("credentials-empty", loading ? t("키를 불러오고 있습니다") : t("연결 후 키를 확인할 수 있습니다"), loading ? t("잠시만 기다려 주세요.") : t("관리자 토큰으로 연결해 주세요."));
      return;
    }
    const activeCount = state.credentials.filter((item) => credentialStatus(item) === "active").length;
    text("credential-visible-count", t("{shown}개 표시 · 활성 {active}개 · 전체 {total}개{loading}", { shown: count(items.length), active: count(activeCount), total: count(state.credentials.length), loading: loading ? t(" · 업데이트 중") : "" }));
    hide("credentials-empty", items.length > 0);
    if (!items.length) {
      const onlyInactive = !query && state.credentialStatus === "active" && state.credentials.length > 0;
      emptyState("credentials-empty",
        onlyInactive ? t("활성 키가 없습니다") : filtered ? t("조건에 맞는 키가 없습니다") : t("첫 번째 릴레이 키를 만들어 보세요"),
        onlyInactive ? t("만료되거나 폐기된 키 {n}개는 모든 상태에서 볼 수 있어요.", { n: count(state.credentials.length) }) : filtered ? t("이름, 접두사 또는 경로를 다시 검색하거나 필터를 초기화하세요.") : t("필요한 경로와 사용량을 정하면 키를 발급할 수 있습니다."));
      hide("empty-create-button", filtered && !onlyInactive);
      hide("show-all-keys", !onlyInactive);
    }
    for (const { item: credential, status } of items) {
      const row = node("tr");
      if (status !== "active") row.classList.add("is-inactive");
      const name = node("div");
      const detailButton = node("button", "credential-detail-button credential-name", credential.name);
      detailButton.type = "button";
      detailButton.addEventListener("click", () => openCredential(credential.id, detailButton));
      name.append(detailButton, node("code", "credential-prefix", `${credential.prefix}…`));
      const routes = list(credential.policy?.routes);
      const route = node("div", "route-tags");
      route.append(node("span", "route-tag", routes[0] ? `${routes[0].method} ${routes[0].path}` : t("허용 경로 없음")));
      if (routes.length > 1) route.append(node("span", "quota-secondary", t("외 {n}개 경로", { n: count(routes.length - 1) })));
      const policy = credential.policy || {};
      const usage = credential.usage || {};
      const minuteRequests = Number(usage.minute_requests) || 0;
      const minuteBytes = Number(usage.minute_bytes) || 0;
      const quota = node("div", "usage-cell");
      quota.append(
        usageLine("분당 요청", t("{used} / {limit}회", { used: count(minuteRequests), limit: count(policy.requests_per_minute) }), minuteRequests, policy.requests_per_minute, t("이번 분 요청 사용량")),
        usageLine("분당 응답", `${bytes(minuteBytes)} / ${bytes(policy.bytes_per_minute)}`, minuteBytes, policy.bytes_per_minute, t("이번 분 응답 사용량")));
      const budget = lifetimeBudget(credential);
      if (budget.requestLimit !== null) quota.append(usageLine("총 요청", t("{used} / {limit}건", { used: count(budget.requests), limit: count(budget.requestLimit) }), budget.requests, budget.requestLimit, t("총 요청 사용량")));
      if (budget.byteLimit !== null) quota.append(usageLine("총 응답", `${bytes(budget.responseBytes)} / ${bytes(budget.byteLimit)}`, budget.responseBytes, budget.byteLimit, t("총 응답 사용량")));
      if (budget.requestLimit === null && budget.byteLimit === null) quota.append(node("span", "quota-secondary", t("총량 제한 없음")));
      const expiry = node("div", "expiry-cell");
      expiry.append(node("span", "", date(credential.expires_at, true)), node("span", "quota-secondary", status === "revoked" ? t("폐기됨") : relative(credential.expires_at)));
      const statusContent = node("div", "credential-state");
      statusContent.append(badge(statusLabel(status), status === "active" ? "allow" : "neutral"));
      if (expiringSoon(credential)) statusContent.append(badge(t("곧 만료"), "warning"));
      for (const label of budget.exhausted) statusContent.append(badge(label, "deny"));
      const actions = node("div", "row-actions");
      if (status === "active") {
        const revoke = node("button", "revoke-button", t("폐기하기"));
        revoke.type = "button";
        revoke.setAttribute("aria-label", t("{name}, {prefix} 키 폐기", { name: credential.name, prefix: credential.prefix }));
        revoke.addEventListener("click", () => openRevoke(credential.id, revoke));
        actions.append(revoke);
      }
      row.append(cell("이름", name), cell("허용 경로", route), cell("사용량", quota), cell("만료 일시", expiry), cell("상태", statusContent), cell("작업", actions, "cell-actions"));
      $("credentials-body")?.append(row);
    }
    if (state.detailId && $("detail-dialog")?.open) populateDetail();
  }
  function setDetailMeter(id, used, limit, label) {
    const element = $(id);
    if (!element) return;
    element.replaceChildren(...(limit ? [meter(used, limit, label)] : []));
    element.hidden = !limit;
  }
  function populateDetail() {
    const credential = credentialById(state.detailId);
    if (!credential) { requestClose("detail-dialog", true); return; }
    const policy = credential.policy || {};
    const usage = credential.usage || {};
    const status = credentialStatus(credential);
    text("detail-name", credential.name);
    text("detail-prefix", `${credential.prefix}…`);
    text("detail-id", credential.id);
    text("detail-status", statusLabel(status));
    if ($("detail-status")) $("detail-status").className = `badge badge-${status === "active" ? "allow" : "neutral"}`;
    text("detail-expiry-badge", t("곧 만료"));
    hide("detail-expiry-badge", !expiringSoon(credential));
    text("detail-expiry", date(credential.expires_at, true));
    text("detail-expiry-relative", status === "revoked" ? t("{time}에 폐기됨", { time: date(credential.revoked_at, true) }) : relative(credential.expires_at));
    text("detail-created", date(credential.created_at, true));
    $("detail-routes")?.replaceChildren();
    for (const route of list(policy.routes)) {
      const item = node("li", "detail-route");
      const keys = list(route.query_keys);
      item.append(node("code", "route-tag", `${route.method} ${route.path}`), node("span", "field-help", keys.length ? t("허용 쿼리: {keys}", { keys: keys.join(", ") }) : t("쿼리 매개변수 허용 안 함")));
      $("detail-routes")?.append(item);
    }
    text("detail-ips", list(policy.ip_allowlist).length ? policy.ip_allowlist.join(", ") : t("IP 주소 제한 없음"));
    text("detail-forward", list(policy.forward_error_statuses).length ? policy.forward_error_statuses.join(", ") : t("없음 (모두 502)"));
    const minuteRequests = Number(usage.minute_requests) || 0;
    const minuteBytes = Number(usage.minute_bytes) || 0;
    text("detail-rate", t("{n}회 / 분", { n: count(policy.requests_per_minute) }));
    text("detail-budget", t("{size} / 분 ({n}바이트)", { size: bytes(policy.bytes_per_minute), n: count(policy.bytes_per_minute) }));
    text("detail-response", t("{size} ({n}바이트)", { size: bytes(policy.response_bytes_limit), n: count(policy.response_bytes_limit) }));
    const rateUsage = $("detail-rate-usage");
    rateUsage?.replaceChildren(usageLine("이번 분", t("{n}회 사용", { n: count(minuteRequests) }), minuteRequests, policy.requests_per_minute, t("이번 분 요청 사용량")));
    $("detail-budget-usage")?.replaceChildren(usageLine("이번 분", t("{size} 사용", { size: bytes(minuteBytes) }), minuteBytes, policy.bytes_per_minute, t("이번 분 응답 사용량")));
    const budget = lifetimeBudget(credential);
    text("detail-total-requests", budget.requestLimit === null ? t("{n}건 사용", { n: count(budget.requests) }) : t("{used} / {limit}건", { used: count(budget.requests), limit: count(budget.requestLimit) }));
    setDetailMeter("detail-total-requests-meter", budget.requests, budget.requestLimit, t("총 요청 사용량"));
    text("detail-total-requests-remaining", budget.requestRemaining === null ? t("총 요청 수 제한 없음") : t("잔여 {n}건", { n: count(budget.requestRemaining) }));
    text("detail-total-bytes", budget.byteLimit === null ? t("{size} 사용", { size: bytes(budget.responseBytes) }) : `${bytes(budget.responseBytes)} / ${bytes(budget.byteLimit)}`);
    setDetailMeter("detail-total-bytes-meter", budget.responseBytes, budget.byteLimit, t("총 응답 사용량"));
    text("detail-total-bytes-remaining", budget.byteRemaining === null ? t("총 응답 사용량 제한 없음 · 사용 {n}바이트", { n: count(budget.responseBytes) }) : t("사용 {used}바이트 · 잔여 {left}바이트", { used: count(budget.responseBytes), left: count(budget.byteRemaining) }));
    text("detail-budget-status", budget.exhausted.join(" / "));
    hide("detail-budget-status", budget.exhausted.length === 0);
    hide("detail-revoke-button", status !== "active");
    setButtonLabel("detail-reissue-button", status === "active" ? "키 교체하기" : "같은 정책으로 새로 발급");
    renderControls();
  }
  function openCredential(id, trigger) {
    state.detailId = id;
    populateDetail();
    openDialog("detail-dialog", "detail-name", trigger);
  }
  function openRevoke(id, trigger = document.activeElement) {
    const credential = credentialById(id);
    if (!credential || credentialStatus(credential) !== "active" || state.pending.has("revoke")) return;
    state.revokeId = id;
    text("revoke-name", credential.name);
    text("revoke-prefix", `${credential.prefix}…`);
    notice("revoke-error", "");
    requestClose("detail-dialog", true);
    openDialog("revoke-dialog", "revoke-cancel-button", trigger);
  }
  function policyDocument(credential) {
    const created = new Date(credential.created_at).getTime();
    const expires = new Date(credential.expires_at).getTime();
    const hours = Number.isFinite(created) && Number.isFinite(expires) ? Math.round((expires - created) / 3600e3) : 24;
    return { name: credential.name, ttl_hours: Math.min(720, Math.max(1, hours)), policy: credential.policy || {} };
  }

  /* ---------- Activity ---------- */
  function eventsUrl(beforeId) {
    const params = new URLSearchParams({ limit: "100" });
    if (state.decision) params.set("decision", state.decision);
    if (state.eventKind) params.set("kind", state.eventKind);
    if (state.eventCredential) params.set("credential_id", state.eventCredential);
    if (state.eventPeriod) params.set("since_hours", state.eventPeriod);
    if (beforeId) params.set("before_id", String(beforeId));
    return `/api/events?${params}`;
  }
  function renderEventKeyOptions() {
    const select = $("event-key");
    if (!select) return;
    const options = [node("option", "", t("모든 키"))];
    options[0].value = "";
    const known = new Set();
    for (const credential of state.credentials) {
      const option = node("option", "", `${credential.name} · ${credential.prefix}…${credentialStatus(credential) === "active" ? "" : ` (${statusLabel(credentialStatus(credential))})`}`);
      option.value = credential.id;
      known.add(credential.id);
      options.push(option);
    }
    if (state.eventCredential && !known.has(state.eventCredential)) {
      const option = node("option", "", t("선택한 키 {id}", { id: `${state.eventCredential.slice(0, 8)}…` }));
      option.value = state.eventCredential;
      options.push(option);
    }
    select.replaceChildren(...options);
    select.value = state.eventCredential;
  }
  function displayPath(event) {
    if (event.path === "[unmatched]") return t("정책에 없는 경로");
    return event.path || t("프록시 요청");
  }
  function eventAction(event) { return kinds[event.kind] ? t(kinds[event.kind]) : displayPath(event); }
  function eventHaystack(event) {
    const credential = credentialById(event.credential_id);
    return [event.path, displayPath(event), event.method, event.reason, reasonLabel(event.reason), event.credential_id, credential?.name, credential?.prefix,
      event.status, event.upstream_status, event.peer_ip, event.request_id, kinds[event.kind] ? t(kinds[event.kind]) : ""].join(" ").toLocaleLowerCase(locale());
  }
  function visibleEvents() {
    const query = state.eventSearch.toLocaleLowerCase(locale());
    return state.events.filter((event) => !query || eventHaystack(event).includes(query));
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
    const filtered = Boolean(state.eventSearch || state.decision || state.eventKind || state.eventCredential || state.eventPeriod);
    hide("clear-event-filters", !filtered);
    hide("events-more-button", true);
    if (!connected() || loading || failed) {
      text("event-count", loading ? t("불러오는 중") : failed ? t("조회 실패") : t("기록 0건"));
      hide("events-empty", failed);
      if (!failed) emptyState("events-empty", loading ? t("{decision} 기록을 불러오고 있습니다", { decision: t(decisions[state.decision]) }) : t("연결 후 기록을 확인할 수 있습니다"), loading ? t("잠시만 기다려 주세요.") : t("관리자 토큰으로 연결해 주세요."));
      text("events-announcement", failed ? t("{decision} 기록을 불러오지 못했습니다. 다시 시도해 주세요.", { decision: t(decisions[state.decision]) }) : loading ? t("기록을 불러오는 중입니다.") : "");
      renderControls();
      return;
    }
    const items = visibleEvents();
    text("event-count", state.eventSearch ? t("{total}건 중 {shown}건", { total: count(state.events.length), shown: count(items.length) }) : t("기록 {n}건", { n: count(items.length) }));
    text("events-announcement", t("{decision} 기록 {n}건을 표시합니다.", { decision: t(decisions[state.decision]), n: count(items.length) }));
    hide("events-empty", items.length > 0);
    hide("events-more-button", !state.eventsNext);
    if (!items.length) emptyState("events-empty", state.eventSearch ? t("검색 결과가 없습니다") : t("해당하는 기록이 없습니다"), filtered ? t("검색어나 필터를 변경해 보세요.") : state.demoMode ? t("데모를 실행하거나 릴레이 키를 발급하면 기록이 쌓입니다.") : t("릴레이 요청과 키 변경 이력이 이곳에 표시됩니다."));
    for (const event of items) {
      const row = node("tr");
      const proxy = event.kind === "proxy";
      const request = node("div", "event-path");
      const line = node("span", "event-line");
      if (event.method) line.append(node("span", "method", event.method));
      const action = proxy ? displayPath(event) : eventAction(event);
      const path = node("span", `path-label${proxy && event.path && event.path !== "[unmatched]" ? "" : " is-prose"}`, action);
      path.title = action;
      line.append(path);
      request.append(line);
      if (!proxy && event.path && event.kind === "admin_auth") request.append(node("span", "event-secondary", event.path));
      if (event.related_credential_id) request.append(node("span", "event-secondary", t("연결된 키: {key}", { key: credentialLabel(event.related_credential_id) })));
      if (event.request_id) {
        const id = node("span", "event-secondary", `${t("요청 ID")} `);
        const value = node("code", "event-request-id", event.request_id.slice(0, 12));
        value.title = event.request_id;
        id.append(value);
        request.append(id);
      }
      const key = node("div", "event-key");
      const credential = credentialById(event.credential_id);
      if (credential) {
        const button = node("button", "credential-detail-button", credential.name);
        button.type = "button";
        button.addEventListener("click", () => openCredential(credential.id, button));
        key.append(button, node("code", "credential-prefix", `${credential.prefix}…`));
      } else key.append(node("span", "event-secondary", event.credential_id ? `${event.credential_id.slice(0, 8)}…` : proxy || event.kind === "admin_auth" ? t("키 없음") : "—"));
      if (event.peer_ip) key.append(node("span", "event-secondary", `IP ${event.peer_ip}`));
      const time = cell("일시", date(event.ts), "event-time");
      time.title = event.ts || "";
      const result = badge(!proxy && event.decision === "allow" ? t("완료") : decisions[event.decision] ? t(decisions[event.decision]) : event.decision, decisions[event.decision] ? event.decision : "neutral");
      const reasonText = proxy || event.kind === "admin_auth" ? reasonLabel(event.reason) : event.kind === "credential_rotated" ? t("새 키로 교체") : "—";
      const status = node("div", "event-status-cell");
      status.append(node("span", "event-status", event.status || "—"));
      if (event.upstream_status && event.upstream_status !== event.status) status.append(node("span", "event-secondary", t("원본 {status}", { status: event.upstream_status })));
      row.append(time, cell("결과", result), cell("키", key), cell("요청 / 작업", request), cell("사유", reasonText, "event-reason"), cell("HTTP", status), cell("응답 크기", proxy ? bytes(event.response_bytes) : "—"));
      $("events-body")?.append(row);
    }
    renderControls();
  }
  function csvField(value) {
    let textValue = value === null || value === undefined ? "" : String(value);
    // Spreadsheet formula injection: neutralize cells that start a formula.
    if (/^[=+\-@\t\r]/.test(textValue)) textValue = `'${textValue}`;
    return /[",\n\r]/.test(textValue) ? `"${textValue.replace(/"/g, '""')}"` : textValue;
  }
  function exportEventsCsv() {
    const columns = ["id", "ts", "kind", "decision", "reason", "credential_id", "credential_name", "method", "path", "status", "upstream_status", "response_bytes", "peer_ip", "request_id", "related_credential_id"];
    const rows = visibleEvents().map((event) => columns.map((column) => csvField(column === "credential_name" ? credentialById(event.credential_id)?.name : event[column])).join(","));
    download(`relayguard-activity-${new Date().toISOString().slice(0, 19).replace(/:/g, "")}.csv`, [columns.join(","), ...rows].join("\r\n") + "\r\n", "text/csv;charset=utf-8");
    toast(t("불러온 활동 {n}건을 CSV로 내보냈습니다.", { n: count(rows.length) }));
  }

  /* ---------- Loading ---------- */
  const loadOverview = () => loadResource("overview", "/api/overview", renderOverview, "global-error");
  const loadCredentials = () => loadResource("credentials", "/api/credentials", (data) => { state.credentials = list(data.items); renderCredentials(); renderEvents(); if (state.overview) renderOverview(state.overview); }, "credentials-error");
  function loadEvents(decision = state.decision) {
    state.decision = Object.hasOwn(decisions, decision) ? decision : "";
    const url = eventsUrl();
    state.eventsQuery = url;
    return loadResource("events", url, (data) => { state.events = list(data.items); state.eventsNext = data.next_before_id ?? null; state.eventPages = 1; renderEvents(); }, "events-error");
  }
  async function loadMoreEvents() {
    if (!connected() || !state.eventsNext) return;
    const operation = begin("eventsMore");
    if (!operation) return;
    const query = state.eventsQuery;
    notice("events-error", "");
    try {
      const data = await api(eventsUrl(state.eventsNext));
      if (!active(operation) || state.eventsQuery !== query || state.resources.events?.status !== "ready") return;
      const seen = new Set(state.events.map((event) => event.id));
      state.events = state.events.concat(list(data.items).filter((event) => !seen.has(event.id)));
      state.eventsNext = data.next_before_id ?? null;
      state.eventPages += 1;
      renderEvents();
    } catch (error) { if (active(operation) && !cancelled(error)) notice("events-error", error.message); }
    finally { finish(operation); }
  }
  async function syncResources() { await Promise.all([loadOverview(), loadCredentials(), loadEvents()]); }
  async function refresh() {
    if (!connected()) return;
    const operation = begin("refresh");
    if (!operation) return;
    globalError("");
    try { await syncResources(); } finally { finish(operation); }
  }
  function autoRefreshTick() {
    if (!connected() || state.view !== "activity" || document.hidden) return;
    if (state.resources.events?.status === "loading" || state.pending.has("eventsMore") || state.eventPages > 1) return;
    loadEvents();
  }

  /* ---------- Create form ---------- */
  function routeRows() { return Array.from(document.querySelectorAll("#route-list .route-row")); }
  function addRouteRow(route = { method: "GET", path: "", query_keys: [] }, moveFocus = false) {
    const container = $("route-list");
    if (!container || routeRows().length >= 32) return;
    const id = ++state.routeSequence;
    const row = node("div", "route-row");
    const methodLabel = node("label", "sr-only", t("메서드"));
    methodLabel.htmlFor = `route-method-${id}`;
    const method = node("select", "route-method");
    method.id = `route-method-${id}`;
    for (const value of methods) { const option = node("option", "", value); option.value = value; method.append(option); }
    method.value = methods.includes(String(route.method).toUpperCase()) ? String(route.method).toUpperCase() : "GET";
    const pathLabel = node("label", "sr-only", t("경로"));
    pathLabel.htmlFor = `route-path-${id}`;
    const path = node("input", "route-path");
    path.id = `route-path-${id}`;
    path.spellcheck = false;
    path.autocomplete = "off";
    path.placeholder = "/customers/*";
    path.value = route.path || "";
    const queryLabel = node("label", "sr-only", t("허용할 쿼리 키"));
    queryLabel.htmlFor = `route-query-${id}`;
    const query = node("input", "route-query");
    query.id = `route-query-${id}`;
    query.spellcheck = false;
    query.autocomplete = "off";
    query.placeholder = t("예: limit, page");
    query.value = list(route.query_keys).join(", ");
    const remove = node("button", "icon-button route-remove");
    remove.type = "button";
    remove.setAttribute("aria-label", t("이 경로 삭제"));
    const icon = node("img", "icon");
    icon.src = "/static/icons/x.svg";
    icon.alt = "";
    remove.append(icon);
    remove.addEventListener("click", () => {
      if (routeRows().length <= 1) return;
      const next = row.nextElementSibling || row.previousElementSibling;
      row.remove();
      fieldError("key-routes");
      updateCreatePreview();
      renderControls();
      next?.querySelector(".route-path")?.focus();
    });
    for (const input of [method, path, query]) input.addEventListener("input", () => { input.removeAttribute("aria-invalid"); fieldError("key-routes"); notice("create-error", ""); updateCreatePreview(); });
    row.append(methodLabel, method, pathLabel, path, queryLabel, query, remove);
    container.append(row);
    renderControls();
    if (moveFocus) path.focus();
  }
  function setRoutes(routes) {
    $("route-list")?.replaceChildren();
    for (const route of routes.length ? routes : [{ method: "GET", path: "", query_keys: [] }]) addRouteRow(route);
  }
  function splitValues(value) { return value.split(/[,\n]/).map((item) => item.trim()).filter(Boolean); }
  function fieldError(id, message = "") {
    notice(`${id}-error`, message);
    const input = $(id);
    if (!input || id === "key-routes" || input.tagName === "FIELDSET" || input.tagName === "DIV") {
      if (id === "key-routes" && !message) routeRows().forEach((row) => row.querySelectorAll("[aria-invalid]").forEach((field) => field.removeAttribute("aria-invalid")));
      if (input && input.tagName === "DIV") { if (message) input.setAttribute("aria-invalid", "true"); else input.removeAttribute("aria-invalid"); }
      return;
    }
    input.setAttribute("aria-invalid", String(Boolean(message)));
    input.setCustomValidity?.(message);
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
    text("create-title", step === 1 ? t("어떤 접근을 허용할까요?") : t("사용량과 접근 조건을 정하세요"));
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
  function byteValue(id) {
    const raw = $(id)?.value.trim() || "";
    if (raw === "") return null;
    const value = Number(raw) * Number($(`${id}-unit`)?.value || 1);
    return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : NaN;
  }
  function setByteField(id, value) {
    const units = Array.from($(`${id}-unit`)?.options || []).map((option) => Number(option.value)).sort((a, b) => b - a);
    if (value === null || value === undefined || value === "") { $(id).value = ""; return; }
    const unit = units.find((size) => value >= size && value % size === 0) || 1;
    $(`${id}-unit`).value = String(unit);
    $(id).value = String(value / unit);
  }
  function selectedStatuses() { return Array.from(document.querySelectorAll("#forward-statuses input:checked")).map((input) => Number(input.value)); }
  function updateTtlChips() {
    document.querySelectorAll(".chip[data-ttl]").forEach((chip) => chip.setAttribute("aria-pressed", String(chip.dataset.ttl === $("key-ttl")?.value.trim())));
  }
  function updateCreatePreview() {
    for (const [input, preview] of [["key-response", "response-preview"], ["key-budget", "budget-preview"]]) {
      const value = byteValue(input);
      text(preview, Number.isFinite(value) && value >= 0 ? t("{size} ({n}바이트)", { size: bytes(value), n: count(value) }) : t("크기를 입력하세요"));
    }
    const routes = routeRows().filter((row) => row.querySelector(".route-path").value.trim());
    const ips = splitValues($("key-ips")?.value || "");
    const totalRequests = optionalNumber("key-total-requests");
    const totalBytes = byteValue("key-total-bytes");
    text("total-bytes-preview", totalBytes === null ? t("총량 제한 없음") : Number.isFinite(totalBytes) && totalBytes >= 0 ? t("{size} ({n}바이트)", { size: bytes(totalBytes), n: count(totalBytes) }) : t("크기를 확인하세요"));
    const statuses = selectedStatuses();
    const lines = [
      $("key-name")?.value.trim() || t("이름 없는 키"),
      t("{hours}시간 동안 {n}개 경로 허용", { hours: $("key-ttl")?.value || "—", n: count(routes.length) }),
      t("분당 {rate}회, 응답당 {response}, 분당 {budget}", { rate: $("key-rate")?.value || "—", response: bytes(byteValue("key-response")), budget: bytes(byteValue("key-budget")) }),
      t("키 전체 유효 기간: 총 요청 {requests}, 총 응답 {bytes}", { requests: totalRequests === null ? t("제한 없음") : t("{n}건", { n: count(totalRequests) }), bytes: totalBytes === null ? t("제한 없음") : bytes(totalBytes) }),
      ips.length ? t("{n}개 IP 대역만 허용", { n: count(ips.length) }) : t("IP 주소 제한 없음"),
      statuses.length ? t("원본 오류 {codes} 전달", { codes: statuses.join(", ") }) : t("원본 오류는 모두 502로 응답")
    ];
    text("create-summary", lines.join("\n"));
    updateTtlChips();
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
  function collectCreate() {
    const errors = {};
    const invalidRoutes = [];
    const add = (id, message) => { if (!errors[id]) errors[id] = message; };
    const name = $("key-name").value.trim();
    if (!name || name.length > 80 || /[\x00-\x1F\x7F]/.test(name)) add("key-name", t("키 이름을 1~80자의 일반 문자로 입력하세요."));
    const routes = [];
    const rows = routeRows();
    if (!rows.length || rows.length > 32) add("key-routes", t("허용 경로를 1~32개 입력하세요."));
    for (const row of rows) {
      const method = row.querySelector(".route-method").value;
      const pathInput = row.querySelector(".route-path");
      const queryInput = row.querySelector(".route-query");
      const path = pathInput.value.trim();
      const query = splitValues(queryInput.value);
      const safe = path.startsWith("/") && path.length <= 256 && (path === "/" || path.slice(1).split("/").every((part) => part === "*" || (part !== "." && part !== ".." && /^[A-Za-z0-9._~-]+$/.test(part))));
      if (!safe) { add("key-routes", path ? t("경로는 /로 시작하고 영문, 숫자, 점, 밑줄, 물결표, 하이픈만 사용할 수 있습니다. *는 경로 한 단계만 허용합니다.") : t("경로를 입력하거나 빈 줄을 삭제하세요.")); invalidRoutes.push(pathInput); }
      if (!query.every((key) => /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)) || query.length > 20 || new Set(query).size !== query.length) {
        add("key-routes", t("쿼리 키는 경로마다 중복 없이 최대 20개입니다. 영문자로 시작하고 영문, 숫자, 밑줄만 사용할 수 있습니다."));
        invalidRoutes.push(queryInput);
      }
      routes.push({ method, path, query_keys: query });
    }
    const seen = new Set();
    routes.forEach((route, index) => {
      const key = `${route.method} ${route.path}`;
      if (seen.has(key)) { add("key-routes", t("같은 메서드와 경로를 중복 입력하지 마세요.")); invalidRoutes.push(rows[index].querySelector(".route-path")); }
      seen.add(key);
    });
    const numbers = {
      "key-ttl": [optionalNumber("key-ttl"), 1, 720, t("유효 시간을 1~720시간의 정수로 입력하세요.")],
      "key-rate": [optionalNumber("key-rate"), 1, 10000, t("분당 요청 수를 1~10,000회의 정수로 입력하세요.")],
      "key-response": [byteValue("key-response"), 128, 1048576, t("응답당 제한은 128바이트~1MB 사이의 정수 바이트여야 합니다.")],
      "key-budget": [byteValue("key-budget"), 128, 104857600, t("분당 응답 크기는 128바이트~100MB 사이의 정수 바이트여야 합니다.")],
      "key-total-requests": [optionalNumber("key-total-requests"), 1, 1000000000, t("총 요청 수를 1~1,000,000,000건의 정수로 입력하거나 비워 두세요."), true],
      "key-total-bytes": [byteValue("key-total-bytes"), 128, 1000000000000, t("총 응답 사용량은 128바이트~1TB 사이의 정수 바이트로 입력하거나 비워 두세요."), true]
    };
    const values = {};
    for (const [id, [value, min, max, message, optional = false]] of Object.entries(numbers)) {
      values[id] = value;
      if (optional && value === null && !$(id).validity?.badInput) continue;
      if (value === null || !Number.isInteger(value) || value < min || value > max) add(id, message);
    }
    const ips = splitValues($("key-ips").value);
    const keys = ips.map(networkKey);
    if (ips.length > 32 || keys.some((key) => key === null)) add("key-ips", t("올바른 IP 주소 또는 네트워크 CIDR을 최대 32개 입력하세요. 예: 127.0.0.1/32, 10.0.0.0/24, ::1/128"));
    else if (new Set(keys).size !== keys.length) add("key-ips", t("같은 IP 대역을 중복 입력하지 마세요."));
    const body = { name, ttl_hours: values["key-ttl"], policy: {
      routes, ip_allowlist: ips, requests_per_minute: values["key-rate"], response_bytes_limit: values["key-response"], bytes_per_minute: values["key-budget"],
      max_total_requests: values["key-total-requests"], max_total_bytes: values["key-total-bytes"], forward_error_statuses: selectedStatuses()
    } };
    return { body, errors, invalidRoutes };
  }
  function validateCreate(steps = [1, 2]) {
    for (const [id, step] of Object.entries(formFields)) if (steps.includes(step)) fieldError(id);
    const { body, errors, invalidRoutes } = collectCreate();
    const relevant = Object.entries(errors).filter(([id]) => steps.includes(formFields[id]));
    if (relevant.length) {
      for (const [id, message] of relevant) fieldError(id, message);
      if (steps.includes(1)) invalidRoutes.forEach((input) => input.setAttribute("aria-invalid", "true"));
      const first = Object.keys(formFields).find((id) => relevant.some(([key]) => key === id));
      showCreateStep(formFields[first], false);
      const target = first === "key-routes" ? invalidRoutes[0] || routeRows()[0]?.querySelector(".route-path") : $(first);
      target?.focus();
      if (target && first !== "key-routes") target.reportValidity?.();
      return null;
    }
    return body;
  }
  function showServerValidation(error) {
    const mapping = { name: "key-name", ttl_hours: "key-ttl", routes: "key-routes", query_keys: "key-routes", ip_allowlist: "key-ips", requests_per_minute: "key-rate", response_bytes_limit: "key-response", bytes_per_minute: "key-budget", max_total_requests: "key-total-requests", max_total_bytes: "key-total-bytes", forward_error_statuses: "forward-statuses", grace_hours: "rotation-mode" };
    const messages = { "key-name": "키 이름을 1~80자의 일반 문자로 입력하세요.", "key-ttl": "유효 시간은 1~720시간이어야 합니다.", "key-routes": "허용 경로와 쿼리 키의 형식과 중복 여부를 확인하세요.", "key-ips": "IP 주소와 CIDR의 네트워크 주소를 확인하세요. 예: 10.0.0.0/24", "key-rate": "분당 요청 수의 허용 범위를 확인하세요.", "key-response": "응답당 바이트 제한의 허용 범위를 확인하세요.", "key-budget": "분당 바이트 제한의 허용 범위를 확인하세요.", "key-total-requests": "총 요청 수는 1~1,000,000,000건의 정수여야 합니다. 제한하지 않으려면 비워 두세요.", "key-total-bytes": "총 응답 사용량은 128바이트~1TB 사이의 정수 바이트여야 합니다. 제한하지 않으려면 비워 두세요.", "forward-statuses": "전달할 수 있는 원본 오류 상태만 선택하세요.", "rotation-mode": "기존 키 처리 방법을 다시 선택하세요." };
    const invalid = new Set();
    for (const field of error.fields || []) {
      const parts = String(field.field || "").split(".");
      const key = [...parts].reverse().find((part) => mapping[part]);
      if (key) { const id = mapping[key]; invalid.add(id); fieldError(id, t(messages[id])); }
    }
    notice("create-error", invalid.size ? t("표시된 입력 항목을 확인해 주세요.") : t("서버가 정책을 승인하지 않았습니다. 입력한 경로, IP 주소와 제한 값을 확인해 주세요."));
    const first = Object.keys(formFields).find((id) => invalid.has(id));
    if (first) {
      showCreateStep(formFields[first], false);
      const target = first === "key-routes" ? routeRows()[0]?.querySelector(".route-path") : first === "forward-statuses" ? document.querySelector("#forward-statuses input") : $(first);
      target?.focus();
      if (target && !["key-routes", "forward-statuses"].includes(first)) target.reportValidity?.();
    }
  }
  function fillForm(document_, { keepName = false } = {}) {
    const policy = document_.policy || {};
    if (!keepName && typeof document_.name === "string") $("key-name").value = document_.name.slice(0, 80);
    if (Number.isFinite(document_.ttl_hours)) $("key-ttl").value = String(document_.ttl_hours);
    setRoutes(list(policy.routes).map((route) => ({ method: route.method, path: route.path, query_keys: list(route.query_keys) })));
    if (Number.isFinite(policy.requests_per_minute)) $("key-rate").value = String(policy.requests_per_minute);
    if (Number.isFinite(policy.response_bytes_limit)) setByteField("key-response", policy.response_bytes_limit);
    if (Number.isFinite(policy.bytes_per_minute)) setByteField("key-budget", policy.bytes_per_minute);
    $("key-total-requests").value = Number.isFinite(policy.max_total_requests) ? String(policy.max_total_requests) : "";
    setByteField("key-total-bytes", Number.isFinite(policy.max_total_bytes) ? policy.max_total_bytes : null);
    $("key-ips").value = list(policy.ip_allowlist).join(", ");
    const statuses = new Set(list(policy.forward_error_statuses).map(Number));
    document.querySelectorAll("#forward-statuses input").forEach((input) => { input.checked = statuses.has(Number(input.value)); });
  }
  function resetCreateForm() {
    $("create-form")?.reset();
    setRoutes([{ method: "GET", path: "/customers", query_keys: ["limit"] }, { method: "GET", path: "/customers/*", query_keys: ["limit"] }]);
    for (const id of Object.keys(formFields)) fieldError(id);
    for (const id of ["create-error", "import-error", "test-error"]) notice(id, "");
    $("test-results")?.replaceChildren();
    if ($("import-details")) $("import-details").open = false;
  }
  function openCreate(trigger = document.activeElement, source = null) {
    if (!connected() || state.pending.has("create")) return;
    resetCreateForm();
    state.createSource = source ? source.id : null;
    const rotating = source && credentialStatus(source) === "active";
    text("create-eyebrow", source ? (rotating ? t("키 교체") : t("같은 정책으로 발급")) : t("새 릴레이 키"));
    if (source) {
      const documentValue = policyDocument(source);
      fillForm(documentValue, { keepName: true });
      $("key-name").value = t("{name} (교체)", { name: source.name }).slice(0, 80);
      notice("create-source", rotating ? t("{name} 키의 정책을 불러왔어요. 2단계에서 기존 키를 언제 끝낼지 정할 수 있어요.", { name: source.name }) : t("{name} 키의 정책을 불러왔어요. 새 키로 발급됩니다.", { name: source.name }));
    } else notice("create-source", "");
    hide("rotation-fields", !rotating);
    if ($("rotation-mode")) $("rotation-mode").value = "1";
    showCreateStep(1, false);
    openDialog("create-dialog", "key-name", trigger);
  }
  function importPolicy(raw) {
    notice("import-error", "");
    let parsed;
    try { parsed = JSON.parse(raw); } catch { notice("import-error", t("JSON 형식을 읽지 못했습니다. 괄호와 따옴표를 확인하세요.")); return false; }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) { notice("import-error", t("JSON 객체를 붙여 넣으세요.")); return false; }
    const documentValue = Object.hasOwn(parsed, "policy") ? parsed : { policy: parsed };
    const allowedTop = ["name", "ttl_hours", "policy"];
    const allowedPolicy = ["routes", "ip_allowlist", "requests_per_minute", "response_bytes_limit", "bytes_per_minute", "max_total_requests", "max_total_bytes", "forward_error_statuses"];
    const unknown = [...Object.keys(documentValue).filter((key) => !allowedTop.includes(key)), ...Object.keys(documentValue.policy || {}).filter((key) => !allowedPolicy.includes(key))];
    if (unknown.length) { notice("import-error", t("지원하지 않는 항목이 있습니다: {fields}", { fields: unknown.slice(0, 5).join(", ") })); return false; }
    const routes = documentValue.policy?.routes;
    if (!Array.isArray(routes) || !routes.length || routes.some((route) => !route || typeof route.path !== "string" || typeof route.method !== "string" || (route.query_keys !== undefined && !Array.isArray(route.query_keys)))) {
      notice("import-error", t("policy.routes에 method와 path가 있는 경로를 하나 이상 넣어 주세요.")); return false;
    }
    fillForm(documentValue);
    for (const id of Object.keys(formFields)) fieldError(id);
    updateCreatePreview();
    if ($("import-details")) $("import-details").open = false;
    toast(t("JSON 정책을 양식에 적용했습니다. 발급 전에 내용을 확인하세요."));
    routeRows()[0]?.querySelector(".route-path")?.focus();
    return true;
  }
  function parseTestRequests() {
    const lines = ($("test-requests")?.value || "").split("\n").map((line) => line.trim()).filter(Boolean);
    if (!lines.length) return { error: t("시험할 요청을 한 줄에 하나씩 입력하세요. 예: GET /customers/123?limit=2") };
    if (lines.length > 10) return { error: t("한 번에 최대 10개 요청까지 시험할 수 있어요.") };
    const ip = ($("test-ip")?.value || "").trim();
    const cases = [];
    for (const line of lines) {
      const match = line.match(/^([A-Za-z]+)\s+(\S+)$/);
      if (!match) return { error: t("'{line}' 형식을 확인하세요. 예: GET /customers/123", { line: line.slice(0, 60) }) };
      cases.push({ method: match[1].toUpperCase(), path: match[2], ...(ip ? { peer_ip: ip } : {}) });
    }
    return { cases };
  }
  async function runPolicyTest() {
    if (!connected()) return;
    notice("test-error", "");
    const { cases, error } = parseTestRequests();
    if (error) { notice("test-error", error); focus("test-requests"); return; }
    const { body, errors } = collectCreate();
    if (Object.keys(errors).length) { validateCreate([1, 2]); notice("test-error", t("정책 입력 오류를 먼저 고쳐 주세요.")); return; }
    const operation = begin("policyTest");
    if (!operation) return;
    $("test-results")?.replaceChildren();
    try {
      const result = await api("/api/policy/check", { method: "POST", body: { policy: body.policy, cases } });
      if (!active(operation)) return;
      $("test-results")?.replaceChildren(...list(result.results).map((item) => {
        const row = node("li", `test-result test-${item.decision}`);
        const top = node("div", "test-result-top");
        top.append(badge(item.decision === "allow" ? t("허용") : t("차단"), item.decision === "allow" ? "allow" : "deny"), node("code", "", `${item.method} ${item.path}`));
        row.append(top, node("span", "field-help", item.decision === "allow"
          ? t("적용 규칙: {rule}", { rule: `${item.matched_route?.method} ${item.matched_route?.path}` }) + (item.ip_checked ? "" : t(" · IP는 확인하지 않음"))
          : reasonLabel(item.code)));
        return row;
      }));
    } catch (failure) {
      if (active(operation) && !cancelled(failure)) notice("test-error", failure.kind === "validation" ? t("시험 요청 또는 IP 주소 형식을 확인하세요.") : failure.message);
    } finally { finish(operation); }
  }

  /* ---------- Language change ---------- */
  function rerender() {
    buildFormatters();
    translateStatic();
    renderPreferences();
    setView();
    renderControls();
    if (connected() && state.overview) renderOverview(state.overview);
    if (state.audit) renderAudit(state.audit.data, state.audit.sequence, state.audit.checkedAt);
    renderCredentials();
    renderEvents();
    if (state.scenarios) renderScenarios(state.scenarios);
    if (state.detailId && $("detail-dialog")?.open) populateDetail();
    if ($("create-dialog")?.open) { showCreateStep(state.createStep, false); routeRows().forEach((row) => { row.querySelector(".route-query").placeholder = t("예: limit, page"); row.querySelector(".route-remove").setAttribute("aria-label", t("이 경로 삭제")); }); }
  }
  function renderScenarios(result) {
    state.scenarios = result;
    const scenarios = list(result.scenarios);
    $("scenario-list")?.replaceChildren();
    for (const scenario of scenarios) {
      const item = node("article", "scenario-item");
      const top = node("div", "scenario-top");
      top.append(node("strong", "", t(scenario.name)), badge(scenario.passed ? t("통과") : t("실패"), scenario.passed ? "allow" : "error"));
      item.append(top, node("p", "scenario-detail", t("기대 HTTP {expected} · 실제 HTTP {actual}", { expected: scenario.expected_status, actual: scenario.actual_status })), node("p", "scenario-reason", reasonLabel(scenario.reason)));
      $("scenario-list")?.append(item);
    }
    const passed = scenarios.filter((scenario) => scenario.passed).length;
    text("demo-result-badge", t("{passed} / {total}개 통과", { passed: count(passed), total: count(scenarios.length) }));
    if ($("demo-result-badge")) $("demo-result-badge").className = `badge badge-${result.passed ? "allow" : "error"}`;
  }

  /* ---------- Event wiring ---------- */
  for (const id of ["connect-button", "gate-connect-button"]) on(id, "click", () => { notice("connect-error", ""); $("admin-token").value = ""; openDialog("connect-dialog", "admin-token"); });
  on("connect-form", "submit", async (event) => {
    event.preventDefault();
    if (state.pending.has("connect")) return;
    const token = $("admin-token").value.trim();
    if (!token) { notice("connect-error", t("관리자 토큰을 입력하세요.")); focus("admin-token"); return; }
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
      toast(t("워크스페이스에 연결했습니다."));
      await Promise.all([loadCredentials(), loadEvents()]);
    } catch (error) {
      if (!active(operation) || cancelled(error)) return;
      resetSession({ keepConnect: true });
      notice("connect-error", error.message);
      focus("admin-token");
    } finally { finish(operation); }
  });
  on("disconnect-button", "click", () => { resetSession(); toast(t("연결을 해제하고 관리자 토큰을 지웠습니다.")); focus("gate-connect-button"); });
  for (const id of ["refresh-button", "retry-button"]) on(id, "click", refresh);
  on("credentials-retry", "click", loadCredentials);
  on("events-retry", "click", () => loadEvents());
  for (const id of ["create-key-button", "overview-create-button", "empty-create-button"]) on(id, "click", (event) => openCreate(event.currentTarget));
  on("credential-search", "input", (event) => { state.credentialSearch = event.target.value.trim(); renderCredentials(); });
  on("credential-status", "change", (event) => { state.credentialStatus = event.target.value; renderCredentials(); });
  on("clear-key-filters", "click", () => { state.credentialSearch = ""; state.credentialStatus = "active"; $("credential-search").value = ""; $("credential-status").value = "active"; renderCredentials(); focus("credential-search"); });
  on("show-all-keys", "click", () => { state.credentialStatus = "all"; $("credential-status").value = "all"; renderCredentials(); focus("credential-status"); });
  on("detail-revoke-button", "click", (event) => openRevoke(state.detailId, event.currentTarget));
  on("detail-activity-button", "click", () => {
    const id = state.detailId;
    if (!id) return;
    requestClose("detail-dialog", true);
    state.eventCredential = id;
    renderEventKeyOptions();
    if (location.hash !== "#activity") location.hash = "activity"; else setView(true);
    loadEvents();
  });
  on("detail-export-button", "click", () => {
    const credential = credentialById(state.detailId);
    if (!credential) return;
    download(`relayguard-policy-${credential.prefix}.json`, JSON.stringify(policyDocument(credential), null, 2) + "\n", "application/json");
    toast(t("정책 JSON을 내보냈습니다. relayguard policy check로 검사하거나 다시 가져올 수 있어요."));
  });
  on("detail-reissue-button", "click", (event) => {
    const credential = credentialById(state.detailId);
    if (!credential) return;
    requestClose("detail-dialog", true);
    openCreate(event.currentTarget, credential);
  });
  on("create-next-button", "click", () => { if (validateCreate([1])) showCreateStep(2); });
  on("create-back-button", "click", () => { if (!state.pending.has("create")) showCreateStep(1); });
  on("add-route-button", "click", () => { addRouteRow(undefined, true); updateCreatePreview(); });
  document.querySelectorAll(".chip[data-ttl]").forEach((chip) => chip.addEventListener("click", () => { $("key-ttl").value = chip.dataset.ttl; fieldError("key-ttl"); updateCreatePreview(); }));
  for (const id of Object.keys(formFields)) if (!["key-routes", "forward-statuses"].includes(id)) on(id, "input", () => { fieldError(id); notice("create-error", ""); updateCreatePreview(); });
  for (const id of ["key-response-unit", "key-budget-unit", "key-total-bytes-unit"]) on(id, "change", () => { fieldError(id.replace(/-unit$/, "")); updateCreatePreview(); });
  on("forward-statuses", "change", () => { fieldError("forward-statuses"); updateCreatePreview(); });
  on("import-apply", "click", () => importPolicy($("import-json").value));
  on("import-file", "change", async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > 65536) { notice("import-error", t("64KB 이하의 JSON 파일을 선택하세요.")); return; }
    try { const raw = await file.text(); $("import-json").value = raw; importPolicy(raw); }
    catch { notice("import-error", t("파일을 읽지 못했습니다.")); }
  });
  on("test-button", "click", runPolicyTest);
  on("create-form", "submit", async (event) => {
    event.preventDefault();
    if (!connected() || state.pending.has("create")) return;
    if (state.createStep === 1) { if (validateCreate([1])) showCreateStep(2); return; }
    const body = validateCreate();
    if (!body) return;
    const source = credentialById(state.createSource);
    const mode = $("rotation-mode")?.value;
    const rotate = source && credentialStatus(source) === "active" && mode !== "keep";
    const operation = begin("create");
    notice("create-error", "");
    try {
      const result = await api(rotate ? `/api/credentials/${encodeURIComponent(source.id)}/rotate` : "/api/credentials",
        { method: "POST", body: rotate ? { credential: body, grace_hours: Number(mode) } : body });
      if (!active(operation)) return;
      requestClose("create-dialog", true);
      wipeSecret();
      $("new-key").value = result.token;
      result.token = "";
      if (rotate) notice("key-replaced-note", Number(mode) === 0 ? t("기존 키 {name}: 즉시 폐기했어요.", { name: source.name }) : t("기존 키 {name}: {hours}시간 뒤 만료돼요. 그 전에 연동을 새 키로 바꾸세요.", { name: source.name, hours: mode }));
      state.createSource = null;
      openDialog("key-dialog", "new-key", $("create-key-button"));
      renderControls();
      await syncResources();
    } catch (error) {
      if (!active(operation) || cancelled(error)) return;
      finish(operation);
      if (error.kind === "validation") showServerValidation(error);
      else notice("create-error", error.uncertain ? t("발급 결과를 확인하지 못했습니다. 키가 생성되었을 수 있으니 다시 발급하기 전에 키 목록을 확인해 주세요. 원문을 받지 못한 키는 폐기 후 새로 발급하세요.") : error.message);
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
      if (active(operation) && version === state.secretVersion && $("key-dialog").open) text("copy-feedback", t("키를 복사했습니다. 안전한 비밀 저장소에 보관한 뒤 아래 항목을 확인하세요."));
    } catch {
      if (active(operation) && version === state.secretVersion && $("key-dialog").open) {
        text("copy-feedback", t("자동 복사를 사용할 수 없습니다. 선택된 키를 키보드의 복사 명령으로 복사하세요."));
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
      toast(t("릴레이 키를 폐기했습니다."));
      await syncResources();
      if (active(operation)) {
        if (location.hash !== "#credentials") history.pushState(null, "", "#credentials");
        setView();
        focus("credentials-title");
      }
    } catch (error) {
      if (!active(operation) || cancelled(error)) return;
      finish(operation);
      notice("revoke-error", error.uncertain ? t("폐기 결과를 확인하지 못했습니다. 다시 시도하거나 창을 닫고 목록에서 키 상태를 확인하세요.") : error.message);
      if (error.uncertain) await loadCredentials();
    } finally { finish(operation); }
  });
  document.querySelectorAll(".filter-button").forEach((button) => button.addEventListener("click", () => { if (connected()) loadEvents(button.dataset.decision); }));
  on("event-kind", "change", (event) => { state.eventKind = event.target.value; loadEvents(); });
  on("event-key", "change", (event) => { state.eventCredential = event.target.value; loadEvents(); });
  on("event-period", "change", (event) => { state.eventPeriod = event.target.value; loadEvents(); });
  on("event-search", "input", (event) => { state.eventSearch = event.target.value.trim(); renderEvents(); });
  on("clear-event-filters", "click", () => {
    state.eventSearch = ""; state.eventKind = ""; state.eventCredential = ""; state.eventPeriod = "";
    for (const id of ["event-search", "event-kind", "event-period"]) $(id).value = "";
    renderEventKeyOptions();
    loadEvents("");
    focus("event-search");
  });
  on("events-more-button", "click", loadMoreEvents);
  on("event-export-button", "click", () => { if (state.events.length) exportEventsCsv(); });
  on("event-auto-refresh", "change", (event) => {
    if (state.autoRefresh) clearInterval(state.autoRefresh);
    state.autoRefresh = event.target.checked ? setInterval(autoRefreshTick, 10000) : null;
    toast(event.target.checked ? t("활동 기록을 10초마다 새로고침합니다.") : t("자동 새로고침을 껐습니다."));
  });
  on("verify-button", "click", async () => {
    const operation = begin("verify");
    if (!operation || !connected()) { finish(operation); return; }
    notice("audit-error", "");
    state.auditSequence = operation.id;
    try {
      const result = await api("/api/audit/verify");
      if (active(operation) && operation.id === state.auditSequence) {
        renderAudit(result, operation.id);
        toast(result.valid ? t("감사 로그의 무결성을 확인했습니다.") : t("감사 로그 검증에 실패했습니다. 기록을 확인해 주세요."));
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
      download(`relayguard-audit-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(result, null, 2), "application/json");
      toast(t("감사 로그 다운로드를 시작했습니다."));
    } catch (error) { if (active(operation) && !cancelled(error)) notice("audit-error", error.message); }
    finally { finish(operation); }
  });
  on("copy-hash-button", "click", async () => {
    if (!state.headHash || !connected()) return;
    const operation = begin("copyHash");
    if (!operation) return;
    try { await navigator.clipboard.writeText(state.headHash); if (active(operation)) toast(t("현재 해시를 복사했습니다.")); }
    catch { if (active(operation)) notice("audit-error", t("자동 복사를 사용할 수 없습니다. 표시된 해시를 직접 선택해 복사하세요.")); }
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
      renderScenarios(result);
      if ($("scenario-details")) $("scenario-details").open = !result.passed;
      hide("demo-results", false);
      toast(result.passed ? t("모든 검증 시나리오를 통과했습니다.") : t("실패한 시나리오가 있습니다. 결과를 확인해 주세요."));
      await syncResources();
    } catch (error) { if (active(operation) && !cancelled(error)) globalError(error.uncertain ? t("데모 실행 결과를 확인하지 못했습니다. 요청 기록을 확인한 뒤 다시 실행해 주세요.") : error.message); }
    finally { finish(operation); }
  });
  on("toast-close", "click", () => { clearTimeout(toastTimer); hide("toast", true); });
  on("language-button", "click", () => { lang = lang === "ko" ? "en" : "ko"; writePreference("relayguard.lang", lang); rerender(); });
  on("theme-button", "click", () => { theme = themes[(themes.indexOf(theme) + 1) % themes.length]; writePreference("relayguard.theme", theme); renderPreferences(); });

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
      if (dialog.id === "create-dialog") state.createSource = null;
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

  /* ---------- Start ---------- */
  captureButtonLabels();
  resetCreateForm();
  translateStatic();
  renderPreferences();
  renderControls();
  setView();
  const healthController = new AbortController();
  const healthTimeout = setTimeout(() => healthController.abort(), 12000);
  fetch("/healthz", { credentials: "omit", cache: "no-store", redirect: "error", signal: healthController.signal })
    .then((response) => { if (!response.ok) throw new Error("Unavailable"); return response.json(); })
    .then((data) => { if (connected()) return; state.demoMode = data.demo_mode === true; hide("demo-banner", !state.demoMode); text("environment-label", state.demoMode ? t("로컬 데모") : t("운영 환경")); renderControls(); })
    .catch(() => { if (!connected()) { text("environment-label", t("서버 확인 필요")); globalError(t("서버 상태를 확인하지 못했습니다. 서버가 실행 중인지 확인한 뒤 연결해 주세요.")); } })
    .finally(() => clearTimeout(healthTimeout));
})();
