// src/analytics-titles.js — Local session title overrides
//
// Claude Desktop (the GUI app at /Applications/Claude.app) lets users rename
// sessions, but those renames do NOT get written back to the jsonl files in
// ~/.claude/projects/. They live on Anthropic's server and are fetched on
// demand. That means clawd's analytics scanner has no way to discover them.
//
// This module provides a parallel, local-only rename store. Users click the
// pencil icon on a session card in the dashboard, type a new title, and it
// gets persisted to ~/.clawd/session-titles.json. The analytics IPC handler
// overlays these titles onto scan results as `session.localTitle`, and the
// renderer resolves the final display title via the priority chain:
//
//   localTitle > jsonl custom-title > firstUserMsg (truncated) > project
//
// Storage shape:
//   { "<sessionId>": "<user-chosen title>", ... }
//
// No versioning, no frontmatter — keeping it dead simple because the data is
// trivial and the recovery path is "just retype it" if the file is ever lost.

const fs = require("fs");
const path = require("path");
const os = require("os");

module.exports = function initAnalyticsTitles(ctx = {}) {
  const titlesPath = ctx.titlesPath || path.join(os.homedir(), ".clawd", "session-titles.json");

  // In-memory cache — loaded lazily on first access, invalidated on every write.
  // The file is tiny (one string per renamed session) so no TTL needed.
  let cache = null;

  function ensureDir() {
    try { fs.mkdirSync(path.dirname(titlesPath), { recursive: true }); } catch { /* ignore */ }
  }

  function load() {
    if (cache) return cache;
    try {
      const raw = fs.readFileSync(titlesPath, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        cache = parsed;
        return cache;
      }
    } catch { /* missing or corrupt — fall through */ }
    cache = {};
    return cache;
  }

  // Atomic write: temp file + rename. Prevents a partial write from corrupting
  // the store if the process is killed mid-save.
  function persist(data) {
    ensureDir();
    const tmpPath = titlesPath + ".tmp";
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
      fs.renameSync(tmpPath, titlesPath);
      cache = data;
      return true;
    } catch (err) {
      console.warn("Clawd analytics-titles: failed to persist:", err.message);
      // Best-effort cleanup
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      return false;
    }
  }

  function getTitle(sessionId) {
    if (!sessionId) return null;
    const data = load();
    return data[sessionId] || null;
  }

  function getAll() {
    // Return a shallow copy so callers can't mutate the cache
    return { ...load() };
  }

  function setTitle(sessionId, title) {
    if (!sessionId) return false;
    const data = { ...load() };
    const trimmed = typeof title === "string" ? title.trim() : "";
    if (!trimmed) {
      // Empty title = clear the override (fall back down the priority chain)
      delete data[sessionId];
    } else {
      // Cap at a sensible length — these are card titles, not descriptions
      data[sessionId] = trimmed.slice(0, 200);
    }
    return persist(data);
  }

  function clearTitle(sessionId) {
    if (!sessionId) return false;
    const data = { ...load() };
    if (!(sessionId in data)) return true; // nothing to clear
    delete data[sessionId];
    return persist(data);
  }

  return { getTitle, getAll, setTitle, clearTitle };
};
