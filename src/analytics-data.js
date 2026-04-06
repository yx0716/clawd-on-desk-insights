// src/analytics-data.js — Aggregate analytics JSONL into rich time-based summaries
// All aggregations work without AI — pure data processing from hook events

const fs = require("fs");

const STATE_COLORS = {
  working: "#4CAF50", thinking: "#2196F3", juggling: "#9C27B0",
  idle: "#9E9E9E", error: "#F44336", attention: "#FF9800",
  sweeping: "#00BCD4", notification: "#FFEB3B", carrying: "#795548",
  sleeping: "#607D8B",
};

const AGENT_COLORS = {
  "claude-code": "#D97706", "codex": "#2563EB", "cursor-agent": "#7C3AED",
  "copilot-cli": "#059669", "gemini-cli": "#DC2626", "codebuddy": "#DB2777",
};

const ACTIVE_STATES = new Set(["working", "thinking", "juggling", "sweeping", "carrying"]);

function formatLocalDate(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

module.exports = function initAnalyticsData(ctx) {
  const logPath = ctx.analyticsPath;

  function loadEvents(startTs, endTs) {
    try {
      if (!fs.existsSync(logPath)) return [];
      const content = fs.readFileSync(logPath, "utf8");
      const lines = content.trim().split("\n").filter(Boolean);
      const events = [];
      for (const line of lines) {
        try {
          const ev = JSON.parse(line);
          if (ev.ts >= startTs && ev.ts <= endTs) events.push(ev);
        } catch { /* skip malformed */ }
      }
      return events;
    } catch { return []; }
  }

  function projectName(cwd) {
    if (!cwd) return "unknown";
    const parts = cwd.replace(/\\/g, "/").split("/").filter(Boolean);
    if (parts.length >= 2) return parts.slice(-2).join("/");
    return parts[parts.length - 1] || "unknown";
  }

  // Short display name for project (last segment only)
  function projectShort(cwd) {
    if (!cwd) return "unknown";
    const parts = cwd.replace(/\\/g, "/").split("/").filter(Boolean);
    return parts[parts.length - 1] || "unknown";
  }

  function aggregateToday(filters) {
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const endOfDay = startOfDay + 24 * 60 * 60 * 1000;
    return aggregateRange(startOfDay, endOfDay, now, filters);
  }

  // filters: { agent?: string, project?: string, keyword?: string }
  function aggregateRange(startTs, endTs, now, filters) {
    let events = loadEvents(startTs, endTs);

    // Apply filters
    if (filters) {
      if (filters.agent) {
        events = events.filter(e => e.agent === filters.agent);
      }
      if (filters.project) {
        events = events.filter(e => projectName(e.cwd) === filters.project || projectShort(e.cwd) === filters.project);
      }
      if (filters.keyword) {
        const kw = filters.keyword.toLowerCase();
        events = events.filter(e =>
          (e.cwd && e.cwd.toLowerCase().includes(kw)) ||
          (e.agent && e.agent.toLowerCase().includes(kw)) ||
          (e.event && e.event.toLowerCase().includes(kw)) ||
          (e.state && e.state.toLowerCase().includes(kw)) ||
          (e.hint && e.hint.toLowerCase().includes(kw)) ||
          (e.sid && e.sid.toLowerCase().includes(kw))
        );
      }
    }

    const stateTotals = {};
    const agentTotals = {};
    const projectTotals = {};     // key = short/path form
    const projectFullPaths = {};  // key → full cwd path (for tooltips)
    const eventCounts = {};
    const toolHintCounts = {};
    const hourly = Array.from({ length: 24 }, () => ({}));
    const sessionMap = {};
    const editorCounts = {};

    for (const ev of events) {
      const sid = ev.sid || "default";
      const agent = ev.agent || "unknown";
      const cwd = ev.cwd || "";
      const dur = ev.dur || 0;

      if (!sessionMap[sid]) {
        sessionMap[sid] = { agent, cwd, project: projectName(cwd), short: projectShort(cwd), events: [], totalActive: 0, firstTs: ev.ts, lastTs: ev.ts };
      }
      const sess = sessionMap[sid];
      sess.lastTs = Math.max(sess.lastTs, ev.ts);
      sess.events.push({ ts: ev.ts, state: ev.state, event: ev.event, dur, hint: ev.hint });

      if (ev.event) eventCounts[ev.event] = (eventCounts[ev.event] || 0) + 1;
      if (ev.hint) toolHintCounts[ev.hint] = (toolHintCounts[ev.hint] || 0) + 1;
      if (ev.editor) editorCounts[ev.editor] = (editorCounts[ev.editor] || 0) + 1;

      if (!ev.prev || dur <= 0) continue;

      const state = ev.prev;
      stateTotals[state] = (stateTotals[state] || 0) + dur;
      agentTotals[agent] = (agentTotals[agent] || 0) + dur;

      const projKey = projectShort(cwd);
      if (projKey !== "unknown") {
        projectTotals[projKey] = (projectTotals[projKey] || 0) + dur;
        if (cwd) projectFullPaths[projKey] = cwd;
      }

      if (ACTIVE_STATES.has(state)) sess.totalActive += dur;

      const prevTs = ev.ts - dur;
      const hour = new Date(prevTs).getHours();
      if (hour >= 0 && hour < 24) {
        hourly[hour][state] = (hourly[hour][state] || 0) + dur;
      }
    }

    const activeTime = Object.entries(stateTotals).filter(([s]) => ACTIVE_STATES.has(s)).reduce((sum, [, ms]) => sum + ms, 0);
    const totalTime = Object.values(stateTotals).reduce((a, b) => a + b, 0);

    const sessions = Object.entries(sessionMap)
      .map(([sid, s]) => ({
        sid, agent: s.agent, project: s.short, fullPath: s.cwd,
        eventCount: s.events.length, totalActive: s.totalActive,
        firstTs: s.firstTs, lastTs: s.lastTs, duration: s.lastTs - s.firstTs,
      }))
      .sort((a, b) => b.lastTs - a.lastTs);

    // Collect available filter options (for UI dropdowns)
    const availableAgents = [...new Set(events.map(e => e.agent).filter(Boolean))];
    const availableProjects = [...new Set(events.map(e => projectShort(e.cwd)).filter(p => p !== "unknown"))];

    return {
      date: formatLocalDate(startTs),
      stateTotals, agentTotals, projectTotals, projectFullPaths,
      eventCounts, toolHintCounts, editorCounts, hourly,
      activeTime, totalTime,
      sessionCount: sessions.length,
      errorCount: events.filter(e => e.state === "error").length,
      totalEvents: events.length, sessions,
      availableAgents, availableProjects,
    };
  }

  // ── Computed insights (no AI needed) ──
  function computeInsights(todayData, weekData) {
    const insights = [];

    // 1. Peak productive hour
    if (todayData.hourly) {
      let peakHour = -1, peakMs = 0;
      todayData.hourly.forEach((h, i) => {
        const active = Object.entries(h).filter(([s]) => ACTIVE_STATES.has(s)).reduce((sum, [, ms]) => sum + ms, 0);
        if (active > peakMs) { peakMs = active; peakHour = i; }
      });
      if (peakHour >= 0 && peakMs > 0) {
        insights.push({ icon: "peak", label: "Peak Hour", value: `${peakHour}:00`, detail: `${fmtDur(peakMs)} active` });
      }
    }

    // 2. Focus blocks (continuous working ≥5min without switching projects)
    if (todayData.sessions) {
      let focusBlocks = 0;
      let longestFocus = 0;
      for (const sess of todayData.sessions) {
        if (sess.totalActive >= 5 * 60 * 1000) { // ≥5min active
          focusBlocks++;
          longestFocus = Math.max(longestFocus, sess.totalActive);
        }
      }
      insights.push({ icon: "focus", label: "Focus Blocks", value: `${focusBlocks}`, detail: longestFocus > 0 ? `longest: ${fmtDur(longestFocus)}` : "none today" });
    }

    // 3. Context switches (number of distinct project transitions)
    let contextSwitches = 0;
    if (todayData.sessions && todayData.sessions.length > 1) {
      const sorted = [...todayData.sessions].sort((a, b) => a.firstTs - b.firstTs);
      for (let i = 1; i < sorted.length; i++) {
        if (sorted[i].project !== sorted[i - 1].project) contextSwitches++;
      }
    }
    insights.push({ icon: "switch", label: "Context Switches", value: `${contextSwitches}`, detail: contextSwitches > 5 ? "high fragmentation" : contextSwitches > 2 ? "moderate" : "focused" });

    // 4. Productivity score (active% × error-penalty × focus-bonus)
    if (todayData.totalTime > 0) {
      const activePct = todayData.activeTime / todayData.totalTime;
      const errorPenalty = Math.max(0, 1 - (todayData.errorCount * 0.05));
      const focusBonus = contextSwitches <= 2 ? 1.1 : contextSwitches <= 5 ? 1.0 : 0.9;
      const score = Math.min(100, Math.round(activePct * errorPenalty * focusBonus * 100));
      insights.push({ icon: "score", label: "Productivity", value: `${score}%`, detail: score >= 80 ? "excellent" : score >= 60 ? "good" : score >= 40 ? "moderate" : "low activity" });
    }

    // 5. Error rate
    if (todayData.totalEvents > 0) {
      const rate = ((todayData.errorCount / todayData.totalEvents) * 100).toFixed(1);
      insights.push({ icon: "error", label: "Error Rate", value: `${rate}%`, detail: `${todayData.errorCount} of ${todayData.totalEvents} events` });
    }

    // 6. Week trend
    if (weekData && weekData.days && weekData.days.length >= 2) {
      const today = weekData.days[weekData.days.length - 1];
      const yesterday = weekData.days[weekData.days.length - 2];
      if (yesterday.activeTime > 0) {
        const change = ((today.activeTime - yesterday.activeTime) / yesterday.activeTime * 100).toFixed(0);
        const dir = Number(change) >= 0 ? "+" : "";
        insights.push({ icon: "trend", label: "vs Yesterday", value: `${dir}${change}%`, detail: `${fmtDur(today.activeTime)} vs ${fmtDur(yesterday.activeTime)}` });
      }
    }

    return insights;
  }

  function fmtDur(ms) {
    if (!ms || ms <= 0) return "0s";
    if (ms < 60000) return Math.round(ms / 1000) + "s";
    if (ms < 3600000) return Math.round(ms / 60000) + "m";
    return (ms / 3600000).toFixed(1) + "h";
  }

  function aggregateWeek(filters) {
    const now = new Date();
    const days = [];

    for (let i = 6; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      const startOfDay = d.getTime();
      const endOfDay = startOfDay + 24 * 60 * 60 * 1000;
      const dayData = aggregateRange(startOfDay, endOfDay, now, filters);
      dayData.dayLabel = d.toLocaleDateString("en", { weekday: "short" });
      days.push(dayData);
    }

    const weekProjectTotals = {};
    const weekAgentTotals = {};
    const weekEventCounts = {};
    const weekToolHintCounts = {};
    let weekActiveTime = 0, weekTotalTime = 0, weekSessions = 0, weekErrors = 0, weekTotalEvents = 0;

    for (const d of days) {
      weekActiveTime += d.activeTime;
      weekTotalTime += d.totalTime;
      weekSessions += d.sessionCount;
      weekErrors += d.errorCount;
      weekTotalEvents += d.totalEvents;
      for (const [k, v] of Object.entries(d.projectTotals)) weekProjectTotals[k] = (weekProjectTotals[k] || 0) + v;
      for (const [k, v] of Object.entries(d.agentTotals)) weekAgentTotals[k] = (weekAgentTotals[k] || 0) + v;
      for (const [k, v] of Object.entries(d.eventCounts)) weekEventCounts[k] = (weekEventCounts[k] || 0) + v;
      for (const [k, v] of Object.entries(d.toolHintCounts)) weekToolHintCounts[k] = (weekToolHintCounts[k] || 0) + v;
    }

    return {
      days, weekProjectTotals, weekAgentTotals, weekEventCounts, weekToolHintCounts,
      weekActiveTime, weekTotalTime, weekSessions, weekErrors, weekTotalEvents,
    };
  }

  return { loadEvents, aggregateToday, aggregateWeek, computeInsights, STATE_COLORS, AGENT_COLORS };
};
