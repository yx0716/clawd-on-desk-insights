#!/usr/bin/env node
// Clawd Desktop Pet — Copilot CLI Hook Script
// Usage: node copilot-hook.js <event_name>
// Reads stdin JSON from Copilot CLI for sessionId (camelCase)

const { postStateToRunningServer } = require("./server-config");
const { createPidResolver, readStdinJson, getPlatformConfig } = require("./shared-process");

const EVENT_TO_STATE = {
  sessionStart: "idle",
  sessionEnd: "sleeping",
  userPromptSubmitted: "thinking",
  preToolUse: "working",
  postToolUse: "working",
  errorOccurred: "error",
  agentStop: "attention",
  subagentStart: "juggling",
  subagentStop: "working",
  preCompact: "sweeping",
};

const event = process.argv[2];
const state = EVENT_TO_STATE[event];
if (!state) process.exit(0);

const config = getPlatformConfig();
const resolve = createPidResolver({
  agentNames: { win: new Set(["copilot.exe"]), mac: new Set(["copilot"]) },
  agentCmdlineCheck: (cmd) => cmd.includes("@github/copilot"),
  platformConfig: config,
});

// Pre-resolve on sessionStart
if (event === "sessionStart") resolve();

readStdinJson().then((payload) => {
  // Copilot CLI uses camelCase: sessionId, not session_id
  const sessionId = payload.sessionId || payload.session_id || "default";
  const cwd = payload.cwd || "";

  const { stablePid, agentPid, detectedEditor, pidChain } = resolve();

  const body = { state, session_id: sessionId, event };
  body.agent_id = "copilot-cli";
  if (cwd) body.cwd = cwd;
  body.source_pid = stablePid;
  if (detectedEditor) body.editor = detectedEditor;
  if (agentPid) body.agent_pid = agentPid;
  if (pidChain.length) body.pid_chain = pidChain;

  postStateToRunningServer(
    JSON.stringify(body),
    { timeoutMs: 100 },
    () => process.exit(0)
  );
});
