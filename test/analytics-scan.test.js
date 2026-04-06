const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

const ANALYTICS_SCAN_PATH = require.resolve("../src/analytics-scan");

function writeCodexSession(homeDir, sessionId, cwd) {
  const dateDir = path.join(homeDir, ".codex", "sessions", "2026", "04", "06");
  fs.mkdirSync(dateDir, { recursive: true });

  const filePath = path.join(
    dateDir,
    `rollout-2026-04-06T19-44-02-${sessionId}.jsonl`
  );
  const lines = [
    {
      timestamp: "2026-04-06T11:44:02.000Z",
      type: "session_meta",
      payload: {
        id: sessionId,
        timestamp: "2026-04-06T11:44:02.000Z",
        cwd,
      },
    },
    {
      timestamp: "2026-04-06T11:44:03.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "first prompt" }],
      },
    },
    {
      timestamp: "2026-04-06T11:44:04.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "first reply" }],
      },
    },
    {
      timestamp: "2026-04-06T11:44:05.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "second prompt" }],
      },
    },
    {
      timestamp: "2026-04-06T11:44:06.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "second reply" }],
      },
    },
    {
      timestamp: "2026-04-06T11:44:07.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "third prompt" }],
      },
    },
    {
      timestamp: "2026-04-06T11:44:08.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "third reply" }],
      },
    },
  ];

  fs.writeFileSync(filePath, lines.map(line => JSON.stringify(line)).join("\n") + "\n");
}

describe("analytics scan", () => {
  let tempHome;
  let previousHome;
  let previousUserProfile;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "analytics-scan-"));
    previousHome = process.env.HOME;
    previousUserProfile = process.env.USERPROFILE;
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    delete require.cache[ANALYTICS_SCAN_PATH];
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;

    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;

    delete require.cache[ANALYTICS_SCAN_PATH];
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it("includes codex sessions from non-hidden projects in analytics results", () => {
    const sessionId = "019d629b-5f09-73f1-b73c-7fd96130faca";
    const cwd = "/Users/jyx/Documents/1_explore/project-alpha";
    writeCodexSession(tempHome, sessionId, cwd);

    const initAnalyticsScan = require("../src/analytics-scan");
    const analyticsScan = initAnalyticsScan({});
    const startTs = new Date("2026-04-06T00:00:00+08:00").getTime();
    const endTs = new Date("2026-04-07T00:00:00+08:00").getTime();
    const data = analyticsScan.scanRange(startTs, endTs);

    assert.strictEqual(data.sessionCount, 1);
    assert.strictEqual(data.sessions[0].agent, "codex");
    assert.strictEqual(data.sessions[0].project, "project-alpha");
    assert.strictEqual(data.sessions[0].cwd, cwd);
    assert.strictEqual(data.sessions[0].messages, 6);
  });

  it("filters out on-desk self-project sessions from analytics results", () => {
    writeCodexSession(
      tempHome,
      "019d629b-5f09-73f1-b73c-7fd96130fac1",
      "/Users/jyx/Documents/1_explore/clawd-on-desk"
    );
    writeCodexSession(
      tempHome,
      "019d629b-5f09-73f1-b73c-7fd96130fac2",
      "/Users/jyx/Documents/1_explore/on-desk"
    );
    writeCodexSession(
      tempHome,
      "019d629b-5f09-73f1-b73c-7fd96130fac3",
      "/Users/jyx/Documents/1_explore/cache-revolution"
    );

    const initAnalyticsScan = require("../src/analytics-scan");
    const analyticsScan = initAnalyticsScan({});
    const startTs = new Date("2026-04-06T00:00:00+08:00").getTime();
    const endTs = new Date("2026-04-07T00:00:00+08:00").getTime();
    const data = analyticsScan.scanRange(startTs, endTs);

    assert.strictEqual(data.sessionCount, 1);
    assert.strictEqual(data.sessions[0].project, "cache-revolution");
  });
});
