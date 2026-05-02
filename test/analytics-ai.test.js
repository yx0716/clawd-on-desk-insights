const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");

const analyticsAI = require("../src/analytics-ai");

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

function makeAnalytics(config) {
  return analyticsAI({
    getAIConfig: () => config,
    setAIConfig: (next) => { config = next; },
    disableCliDiscoveryForTests: true,
  });
}

function makeDetail(sessionId = "session-1") {
  return {
    sessionId,
    agent: "codex",
    title: "Provider registry test",
    cwd: "/tmp/project",
    timestamps: [Date.now()],
    conversation: [{ role: "user", text: "Summarize provider registry behavior" }],
    userMessages: [{ text: "Summarize provider registry behavior" }],
  };
}

function providerFixture(type, id = `${type}-provider`) {
  return {
    id,
    name: `${type} Registry Provider`,
    type,
    baseUrl: type === "ollama" ? "http://localhost:11434" : `https://${type}.example.com`,
    apiKey: type === "ollama" ? "" : `sk-${type}`,
    model: `${type}-model`,
    enabled: true,
  };
}

function installProviderFetchStub({ content = "Registry one liner", jsonText = null, calls = [] } = {}) {
  global.fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url: String(url), options, body });
    return {
      ok: true,
      text: async () => "",
      json: async () => {
        if (String(url).includes("/v1/messages")) {
          return { content: [{ text: jsonText || content }] };
        }
        if (String(url).includes("/api/chat")) {
          return { message: { content: jsonText || content } };
        }
        return { choices: [{ message: { content: jsonText || content } }] };
      },
    };
  };
  return calls;
}

function expectedProviderUrl(provider) {
  if (provider.type === "claude") return `${provider.baseUrl}/v1/messages`;
  if (provider.type === "ollama") return `${provider.baseUrl}/api/chat`;
  return `${provider.baseUrl}/v1/chat/completions`;
}

describe("analytics AI session context", () => {
  it("builds prompt context from conversation including assistant replies", () => {
    const detail = {
      agent: "codex",
      title: "Fix dashboard",
      cwd: "/tmp/project-alpha",
      timestamps: [
        new Date("2026-04-06T11:44:03.000Z").getTime(),
        new Date("2026-04-06T11:49:03.000Z").getTime(),
      ],
      conversation: [
        { role: "user", text: "时间线有漏抓吗" },
        { role: "assistant", text: "有两个漏点 一个是短会话 一个是 Cursor 时间戳粗粒度" },
      ],
      userMessages: [{ text: "时间线有漏抓吗" }],
    };

    const text = analyticsAI.__test.buildSessionContext(detail);

    assert.match(text, /## Conversation/);
    assert.match(text, /- 用户: 时间线有漏抓吗/);
    assert.match(text, /- 助手: 有两个漏点 一个是短会话 一个是 Cursor 时间戳粗粒度/);
    assert.doesNotMatch(text, /## Activity types/);
  });

  it("counts conversation entries for cache invalidation", () => {
    const detail = {
      conversation: [
        { role: "user", text: "a" },
        { role: "assistant", text: "b" },
        { role: "user", text: "c" },
      ],
      userMessages: [{ text: "a" }],
    };

    assert.strictEqual(analyticsAI.__test.getDetailContextEntryCount(detail), 3);
  });

  it("prefers the saved default analysis provider when available", () => {
    const picked = analyticsAI.__test.resolvePreferredAnalysisProvider(
      [
        { id: "claude-code", label: "Claude Code" },
        { id: "codex", label: "Codex" },
      ],
      { defaultAnalysisProvider: "codex" }
    );

    assert.strictEqual(picked.id, "codex");
  });

  it("falls back to the first available analysis provider when the saved one is missing", () => {
    const picked = analyticsAI.__test.resolvePreferredAnalysisProvider(
      [
        { id: "claude-code", label: "Claude Code" },
        { id: "codex", label: "Codex" },
      ],
      { defaultAnalysisProvider: "api:openai" }
    );

    assert.strictEqual(picked.id, "claude-code");
  });
});

describe("analytics AI Windows CLI shim resolution", () => {
  it("prefers a .cmd sibling over an extensionless npm POSIX shim", () => {
    // `where claude` on Windows lists the extensionless POSIX shim first, but
    // Node spawn() without shell:true throws ENOENT on that file. The .cmd
    // sibling is what actually runs.
    const picked = analyticsAI.__test.preferWindowsExecutable([
      "C:\\Users\\alice\\AppData\\Roaming\\npm\\claude",
      "C:\\Users\\alice\\AppData\\Roaming\\npm\\claude.cmd",
    ]);
    assert.strictEqual(picked, "C:\\Users\\alice\\AppData\\Roaming\\npm\\claude.cmd");
  });

  it("prefers a .exe installer over a .cmd when both are present", () => {
    const picked = analyticsAI.__test.preferWindowsExecutable([
      "C:\\Users\\alice\\AppData\\Roaming\\npm\\claude.cmd",
      "C:\\Program Files\\Claude Code\\claude.exe",
    ]);
    // First hit wins among the Windows-executable extensions; callers pass
    // paths in their own preferred order, so we just keep that order stable.
    assert.strictEqual(picked, "C:\\Users\\alice\\AppData\\Roaming\\npm\\claude.cmd");
  });

  it("falls back to the first path when none have a Windows executable extension", () => {
    const picked = analyticsAI.__test.preferWindowsExecutable([
      "/usr/local/bin/claude",
      "/opt/claude-code/bin/claude",
    ]);
    assert.strictEqual(picked, "/usr/local/bin/claude");
  });

  it("returns null for empty input", () => {
    assert.strictEqual(analyticsAI.__test.preferWindowsExecutable([]), null);
    assert.strictEqual(analyticsAI.__test.preferWindowsExecutable(null), null);
  });
});

describe("analytics AI registry provider resolution", () => {
  it("getSessionOneLiner uses the brief registry provider when available", async () => {
    const provider = providerFixture("openai", "brief-provider");
    const calls = installProviderFetchStub({ content: "\"Registry summary\"" });
    const analytics = makeAnalytics({
      providers: [provider],
      defaultProviders: { brief: provider.id },
    });

    const line = await analytics.getSessionOneLiner(makeDetail());

    assert.strictEqual(line, "Registry summary");
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].url, expectedProviderUrl(provider));
    assert.strictEqual(calls[0].options.headers.Authorization, `Bearer ${provider.apiKey}`);
    assert.strictEqual(calls[0].body.model, provider.model);
  });

  it("getSessionOneLiner returns null without throwing when registry and legacy config are absent", async () => {
    const calls = installProviderFetchStub();
    const analytics = makeAnalytics({ providers: [], defaultProviders: {} });

    const line = await analytics.getSessionOneLiner(makeDetail());

    assert.strictEqual(line, null);
    assert.strictEqual(calls.length, 0);
  });

  it("Property 1: one-liner uses each available registry provider type", async () => {
    for (const type of ["claude", "openai", "ollama"]) {
      const provider = providerFixture(type, `brief-${type}`);
      const calls = installProviderFetchStub({ content: `${type} one liner` });
      const analytics = makeAnalytics({
        providers: [provider],
        defaultProviders: { brief: provider.id },
      });

      const line = await analytics.getSessionOneLiner(makeDetail(`session-${type}`));

      assert.strictEqual(line, `${type} one liner`);
      assert.strictEqual(calls.length, 1, `${type} should call exactly one registry API`);
      assert.strictEqual(calls[0].url, expectedProviderUrl(provider));
      assert.strictEqual(calls[0].body.model, provider.model);
    }
  });

  it("Property 2: one-liner falls back gracefully when no registry provider exists", async () => {
    const configs = [
      {},
      { providers: [] },
      { providers: [], defaultProviders: { brief: "missing" } },
      { providers: [providerFixture("openai", "other")], defaultProviders: { brief: "missing" } },
    ];

    for (let i = 0; i < configs.length; i++) {
      const calls = installProviderFetchStub();
      const analytics = makeAnalytics(configs[i]);

      const line = await analytics.getSessionOneLiner(makeDetail(`missing-${i}`));

      assert.strictEqual(line, null);
      assert.strictEqual(calls.length, 0);
    }
  });

  it("analyzeKnowledgeCompound uses Route 3 registry provider metadata", async () => {
    const provider = providerFixture("openai", "knowledge-provider");
    const calls = installProviderFetchStub({
      jsonText: JSON.stringify({
        topAssets: [{ title: "Registry", sessions: ["S1"], why: "Uses selected backend" }],
        unlinkedConnections: [],
        behaviorObservation: "Uses provider registry",
      }),
    });
    const analytics = makeAnalytics({
      providers: [provider],
      defaultProviders: { detail: provider.id },
    });

    const result = await analytics.analyzeKnowledgeCompound([makeDetail()], { provider: `api:${provider.id}` });

    assert.strictEqual(result._provider, provider.name);
    assert.strictEqual(result._model, provider.model);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].url, expectedProviderUrl(provider));
    assert.strictEqual(calls[0].body.model, provider.model);
  });

  it("analyzeKnowledgeCompound returns an error object when registry and legacy config are absent", async () => {
    const calls = installProviderFetchStub();
    const analytics = makeAnalytics({ providers: [], defaultProviders: {} });

    const result = await analytics.analyzeKnowledgeCompound([makeDetail()], { provider: "api:missing" });

    assert.strictEqual(result.error, true);
    assert.match(result.summary, /API Key|配置/);
    assert.strictEqual(calls.length, 0);
  });

  it("Property 3: knowledge compound uses each available registry provider type", async () => {
    for (const type of ["claude", "openai", "ollama"]) {
      const provider = providerFixture(type, `detail-${type}`);
      const calls = installProviderFetchStub({
        jsonText: JSON.stringify({
          topAssets: [{ title: type, sessions: ["S1"], why: "registry provider selected" }],
          unlinkedConnections: [],
          behaviorObservation: "registry route",
        }),
      });
      const analytics = makeAnalytics({
        providers: [provider],
        defaultProviders: { detail: provider.id },
      });

      const result = await analytics.analyzeKnowledgeCompound([makeDetail(`kc-${type}`)], { provider: `api:${provider.id}` });

      assert.strictEqual(result._provider, provider.name);
      assert.strictEqual(result._model, provider.model);
      assert.strictEqual(calls.length, 1, `${type} should call exactly one registry API`);
      assert.strictEqual(calls[0].url, expectedProviderUrl(provider));
      assert.strictEqual(calls[0].body.model, provider.model);
    }
  });

  it("Property 4: knowledge compound falls back gracefully when no registry provider exists", async () => {
    const configs = [
      {},
      { providers: [] },
      { providers: [], defaultProviders: { detail: "missing" } },
      { providers: [providerFixture("openai", "other")], defaultProviders: { detail: "missing" } },
    ];

    for (let i = 0; i < configs.length; i++) {
      const calls = installProviderFetchStub();
      const analytics = makeAnalytics(configs[i]);

      const result = await analytics.analyzeKnowledgeCompound([makeDetail(`kc-missing-${i}`)], { provider: "api:missing" });

      assert.strictEqual(result.error, true);
      assert.strictEqual(calls.length, 0);
    }
  });
});
