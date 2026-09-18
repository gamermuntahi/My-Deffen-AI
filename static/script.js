/* ============================================================================
 * DEFFEN AI — FRONTEND AI CONFIGURATION
 * ----------------------------------------------------------------------------
 * NO API KEY IS STORED IN THIS FILE.
 *
 * The backend (app.py) owns the AI configuration: it reads the OpenRouter key
 * from the server environment / an untracked .env file and hands the resolved
 * settings to this script in one of two ways:
 *
 *   1. A Jinja block rendered into /chat:
 *        <script id="deffen-config" type="application/json"> { ... } </script>
 *   2. The internal, no-cache JSON endpoint:  GET /api/config
 *
 * The script prefers (1) and only falls back to (2) when the block is absent,
 * so the same frontend keeps working when it is served without the template.
 * Both provide the same keys:
 *
 *   endpoint, fallbacks, api_key, model, timeout_ms, system_prompt,
 *   referer, title, max_history_messages, configured
 *
 * The actual AI request is then made DIRECTLY from the browser to OpenRouter:
 *
 *     Browser  ──>  OpenRouter API  ──>  AI response  ──>  Browser
 * ==========================================================================*/

// Safe defaults — used only until the server-provided configuration arrives.
const CONFIG_DEFAULTS = {
  endpoint: "https://openrouter.ai/api/v1/chat/completions",
  fallbacks: [],
  api_key: "",
  model: "",
  timeout_ms: 120000,
  system_prompt: "",
  referer: "",
  title: "Deffen AI",
  max_history_messages: 31,
  configured: false,
};

// The internal backend endpoint that mirrors the Jinja block.
const CONFIG_ENDPOINT = "/api/config";

// Live configuration — replaced with the server values during init().
let AI_CONFIG = Object.assign({}, CONFIG_DEFAULTS);

// Read the Jinja-rendered <script id="deffen-config"> JSON block, if present.
function readInlineConfig() {
  const node = document.getElementById("deffen-config");
  if (!node) return null;
  try {
    const parsed = JSON.parse(node.textContent || "{}");
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (e) {
    return null;
  }
}

// Coerce a server payload into a fully-populated, safely-typed config object.
function normalizeConfig(raw) {
  const cfg = Object.assign({}, CONFIG_DEFAULTS);
  if (!raw || typeof raw !== "object") return cfg;

  const str = (v) => (v == null ? "" : String(v));
  const num = (v, fallback) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };

  // Strip a stray "Bearer " prefix the same way the backend does.
  const key = str(raw.api_key).trim().replace(/^\s*bearer\s+/i, "").trim();
  if (key) cfg.api_key = key;

  const endpoint = str(raw.endpoint).trim();
  if (endpoint) cfg.endpoint = endpoint;

  const model = str(raw.model).trim();
  if (model) cfg.model = model;

  const prompt = str(raw.system_prompt).trim();
  if (prompt) cfg.system_prompt = prompt;

  const referer = str(raw.referer).trim();
  if (referer) cfg.referer = referer;

  const title = str(raw.title).trim();
  if (title) cfg.title = title;

  if (Array.isArray(raw.fallbacks)) {
    cfg.fallbacks = raw.fallbacks
      .map((u) => str(u).trim())
      .filter(Boolean);
  }

  cfg.timeout_ms = num(raw.timeout_ms, cfg.timeout_ms);
  cfg.max_history_messages = num(
    raw.max_history_messages,
    cfg.max_history_messages
  );
  cfg.configured = !!raw.configured;
  return cfg;
}

// Resolve the configuration: the Jinja block first, then the internal API.
async function loadConfig() {
  const inline = readInlineConfig();
  if (inline) return normalizeConfig(inline);

  try {
    const res = await fetch(CONFIG_ENDPOINT, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (res.ok) return normalizeConfig(await res.json());
  } catch (e) {
    // Ignore — a clear "not configured" error is shown when sending a message.
  }
  return Object.assign({}, CONFIG_DEFAULTS);
}

const history = [];
let busy = false;

const STORAGE_KEY = "deffen.sessions.v1";
const SIDEBAR_KEY = "deffen.sidebar.v1";
let sessions = [];
let activeSessionId = null;
let searchQuery = "";

const app = document.getElementById("app");
const sidebarClose = document.getElementById("sidebarClose");
const newChatSidebarBtn = document.getElementById("newChatSidebarBtn");
const chatSearch = document.getElementById("chatSearch");
const chatList = document.getElementById("chatList");
const chatSectionLabel = document.getElementById("chatSectionLabel");
const settingsSidebarBtn = document.getElementById("settingsSidebarBtn");
const sidebarOverlay = document.getElementById("sidebarOverlay");
const sidebar = document.getElementById("sidebar");
const sidebarCollapseBtn = document.getElementById("sidebarCollapseBtn");
const sidebarSearchToggle = document.getElementById("sidebarSearchToggle");
const navNewChat = document.getElementById("navNewChat");
const navSearch = document.getElementById("navSearch");
const navSettings = document.getElementById("navSettings");

// Sidebar UI state (presentation only — does not touch chat/API logic).
let sidebarSearchOpen = true;

// Collapse the sidebar into an icon-only rail and remember the choice.
function setSidebarCollapsed(collapsed, opts) {
  if (!sidebar) return;
  sidebar.classList.toggle("collapsed", !!collapsed);
  sidebarCollapseBtn?.setAttribute("aria-expanded", String(!collapsed));
  if (collapsed) setSidebarSearch(false);
  if (!opts || opts.persist !== false) {
    try {
      localStorage.setItem(SIDEBAR_KEY, collapsed ? "1" : "0");
    } catch (e) {}
  }
}

function toggleSidebarCollapse() {
  if (!sidebar) return;
  setSidebarCollapsed(!sidebar.classList.contains("collapsed"));
}

// Show/hide the in-sidebar search field (visual only).
function setSidebarSearch(open, focus) {
  sidebarSearchOpen = !!open;
  sidebar?.classList.toggle("search-hidden", !sidebarSearchOpen);
  sidebarSearchToggle?.setAttribute("aria-expanded", String(sidebarSearchOpen));
  if (sidebarSearchOpen && focus) chatSearch?.focus();
}

function toggleSidebarSearch() {
  // Searching from the icon rail first expands the panel.
  if (sidebar?.classList.contains("collapsed")) setSidebarCollapsed(false);
  setSidebarSearch(!sidebarSearchOpen, true);
}
const menuBtn = document.getElementById("menuBtn");
const topbarChat = document.getElementById("topbarChat");
const settingsBtn = document.getElementById("settingsBtn");
const settingsModal = document.getElementById("settingsModal");
const settingsCloseBtn = document.getElementById("settingsCloseBtn");
const settingSessionCount = document.getElementById("settingSessionCount");
const clearSessionsBtn = document.getElementById("clearSessionsBtn");

const chatArea = document.getElementById("chatArea");
const messageList = document.getElementById("messageList");
const emptyState = document.getElementById("emptyState");
const input = document.getElementById("userInput");
const sendBtn = document.getElementById("sendBtn");
const newChatBtn = document.getElementById("newChatBtn");
const scrollBottomBtn = document.getElementById("scrollBottomBtn");
const suggestions = document.getElementById("suggestions");
const brand = document.getElementById("brand");
const loadingScreen = document.getElementById("loadingScreen");

// UI-only element references (theme controls)
const themeToggleBtn = document.getElementById("themeToggleBtn");
const themePicker = document.getElementById("themePicker");

const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
};

const hideEmptyState = () => emptyState?.remove();

// Bot avatar. Uses the app-relative public asset path (identical file to the
// Flask-served one) so it keeps working when the frontend is hosted directly
// on Vercel without the Flask static route.
const BOT_LOGO =
  '<img class="msg-logo" src="static/media/img/fav/favicon.png" alt="" width="18" height="18" />';

// Keep the boot/loading screen visible for at least this long (ms).
const LOADING_MIN_MS = 3000;
const loadingShownAt = Date.now();

// Fade out and remove the boot/loading screen once the app is ready,
// but never before LOADING_MIN_MS has elapsed.
function hideLoadingScreen() {
  if (!loadingScreen) return;
  const remaining = LOADING_MIN_MS - (Date.now() - loadingShownAt);
  setTimeout(() => {
    loadingScreen.classList.add("done");
    setTimeout(() => loadingScreen.setAttribute("hidden", ""), 500);
  }, Math.max(0, remaining));
}

// ---------- Theme switching (UI only) ----------
const THEME_KEY = "deffen.theme.v1";
const rootEl = document.documentElement;

const resolveSystemTheme = () =>
  window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches
    ? "light"
    : "dark";

function applyTheme(pref, opts) {
  const animate = !!(opts && opts.animate);
  const resolved = pref === "system" ? resolveSystemTheme() : pref;
  rootEl.setAttribute("data-theme", pref);
  rootEl.setAttribute("data-ui-theme", resolved);
  try {
    localStorage.setItem(THEME_KEY, pref);
  } catch (e) {}
  if (themePicker) {
    themePicker.querySelectorAll(".theme-option").forEach((opt) => {
      opt.classList.toggle("active", opt.dataset.themeOption === pref);
    });
  }
  if (animate) {
    rootEl.classList.add("theme-switching");
    clearTimeout(applyTheme._t);
    applyTheme._t = setTimeout(() => rootEl.classList.remove("theme-switching"), 380);
  }
}

function toggleTheme() {
  const cur = rootEl.getAttribute("data-ui-theme") === "light" ? "light" : "dark";
  applyTheme(cur === "light" ? "dark" : "light", { animate: true });
}

// ---------- Mobile keyboard / visible viewport handling (UI only) ----------
function setupViewport() {
  const vv = window.visualViewport;
  if (!vv) return;
  const sync = () => {
    const h = vv.height;
    if (h > 0) {
      rootEl.classList.add("vv");
      rootEl.style.setProperty("--app-height", Math.round(h) + "px");
    }
  };
  sync();
  vv.addEventListener("resize", sync);
  vv.addEventListener("scroll", sync);
}

async function init() {
  // Resolve the AI configuration (API key, model, ...) from the backend before
  // wiring the UI, so the very first message already has everything it needs.
  AI_CONFIG = await loadConfig();

  input.addEventListener("input", onInput);
  input.addEventListener("keydown", onKeydown);
  sendBtn.addEventListener("click", onSend);
  newChatBtn.addEventListener("click", onNewChat);
  chatArea.addEventListener("scroll", onChatScroll, { passive: true });
  scrollBottomBtn.addEventListener("click", () => scrollToBottom(true));
  brand?.addEventListener("click", onNewChat);
  suggestions?.addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (chip) {
      input.value = chip.dataset.prompt || chip.textContent;
      sendMessage();
    }
  });

  newChatSidebarBtn?.addEventListener("click", onNewChat);
  menuBtn?.addEventListener("click", openSidebar);
  sidebarClose?.addEventListener("click", closeSidebar);
  sidebarOverlay?.addEventListener("click", closeSidebar);
  chatSearch?.addEventListener("input", onSearchInput);

  // Sidebar redesign controls (UI only). Each reuses an existing action.
  sidebarCollapseBtn?.addEventListener("click", toggleSidebarCollapse);
  sidebarSearchToggle?.addEventListener("click", toggleSidebarSearch);
  navNewChat?.addEventListener("click", onNewChat);
  navSearch?.addEventListener("click", toggleSidebarSearch);
  navSettings?.addEventListener("click", openSettings);

  settingsBtn?.addEventListener("click", openSettings);
  settingsSidebarBtn?.addEventListener("click", openSettings);
  settingsCloseBtn?.addEventListener("click", closeSettings);
  settingsModal?.addEventListener("click", (e) => {
    if (e.target === settingsModal) closeSettings();
  });
  clearSessionsBtn?.addEventListener("click", clearAllSessions);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeSidebar();
      closeSettings();
    }
  });

  autoGrow();
  updateSendState();
  loadSessions();
  renderChatList();
  updateTopbar();
  updateSettings();
  input.focus();


  // UI-only additions: theme controls + visible viewport handling
  if (themePicker && rootEl.hasAttribute("data-theme")) {
    applyTheme(rootEl.getAttribute("data-theme"));
  }
  themeToggleBtn?.addEventListener("click", toggleTheme);
  themePicker?.addEventListener("click", (e) => {
    const opt = e.target.closest(".theme-option");
    if (opt && opt.dataset.themeOption) {
      applyTheme(opt.dataset.themeOption, { animate: true });
    }
  });
  const mq = window.matchMedia && window.matchMedia("(prefers-color-scheme: light)");
  const onSystemThemeChange = () => {
    if (rootEl.getAttribute("data-theme") === "system") applyTheme("system", { animate: true });
  };
  if (mq) {
    if (mq.addEventListener) mq.addEventListener("change", onSystemThemeChange);
    else if (mq.addListener) mq.addListener(onSystemThemeChange);
  }
  setupViewport();

  // Restore the saved sidebar rail state and reset the search field to shown.
  try {
    if (localStorage.getItem(SIDEBAR_KEY) === "1") {
      setSidebarCollapsed(true, { persist: false });
    }
  } catch (e) {}
  setSidebarSearch(true, false);

  // Dismiss the boot/loading screen once the app is fully wired up.
  if (document.readyState === "complete") hideLoadingScreen();
  else window.addEventListener("load", hideLoadingScreen, { once: true });
}

function onNewChat() {
  if (busy) return;
  history.length = 0;
  activeSessionId = null;
  messageList.innerHTML = "";
  hideEmptyState();
  const ghost = el("div");
  ghost.appendChild(emptyState);
  messageList.appendChild(ghost);
  chatArea.scrollTop = 0;
  input.value = "";
  autoGrow();
  updateSendState();
  scrollBottomBtn.hidden = true;
  if (chatSearch) chatSearch.value = "";
  searchQuery = "";
  renderChatList();
  updateTopbar();
  closeSidebar();
  input.focus();
}


function openSidebar() {
  app?.classList.add("sidebar-open");
  if (sidebarOverlay) sidebarOverlay.hidden = false;
  // The mobile drawer always shows the full panel (never the icon rail).
  setSidebarSearch(true, false);
}

function closeSidebar() {
  app?.classList.remove("sidebar-open");
  if (sidebarOverlay) sidebarOverlay.hidden = true;
}

function persistSessions() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
  } catch (e) {
  }
}

function loadSessions() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (Array.isArray(parsed)) {
      sessions = parsed
        .map((s) => ({
          id: String(s.id || ""),
          title: String(s.title || "New chat"),
          time: Number(s.time) || 0,
          messages: Array.isArray(s.messages) ? s.messages : [],
        }))
        .filter((s) => s.id)
        .slice(0, 50);
    }
  } catch (e) {
    sessions = [];
  }
}

function saveActiveSession() {
  if (!history.length) return;
  const now = Date.now();
  if (activeSessionId) {
    const existing = sessions.find((s) => s.id === activeSessionId);
    if (existing) {
      existing.messages = history.slice();
      existing.time = now;
      if (!existing.title) existing.title = makeTitle();
      persistSessions();
      renderChatList();
      return;
    }
  }
  const session = {
    id: "s" + now + Math.random().toString(36).slice(2, 7),
    title: makeTitle(),
    time: now,
    messages: history.slice(),
  };
  sessions.unshift(session);
  activeSessionId = session.id;
  persistSessions();
  renderChatList();
}

function makeTitle() {
  const first = history.find((m) => m.role === "user");
  if (!first) return "New chat";
  const t = String(first.content || "").trim().replace(/\s+/g, " ");
  return t.length > 42 ? t.slice(0, 42).trimEnd() + "…" : t || "New chat";
}

function relativeTime(ts) {
  if (!ts) return "";
  const diff = Date.now() - ts;
  const min = Math.round(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return min + "m ago";
  const hr = Math.round(min / 60);
  if (hr < 24) return hr + "h ago";
  const d = Math.round(hr / 24);
  if (d < 7) return d + "d ago";
  return new Date(ts).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function renderChatList() {
  if (!chatList) return;
  chatList.innerHTML = "";

  const q = searchQuery.trim().toLowerCase();
  const visible = sessions.filter(
    (s) => !q || s.title.toLowerCase().includes(q)
  );

  if (chatSectionLabel) {
    chatSectionLabel.textContent = q ? `Recents · ${visible.length}` : "Recents";
  }

  if (!visible.length) {
    const empty = el(
      "p",
      "chat-list-empty",
      q ? "No conversations match your search." : "No conversations yet. Start a new chat below."
    );
    chatList.appendChild(empty);
    return;
  }

  for (const s of visible) {
    const item = el("div", "session-item");
    if (s.id === activeSessionId) item.classList.add("active");

    const open = el("button", "session-open");
    open.type = "button";
    open.title = s.title;
    open.addEventListener("click", () => openChat(s.id));

    const icon = el("span", "session-icon");
    icon.innerHTML =
      '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M12 8v4l2.5 1.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';

    const meta = el("span", "session-meta");
    meta.append(el("span", "session-title", s.title));
    meta.append(el("span", "session-time", relativeTime(s.time)));

    open.append(icon, meta);

    const del = el("button", "session-delete");
    del.type = "button";
    del.title = "Delete conversation";
    del.setAttribute("aria-label", "Delete conversation");
    del.innerHTML =
      '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteSession(s.id);
    });

    item.append(open, del);
    chatList.appendChild(item);
  }
}

function onSearchInput() {
  searchQuery = chatSearch ? chatSearch.value : "";
  renderChatList();
}

function openChat(id) {
  if (busy) return;
  const s = sessions.find((x) => x.id === id);
  if (!s) return;
  activeSessionId = id;
  history.length = 0;
  for (const m of s.messages) history.push({ role: m.role, content: m.content });
  hideEmptyState();
  messageList.innerHTML = "";
  for (const m of history) {
    if (m.role === "assistant") {
      const { bubble } = addMessage("bot", "");
      bubble.appendChild(renderMarkdown(m.content));
    } else {
      addMessage(
        "user",
        inlineLinks(boldAndItalic(inlineCode(escapeInline(m.content)))).replace(/\n/g, "<br>")
      );
    }
  }
  input.value = "";
  autoGrow();
  updateSendState();
  scrollBottomBtn.hidden = true;
  chatArea.scrollTop = 0;
  renderChatList();
  updateTopbar();
  closeSidebar();
  input.focus();
}

function deleteSession(id) {
  sessions = sessions.filter((s) => s.id !== id);
  if (activeSessionId === id) {
    activeSessionId = null;
    history.length = 0;
    messageList.innerHTML = "";
    hideEmptyState();
    const ghost = el("div");
    ghost.appendChild(emptyState);
    messageList.appendChild(ghost);
    chatArea.scrollTop = 0;
    input.value = "";
    autoGrow();
    updateSendState();
    scrollBottomBtn.hidden = true;
    updateTopbar();
  }
  persistSessions();
  renderChatList();
}

function clearAllSessions() {
  sessions = [];
  activeSessionId = null;
  history.length = 0;
  messageList.innerHTML = "";
  hideEmptyState();
  const ghost = el("div");
  ghost.appendChild(emptyState);
  messageList.appendChild(ghost);
  chatArea.scrollTop = 0;
  input.value = "";
  autoGrow();
  updateSendState();
  scrollBottomBtn.hidden = true;
  persistSessions();
  renderChatList();
  updateTopbar();
  updateSettings();
}

function updateTopbar() {
  if (!topbarChat) return;
  const s = sessions.find((x) => x.id === activeSessionId);
  topbarChat.textContent = activeSessionId && s ? s.title : "New chat";
  topbarChat.title = topbarChat.textContent;
}

function openSettings() {
  updateSettings();
  if (settingsModal) settingsModal.hidden = false;
}

function closeSettings() {
  if (settingsModal) settingsModal.hidden = true;
}

function updateSettings() {
  if (settingSessionCount) {
    const n = sessions.length;
    settingSessionCount.textContent =
      n === 1 ? "1 conversation stored in this browser" : n + " conversations stored in this browser";
  }
}

function autoGrow() {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 180) + "px";
}

function onInput() {
  autoGrow();
  updateSendState();
}

function onKeydown(e) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    if (!busy) onSend();
  }
}

function updateSendState() {
  sendBtn.disabled = busy || !input.value.trim();
}

function addMessage(role, html, extraClass = "") {
  hideEmptyState();

  const row = el("div", `msg ${role} ${extraClass}`.trim());
  const avatar = el("div", "msg-avatar");
  avatar.innerHTML =
    role === "user"
      ? '<svg viewBox="0 0 24 24" width="15" height="15"><circle cx="12" cy="8" r="3.4" fill="currentColor"/><path d="M4.5 20c1.1-3.6 4.1-5.4 7.5-5.4S18.4 16.4 19.5 20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>'
      : BOT_LOGO;

  const body = el("div", "msg-body");
  const label = el("div", "msg-label", role === "user" ? "You" : "Deffen AI");
  const bubble = el("div", "bubble");
  bubble.innerHTML = html;

  body.append(label, bubble);
  row.append(avatar, body);
  messageList.appendChild(row);

  scrollToBottom(true);
  return { row, bubble };
}

let stickToBottom = true;

function onChatScroll() {
  const dist = chatArea.scrollHeight - chatArea.scrollTop - chatArea.clientHeight;
  stickToBottom = dist < 90;
  scrollBottomBtn.hidden = stickToBottom;
}

function scrollToBottom(force = false) {
  if (force || stickToBottom) {
    chatArea.scrollTop = chatArea.scrollHeight;
    stickToBottom = true;
    scrollBottomBtn.hidden = true;
  }
}

function showTyping() {
  const row = el("div", "msg bot typing-row");
  const avatar = el("div", "msg-avatar");
  avatar.innerHTML = BOT_LOGO;

  const body = el("div", "msg-body");
  const label = el("div", "msg-label", "Deffen AI");
  const bubble = el("div", "bubble");
  const dots = el("span", "typing");
  for (let i = 0; i < 3; i++) dots.appendChild(el("i"));

  bubble.appendChild(dots);
  body.append(label, bubble);
  row.append(avatar, body);
  messageList.appendChild(row);
  scrollToBottom(true);
  return row;
}

function removeTyping(row) {
  row?.remove();
}

function showError(title, detail) {
  const detailEl =
    detail == null
      ? ""
      : `<span class="error-detail">${escapeHtml(String(detail))}</span>`;
  addMessage("error", `<strong>${escapeHtml(title)}</strong>${detailEl}`, "error");
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&": return "\u0026amp;";
      case "<": return "\u0026lt;";
      case ">": return "\u0026gt;";
      case '"': return "\u0026quot;";
      case "'": return "\u0026#39;";
      default: return c;
    }
  });
}

function escapeInline(text) {
  return String(text).replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&": return "\u0026amp;";
      case "<": return "\u0026lt;";
      case ">": return "\u0026gt;";
      case '"': return "\u0026quot;";
      case "'": return "\u0026#39;";
      default: return c;
    }
  });
}

function inlineCode(str) {
  return str.replace(/`([^`\n]+)`/g, (_, code) => `<code>${escapeInline(code)}</code>`);
}

function inlineLinks(str) {
  return str.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_, label, url) => `<a href="${escapeInline(url)}" target="_blank" rel="noopener noreferrer">${inlineCode(label)}</a>`
  );
}

function boldAndItalic(str) {
  return str
    .replace(/\*\*\*([^*]+)\*\*\*/g, "<strong><em>$1</em></strong>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
}

function makeCodeBlock(lang, code) {
  const wrapper = el("div", "codeblock");
  const bar = el("div", "codebar");
  const langLabel = el("span", "codebar-lang", (lang || "code").toUpperCase());

  const actions = el("div", "codebar-actions");
  const copy = el("button", "copy-btn", "Copy");
  copy.type = "button";
  copy.innerHTML =
    '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M6 15H5.5A2.5 2.5 0 0 1 3 12.5v-7A2.5 2.5 0 0 1 5.5 3h7A2.5 2.5 0 0 1 15 5.5V6" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>';
  copy.append(document.createTextNode(" Copy"));

  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = code;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    copy.classList.add("copied");
    copy.lastChild.textContent = " Copied!";
    setTimeout(() => {
      copy.classList.remove("copied");
      copy.lastChild.textContent = " Copy";
    }, 1800);
  });

  actions.appendChild(copy);
  bar.append(langLabel, actions);

  const pre = el("pre");
  pre.appendChild(el("code", "", code));

  wrapper.append(bar, pre);
  return wrapper;
}

function renderMarkdown(md) {
  const container = document.createElement("div");
  container.className = "md";

  const parts = [];
  let cursor = 0;
  const fence = /```([\w+-]*)\n?([\s\S]*?)(?:```|$)/g;
  let match;
  while ((match = fence.exec(md))) {
    if (match.index > cursor) parts.push({ type: "text", text: md.slice(cursor, match.index) });
    parts.push({ type: "code", lang: match[1] || "", code: match[2].replace(/\n$/, "") });
    cursor = match.index + match[0].length;
  }
  if (cursor < md.length) parts.push({ type: "text", text: md.slice(cursor) });

  for (const part of parts) {
    if (part.type === "code") {
      container.appendChild(makeCodeBlock(part.lang, part.code));
      continue;
    }

    const text = part.text
      .replace(/\r\n/g, "\n")
      .split(/\n{2,}/)
      .map((block) => block.trim())
      .filter(Boolean);

    for (const rawBlock of text) {
      const lines = rawBlock.split("\n");
      const first = lines[0];

      const heading = first.match(/^(#{1,4})\s+(.+)/);
      if (heading) {
        const h = el(`h${heading[1].length}`);
        h.innerHTML = inlineLinks(boldAndItalic(inlineCode(heading[2])));
        container.appendChild(h);
        continue;
      }

      if (/^([-*_])\s*\1\s*\1/.test(first)) {
        container.appendChild(el("hr"));
        continue;
      }

      const listItems = lines.filter((l) => /^\s*[-*+]\s+/.test(l));
      if (listItems.length === lines.length && listItems.length > 0) {
        const ul = el("ul");
        for (const line of listItems) {
          const li = el("li");
          li.innerHTML = inlineLinks(boldAndItalic(inlineCode(line.replace(/^\s*[-*+]\s+/, ""))));
          ul.appendChild(li);
        }
        container.appendChild(ul);
        continue;
      }

      const olItems = lines.filter((l) => /^\s*\d+[.)]\s+/.test(l));
      if (olItems.length === lines.length && olItems.length > 0) {
        const ol = el("ol");
        for (const line of olItems) {
          const li = el("li");
          li.innerHTML = inlineLinks(boldAndItalic(inlineCode(line.replace(/^\s*\d+[.)]\s+/, ""))));
          ol.appendChild(li);
        }
        container.appendChild(ol);
        continue;
      }

      const quote = first.match(/^>\s?(.+)/);
      if (quote && lines.length === 1) {
        const bq = el("blockquote");
        bq.innerHTML = inlineLinks(boldAndItalic(inlineCode(quote[1])));
        container.appendChild(bq);
        continue;
      }

      const p = el("p");
      p.innerHTML = lines
        .map((l) => inlineLinks(boldAndItalic(inlineCode(l))))
        .join("<br>");
      container.appendChild(p);
    }
  }

  return container;
}

function onSend() {
  const text = input.value.trim();
  if (!text || busy) return;
  sendMessage(text);
}

async function sendMessage(textOverride) {
  if (busy) return;

  const text = (textOverride ?? input.value).trim();
  if (!text) return;

  hideEmptyState();

  addMessage(
    "user",
    inlineLinks(boldAndItalic(inlineCode(escapeInline(text)))).replace(/\n/g, "<br>")
  );

  history.push({ role: "user", content: text });

  saveActiveSession();
  updateTopbar();

  input.value = "";
  autoGrow();

  const typingRow = showTyping();
  busy = true;
  updateSendState();
  input.focus();

  await new Promise((r) => setTimeout(r, 350));

  let replyStarted = false;

  try {
    const reply = await requestReply(buildMessages());
    const trimmed = String(reply ?? "").trim();

    if (!trimmed) {
      throw new Error("The AI returned an empty response.");
    }

    removeTyping(typingRow);
    const { bubble } = addMessage("bot", "");
    replyStarted = true;
    await streamInto(bubble, trimmed);

    history.push({ role: "assistant", content: trimmed });

    saveActiveSession();
    updateTopbar();
  } catch (err) {
    removeTyping(typingRow);
    if (!replyStarted) {
      const { title, detail } = classifyError(err);
      showError(title, detail);
    }
    console.error("[Deffen AI]", err);
  } finally {
    busy = false;
    updateSendState();
    input.focus();
  }
}


// Collect the visible conversation (the existing `history` array, restored
// from localStorage sessions) and prepend the server-provided system prompt.
// The system prompt is always kept; only the recent messages are capped.
function buildMessages() {
  const msgs = [];
  const systemPrompt = String(AI_CONFIG.system_prompt || "").trim();
  if (systemPrompt) msgs.push({ role: "system", content: systemPrompt });

  for (const m of history) {
    const content = String(m.content ?? "").trim();
    if (!content) continue;
    msgs.push({ role: m.role === "assistant" ? "assistant" : "user", content });
  }

  const maxHistory = Number(AI_CONFIG.max_history_messages);
  if (maxHistory > 0 && msgs.length > maxHistory) {
    const hasSystem = msgs[0]?.role === "system";
    const head = hasSystem ? [msgs[0]] : [];
    const budget = hasSystem ? maxHistory - 1 : maxHistory;
    return head.concat(msgs.slice(-Math.max(0, budget)));
  }
  return msgs;
}

// The HTTP-Referer sent to OpenRouter must be a real http(s) URL. When the app
// runs from a file:// page we fall back to the production site.
function httpReferrer() {
  if (typeof location !== "undefined" && /^https?:/i.test(location.protocol)) {
    return location.href;
  }
  return "https://deffen.ai/";
}

// Prefer the referer configured by the backend; otherwise use the page URL.
function configReferer() {
  const configured = String(AI_CONFIG.referer || "").trim();
  if (/^https?:\/\//i.test(configured)) return configured;
  return httpReferrer();
}

// True for browser-level fetch failures (CORS, DNS, offline, connection reset)
// rather than a structured HTTP response from OpenRouter.
function isNetworkError(err) {
  if (!err) return false;
  const name = String(err.name || "");
  const msg = String(err.message || "");
  return (
    name === "TypeError" ||
    /failed to fetch|load failed|networkerror|network error|econn|offline|internet/i.test(msg)
  );
}

// Read a single reply text out of an OpenRouter-compatible response.
function extractContent(data) {
  if (!data || typeof data !== "object") return null;
  const choices = data.choices;
  if (Array.isArray(choices) && choices.length) {
    const choice = choices[0];
    if (choice && typeof choice === "object") {
      const message = choice.message;
      if (message && typeof message.content === "string") return message.content;
      const delta = choice.delta;
      if (delta && typeof delta.content === "string") return delta.content;
      if (typeof choice.text === "string") return choice.text;
    }
  }
  if (typeof data.content === "string") return data.content;
  return null;
}

// Perform ONE request against an OpenRouter-compatible endpoint and return the
// assistant's reply text. Throws on HTTP errors, empty bodies or bad payloads.
async function fetchOnce(url, messages) {
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + String(AI_CONFIG.api_key || "").trim(),
        "HTTP-Referer": configReferer(),
        "X-Title": AI_CONFIG.title || "Deffen AI",
      },
      body: JSON.stringify({
        model: AI_CONFIG.model,
        messages,
      }),
      signal: AbortSignal.timeout(AI_CONFIG.timeout_ms || 120000),
    });
  } catch (err) {
    if (err && err.name === "TimeoutError") {
      throw new Error(
        "The request timed out. The model may be busy — please try again."
      );
    }
    throw err;
  }

  if (!res.ok) {
    let detail = "";
    try {
      const j = await res.json();
      detail = (j && j.error && j.error.message) || (j && j.message) || "";
    } catch {}
    if (!detail) {
      try {
        detail = (await res.text()).slice(0, 240);
      } catch {}
    }
    const err = new Error(
      detail || "OpenRouter responded with HTTP " + res.status + "."
    );
    err.status = res.status;
    throw err;
  }

  const body = await res.text();
  if (!body) throw new Error("OpenRouter returned an empty response.");

  let data;
  try {
    data = JSON.parse(body);
  } catch {
    throw new Error("OpenRouter returned a malformed response.");
  }

  if (data && data.error) {
    const err = new Error(
      (data.error && data.error.message) || "OpenRouter returned an error."
    );
    err.status = data.error && data.error.code;
    throw err;
  }

  const content = extractContent(data);
  if (content == null) {
    throw new Error("OpenRouter returned an unexpected response.");
  }
  return String(content);
}

// Call OpenRouter DIRECTLY from the browser (Browser -> OpenRouter -> Browser).
// The endpoint list comes from the server config: the primary endpoint, its
// declared fallbacks, then the canonical OpenRouter URL. Only network/CORS/
// timeout failures trigger a retry; a real HTTP status is surfaced immediately.
async function requestReply(messages) {
  const key = String(AI_CONFIG.api_key || "").trim();

  if (!key) {
    const e = new Error(
      "No OpenRouter API key is configured on the server. Set " +
        "OPENROUTER_API_KEY in the .env file (or in the deployment's " +
        "environment variables) and restart the app."
    );
    e.isConfigError = true;
    throw e;
  }

  if (!String(AI_CONFIG.model || "").trim()) {
    const e = new Error(
      "No AI model is configured on the server. Set OPENROUTER_MODEL in the " +
        ".env file (or config.yml)."
    );
    e.isConfigError = true;
    throw e;
  }

  const primary = String(AI_CONFIG.endpoint || "").trim();
  if (!/^https?:\/\//i.test(primary)) {
    const e = new Error("The OpenRouter endpoint is not configured correctly.");
    e.isConfigError = true;
    throw e;
  }

  const endpoints = [primary];
  for (const url of AI_CONFIG.fallbacks || []) {
    if (url && !endpoints.includes(url)) endpoints.push(url);
  }
  const canonical = "https://openrouter.ai/api/v1/chat/completions";
  if (!endpoints.includes(canonical)) endpoints.push(canonical);

  let lastError = null;

  for (const url of endpoints) {
    try {
      return await fetchOnce(url, messages);
    } catch (err) {
      // A structured HTTP error (401/402/403/404/429/5xx) is final — retrying
      // another URL would only repeat it. Only retry on transport failures.
      if (!isNetworkError(err) && !(err && err.name === "TimeoutError")) {
        throw err;
      }
      lastError = err;
    }
  }

  const e = new Error(
    "Deffen AI could not reach OpenRouter. This is usually a temporary network " +
      "issue, or the browser was blocked from calling OpenRouter directly (CORS). " +
      "Please check your connection and try again."
  );
  e.isCors = true;
  e.cause = lastError;
  throw e;
}

function classifyError(err) {
  const msg = String(err?.message || err || "");
  const status = Number(err?.status) || 0;

  // The frontend config itself is incomplete / unusable.
  if (err && err.isConfigError) {
    return {
      title: "Assistant not configured",
      detail: msg,
    };
  }

  // 401 — invalid or missing key. 403 — key blocked / provider refused.
  if (
    status === 401 ||
    status === 403 ||
    /api key|apikey|invalid.*key|unauthorized|forbidden|authentication|permission/i.test(msg)
  ) {
    return {
      title: "Access denied",
      detail:
        "OpenRouter rejected the request. The API key is invalid, disabled, or " +
        "this origin is not allowed.\n\n" +
        msg,
    };
  }

  // 402 — the OpenRouter account is out of credits.
  if (status === 402 || /402|insufficient|credits|balance|billing/i.test(msg)) {
    return {
      title: "Insufficient credits",
      detail:
        "The OpenRouter account has run out of credits. Top up the account and " +
        "try again.\n\n" +
        msg,
    };
  }

  // 429 — rate limit reached.
  if (status === 429 || /429|rate limit|too many requests/i.test(msg)) {
    return {
      title: "Too many requests",
      detail:
        "OpenRouter rate limit reached. Wait a moment and try again.\n\n" + msg,
    };
  }

  // 404 — model or endpoint not found.
  if (status === 404 || /404|not found|does not exist|no model|unknown model/i.test(msg)) {
    return {
      title: "Model unavailable",
      detail:
        "OpenRouter could not find the configured model or endpoint. Check " +
        "OPENROUTER_MODEL / OPENROUTER_API_URL in the .env file or config.yml.\n\n" +
        msg,
    };
  }

  // 400 / 422 — the request body or model name was rejected as invalid.
  if (status === 400 || status === 422 || /bad request|invalid request|malformed/i.test(msg)) {
    return {
      title: "Request rejected",
      detail:
        "OpenRouter rejected the request as invalid. This usually means the " +
        "model name or request body is incorrect.\n\n" +
        msg,
    };
  }

  if (/timed out|timeout/i.test(msg)) {
    return {
      title: "Request timed out",
      detail:
        msg +
        "\n\nThe assistant may be busy or your connection is slow. " +
        "Wait a moment and try again.",
    };
  }

  if (
    (err && err.isCors) ||
    /failed to fetch|network|load failed|econn|offline|internet|could not reach|blocked by cors/i.test(msg)
  ) {
    const offline =
      typeof navigator !== "undefined" && navigator.onLine === false;
    let detail;
    if (offline) {
      detail =
        "Your device appears to be offline. Check your internet connection and try again.";
    } else {
      detail =
        "Deffen AI could not reach OpenRouter. This is usually a temporary " +
        "network issue — or the browser was blocked from calling OpenRouter " +
        "directly (CORS). Please check your connection and try again.";
    }
    detail += "\n\n" + msg;
    return { title: "Connection error", detail };
  }

  if (status >= 500) {
    return {
      title: "AI service temporarily unavailable",
      detail:
        "OpenRouter (or the model provider) is having issues right now. " +
        "Please try again shortly.\n\n" + msg,
    };
  }

  return {
    title: "Something went wrong",
    detail: msg || "Unknown error. Please try again.",
  };
}

async function streamInto(bubble, text) {
  const chunk = (start, end) => text.slice(start, end);

  const step = Math.max(140, Math.ceil(text.length / 120));
  for (let i = 0; i < text.length; i += step) {
    const rendered = renderMarkdown(chunk(0, i + step));
    bubble.innerHTML = "";
    bubble.appendChild(rendered);
    scrollToBottom();
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
  }

  const final = renderMarkdown(text);
  bubble.innerHTML = "";
  bubble.appendChild(final);
  scrollToBottom(true);
}

init();
