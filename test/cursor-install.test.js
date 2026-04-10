const { describe, it, afterEach, mock } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { registerCursorHooks, CURSOR_HOOK_EVENTS } = require("../hooks/cursor-install");

const MARKER = "cursor-hook.js";
const tempDirs = [];

function makeTempHooksFile(initial = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-cursor-"));
  const hooksPath = path.join(tmpDir, "hooks.json");
  fs.writeFileSync(hooksPath, JSON.stringify(initial, null, 2), "utf8");
  tempDirs.push(tmpDir);
  return hooksPath;
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

describe("Cursor hook installer", () => {
  it("registers all events on fresh install", () => {
    const hooksPath = makeTempHooksFile({});
    const result = registerCursorHooks({
      silent: true,
      hooksPath,
      nodeBin: "/usr/local/bin/node",
    });

    assert.strictEqual(result.added, CURSOR_HOOK_EVENTS.length);
    assert.strictEqual(result.skipped, 0);
    assert.strictEqual(result.updated, 0);

    const settings = readJson(hooksPath);
    assert.strictEqual(settings.version, 1);
    for (const event of CURSOR_HOOK_EVENTS) {
      assert.ok(Array.isArray(settings.hooks[event]), `missing hooks for ${event}`);
      assert.strictEqual(settings.hooks[event].length, 1);
      const entry = settings.hooks[event][0];
      assert.ok(typeof entry.command === "string");
      assert.ok(entry.command.includes(MARKER));
      assert.ok(entry.command.includes("/usr/local/bin/node"));
    }
  });

  it("is idempotent on second run", () => {
    const hooksPath = makeTempHooksFile({});
    registerCursorHooks({ silent: true, hooksPath, nodeBin: "/usr/local/bin/node" });
    const contentBefore = fs.readFileSync(hooksPath, "utf8");

    const result = registerCursorHooks({ silent: true, hooksPath, nodeBin: "/usr/local/bin/node" });

    assert.strictEqual(result.added, 0);
    assert.strictEqual(result.updated, 0);
    assert.strictEqual(result.skipped, CURSOR_HOOK_EVENTS.length);
    assert.strictEqual(fs.readFileSync(hooksPath, "utf8"), contentBefore);
  });

  it("updates stale hook paths", () => {
    const hooksPath = makeTempHooksFile({
      version: 1,
      hooks: {
        stop: [{ command: '"/old/node" "/old/path/cursor-hook.js"' }],
        preToolUse: [{ command: '"/old/node" "/old/path/cursor-hook.js"' }],
      },
    });

    const result = registerCursorHooks({
      silent: true,
      hooksPath,
      nodeBin: "/usr/local/bin/node",
    });

    assert.ok(result.updated >= 2);
    const settings = readJson(hooksPath);
    assert.ok(settings.hooks.stop[0].command.includes("/usr/local/bin/node"));
    assert.ok(!settings.hooks.stop[0].command.includes("/old/path/"));
    assert.strictEqual(settings.hooks.stop.length, 1);
  });

  it("preserves existing node path when detection fails", () => {
    const hooksPath = makeTempHooksFile({
      version: 1,
      hooks: {
        stop: [{ command: '"/home/user/.nvm/versions/node/v20/bin/node" "/some/path/cursor-hook.js"' }],
      },
    });

    const result = registerCursorHooks({
      silent: true,
      hooksPath,
      nodeBin: null,
    });

    const settings = readJson(hooksPath);
    assert.ok(settings.hooks.stop[0].command.includes("/home/user/.nvm/versions/node/v20/bin/node"));
  });

  it("preserves third-party hooks", () => {
    const thirdParty = { command: "some-other-tool --flag" };
    const hooksPath = makeTempHooksFile({
      version: 1,
      hooks: {
        sessionStart: [thirdParty],
      },
    });

    registerCursorHooks({ silent: true, hooksPath, nodeBin: "/usr/local/bin/node" });

    const settings = readJson(hooksPath);
    assert.strictEqual(settings.hooks.sessionStart.length, 2);
    assert.deepStrictEqual(settings.hooks.sessionStart[0], thirdParty);
    assert.ok(settings.hooks.sessionStart[1].command.includes(MARKER));
  });

  it("skips when ~/.cursor/ does not exist", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-cursor-home-"));
    tempDirs.push(tmpHome);
    mock.method(os, "homedir", () => tmpHome);

    const result = registerCursorHooks({
      silent: true,
      nodeBin: "/usr/local/bin/node",
    });

    assert.deepStrictEqual(result, { added: 0, skipped: 0, updated: 0 });
  });
});
