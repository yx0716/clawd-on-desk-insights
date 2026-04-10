const { describe, it, afterEach, mock } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { registerGeminiHooks, GEMINI_HOOK_EVENTS } = require("../hooks/gemini-install");

const MARKER = "gemini-hook.js";
const tempDirs = [];

function makeTempSettingsFile(initial = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-gemini-"));
  const settingsPath = path.join(tmpDir, "settings.json");
  fs.writeFileSync(settingsPath, JSON.stringify(initial, null, 2), "utf8");
  tempDirs.push(tmpDir);
  return settingsPath;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

afterEach(() => {
  mock.restoreAll();
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe("Gemini hook installer", () => {
  it("registers all events on fresh install", () => {
    const settingsPath = makeTempSettingsFile({});
    const result = registerGeminiHooks({
      silent: true,
      settingsPath,
      nodeBin: "/usr/local/bin/node",
    });

    assert.strictEqual(result.added, GEMINI_HOOK_EVENTS.length);
    assert.strictEqual(result.skipped, 0);
    assert.strictEqual(result.updated, 0);

    const settings = readJson(settingsPath);
    for (const event of GEMINI_HOOK_EVENTS) {
      assert.ok(Array.isArray(settings.hooks[event]), `missing hooks for ${event}`);
      assert.strictEqual(settings.hooks[event].length, 1);
      const entry = settings.hooks[event][0];
      assert.strictEqual(entry.type, "command");
      assert.strictEqual(entry.name, "clawd");
      assert.ok(entry.command.includes(MARKER));
      assert.ok(entry.command.includes("/usr/local/bin/node"));
    }
  });

  it("is idempotent on second run", () => {
    const settingsPath = makeTempSettingsFile({});
    registerGeminiHooks({ silent: true, settingsPath, nodeBin: "/usr/local/bin/node" });
    const contentBefore = fs.readFileSync(settingsPath, "utf8");

    const result = registerGeminiHooks({ silent: true, settingsPath, nodeBin: "/usr/local/bin/node" });

    assert.strictEqual(result.added, 0);
    assert.strictEqual(result.updated, 0);
    assert.strictEqual(result.skipped, GEMINI_HOOK_EVENTS.length);
    assert.strictEqual(fs.readFileSync(settingsPath, "utf8"), contentBefore);
  });

  it("updates stale hook paths", () => {
    const settingsPath = makeTempSettingsFile({
      hooks: {
        AfterTool: [{ type: "command", command: '"/old/node" "/old/path/gemini-hook.js"', name: "clawd" }],
      },
    });

    const result = registerGeminiHooks({
      silent: true,
      settingsPath,
      nodeBin: "/usr/local/bin/node",
    });

    assert.ok(result.updated >= 1);
    const settings = readJson(settingsPath);
    assert.ok(settings.hooks.AfterTool[0].command.includes("/usr/local/bin/node"));
    assert.ok(!settings.hooks.AfterTool[0].command.includes("/old/path/"));
    assert.strictEqual(settings.hooks.AfterTool.length, 1);
  });

  it("preserves existing node path when detection fails", () => {
    const settingsPath = makeTempSettingsFile({
      hooks: {
        BeforeTool: [{ type: "command", command: '"/home/user/.nvm/versions/node/v20/bin/node" "/some/path/gemini-hook.js"', name: "clawd" }],
      },
    });

    registerGeminiHooks({ silent: true, settingsPath, nodeBin: null });

    const settings = readJson(settingsPath);
    assert.ok(settings.hooks.BeforeTool[0].command.includes("/home/user/.nvm/versions/node/v20/bin/node"));
  });

  it("preserves third-party hooks", () => {
    const thirdParty = { type: "command", command: "other-tool --flag", name: "other" };
    const settingsPath = makeTempSettingsFile({
      hooks: {
        SessionStart: [thirdParty],
      },
    });

    registerGeminiHooks({ silent: true, settingsPath, nodeBin: "/usr/local/bin/node" });

    const settings = readJson(settingsPath);
    assert.strictEqual(settings.hooks.SessionStart.length, 2);
    assert.deepStrictEqual(settings.hooks.SessionStart[0], thirdParty);
    assert.ok(settings.hooks.SessionStart[1].command.includes(MARKER));
  });

  it("skips when ~/.gemini/ does not exist", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-gemini-home-"));
    tempDirs.push(tmpHome);
    mock.method(os, "homedir", () => tmpHome);

    const result = registerGeminiHooks({
      silent: true,
      nodeBin: "/usr/local/bin/node",
    });

    assert.deepStrictEqual(result, { added: 0, skipped: 0, updated: 0 });
  });
});
