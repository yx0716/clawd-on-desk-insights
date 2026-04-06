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
    ctx.analyticsAI.setConfig(config);
  });

  ipcMain.handle("analytics-get-providers", async () => {
    return ctx.analyticsAI.PROVIDERS;
  });

  ipcMain.handle("analytics-get-conversations", async (_event, range) => {
    if (!ctx.analyticsScan) return null;
    if (range === "week") return ctx.analyticsScan.scanWeek();
    return ctx.analyticsScan.scanToday();
  });

  ipcMain.handle("analytics-get-timeline", async (_event, range) => {
    if (!ctx.analyticsScan) return null;
    if (range === "week") return ctx.analyticsScan.scanWeek();
    if (range === "3days") return ctx.analyticsScan.scan3Days();
    return ctx.analyticsScan.scanToday();
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
