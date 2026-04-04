// Gemini CLI session JSON monitor
// Polls ~/.gemini/tmp/*/chats/session-*.json for state changes
// Zero dependencies (node built-ins only)

const fs = require("fs");
const path = require("path");
const os = require("os");

class GeminiLogMonitor {
  /**
   * @param {object} agentConfig - gemini-cli.js config (logConfig)
   * @param {function} onStateChange - (sessionId, state, event, extra) => void
   */
  constructor(agentConfig, onStateChange) {
    this._config = agentConfig;
    this._onStateChange = onStateChange;
    this._interval = null;
    // Map<filePath, { mtime, sessionId, lastState, lastEventTime, msgCount, cwd }>
    this._tracked = new Map();
    this._baseDir = this._resolveBaseDir();
    this._cwdMap = null; // projectDir → cwd reverse mapping
    this._projectsMtime = 0; // mtime of projects.json for cache invalidation
  }

  _resolveBaseDir() {
    const dir = this._config.logConfig.sessionDir;
    if (dir.startsWith("~")) {
      return path.join(os.homedir(), dir.slice(1));
    }
    return dir;
  }

  start() {
    if (this._interval) return;
    this._poll();
    this._interval = setInterval(
      () => this._poll(),
      this._config.logConfig.pollIntervalMs || 1500
    );
  }

  stop() {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
    this._tracked.clear();
  }

  _loadCwdMap() {
    const projectsPath = path.join(os.homedir(), ".gemini", "projects.json");
    let mtime;
    try {
      mtime = fs.statSync(projectsPath).mtimeMs;
    } catch {
      return; // projects.json doesn't exist
    }
    // Only reload if changed
    if (this._cwdMap && mtime === this._projectsMtime) return;
    this._projectsMtime = mtime;
    try {
      const data = JSON.parse(fs.readFileSync(projectsPath, "utf8"));
      if (data && data.projects) {
        // Invert: { physicalPath: dirName } → { dirName: physicalPath }
        this._cwdMap = {};
        for (const [physPath, dirName] of Object.entries(data.projects)) {
          this._cwdMap[dirName] = physPath;
        }
      }
    } catch {
      // corrupted file, keep old map
    }
  }

  _poll() {
    this._loadCwdMap();

    // List project directories under baseDir
    let projectDirs;
    try {
      projectDirs = fs.readdirSync(this._baseDir, { withFileTypes: true });
    } catch {
      return; // ~/.gemini/tmp doesn't exist yet
    }

    const now = Date.now();
    for (const entry of projectDirs) {
      if (!entry.isDirectory()) continue;
      const projectDir = entry.name;
      const chatsDir = path.join(this._baseDir, projectDir, "chats");

      let files;
      try {
        files = fs.readdirSync(chatsDir);
      } catch {
        continue; // no chats dir
      }

      for (const file of files) {
        if (!file.startsWith("session-") || !file.endsWith(".json")) continue;
        const filePath = path.join(chatsDir, file);

        // Skip files we're not already tracking if they're old
        if (!this._tracked.has(filePath)) {
          try {
            const mtime = fs.statSync(filePath).mtimeMs;
            if (now - mtime > 120000) continue; // older than 2 min — skip
          } catch {
            continue;
          }
        }

        this._pollFile(filePath, projectDir);
      }
    }

    this._cleanStale();
  }

  _pollFile(filePath, projectDir) {
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return;
    }

    const tracked = this._tracked.get(filePath);
    // mtime unchanged → skip
    if (tracked && stat.mtimeMs === tracked.mtime) return;

    // Read and parse session JSON
    let data;
    try {
      data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
      return; // half-written or corrupted, retry next poll
    }

    this._processSession(filePath, data, projectDir, stat.mtimeMs);
  }

  _processSession(filePath, data, projectDir, mtime) {
    const msgs = data.messages;
    if (!msgs || !msgs.length) return;
    const last = msgs[msgs.length - 1];

    let state, event;
    if (last.type === "user") {
      state = "thinking";
      event = "UserPromptSubmit";
    } else if (last.type === "gemini") {
      const tools = last.toolCalls;
      if (tools && tools.length) {
        const lastTool = tools[tools.length - 1];
        if (lastTool.status === "error") {
          state = "error";
          event = "PostToolUseFailure";
        } else {
          state = "attention";
          event = "Stop";
        }
      } else {
        state = "attention";
        event = "Stop";
      }
    } else {
      return; // unknown type
    }

    // Dedup: same state + same message count → skip
    const tracked = this._tracked.get(filePath);
    if (tracked && tracked.lastState === state && tracked.msgCount === msgs.length) {
      // Still update mtime so stale cleanup doesn't fire prematurely
      tracked.mtime = mtime;
      tracked.lastEventTime = Date.now();
      return;
    }

    const sessionId = "gemini:" + (data.sessionId || path.basename(filePath, ".json"));
    const cwd = (this._cwdMap && this._cwdMap[projectDir]) || "";

    // Update tracking
    this._tracked.set(filePath, {
      mtime,
      sessionId,
      lastState: state,
      lastEventTime: Date.now(),
      msgCount: msgs.length,
      cwd,
    });

    this._onStateChange(sessionId, state, event, {
      cwd,
      sourcePid: null,
      agentPid: null,
    });
  }

  _cleanStale() {
    const now = Date.now();
    for (const [filePath, tracked] of this._tracked) {
      if (now - tracked.lastEventTime > 300000) {
        // 5 min no update → SessionEnd
        this._onStateChange(tracked.sessionId, "sleeping", "SessionEnd", {
          cwd: tracked.cwd,
          sourcePid: null,
          agentPid: null,
        });
        this._tracked.delete(filePath);
      }
    }
  }
}

module.exports = GeminiLogMonitor;
