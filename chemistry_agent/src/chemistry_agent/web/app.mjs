import { TOOL_LABELS, buildTurns, contextBadge, createMarkdownRenderer, escapeHtml, metricValue } from "./core.mjs";

const $ = (id) => document.getElementById(id);
const icon = (name, className = "") => `<svg class="icon ${className}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const markdown = globalThis.markdownit ? createMarkdownRenderer(globalThis.markdownit) : {
  render: (text) => `<p>${escapeHtml(text).replace(/\n/g, "<br>")}</p>`,
};
const state = {
  sessions: [], sessionId: null, turns: [], runs: [], pending: null, health: null,
  busy: false, loading: false, hasMore: false, navigation: 0, results: new Map(),
  auth: { enabled: false, user: null }, accountVersion: 0,
};
let toastTimer;

class ApiError extends Error {
  constructor(message, data, status) { super(message); this.data = data; this.status = status; }
}

async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(path, { ...options, headers: { "Content-Type": "application/json", ...options.headers } });
  } catch {
    throw new ApiError("暂时无法连接本地服务，请检查服务是否正在运行。", null, 0);
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const message = data?.error?.message || data?.result?.message ||
      (response.status === 422 ? "输入格式有误，请检查后再试。" : "请求未能完成，请稍后重试。");
    if (response.status === 401 && data?.error?.code === "authentication_required") {
      showLogin("登录已过期，请重新登录。");
    }
    throw new ApiError(message, data, response.status);
  }
  return data;
}

function toast(message) {
  clearTimeout(toastTimer);
  $("toast").textContent = message;
  $("toast").hidden = false;
  toastTimer = setTimeout(() => { $("toast").hidden = true; }, 4200);
}

function rememberSession(id) {
  const storageKey = state.auth.user ? `chemistry.session.${state.auth.user.id}` : "chemistry.session";
  try {
    if (id) localStorage.setItem(storageKey, id);
    else localStorage.removeItem(storageKey);
  } catch { /* Storage can be unavailable in a private browser. */ }
  const url = new URL(location.href);
  if (id) url.searchParams.set("session", id);
  else url.searchParams.delete("session");
  history.replaceState(null, "", url);
}

function syncDrawerAccessibility() {
  const loginRequired = !$("login-screen").hidden;
  const sidebarHidden = loginRequired || (innerWidth <= 760 && !document.body.classList.contains("sidebar-open"));
  const inspectorHidden = loginRequired || (innerWidth <= 1120 && !document.body.classList.contains("inspector-open"));
  document.querySelector(".main-panel").inert = loginRequired;
  document.querySelector(".main-panel").setAttribute("aria-hidden", String(loginRequired));
  $("sidebar").inert = sidebarHidden;
  $("inspector").inert = inspectorHidden;
  $("sidebar").setAttribute("aria-hidden", String(sidebarHidden));
  $("inspector").setAttribute("aria-hidden", String(inspectorHidden));
}

function setDrawer(name, open) {
  const panel = $(name === "sidebar" ? "sidebar" : "inspector");
  const trigger = $(name === "sidebar" ? "menu-toggle" : "tools-toggle");
  const wasFocused = panel.contains(document.activeElement);
  document.body.classList.toggle(`${name}-open`, open);
  const anyOpen = document.body.classList.contains("sidebar-open") || document.body.classList.contains("inspector-open");
  $("screen-overlay").hidden = !anyOpen;
  $("menu-toggle").setAttribute("aria-expanded", String(document.body.classList.contains("sidebar-open")));
  $("tools-toggle").setAttribute("aria-expanded", String(document.body.classList.contains("inspector-open")));
  syncDrawerAccessibility();
  if (open) panel.querySelector("button, input, summary")?.focus();
  else if (wasFocused && trigger.getClientRects().length) trigger.focus();
}

function closeDrawers() { setDrawer("sidebar", false); setDrawer("inspector", false); }

function updateControls() {
  const locked = state.busy || state.loading;
  $("message-input").disabled = locked;
  $("reference-input").disabled = locked;
  $("send-button").disabled = locked || !state.health?.model_configured;
  $("send-button").setAttribute("aria-label", state.busy ? "正在生成回答" : "发送消息");
  $("new-chat").disabled = locked;
  $("logout-button").disabled = locked;
  $("reference-toggle").disabled = locked;
  $("remove-reference").disabled = locked;
  document.querySelectorAll(".session-button,.suggestion-card").forEach((button) => { button.disabled = locked; });
  $("chat-form").setAttribute("aria-busy", String(state.busy));
}

async function refreshHealth() {
  try {
    state.health = await api("/health");
    const names = { "deepseek-flash": "DeepSeek Flash", "deepseek-v4-pro": "DeepSeek Pro" };
    $("model-label").textContent = state.health.model_configured
      ? `${names[state.health.model] || state.health.model} · 已连接` : "模型未配置";
    $("model-status").classList.toggle("unavailable", !state.health.model_configured);
    $("connection-notice").hidden = state.health.model_configured;
    $("connection-notice").textContent = "模型尚未配置，请设置本地 API Key 并重启服务。分子工具仍可使用。";
  } catch {
    state.health = null;
    $("model-label").textContent = "服务未连接";
    $("model-status").classList.add("unavailable");
    $("connection-notice").hidden = false;
    $("connection-notice").textContent = "暂时无法连接本地服务，恢复连接后将自动更新。";
  }
  updateControls();
}

function renderSessions() {
  $("session-list").innerHTML = state.sessions.length ? state.sessions.map((session) =>
    `<button class="session-button${session.id === state.sessionId ? " active" : ""}" data-session="${escapeHtml(session.id)}" aria-current="${session.id === state.sessionId ? "page" : "false"}" title="${escapeHtml(session.title)}">${icon("chat")}<span>${escapeHtml(session.title)}</span></button>`
  ).join("") : '<p class="sidebar-empty">你的研究，从第一段对话开始。</p>';
  $("load-more").hidden = !state.hasMore;
  updateControls();
}

async function refreshSessions(append = false) {
  const accountVersion = state.accountVersion;
  const offset = append ? state.sessions.length : 0;
  const sessions = await api(`/sessions?limit=50&offset=${offset}`);
  if (accountVersion !== state.accountVersion) return;
  state.sessions = append ? [...state.sessions, ...sessions] : sessions;
  state.hasMore = sessions.length === 50;
  renderSessions();
}

function renderUser(text, context) {
  return `<div class="user-message"><div class="user-bubble">${escapeHtml(text)}${context ?
    `<details class="attached-reference"><summary>${icon("document")} 已附参考文献片段 · ${context.length.toLocaleString()} 字符</summary><pre>${escapeHtml(context)}</pre></details>` : ""}</div></div>`;
}

function renderToolTrace(calls, turnIndex) {
  if (!calls.length) return "";
  const success = calls.filter((call) => call.success).length;
  return `<details class="tool-trace"><summary>${icon(success === calls.length ? "check" : "flask")}<span>已使用 ${calls.length} 次研究工具${success < calls.length ? ` · ${calls.length - success} 次需调整输入` : ""}</span>${icon("chevron", "disclosure")}</summary><div class="tool-trace-content">${calls.map((call, index) => {
    const id = `${turnIndex}-${index}`;
    state.results.set(id, call);
    return `<div class="tool-trace-item"><strong>${escapeHtml(TOOL_LABELS[call.name] || call.name)}</strong><button type="button" class="view-result" data-result="${id}">查看结果</button><pre>${escapeHtml(JSON.stringify({ arguments: call.arguments, result: call.result }, null, 2))}</pre></div>`;
  }).join("")}</div></details>`;
}

function renderContextBadge(context) {
  const badge = contextBadge(context);
  return badge ? `<span class="context-badge" title="${escapeHtml(badge.description)}" aria-label="${escapeHtml(badge.description)}">${escapeHtml(badge.label)}</span>` : "";
}

function renderConversation(scroll = true) {
  state.results.clear();
  const hasConversation = state.turns.length > 0 || state.pending !== null;
  $("welcome").hidden = hasConversation || state.loading;
  $("conversation").hidden = !hasConversation && !state.loading;
  if (state.loading) {
    $("conversation").innerHTML = '<div class="thinking-indicator">正在打开这段研究对话…</div>';
    return;
  }
  $("conversation").innerHTML = state.turns.map((turn, index) =>
    `<article class="turn">${renderUser(turn.text, turn.context)}<div class="assistant-message"><span class="assistant-avatar">${icon("molecule")}</span><div class="assistant-body"><div class="assistant-label">Chemistry Agent <span>研究助手</span></div>${renderToolTrace(turn.calls, index)}<div class="markdown">${markdown.render(turn.answer)}</div><div class="message-footer"><button class="icon-button" data-copy="${index}" title="复制回答" aria-label="复制回答">${icon("copy")}</button><span>${turn.run ? `${turn.run.usage.total_tokens.toLocaleString()} tokens · ` : ""}对话已保存</span>${renderContextBadge(turn.run?.context)}</div></div></div></article>`
  ).join("");
  if (state.pending) {
    const pending = state.pending;
    const article = document.createElement("article");
    article.className = "turn";
    article.innerHTML = `${renderUser(pending.message, pending.context)}<div class="assistant-message"><span class="assistant-avatar">${icon("molecule")}</span><div class="assistant-body"><div class="assistant-label">Chemistry Agent <span>研究助手</span></div>${pending.error ? `<div class="message-error">${escapeHtml(pending.error)}<br><button class="retry-button" id="retry-message">${icon("refresh")}重试这条消息</button></div>` : '<div class="thinking-indicator"><span></span><span></span><span></span>正在分析问题…</div>'}</div></div>`;
    $("conversation").append(article);
  }
  if (scroll) requestAnimationFrame(() => {
    $("chat-scroll").scrollTo({ top: $("chat-scroll").scrollHeight, behavior: "smooth" });
  });
  updateControls();
}

async function selectSession(id, quiet = false) {
  if (state.busy) return;
  const navigation = ++state.navigation;
  state.loading = true;
  state.pending = null;
  renderConversation(false);
  closeDrawers();
  try {
    // Message history is authoritative. All tool details can be reconstructed from it.
    const session = await api(`/sessions/${encodeURIComponent(id)}`);
    const runs = await api(`/sessions/${encodeURIComponent(id)}/runs?limit=100`).catch(() => []);
    if (navigation !== state.navigation) return;
    state.sessionId = id;
    state.runs = runs;
    state.turns = buildTurns(session.messages, runs);
    $("conversation-title").textContent = session.title;
    rememberSession(id);
    const lastCall = state.turns.flatMap((turn) => turn.calls).at(-1);
    renderResult(lastCall || null);
  } catch (error) {
    if (navigation !== state.navigation) return;
    if (!quiet) toast(error.message);
    state.sessionId = null;
    state.turns = [];
    state.runs = [];
    rememberSession(null);
    $("conversation-title").textContent = "化学助手";
  } finally {
    if (navigation === state.navigation) {
      state.loading = false;
      renderConversation();
      renderSessions();
    }
  }
}

function newConversation() {
  if (state.busy || state.loading) return;
  state.navigation += 1;
  state.sessionId = null;
  state.turns = [];
  state.runs = [];
  state.pending = null;
  rememberSession(null);
  $("conversation-title").textContent = "化学助手";
  $("message-input").value = "";
  $("reference-input").value = "";
  setReferenceOpen(false);
  renderConversation(false);
  renderSessions();
  renderResult(null);
  closeDrawers();
  $("message-input").focus();
}

function setReferenceOpen(open) {
  $("reference-editor").hidden = !open;
  $("reference-toggle").setAttribute("aria-expanded", String(open));
  const length = $("reference-input").value.length;
  $("reference-count").textContent = length.toLocaleString();
  $("reference-count").hidden = length === 0;
}

async function sendChat(message, context) {
  if (state.busy || state.loading || !message.trim()) return;
  if (!state.health?.model_configured) { toast("请先连接并配置模型。"); return; }
  state.busy = true;
  const accountVersion = state.accountVersion;
  state.pending = { message: message.trim(), context: context.trim() };
  renderConversation();
  try {
    if (!state.sessionId) {
      const session = await api("/sessions", { method: "POST", body: JSON.stringify({ title: message.trim().slice(0, 80) }) });
      if (accountVersion !== state.accountVersion) return;
      state.sessionId = session.id;
      $("conversation-title").textContent = session.title;
      rememberSession(session.id);
    }
    const result = await api("/chat", { method: "POST", body: JSON.stringify({
      session_id: state.sessionId, message: message.trim(), context: context.trim() || null,
    }) });
    if (accountVersion !== state.accountVersion) return;
    state.turns.push({ text: message.trim(), context: context.trim(), answer: result.answer,
      calls: result.tool_calls, run: { usage: result.usage, context: result.context } });
    state.pending = null;
    $("message-input").value = "";
    $("message-input").style.height = "";
    $("reference-input").value = "";
    setReferenceOpen(false);
    if (result.tool_calls.length) renderResult(result.tool_calls.at(-1));
    await refreshSessions().catch(() => {});
  } catch (error) {
    if (accountVersion !== state.accountVersion) return;
    state.pending = { message: message.trim(), context: context.trim(), error: error.message };
    $("message-input").value = message;
    $("reference-input").value = context;
    if (context) setReferenceOpen(true);
    await refreshSessions().catch(() => {});
  } finally {
    if (accountVersion === state.accountVersion) {
      state.busy = false;
      renderConversation();
      $("message-input").focus();
    }
  }
}

function metric(label, value, unit = "") {
  return `<div class="metric"><small>${escapeHtml(label)}</small><strong>${escapeHtml(metricValue(value))}${unit ? `<span>${escapeHtml(unit)}</span>` : ""}</strong></div>`;
}

const emptyResult = $("result-panel").innerHTML;
function renderResult(call) {
  if (!call) {
    $("result-panel").innerHTML = emptyResult;
    $("result-badge").textContent = "等待计算";
    return;
  }
  if (!call.success) {
    $("result-panel").innerHTML = `<div class="tool-failure">${escapeHtml(call.result?.message || "计算未完成，请检查输入的分子结构。")}</div>`;
    $("result-badge").textContent = "请检查输入";
    return;
  }
  const result = call.result;
  $("result-badge").textContent = "已计算";
  let body;
  if (call.name === "molecular_properties") {
    body = `<div class="calculation-title"><strong>${escapeHtml(result.formula)}</strong><span>分子属性</span></div><div class="canonical-smiles">${escapeHtml(result.canonical_smiles)}</div><div class="metric-grid">${metric("分子量", result.molecular_weight_g_mol, "g/mol")}${metric("Crippen LogP", result.logp_rdkit_crippen)}${metric("TPSA", result.tpsa_angstrom_squared, "Å²")}${metric("精确质量", result.exact_mass_da, "Da")}${metric("氢键供体", result.hydrogen_bond_donors)}${metric("氢键受体", result.hydrogen_bond_acceptors)}${metric("可旋转键", result.rotatable_bonds)}${metric("环数量", result.ring_count)}</div>`;
  } else if (call.name === "molecular_similarity") {
    const score = Number(result.tanimoto_similarity);
    const percent = Number.isFinite(score) ? Math.max(0, Math.min(100, score * 100)) : 0;
    body = `<div class="calculation-title"><strong>结构相似度</strong><span>TANIMOTO</span></div><div class="canonical-smiles">${escapeHtml(result.canonical_smiles_a)} ↔ ${escapeHtml(result.canonical_smiles_b)}</div><div class="similarity-score"><strong>${escapeHtml(metricValue(score, 6))}</strong><div class="score-track"><span style="width:${percent}%"></span></div><small>0 无指纹重叠 · 1 指纹相同</small></div><div class="result-source">Morgan 指纹 · radius=2 · 2048 bits<br>结构相似度不代表生物活性。</div>`;
  } else {
    body = `<div class="calculation-title"><strong>${escapeHtml(call.name)}</strong></div>`;
  }
  $("result-panel").innerHTML = `<div class="calculation-card">${body}<div class="result-source">${escapeHtml(result.source || "")}</div><details class="raw-result"><summary>查看参数与完整结果</summary><pre>${escapeHtml(JSON.stringify({ arguments: call.arguments, result }, null, 2))}</pre></details></div>`;
}

async function runLocalTool(name, form) {
  const accountVersion = state.accountVersion;
  const button = form.querySelector("button[type=submit]");
  if (button.disabled) return;
  const arguments_ = Object.fromEntries([...new FormData(form)].map(([key, value]) => [key, value.trim()]));
  if (Object.values(arguments_).some((value) => !value)) { toast("请输入有效的 SMILES。"); return; }
  const buttonContent = button.innerHTML;
  button.disabled = true;
  button.textContent = "正在计算…";
  try {
    const call = await api(`/tools/${name}/invoke`, { method: "POST", body: JSON.stringify({ arguments: arguments_ }) });
    if (accountVersion !== state.accountVersion) return;
    renderResult(call);
    toast("计算完成，结果已显示在研究面板。");
  } catch (error) {
    if (accountVersion !== state.accountVersion) return;
    renderResult({ success: false, result: { message: error.message } });
    toast(error.message);
  } finally {
    button.innerHTML = buttonContent;
    button.disabled = false;
  }
}

$("chat-form").addEventListener("submit", (event) => {
  event.preventDefault();
  sendChat($("message-input").value, $("reference-input").value);
});
$("message-input").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
    event.preventDefault();
    $("chat-form").requestSubmit();
  }
});
$("message-input").addEventListener("input", () => {
  $("message-input").style.height = "auto";
  $("message-input").style.height = `${Math.min($("message-input").scrollHeight, 180)}px`;
});
$("new-chat").addEventListener("click", newConversation);
$("reference-toggle").addEventListener("click", () => {
  setReferenceOpen($("reference-editor").hidden);
  if (!$("reference-editor").hidden) $("reference-input").focus();
});
$("remove-reference").addEventListener("click", () => { $("reference-input").value = ""; setReferenceOpen(false); });
$("reference-input").addEventListener("input", () => setReferenceOpen(true));
$("reference-suggestion").addEventListener("click", () => {
  $("message-input").value = "请分析这段文献的研究方法、关键发现和结论局限，并区分原文证据与推断。";
  setReferenceOpen(true);
  $("reference-input").focus();
});
document.querySelectorAll("[data-prompt]").forEach((button) => button.addEventListener("click", () => {
  $("message-input").value = button.dataset.prompt;
  $("message-input").focus();
}));
$("session-list").addEventListener("click", (event) => {
  const button = event.target.closest("[data-session]");
  if (button) selectSession(button.dataset.session);
});
$("refresh-sessions").addEventListener("click", () => refreshSessions().catch((error) => toast(error.message)));
$("load-more").addEventListener("click", async () => {
  $("load-more").disabled = true;
  try { await refreshSessions(true); } catch (error) { toast(error.message); }
  finally { $("load-more").disabled = false; }
});
$("conversation").addEventListener("click", async (event) => {
  const resultButton = event.target.closest("[data-result]");
  if (resultButton) {
    renderResult(state.results.get(resultButton.dataset.result));
    if (innerWidth <= 1120) setDrawer("inspector", true);
  }
  const copyButton = event.target.closest("[data-copy]");
  if (copyButton) {
    try { await navigator.clipboard.writeText(state.turns[Number(copyButton.dataset.copy)].answer); toast("回答已复制。"); }
    catch { toast("复制不可用，请选中文字后手动复制。"); }
  }
  if (event.target.closest("#retry-message") && state.pending && !state.busy) {
    sendChat(state.pending.message, state.pending.context);
  }
});
$("properties-form").addEventListener("submit", (event) => { event.preventDefault(); runLocalTool("molecular_properties", event.currentTarget); });
$("similarity-form").addEventListener("submit", (event) => { event.preventDefault(); runLocalTool("molecular_similarity", event.currentTarget); });
$("menu-toggle").addEventListener("click", () => { setDrawer("inspector", false); setDrawer("sidebar", !document.body.classList.contains("sidebar-open")); });
$("tools-toggle").addEventListener("click", () => { setDrawer("sidebar", false); setDrawer("inspector", !document.body.classList.contains("inspector-open")); });
$("inspector-close").addEventListener("click", () => setDrawer("inspector", false));
$("screen-overlay").addEventListener("click", closeDrawers);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeDrawers();
  if (event.key !== "Tab") return;
  const openPanel = document.body.classList.contains("sidebar-open") ? $("sidebar") :
    document.body.classList.contains("inspector-open") ? $("inspector") : null;
  if (!openPanel) return;
  const focusable = [...openPanel.querySelectorAll("a, button:not(:disabled), input, textarea, summary")]
    .filter((element) => element.getClientRects().length && !element.disabled);
  const first = focusable[0], last = focusable.at(-1);
  if (event.shiftKey && (document.activeElement === first || !openPanel.contains(document.activeElement))) {
    event.preventDefault(); last?.focus();
  } else if (!event.shiftKey && (document.activeElement === last || !openPanel.contains(document.activeElement))) {
    event.preventDefault(); first?.focus();
  }
});
window.addEventListener("resize", () => {
  if (innerWidth > 1120) closeDrawers();
  syncDrawerAccessibility();
});

function showLogin(message = "") {
  state.accountVersion += 1;
  state.navigation += 1;
  rememberSession(null);
  state.sessionId = null;
  state.sessions = [];
  state.turns = [];
  state.runs = [];
  state.pending = null;
  state.results.clear();
  state.auth.user = null;
  state.busy = false;
  state.loading = false;
  $("conversation").replaceChildren();
  $("session-list").replaceChildren();
  $("conversation-title").textContent = "化学助手";
  $("message-input").value = "";
  $("reference-input").value = "";
  $("properties-form").reset();
  $("similarity-form").reset();
  setReferenceOpen(false);
  renderResult(null);
  closeDrawers();
  $("login-screen").hidden = false;
  document.body.classList.remove("auth-checking");
  $("login-error").textContent = message;
  $("login-error").hidden = !message;
  $("login-password").value = "";
  syncDrawerAccessibility();
  $("login-username").focus();
}

async function startWorkspace() {
  $("login-screen").hidden = true;
  document.body.classList.remove("auth-checking");
  $("workspace-name").textContent = state.auth.user?.username || "本地研究空间";
  $("workspace-note").textContent = state.auth.enabled ? "个人研究空间" : "会话自动保存在本机";
  $("logout-button").hidden = !state.auth.enabled;
  syncDrawerAccessibility();
  await Promise.all([refreshHealth(), refreshSessions().catch((error) => {
    $("session-list").innerHTML = '<p class="sidebar-empty">暂时无法读取会话，请点击刷新。</p>';
    toast(error.message);
  })]);
  let id = new URL(location.href).searchParams.get("session");
  const storageKey = state.auth.user ? `chemistry.session.${state.auth.user.id}` : "chemistry.session";
  try { id ||= localStorage.getItem(storageKey); } catch { /* Optional persistence. */ }
  if (id) await selectSession(id, true);
  else updateControls();
}

async function initialize() {
  try {
    state.auth = await api("/auth/status");
    if (state.auth.enabled && !state.auth.user) showLogin();
    else await startWorkspace();
  } catch {
    showLogin("暂时无法连接服务，请稍后刷新页面重试。");
  }
}

$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("login-submit").disabled = true;
  $("login-error").hidden = true;
  try {
    const result = await api("/auth/login", { method: "POST", body: JSON.stringify({
      username: $("login-username").value, password: $("login-password").value,
    }) });
    state.auth = { enabled: true, user: result.user };
    $("login-password").value = "";
    await startWorkspace();
  } catch (error) {
    $("login-error").textContent = error.message;
    $("login-error").hidden = false;
  } finally {
    $("login-submit").disabled = false;
  }
});
$("logout-button").addEventListener("click", async () => {
  try {
    await api("/auth/logout", { method: "POST" });
    showLogin();
  } catch (error) { toast(error.message); }
});

initialize();
setInterval(() => { if ($("login-screen").hidden) refreshHealth(); }, 30000);
