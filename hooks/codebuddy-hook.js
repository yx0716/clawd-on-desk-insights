#!/usr/bin/env node
// Clawd — CodeBuddy hook (stdin JSON with hook_event_name; stdout JSON for gating hooks)
// Registered in ~/.codebuddy/settings.json by hooks/codebuddy-install.js
// CodeBuddy uses Claude Code-compatible hook format with identical event names.

const { postStateToRunningServer, readHostPrefix } = require("./server-config");
const { createPidResolver, readStdinJson, getPlatformConfig } = require("./shared-process");

// CodeBuddy hook event → { state, event } for the Clawd state machine
const HOOK_MAP = {
  SessionStart:     { state: "idle",         event: "SessionStart" },
  SessionEnd:       { state: "sleeping",     event: "SessionEnd" },
  UserPromptSubmit: { state: "thinking",     event: "UserPromptSubmit" },
  PreToolUse:       { state: "working",      event: "PreToolUse" },
  PostToolUse:      { state: "working",      event: "PostToolUse" },
  Stop:             { state: "attention",    event: "Stop" },
  // PermissionRequest: handled by HTTP hook (blocking), not this command hook
  Notification:     { state: "notification", event: "Notification" },
  PreCompact:       { state: "sweeping",     event: "PreCompact" },
};

const config = getPlatformConfig({
  extraTerminals: { win: ["codebuddy.exe"] },
  extraEditors: {
    win: { "codebuddy.exe": "codebuddy" },
    mac: { "codebuddy": "codebuddy" },
    linux: { "codebuddy": "codebuddy" },
  },
  extraEditorPathChecks: [["codebuddy", "codebuddy"]],
});
const resolve = createPidResolver({
  agentNames: { win: new Set(["codebuddy.exe"]), mac: new Set(["codebuddy"]), linux: new Set(["codebuddy"]) },
  platformConfig: config,
});

// CodeBuddy PreToolUse gating — allow by default
function stdoutForEvent(hookName) {
  if (hookName === "PreToolUse") return JSON.stringify({ decision: "allow" });
  return "{}";
}

readStdinJson().then((payload) => {
  const hookName = (payload && payload.hook_event_name) || "";
  const mapped = HOOK_MAP[hookName];

  if (!mapped) {
    process.stdout.write(stdoutForEvent(hookName) + "\n");
    process.exit(0);
    return;
  }

  const { state, event } = mapped;
  if (hookName === "SessionStart" && !process.env.CLAWD_REMOTE) resolve();

  const sessionId = (payload && payload.session_id) || "default";
  const cwd = (payload && payload.cwd) || "";

  const { stablePid, agentPid, detectedEditor, pidChain } = resolve();

  const body = { state, session_id: sessionId, event };
  body.agent_id = "codebuddy";
  if (cwd) body.cwd = cwd;
  if (process.env.CLAWD_REMOTE) {
    body.host = readHostPrefix();
  } else {
    body.source_pid = stablePid;
    if (detectedEditor) body.editor = detectedEditor;
    if (agentPid) body.agent_pid = agentPid;
    if (pidChain.length) body.pid_chain = pidChain;
  }

  const outLine = stdoutForEvent(hookName);
  postStateToRunningServer(JSON.stringify(body), { timeoutMs: 100 }, () => {
    process.stdout.write(outLine + "\n");
    process.exit(0);
  });
});
