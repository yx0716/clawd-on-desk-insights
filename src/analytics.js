// src/analytics.js — Dashboard window lifecycle (create/toggle/destroy)

const fs = require("fs");
const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const path = require("path");
const { mergeAIConfig } = require("./analytics-config");
const {
  buildSessionAnalysesExportMarkdown,
  makeSessionAnalysesExportFilename,
} = require("./analytics-export");

module.exports = function initAnalytics(ctx) {
  let dashWin = null;

  function createWindow() {
    dashWin = new BrowserWindow({
      width: 1040,
      height: 720,
      minWidth: 600,
      minHeight: 450,
      frame: true,
      resizable: true,
      alwaysOnTop: false,
      skipTaskbar: false,
      title: "Clawd Analytics",
      show: false,
      webPreferences: {
        preload: path.join(__dirname, "preload-analytics.js"),
        nodeIntegration: false,
        contextIsolation: true,
      },
    });

    dashWin.loadFile(path.join(__dirname, "analytics.html"));

    dashWin.once("ready-to-show", () => {
      dashWin.show();
    });

    dashWin.on("closed", () => {
      dashWin = null;
    });
  }

  function toggleDashboard() {
    if (dashWin && !dashWin.isDestroyed()) {
      if (dashWin.isVisible()) {
        dashWin.hide();
      } else {
        dashWin.show();
        dashWin.focus();
      }
    } else {
      createWindow();
    }
  }

  // IPC handlers
  ipcMain.handle("analytics-get-data", async (_event, filters) => {
    const today = ctx.analyticsData.aggregateToday(filters);
    const week = ctx.analyticsData.aggregateWeek(filters);
    const computed = ctx.analyticsData.computeInsights(today, week);
    return { today, week, computed };
  });

  ipcMain.handle("analytics-get-insights", async () => {
    const today = ctx.analyticsData.aggregateToday();
    const week = ctx.analyticsData.aggregateWeek();
    return ctx.analyticsAI.getInsights(today, week);
  });

  ipcMain.handle("analytics-generate-report", async (_event, scope) => {
    const today = ctx.analyticsData.aggregateToday();
    const week = ctx.analyticsData.aggregateWeek();
    if (scope === "week") {
      return {
        scope: "week",
        title: "周报",
        text: ctx.analyticsData.buildWeeklyReport(week),
      };
    }
    const computed = ctx.analyticsData.computeInsights(today, week);
    return {
      scope: "day",
      title: "日报",
      text: ctx.analyticsData.buildDailyReport(today, computed),
    };
  });

  ipcMain.handle("analytics-pick-session-analyses-export-path", async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender) || dashWin || null;
    const result = await dialog.showSaveDialog(owner, {
      title: "Export Session Analyses",
      defaultPath: path.join(app.getPath("documents"), makeSessionAnalysesExportFilename()),
      filters: [
        { name: "Markdown", extensions: ["md"] },
        { name: "Text", extensions: ["txt"] },
      ],
    });
    return {
      canceled: !!result.canceled,
      filePath: result.filePath || null,
    };
  });

  ipcMain.handle("analytics-export-session-analyses", async (_event, payload) => {
    const markdown = buildSessionAnalysesExportMarkdown(payload || {});
    const filePath = payload && payload.filePath;
    if (!filePath) throw new Error("missing export path");
    fs.writeFileSync(filePath, markdown, "utf8");
    return { ok: true, filePath, markdown };
  });

  ipcMain.handle("analytics-get-ai-config", async () => {
    const cfg = ctx.analyticsAI.getConfig();
    if (!cfg) return null;
    // Mask the API key for display
    const masked = { ...cfg };
    if (masked.apiKey) {
      masked.apiKeyMasked = masked.apiKey.slice(0, 6) + "***" + masked.apiKey.slice(-4);
      delete masked.apiKey;
    }
    return masked;
  });

  ipcMain.handle("analytics-save-ai-config", async (_event, config) => {
    const existing = ctx.analyticsAI.getConfig() || {};
    const merged = mergeAIConfig(existing, config || {});
    ctx.analyticsAI.setConfig(merged);
    return { ok: true };
  });

  ipcMain.handle("analytics-clear-ai-config", async () => {
    ctx.analyticsAI.setConfig(null);
    return { ok: true };
  });

  // Settings UI: report which CLIs were detected and what was searched, so
  // users can debug "Codex doesn't show up in the provider list" without
  // reading source code.
  ipcMain.handle("analytics-cli-diagnostics", async () => {
    if (!ctx.analyticsAI || !ctx.analyticsAI.getCliDiagnostics) return null;
    return ctx.analyticsAI.getCliDiagnostics();
  });

  // Settings UI: validate a user-supplied custom CLI path. Returns
  // { ok, version, error } so the form can show inline feedback before save.
  ipcMain.handle("analytics-test-cli-path", async (_event, rawPath) => {
    if (!ctx.analyticsAI || !ctx.analyticsAI.testCliPath) return { ok: false, error: "unsupported" };
    return ctx.analyticsAI.testCliPath(rawPath);
  });

  ipcMain.handle("analytics-get-providers", async () => {
    return ctx.analyticsAI.PROVIDERS;
  });

  ipcMain.handle("analytics-get-conversations", async (_event, range) => {
    if (!ctx.analyticsScan) return null;
    if (range === "week") return ctx.analyticsScan.scanWeek();
    return ctx.analyticsScan.scanToday();
  });

  // Overlay clawd local title renames onto scan results. Local renames live
  // in ~/.clawd/session-titles.json (via analytics-titles module) because
  // Claude Desktop's rename feature doesn't write back to jsonl. We attach
  // them as `session.localTitle` — the renderer then resolves the final
  // display title via the chain `localTitle > title > firstUserMsg > project`.
  function overlayLocalTitles(data) {
    if (!data || !Array.isArray(data.sessions) || !ctx.analyticsTitles) return data;
    const titles = ctx.analyticsTitles.getAll();
    if (!titles) return data;
    for (const sess of data.sessions) {
      if (sess && sess.id && titles[sess.id]) {
        sess.localTitle = titles[sess.id];
      }
    }
    return data;
  }

  ipcMain.handle("analytics-get-timeline", async (_event, range, year, month) => {
    if (!ctx.analyticsScan) return null;
    // Month tab passes year + month (1-indexed). Extra args are backward-
    // compatible — old callers passing only `range` still hit the existing
    // branches below.
    let data;
    if (range === "month" && year && month && ctx.analyticsScan.scanMonthOf) {
      data = ctx.analyticsScan.scanMonthOf(year, month);
    } else if (range === "week") {
      data = ctx.analyticsScan.scanWeek();
    } else if (range === "3days") {
      data = ctx.analyticsScan.scan3Days();
    } else {
      data = ctx.analyticsScan.scanToday();
    }
    return overlayLocalTitles(data);
  });

  // Returns the list of months that have at least one session, most recent
  // first. Used by the Month-tab dropdown so the picker only shows months
  // that contain data.
  ipcMain.handle("analytics-get-available-months", async () => {
    if (!ctx.analyticsScan || !ctx.analyticsScan.getAvailableMonths) return [];
    return ctx.analyticsScan.getAvailableMonths();
  });

  // ── Local session title overrides (user renames from the dashboard) ──
  // These persist to ~/.clawd/session-titles.json and override both the
  // jsonl-derived title and the firstUserMsg/project fallbacks when rendering
  // session cards. See analytics-titles.js for the rationale.

  ipcMain.handle("analytics-get-local-title-map", async () => {
    if (!ctx.analyticsTitles) return {};
    return ctx.analyticsTitles.getAll();
  });

  ipcMain.handle("analytics-set-local-title", async (_event, sessionId, title) => {
    if (!ctx.analyticsTitles) return { ok: false, error: "titles module unavailable" };
    const ok = ctx.analyticsTitles.setTitle(sessionId, title);
    return { ok };
  });

  ipcMain.handle("analytics-clear-local-title", async (_event, sessionId) => {
    if (!ctx.analyticsTitles) return { ok: false, error: "titles module unavailable" };
    const ok = ctx.analyticsTitles.clearTitle(sessionId);
    return { ok };
  });

  ipcMain.handle("analytics-analyze-session", async (_event, sessionId, agent, preferredProvider, mode) => {
    if (!ctx.analyticsScan || !ctx.analyticsAI) return null;
    const detail = ctx.analyticsScan.getSessionDetail(sessionId, agent);
    if (!detail) return null;
    if (preferredProvider) detail._preferredProvider = preferredProvider;
    return ctx.analyticsAI.analyzeSession(detail, mode);
  });

  ipcMain.handle("analytics-get-analysis-provider", async () => {
    if (!ctx.analyticsAI) return null;
    return ctx.analyticsAI.getAnalysisProvider();
  });

  ipcMain.handle("analytics-get-analysis-options", async () => {
    if (!ctx.analyticsAI || !ctx.analyticsAI.getAvailableAnalysisProviders) return [];
    return ctx.analyticsAI.getAvailableAnalysisProviders();
  });

  ipcMain.handle("analytics-get-oneliners", async (_event, sessionIds) => {
    if (!ctx.analyticsScan || !ctx.analyticsAI) return {};
    const results = {};
    // Process sequentially to avoid flooding the CLI
    for (const { id, agent } of sessionIds) {
      const detail = ctx.analyticsScan.getSessionDetail(id, agent);
      if (detail) {
        try {
          results[id] = await ctx.analyticsAI.getSessionOneLiner(detail);
        } catch { results[id] = null; }
      }
    }
    return results;
  });

  function cleanup() {
    if (dashWin && !dashWin.isDestroyed()) {
      dashWin.destroy();
      dashWin = null;
    }
  }

  return { toggleDashboard, cleanup };
};

module.exports.__test = {
  buildSessionAnalysesExportMarkdown,
  makeSessionAnalysesExportFilename,
  mergeAIConfig,
};
