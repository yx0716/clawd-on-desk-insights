"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

const prefs = require("../src/prefs");

const tempDirs = [];

function makeTempPath(name = "clawd-prefs.json") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-prefs-"));
  tempDirs.push(dir);
  return path.join(dir, name);
}

afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe("prefs.getDefaults", () => {
  it("returns a fresh snapshot every call (no shared object refs)", () => {
    const a = prefs.getDefaults();
    const b = prefs.getDefaults();
    assert.notStrictEqual(a, b);
    assert.notStrictEqual(a.agents, b.agents);
    assert.notStrictEqual(a.themeOverrides, b.themeOverrides);
    // Mutating one shouldn't affect the other
    a.agents["claude-code"].enabled = false;
    assert.strictEqual(b.agents["claude-code"].enabled, true);
  });

  it("includes the current schema version", () => {
    const d = prefs.getDefaults();
    assert.strictEqual(d.version, prefs.CURRENT_VERSION);
  });

  it("seeds all known agents as enabled", () => {
    const d = prefs.getDefaults();
    for (const id of ["claude-code", "codex", "copilot-cli", "cursor-agent", "gemini-cli", "codebuddy", "kiro-cli", "opencode"]) {
      assert.strictEqual(d.agents[id].enabled, true, `${id} should default enabled`);
    }
  });

  it("seeds all known agents with permissionsEnabled=true", () => {
    const d = prefs.getDefaults();
    for (const id of ["claude-code", "codex", "copilot-cli", "cursor-agent", "gemini-cli", "codebuddy", "kiro-cli", "opencode"]) {
      assert.strictEqual(
        d.agents[id].permissionsEnabled,
        true,
        `${id} should default permissionsEnabled`
      );
    }
  });
});

describe("prefs.validate", () => {
  it("drops bad fields and falls back to defaults", () => {
    const v = prefs.validate({
      lang: "klingon",       // not in enum
      soundMuted: "yes",     // wrong type
      x: NaN,                // not finite
      bubbleFollowPet: true, // ok
      hideBubbles: 0,        // wrong type
    });
    const d = prefs.getDefaults();
    assert.strictEqual(v.lang, d.lang);
    assert.strictEqual(v.soundMuted, false);
    assert.strictEqual(v.x, 0);
    assert.strictEqual(v.bubbleFollowPet, true);
    assert.strictEqual(v.hideBubbles, false);
  });

  it("keeps valid fields verbatim", () => {
    const v = prefs.validate({
      lang: "zh",
      soundMuted: true,
      bubbleFollowPet: true,
      x: 100,
      y: -50,
      size: "P:15",
      miniEdge: "left",
      theme: "calico",
    });
    assert.strictEqual(v.lang, "zh");
    assert.strictEqual(v.soundMuted, true);
    assert.strictEqual(v.bubbleFollowPet, true);
    assert.strictEqual(v.x, 100);
    assert.strictEqual(v.y, -50);
    assert.strictEqual(v.size, "P:15");
    assert.strictEqual(v.miniEdge, "left");
    assert.strictEqual(v.theme, "calico");
  });

  it("keeps dashboard AI config fields", () => {
    const v = prefs.validate({
      aiConfig: {
        provider: "openai",        // legacy — stripped by normalizeAIConfig at v3
        defaultAnalysisProvider: "codex",
        apiKey: "sk-test",         // legacy — stripped
        baseUrl: "https://example.com/v1", // legacy — stripped
        model: "gpt-test",         // legacy — stripped
        customCliPaths: {
          claude: "/usr/local/bin/claude",
          codex: "/usr/local/bin/codex",
        },
        ignored: true,
      },
    });
    // Only non-legacy fields survive normalizeAIConfig
    assert.deepStrictEqual(v.aiConfig, {
      defaultAnalysisProvider: "codex",
      customCliPaths: {
        claude: "/usr/local/bin/claude",
        codex: "/usr/local/bin/codex",
      },
    });
  });

  it("normalizes agents (drops malformed entries)", () => {
    const v = prefs.validate({
      agents: {
        "claude-code": { enabled: false },
        "bogus-entry": "not an object",
        "codex": { enabled: "true" }, // wrong type — should be dropped
      },
    });
    assert.strictEqual(v.agents["claude-code"].enabled, false);
    // bogus + bad codex use defaults
    assert.strictEqual(v.agents.codex.enabled, true);
    assert.strictEqual(v.agents["bogus-entry"], undefined);
  });

  it("normalizes agents: preserves permissionsEnabled flag", () => {
    const v = prefs.validate({
      agents: {
        "claude-code": { enabled: true, permissionsEnabled: false },
      },
    });
    assert.strictEqual(v.agents["claude-code"].enabled, true);
    assert.strictEqual(v.agents["claude-code"].permissionsEnabled, false);
  });

  it("normalizes agents: fills missing permissionsEnabled from defaults", () => {
    // Pre-subgate prefs files only have { enabled: bool }. Normalization
    // must NOT strip them, but must also NOT invent permissionsEnabled=false
    // — defaults are true, and the gate reads "missing flag" as true anyway.
    const v = prefs.validate({
      agents: {
        "claude-code": { enabled: false },
      },
    });
    assert.strictEqual(v.agents["claude-code"].enabled, false);
    assert.strictEqual(v.agents["claude-code"].permissionsEnabled, true);
  });

  it("normalizes agents: drops non-boolean permissionsEnabled, keeps valid enabled", () => {
    const v = prefs.validate({
      agents: {
        "claude-code": { enabled: false, permissionsEnabled: "nope" },
      },
    });
    assert.strictEqual(v.agents["claude-code"].enabled, false);
    // Bad flag falls back to the default for that agent (true), not dropped
    // altogether — the entry has a valid flag so it survives.
    assert.strictEqual(v.agents["claude-code"].permissionsEnabled, true);
  });

  it("returns defaults for null/non-object input", () => {
    const a = prefs.validate(null);
    const b = prefs.validate("not an object");
    const d = prefs.getDefaults();
    assert.deepStrictEqual(a, d);
    assert.deepStrictEqual(b, d);
  });
});

describe("prefs.migrate", () => {
  it("upgrades v0 (no version field) to v1", () => {
    const raw = { lang: "zh", soundMuted: true };
    const upgraded = prefs.migrate(raw);
    assert.strictEqual(upgraded.version, 3);
    assert.ok(upgraded.agents && typeof upgraded.agents === "object");
    assert.ok(upgraded.themeOverrides && typeof upgraded.themeOverrides === "object");
    // Original fields preserved
    assert.strictEqual(upgraded.lang, "zh");
    assert.strictEqual(upgraded.soundMuted, true);
  });

  it("leaves v1 files alone", () => {
    const raw = {
      version: 1,
      lang: "en",
      agents: { "claude-code": { enabled: false } },
    };
    const upgraded = prefs.migrate(raw);
    assert.strictEqual(upgraded.version, 3);
    assert.strictEqual(upgraded.agents["claude-code"].enabled, false);
  });

  it("backfills positionSaved=true for files with non-zero x/y", () => {
    const raw = { version: 1, x: 500, y: 300 };
    const upgraded = prefs.migrate(raw);
    assert.strictEqual(upgraded.positionSaved, true);
  });

  it("backfills positionSaved=false for files with x=0,y=0", () => {
    const raw = { version: 1, x: 0, y: 0 };
    const upgraded = prefs.migrate(raw);
    assert.strictEqual(upgraded.positionSaved, false);
  });

  it("does not overwrite existing positionSaved field", () => {
    const raw = { version: 1, x: 0, y: 0, positionSaved: true };
    const upgraded = prefs.migrate(raw);
    assert.strictEqual(upgraded.positionSaved, true);
  });

  it("v2→v3: removes legacy flat fields from aiConfig", () => {
    const raw = {
      version: 2,
      aiConfig: {
        provider: "openai",
        apiKey: "sk-test",
        baseUrl: "https://api.example.com",
        model: "gpt-4o-mini",
        defaultAnalysisProvider: "codex",
        providers: [{ id: "abc", name: "Test", type: "openai", baseUrl: "https://x.com", apiKey: "k", model: "m", enabled: true }],
      },
    };
    const upgraded = prefs.migrate(raw);
    assert.strictEqual(upgraded.version, 3);
    assert.strictEqual(upgraded.aiConfig.provider, undefined);
    assert.strictEqual(upgraded.aiConfig.apiKey, undefined);
    assert.strictEqual(upgraded.aiConfig.baseUrl, undefined);
    assert.strictEqual(upgraded.aiConfig.model, undefined);
    // Non-legacy fields preserved
    assert.strictEqual(upgraded.aiConfig.defaultAnalysisProvider, "codex");
    assert.strictEqual(upgraded.aiConfig.providers.length, 1);
  });

  it("v2→v3: handles aiConfig with no legacy fields gracefully", () => {
    const raw = { version: 2, aiConfig: { providers: [], defaultProviders: {} } };
    const upgraded = prefs.migrate(raw);
    assert.strictEqual(upgraded.version, 3);
    assert.ok(Array.isArray(upgraded.aiConfig.providers));
  });

  it("v2→v3: handles missing aiConfig without throwing", () => {
    const raw = { version: 2 };
    const upgraded = prefs.migrate(raw);
    assert.strictEqual(upgraded.version, 3);
  });

  it("v2→v3: is idempotent on v3 snapshots", () => {
    const raw = { version: 3, aiConfig: { providers: [], defaultProviders: {} } };
    const once = prefs.migrate(raw);
    const twice = prefs.migrate(once);
    assert.deepStrictEqual(once, twice);
  });

  it("v1→v3: full chain preserves migrated provider and removes legacy fields", () => {
    const raw = {
      version: 1,
      aiConfig: { provider: "claude", apiKey: "sk-ant-test", model: "claude-haiku-4-5-20251001" },
    };
    const upgraded = prefs.migrate(raw);
    assert.strictEqual(upgraded.version, 3);
    // Legacy fields removed
    assert.strictEqual(upgraded.aiConfig.provider, undefined);
    assert.strictEqual(upgraded.aiConfig.apiKey, undefined);
    assert.strictEqual(upgraded.aiConfig.model, undefined);
    // Provider promoted into registry
    assert.ok(Array.isArray(upgraded.aiConfig.providers));
    assert.strictEqual(upgraded.aiConfig.providers.length, 1);
    assert.strictEqual(upgraded.aiConfig.providers[0].type, "claude");
  });

  it("Property 5: v2→v3 migration removes legacy fields and bumps version", () => {
    const legacyFields = {
      provider: "openai",
      apiKey: "sk-test",
      baseUrl: "https://api.example.com",
      model: "gpt-4o-mini",
    };

    for (let mask = 0; mask < 16; mask++) {
      const aiConfig = {
        providers: [{ id: "p1", name: "Provider", type: "openai" }],
        defaultProviders: { brief: "p1" },
      };
      Object.keys(legacyFields).forEach((key, idx) => {
        if (mask & (1 << idx)) aiConfig[key] = legacyFields[key];
      });

      const upgraded = prefs.migrate({ version: 2, aiConfig });

      assert.strictEqual(upgraded.version, 3);
      for (const key of Object.keys(legacyFields)) {
        assert.strictEqual(Object.prototype.hasOwnProperty.call(upgraded.aiConfig, key), false, `${key} should be removed`);
      }
    }
  });

  it("Property 6: v2→v3 migration preserves the providers array", () => {
    const providerSets = [
      [],
      [{ id: "p1", name: "One", type: "openai", model: "m1" }],
      [
        { id: "p1", name: "One", type: "openai", model: "m1" },
        { id: "p2", name: "Two", type: "ollama", model: "m2" },
      ],
    ];

    for (const providers of providerSets) {
      const raw = {
        version: 2,
        aiConfig: {
          provider: "openai",
          apiKey: "sk-test",
          providers,
          defaultProviders: { detail: providers[0] ? providers[0].id : "" },
        },
      };

      const upgraded = prefs.migrate(raw);

      assert.strictEqual(upgraded.version, 3);
      assert.deepStrictEqual(upgraded.aiConfig.providers, providers);
    }
  });

  it("Property 7: migrate() is idempotent on v3 snapshots", () => {
    const snapshots = [
      { version: 3 },
      { version: 3, aiConfig: { providers: [], defaultProviders: {} } },
      {
        version: 3,
        lang: "zh",
        aiConfig: {
          defaultAnalysisProvider: "codex",
          customCliPaths: { codex: "/opt/bin/codex" },
          providers: [{ id: "p1", name: "One", type: "openai" }],
          defaultProviders: { brief: "p1" },
        },
      },
    ];

    for (const snapshot of snapshots) {
      const once = prefs.migrate(snapshot);
      const twice = prefs.migrate(once);
      assert.deepStrictEqual(twice, once);
    }
  });

  it("Property 8: full migration chain v1→v3 preserves migrated provider", () => {
    const legacyConfigs = [
      { provider: "claude", apiKey: "sk-ant-test", baseUrl: "https://claude.example.com", model: "claude-test" },
      { provider: "openai", apiKey: "sk-openai-test", baseUrl: "https://openai.example.com", model: "gpt-test" },
      { provider: "ollama", baseUrl: "http://localhost:11434", model: "llama-test" },
    ];

    for (const legacy of legacyConfigs) {
      const upgraded = prefs.migrate({ version: 1, aiConfig: legacy });
      const providerId = `legacy-${legacy.provider}-migrated`;

      assert.strictEqual(upgraded.version, 3);
      assert.strictEqual(upgraded.aiConfig.providers.length, 1);
      assert.strictEqual(upgraded.aiConfig.providers[0].id, providerId);
      assert.strictEqual(upgraded.aiConfig.providers[0].type, legacy.provider);
      assert.strictEqual(upgraded.aiConfig.providers[0].model, legacy.model);
      assert.deepStrictEqual(upgraded.aiConfig.defaultProviders, {
        brief: providerId,
        detail: providerId,
        batch: providerId,
      });
      for (const key of ["provider", "apiKey", "baseUrl", "model"]) {
        assert.strictEqual(Object.prototype.hasOwnProperty.call(upgraded.aiConfig, key), false, `${key} should be removed`);
      }
    }
  });

  it("Property 9: migrate() handles missing or empty aiConfig without throwing", () => {
    const snapshots = [
      { version: 2 },
      { version: 2, aiConfig: null },
      { version: 2, aiConfig: {} },
      { version: 2, aiConfig: [] },
    ];

    for (const snapshot of snapshots) {
      assert.doesNotThrow(() => prefs.migrate(snapshot));
      assert.strictEqual(prefs.migrate(snapshot).version, 3);
    }
  });
});

describe("prefs.load", () => {
  it("returns defaults for missing file (ENOENT) without backup", () => {
    const p = makeTempPath();
    const { snapshot, locked } = prefs.load(p);
    assert.strictEqual(locked, false);
    assert.deepStrictEqual(snapshot, prefs.getDefaults());
    // Should NOT have created a backup since file never existed
    assert.strictEqual(fs.existsSync(p + ".bak"), false);
  });

  it("backs up corrupt JSON and returns defaults", () => {
    const p = makeTempPath();
    fs.writeFileSync(p, "{ this is not valid json", "utf8");
    const { snapshot, locked } = prefs.load(p);
    assert.strictEqual(locked, false);
    assert.deepStrictEqual(snapshot, prefs.getDefaults());
    assert.strictEqual(fs.existsSync(p + ".bak"), true);
    assert.strictEqual(
      fs.readFileSync(p + ".bak", "utf8"),
      "{ this is not valid json"
    );
  });

  it("migrates a v0 file (no version field) on load", () => {
    const p = makeTempPath();
    fs.writeFileSync(
      p,
      JSON.stringify({ lang: "zh", x: 100, y: 200, size: "P:12" }),
      "utf8"
    );
    const { snapshot, locked } = prefs.load(p);
    assert.strictEqual(locked, false);
    assert.strictEqual(snapshot.version, 3);
    assert.strictEqual(snapshot.lang, "zh");
    assert.strictEqual(snapshot.x, 100);
    assert.strictEqual(snapshot.y, 200);
    assert.strictEqual(snapshot.size, "P:12");
    // New fields populated from defaults
    assert.ok(snapshot.agents);
    assert.ok(snapshot.themeOverrides);
  });

  it("returns locked=true and warns for future-version files", () => {
    const p = makeTempPath();
    fs.writeFileSync(
      p,
      JSON.stringify({ version: 999, lang: "en" }),
      "utf8"
    );
    const originalWarn = console.warn;
    let warned = false;
    console.warn = () => { warned = true; };
    try {
      const { snapshot, locked } = prefs.load(p);
      assert.strictEqual(locked, true);
      assert.strictEqual(snapshot.lang, "en");
      assert.strictEqual(warned, true);
    } finally {
      console.warn = originalWarn;
    }
  });
});

describe("prefs.save", () => {
  it("writes a valid snapshot that round-trips through load", () => {
    const p = makeTempPath();
    const snap = prefs.getDefaults();
    snap.lang = "zh";
    snap.bubbleFollowPet = true;
    snap.x = 42;
    prefs.save(p, snap);
    const { snapshot } = prefs.load(p);
    assert.strictEqual(snapshot.lang, "zh");
    assert.strictEqual(snapshot.bubbleFollowPet, true);
    assert.strictEqual(snapshot.x, 42);
    assert.strictEqual(snapshot.version, 3);
  });

  it("validates before writing — bad fields fall back to defaults on disk", () => {
    const p = makeTempPath();
    const dirty = {
      ...prefs.getDefaults(),
      lang: "klingon",
      x: NaN,
    };
    prefs.save(p, dirty);
    const written = JSON.parse(fs.readFileSync(p, "utf8"));
    assert.strictEqual(written.lang, "en");
    assert.strictEqual(written.x, 0);
  });

  it("round-trips themeOverrides with disabled: true", () => {
    const p = makeTempPath();
    const snap = prefs.getDefaults();
    snap.themeOverrides = {
      clawd: {
        sweeping: { disabled: true },
      },
    };
    prefs.save(p, snap);
    const { snapshot } = prefs.load(p);
    assert.deepStrictEqual(snapshot.themeOverrides.clawd.sweeping, { disabled: true });
  });

  it("round-trips aiConfig through save/load", () => {
    const p = makeTempPath();
    const snap = prefs.getDefaults();
    snap.aiConfig = {
      defaultAnalysisProvider: "codex",
      customCliPaths: { codex: "/opt/bin/codex" },
    };
    prefs.save(p, snap);
    const { snapshot } = prefs.load(p);
    assert.deepStrictEqual(snapshot.aiConfig, {
      defaultAnalysisProvider: "codex",
      customCliPaths: { codex: "/opt/bin/codex" },
    });
  });

  it("themeOverrides: disabled wins over file when both present on same key", () => {
    const p = makeTempPath();
    const snap = prefs.getDefaults();
    snap.themeOverrides = {
      clawd: {
        attention: {
          disabled: true,
          sourceThemeId: "clawd",
          file: "clawd-happy.svg",
        },
      },
    };
    prefs.save(p, snap);
    const { snapshot } = prefs.load(p);
    assert.deepStrictEqual(snapshot.themeOverrides.clawd.attention, { disabled: true });
  });

  it("themeOverrides: file-form entry round-trips unchanged when disabled is absent/false", () => {
    const p = makeTempPath();
    const snap = prefs.getDefaults();
    snap.themeOverrides = {
      clawd: {
        attention: {
          disabled: false,
          sourceThemeId: "clawd",
          file: "clawd-happy.svg",
        },
      },
    };
    prefs.save(p, snap);
    const { snapshot } = prefs.load(p);
    assert.deepStrictEqual(snapshot.themeOverrides.clawd.attention, {
      sourceThemeId: "clawd",
      file: "clawd-happy.svg",
    });
  });
});
