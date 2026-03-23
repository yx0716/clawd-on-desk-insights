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

// Walk the process tree to find the terminal app PID.
// Claude Code spawns hooks through multiple transient layers (workers, shells).
// We walk up until we find a known terminal app, then let focusTerminalWindow
// walk the remaining hops (it has its own parent walk with MainWindowHandle check).
// Runs synchronously during stdin buffering (~100ms per level × 5-6 levels).
// Known terminal/launcher apps — outermost match becomes the focus target.
// focusTerminalWindow() walks further up via MainWindowHandle if needed,
// so including launchers (e.g. antigravity) that host terminals is correct.
const TERMINAL_NAMES_WIN = new Set([
  "windowsterminal.exe", "cmd.exe", "powershell.exe", "pwsh.exe",
  "code.exe", "alacritty.exe", "wezterm-gui.exe", "mintty.exe",
  "conemu64.exe", "conemu.exe", "hyper.exe", "tabby.exe",
  "antigravity.exe", "warp.exe", "iterm.exe",
]);
const TERMINAL_NAMES_MAC = new Set([
  "terminal", "iterm2", "alacritty", "wezterm-gui", "kitty",
  "hyper", "tabby", "warp",
]);

const SYSTEM_BOUNDARY_WIN = new Set(["explorer.exe", "services.exe", "winlogon.exe", "svchost.exe"]);
const SYSTEM_BOUNDARY_MAC = new Set(["launchd", "init", "systemd"]);

let _stablePid = null;
function getStablePid() {
  if (_stablePid) return _stablePid;
  const { execSync } = require("child_process");
  const isWin = process.platform === "win32";
  const terminalNames = isWin ? TERMINAL_NAMES_WIN : TERMINAL_NAMES_MAC;
  const systemBoundary = isWin ? SYSTEM_BOUNDARY_WIN : SYSTEM_BOUNDARY_MAC;
  let pid = process.ppid;
  let lastGoodPid = pid;
  let terminalPid = null;
  for (let i = 0; i < 8; i++) {
    let name, parentPid;
    try {
      if (isWin) {
        const out = execSync(
          `wmic process where "ProcessId=${pid}" get Name,ParentProcessId /format:csv`,
          { encoding: "utf8", timeout: 1500, windowsHide: true }
        );
        const lines = out.trim().split("\n").filter(l => l.includes(","));
        if (!lines.length) break;
        const parts = lines[lines.length - 1].split(",");
        name = (parts[1] || "").trim().toLowerCase();
        parentPid = parseInt(parts[2], 10);
      } else {
        const cp = require("child_process");
        const ppidOut = cp.execSync(`ps -o ppid= -p ${pid}`, { encoding: "utf8", timeout: 1000 }).trim();
        const commOut = cp.execSync(`ps -o comm= -p ${pid}`, { encoding: "utf8", timeout: 1000 }).trim();
        name = require("path").basename(commOut).toLowerCase();
        parentPid = parseInt(ppidOut, 10);
      }
    } catch { break; }
    if (systemBoundary.has(name)) break;
    if (terminalNames.has(name)) terminalPid = pid;
    lastGoodPid = pid;
    if (!parentPid || parentPid === pid || parentPid <= 1) break;
    pid = parentPid;
  }
  // Prefer outermost known terminal; fall back to highest non-system PID
  _stablePid = terminalPid || lastGoodPid;
  return _stablePid;
}

// Pre-resolve on SessionStart (runs during stdin buffering, not after)
if (event === "SessionStart") getStablePid();

// Read stdin for session_id (Claude Code pipes JSON with session metadata)
const chunks = [];
let sent = false;

process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("end", () => {
  let sessionId = "default";
  let cwd = "";
  try {
    const payload = JSON.parse(Buffer.concat(chunks).toString());
    sessionId = payload.session_id || "default";
    cwd = payload.cwd || "";
  } catch {}
  send(sessionId, cwd);
});

// Safety: if stdin doesn't end in 400ms, send with default session
// (200ms was too aggressive on slow machines / AV scanning)
setTimeout(() => send("default", ""), 400);

function send(sessionId, cwd) {
  if (sent) return;
  sent = true;

  const body = { state, session_id: sessionId, event };
  if (cwd) body.cwd = cwd;
  // Always walk to stable terminal PID — process.ppid is an ephemeral shell
  // that dies when the hook exits, so it's useless for later focus calls
  body.source_pid = getStablePid();

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
