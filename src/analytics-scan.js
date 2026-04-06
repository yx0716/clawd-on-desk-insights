// src/analytics-scan.js — Scan local agent conversation files for analytics
// Reads conversation history from Claude Code, Codex, and Cursor local storage.
// No AI needed — pure file scanning and aggregation.
//
// Data sources:
//   ~/.claude/projects/<project>/<uuid>.jsonl   — Claude Code conversations
//   ~/.codex/sessions/<YYYY>/<MM>/<DD>/*.jsonl  — Codex CLI sessions
//   ~/.cursor/projects/<project>/agent-transcripts/<uuid>/<uuid>.jsonl — Cursor Agent

const fs = require("fs");
const path = require("path");
const os = require("os");

module.exports = function initAnalyticsScan(ctx) {
  const home = os.homedir();
  const CLAUDE_PROJECTS = path.join(home, ".claude", "projects");
  const CODEX_SESSIONS = path.join(home, ".codex", "sessions");
  const CURSOR_PROJECTS = path.join(home, ".cursor", "projects");

  // Cache scan results (expensive I/O)
  let cache = null;
  let cacheExpiry = 0;
  const CACHE_TTL = 60 * 1000; // 1 minute

  // ── Helpers ──

  function projectFromDirName(dirName) {
    // "-Users-jyx-Documents-1-explore" → "1-explore"
    const parts = dirName.replace(/^-/, "").split("-").filter(Boolean);
    // Take last meaningful segment(s)
    if (parts.length >= 2) return parts.slice(-2).join("-");
    return parts[parts.length - 1] || dirName;
  }

  function cwdFromDirName(dirName) {
    // "-Users-jyx-Documents-1-explore" → "/Users/jyx/Documents/1-explore"
    return dirName.replace(/^-/, "/").replace(/-/g, "/");
  }

  function dateStr(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  function isInDateRange(ts, startTs, endTs) {
    return ts >= startTs && ts <= endTs;
  }

  const HIDDEN_PROJECT_TOKENS = new Set([
    "on-desk",
    "clawd-on-desk",
    "clawd-on-desk-insights",
  ]);

  function normalizeProjectToken(value) {
    if (!value) return "";
    const normalized = String(value).trim().toLowerCase().replace(/\\/g, "/");
    const parts = normalized.split("/").filter(Boolean);
    return parts[parts.length - 1] || normalized;
  }

  function shouldHideSession(session) {
    const candidates = [
      session.project,
      session.title,
      session.cwd,
      session.fullPath,
    ];
    return candidates.some(value => HIDDEN_PROJECT_TOKENS.has(normalizeProjectToken(value)));
  }

  const GAP_THRESHOLD = 30 * 60 * 1000; // 30 minutes — split blocks at this gap

  function splitIntoBlocks(timestamps) {
    if (!timestamps.length) return [];
    const sorted = [...timestamps].sort((a, b) => a - b);
    const blocks = [];
    let blockStart = sorted[0];
    let blockEnd = sorted[0];
    let msgCount = 1;
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i] - blockEnd > GAP_THRESHOLD) {
        blocks.push({ start: blockStart, end: blockEnd, msgs: msgCount });
        blockStart = sorted[i];
        blockEnd = sorted[i];
        msgCount = 1;
      } else {
        blockEnd = sorted[i];
        msgCount++;
      }
    }
    blocks.push({ start: blockStart, end: blockEnd, msgs: msgCount });
    return blocks;
  }

  // ── Claude Code Scanner ──

  function scanClaudeProject(projectDir, projectName, startTs, endTs) {
    const sessions = [];
    let files;
    try { files = fs.readdirSync(projectDir); } catch { return sessions; }

    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const filePath = path.join(projectDir, file);

      let stat;
      try { stat = fs.statSync(filePath); } catch { continue; }

      // Quick filter: skip files not modified in our date range (with 1-day buffer)
      const mtimeMs = stat.mtimeMs;
      if (mtimeMs < startTs - 86400000) continue;

      const sessionId = file.replace(".jsonl", "");
      const sess = {
        id: sessionId, agent: "claude-code", project: projectName,
        fullPath: cwdFromDirName(path.basename(projectDir)),
        title: null, cwd: null, messages: 0, toolCalls: {},
        firstTs: null, lastTs: null, turns: 0, blocks: [], firstUserMsg: null,
      };
      const allTimestamps = [];

      try {
        const content = fs.readFileSync(filePath, "utf8");
        const lines = content.split("\n").filter(Boolean);
        for (const line of lines) {
          let d;
          try { d = JSON.parse(line); } catch { continue; }

          // Timestamps
          const ts = d.timestamp ? new Date(d.timestamp).getTime() : null;
          if (ts) {
            allTimestamps.push(ts);
            if (!sess.firstTs || ts < sess.firstTs) sess.firstTs = ts;
            if (!sess.lastTs || ts > sess.lastTs) sess.lastTs = ts;
          }

          if (d.type === "custom-title" && d.customTitle) sess.title = d.customTitle;
          if (d.cwd && !sess.cwd) sess.cwd = d.cwd;

          if (d.type === "user") {
            sess.messages++; sess.turns++;
            if (!sess.firstUserMsg) {
              const msg = d.message || {};
              let text = "";
              if (typeof msg.content === "string") text = msg.content;
              else if (Array.isArray(msg.content)) {
                for (const c of msg.content) { if (c && c.type === "text" && c.text) { text = c.text; break; } }
              }
              if (text) sess.firstUserMsg = text.trim().slice(0, 80);
            }
          }
          if (d.type === "assistant") {
            sess.messages++;
            const msg = d.message || {};
            const content = msg.content;
            if (Array.isArray(content)) {
              for (const c of content) {
                if (c && c.type === "tool_use" && c.name) {
                  sess.toolCalls[c.name] = (sess.toolCalls[c.name] || 0) + 1;
                }
              }
            }
          }
        }
      } catch { continue; }

      // Build active blocks from timestamps
      sess.blocks = splitIntoBlocks(allTimestamps);

      // Filter
      if (sess.messages < 6) continue;
      if (sess.lastTs && sess.lastTs < startTs) continue;
      if (sess.firstTs && sess.firstTs > endTs) continue;

      sessions.push(sess);
    }
    return sessions;
  }

  function scanAllClaude(startTs, endTs) {
    const sessions = [];
    let dirs;
    try { dirs = fs.readdirSync(CLAUDE_PROJECTS); } catch { return sessions; }
    for (const dir of dirs) {
      const full = path.join(CLAUDE_PROJECTS, dir);
      let stat;
      try { stat = fs.statSync(full); } catch { continue; }
      if (!stat.isDirectory()) continue;
      const projName = projectFromDirName(dir);
      sessions.push(...scanClaudeProject(full, projName, startTs, endTs));
    }
    return sessions;
  }

  // ── Codex Scanner ──

  function scanCodex(startTs, endTs) {
    const sessions = [];
    const startDate = new Date(startTs);
    const endDate = new Date(endTs);

    // Iterate over date range (YYYY/MM/DD directory structure)
    for (let d = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate());
         d.getTime() <= endTs;
         d.setDate(d.getDate() + 1)) {
      const yearDir = path.join(CODEX_SESSIONS, String(d.getFullYear()),
        String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0"));
      let files;
      try { files = fs.readdirSync(yearDir); } catch { continue; }

      for (const file of files) {
        if (!file.endsWith(".jsonl")) continue;
        const filePath = path.join(yearDir, file);

        const sess = {
          id: file.replace(".jsonl", ""), agent: "codex", project: null,
          fullPath: null, title: null, cwd: null,
          messages: 0, toolCalls: {}, firstTs: null, lastTs: null, turns: 0, blocks: [], firstUserMsg: null,
        };
        const allTimestamps = [];

        try {
          const content = fs.readFileSync(filePath, "utf8");
          const lines = content.split("\n").filter(Boolean);
          for (const line of lines) {
            let rec;
            try { rec = JSON.parse(line); } catch { continue; }

            if (rec.type === "session_meta") {
              const p = rec.payload || {};
              sess.cwd = p.cwd || null;
              sess.fullPath = p.cwd || null;
              if (p.cwd) {
                const parts = p.cwd.replace(/\\/g, "/").split("/").filter(Boolean);
                sess.project = parts[parts.length - 1] || "unknown";
              }
              const ts = p.timestamp ? new Date(p.timestamp).getTime() : null;
              if (ts) sess.firstTs = ts;
            }

            if (rec.type === "response_item") {
              const p = rec.payload || {};
              const ts = rec.timestamp ? new Date(rec.timestamp).getTime() : null;
              if (ts) {
                allTimestamps.push(ts);
                if (!sess.firstTs || ts < sess.firstTs) sess.firstTs = ts;
                if (!sess.lastTs || ts > sess.lastTs) sess.lastTs = ts;
              }
              if (p.type === "function_call" && p.name) {
                sess.toolCalls[p.name] = (sess.toolCalls[p.name] || 0) + 1;
              }
              if (p.type === "message") {
                if (p.role === "user") {
                  sess.messages++; sess.turns++;
                  if (!sess.firstUserMsg && Array.isArray(p.content)) {
                    for (const c of p.content) { if (c && c.type === "input_text" && c.text) { sess.firstUserMsg = c.text.trim().slice(0, 80); break; } }
                  }
                }
                if (p.role === "assistant") sess.messages++;
              }
            }
          }
        } catch { continue; }

        // Use file mtime as lastTs fallback
        if (!sess.lastTs) {
          try { sess.lastTs = fs.statSync(filePath).mtimeMs; } catch {}
        }

        sess.blocks = splitIntoBlocks(allTimestamps);

        if (sess.messages < 6) continue;
        if (sess.lastTs && sess.lastTs < startTs) continue;
        if (sess.firstTs && sess.firstTs > endTs) continue;

        sessions.push(sess);
      }
    }
    return sessions;
  }

  // ── Cursor Scanner ──

  function scanCursor(startTs, endTs) {
    const sessions = [];
    let dirs;
    try { dirs = fs.readdirSync(CURSOR_PROJECTS); } catch { return sessions; }

    for (const dir of dirs) {
      const transcriptsDir = path.join(CURSOR_PROJECTS, dir, "agent-transcripts");
      let transcriptDirs;
      try { transcriptDirs = fs.readdirSync(transcriptsDir); } catch { continue; }

      const projName = projectFromDirName(dir);

      for (const tid of transcriptDirs) {
        const jsonlFile = path.join(transcriptsDir, tid, tid + ".jsonl");
        let stat;
        try { stat = fs.statSync(jsonlFile); } catch { continue; }

        // Quick filter by mtime
        if (stat.mtimeMs < startTs - 86400000) continue;

        const sess = {
          id: tid, agent: "cursor-agent", project: projName,
          fullPath: cwdFromDirName(dir), title: null, cwd: cwdFromDirName(dir),
          messages: 0, toolCalls: {}, firstTs: null, lastTs: stat.mtimeMs, turns: 0, blocks: [], firstUserMsg: null,
        };

        try {
          const content = fs.readFileSync(jsonlFile, "utf8");
          const lines = content.split("\n").filter(Boolean);
          for (const line of lines) {
            let rec;
            try { rec = JSON.parse(line); } catch { continue; }

            const role = rec.role;
            if (role === "user") {
              sess.messages++; sess.turns++;
              if (!sess.firstUserMsg) {
                const msg = rec.message || {};
                let text = typeof msg.content === "string" ? msg.content : "";
                if (!text && Array.isArray(msg.content)) { for (const c of msg.content) { if (c && c.type === "text" && c.text) { text = c.text; break; } } }
                if (text) sess.firstUserMsg = text.trim().slice(0, 80);
              }
            }
            if (role === "assistant") {
              sess.messages++;
              const msg = rec.message || {};
              const msgContent = msg.content;
              if (Array.isArray(msgContent)) {
                for (const c of msgContent) {
                  if (c && c.type === "tool_use" && c.name) {
                    sess.toolCalls[c.name] = (sess.toolCalls[c.name] || 0) + 1;
                  }
                }
              }
            }
          }
        } catch { continue; }

        // Cursor transcripts don't have timestamps per message — use file mtime
        if (!sess.firstTs) sess.firstTs = stat.birthtimeMs || stat.mtimeMs;

        // Single block spanning the whole session (no per-message timestamps)
        if (sess.firstTs && sess.lastTs) {
          sess.blocks = [{ start: sess.firstTs, end: sess.lastTs, msgs: sess.messages }];
        }

        if (sess.messages < 6) continue;
        if (sess.lastTs < startTs) continue;
        if (sess.firstTs > endTs) continue;

        sessions.push(sess);
      }
    }
    return sessions;
  }

  // ── Main API ──

  function scanRange(startTs, endTs) {
    // Return cached if fresh
    const cacheKey = `${startTs}-${endTs}`;
    if (cache && cache.key === cacheKey && Date.now() < cacheExpiry) return cache.data;

    const allSessions = [
      ...scanAllClaude(startTs, endTs),
      ...scanCodex(startTs, endTs),
      ...scanCursor(startTs, endTs),
    ];
    const visibleSessions = allSessions.filter(session => !shouldHideSession(session));

    // Aggregate
    const agentTotals = {};      // agent → session count
    const agentMessages = {};    // agent → message count
    const projectTotals = {};    // project → session count
    const projectMessages = {};  // project → message count
    const projectFullPaths = {}; // project → full cwd path
    const toolTotals = {};       // tool → usage count
    const dailySessions = {};    // date → count
    let totalMessages = 0;
    let totalTurns = 0;
    let totalToolCalls = 0;

    for (const s of visibleSessions) {
      const agent = s.agent || "unknown";
      const project = s.project || "unknown";

      agentTotals[agent] = (agentTotals[agent] || 0) + 1;
      agentMessages[agent] = (agentMessages[agent] || 0) + s.messages;
      projectTotals[project] = (projectTotals[project] || 0) + 1;
      projectMessages[project] = (projectMessages[project] || 0) + s.messages;
      if (s.fullPath || s.cwd) projectFullPaths[project] = s.fullPath || s.cwd;

      totalMessages += s.messages;
      totalTurns += s.turns;

      for (const [tool, count] of Object.entries(s.toolCalls)) {
        toolTotals[tool] = (toolTotals[tool] || 0) + count;
        totalToolCalls += count;
      }

      // Daily distribution
      if (s.firstTs) {
        const day = dateStr(new Date(s.firstTs));
        dailySessions[day] = (dailySessions[day] || 0) + 1;
      }
    }

    const data = {
      sessions: visibleSessions.sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0)),
      sessionCount: visibleSessions.length,
      totalMessages, totalTurns, totalToolCalls,
      agentTotals, agentMessages,
      projectTotals, projectMessages, projectFullPaths,
      toolTotals, dailySessions,
    };

    cache = { key: cacheKey, data };
    cacheExpiry = Date.now() + CACHE_TTL;
    return data;
  }

  function scanToday() {
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const endOfDay = startOfDay + 24 * 60 * 60 * 1000;
    return scanRange(startOfDay, endOfDay);
  }

  function scan3Days() {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 2).getTime();
    const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() + 86400000;
    return scanRange(start, endOfDay);
  }

  function scanWeek() {
    const now = new Date();
    const startOfWeek = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6).getTime();
    const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() + 86400000;
    return scanRange(startOfWeek, endOfDay);
  }

  // ── Session Detail (for AI analysis) ──

  function findSessionFile(sessionId, agent) {
    if (agent === "claude-code") {
      // Search all project dirs for sessionId.jsonl
      let dirs;
      try { dirs = fs.readdirSync(CLAUDE_PROJECTS); } catch { return null; }
      for (const dir of dirs) {
        const filePath = path.join(CLAUDE_PROJECTS, dir, sessionId + ".jsonl");
        try { fs.accessSync(filePath); return filePath; } catch { /* next */ }
      }
    } else if (agent === "codex") {
      // Search date-structured dirs
      const now = new Date();
      for (let dayOffset = 0; dayOffset < 30; dayOffset++) {
        const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dayOffset);
        const yearDir = path.join(CODEX_SESSIONS, String(d.getFullYear()),
          String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0"));
        const filePath = path.join(yearDir, sessionId + ".jsonl");
        try { fs.accessSync(filePath); return filePath; } catch { /* next */ }
      }
    } else if (agent === "cursor-agent") {
      // Search project dirs for transcript
      let dirs;
      try { dirs = fs.readdirSync(CURSOR_PROJECTS); } catch { return null; }
      for (const dir of dirs) {
        const filePath = path.join(CURSOR_PROJECTS, dir, "agent-transcripts", sessionId, sessionId + ".jsonl");
        try { fs.accessSync(filePath); return filePath; } catch { /* next */ }
      }
    }
    return null;
  }

  function getSessionDetail(sessionId, agent) {
    const filePath = findSessionFile(sessionId, agent);
    if (!filePath) return null;

    const detail = {
      sessionId, agent,
      userMessages: [],    // { ts, text (first 200 chars) }
      toolCalls: [],       // { ts, name, inputSnippet }
      timestamps: [],      // all message timestamps
      title: null,
      cwd: null,
    };

    try {
      const content = fs.readFileSync(filePath, "utf8");
      const lines = content.split("\n").filter(Boolean);

      for (const line of lines) {
        let d;
        try { d = JSON.parse(line); } catch { continue; }

        if (agent === "claude-code") {
          const ts = d.timestamp ? new Date(d.timestamp).getTime() : null;
          if (ts) detail.timestamps.push(ts);
          if (d.type === "custom-title" && d.customTitle) detail.title = d.customTitle;
          if (d.cwd && !detail.cwd) detail.cwd = d.cwd;

          if (d.type === "user") {
            const msg = d.message || {};
            let text = "";
            if (typeof msg.content === "string") text = msg.content;
            else if (Array.isArray(msg.content)) {
              for (const c of msg.content) {
                if (c && c.type === "text" && c.text) text += c.text + " ";
              }
            }
            detail.userMessages.push({ ts, text: text.trim().slice(0, 200) });
          }

          if (d.type === "assistant") {
            const msg = d.message || {};
            if (Array.isArray(msg.content)) {
              for (const c of msg.content) {
                if (c && c.type === "tool_use" && c.name) {
                  let inputSnippet = "";
                  if (c.input) {
                    const s = JSON.stringify(c.input);
                    inputSnippet = s.slice(0, 100);
                  }
                  detail.toolCalls.push({ ts, name: c.name, inputSnippet });
                }
              }
            }
          }
        } else if (agent === "codex") {
          const ts = d.timestamp ? new Date(d.timestamp).getTime() : null;
          if (ts) detail.timestamps.push(ts);
          const p = d.payload || {};
          if (d.type === "session_meta") {
            detail.cwd = p.cwd || null;
          }
          if (d.type === "response_item") {
            if (p.type === "message" && p.role === "user") {
              let text = "";
              if (Array.isArray(p.content)) {
                for (const c of p.content) {
                  if (c && c.type === "input_text" && c.text) text += c.text + " ";
                }
              }
              detail.userMessages.push({ ts, text: text.trim().slice(0, 200) });
            }
            if (p.type === "function_call" && p.name) {
              detail.toolCalls.push({ ts, name: p.name, inputSnippet: (p.arguments || "").slice(0, 100) });
            }
          }
        } else if (agent === "cursor-agent") {
          if (d.role === "user") {
            let text = "";
            const msg = d.message || {};
            if (typeof msg.content === "string") text = msg.content;
            else if (Array.isArray(msg.content)) {
              for (const c of msg.content) {
                if (c && c.type === "text" && c.text) text += c.text + " ";
              }
            }
            detail.userMessages.push({ ts: null, text: text.trim().slice(0, 200) });
          }
          if (d.role === "assistant") {
            const msg = d.message || {};
            if (Array.isArray(msg.content)) {
              for (const c of msg.content) {
                if (c && c.type === "tool_use" && c.name) {
                  detail.toolCalls.push({ ts: null, name: c.name, inputSnippet: "" });
                }
              }
            }
          }
        }
      }
    } catch { return null; }

    return detail;
  }

  return { scanRange, scanToday, scan3Days, scanWeek, getSessionDetail };
};
