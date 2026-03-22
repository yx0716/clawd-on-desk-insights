#!/usr/bin/env node
// Clawd Desktop Pet — Claude Code Hook Script
// Zero dependencies, fast cold start, 1s timeout
// Usage: node clawd-hook.js <event_name>
// Reads stdin JSON from Claude Code for session_id

const EVENT_TO_STATE = {
  SessionStart: "idle",
  SessionEnd: "sleeping",
  UserPromptSubmit: "thinking",
  PreToolUse: "working",
  PostToolUse: "working",
  PostToolUseFailure: "error",
  Stop: "attention",
  SubagentStart: "juggling",
  SubagentStop: "working",
  PreCompact: "sweeping",
  PostCompact: "attention",
  Notification: "notification",
  PermissionRequest: "notification",
  Elicitation: "notification",
  WorktreeCreate: "carrying",
};

const event = process.argv[2];
const state = EVENT_TO_STATE[event];
if (!state) process.exit(0);

// Walk the FULL process tree to find a stable ancestor PID.
// Claude Code spawns hooks through multiple transient layers (workers, shells).
// We walk up until we find the terminal app or a system boundary.
// Runs synchronously during stdin buffering (~100ms per level × 5-6 levels).
let _stablePid = null;
function getStablePid() {
  if (_stablePid) return _stablePid;
  const { execSync } = require("child_process");
  const isWin = process.platform === "win32";
  // Collect the full ancestor chain, return the highest non-system PID
  let pid = process.ppid;
  let lastGoodPid = pid;
  for (let i = 0; i < 8; i++) {
    try {
      if (isWin) {
        const out = execSync(
          `wmic process where "ProcessId=${pid}" get Name,ParentProcessId /format:csv`,
          { encoding: "utf8", timeout: 1500, windowsHide: true }
        );
        const lines = out.trim().split("\n").filter(l => l.includes(","));
        if (!lines.length) break;
        const parts = lines[lines.length - 1].split(",");
        const name = (parts[1] || "").trim().toLowerCase();
        const parentPid = parseInt(parts[2], 10);
        // Stop at system boundaries
        if (name === "explorer.exe" || name === "services.exe" ||
            name === "winlogon.exe" || name === "svchost.exe") break;
        lastGoodPid = pid;
        if (!parentPid || parentPid === pid || parentPid <= 1) break;
        pid = parentPid;
      } else {
        // macOS/Linux
        const cp = require("child_process");
        const ppidOut = cp.execSync(`ps -o ppid= -p ${pid}`, { encoding: "utf8", timeout: 1000 }).trim();
        const commOut = cp.execSync(`ps -o comm= -p ${pid}`, { encoding: "utf8", timeout: 1000 }).trim();
        const name = require("path").basename(commOut).toLowerCase();
        const parentPid = parseInt(ppidOut, 10);
        if (name === "launchd" || name === "init" || name === "systemd") break;
        lastGoodPid = pid;
        if (!parentPid || parentPid === pid || parentPid <= 1) break;
        pid = parentPid;
      }
    } catch { break; }
  }
  _stablePid = lastGoodPid;
  return lastGoodPid;
}

// Start resolution immediately (runs during stdin buffering, not after)
getStablePid();

// Read stdin for session_id (Claude Code pipes JSON with session metadata)
const chunks = [];
let sent = false;

process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("end", () => {
  let sessionId = "default";
  try {
    const payload = JSON.parse(Buffer.concat(chunks).toString());
    sessionId = payload.session_id || "default";
  } catch {}
  send(sessionId);
});

// Safety: if stdin doesn't end in 400ms, send with default session
// (200ms was too aggressive on slow machines / AV scanning)
setTimeout(() => send("default"), 400);

function send(sessionId) {
  if (sent) return;
  sent = true;

  // Get a stable ancestor PID (survives after this hook process exits).
  // process.ppid is a transient shell (cmd.exe/bash.exe) spawned by Claude Code
  // to run this hook — it dies immediately after. One wmic/ps call up gives us
  // Claude Code's node.exe PID, which is long-lived.
  const body = { state, session_id: sessionId, event, source_pid: getStablePid() };

  const data = JSON.stringify(body);
  const req = require("http").request(
    {
      hostname: "127.0.0.1",
      port: 23333,
      path: "/state",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
      },
      timeout: 500,  // 400ms stdin + 500ms HTTP = 900ms < 1000ms Claude Code budget
    },
    () => process.exit(0)
  );
  req.on("error", () => process.exit(0));
  req.on("timeout", () => { req.destroy(); process.exit(0); });
  req.end(data);
}
