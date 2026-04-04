const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const GeminiLogMonitor = require("../agents/gemini-log-monitor");
const geminiConfig = require("../agents/gemini-cli");

// Helper: create temp dir mimicking ~/.gemini/tmp/{projectDir}/chats/
function makeTempGeminiDir(projectDir = "animation") {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-test-"));
  const chatsDir = path.join(tmpDir, projectDir, "chats");
  fs.mkdirSync(chatsDir, { recursive: true });
  return { tmpDir, chatsDir, projectDir };
}

// Helper: create a config pointing to our temp dir
function makeConfig(tmpDir) {
  return {
    ...geminiConfig,
    logConfig: { ...geminiConfig.logConfig, sessionDir: tmpDir, pollIntervalMs: 100 },
  };
}

// Helper: build a session JSON file
function makeSessionJson(messages, sessionId = "test-session-id") {
  return JSON.stringify({
    sessionId,
    projectHash: "abc123",
    startTime: new Date().toISOString(),
    lastUpdated: new Date().toISOString(),
    messages,
    kind: "main",
  });
}

const SESSION_FILE = "session-2026-04-04T08-00-00-abcd1234.json";

describe("GeminiLogMonitor", () => {
  let tmpDir, chatsDir, projectDir, monitor;

  beforeEach(() => {
    const dirs = makeTempGeminiDir();
    tmpDir = dirs.tmpDir;
    chatsDir = dirs.chatsDir;
    projectDir = dirs.projectDir;
  });

  afterEach(() => {
    if (monitor) monitor.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should detect user message as thinking", (_, done) => {
    const filePath = path.join(chatsDir, SESSION_FILE);
    fs.writeFileSync(filePath, makeSessionJson([
      { type: "user", content: [{ text: "hello" }] },
    ]));

    const config = makeConfig(tmpDir);
    monitor = new GeminiLogMonitor(config, (sid, state, event) => {
      assert.strictEqual(sid, "gemini:test-session-id");
      assert.strictEqual(state, "thinking");
      assert.strictEqual(event, "UserPromptSubmit");
      done();
    });
    monitor.start();
  });

  it("should detect gemini reply as attention", (_, done) => {
    const filePath = path.join(chatsDir, SESSION_FILE);
    fs.writeFileSync(filePath, makeSessionJson([
      { type: "user", content: [{ text: "hello" }] },
      { type: "gemini", content: "Hi there!", tokens: { input: 10, output: 5 } },
    ]));

    const config = makeConfig(tmpDir);
    const states = [];
    monitor = new GeminiLogMonitor(config, (sid, state, event) => {
      states.push({ state, event });
      if (state === "attention") {
        assert.strictEqual(event, "Stop");
        done();
      }
    });
    monitor.start();
  });

  it("should detect tool error as error state", (_, done) => {
    const filePath = path.join(chatsDir, SESSION_FILE);
    fs.writeFileSync(filePath, makeSessionJson([
      { type: "user", content: [{ text: "read file" }] },
      {
        type: "gemini",
        content: "Failed",
        tokens: { input: 10, output: 5 },
        toolCalls: [
          { name: "read_file", status: "error", args: { path: "/bad" }, displayName: "ReadFile" },
        ],
      },
    ]));

    const config = makeConfig(tmpDir);
    monitor = new GeminiLogMonitor(config, (sid, state, event) => {
      if (state === "error") {
        assert.strictEqual(event, "PostToolUseFailure");
        done();
      }
    });
    monitor.start();
  });

  it("should detect successful tool call as attention", (_, done) => {
    const filePath = path.join(chatsDir, SESSION_FILE);
    fs.writeFileSync(filePath, makeSessionJson([
      { type: "user", content: [{ text: "list files" }] },
      {
        type: "gemini",
        content: "Here are the files",
        tokens: { input: 10, output: 20 },
        toolCalls: [
          { name: "list_files", status: "success", args: {}, displayName: "ListFiles" },
        ],
      },
    ]));

    const config = makeConfig(tmpDir);
    monitor = new GeminiLogMonitor(config, (sid, state, event) => {
      if (state === "attention") {
        assert.strictEqual(event, "Stop");
        done();
      }
    });
    monitor.start();
  });

  it("should use last tool status when multiple toolCalls", (_, done) => {
    const filePath = path.join(chatsDir, SESSION_FILE);
    fs.writeFileSync(filePath, makeSessionJson([
      { type: "user", content: [{ text: "do things" }] },
      {
        type: "gemini",
        content: "Done",
        tokens: { input: 10, output: 20 },
        toolCalls: [
          { name: "read_file", status: "success", args: {} },
          { name: "write_file", status: "error", args: {} },
        ],
      },
    ]));

    const config = makeConfig(tmpDir);
    monitor = new GeminiLogMonitor(config, (sid, state) => {
      if (state === "error") {
        done();
      }
    });
    monitor.start();
  });

  it("should dedup: same state + same msgCount → no re-emit", (_, done) => {
    const filePath = path.join(chatsDir, SESSION_FILE);
    fs.writeFileSync(filePath, makeSessionJson([
      { type: "user", content: [{ text: "hello" }] },
    ]));

    const config = makeConfig(tmpDir);
    const calls = [];
    monitor = new GeminiLogMonitor(config, (sid, state) => {
      calls.push(state);
    });
    monitor.start();

    // After several poll cycles, should only have been called once
    setTimeout(() => {
      // Touch the file to update mtime but keep same content
      const content = fs.readFileSync(filePath, "utf8");
      fs.writeFileSync(filePath, content);
    }, 200);

    setTimeout(() => {
      assert.strictEqual(calls.length, 1, `expected 1 call, got ${calls.length}: ${calls}`);
      assert.strictEqual(calls[0], "thinking");
      done();
    }, 600);
  });

  it("should skip mtime-unchanged files", (_, done) => {
    const filePath = path.join(chatsDir, SESSION_FILE);
    fs.writeFileSync(filePath, makeSessionJson([
      { type: "user", content: [{ text: "hello" }] },
    ]));

    const config = makeConfig(tmpDir);
    let callCount = 0;
    monitor = new GeminiLogMonitor(config, () => {
      callCount++;
    });
    monitor.start();

    // Multiple poll cycles — file untouched → only 1 call
    setTimeout(() => {
      assert.strictEqual(callCount, 1);
      done();
    }, 500);
  });

  it("should detect incremental changes (new messages appended)", (_, done) => {
    const filePath = path.join(chatsDir, SESSION_FILE);
    // Start with user message
    fs.writeFileSync(filePath, makeSessionJson([
      { type: "user", content: [{ text: "hello" }] },
    ]));

    const config = makeConfig(tmpDir);
    const states = [];
    monitor = new GeminiLogMonitor(config, (sid, state) => {
      states.push(state);
      if (state === "attention") {
        assert.deepStrictEqual(states, ["thinking", "attention"]);
        done();
      }
    });
    monitor.start();

    // Simulate Gemini completing reply
    setTimeout(() => {
      fs.writeFileSync(filePath, makeSessionJson([
        { type: "user", content: [{ text: "hello" }] },
        { type: "gemini", content: "Hi!", tokens: { input: 5, output: 3 } },
      ]));
    }, 250);
  });

  it("should skip old files (>2min mtime)", (_, done) => {
    const filePath = path.join(chatsDir, SESSION_FILE);
    fs.writeFileSync(filePath, makeSessionJson([
      { type: "user", content: [{ text: "hello" }] },
    ]));
    // Backdate mtime
    const oldTime = new Date(Date.now() - 600000);
    fs.utimesSync(filePath, oldTime, oldTime);

    const config = makeConfig(tmpDir);
    let called = false;
    monitor = new GeminiLogMonitor(config, () => { called = true; });
    monitor.start();

    setTimeout(() => {
      assert.strictEqual(called, false, "should not have processed old file");
      done();
    }, 300);
  });

  it("should handle corrupted JSON gracefully", (_, done) => {
    const filePath = path.join(chatsDir, SESSION_FILE);
    fs.writeFileSync(filePath, "THIS IS NOT JSON");

    const config = makeConfig(tmpDir);
    let called = false;
    monitor = new GeminiLogMonitor(config, () => { called = true; });
    monitor.start();

    setTimeout(() => {
      assert.strictEqual(called, false, "should not crash on bad JSON");
      done();
    }, 300);
  });

  it("should handle empty messages array", (_, done) => {
    const filePath = path.join(chatsDir, SESSION_FILE);
    fs.writeFileSync(filePath, makeSessionJson([]));

    const config = makeConfig(tmpDir);
    let called = false;
    monitor = new GeminiLogMonitor(config, () => { called = true; });
    monitor.start();

    setTimeout(() => {
      assert.strictEqual(called, false, "should not emit for empty messages");
      done();
    }, 300);
  });

  it("should emit SessionEnd for stale sessions (5min)", (_, done) => {
    const filePath = path.join(chatsDir, SESSION_FILE);
    fs.writeFileSync(filePath, makeSessionJson([
      { type: "user", content: [{ text: "hello" }] },
    ]));

    const config = makeConfig(tmpDir);
    const states = [];
    monitor = new GeminiLogMonitor(config, (sid, state, event) => {
      states.push({ state, event });
      if (state === "sleeping" && event === "SessionEnd") {
        done();
      }
    });
    monitor.start();

    // Manually age the tracked entry to trigger stale cleanup
    setTimeout(() => {
      for (const tracked of monitor._tracked.values()) {
        tracked.lastEventTime = Date.now() - 400000; // 6+ min ago
      }
    }, 200);
  });

  it("should resolve cwd from projects.json", (_, done) => {
    // Create a mock projects.json
    const geminiDir = path.join(tmpDir, ".gemini-projects");
    fs.mkdirSync(geminiDir, { recursive: true });
    const projectsPath = path.join(geminiDir, "projects.json");
    fs.writeFileSync(projectsPath, JSON.stringify({
      projects: { "d:\\animation": "animation", "c:\\users\\ruller": "ruller" },
    }));

    // Monkey-patch _loadCwdMap to use our custom path
    const filePath = path.join(chatsDir, SESSION_FILE);
    fs.writeFileSync(filePath, makeSessionJson([
      { type: "user", content: [{ text: "hello" }] },
    ]));

    const config = makeConfig(tmpDir);
    monitor = new GeminiLogMonitor(config, (sid, state, event, extra) => {
      assert.strictEqual(extra.cwd, "d:\\animation");
      done();
    });

    // Override _loadCwdMap to read from our test path
    const origLoad = monitor._loadCwdMap.bind(monitor);
    monitor._loadCwdMap = function () {
      try {
        const mtime = fs.statSync(projectsPath).mtimeMs;
        if (this._cwdMap && mtime === this._projectsMtime) return;
        this._projectsMtime = mtime;
        const data = JSON.parse(fs.readFileSync(projectsPath, "utf8"));
        if (data && data.projects) {
          this._cwdMap = {};
          for (const [physPath, dirName] of Object.entries(data.projects)) {
            this._cwdMap[dirName] = physPath;
          }
        }
      } catch {}
    }.bind(monitor);

    monitor.start();
  });

  it("should reload cwdMap when projects.json changes", (_, done) => {
    const geminiDir = path.join(tmpDir, ".gemini-projects");
    fs.mkdirSync(geminiDir, { recursive: true });
    const projectsPath = path.join(geminiDir, "projects.json");
    fs.writeFileSync(projectsPath, JSON.stringify({
      projects: { "c:\\old": "animation" },
    }));

    const filePath = path.join(chatsDir, SESSION_FILE);
    fs.writeFileSync(filePath, makeSessionJson([
      { type: "user", content: [{ text: "hello" }] },
    ]));

    const config = makeConfig(tmpDir);
    const cwds = [];
    monitor = new GeminiLogMonitor(config, (sid, state, event, extra) => {
      cwds.push(extra.cwd);
    });

    // Override _loadCwdMap
    monitor._loadCwdMap = function () {
      try {
        const mtime = fs.statSync(projectsPath).mtimeMs;
        if (this._cwdMap && mtime === this._projectsMtime) return;
        this._projectsMtime = mtime;
        const data = JSON.parse(fs.readFileSync(projectsPath, "utf8"));
        if (data && data.projects) {
          this._cwdMap = {};
          for (const [physPath, dirName] of Object.entries(data.projects)) {
            this._cwdMap[dirName] = physPath;
          }
        }
      } catch {}
    }.bind(monitor);

    monitor.start();

    setTimeout(() => {
      // First call should have old cwd
      assert.strictEqual(cwds[0], "c:\\old");

      // Update projects.json
      fs.writeFileSync(projectsPath, JSON.stringify({
        projects: { "d:\\new-project": "animation" },
      }));

      // Update session to trigger new event
      fs.writeFileSync(filePath, makeSessionJson([
        { type: "user", content: [{ text: "hello" }] },
        { type: "gemini", content: "reply", tokens: { input: 5, output: 3 } },
      ]));
    }, 250);

    setTimeout(() => {
      assert.ok(cwds.length >= 2, `expected at least 2 calls, got ${cwds.length}`);
      assert.strictEqual(cwds[cwds.length - 1], "d:\\new-project");
      done();
    }, 600);
  });

  it("should ignore unknown message types", (_, done) => {
    const filePath = path.join(chatsDir, SESSION_FILE);
    fs.writeFileSync(filePath, makeSessionJson([
      { type: "system", content: "some system thing" },
    ]));

    const config = makeConfig(tmpDir);
    let called = false;
    monitor = new GeminiLogMonitor(config, () => { called = true; });
    monitor.start();

    setTimeout(() => {
      assert.strictEqual(called, false, "should not emit for unknown message type");
      done();
    }, 300);
  });

  it("should track multiple project directories independently", (_, done) => {
    // Create a second project dir
    const chatsDir2 = path.join(tmpDir, "otherproject", "chats");
    fs.mkdirSync(chatsDir2, { recursive: true });

    const file1 = path.join(chatsDir, SESSION_FILE);
    const file2 = path.join(chatsDir2, "session-2026-04-04T09-00-00-efgh5678.json");

    fs.writeFileSync(file1, makeSessionJson(
      [{ type: "user", content: [{ text: "in animation" }] }],
      "session-aaa"
    ));
    fs.writeFileSync(file2, makeSessionJson(
      [{ type: "gemini", content: "done", tokens: { input: 1, output: 1 } }],
      "session-bbb"
    ));

    const config = makeConfig(tmpDir);
    const events = [];
    monitor = new GeminiLogMonitor(config, (sid, state) => {
      events.push({ sid, state });
      if (events.length === 2) {
        const sids = events.map(e => e.sid).sort();
        assert.ok(sids.includes("gemini:session-aaa"));
        assert.ok(sids.includes("gemini:session-bbb"));
        done();
      }
    });
    monitor.start();
  });

  it("should fall back to filename as sessionId when data.sessionId is missing", (_, done) => {
    const filePath = path.join(chatsDir, SESSION_FILE);
    const data = {
      projectHash: "abc",
      messages: [{ type: "user", content: [{ text: "hi" }] }],
    };
    fs.writeFileSync(filePath, JSON.stringify(data));

    const config = makeConfig(tmpDir);
    monitor = new GeminiLogMonitor(config, (sid) => {
      assert.strictEqual(sid, "gemini:session-2026-04-04T08-00-00-abcd1234");
      done();
    });
    monitor.start();
  });
});
