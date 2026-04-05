// Clawd on Desk — opencode Plugin
// Runs inside the opencode process (Bun runtime) and forwards session/tool
// events to the Clawd HTTP server (127.0.0.1:23333-23337).
//
// Design invariants:
//   - Zero dependencies (Bun's built-in fetch + fs/os/path)
//   - fire-and-forget: event hook never awaits the fetch, so slow/broken Clawd
//     cannot stall opencode
//   - same-state dedup — consecutive identical states skip POST
//   - self-healing port discovery: cache hit skips I/O; on miss we read
//     runtime.json, then fall back to a full SERVER_PORTS scan

import { readFileSync, appendFileSync, writeFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const CLAWD_DIR = join(homedir(), ".clawd");
const RUNTIME_CONFIG_PATH = join(CLAWD_DIR, "runtime.json");
const DEBUG_LOG_PATH = join(CLAWD_DIR, "opencode-plugin.log");
const SERVER_PORTS = [23333, 23334, 23335, 23336, 23337];
const STATE_PATH = "/state";
// Fire-and-forget: the IIFE never blocks the event hook's return value, so a
// generous timeout is safe. 200ms was too tight when Clawd's IPC roundtrip
// (main → renderer → main) ran under load and silently timed out.
const POST_TIMEOUT_MS = 1000;
const AGENT_ID = "opencode";

// opencode emits session.status=busy between every tool call as the LLM
// deliberates the next step; without this gate the pet would flash
// thinking ↔ working on every invocation. Active states listed here
// suppress the "back to thinking" regression.
const ACTIVE_STATES_BLOCKING_THINKING = new Set(["working", "sweeping"]);

// Per plugin-instance state (scoped to one opencode process).
let _cachedPort = null;
let _lastState = null;
let _lastSessionId = null;
let _reqCounter = 0;

// Debug log is reset on plugin init so each opencode startup gets a clean
// file. Only session.* ignores are logged; high-frequency message.part.*
// ignores are skipped to avoid synchronous fsync on every text delta.
function debugLog(msg) {
  try {
    appendFileSync(DEBUG_LOG_PATH, `[${new Date().toISOString()}] ${msg}\n`, "utf8");
  } catch {}
}

function resetDebugLog() {
  try {
    mkdirSync(CLAWD_DIR, { recursive: true });
    writeFileSync(DEBUG_LOG_PATH, "", "utf8");
  } catch {}
}

function readRuntimePort() {
  try {
    const raw = JSON.parse(readFileSync(RUNTIME_CONFIG_PATH, "utf8"));
    const port = Number(raw && raw.port);
    if (Number.isInteger(port) && SERVER_PORTS.includes(port)) return port;
  } catch {}
  return null;
}

// Ordered: cached → runtime.json → full scan. Only touches runtime.json when
// the cache is empty (avoids a sync fs read on every successful POST).
function getPortCandidates() {
  const ordered = [];
  const seen = new Set();
  const add = (p) => {
    if (p && !seen.has(p) && SERVER_PORTS.includes(p)) {
      seen.add(p);
      ordered.push(p);
    }
  };
  add(_cachedPort);
  if (_cachedPort == null) add(readRuntimePort());
  SERVER_PORTS.forEach(add);
  return ordered;
}

// POST state to Clawd, fire-and-forget. Tries cached port first; on failure
// walks runtime.json + fallback range. Caches the winning port. Never throws.
function postStateToClawd(body) {
  const payload = JSON.stringify(body);
  const candidates = getPortCandidates();
  const reqId = ++_reqCounter;
  debugLog(`POST[${reqId}] start state=${body.state} candidates=[${candidates.join(",")}]`);

  (async () => {
    for (const port of candidates) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), POST_TIMEOUT_MS);
      const t0 = Date.now();
      try {
        const res = await fetch(`http://127.0.0.1:${port}${STATE_PATH}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: payload,
          signal: controller.signal,
        });
        clearTimeout(timer);
        const elapsed = Date.now() - t0;
        const header = res.headers.get("x-clawd-server");
        debugLog(`POST[${reqId}] port=${port} status=${res.status} header=${header} elapsed=${elapsed}ms`);
        // Port range is unprivileged so another app could answer — require the
        // Clawd identity header before trusting the response.
        if (header === "clawd-on-desk") {
          _cachedPort = port;
          try { await res.text(); } catch {}
          debugLog(`POST[${reqId}] OK port=${port}`);
          return;
        }
      } catch (err) {
        clearTimeout(timer);
        const elapsed = Date.now() - t0;
        debugLog(`POST[${reqId}] port=${port} ERR ${err && err.name}/${err && err.message} elapsed=${elapsed}ms`);
      }
    }
    // All candidates failed — drop the cache so next call re-reads runtime.json.
    debugLog(`POST[${reqId}] EXHAUSTED all candidates failed`);
    _cachedPort = null;
  })().catch((err) => {
    debugLog(`POST[${reqId}] UNCAUGHT ${err && err.message}`);
  });
}

// Clawd uses PascalCase event names matching Claude Code's hook vocabulary so
// state.js transition rules (e.g. SubagentStop → working whitelist) are
// reusable across agents.
function sendState(state, eventName, sessionId) {
  if (!state || !eventName) return;

  if (state === "thinking" && ACTIVE_STATES_BLOCKING_THINKING.has(_lastState)) {
    debugLog(`GATE busy→thinking blocked (lastState=${_lastState}, session=${sessionId})`);
    return;
  }

  if (state === _lastState && sessionId === _lastSessionId) {
    return;
  }

  debugLog(`SEND ${_lastState || "null"} → ${state} event=${eventName} session=${sessionId}`);
  _lastState = state;
  _lastSessionId = sessionId;

  postStateToClawd({
    state,
    session_id: sessionId || "default",
    event: eventName,
    agent_id: AGENT_ID,
  });
}

// Translate an opencode event into a Clawd (state, eventName) pair, or null
// if Clawd should ignore it. Event shape (from runtime dumps):
//   { type: "session.status", properties: { sessionID, status: { type } } }
//   { type: "message.part.updated", properties: { part: { type, tool, state: { status } } } }
function translateEvent(event) {
  if (!event || typeof event.type !== "string") return null;
  const props = event.properties || {};

  switch (event.type) {
    case "session.created":
      return { state: "idle", event: "SessionStart" };

    case "session.status": {
      // Only busy drives thinking. Runtime observations show session.status
      // carries type=busy during activity; session-idle is delivered as a
      // separate "session.idle" event, not as status.type=idle (the latter
      // does appear occasionally but is redundant and safely ignored).
      const type = props.status && props.status.type;
      if (type === "busy") return { state: "thinking", event: "UserPromptSubmit" };
      return null;
    }

    case "message.part.updated": {
      const part = props.part;
      if (!part || typeof part !== "object") return null;

      if (part.type === "tool") {
        // pending → running → completed fires back-to-back; dedup absorbs the
        // repeat so only the first transition actually POSTs.
        const status = part.state && part.state.status;
        if (status === "running") return { state: "working", event: "PreToolUse" };
        if (status === "completed") return { state: "working", event: "PostToolUse" };
        if (status === "error") return { state: "error", event: "PostToolUseFailure" };
        return null;
      }

      if (part.type === "compaction") {
        return { state: "sweeping", event: "PreCompact" };
      }

      return null;
    }

    case "session.compacted":
      return { state: "sweeping", event: "PreCompact" };

    case "session.idle":
      return { state: "attention", event: "Stop" };

    case "session.error":
      return { state: "error", event: "StopFailure" };

    case "session.deleted":
    case "server.instance.disposed":
      return { state: "sleeping", event: "SessionEnd" };

    default:
      return null;
  }
}

// Plugin entrypoint (opencode loads this via default export).
export default async (ctx) => {
  resetDebugLog();
  debugLog(`INIT directory=${ctx && ctx.directory} serverUrl=${ctx && ctx.serverUrl} pid=${process.pid}`);

  return {
    event: async ({ event }) => {
      try {
        if (!event || typeof event.type !== "string") return;
        const mapped = translateEvent(event);
        if (!mapped) {
          // Log ignored session.* events only — they are low-frequency and
          // occasionally useful for diagnosis. message.part.updated ignores
          // are skipped because they would trigger a sync fsync on every
          // text/reasoning/step streaming update (tens per session).
          if (event.type.startsWith("session.")) {
            const statusType = event.properties && event.properties.status && event.properties.status.type;
            debugLog(`IGNORE ${event.type}${statusType ? ` status=${statusType}` : ""}`);
          }
          return;
        }
        const sessionId = (event.properties && event.properties.sessionID) || "default";
        debugLog(`MAP ${event.type} → state=${mapped.state} event=${mapped.event}`);
        sendState(mapped.state, mapped.event, sessionId);
      } catch (err) {
        debugLog(`ERROR in event hook: ${err && err.message}`);
      }
    },
  };
};
