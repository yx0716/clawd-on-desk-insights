const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const CLAWD_SERVER_ID = "clawd-on-desk";
const CLAWD_SERVER_HEADER = "x-clawd-server";
const DEFAULT_SERVER_PORT = 23333;
const SERVER_PORT_COUNT = 5;
const SERVER_PORTS = Array.from({ length: SERVER_PORT_COUNT }, (_, i) => DEFAULT_SERVER_PORT + i);
const STATE_PATH = "/state";
const PERMISSION_PATH = "/permission";
const RUNTIME_CONFIG_PATH = path.join(os.homedir(), ".clawd", "runtime.json");

function normalizePort(value) {
  const port = Number(value);
  return Number.isInteger(port) && SERVER_PORTS.includes(port) ? port : null;
}

function readRuntimeConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(RUNTIME_CONFIG_PATH, "utf8"));
    if (!raw || typeof raw !== "object") return null;
    const port = normalizePort(raw.port);
    return port ? { port } : null;
  } catch {
    return null;
  }
}

function readRuntimePort() {
  const config = readRuntimeConfig();
  return config ? config.port : null;
}

function writeRuntimeConfig(port) {
  const safePort = normalizePort(port);
  if (!safePort) return false;

  const dir = path.dirname(RUNTIME_CONFIG_PATH);
  const tmpPath = path.join(dir, `.runtime.${process.pid}.${Date.now()}.tmp`);
  const body = JSON.stringify({ app: CLAWD_SERVER_ID, port: safePort }, null, 2);
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.writeFileSync(tmpPath, body, "utf8");
    fs.renameSync(tmpPath, RUNTIME_CONFIG_PATH);
    return true;
  } catch {
    try { fs.unlinkSync(tmpPath); } catch {}
    return false;
  }
}

function getPortCandidates(preferredPort) {
  const ports = [];
  const seen = new Set();
  const add = (value) => {
    const port = normalizePort(value);
    if (!port || seen.has(port)) return;
    seen.add(port);
    ports.push(port);
  };

  if (Array.isArray(preferredPort)) preferredPort.forEach(add);
  else add(preferredPort);
  add(readRuntimePort());
  SERVER_PORTS.forEach(add);
  return ports;
}

function buildPermissionUrl(port) {
  const safePort = normalizePort(port) || DEFAULT_SERVER_PORT;
  return `http://127.0.0.1:${safePort}${PERMISSION_PATH}`;
}

function readHeader(res, headerName) {
  const value = res.headers && res.headers[headerName];
  return Array.isArray(value) ? value[0] : value;
}

function isClawdResponse(res, body) {
  if (readHeader(res, CLAWD_SERVER_HEADER) === CLAWD_SERVER_ID) return true;
  if (!body) return false;
  try {
    const data = JSON.parse(body);
    return data && data.app === CLAWD_SERVER_ID;
  } catch {
    return false;
  }
}

function discoverClawdPort(options, callback) {
  const timeoutMs = options && options.timeoutMs ? options.timeoutMs : 100;
  const ports = getPortCandidates(options && options.preferredPort);
  let index = 0;

  const tryNext = () => {
    if (index >= ports.length) {
      callback(null);
      return;
    }

    const port = ports[index++];
    const req = http.get(
      { hostname: "127.0.0.1", port, path: STATE_PATH, timeout: timeoutMs },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          if (body.length < 256) body += chunk;
        });
        res.on("end", () => {
          if (isClawdResponse(res, body)) {
            callback(port);
            return;
          }
          tryNext();
        });
      }
    );

    req.on("error", () => tryNext());
    req.on("timeout", () => {
      req.destroy();
      tryNext();
    });
  };

  tryNext();
}

function postStateToRunningServer(body, options, callback) {
  const timeoutMs = options && options.timeoutMs ? options.timeoutMs : 100;
  const ports = getPortCandidates(options && options.preferredPort);
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  let index = 0;

  const tryNext = () => {
    if (index >= ports.length) {
      callback(false, null);
      return;
    }

    const port = ports[index++];
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: STATE_PATH,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
        timeout: timeoutMs,
      },
      (res) => {
        if (readHeader(res, CLAWD_SERVER_HEADER) === CLAWD_SERVER_ID) {
          res.resume();
          callback(true, port);
          return;
        }

        let responseBody = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          if (responseBody.length < 256) responseBody += chunk;
        });
        res.on("end", () => {
          if (isClawdResponse(res, responseBody)) {
            callback(true, port);
            return;
          }
          tryNext();
        });
      }
    );

    req.on("error", () => tryNext());
    req.on("timeout", () => {
      req.destroy();
      tryNext();
    });
    req.end(payload);
  };

  tryNext();
}

module.exports = {
  CLAWD_SERVER_HEADER,
  CLAWD_SERVER_ID,
  DEFAULT_SERVER_PORT,
  PERMISSION_PATH,
  RUNTIME_CONFIG_PATH,
  SERVER_PORTS,
  STATE_PATH,
  buildPermissionUrl,
  discoverClawdPort,
  getPortCandidates,
  postStateToRunningServer,
  readRuntimePort,
  writeRuntimeConfig,
};
