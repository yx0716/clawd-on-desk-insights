const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const serverConfig = require("../hooks/server-config");

const tempDirs = [];

function makeTempHome() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-server-config-"));
  tempDirs.push(tmpDir);
  return tmpDir;
}

afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe("server-config helpers", () => {
  it("clearRuntimeConfig removes runtime.json when present", () => {
    const tmpHome = makeTempHome();
    const runtimeDir = path.join(tmpHome, ".clawd");
    fs.mkdirSync(runtimeDir, { recursive: true });
    const runtimePath = path.join(runtimeDir, "runtime.json");
    fs.writeFileSync(runtimePath, JSON.stringify({ app: "clawd-on-desk", port: 23333 }));

    assert.strictEqual(serverConfig.clearRuntimeConfig(runtimePath), true);
    assert.strictEqual(fs.existsSync(runtimePath), false);
  });

  it("splitPortCandidates prioritizes preferred and runtime ports", () => {
    const result = serverConfig.splitPortCandidates(23335, { runtimePort: 23334 });
    assert.deepStrictEqual(result.direct, [23335, 23334]);
    assert.ok(result.fallback.includes(23333));
    assert.ok(!result.fallback.includes(23334));
    assert.ok(!result.fallback.includes(23335));
  });

  it("probePort recognizes signed Clawd responses", async () => {
    await new Promise((resolve, reject) => {
      const req = {
        on(event, handler) {
          if (event === "error" || event === "timeout") this[`_${event}`] = handler;
        },
        destroy() {},
      };

      serverConfig.probePort(23337, 100, (ok) => {
        try {
          assert.strictEqual(ok, true);
          resolve();
        } catch (err) {
          reject(err);
        }
      }, {
        httpGet(_options, onResponse) {
          const res = {
            headers: { "x-clawd-server": "clawd-on-desk" },
            setEncoding() {},
            on(event, handler) {
              if (event === "data") handler("");
              if (event === "end") handler();
            },
          };
          onResponse(res);
          return req;
        },
      });
    });
  });

  it("postStateToRunningServer probes fallback ports before posting", async () => {
    const probes = [];
    const posts = [];

    await new Promise((resolve, reject) => {
      serverConfig.postStateToRunningServer(
        JSON.stringify({ state: "idle" }),
        {
          timeoutMs: 50,
          preferredPort: 23335,
          runtimePort: 23334,
          probePort(port, _timeoutMs, cb) {
            probes.push(port);
            cb(port === 23336);
          },
          postStateToPort(port, _payload, _timeoutMs, cb) {
            posts.push(port);
            cb(port === 23336, port);
          },
        },
        (ok, port) => {
          try {
            assert.strictEqual(ok, true);
            assert.strictEqual(port, 23336);
            assert.deepStrictEqual(posts, [23335, 23334, 23336]);
            assert.deepStrictEqual(probes, [23333, 23336]);
            resolve();
          } catch (err) {
            reject(err);
          }
        }
      );
    });
  });
});
