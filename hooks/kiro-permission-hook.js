#!/usr/bin/env node
// Clawd — Kiro CLI permission hook (blocking preToolUse gate via Clawd bubble)
// Returns 0 to allow, 2 to deny, and 0 to fall back to Kiro's native prompt.

const { requestPermissionFromRunningServer, readHostPrefix } = require("./server-config");

const TOOL_NAME_MAP = {
  fs_write: "Write",
  execute_bash: "Bash",
  use_aws: "Bash",
};

function normalizeToolInput(toolName, payload) {
  if (!payload || typeof payload !== "object") return {};

  if (toolName === "fs_write") {
    return {
      file_path: payload.path || payload.file_path || "",
      content: payload.content || "",
    };
  }
  if (toolName === "execute_bash") {
    return {
      command: payload.command || "",
      cwd: payload.cwd || payload.workdir || "",
    };
  }
  if (toolName === "use_aws") {
    return {
      command: payload.cli_command || payload.command || "",
      service: payload.service || "",
    };
  }
  return payload;
}

function exitForBehavior(behavior) {
  if (behavior === "deny") process.exit(2);
  process.exit(0);
}

const chunks = [];
let finished = false;
let stdinTimer = null;

function finish(payload) {
  if (finished) return;
  finished = true;
  if (stdinTimer) clearTimeout(stdinTimer);

  const hookName = payload && payload.hook_event_name;
  if (hookName !== "preToolUse") {
    process.exit(0);
    return;
  }

  const rawToolName = typeof payload.tool_name === "string" ? payload.tool_name : "";
  const mappedToolName = TOOL_NAME_MAP[rawToolName] || rawToolName || "Unknown";
  const toolInput = normalizeToolInput(rawToolName, payload.tool_input);
  const body = {
    agent_id: "kiro-cli",
    permission_protocol: "kiro-cli",
    session_id: "default",
    tool_name: mappedToolName,
    tool_input: toolInput,
  };

  if (typeof payload.cwd === "string" && payload.cwd) body.cwd = payload.cwd;
  if (process.env.CLAWD_REMOTE) body.host = readHostPrefix();

  requestPermissionFromRunningServer(
    JSON.stringify(body),
    { timeoutMs: 600000 },
    (ok, _port, responseBody) => {
      if (!ok) {
        process.exit(0);
        return;
      }
      try {
        const response = JSON.parse(responseBody);
        const behavior = response && response.hookSpecificOutput
          && response.hookSpecificOutput.decision
          && response.hookSpecificOutput.decision.behavior;
        exitForBehavior(behavior);
      } catch {
        process.exit(0);
      }
    }
  );
}

process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  let payload = {};
  try {
    const raw = Buffer.concat(chunks).toString();
    if (raw.trim()) payload = JSON.parse(raw);
  } catch {
    payload = {};
  }
  finish(payload);
});

stdinTimer = setTimeout(() => finish({}), 400);
