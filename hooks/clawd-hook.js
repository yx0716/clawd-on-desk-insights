#!/usr/bin/env node
// Clawd Desktop Pet — Claude Code Hook Script
// Usage: node clawd-hook.js <event_name>
// Reads stdin JSON from Claude Code for session_id

const { postStateToRunningServer, readHostPrefix } = require("./server-config");
const { createPidResolver, readStdinJson, getPlatformConfig } = require("./shared-process");

const EVENT_TO_STATE = {
  SessionStart: "idle",
  SessionEnd: "sleeping",
  UserPromptSubmit: "thinking",
  PreToolUse: "working",
  PostToolUse: "working",
  PostToolUseFailure: "error",
  Stop: "attention",
  StopFailure: "error",
  SubagentStart: "juggling",
  SubagentStop: "working",
  PreCompact: "sweeping",
  PostCompact: "attention",
  Notification: "notification",
  // PermissionRequest is handled by HTTP hook (blocking) — not command hook
  Elicitation: "notification",
  WorktreeCreate: "carrying",
};

const event = process.argv[2];
const state = EVENT_TO_STATE[event];
if (!state) process.exit(0);

const config = getPlatformConfig();
const resolve = createPidResolver({
  agentNames: { win: new Set(["claude.exe"]), mac: new Set(["claude"]) },
  agentCmdlineCheck: (cmd) => cmd.includes("claude-code") || cmd.includes("@anthropic-ai"),
  platformConfig: config,
});

// Pre-resolve on SessionStart (runs during stdin buffering, not after)
// Remote mode: skip PID collection — remote PIDs are meaningless on the local machine
if (event === "SessionStart" && !process.env.CLAWD_REMOTE) resolve();

readStdinJson().then((payload) => {
  const sessionId = payload.session_id || "default";
  const cwd = payload.cwd || "";
  const source = payload.source || payload.reason || "";

  // /clear triggers SessionEnd → SessionStart in quick succession;
  // show sweeping (clearing context) instead of sleeping
  const resolvedState = (event === "SessionEnd" && source === "clear") ? "sweeping" : state;

  const body = { state: resolvedState, session_id: sessionId, event };
  body.agent_id = "claude-code";
  if (cwd) body.cwd = cwd;
  if (process.env.CLAWD_REMOTE) {
    body.host = readHostPrefix();
  } else {
    const { stablePid, agentPid, detectedEditor, pidChain } = resolve();
    body.source_pid = stablePid;
    if (detectedEditor) body.editor = detectedEditor;
    if (agentPid) {
      body.agent_pid = agentPid;
      body.claude_pid = agentPid; // backward compat with older Clawd versions
      // Check if claude process is running in non-interactive (-p/--print) mode
      try {
        const { execSync } = require("child_process");
        const isWin = process.platform === "win32";
        const cmdOut = isWin
          ? execSync(
              `wmic process where "ProcessId=${agentPid}" get CommandLine /format:csv`,
              { encoding: "utf8", timeout: 500, windowsHide: true }
            )
          : execSync(`ps -o command= -p ${agentPid}`, { encoding: "utf8", timeout: 500 });
        if (/\s(-p|--print)(\s|$)/.test(cmdOut)) body.headless = true;
      } catch {}
    }
    if (pidChain.length) body.pid_chain = pidChain;
  }

  postStateToRunningServer(
    JSON.stringify(body),
    { timeoutMs: 100 },
    () => process.exit(0)
  );
});
