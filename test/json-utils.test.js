const { describe, it } = require("node:test");
const assert = require("node:assert");
const { extractExistingNodeBin } = require("../hooks/json-utils");

describe("extractExistingNodeBin", () => {
  it("extracts node path from flat command format", () => {
    const settings = {
      hooks: {
        stop: [{ command: '"/usr/local/bin/node" "/path/to/cursor-hook.js"' }],
      },
    };
    assert.strictEqual(
      extractExistingNodeBin(settings, "cursor-hook.js"),
      "/usr/local/bin/node"
    );
  });

  it("extracts node path from nested format with { nested: true }", () => {
    const settings = {
      hooks: {
        Stop: [{
          matcher: "",
          hooks: [{ type: "command", command: '"/opt/homebrew/bin/node" "/path/to/codebuddy-hook.js"' }],
        }],
      },
    };
    assert.strictEqual(
      extractExistingNodeBin(settings, "codebuddy-hook.js", { nested: true }),
      "/opt/homebrew/bin/node"
    );
  });

  it("returns null for nested format without { nested: true }", () => {
    const settings = {
      hooks: {
        Stop: [{
          matcher: "",
          hooks: [{ type: "command", command: '"/opt/homebrew/bin/node" "/path/to/codebuddy-hook.js"' }],
        }],
      },
    };
    assert.strictEqual(
      extractExistingNodeBin(settings, "codebuddy-hook.js"),
      null
    );
  });

  it("returns null for empty or missing settings", () => {
    assert.strictEqual(extractExistingNodeBin({}, "cursor-hook.js"), null);
    assert.strictEqual(extractExistingNodeBin(null, "cursor-hook.js"), null);
    assert.strictEqual(extractExistingNodeBin({ hooks: {} }, "cursor-hook.js"), null);
  });

  it("returns null when first quoted token is not an absolute path", () => {
    const settings = {
      hooks: {
        stop: [{ command: '"node" "/path/to/cursor-hook.js"' }],
      },
    };
    assert.strictEqual(extractExistingNodeBin(settings, "cursor-hook.js"), null);
  });

  it("skips when first quoted token is the marker itself", () => {
    const settings = {
      hooks: {
        stop: [{ command: '"/path/to/cursor-hook.js"' }],
      },
    };
    assert.strictEqual(extractExistingNodeBin(settings, "cursor-hook.js"), null);
  });
});
