// src/preload-analytics.js — IPC bridge for analytics dashboard window

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("analyticsAPI", {
  getData: (filters) => ipcRenderer.invoke("analytics-get-data", filters),
  getInsights: () => ipcRenderer.invoke("analytics-get-insights"),
  getAIConfig: () => ipcRenderer.invoke("analytics-get-ai-config"),
  saveAIConfig: (config) => ipcRenderer.invoke("analytics-save-ai-config", config),
  getProviders: () => ipcRenderer.invoke("analytics-get-providers"),
  getConversations: (range) => ipcRenderer.invoke("analytics-get-conversations", range),
  getTimeline: (range) => ipcRenderer.invoke("analytics-get-timeline", range),
  analyzeSession: (sessionId, agent, provider) => ipcRenderer.invoke("analytics-analyze-session", sessionId, agent, provider),
  getAnalysisProvider: () => ipcRenderer.invoke("analytics-get-analysis-provider"),
  getAnalysisOptions: () => ipcRenderer.invoke("analytics-get-analysis-options"),
  getOneLiners: (sessionIds) => ipcRenderer.invoke("analytics-get-oneliners", sessionIds),
});
