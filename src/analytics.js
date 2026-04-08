// src/analytics.js — Dashboard window lifecycle (create/toggle/destroy)

const { BrowserWindow, ipcMain } = require("electron");
const path = require("path");

module.exports = function initAnalytics(ctx) {
  let dashWin = null;

  function createWindow() {
    dashWin = new BrowserWindow({
      width: 900,
      height: 650,
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
    // Merge with existing config: the GET handler masks apiKey before
    // sending it to the renderer, so the form has no way to round-trip
    // the saved key. If the incoming payload omits apiKey (or sends it
    // as empty string), preserve the previously saved value instead of
    // wiping it. Use `apiKey: null` to explicitly clear.
    const existing = ctx.analyticsAI.getConfig() || {};
    const incoming = config || {};
    const merged = { ...existing, ...incoming };
    if (incoming.apiKey === undefined || incoming.apiKey === "") {
      if (existing.apiKey) merged.apiKey = existing.apiKey;
      else delete merged.apiKey;
    } else if (incoming.apiKey === null) {
      delete merged.apiKey;
    }
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

  ipcMain.handle("analytics-get-timeline", async (_event, range, year, month) => {
    if (!ctx.analyticsScan) return null;
    // Month tab passes year + month (1-indexed). Extra args are backward-
    // compatible — old callers passing only `range` still hit the existing
    // branches below.
    if (range === "month" && year && month && ctx.analyticsScan.scanMonthOf) {
      return ctx.analyticsScan.scanMonthOf(year, month);
    }
    if (range === "week") return ctx.analyticsScan.scanWeek();
    if (range === "3days") return ctx.analyticsScan.scan3Days();
    return ctx.analyticsScan.scanToday();
  });

  // Returns the list of months that have at least one session, most recent
  // first. Used by the Month-tab dropdown so the picker only shows months
  // that contain data.
  ipcMain.handle("analytics-get-available-months", async () => {
    if (!ctx.analyticsScan || !ctx.analyticsScan.getAvailableMonths) return [];
    return ctx.analyticsScan.getAvailableMonths();
  });

  ipcMain.handle("analytics-analyze-session", async (_event, sessionId, agent, preferredProvider) => {
    if (!ctx.analyticsScan || !ctx.analyticsAI) return null;
    const detail = ctx.analyticsScan.getSessionDetail(sessionId, agent);
    if (!detail) return null;
    if (preferredProvider) detail._preferredProvider = preferredProvider;
    return ctx.analyticsAI.analyzeSession(detail);
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
