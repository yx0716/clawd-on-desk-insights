// src/analytics-log.js — Persist session state transitions to JSONL for analytics
// Hooks into state.js updateSession() via ctx.logAnalyticsEvent callback
//
// Record fields:
//   ts      - timestamp (ms)
//   sid     - session ID
//   prev    - previous state
//   state   - new state
//   event   - hook event name (PreToolUse, PostToolUse, Stop, etc.)
//   agent   - agent ID (claude-code, codex, cursor-agent, etc.)
//   cwd     - working directory (project path)
//   editor  - editor type (code, cursor, null)
//   hint    - display_svg hint (tool type indicator)
//   dur     - duration in previous state (ms)

const fs = require("fs");
const path = require("path");
const { rotatedAppend } = require("./log-rotate");

const MAX_LOG_BYTES = 5 * 1024 * 1024; // 5 MB

module.exports = function initAnalyticsLog(ctx) {
  const logPath = ctx.analyticsPath; // ~/.clawd/analytics.jsonl

  // Track per-session last event time for duration calculation
  const sessionTimestamps = new Map();
  let dirChecked = false;

  function logEvent(sessionId, prevState, newState, event, agentId, cwd, editor, displaySvg) {
    const now = Date.now();
    const sid = sessionId || "default";

    // Calculate duration in previous state
    const lastTs = sessionTimestamps.get(sid);
    const dur = lastTs ? now - lastTs : 0;
    sessionTimestamps.set(sid, now);

    // Extract tool hint from display_svg (e.g. "clawd-working-building.svg" → "building")
    let hint = null;
    if (displaySvg && typeof displaySvg === "string") {
      const m = displaySvg.match(/clawd-working-(\w+)\.svg/);
      if (m) hint = m[1]; // typing, building, debugging, sweeping, etc.
    }

    const record = {
      ts: now,
      sid,
      prev: prevState || null,
      state: newState,
      event: event || null,
      agent: agentId || null,
      cwd: cwd || null,
    };
    // Only include optional fields if present (keep JSONL compact)
    if (editor) record.editor = editor;
    if (hint) record.hint = hint;
    if (dur > 0) record.dur = dur;

    try {
      if (!dirChecked) {
        const dir = path.dirname(logPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        dirChecked = true;
      }
      rotatedAppend(logPath, JSON.stringify(record) + "\n", MAX_LOG_BYTES);
    } catch (err) {
      console.warn("Clawd analytics: failed to write log:", err.message);
    }
  }

  function cleanup() {
    sessionTimestamps.clear();
  }

  return { logEvent, cleanup };
};
