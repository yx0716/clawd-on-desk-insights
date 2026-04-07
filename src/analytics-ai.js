// src/analytics-ai.js — Multi-provider AI insights (Claude, OpenAI-compatible, Ollama)
//
// Supported providers:
//   "claude"   — Anthropic Claude API (api.anthropic.com)
//   "openai"   — OpenAI-compatible API (also works with Qwen, DeepSeek, etc.)
//   "ollama"   — Local Ollama (default http://localhost:11434)

const { execFileSync, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const net = require("net");

// Default provider configs
const PROVIDERS = {
  claude: {
    label: "Claude (Anthropic)",
    baseUrl: "https://api.anthropic.com",
    defaultModel: "claude-haiku-4-5-20251001",
    needsKey: true,
  },
  openai: {
    label: "OpenAI-Compatible (Qwen, DeepSeek, etc.)",
    baseUrl: "https://api.openai.com",
    defaultModel: "gpt-4o-mini",
    needsKey: true,
  },
  ollama: {
    label: "Ollama (Local)",
    baseUrl: "http://localhost:11434",
    defaultModel: "qwen2.5:7b",
    needsKey: false,
  },
};

module.exports = function initAnalyticsAI(ctx) {
  const isWin = process.platform === "win32";
  let cachedInsights = null;
  let cacheExpiry = 0;
  const CACHE_TTL = 15 * 60 * 1000; // 15 minutes
  const PROVIDER_COOLDOWN_MS = 5 * 60 * 1000;
  const providerCooldowns = new Map();
  const loggedCliBinaries = new Set();
  const loggedProviderCooldowns = new Set();
  const loggedProxyStrips = new Set();

  function getConfig() {
    return ctx.getAIConfig ? ctx.getAIConfig() : null;
  }

  function setConfig(config) {
    if (ctx.setAIConfig) ctx.setAIConfig(config);
    cachedInsights = null;
    cacheExpiry = 0;
  }

  // Legacy compat
  function getApiKey() {
    const cfg = getConfig();
    return cfg ? cfg.apiKey : null;
  }

  function setApiKey(key) {
    const cfg = getConfig() || { provider: "claude" };
    cfg.apiKey = key;
    setConfig(cfg);
  }

  function formatDuration(ms) {
    if (ms < 60000) return `${Math.round(ms / 1000)}s`;
    if (ms < 3600000) return `${Math.round(ms / 60000)}m`;
    return `${(ms / 3600000).toFixed(1)}h`;
  }

  function sortedEntries(obj) {
    return Object.entries(obj || {}).sort((a, b) => b[1] - a[1]);
  }

  function buildPrompt(todayData, weekData) {
    let p = "Analyze this AI coding agent usage data collected from desktop pet hooks and provide productivity insights.\n\n";

    // ── Today detail ──
    p += "## Today's Activity\n";
    p += `- Date: ${todayData.date}\n`;
    p += `- Active time: ${formatDuration(todayData.activeTime)} (working+thinking+juggling+sweeping+carrying)\n`;
    p += `- Total tracked time: ${formatDuration(todayData.totalTime)}\n`;
    p += `- Sessions: ${todayData.sessionCount}, Total events: ${todayData.totalEvents}, Errors: ${todayData.errorCount}\n`;

    p += "\n### Time by State\n";
    for (const [state, ms] of sortedEntries(todayData.stateTotals)) {
      p += `  - ${state}: ${formatDuration(ms)}\n`;
    }

    p += "\n### Time by Agent\n";
    for (const [agent, ms] of sortedEntries(todayData.agentTotals)) {
      p += `  - ${agent}: ${formatDuration(ms)}\n`;
    }

    if (Object.keys(todayData.projectTotals || {}).length) {
      p += "\n### Time by Project (working directory)\n";
      for (const [proj, ms] of sortedEntries(todayData.projectTotals)) {
        p += `  - ${proj}: ${formatDuration(ms)}\n`;
      }
    }

    if (Object.keys(todayData.eventCounts || {}).length) {
      p += "\n### Hook Event Frequency\n";
      for (const [ev, n] of sortedEntries(todayData.eventCounts)) {
        p += `  - ${ev}: ${n}x\n`;
      }
    }

    if (Object.keys(todayData.toolHintCounts || {}).length) {
      p += "\n### Tool Types Detected\n";
      for (const [hint, n] of sortedEntries(todayData.toolHintCounts)) {
        p += `  - ${hint}: ${n}x\n`;
      }
    }

    // Hourly activity summary (non-zero hours only)
    if (todayData.hourly) {
      const activeHours = todayData.hourly
        .map((h, i) => ({ hour: i, total: Object.values(h).reduce((a, b) => a + b, 0) }))
        .filter(h => h.total > 0);
      if (activeHours.length) {
        p += "\n### Hourly Activity\n";
        for (const { hour, total } of activeHours) {
          const breakdown = Object.entries(todayData.hourly[hour])
            .sort((a, b) => b[1] - a[1])
            .map(([s, ms]) => `${s}:${formatDuration(ms)}`)
            .join(", ");
          p += `  - ${hour}:00: ${formatDuration(total)} (${breakdown})\n`;
        }
      }
    }

    // Session details
    if (todayData.sessions && todayData.sessions.length) {
      p += "\n### Session Details\n";
      for (const s of todayData.sessions.slice(0, 10)) {
        p += `  - [${s.agent}] ${s.project}: ${s.eventCount} events, ${formatDuration(s.totalActive)} active, span ${formatDuration(s.duration)}\n`;
      }
    }

    // ── Week overview ──
    if (weekData && weekData.days) {
      p += "\n## This Week Overview\n";
      p += `- Total active: ${formatDuration(weekData.weekActiveTime)}, Total tracked: ${formatDuration(weekData.weekTotalTime)}\n`;
      p += `- Sessions: ${weekData.weekSessions}, Events: ${weekData.weekTotalEvents}, Errors: ${weekData.weekErrors}\n`;

      p += "\n### Daily Breakdown\n";
      for (const day of weekData.days) {
        const topStates = sortedEntries(day.stateTotals).slice(0, 3).map(([s, ms]) => `${s}:${formatDuration(ms)}`).join(", ");
        p += `  - ${day.date} (${day.dayLabel}): active ${formatDuration(day.activeTime)}, total ${formatDuration(day.totalTime)}, ${day.sessionCount} sessions [${topStates}]\n`;
      }

      if (Object.keys(weekData.weekProjectTotals || {}).length) {
        p += "\n### Weekly Project Totals\n";
        for (const [proj, ms] of sortedEntries(weekData.weekProjectTotals)) {
          p += `  - ${proj}: ${formatDuration(ms)}\n`;
        }
      }

      if (Object.keys(weekData.weekAgentTotals || {}).length) {
        p += "\n### Weekly Agent Totals\n";
        for (const [agent, ms] of sortedEntries(weekData.weekAgentTotals)) {
          p += `  - ${agent}: ${formatDuration(ms)}\n`;
        }
      }
    }

    p += "\nProvide a JSON response with exactly this structure:\n";
    p += '{"summary":"2-3 sentence overview of work patterns","highlights":["insight1","insight2","insight3"],"suggestions":["actionable suggestion1","actionable suggestion2"]}\n';
    p += "Focus on: productivity patterns, peak productive hours, project focus vs context-switching, error patterns, work/rest balance, agent efficiency comparison, and any unusual patterns.";

    return p;
  }

  // ── Provider-specific request builders ──

  async function callClaude(apiKey, model, prompt) {
    const cfg = getConfig() || {};
    const baseUrl = cfg.baseUrl || PROVIDERS.claude.baseUrl;
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: model || PROVIDERS.claude.defaultModel,
        max_tokens: 500,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Claude API ${response.status}: ${errText.slice(0, 200)}`);
    }

    const data = await response.json();
    return data.content && data.content[0] && data.content[0].text;
  }

  async function callOpenAICompat(apiKey, model, prompt, baseUrl) {
    const url = baseUrl || PROVIDERS.openai.baseUrl;
    const headers = { "Content-Type": "application/json" };
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

    const response = await fetch(`${url}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: model || PROVIDERS.openai.defaultModel,
        max_tokens: 500,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`API ${response.status}: ${errText.slice(0, 200)}`);
    }

    const data = await response.json();
    return data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  }

  async function callOllama(model, prompt, baseUrl) {
    const url = baseUrl || PROVIDERS.ollama.baseUrl;
    const response = await fetch(`${url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: model || PROVIDERS.ollama.defaultModel,
        messages: [{ role: "user", content: prompt }],
        stream: false,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Ollama ${response.status}: ${errText.slice(0, 200)}`);
    }

    const data = await response.json();
    return data.message && data.message.content;
  }

  function uniqueExistingPaths(candidates) {
    const seen = new Set();
    const results = [];
    for (const file of candidates || []) {
      if (!file || seen.has(file)) continue;
      seen.add(file);
      if (fs.existsSync(file)) results.push(file);
    }
    return results;
  }

  function getCommonCliSearchDirs() {
    const home = os.homedir();
    const dirs = [
      path.join(home, ".npm-global", "bin"),
      path.join(home, ".local", "bin"),
    ];
    if (isWin) {
      const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
      dirs.unshift(path.join(appData, "npm"));
    } else {
      dirs.unshift("/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin");
    }
    return uniqueExistingPaths(dirs);
  }

  function buildCliEnv(extraEnv = {}) {
    const env = { ...process.env, ...extraEnv };
    const delimiter = path.delimiter;
    const current = String(env.PATH || "").split(delimiter).filter(Boolean);
    env.PATH = [...new Set([...getCommonCliSearchDirs(), ...current])].join(delimiter);
    return env;
  }

  const PROXY_ENV_KEYS = [
    "HTTPS_PROXY",
    "https_proxy",
    "HTTP_PROXY",
    "http_proxy",
    "ALL_PROXY",
    "all_proxy",
  ];

  function parseProxyUrl(value) {
    if (!value) return null;
    try {
      const url = new URL(String(value));
      const protocol = url.protocol.replace(/:$/, "");
      const defaultPort = protocol === "https" ? 443 : protocol.startsWith("socks") ? 1080 : 80;
      const port = Number(url.port || defaultPort);
      if (!url.hostname || !port) return null;
      return { host: url.hostname, port, protocol, raw: String(value) };
    } catch {
      return null;
    }
  }

  function isLoopbackHost(host) {
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
  }

  function canConnect(host, port, timeoutMs = 400) {
    return new Promise(resolve => {
      let settled = false;
      const socket = net.createConnection({ host, port });
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        try { socket.destroy(); } catch { /* ignore */ }
        resolve(ok);
      };
      socket.setTimeout(timeoutMs);
      socket.once("connect", () => finish(true));
      socket.once("timeout", () => finish(false));
      socket.once("error", () => finish(false));
    });
  }

  async function sanitizeCliProxyEnv(env, cliName) {
    const nextEnv = { ...env };
    const proxyEntries = PROXY_ENV_KEYS
      .map(key => ({ key, parsed: parseProxyUrl(nextEnv[key]) }))
      .filter(entry => entry.parsed && isLoopbackHost(entry.parsed.host));
    if (!proxyEntries.length) return nextEnv;

    const reachability = new Map();
    for (const entry of proxyEntries) {
      const target = `${entry.parsed.host}:${entry.parsed.port}`;
      if (!reachability.has(target)) {
        reachability.set(target, await canConnect(entry.parsed.host, entry.parsed.port));
      }
    }

    for (const entry of proxyEntries) {
      const target = `${entry.parsed.host}:${entry.parsed.port}`;
      if (reachability.get(target)) continue;
      delete nextEnv[entry.key];
      const logKey = `${cliName}:${entry.key}:${target}`;
      if (!loggedProxyStrips.has(logKey)) {
        loggedProxyStrips.add(logKey);
        console.warn(`Clawd analytics: ignoring unavailable local proxy ${target} for ${cliName}`);
      }
    }

    return nextEnv;
  }

  function isWindowsShellShim(filePath) {
    return isWin && /\.(cmd|bat)$/i.test(filePath || "");
  }

  function spawnCli(filePath, args, options = {}) {
    return spawn(filePath, args, {
      ...options,
      shell: options.shell ?? isWindowsShellShim(filePath),
    });
  }

  function parseLocatorOutput(output) {
    return String(output || "")
      .split(/\r?\n/)
      .map(line => line.trim().replace(/^"+|"+$/g, ""))
      .filter(Boolean);
  }

  function findOnPath(commandName) {
    try {
      const lookupCmd = isWin ? "where" : "which";
      const result = execFileSync(lookupCmd, [commandName], {
        encoding: "utf8",
        timeout: 3000,
        env: buildCliEnv(),
      });
      const lines = parseLocatorOutput(result);
      const hit = lines.find(file => fs.existsSync(file));
      if (hit) return hit;
    } catch { /* not in PATH */ }
    return null;
  }

  function findInLoginShell(commandName) {
    if (isWin) return null;
    try {
      const shell = process.env.SHELL || "/bin/sh";
      const result = execFileSync(shell, ["-l", "-c", `command -v ${commandName}`], {
        encoding: "utf8",
        timeout: 5000,
        env: buildCliEnv(),
      });
      const lines = parseLocatorOutput(result).filter(line => line.startsWith("/"));
      const hit = lines[lines.length - 1];
      if (hit && fs.existsSync(hit)) return hit;
    } catch { /* login shell lookup failed */ }
    return null;
  }

  function getDefaultNpmCommandCandidates(commandName) {
    const home = os.homedir();
    if (isWin) {
      const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
      return [
        path.join(appData, "npm", `${commandName}.cmd`),
        path.join(appData, "npm", `${commandName}.exe`),
      ];
    }
    return [
      path.join(home, ".npm-global", "bin", commandName),
      path.join(home, ".local", "bin", commandName),
    ];
  }

  function findCommandBinary(commandName, extraCandidates = []) {
    return (
      findOnPath(commandName) ||
      findInLoginShell(commandName) ||
      uniqueExistingPaths([...extraCandidates, ...getDefaultNpmCommandCandidates(commandName)])[0] ||
      null
    );
  }

  async function getInsights(todayData, weekData) {
    const cfg = getConfig();
    const provider = (cfg && cfg.provider) || "claude";
    const providerDef = PROVIDERS[provider];
    const apiKey = cfg && cfg.apiKey;

    // Need API key for claude/openai providers
    if (providerDef && providerDef.needsKey && !apiKey) return null;

    // Return cached if fresh
    if (cachedInsights && Date.now() < cacheExpiry) return cachedInsights;

    // Skip if no meaningful data
    if (!todayData.totalTime && (!weekData || !weekData.days.some(d => d.totalTime > 0))) {
      return { summary: "No agent activity recorded yet. Start using AI agents and check back!", highlights: [], suggestions: [] };
    }

    const prompt = buildPrompt(todayData, weekData);
    const model = (cfg && cfg.model) || (providerDef && providerDef.defaultModel);
    const baseUrl = (cfg && cfg.baseUrl) || (providerDef && providerDef.baseUrl);

    try {
      let text;
      if (provider === "claude") {
        text = await callClaude(apiKey, model, prompt);
      } else if (provider === "ollama") {
        text = await callOllama(model, prompt, baseUrl);
      } else {
        // openai-compatible (covers Qwen, DeepSeek, etc.)
        text = await callOpenAICompat(apiKey, model, prompt, baseUrl);
      }

      if (!text) return null;

      // Parse JSON from response (might be wrapped in markdown code block)
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return { summary: text.slice(0, 200), highlights: [], suggestions: [] };

      const insights = JSON.parse(jsonMatch[0]);
      cachedInsights = insights;
      cacheExpiry = Date.now() + CACHE_TTL;
      return insights;
    } catch (err) {
      console.warn("Clawd analytics AI: fetch failed:", err.message);
      return { summary: `AI request failed: ${err.message}`, highlights: [], suggestions: [] };
    }
  }

  // ── Local Claude CLI detection ──

  let cachedClaudePath = undefined; // undefined = not searched, null = not found

  function findClaudeBinary() {
    if (cachedClaudePath !== undefined) return cachedClaudePath;
    const extraCandidates = [];

    // Homebrew (macOS) — standalone Mach-O binary, most reliable
    const brewDirs = ["/opt/homebrew/Caskroom/claude-code", "/usr/local/Caskroom/claude-code"];
    for (const brewDir of brewDirs) {
      try {
        const versions = fs.readdirSync(brewDir).sort().reverse();
        for (const v of versions) {
          extraCandidates.push(path.join(brewDir, v, "claude"));
        }
      } catch { /* dir doesn't exist */ }
    }

    // Claude Desktop managed (macOS) — .app bundle only
    const claudeCodeDir = path.join(os.homedir(), "Library", "Application Support", "Claude", "claude-code");
    try {
      const versions = fs.readdirSync(claudeCodeDir).sort().reverse();
      for (const v of versions) {
        extraCandidates.push(path.join(claudeCodeDir, v, "claude.app", "Contents", "MacOS", "claude"));
      }
    } catch { /* dir doesn't exist */ }

    // Windows npm / installer candidates
    if (isWin) {
      const home = os.homedir();
      const localAppData = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
      extraCandidates.push(path.join(localAppData, "Programs", "Claude Code", "claude.exe"));
    }

    cachedClaudePath = findCommandBinary("claude", extraCandidates);
    return cachedClaudePath;
  }

  // ── Codex CLI detection ──

  let cachedCodexPath = undefined;

  function findCodexBinary() {
    if (cachedCodexPath !== undefined) return cachedCodexPath;
    cachedCodexPath = findCommandBinary("codex", ["/opt/homebrew/bin/codex", "/usr/local/bin/codex"]);
    return cachedCodexPath;
  }

  function getProviderCooldown(providerId) {
    const cooldown = providerCooldowns.get(providerId);
    if (!cooldown) return null;
    if (cooldown.until <= Date.now()) {
      providerCooldowns.delete(providerId);
      loggedProviderCooldowns.delete(providerId);
      return null;
    }
    return cooldown;
  }

  function disableProviderTemporarily(providerId, reason) {
    providerCooldowns.set(providerId, {
      reason,
      until: Date.now() + PROVIDER_COOLDOWN_MS,
    });
  }

  function isLikelyCliNetworkFailure(message) {
    const text = String(message || "");
    return [
      /failed to refresh available models/i,
      /stream disconnected before completion/i,
      /error sending request/i,
      /transport channel closed/i,
      /connection refused/i,
      /connectfailed/i,
      /tcp connect error/i,
      /wham\/apps/i,
      /backend-api/i,
      /proxy/i,
    ].some(re => re.test(text));
  }

  function friendlyCliError(cliName, message) {
    const text = String(message || "").trim();
    const proxyTarget = text.match(/\b(?:127\.0\.0\.1|localhost|\[::1\]|::1):(\d+)\b/i);
    if (proxyTarget && /connection refused/i.test(text)) {
      const host = proxyTarget[0].replace(/^\[|\]$/g, "");
      return `${cliName} 无法连接本地代理 ${host}。请确认代理已启动，或关闭该代理配置后重试。`;
    }
    if (isLikelyCliNetworkFailure(text)) {
      return `${cliName} 网络初始化失败。请检查代理、登录状态或外网连通性后重试。`;
    }
    return text || `${cliName} 执行失败`;
  }

  function stripAnsi(text) {
    return String(text || "").replace(/\u001b\[[0-9;]*m/g, "");
  }

  function summarizeCodexError(stderr, fallback) {
    const lines = stripAnsi(stderr)
      .split("\n")
      .map(line => line.trim())
      .filter(Boolean);

    if (!lines.length) return fallback || "Codex CLI failed";

    const ignore = [
      /^WARNING: proceeding, even though we could not update PATH:/,
      /^Reading additional input from stdin\.\.\.$/,
      /^note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace$/,
    ];
    const important = [
      /\bERROR\b/i,
      /\bfailed\b/i,
      /\bpanic/i,
      /\bCould not\b/i,
      /\bnot found\b/i,
      /\bdenied\b/i,
      /\btimeout\b/i,
      /\bunauthorized\b/i,
      /\bforbidden\b/i,
      /\bdns error\b/i,
      /\breadonly database\b/i,
      /\bwebsocket\b/i,
    ];

    const cleaned = lines
      .filter(line => !ignore.some(re => re.test(line)))
      .map(line => line
        .replace(/^\d{4}-\d{2}-\d{2}T\S+\s+(WARN|ERROR)\s+\S+:\s*/, "$1: ")
        .replace(/^thread '[^']+' \([^)]*\) panicked at .*?:\d+:\d+:\s*/, "panic: ")
      );

    const prioritized = cleaned.filter(line => important.some(re => re.test(line)));
    const selected = (prioritized.length ? prioritized : cleaned).slice(0, 6).join(" | ");
    return selected || fallback || "Codex CLI failed";
  }

  function resolveCodexWorkingDir(preferredCwd) {
    if (preferredCwd && fs.existsSync(preferredCwd)) return preferredCwd;
    return process.cwd();
  }

  // JSON Schema for analysis output. When passed to codex via --output-schema,
  // OpenAI's strict mode forces the model to emit exactly this shape and skip
  // unstructured "thinking out loud" — significantly cuts output tokens.
  // NOTE: every nested object must have additionalProperties:false for strict mode.
  const ANALYSIS_OUTPUT_SCHEMA = {
    type: "object",
    additionalProperties: false,
    properties: {
      summary: { type: "string" },
      keyTopics: { type: "array", items: { type: "string" } },
      outcomes: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            headline: { type: "string" },
            detail: { type: "string" },
          },
          required: ["headline", "detail"],
        },
      },
      timeBreakdown: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            activity: { type: "string" },
            percent: { type: "number" },
          },
          required: ["activity", "percent"],
        },
      },
      suggestions: { type: "array", items: { type: "string" } },
    },
    required: ["summary", "keyTopics", "outcomes", "timeBreakdown", "suggestions"],
  };

  async function callCodexCLI(codexPath, prompt, options = {}) {
    const env = await sanitizeCliProxyEnv(buildCliEnv(), "codex");
    return new Promise((resolve, reject) => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-codex-"));
      const outputFile = path.join(tmpDir, "last-message.txt");
      const schemaFile = path.join(tmpDir, "output-schema.json");
      try { fs.writeFileSync(schemaFile, JSON.stringify(ANALYSIS_OUTPUT_SCHEMA)); } catch { /* ignore */ }
      // Phase 0 cost/speed optimization (2026-04-07): force codex into fast
      // analysis mode. Without these, gpt-5.4 with `xhigh` reasoning_effort
      // routinely takes 90+ seconds. With them, the same task finishes in ~10s.
      const args = [
        "exec",
        "--skip-git-repo-check",
        "--json",
        "--ephemeral",                           // don't persist session to disk
        "--sandbox", "read-only",                // forbid any writes
        "-c", "model_reasoning_effort=low",      // gpt-5.4 default is xhigh — way too deep for analysis
        "-c", "tools.web_search=false",          // also avoids 'minimal' incompat error
        "--output-schema", schemaFile,           // strict JSON output, suppresses chain-of-thought text
        "-o", outputFile,
        "-",
      ];
      const child = spawnCli(codexPath, args, {
        cwd: resolveCodexWorkingDir(options.cwd),
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const timeoutMs = 90000;
      const maxBytes = 2 * 1024 * 1024;
      let stdout = "";
      let stderr = "";
      let settled = false;

      function cleanup() {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
      }

      function fail(message, extra = {}) {
        if (settled) return;
        settled = true;
        cleanup();
        const err = new Error(message);
        Object.assign(err, extra);
        reject(err);
      }

      const timer = setTimeout(() => {
        try { child.kill("SIGTERM"); } catch { /* ignore */ }
        fail(summarizeCodexError(stderr, `codex exec 超时（${Math.round(timeoutMs / 1000)}s）`), { stdout, stderr, timedOut: true });
      }, timeoutMs);

      child.on("error", (err) => {
        clearTimeout(timer);
        fail(err.message, { stdout, stderr });
      });

      child.stdout.on("data", (buf) => {
        stdout += buf.toString();
        if (Buffer.byteLength(stdout, "utf8") > maxBytes) {
          clearTimeout(timer);
          try { child.kill("SIGTERM"); } catch { /* ignore */ }
          fail("Codex CLI 输出过大", { stdout, stderr });
        }
      });

      child.stderr.on("data", (buf) => {
        stderr += buf.toString();
        if (Buffer.byteLength(stderr, "utf8") > maxBytes) {
          stderr = stderr.slice(-maxBytes);
        }
      });

      child.on("close", (code, signal) => {
        if (settled) return;
        clearTimeout(timer);
        let text = fs.existsSync(outputFile) ? fs.readFileSync(outputFile, "utf8") : "";
        if (code === 0) {
          settled = true;
          cleanup();
          // Parse codex 0.118+ JSONL output. Two output schemas exist depending
          // on flags (`exec` vs `exec --json` modes), so we handle both.
          let usage = null;
          let model = null;
          try {
            const lines = stdout.split("\n").filter(Boolean);
            for (const line of lines) {
              try {
                const obj = JSON.parse(line);

                // ── model name (best effort, often missing in exec --json) ──
                // Schema A: codex < 0.118 — wrapped in payload
                if (obj.type === "turn_context" && obj.payload && obj.payload.model) model = obj.payload.model;
                // Schema B: codex 0.118+ — flat top-level model field on turn.started
                if (obj.type === "turn.started" && obj.model) model = obj.model;

                // ── output text fallback (when -o file is empty) ──
                // codex 0.118+ emits `item.completed` for the final agent message
                if (obj.type === "item.completed" && obj.item && obj.item.type === "agent_message" && typeof obj.item.text === "string" && !text) {
                  text = obj.item.text;
                }

                // ── token usage ──
                // Schema A (older): event_msg.token_count.info.total_token_usage
                if (obj.type === "event_msg" && obj.payload && obj.payload.type === "token_count" && obj.payload.info && obj.payload.info.total_token_usage) {
                  const t = obj.payload.info.total_token_usage;
                  usage = {
                    input_tokens: t.input_tokens || 0,
                    cached_input_tokens: t.cached_input_tokens || 0,
                    output_tokens: (t.output_tokens || 0) + (t.reasoning_output_tokens || 0),
                  };
                }
                // Schema B (codex 0.118+): turn.completed.usage (flat)
                if (obj.type === "turn.completed" && obj.usage) {
                  const u = obj.usage;
                  usage = {
                    input_tokens: u.input_tokens || 0,
                    cached_input_tokens: u.cached_input_tokens || 0,
                    output_tokens: (u.output_tokens || 0) + (u.reasoning_output_tokens || 0),
                  };
                }
              } catch { /* skip non-json lines */ }
            }
          } catch { /* ignore parse errors */ }
          return resolve({ text, usage, model, stderr });
        }
        fail(
          summarizeCodexError(stderr, text.trim() || `codex exec 退出异常${code !== null ? `（code ${code}）` : signal ? `（signal ${signal}）` : ""}`),
          { stdout, stderr, code, signal }
        );
      });

      child.stdin.end(prompt);
    });
  }

  function getConfiguredApiProviderOption() {
    const cfg = getConfig();
    if (!cfg) return null;
    const provider = cfg.provider || "claude";
    const providerDef = PROVIDERS[provider];
    if (!providerDef) return null;
    if (providerDef.needsKey && !cfg.apiKey) return null;
    return {
      id: `api:${provider}`,
      type: "api",
      provider,
      label: providerDef.label,
    };
  }

  // ── Model + pricing detection ──
  //
  // Pricing table (USD per 1M tokens). Update as needed.
  // Prefer "alias" keys (haiku/sonnet/opus/gpt-5/etc) so user-config aliases work.
  // Each entry: { input, cachedInput (cache_read), cacheWrite (cache_creation), output }
  // cacheWrite defaults to 1.25× input (Anthropic 5-min cache); cachedInput defaults to 0.1× input.
  const MODEL_PRICING = {
    // Claude — official Anthropic prices per 1M tokens
    "claude-haiku-4-5":      { input: 1.00, cachedInput: 0.10, cacheWrite: 1.25, output: 5.00 },
    "claude-sonnet-4-5":     { input: 3.00, cachedInput: 0.30, cacheWrite: 3.75, output: 15.00 },
    "claude-opus-4-6":       { input: 15.00, cachedInput: 1.50, cacheWrite: 18.75, output: 75.00 },
    "haiku":                 { input: 1.00, cachedInput: 0.10, cacheWrite: 1.25, output: 5.00 },
    "sonnet":                { input: 3.00, cachedInput: 0.30, cacheWrite: 3.75, output: 15.00 },
    "opus":                  { input: 15.00, cachedInput: 1.50, cacheWrite: 18.75, output: 75.00 },
    // OpenAI — GPT-5 family per 1M tokens
    "gpt-5":                 { input: 1.25, cachedInput: 0.13, cacheWrite: 1.25, output: 10.00 },
    "gpt-5-mini":            { input: 0.25, cachedInput: 0.025, cacheWrite: 0.25, output: 2.00 },
    "gpt-5.4":               { input: 1.25, cachedInput: 0.13, cacheWrite: 1.25, output: 10.00 },
    "gpt-4o":                { input: 2.50, cachedInput: 1.25, cacheWrite: 2.50, output: 10.00 },
    "gpt-4o-mini":           { input: 0.15, cachedInput: 0.075, cacheWrite: 0.15, output: 0.60 },
  };

  // Resolve a model id (e.g. "claude-haiku-4-5-20251001", "gpt-5.4", "haiku")
  // to a canonical pricing key. Falls back to broad family match.
  function resolvePricingKey(modelId) {
    if (!modelId) return null;
    const m = String(modelId).toLowerCase();
    if (MODEL_PRICING[m]) return m;
    // Strip date suffix on Anthropic models (e.g. claude-haiku-4-5-20251001 → claude-haiku-4-5)
    const stripped = m.replace(/-\d{8}$/, "");
    if (MODEL_PRICING[stripped]) return stripped;
    // Family match
    if (m.includes("haiku")) return "haiku";
    if (m.includes("sonnet")) return "sonnet";
    if (m.includes("opus")) return "opus";
    if (m.includes("gpt-5-mini") || m.includes("gpt-5.4-mini")) return "gpt-5-mini";
    if (m.includes("gpt-5")) return "gpt-5";
    if (m.includes("gpt-4o-mini")) return "gpt-4o-mini";
    if (m.includes("gpt-4o")) return "gpt-4o";
    return null;
  }

  // Compute USD cost from a usage object. Handles both Claude and Codex shapes.
  // usage shape (normalized): { input_tokens, output_tokens, cache_read_input_tokens?, cache_creation_input_tokens?, cached_input_tokens? }
  function estimateCost(usage, modelId) {
    if (!usage) return null;
    const key = resolvePricingKey(modelId);
    if (!key) return null;
    const p = MODEL_PRICING[key];
    const fresh = usage.input_tokens || 0;
    const out = usage.output_tokens || 0;
    const cacheRead = usage.cache_read_input_tokens || usage.cached_input_tokens || 0;
    const cacheWrite = usage.cache_creation_input_tokens || 0;
    const cost =
      (fresh * p.input
        + cacheRead * p.cachedInput
        + cacheWrite * p.cacheWrite
        + out * p.output) / 1_000_000;
    return { usd: cost, pricingKey: key };
  }

  // Get CLI version (cached). `claude --version` / `codex --version`.
  const cliVersionCache = new Map();
  function getCliVersion(binPath) {
    if (!binPath) return null;
    if (cliVersionCache.has(binPath)) return cliVersionCache.get(binPath);
    let version = null;
    try {
      const out = execFileSync(binPath, ["--version"], { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "pipe"] });
      const m = out.match(/(\d+\.\d+\.\d+(?:[-+][\w.]+)?)/);
      version = m ? m[1] : out.trim().split("\n")[0].slice(0, 50);
    } catch { /* ignore */ }
    cliVersionCache.set(binPath, version);
    return version;
  }

  // Read default model from local CLI config files.
  function getClaudeDefaultModel() {
    try {
      const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
      const text = fs.readFileSync(settingsPath, "utf8");
      const cfg = JSON.parse(text);
      if (cfg && typeof cfg.model === "string") return cfg.model;
    } catch { /* ignore */ }
    return null;
  }

  function getCodexDefaultModel() {
    try {
      const cfgPath = path.join(os.homedir(), ".codex", "config.toml");
      const text = fs.readFileSync(cfgPath, "utf8");
      // Cheap TOML scrape: first top-level `model = "..."` line
      const m = text.match(/^model\s*=\s*"([^"]+)"/m);
      if (m) return m[1];
    } catch { /* ignore */ }
    return null;
  }

  function getAvailableAnalysisProviders() {
    const options = [];
    const claudePath = findClaudeBinary();
    if (claudePath && !getProviderCooldown("claude-code")) {
      const version = getCliVersion(claudePath);
      const model = getClaudeDefaultModel();
      const pricingKey = resolvePricingKey(model);
      options.push({
        id: "claude-code",
        type: "claude-cli",
        label: "Claude Code",
        path: claudePath,
        version,
        model,
        pricingKey,
      });
    }
    const codexPath = findCodexBinary();
    if (codexPath && !getProviderCooldown("codex")) {
      const version = getCliVersion(codexPath);
      const model = getCodexDefaultModel();
      const pricingKey = resolvePricingKey(model);
      options.push({
        id: "codex",
        type: "codex-cli",
        label: "Codex",
        path: codexPath,
        version,
        model,
        pricingKey,
      });
    }
    const apiOption = getConfiguredApiProviderOption();
    if (apiOption) options.push(apiOption);
    return options;
  }

  // ── Session-level AI analysis ──

  const ANALYSIS_CACHE_VERSION = 2;
  const sessionAnalysisCache = new Map(); // `${sessionId}:${provider}` → result

  function analysisCacheKey(sessionId, provider) {
    return `${sessionId}:${provider || "claude-code"}`;
  }

  function isTransientAnalysisFailure(result) {
    const summary = result && typeof result.summary === "string" ? result.summary : "";
    if (!summary) return false;
    return (
      summary.includes("执行失败:") ||
      summary.startsWith("分析失败:") ||
      summary.includes("未找到本地 CLI") ||
      summary.includes("未配置 API Key") ||
      summary.includes("Codex CLI 未找到") ||
      summary.includes("无法连接本地代理") ||
      summary.includes("网络初始化失败")
    );
  }

  function maybeCacheAnalysisResult(cacheKey, result) {
    if (!result) return result;
    result._analysisCacheVersion = ANALYSIS_CACHE_VERSION;
    result._cacheable = !isTransientAnalysisFailure(result);
    if (result._cacheable) sessionAnalysisCache.set(cacheKey, result);
    else sessionAnalysisCache.delete(cacheKey);
    return result;
  }

  function buildSessionPrompt(detail) {
    let p = "你是一个对话分析助手。以下是用户与 AI 编程 agent 的对话记录摘要。\n";
    p += "请从**用户视角**分析这段对话：用户想做什么、获得了什么成果、学到了什么信息。\n";
    p += "不要描述 agent 的工作流程（如调用了什么工具），而是关注用户的意图和收获。\n\n";
    p += `Agent: ${detail.agent}\n`;
    if (detail.title) p += `Title: ${detail.title}\n`;
    if (detail.cwd) p += `Project: ${detail.cwd}\n`;

    if (detail.timestamps.length >= 2) {
      const sorted = [...detail.timestamps].sort((a, b) => a - b);
      const duration = sorted[sorted.length - 1] - sorted[0];
      const mins = Math.round(duration / 60000);
      p += `Duration: ${mins} minutes\n`;
    }

    p += "\n## User Messages (what the user asked/discussed)\n";
    for (const m of detail.userMessages.slice(0, 30)) {
      if (m.text) p += `- ${m.text}\n`;
    }

    // Brief tool context (just categories, not detailed calls)
    const toolSummary = {};
    for (const t of detail.toolCalls) {
      toolSummary[t.name] = (toolSummary[t.name] || 0) + 1;
    }
    if (Object.keys(toolSummary).length) {
      p += "\n## Activity types (for context only)\n";
      for (const [name, count] of Object.entries(toolSummary).sort((a, b) => b[1] - a[1]).slice(0, 5)) {
        p += `- ${name}: ${count}x\n`;
      }
    }

    p += "\n请返回 JSON（不要 markdown code block），格式：\n";
    p += '{"summary":"2-3 句话概括用户在这段对话中做了什么、获得了什么成果"';
    p += ',"keyTopics":["话题1","话题2","话题3"]';
    p += ',"outcomes":[{"headline":"极简核心成果（6-14 字）","detail":"展开说明用户学到的关键知识点、新思路或具体细节，帮助用户回忆起当时获得的核心认知"}]';
    p += ',"timeBreakdown":[{"activity":"用户视角的活动描述","percent":百分比}]';
    p += ',"suggestions":["建议1"]}\n';
    p += "所有字段用中文。keyTopics 提取 3-5 个关键话题。\n";
    p += "outcomes 每条是 {headline, detail} 对象：\n";
    p += "  - headline：6-14 字的极简中文短语，高度概括这一条成果的核心。不要用完整句子，不要加标点。示例：'掌握 3 阶段 T2V 流水线'、'明确 cache 项目关联度低'、'定位论文到飞书分类'。\n";
    p += "  - detail：一句话展开具体内容，要具体且有信息量。不要只说'获得了阅读建议'，而要说'了解到该论文提出了X方法解决Y问题——核心思路是Z，与用户项目的关联在于W'。让用户看到就能回忆起关键认知。\n";
    p += "timeBreakdown 从用户视角描述时间分配（如'讨论架构设计'而非'调用Read工具'）。";
    return p;
  }

  // Append-mode system prompt that nudges Claude Code into pure-analysis mode
  // WITHOUT replacing the default system prompt entirely (which would kill the
  // ~6K cache_read benefit). Combined with --tools "" + --disable-slash-commands,
  // this is the winning Phase 0 configuration.
  //
  // Real benchmark vs default `-p` (haiku-4-5, identical user prompt, warm cache):
  //   baseline:   $0.01076 / 14.2s / 1513 out / 31,879 cache_read
  //   optimized:  $0.00640 / 12.2s / 1146 out /  6,622 cache_read
  //   savings:    -40% cost, -14% duration, -24% output tokens
  //
  // Why each flag matters:
  //   --verbose              → REQUIRED on Claude CLI 2.2+ when combining
  //                            -p / --print with --output-format=stream-json.
  //                            Older versions (≤2.1.x) implicitly enabled it,
  //                            newer versions hard-error without it:
  //                            "Error: When using --print, --output-format=
  //                            stream-json requires --verbose". The flag does
  //                            not change the NDJSON shape we already parse —
  //                            metadata events (system/init, hook_*, rate_limit_event)
  //                            were already streamed in 2.1.x and are skipped
  //                            by our parser's type-switch.
  //   --append-system-prompt → tells the model "no tools, JSON only" while
  //                            keeping the default system prompt cacheable
  //   --tools ""             → drops 25K of tool definitions from the prompt
  //   --disable-slash-commands → drops the skill registry (lark-* etc)
  const ANALYSIS_APPEND_SYSTEM_PROMPT =
    "IMPORTANT: For this conversation only — you are operating in pure analysis mode. " +
    "Do NOT use any tool, do NOT investigate, do NOT search files. " +
    "The user message contains all the data you need. " +
    "Respond with ONLY the requested JSON object, no markdown fences, no preamble.";

  function callClaudeCLI(claudePath, prompt) {
    return new Promise((resolve, reject) => {
      const args = [
        "-p", prompt,
        "--output-format", "stream-json",
        "--verbose",                                            // required by Claude CLI 2.2+ with -p + stream-json
        "--tools", "",                                          // disable all built-in tools (-25K tokens)
        "--disable-slash-commands",                             // skip skill loading
        "--append-system-prompt", ANALYSIS_APPEND_SYSTEM_PROMPT, // nudge to JSON-only mode
      ];
      const child = spawnCli(claudePath, args, {
        env: buildCliEnv({ CLAUDE_CODE_ENTRYPOINT: "cli" }),
        stdio: ["ignore", "pipe", "pipe"],
      });
      const timeoutMs = 90000;
      const maxBytes = 2 * 1024 * 1024;
      let stdout = "";
      let stderr = "";
      let settled = false;

      function fail(message, extra = {}) {
        if (settled) return;
        settled = true;
        const err = new Error(message);
        Object.assign(err, extra);
        reject(err);
      }

      const timer = setTimeout(() => {
        try { child.kill("SIGTERM"); } catch { /* ignore */ }
        fail(stderr.trim() || `claude exec 超时（${Math.round(timeoutMs / 1000)}s）`, { stdout, stderr, timedOut: true });
      }, timeoutMs);

      child.on("error", (err) => {
        clearTimeout(timer);
        fail(err.message, { stdout, stderr });
      });

      child.stdout.on("data", (buf) => {
        stdout += buf.toString();
        if (Buffer.byteLength(stdout, "utf8") > maxBytes) {
          clearTimeout(timer);
          try { child.kill("SIGTERM"); } catch { /* ignore */ }
          fail("Claude CLI 输出过大", { stdout, stderr });
        }
      });

      child.stderr.on("data", (buf) => {
        stderr += buf.toString();
        if (Buffer.byteLength(stderr, "utf8") > maxBytes) {
          stderr = stderr.slice(-maxBytes);
        }
      });

      child.on("close", (code, signal) => {
        if (settled) return;
        clearTimeout(timer);
        if (code !== 0) {
          return fail(stderr.trim() || `claude exec 退出异常${code !== null ? `（code ${code}）` : signal ? `（signal ${signal}）` : ""}`, { stdout, stderr, code, signal });
        }

        // stream-json outputs one JSON object per line (NDJSON)
        // The last "result" message contains the text and usage
        let text = "";
        let usage = null;
        let model = null;
        let costUsd = null;
        try {
          const lines = stdout.split("\n").filter(Boolean);
          for (const line of lines) {
            try {
              const obj = JSON.parse(line);
              if (obj.type === "result") {
                text = obj.result || "";
                if (typeof obj.total_cost_usd === "number") costUsd = obj.total_cost_usd;
                if (obj.usage) usage = { ...(usage || {}), ...obj.usage };
              } else if (obj.type === "assistant" && obj.message) {
                const content = obj.message.content;
                if (Array.isArray(content)) {
                  for (const c of content) {
                    if (c.type === "text") text = c.text;
                  }
                }
                if (obj.message.model) model = obj.message.model;
                if (obj.message.usage) usage = obj.message.usage;
              }
            } catch { /* skip unparseable lines */ }
          }
        } catch {
          text = stdout;
        }
        if (!text) text = stdout;
        settled = true;
        resolve({ text, usage, model, costUsd });
      });
    });
  }

  async function analyzeSession(detail) {
    if (!detail) return null;
    const preferredProvider = detail._preferredProvider || "claude-code";

    // Check cache — invalidate if message count or provider changed
    const cacheKey = analysisCacheKey(detail.sessionId, preferredProvider);
    if (sessionAnalysisCache.has(cacheKey)) {
      const cached = sessionAnalysisCache.get(cacheKey);
      if (
        cached._analysisCacheVersion === ANALYSIS_CACHE_VERSION &&
        cached._msgCount === (detail.userMessages || []).length
      ) {
        return cached;
      }
      // Content changed — re-analyze
      console.log(`Clawd analytics: session ${cacheKey} grew (${cached._msgCount} → ${(detail.userMessages || []).length} msgs), re-analyzing`);
      sessionAnalysisCache.delete(cacheKey);
    }

    const startTime = Date.now();
    const prompt = buildSessionPrompt(detail);
    let cliError = null;

    // Pick CLI binary based on preference — no auto-fallback
    let cliPath = null, cliName = null, callFn = null, cliProviderId = null;
    let forcedApiProvider = null;
    if (preferredProvider === "codex") {
      cliProviderId = "codex";
      cliPath = findCodexBinary();
      cliName = "codex";
      callFn = callCodexCLI;
      const cooldown = getProviderCooldown(cliProviderId);
      if (cooldown) {
        cliError = cooldown.reason;
        if (!loggedProviderCooldowns.has(cliProviderId)) {
          loggedProviderCooldowns.add(cliProviderId);
          console.warn(`Clawd analytics: ${cliProviderId} temporarily disabled:`, cooldown.reason);
        }
        cliPath = null;
        callFn = null;
      }
      if (!cliPath) {
        if (!cliError) {
          return maybeCacheAnalysisResult(cacheKey, {
            summary: "Codex CLI 未找到。请确认已安装 codex（npm install -g @openai/codex）。",
            keyTopics: [],
            outcomes: [],
            timeBreakdown: [],
            suggestions: [],
            _provider: "codex-not-found",
          });
        }
      }
    } else if (preferredProvider === "claude-code") {
      cliProviderId = "claude-code";
      cliPath = findClaudeBinary();
      cliName = "claude-cli";
      callFn = callClaudeCLI;
      const cooldown = getProviderCooldown(cliProviderId);
      if (cooldown) {
        cliError = cooldown.reason;
        if (!loggedProviderCooldowns.has(cliProviderId)) {
          loggedProviderCooldowns.add(cliProviderId);
          console.warn(`Clawd analytics: ${cliProviderId} temporarily disabled:`, cooldown.reason);
        }
        cliPath = null;
        callFn = null;
      }
    } else if (preferredProvider.startsWith("api:")) {
      forcedApiProvider = preferredProvider.slice(4);
    } else {
      cliProviderId = "claude-code";
      cliPath = findClaudeBinary();
      cliName = "claude-cli";
      callFn = callClaudeCLI;
    }
    if (cliPath && cliName) {
      const logKey = `${cliName}:${cliPath}`;
      if (!loggedCliBinaries.has(logKey)) {
        loggedCliBinaries.add(logKey);
        console.log(`Clawd analytics: using ${cliName} binary =`, cliPath);
      }
    }

    if (cliPath && callFn) {
      try {
        const cliResult = await callFn(cliPath, prompt, { cwd: detail.cwd });
        const text = cliResult.text;
        const usage = cliResult.usage;
        // Resolve model: prefer runtime (from jsonl events), fall back to
        // configured default (~/.claude/settings.json or ~/.codex/config.toml).
        // Without this fallback, codex 0.117 and earlier (no turn_context.model)
        // would lose cost display entirely.
        let runtimeModel = cliResult.model || null;
        if (!runtimeModel) {
          if (cliProviderId === "codex") runtimeModel = getCodexDefaultModel();
          else if (cliProviderId === "claude-code") runtimeModel = getClaudeDefaultModel();
        }
        const runtimeCostUsd = typeof cliResult.costUsd === "number" ? cliResult.costUsd : null;
        // Compute estimated cost: prefer CLI-provided cost, else use pricing table
        let estCost = null;
        if (runtimeCostUsd !== null) {
          estCost = { usd: runtimeCostUsd, source: "cli" };
        } else if (usage) {
          const c = estimateCost(usage, runtimeModel);
          if (c) estCost = { usd: c.usd, source: "estimate", pricingKey: c.pricingKey };
        }

        const attachMeta = (obj) => {
          if (usage) obj._usage = usage;
          if (runtimeModel) obj._model = runtimeModel;
          if (estCost) obj._cost = estCost;
          obj._provider = cliName;
          obj._msgCount = (detail.userMessages || []).length;
          obj._analysisMs = Date.now() - startTime;
          return obj;
        };
        if (text) {
          const jsonMatch = text.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const result = attachMeta(JSON.parse(jsonMatch[0]));
            return maybeCacheAnalysisResult(cacheKey, result);
          }
          const fallback = attachMeta({ summary: text.trim().slice(0, 300), keyTopics: [], outcomes: [], timeBreakdown: [], suggestions: [] });
          return maybeCacheAnalysisResult(cacheKey, fallback);
        }
      } catch (err) {
        cliError = friendlyCliError(cliName, err.message);
        console.warn(`Clawd analytics: ${cliName} failed:`, cliError);
        if (cliProviderId && isLikelyCliNetworkFailure(err.message)) {
          disableProviderTemporarily(cliProviderId, cliError);
          loggedProviderCooldowns.delete(cliProviderId);
        }
        // Fall through to API providers
      }
    }

    // Fallback to configured API provider
    const cfg = getConfig();
    const provider = forcedApiProvider || (cfg && cfg.provider) || "claude";
    const providerDef = PROVIDERS[provider];
    const apiKey = cfg && cfg.apiKey;

    if (providerDef && providerDef.needsKey && !apiKey) {
      const msg = forcedApiProvider
        ? `${providerDef.label} 未配置 API Key。请先在设置中配置后再分析。`
        : cliPath
          ? `${cliName} 执行失败: ${cliError || "unknown error"}。可配置 API Key 作为备选。`
          : cliError
            ? `${cliError} 可配置 API Key 作为备选。`
            : "未找到本地 CLI，且未配置 API Key。请安装 Claude Code 或配置 API Key。";
      return maybeCacheAnalysisResult(cacheKey, { summary: msg, keyTopics: [], outcomes: [], timeBreakdown: [], suggestions: [], _provider: cliName || provider });
    }

    try {
      const model = (cfg && cfg.model) || (providerDef && providerDef.defaultModel);
      const baseUrl = (cfg && cfg.baseUrl) || (providerDef && providerDef.baseUrl);
      let text;
      if (provider === "claude") {
        text = await callClaude(apiKey, model, prompt);
      } else if (provider === "ollama") {
        text = await callOllama(model, prompt, baseUrl);
      } else {
        text = await callOpenAICompat(apiKey, model, prompt, baseUrl);
      }

      if (!text) return null;
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        const result = { summary: text.slice(0, 300), timeBreakdown: [], insights: [], suggestions: [], _msgCount: (detail.userMessages || []).length, _analysisMs: Date.now() - startTime };
        return maybeCacheAnalysisResult(cacheKey, result);
      }
      const result = JSON.parse(jsonMatch[0]);
      result._msgCount = (detail.userMessages || []).length;
      result._analysisMs = Date.now() - startTime;
      return maybeCacheAnalysisResult(cacheKey, result);
    } catch (err) {
      return maybeCacheAnalysisResult(cacheKey, { summary: `分析失败: ${err.message}`, timeBreakdown: [], insights: [], suggestions: [] });
    }
  }

  function getAnalysisProvider() {
    return getAvailableAnalysisProviders()[0] || null;
  }

  // ── One-liner summaries (lightweight, for event cards) ──

  const onelinerCache = new Map();

  async function getSessionOneLiner(detail) {
    if (!detail) return null;
    if (onelinerCache.has(detail.sessionId)) return onelinerCache.get(detail.sessionId);

    const msgs = (detail.userMessages || []).slice(0, 5).map(m => m.text).filter(Boolean).join("\n");
    if (!msgs) return null;

    const prompt = `用一句中文（15-25字）概括以下对话的主题，不要加标点符号结尾：\n${msgs}`;

    const claudePath = findClaudeBinary();
    if (claudePath) {
      try {
        const { text } = await callClaudeCLI(claudePath, prompt);
        const line = (text || "").trim().split("\n")[0].replace(/^["'""'']|["'""'']$/g, "").trim();
        if (line) { onelinerCache.set(detail.sessionId, line); return line; }
      } catch { /* fall through */ }
    }

    // Fallback to API
    const cfg = getConfig();
    const provider = (cfg && cfg.provider) || "claude";
    const apiKey = cfg && cfg.apiKey;
    if (!apiKey && PROVIDERS[provider] && PROVIDERS[provider].needsKey) return null;

    try {
      const model = (cfg && cfg.model) || PROVIDERS[provider].defaultModel;
      const baseUrl = (cfg && cfg.baseUrl) || PROVIDERS[provider].baseUrl;
      let text;
      if (provider === "claude") text = await callClaude(apiKey, model, prompt);
      else if (provider === "ollama") text = await callOllama(model, prompt, baseUrl);
      else text = await callOpenAICompat(apiKey, model, prompt, baseUrl);
      const line = (text || "").trim().split("\n")[0].replace(/^["'""'']|["'""'']$/g, "").trim();
      if (line) { onelinerCache.set(detail.sessionId, line); return line; }
    } catch { /* ignore */ }

    return null;
  }

  return { getInsights, getApiKey, setApiKey, getConfig, setConfig, PROVIDERS, analyzeSession, getAnalysisProvider, getAvailableAnalysisProviders, findClaudeBinary, getSessionOneLiner };
};
