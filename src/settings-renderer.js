"use strict";

// ── Settings panel renderer ──
//
// Strict unidirectional flow (plan §4.2):
//
//   1. UI clicks → settingsAPI.update(key, value) → main → controller
//   2. Controller commits → broadcasts settings-changed
//   3. settingsAPI.onChanged fires → renderUI() rebuilds the affected row(s)
//
// We never optimistically toggle a switch in the click handler. The visual
// state always reflects what the store says — period. Failures show a toast
// and the switch stays in its previous position because the store was never
// committed.

// ── i18n (mirror src/i18n.js — bubbles can't require electron modules) ──
const STRINGS = {
  en: {
    settingsTitle: "Settings",
    settingsSubtitle: "Configure how Clawd behaves on your desktop.",
    sidebarGeneral: "General",
    sidebarAgents: "Agents",
    sidebarTheme: "Theme",
    sidebarAnimMap: "Animation Map",
    sidebarShortcuts: "Shortcuts",
    sidebarAbout: "About",
    sidebarSoon: "Soon",
    sectionAppearance: "Appearance",
    sectionStartup: "Startup",
    sectionBubbles: "Bubbles",
    agentsTitle: "Agents",
    agentsSubtitle: "Turn tracking on or off per agent. Disabled agents stop log monitors and drop hook events at the HTTP boundary — they won't drive the pet, show permission bubbles, or keep sessions.",
    agentsEmpty: "No agents registered.",
    eventSourceHook: "Hook",
    eventSourceLogPoll: "Log poll",
    eventSourcePlugin: "Plugin",
    badgePermissionBubble: "Permission bubble",
    rowAgentPermissions: "Show pop-up bubbles",
    rowAgentPermissionsDesc: "Turn off to let this agent handle prompts in its own terminal instead of showing a Clawd bubble.",
    rowLanguage: "Language",
    rowLanguageDesc: "Interface language for menus and bubbles.",
    rowSound: "Sound effects",
    rowSoundDesc: "Play a chime when Clawd finishes a task or asks for input.",
    rowOpenAtLogin: "Open at login",
    rowOpenAtLoginDesc: "Start Clawd automatically when you log in.",
    rowStartWithClaude: "Start with Claude Code",
    rowStartWithClaudeDesc: "Auto-launch Clawd whenever a Claude Code session starts.",
    rowBubbleFollow: "Bubbles follow Clawd",
    rowBubbleFollowDesc: "Place permission and update bubbles next to the pet instead of the screen corner.",
    rowHideBubbles: "Hide all bubbles",
    rowHideBubblesDesc: "Suppress permission, notification, and update bubbles entirely.",
    rowShowSessionId: "Show session ID",
    rowShowSessionIdDesc: "Append the short session ID to bubble headers and the Sessions menu.",
    placeholderTitle: "Coming soon",
    placeholderDesc: "This panel will land in a future Clawd release. The plan lives in docs/plan-settings-panel.md.",
    toastSaveFailed: "Couldn't save: ",
    langEnglish: "English",
    langChinese: "中文",
    themeTitle: "Theme",
    themeSubtitle: "Pick a theme for Clawd. Community themes land in your user themes folder and can be removed from here.",
    themeEmpty: "No themes available.",
    themeBadgeBuiltin: "Built-in",
    themeBadgeActive: "Active",
    themeActiveIndicator: "\u2713 Active",
    themeThumbMissing: "\u{1F3AD}",
    themeDeleteLabel: "Delete theme",
    toastThemeDeleted: "Theme deleted.",
    toastThemeDeleteFailed: "Couldn't delete theme: ",
    themeOpenFolderLabel: "Open user themes folder",
  },
  zh: {
    settingsTitle: "设置",
    settingsSubtitle: "配置 Clawd 在桌面上的行为。",
    sidebarGeneral: "通用",
    sidebarAgents: "Agent 管理",
    sidebarTheme: "主题",
    sidebarAnimMap: "动画映射",
    sidebarShortcuts: "快捷键",
    sidebarAbout: "关于",
    sidebarSoon: "待推出",
    sectionAppearance: "外观",
    sectionStartup: "启动",
    sectionBubbles: "气泡",
    agentsTitle: "Agent 管理",
    agentsSubtitle: "按 agent 类型开关追踪。关闭后会停掉日志监视器、在 HTTP 入口丢弃 hook 事件——不会再驱动桌宠、不弹权限气泡、不记会话。",
    agentsEmpty: "没有已注册的 agent。",
    eventSourceHook: "Hook",
    eventSourceLogPoll: "日志轮询",
    eventSourcePlugin: "插件",
    badgePermissionBubble: "权限气泡",
    rowAgentPermissions: "显示弹窗",
    rowAgentPermissionsDesc: "关闭后让该 agent 在自己的终端里处理提示，不再弹 Clawd 气泡。",
    rowLanguage: "语言",
    rowLanguageDesc: "菜单和气泡的界面语言。",
    rowSound: "音效",
    rowSoundDesc: "Clawd 完成任务或需要输入时播放提示音。",
    rowOpenAtLogin: "开机自启",
    rowOpenAtLoginDesc: "登录系统时自动启动 Clawd。",
    rowStartWithClaude: "随 Claude Code 启动",
    rowStartWithClaudeDesc: "Claude Code 会话开始时自动拉起 Clawd。",
    rowBubbleFollow: "气泡跟随 Clawd",
    rowBubbleFollowDesc: "把权限气泡和更新气泡放在桌宠旁边，而不是屏幕角落。",
    rowHideBubbles: "隐藏所有气泡",
    rowHideBubblesDesc: "完全屏蔽权限、通知和更新气泡。",
    rowShowSessionId: "显示会话 ID",
    rowShowSessionIdDesc: "在气泡标题和会话菜单后追加短会话 ID。",
    placeholderTitle: "即将推出",
    placeholderDesc: "此面板将在 Clawd 后续版本中加入，规划见 docs/plan-settings-panel.md。",
    toastSaveFailed: "保存失败：",
    langEnglish: "English",
    langChinese: "中文",
    themeTitle: "主题",
    themeSubtitle: "为 Clawd 选择一个主题。社区主题会放在你的用户主题目录里，可以在此删除。",
    themeEmpty: "没有可用的主题。",
    themeBadgeBuiltin: "内建",
    themeBadgeActive: "当前",
    themeActiveIndicator: "\u2713 当前",
    themeThumbMissing: "\u{1F3AD}",
    themeDeleteLabel: "删除主题",
    toastThemeDeleted: "主题已删除。",
    toastThemeDeleteFailed: "删除主题失败：",
    themeOpenFolderLabel: "打开用户主题目录",
  },
};

let snapshot = null;
let activeTab = "general";
// Static per-agent metadata from agents/registry.js via settings:list-agents.
// Fetched once at boot (since it can't change while the app is running).
// Null until hydrated — renderAgentsTab() renders an empty placeholder.
let agentMetadata = null;

// Theme list cache. Unlike agents, this CAN change at runtime (user deletes
// a theme, drops a new one into the folder). Null until first fetch; refreshed
// on tab open, after removeTheme succeeds, and on `theme` broadcasts.
let themeList = null;

function t(key) {
  const lang = (snapshot && snapshot.lang) || "en";
  const dict = STRINGS[lang] || STRINGS.en;
  return dict[key] || key;
}

// ── Toast ──
const toastStack = document.getElementById("toastStack");
function showToast(message, { error = false, ttl = 3500 } = {}) {
  const node = document.createElement("div");
  node.className = "toast" + (error ? " error" : "");
  node.textContent = message;
  toastStack.appendChild(node);
  // Force reflow then add visible class so the transition runs.
  // eslint-disable-next-line no-unused-expressions
  node.offsetHeight;
  node.classList.add("visible");
  setTimeout(() => {
    node.classList.remove("visible");
    setTimeout(() => node.remove(), 240);
  }, ttl);
}

// ── Sidebar ──
const SIDEBAR_TABS = [
  { id: "general", icon: "\u2699", labelKey: "sidebarGeneral", available: true },
  { id: "agents", icon: "\u26A1", labelKey: "sidebarAgents", available: true },
  { id: "theme", icon: "\u{1F3A8}", labelKey: "sidebarTheme", available: true },
  { id: "animMap", icon: "\u{1F3AC}", labelKey: "sidebarAnimMap", available: false },
  { id: "shortcuts", icon: "\u2328", labelKey: "sidebarShortcuts", available: false },
  { id: "about", icon: "\u2139", labelKey: "sidebarAbout", available: false },
];

function renderSidebar() {
  const sidebar = document.getElementById("sidebar");
  sidebar.innerHTML = "";
  for (const tab of SIDEBAR_TABS) {
    const item = document.createElement("div");
    item.className = "sidebar-item";
    if (!tab.available) item.classList.add("disabled");
    if (tab.id === activeTab) item.classList.add("active");
    item.innerHTML =
      `<span class="sidebar-item-icon">${tab.icon}</span>` +
      `<span class="sidebar-item-label">${escapeHtml(t(tab.labelKey))}</span>` +
      (tab.available ? "" : `<span class="sidebar-item-soon">${escapeHtml(t("sidebarSoon"))}</span>`);
    if (tab.available) {
      item.addEventListener("click", () => {
        activeTab = tab.id;
        renderSidebar();
        renderContent();
      });
    }
    sidebar.appendChild(item);
  }
}

// ── Content ──
function renderContent() {
  const content = document.getElementById("content");
  content.innerHTML = "";
  if (activeTab === "general") {
    renderGeneralTab(content);
  } else if (activeTab === "agents") {
    renderAgentsTab(content);
  } else if (activeTab === "theme") {
    renderThemeTab(content);
  } else {
    renderPlaceholder(content);
  }
}

// ── Theme tab ──

function fetchThemes() {
  if (!window.settingsAPI || typeof window.settingsAPI.listThemes !== "function") {
    themeList = [];
    return Promise.resolve([]);
  }
  return window.settingsAPI.listThemes().then((list) => {
    themeList = Array.isArray(list) ? list : [];
    return themeList;
  }).catch((err) => {
    console.warn("settings: listThemes failed", err);
    themeList = [];
    return [];
  });
}

function renderThemeTab(parent) {
  const h1 = document.createElement("h1");
  h1.textContent = t("themeTitle");
  parent.appendChild(h1);

  const subtitle = document.createElement("p");
  subtitle.className = "subtitle";
  subtitle.textContent = t("themeSubtitle");
  parent.appendChild(subtitle);

  // First render: kick off an async fetch, show an empty shell in the
  // meantime. Subsequent renders use the cached list so tab-flip stays
  // instant.
  if (themeList === null) {
    const loading = document.createElement("div");
    loading.className = "placeholder-desc";
    parent.appendChild(loading);
    fetchThemes().then(() => {
      if (activeTab === "theme") renderContent();
    });
    return;
  }

  if (themeList.length === 0) {
    const empty = document.createElement("div");
    empty.className = "placeholder";
    empty.innerHTML = `<div class="placeholder-desc">${escapeHtml(t("themeEmpty"))}</div>`;
    parent.appendChild(empty);
    return;
  }

  const grid = document.createElement("div");
  grid.className = "theme-grid";
  for (const theme of themeList) grid.appendChild(buildThemeCard(theme));
  parent.appendChild(grid);
}

function buildThemeCard(theme) {
  const card = document.createElement("div");
  card.className = "theme-card";
  card.setAttribute("role", "radio");
  card.setAttribute("tabindex", "0");
  card.setAttribute("aria-checked", theme.active ? "true" : "false");
  if (theme.active) card.classList.add("active");

  // Thumbnail — img with file:// URL if preview resolved, otherwise a
  // neutral glyph. APNG thumbnails animate inside the <img>; acceptable
  // as a "degraded but working" behavior per Phase 3a decision.
  const thumb = document.createElement("div");
  thumb.className = "theme-thumb";
  if (theme.previewFileUrl) {
    const img = document.createElement("img");
    img.src = theme.previewFileUrl;
    img.alt = "";
    img.draggable = false;
    thumb.appendChild(img);
  } else {
    const glyph = document.createElement("span");
    glyph.className = "theme-thumb-empty";
    glyph.textContent = t("themeThumbMissing");
    thumb.appendChild(glyph);
  }
  card.appendChild(thumb);

  // Name + builtin badge on same row.
  const name = document.createElement("div");
  name.className = "theme-card-name";
  const nameText = document.createElement("span");
  nameText.className = "theme-card-name-text";
  nameText.textContent = theme.name || theme.id;
  name.appendChild(nameText);
  if (theme.builtin) {
    const badge = document.createElement("span");
    badge.className = "theme-card-badge";
    badge.textContent = t("themeBadgeBuiltin");
    name.appendChild(badge);
  }
  card.appendChild(name);

  // Footer: active indicator on the left, delete button on the right.
  // Delete is hidden for built-ins (safety) and for the active theme
  // (must switch away first). Those two rules are also enforced by the
  // settings-actions removeTheme gate — the UI just avoids offering
  // the button in the first place.
  const footer = document.createElement("div");
  footer.className = "theme-card-footer";
  const indicator = document.createElement("span");
  indicator.className = "theme-card-check";
  indicator.textContent = theme.active ? t("themeActiveIndicator") : "";
  footer.appendChild(indicator);
  if (!theme.builtin && !theme.active) {
    const btn = document.createElement("button");
    btn.className = "theme-delete-btn";
    btn.type = "button";
    btn.textContent = "\u{1F5D1}";
    btn.title = t("themeDeleteLabel");
    btn.setAttribute("aria-label", t("themeDeleteLabel"));
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      handleDeleteTheme(theme);
    });
    footer.appendChild(btn);
  }
  card.appendChild(footer);

  // Click / keyboard anywhere on the card (except the delete button, which
  // stopPropagation'd) selects the theme.
  const select = () => {
    if (theme.active) return;
    if (card.classList.contains("pending")) return;
    card.classList.add("pending");
    Promise.resolve()
      .then(() => window.settingsAPI.update("theme", theme.id))
      .then((result) => {
        card.classList.remove("pending");
        if (!result || result.status !== "ok") {
          const msg = (result && result.message) || "unknown error";
          showToast(t("toastSaveFailed") + msg, { error: true });
        }
        // On success the broadcast re-renders and marks this card active.
      })
      .catch((err) => {
        card.classList.remove("pending");
        showToast(t("toastSaveFailed") + (err && err.message), { error: true });
      });
  };
  card.addEventListener("click", select);
  card.addEventListener("keydown", (ev) => {
    if (ev.key === " " || ev.key === "Enter") {
      ev.preventDefault();
      select();
    }
  });
  return card;
}

function handleDeleteTheme(theme) {
  if (!window.settingsAPI) return;
  // Main-process native dialog — renderer never owns the confirmation
  // decision. Returns { confirmed: boolean }.
  window.settingsAPI
    .confirmRemoveTheme(theme.id)
    .then((res) => {
      if (!res || !res.confirmed) return null;
      return window.settingsAPI.command("removeTheme", theme.id);
    })
    .then((result) => {
      if (result == null) return; // dialog cancelled
      if (result.status !== "ok") {
        const msg = (result && result.message) || "unknown error";
        showToast(t("toastThemeDeleteFailed") + msg, { error: true });
        return;
      }
      showToast(t("toastThemeDeleted"));
      // Re-fetch since the deleted theme won't show up in discoverThemes
      // anymore. Then re-render if still on this tab.
      fetchThemes().then(() => {
        if (activeTab === "theme") renderContent();
      });
    })
    .catch((err) => {
      showToast(t("toastThemeDeleteFailed") + (err && err.message), { error: true });
    });
}

function renderAgentsTab(parent) {
  const h1 = document.createElement("h1");
  h1.textContent = t("agentsTitle");
  parent.appendChild(h1);

  const subtitle = document.createElement("p");
  subtitle.className = "subtitle";
  subtitle.textContent = t("agentsSubtitle");
  parent.appendChild(subtitle);

  if (!agentMetadata || agentMetadata.length === 0) {
    const empty = document.createElement("div");
    empty.className = "placeholder";
    empty.innerHTML = `<div class="placeholder-desc">${escapeHtml(t("agentsEmpty"))}</div>`;
    parent.appendChild(empty);
    return;
  }

  const rows = agentMetadata.flatMap((agent) => buildAgentRows(agent));
  parent.appendChild(buildSection("", rows));
}

function buildAgentRows(agent) {
  const rows = [
    buildAgentSwitchRow({
      agent,
      flag: "enabled",
      extraClass: null,
      buildText: (text) => {
        const label = document.createElement("span");
        label.className = "row-label";
        label.textContent = agent.name || agent.id;
        text.appendChild(label);
        const badges = document.createElement("span");
        badges.className = "row-desc agent-badges";
        const esKey = agent.eventSource === "log-poll" ? "eventSourceLogPoll"
          : agent.eventSource === "plugin-event" ? "eventSourcePlugin"
          : "eventSourceHook";
        const esBadge = document.createElement("span");
        esBadge.className = "agent-badge";
        esBadge.textContent = t(esKey);
        badges.appendChild(esBadge);
        if (agent.capabilities && agent.capabilities.permissionApproval) {
          const permBadge = document.createElement("span");
          permBadge.className = "agent-badge accent";
          permBadge.textContent = t("badgePermissionBubble");
          badges.appendChild(permBadge);
        }
        text.appendChild(badges);
      },
    }),
  ];
  const caps = agent.capabilities || {};
  if (caps.permissionApproval || caps.interactiveBubble) {
    rows.push(buildAgentSwitchRow({
      agent,
      flag: "permissionsEnabled",
      extraClass: "row-sub",
      buildText: (text) => {
        const label = document.createElement("span");
        label.className = "row-label";
        label.textContent = t("rowAgentPermissions");
        text.appendChild(label);
        const desc = document.createElement("span");
        desc.className = "row-desc";
        desc.textContent = t("rowAgentPermissionsDesc");
        text.appendChild(desc);
      },
    }));
  }
  return rows;
}

function buildAgentSwitchRow({ agent, flag, extraClass, buildText }) {
  const row = document.createElement("div");
  row.className = extraClass ? `row ${extraClass}` : "row";

  const text = document.createElement("div");
  text.className = "row-text";
  buildText(text);
  row.appendChild(text);

  const ctrl = document.createElement("div");
  ctrl.className = "row-control";
  const sw = document.createElement("div");
  sw.className = "switch";
  sw.setAttribute("role", "switch");
  sw.setAttribute("tabindex", "0");
  const readFlag = () => {
    const entry = snapshot && snapshot.agents && snapshot.agents[agent.id];
    return entry ? entry[flag] !== false : true;
  };
  const on = readFlag();
  if (on) sw.classList.add("on");
  sw.setAttribute("aria-checked", on ? "true" : "false");
  attachSwitchToggle(sw, () =>
    window.settingsAPI.command("setAgentFlag", {
      agentId: agent.id,
      flag,
      value: !readFlag(),
    })
  );
  ctrl.appendChild(sw);
  row.appendChild(ctrl);
  return row;
}

function renderPlaceholder(parent) {
  const div = document.createElement("div");
  div.className = "placeholder";
  div.innerHTML =
    `<div class="placeholder-icon">\u{1F6E0}</div>` +
    `<div class="placeholder-title">${escapeHtml(t("placeholderTitle"))}</div>` +
    `<div class="placeholder-desc">${escapeHtml(t("placeholderDesc"))}</div>`;
  parent.appendChild(div);
}

function renderGeneralTab(parent) {
  const h1 = document.createElement("h1");
  h1.textContent = t("settingsTitle");
  parent.appendChild(h1);

  const subtitle = document.createElement("p");
  subtitle.className = "subtitle";
  subtitle.textContent = t("settingsSubtitle");
  parent.appendChild(subtitle);

  // Section: Appearance
  parent.appendChild(buildSection(t("sectionAppearance"), [
    buildLanguageRow(),
    buildSwitchRow({
      key: "soundMuted",
      labelKey: "rowSound",
      descKey: "rowSoundDesc",
      // soundMuted is inverse: ON-switch means sound enabled.
      invert: true,
    }),
  ]));

  // Section: Startup
  parent.appendChild(buildSection(t("sectionStartup"), [
    buildSwitchRow({
      key: "openAtLogin",
      labelKey: "rowOpenAtLogin",
      descKey: "rowOpenAtLoginDesc",
    }),
    buildSwitchRow({
      key: "autoStartWithClaude",
      labelKey: "rowStartWithClaude",
      descKey: "rowStartWithClaudeDesc",
    }),
  ]));

  // Section: Bubbles
  parent.appendChild(buildSection(t("sectionBubbles"), [
    buildSwitchRow({
      key: "bubbleFollowPet",
      labelKey: "rowBubbleFollow",
      descKey: "rowBubbleFollowDesc",
    }),
    buildSwitchRow({
      key: "hideBubbles",
      labelKey: "rowHideBubbles",
      descKey: "rowHideBubblesDesc",
    }),
    buildSwitchRow({
      key: "showSessionId",
      labelKey: "rowShowSessionId",
      descKey: "rowShowSessionIdDesc",
    }),
  ]));
}

function buildSection(title, rows) {
  const section = document.createElement("section");
  section.className = "section";
  if (title) {
    const heading = document.createElement("h2");
    heading.className = "section-title";
    heading.textContent = title;
    section.appendChild(heading);
  }
  const wrap = document.createElement("div");
  wrap.className = "section-rows";
  for (const row of rows) wrap.appendChild(row);
  section.appendChild(wrap);
  return section;
}

// Wire click + Space/Enter keydown on a `.switch` to an async invoker that
// returns a `Promise<{status, message?}>`. Handles pending state, error
// toasts, and keyboard activation identically across all rows — so
// `buildSwitchRow` (pure prefs) and `buildAgentRow` (command-backed) share
// a single toggle behavior.
function attachSwitchToggle(sw, invoke) {
  const run = () => {
    if (sw.classList.contains("pending")) return;
    sw.classList.add("pending");
    Promise.resolve()
      .then(invoke)
      .then((result) => {
        sw.classList.remove("pending");
        if (!result || result.status !== "ok") {
          const msg = (result && result.message) || "unknown error";
          showToast(t("toastSaveFailed") + msg, { error: true });
        }
      })
      .catch((err) => {
        sw.classList.remove("pending");
        showToast(t("toastSaveFailed") + (err && err.message), { error: true });
      });
  };
  sw.addEventListener("click", run);
  sw.addEventListener("keydown", (ev) => {
    if (ev.key === " " || ev.key === "Enter") {
      ev.preventDefault();
      run();
    }
  });
}

function buildSwitchRow({ key, labelKey, descKey, invert = false }) {
  const row = document.createElement("div");
  row.className = "row";
  row.innerHTML =
    `<div class="row-text">` +
      `<span class="row-label"></span>` +
      `<span class="row-desc"></span>` +
    `</div>` +
    `<div class="row-control"><div class="switch" role="switch" tabindex="0"></div></div>`;
  row.querySelector(".row-label").textContent = t(labelKey);
  row.querySelector(".row-desc").textContent = t(descKey);
  const sw = row.querySelector(".switch");
  const rawValue = !!(snapshot && snapshot[key]);
  const visualOn = invert ? !rawValue : rawValue;
  if (visualOn) sw.classList.add("on");
  sw.setAttribute("aria-checked", visualOn ? "true" : "false");
  // No optimistic update — visual state flips on broadcast, not on click.
  // If the action fails, the broadcast never fires and the switch stays.
  attachSwitchToggle(sw, () => {
    const currentRaw = !!(snapshot && snapshot[key]);
    const currentVisual = invert ? !currentRaw : currentRaw;
    const nextRaw = invert ? currentVisual : !currentVisual;
    return window.settingsAPI.update(key, nextRaw);
  });
  return row;
}

function buildLanguageRow() {
  const row = document.createElement("div");
  row.className = "row";
  row.innerHTML =
    `<div class="row-text">` +
      `<span class="row-label"></span>` +
      `<span class="row-desc"></span>` +
    `</div>` +
    `<div class="row-control">` +
      `<div class="segmented" role="tablist">` +
        `<button data-lang="en"></button>` +
        `<button data-lang="zh"></button>` +
      `</div>` +
    `</div>`;
  row.querySelector(".row-label").textContent = t("rowLanguage");
  row.querySelector(".row-desc").textContent = t("rowLanguageDesc");
  const buttons = row.querySelectorAll(".segmented button");
  buttons[0].textContent = t("langEnglish");
  buttons[1].textContent = t("langChinese");
  const current = (snapshot && snapshot.lang) || "en";
  for (const btn of buttons) {
    if (btn.dataset.lang === current) btn.classList.add("active");
    btn.addEventListener("click", () => {
      const next = btn.dataset.lang;
      if (next === ((snapshot && snapshot.lang) || "en")) return;
      window.settingsAPI.update("lang", next).then((result) => {
        if (!result || result.status !== "ok") {
          const msg = (result && result.message) || "unknown error";
          showToast(t("toastSaveFailed") + msg, { error: true });
        }
      }).catch((err) => {
        showToast(t("toastSaveFailed") + (err && err.message), { error: true });
      });
    });
  }
  return row;
}

// ── Boot ──
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

window.settingsAPI.onChanged((payload) => {
  if (payload && payload.snapshot) {
    snapshot = payload.snapshot;
  } else if (payload && payload.changes && snapshot) {
    snapshot = { ...snapshot, ...payload.changes };
  }
  // Guard against an early broadcast that lands before `getSnapshot()`
  // resolves — rendering with a null snapshot blanks the UI and the
  // initial render later would need to re-fetch static language state.
  if (!snapshot) return;
  // If the theme changed (menu-side switch, startup fallback hydrate, etc.)
  // the list's `active` flags are stale — refetch then re-render. Cheap:
  // discoverThemes + getThemeMetadata is just a handful of fs stats.
  const changes = payload && payload.changes;
  if (changes && ("theme" in changes || "themeOverrides" in changes)) {
    fetchThemes().then(() => {
      renderSidebar();
      renderContent();
    });
    return;
  }
  renderSidebar();
  renderContent();
});

window.settingsAPI.getSnapshot().then((snap) => {
  snapshot = snap || {};
  renderSidebar();
  renderContent();
});

// Fetch static agent metadata once at boot. It's a pure lookup from
// agents/registry.js — no runtime state — so there's no refresh loop.
if (typeof window.settingsAPI.listAgents === "function") {
  window.settingsAPI
    .listAgents()
    .then((list) => {
      agentMetadata = Array.isArray(list) ? list : [];
      if (activeTab === "agents") renderContent();
    })
    .catch((err) => {
      console.warn("settings: listAgents failed", err);
      agentMetadata = [];
    });
}
