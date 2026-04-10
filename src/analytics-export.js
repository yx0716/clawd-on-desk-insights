function formatOutcome(outcome) {
  if (!outcome) return "";
  if (typeof outcome === "string") return outcome.trim();
  const head = String(outcome.headline || "").trim();
  const detail = String(outcome.detail || "").trim();
  if (head && detail) return `${head}：${detail}`;
  return head || detail;
}

function pushAnalysisSection(lines, heading, analysis, includeTimeBreakdown) {
  lines.push(`### ${heading}`);
  lines.push("");

  if (!analysis || typeof analysis !== "object") {
    lines.push("- 无可用分析内容");
    lines.push("");
    return;
  }

  const summary = String(analysis.summary || "").trim();
  if (summary) lines.push(`- 摘要：${summary}`);

  const keyTopics = Array.isArray(analysis.keyTopics)
    ? analysis.keyTopics.map(item => String(item || "").trim()).filter(Boolean)
    : [];
  if (keyTopics.length) lines.push(`- 话题：${keyTopics.join(" / ")}`);

  const outcomes = Array.isArray(analysis.outcomes)
    ? analysis.outcomes.map(formatOutcome).filter(Boolean)
    : [];
  if (outcomes.length) {
    lines.push("- 结果：");
    outcomes.forEach(item => lines.push(`  - ${item}`));
  }

  if (includeTimeBreakdown) {
    const breakdown = Array.isArray(analysis.timeBreakdown)
      ? analysis.timeBreakdown
        .map(item => {
          if (!item) return "";
          const activity = String(item.activity || "").trim();
          const percent = item.percent == null ? "" : String(item.percent).trim();
          return activity ? `${activity}${percent ? ` ${percent}%` : ""}` : "";
        })
        .filter(Boolean)
      : [];
    if (breakdown.length) {
      lines.push("- 时间分布：");
      breakdown.forEach(item => lines.push(`  - ${item}`));
    }
  }

  const suggestions = Array.isArray(analysis.suggestions)
    ? analysis.suggestions.map(item => String(item || "").trim()).filter(Boolean)
    : [];
  if (suggestions.length) {
    lines.push("- 建议：");
    suggestions.forEach(item => lines.push(`  - ${item}`));
  }

  if (!summary && !keyTopics.length && !outcomes.length && !(includeTimeBreakdown && Array.isArray(analysis.timeBreakdown) && analysis.timeBreakdown.length) && !suggestions.length) {
    lines.push("- 无可用分析内容");
  }

  lines.push("");
}

function buildSessionAnalysesExportMarkdown(payload = {}) {
  const lines = [];
  const sessions = Array.isArray(payload.sessions) ? payload.sessions : [];
  const exportedAt = payload.exportedAt || new Date().toISOString();

  lines.push("# Session AI 分析导出");
  lines.push("");
  lines.push(`- 导出时间：${exportedAt}`);
  if (payload.providerLabel) lines.push(`- Provider：${payload.providerLabel}`);
  lines.push(`- Sessions：${sessions.length}`);
  lines.push("");

  sessions.forEach((session, index) => {
    const title = String(session.title || session.project || session.sessionId || `session-${index + 1}`).trim();
    lines.push(`## ${index + 1}. ${title}`);
    lines.push("");
    if (session.sessionId) lines.push(`- Session ID：\`${session.sessionId}\``);
    if (session.agentLabel) lines.push(`- Agent：${session.agentLabel}`);
    if (session.project) lines.push(`- 项目：${session.project}`);
    if (session.timeRange) lines.push(`- 时间段：${session.timeRange}`);
    if (session.activeSpan) lines.push(`- 活跃跨度：${session.activeSpan}`);
    lines.push("");
    pushAnalysisSection(lines, "速览", session.briefAnalysis, false);
    pushAnalysisSection(lines, "深入分析", session.detailAnalysis, true);
  });

  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}

function makeSessionAnalysesExportFilename(now = new Date()) {
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `clawd-session-analyses-${yyyy}${mm}${dd}.md`;
}

module.exports = {
  buildSessionAnalysesExportMarkdown,
  makeSessionAnalysesExportFilename,
};
