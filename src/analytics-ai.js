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

const INTERNAL_ANALYTICS_SUMMARY_MARKER = "[clawd-analytics-internal-summary-task]";

// ── Provider Registry Data Structures ──

/**
 * @typedef {Object} Provider
 * @property {string} id - Unique identifier (UUID)
 * @property {string} name - User-friendly name (e.g., "Zhipu AI GLM-4-Flash")
 * @property {'claude'|'openai'|'ollama'} type - Provider type
 * @property {string} baseUrl - API endpoint (e.g., "https://api.zhipuai.com")
 * @property {string} [apiKey] - API key (optional for ollama)
 * @property {string} model - Model identifier (e.g., "glm-4-flash", "gpt-4o-mini")
 * @property {boolean} enabled - Whether provider is enabled
 * @property {Object.<string, string>} [customHeaders] - Custom headers for API requests
 * @property {number} [createdAt] - Timestamp when provider was added
 * @property {number} [updatedAt] - Timestamp when provider was last updated
 */

/**
 * @typedef {Object} ProviderRegistry
 * @property {Provider[]} providers - Array of configured providers
 * @property {Object.<string, string>} defaultProviders - Default provider IDs by analysis mode
 * @property {string} [defaultProviders.brief] - Default provider for brief analysis
 * @property {string} [defaultProviders.detail] - Default provider for detail analysis
 * @property {string} [defaultProviders.batch] - Default provider for batch analysis
 */

/**
 * Generate a UUID v4 string
 * @returns {string} UUID v4 format string
 */
function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

/**
 * Validate a provider object
 * @param {Provider} provider - Provider to validate
 * @returns {boolean} true if valid
 * @throws {Error} if validation fails
 */
function validateProvider(provider) {
  if (!provider || typeof provider !== 'object') {
    throw new Error('Provider must be an object');
  }
  
  if (!provider.name || typeof provider.name !== 'string' || provider.name.trim().length === 0) {
    throw new Error('Provider name is required and must be a non-empty string');
  }
  
  if (!provider.type || !['claude', 'openai', 'ollama'].includes(provider.type)) {
    throw new Error('Provider type must be one of: claude, openai, ollama');
  }
  
  if (!provider.baseUrl || typeof provider.baseUrl !== 'string' || provider.baseUrl.trim().length === 0) {
    throw new Error('Provider baseUrl is required and must be a non-empty string');
  }
  
  // Validate baseUrl format (basic check)
  try {
    new URL(provider.baseUrl);
  } catch {
    throw new Error('Provider baseUrl must be a valid URL');
  }
  
  if (provider.type !== 'ollama' && (!provider.apiKey || typeof provider.apiKey !== 'string')) {
    throw new Error(`Provider type ${provider.type} requires an apiKey`);
  }
  
  if (!provider.model || typeof provider.model !== 'string' || provider.model.trim().length === 0) {
    throw new Error('Provider model is required and must be a non-empty string');
  }
  
  if (provider.customHeaders && typeof provider.customHeaders !== 'object') {
    throw new Error('Provider customHeaders must be an object');
  }
  
  return true;
}

function buildInternalCliAnalysisPrompt(prompt) {
  return `${INTERNAL_ANALYTICS_SUMMARY_MARKER}
Ignore the marker above. It is only used by Clawd to hide this internal summary session from analytics scans.

${prompt}`;
}

// On Windows, `where <cmd>` returns every matching file in PATH. npm-installed
// CLIs produce three sibling shims side-by-side: an extensionless POSIX script
// (`claude`), a `.cmd`, and a `.ps1`. `where` lists the extensionless one
// first, but Node's spawn() without shell:true can't execute a POSIX shell
// script on Windows — it throws ENOENT with the extensionless path. Prefer
// .cmd/.bat/.exe/.ps1 when present so downstream spawn() calls work out of
// the box (the existing isWindowsShellShim check already adds shell:true for
// .cmd/.bat).
function preferWindowsExecutable(paths) {
  if (!paths || !paths.length) return null;
  const windowsExec = paths.find(p => /\.(cmd|bat|exe|ps1)$/i.test(p));
  return windowsExec || paths[0];
}

function resolvePreferredAnalysisProvider(options, config) {
  const opts = Array.isArray(options) ? options : [];
  if (!opts.length) return null;
  const saved = config && config.defaultAnalysisProvider;
  if (saved) {
    const matched = opts.find(opt => (opt.id || opt.provider) === saved);
    if (matched) return matched;
  }
  return opts[0] || null;
}

function getDetailContextEntryCount(detail) {
  if (detail && Array.isArray(detail.conversation) && detail.conversation.length) {
    return detail.conversation.length;
  }
  return Array.isArray(detail && detail.userMessages) ? detail.userMessages.length : 0;
}

function buildSessionContext(detail) {
  let p = "";
  p += `Agent: ${detail.agent}\n`;
  if (detail.title) p += `Title: ${detail.title}\n`;
  if (detail.cwd) p += `Project: ${detail.cwd}\n`;
  if (detail.scope && Number.isFinite(detail.scope.start) && Number.isFinite(detail.scope.end)) {
    p += `Scope: ${new Date(detail.scope.start).toISOString()} - ${new Date(detail.scope.end).toISOString()}\n`;
  }
  if (detail.timestamps.length >= 2) {
    const sorted = [...detail.timestamps].sort((a, b) => a - b);
    const mins = Math.round((sorted[sorted.length - 1] - sorted[0]) / 60000);
    p += `Duration: ${mins} minutes\n`;
  }

  const conversation = Array.isArray(detail.conversation) ? detail.conversation : [];
  if (conversation.length) {
    p += "\n## Conversation\n";
    for (const m of conversation.slice(0, 40)) {
      if (!m || !m.text) continue;
      const speaker = m.role === "assistant" ? "助手" : "用户";
      p += `- ${speaker}: ${m.text}\n`;
    }
    return p;
  }

  p += "\n## User Messages\n";
  for (const m of (detail.userMessages || []).slice(0, 30)) {
    if (m.text) p += `- ${m.text}\n`;
  }
  return p;
}

module.exports = function initAnalyticsAI(ctx) {
  const analysisCachePath = ctx.analysisCachePath || path.join(os.homedir(), ".clawd", "analysis-cache.json");
  const isWin = process.platform === "win32";
  // Hoisted CLI lookup caches — keep at the top of the closure so
  // invalidateCliCaches() (called from setConfig) never trips a TDZ if a
  // hot-reload happens to invoke setConfig before the original `let` lines
  // further down in the file are executed.
  let cachedClaudePath = undefined; // undefined = not searched, null = not found
  let cachedCodexPath = undefined;
  // Per-binary CLI capability cache (Map<binaryPath, Set<flag>>). Populated
  // lazily by getCliCapabilities() the first time a CLI is invoked, so we can
  // skip flags the user's installed version doesn't recognize. Cleared by
  // invalidateCliCaches() when the user re-points a custom CLI path.
  const cliCapabilitiesCache = new Map();
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
    // The custom CLI paths live in config — invalidating the binary lookup
    // cache here is what makes "Settings → Save → providers refresh" work
    // without an app restart. Without this, findClaudeBinary/findCodexBinary
    // would keep returning whatever they cached on first call.
    invalidateCliCaches();
    // Also drop any cooldown for CLIs the user is trying to fix — otherwise
    // a previously-failing CLI is still locked out for ~5 min after the user
    // points it at a working binary.
    providerCooldowns.clear();
    loggedProviderCooldowns.clear();
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

  // ── Provider-specific request builders ──

  async function callClaude(apiKey, model, prompt, maxTokens = 500, baseUrlOverride = null) {
    const cfg = getConfig() || {};
    const baseUrl = baseUrlOverride || cfg.baseUrl || PROVIDERS.claude.baseUrl;
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "clawd-insights/1.0",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: model || PROVIDERS.claude.defaultModel,
        max_tokens: maxTokens,
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

  async function callOpenAICompat(apiKey, model, prompt, baseUrl, maxTokens = 500) {
    const rawUrl = baseUrl || PROVIDERS.openai.baseUrl;
    // Normalize the base URL to a full chat/completions endpoint.
    // Handles several common patterns:
    //   .../v1/chat/completions  → use as-is
    //   .../chat/completions     → use as-is (user already gave full path)
    //   .../v<N>  (e.g. /v1, /v4, /v2) → append /chat/completions
    //   anything else            → append /v1/chat/completions
    const trimmed = rawUrl.replace(/\/+$/, "");
    let url;
    if (trimmed.endsWith("/chat/completions")) {
      url = trimmed;
    } else if (/\/v\d+$/.test(trimmed)) {
      // Ends with /v1, /v4, /v2, etc. — just append the path
      url = `${trimmed}/chat/completions`;
    } else {
      url = `${trimmed}/v1/chat/completions`;
    }
    const headers = { "Content-Type": "application/json", "User-Agent": "clawd-insights/1.0" };
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: model || PROVIDERS.openai.defaultModel,
        max_tokens: maxTokens,
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

  // ── Provider Registry Management ──

  /**
   * Get the provider registry from config
   * @returns {Provider[]} Array of configured providers
   */
  function getProviderRegistry() {
    const cfg = getConfig();
    return (cfg && cfg.providers) || [];
  }

  /**
   * Add a new provider to the registry
   * @param {Omit<Provider, 'id'|'createdAt'|'updatedAt'>} provider - Provider data (without id)
   * @returns {Provider} The created provider with id and timestamps
   * @throws {Error} if validation fails or name already exists
   */
  function addProvider(provider) {
    validateProvider(provider);
    
    const cfg = getConfig() || { providers: [] };
    if (!cfg.providers) cfg.providers = [];
    
    // Check for duplicate names
    if (cfg.providers.some(p => p.name === provider.name)) {
      throw new Error(`Provider name "${provider.name}" already exists`);
    }
    
    const now = Date.now();
    const newProvider = {
      id: generateUUID(),
      ...provider,
      enabled: provider.enabled !== false,
      createdAt: now,
      updatedAt: now,
    };
    
    // Spread to a new object so the store detects a change (avoids noop on same reference)
    setConfig({ ...cfg, providers: [...cfg.providers, newProvider] });
    return newProvider;
  }

  /**
   * Update an existing provider
   * @param {string} id - Provider ID
   * @param {Partial<Omit<Provider, 'id'|'createdAt'>>} updates - Fields to update
   * @returns {Provider} The updated provider
   * @throws {Error} if provider not found or validation fails
   */
  function updateProvider(id, updates) {
    const cfg = getConfig() || { providers: [] };
    if (!cfg.providers) cfg.providers = [];
    
    const index = cfg.providers.findIndex(p => p.id === id);
    if (index === -1) {
      throw new Error(`Provider with id "${id}" not found`);
    }
    
    const existing = cfg.providers[index];
    const updated = { ...existing, ...updates, id: existing.id, createdAt: existing.createdAt };
    
    // Validate the updated provider
    validateProvider(updated);
    
    // Check for duplicate names (excluding self)
    if (updates.name && cfg.providers.some(p => p.id !== id && p.name === updates.name)) {
      throw new Error(`Provider name "${updates.name}" already exists`);
    }
    
    updated.updatedAt = Date.now();
    const newProviders = cfg.providers.map((p, i) => i === index ? updated : p);
    setConfig({ ...cfg, providers: newProviders });
    return updated;
  }

  /**
   * Delete a provider from the registry
   * @param {string} id - Provider ID
   * @throws {Error} if provider not found
   */
  function deleteProvider(id) {
    const cfg = getConfig() || { providers: [] };
    if (!cfg.providers) cfg.providers = [];
    
    const index = cfg.providers.findIndex(p => p.id === id);
    if (index === -1) {
      throw new Error(`Provider with id "${id}" not found`);
    }
    
    const newProviders = cfg.providers.filter((_, i) => i !== index);
    
    // Clean up default provider references if this provider was set as default
    const newDefaultProviders = { ...(cfg.defaultProviders || {}) };
    for (const mode of ['brief', 'detail', 'batch']) {
      if (newDefaultProviders[mode] === id) {
        delete newDefaultProviders[mode];
      }
    }
    
    setConfig({ ...cfg, providers: newProviders, defaultProviders: newDefaultProviders });
  }

  /**
   * Get a provider by ID
   * @param {string} id - Provider ID
   * @returns {Provider|null} The provider or null if not found
   */
  function getProvider(id) {
    const registry = getProviderRegistry();
    return registry.find(p => p.id === id) || null;
  }

  /**
   * Test a provider connection
   * @param {Omit<Provider, 'id'|'enabled'|'createdAt'|'updatedAt'>} provider - Provider to test
   * @returns {Promise<{success: boolean, error?: string, model?: string, latencyMs?: number}>}
   */
  async function testProvider(provider) {
    try {
      validateProvider(provider);
    } catch (err) {
      return { success: false, error: err.message };
    }
    
    const startTime = Date.now();
    const testPrompt = "Say 'OK' in one word.";
    
    // Build the actual URL that will be used so we can show it on failure
    let resolvedUrl = provider.baseUrl || "";
    if (provider.type === "openai") {
      const trimmed = resolvedUrl.replace(/\/+$/, "");
      if (trimmed.endsWith("/chat/completions")) resolvedUrl = trimmed;
      else if (/\/v\d+$/.test(trimmed)) resolvedUrl = `${trimmed}/chat/completions`;
      else resolvedUrl = `${trimmed}/v1/chat/completions`;
    }
    
    try {
      let result;
      if (provider.type === 'claude') {
        result = await callClaude(provider.apiKey, provider.model, testPrompt, 10, provider.baseUrl);
      } else if (provider.type === 'ollama') {
        result = await callOllama(provider.model, testPrompt, provider.baseUrl);
      } else {
        result = await callOpenAICompat(provider.apiKey, provider.model, testPrompt, provider.baseUrl, 10);
      }
      
      if (!result) {
        return { success: false, error: `No response from provider (URL: ${resolvedUrl})` };
      }
      
      return {
        success: true,
        model: provider.model,
        latencyMs: Date.now() - startTime,
      };
    } catch (err) {
      // Attach the resolved URL to the error so the user knows what was actually called
      const detail = err.message || "Unknown error";
      return { success: false, error: `${detail} (URL: ${resolvedUrl})` };
    }
  }

  /**
   * Get the default provider for a given analysis mode
   * @param {string} mode - Analysis mode ('brief', 'detail', 'batch')
   * @returns {string|null} Provider ID or null if not set
   */
  function getDefaultProvider(mode) {
    const cfg = getConfig();
    if (!cfg || !cfg.defaultProviders) return null;
    return cfg.defaultProviders[mode] || null;
  }

  /**
   * Set the default provider for a given analysis mode
   * @param {string} mode - Analysis mode ('brief', 'detail', 'batch')
   * @param {string} providerId - Provider ID
   * @throws {Error} if provider not found
   */
  function setDefaultProvider(mode, providerId) {
    if (!['brief', 'detail', 'batch'].includes(mode)) {
      throw new Error(`Invalid analysis mode: ${mode}`);
    }
    
    // Verify provider exists
    const provider = getProvider(providerId);
    if (!provider) {
      throw new Error(`Provider with id "${providerId}" not found`);
    }
    
    const cfg = getConfig() || {};
    setConfig({ ...cfg, defaultProviders: { ...(cfg.defaultProviders || {}), [mode]: providerId } });
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
      path.join(home, "bin"),
    ];
    if (isWin) {
      const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
      dirs.unshift(path.join(appData, "npm"));
    } else {
      dirs.unshift("/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin");
    }
    // Node version managers — Codex (and other npm-installed CLIs) end up
    // here when the user manages Node via NVM / Volta / fnm / asdf instead
    // of system Node. Without these, `findInLoginShell` is the only fallback
    // and it routinely fails because most NVM users put `nvm.sh` in
    // `~/.zshrc` (interactive) while we spawn `-l` (login) shells.
    try {
      const nvmDir = process.env.NVM_DIR || path.join(home, ".nvm");
      const nvmNodes = path.join(nvmDir, "versions", "node");
      const versions = fs.readdirSync(nvmNodes).sort().reverse();
      for (const v of versions) dirs.push(path.join(nvmNodes, v, "bin"));
    } catch { /* no nvm */ }
    try {
      const fnmRoot = process.env.FNM_DIR || path.join(home, ".fnm", "node-versions");
      const versions = fs.readdirSync(fnmRoot).sort().reverse();
      for (const v of versions) dirs.push(path.join(fnmRoot, v, "installation", "bin"));
    } catch { /* no fnm */ }
    try {
      const voltaHome = process.env.VOLTA_HOME || path.join(home, ".volta");
      dirs.push(path.join(voltaHome, "bin"));
    } catch { /* no volta */ }
    try {
      const asdfData = process.env.ASDF_DATA_DIR || path.join(home, ".asdf");
      dirs.push(path.join(asdfData, "shims"));
    } catch { /* no asdf */ }
    // pnpm / Yarn / Bun globals — covers users who installed Codex via
    // alternative package managers
    try { dirs.push(path.join(home, ".bun", "bin")); } catch { }
    try { dirs.push(path.join(home, ".yarn", "bin")); } catch { }
    if (process.env.PNPM_HOME) dirs.push(process.env.PNPM_HOME);
    try { dirs.push(path.join(home, "Library", "pnpm")); } catch { } // pnpm default on macOS
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
      const existing = lines.filter(file => fs.existsSync(file));
      if (!existing.length) return null;
      return isWin ? preferWindowsExecutable(existing) : existing[0];
    } catch { /* not in PATH */ }
    return null;
  }

  function findInLoginShell(commandName) {
    if (isWin) return null;
    const shell = process.env.SHELL || "/bin/sh";
    // Try login + interactive in turn. Most NVM/Volta/fnm users init their
    // version manager from `~/.zshrc` (interactive), so a pure `-l` (login)
    // invocation misses Codex even though `which codex` works in the user's
    // own terminal. We try the most aggressive combo first, then fall back.
    const attempts = [
      ["-l", "-i", "-c", `command -v ${commandName} 2>/dev/null`],
      ["-i", "-c", `command -v ${commandName} 2>/dev/null`],
      ["-l", "-c", `command -v ${commandName} 2>/dev/null`],
    ];
    for (const args of attempts) {
      try {
        const result = execFileSync(shell, args, {
          encoding: "utf8",
          timeout: 5000,
          env: buildCliEnv(),
          stdio: ["ignore", "pipe", "ignore"], // suppress shell rc noise
        });
        const lines = parseLocatorOutput(result).filter(line => line.startsWith("/"));
        const hit = lines[lines.length - 1];
        if (hit && fs.existsSync(hit)) return hit;
      } catch { /* try next combo */ }
    }
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

  // ── Local Claude CLI detection ──
  // (cachedClaudePath is hoisted to the top of the closure — see comment there)

  // Read user-supplied override (set via Settings UI). Returns the path if it
  // exists on disk, otherwise null. Bypasses every search heuristic so users
  // with exotic install layouts (NVM in non-standard dir, custom prefix, etc.)
  // have a guaranteed escape hatch.
  function getCustomCliPath(key) {
    const cfg = getConfig();
    if (!cfg || !cfg.customCliPaths) return null;
    const candidate = cfg.customCliPaths[key];
    if (typeof candidate !== "string" || !candidate.trim()) return null;
    const expanded = candidate.trim().replace(/^~(?=[/\\])/, os.homedir());
    try { if (fs.existsSync(expanded)) return expanded; } catch { }
    return null;
  }

  // Invalidate cached binary lookups when the user changes their custom path
  // (or any other config) — without this, switching from "wrong path" to
  // "right path" would still report the old result until app restart.
  function invalidateCliCaches() {
    cachedClaudePath = undefined;
    cachedCodexPath = undefined;
    // Drop the capability cache too — when the user re-points a CLI, the new
    // binary might be a totally different version with a different flag set.
    cliCapabilitiesCache.clear();
  }

  function findClaudeBinary() {
    if (ctx.disableCliDiscoveryForTests) return null;
    const custom = getCustomCliPath("claude");
    if (custom) return custom;
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
      const progFiles = process.env.PROGRAMFILES || "C:\\Program Files";
      extraCandidates.push(path.join(progFiles, "Claude Code", "claude.exe"));
      const progFilesX86 = process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)";
      extraCandidates.push(path.join(progFilesX86, "Claude Code", "claude.exe"));
    }

    // Linux-specific paths
    if (process.platform === "linux") {
      extraCandidates.push("/usr/local/bin/claude");
      extraCandidates.push("/opt/claude-code/bin/claude");
      // Linuxbrew
      const linuxbrew = "/home/linuxbrew/.linuxbrew/bin/claude";
      extraCandidates.push(linuxbrew);
      // Snap
      extraCandidates.push("/snap/claude/current/bin/claude");
    }

    cachedClaudePath = findCommandBinary("claude", extraCandidates);
    return cachedClaudePath;
  }

  // ── Codex CLI detection ──
  // (cachedCodexPath is hoisted to the top of the closure — see comment there)

  // Many users install Codex via the OpenAI desktop app (Codex.app) or the
  // OpenAI ChatGPT plugin for Cursor/VS Code instead of `npm i -g @openai/codex`.
  // Both bundle a fully working `codex-cli` binary that we can call directly,
  // but `which codex` returns nothing because nothing is on PATH. Enumerate
  // the known bundle locations so auto-detection covers these cases without
  // requiring the user to set a manual override.
  function getBundledCodexCandidates() {
    const home = os.homedir();
    const out = [];
    const exe = isWin ? "codex.exe" : "codex";

    // Mac app bundle (system + user-local Applications). Codex.app drops a
    // standalone Mach-O at Contents/Resources/codex; the .app shell is just
    // the launcher GUI. Verified on Codex.app 0.118.0-alpha.2 (Mar 2026).
    if (process.platform === "darwin") {
      out.push(`/Applications/Codex.app/Contents/Resources/codex`);
      out.push(path.join(home, "Applications", "Codex.app", "Contents", "Resources", "codex"));
    }

    // Cursor / VS Code "OpenAI ChatGPT" extension (publisher: openai.chatgpt).
    // The extension ships per-platform binaries under `bin/<platform>-<arch>/codex`.
    // Folder name encodes the version + platform: openai.chatgpt-26.325.31654-darwin-arm64
    // We glob the parent extensions dir, then dive into bin/* to find the binary.
    const extRoots = [
      path.join(home, ".cursor", "extensions"),
      path.join(home, ".vscode", "extensions"),
      path.join(home, ".vscode-insiders", "extensions"),
      path.join(home, ".windsurf", "extensions"), // Codeium fork
    ];
    for (const extRoot of extRoots) {
      try {
        const entries = fs.readdirSync(extRoot);
        for (const entry of entries) {
          // Match the OpenAI publisher prefix — covers `openai.chatgpt-*`
          // and any future Codex-branded extension under the same publisher.
          if (!/^openai\./i.test(entry) && !/codex/i.test(entry)) continue;
          const binDir = path.join(extRoot, entry, "bin");
          try {
            const archDirs = fs.readdirSync(binDir);
            for (const archDir of archDirs) {
              out.push(path.join(binDir, archDir, exe));
            }
          } catch { /* no bin dir */ }
        }
      } catch { /* no extensions dir */ }
    }

    return out;
  }

  function findCodexBinary() {
    if (ctx.disableCliDiscoveryForTests) return null;
    const custom = getCustomCliPath("codex");
    if (custom) return custom;
    if (cachedCodexPath !== undefined) return cachedCodexPath;
    const extras = [
      "/opt/homebrew/bin/codex",
      "/usr/local/bin/codex",
      ...getBundledCodexCandidates(),
    ];
    // Linux-specific Codex paths
    if (process.platform === "linux") {
      extras.push("/home/linuxbrew/.linuxbrew/bin/codex");
      extras.push("/snap/codex/current/bin/codex");
      extras.push("/opt/codex/bin/codex");
    }
    // Windows Program Files
    if (isWin) {
      const progFiles = process.env.PROGRAMFILES || "C:\\Program Files";
      extras.push(path.join(progFiles, "Codex", "codex.exe"));
    }
    cachedCodexPath = findCommandBinary("codex", extras);
    return cachedCodexPath;
  }

  // Probe a CLI binary for the long-flags it accepts on a given subcommand.
  // Used to skip version-gated flags (e.g. --ephemeral on codex < 0.118,
  // --output-schema on codex < 0.118, --tools "" on older claude versions)
  // that would otherwise hard-fail with `error: unexpected argument`.
  //
  // Result is a Set<string> of flag names including the leading `--`. An
  // empty set means probing failed — callers must treat that as "I don't know,
  // omit any version-gated flag" rather than "no flags supported", since
  // forcing the legacy minimal arg set always works.
  function getCliCapabilities(binaryPath, subcommand) {
    const cacheKey = `${binaryPath}::${subcommand || ""}`;
    if (cliCapabilitiesCache.has(cacheKey)) return cliCapabilitiesCache.get(cacheKey);
    const supported = new Set();
    try {
      const args = subcommand ? [subcommand, "--help"] : ["--help"];
      const output = execFileSync(binaryPath, args, {
        encoding: "utf8",
        timeout: 5000,
        env: buildCliEnv(),
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 1024 * 1024,
      });
      // Match `--flag-name` at the start of help lines (optionally preceded by
      // `-x, ` short alias). Walks both `--help` body and any "Options:" block.
      for (const m of String(output || "").matchAll(/^\s*(?:-\w[, ]+)?(--[a-z][a-z0-9-]*)/gim)) {
        supported.add(m[1]);
      }
    } catch (err) {
      // Don't spam — log once per binary
      const logKey = `caps:${cacheKey}`;
      if (!loggedCliBinaries.has(logKey)) {
        loggedCliBinaries.add(logKey);
        console.warn(`Clawd analytics: failed to probe ${binaryPath} ${subcommand || ""} --help:`, err.message);
      }
    }
    cliCapabilitiesCache.set(cacheKey, supported);
    return supported;
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

  // Detect "you need to log in again" style errors. Both Claude and Codex CLIs
  // surface these via different wording depending on version, so be inclusive.
  // When matched, friendlyCliError returns an actionable hint instead of the
  // raw upstream message — fixing the bad UX where `code 1` left users guessing.
  function isLikelyCliAuthFailure(message) {
    const text = String(message || "");
    return [
      /not (?:authenticated|logged in|signed in)/i,
      /please (?:log ?in|sign ?in|authenticate)/i,
      /(?:login|session|token|credential|auth(?:entication)?)\s+(?:expired|invalid|missing|required)/i,
      /(?:invalid|missing|expired|revoked)\s+(?:api[\s_-]?key|token|credential)/i,
      /authentication\s+(?:failed|required|error)/i,
      /unauthori[sz]ed/i,
      /401\b/,
      /OAuth\s+token/i,
      /run\s+`?claude(?:\s+login)?`?\s+to/i,
    ].some(re => re.test(text));
  }

  function friendlyCliError(cliName, message) {
    const text = String(message || "").trim();
    const proxyTarget = text.match(/\b(?:127\.0\.0\.1|localhost|\[::1\]|::1):(\d+)\b/i);
    if (proxyTarget && /connection refused/i.test(text)) {
      const host = proxyTarget[0].replace(/^\[|\]$/g, "");
      return `${cliName} 无法连接本地代理 ${host}。请确认代理已启动，或关闭该代理配置后重试。`;
    }
    if (isLikelyCliAuthFailure(text)) {
      const cmd = /codex/i.test(cliName) ? "codex login" : "claude";
      return `${cliName} 登录态失效或未认证。请在终端运行 \`${cmd}\` 重新登录后再试。`;
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

  // Best-effort error extraction from Claude CLI's stream-json output. Claude
  // streams everything to stdout as NDJSON (including failures), so when exit
  // code != 0 the real cause is usually buried in a `result` event with
  // `is_error: true` while stderr is empty. This walks the NDJSON, surfaces the
  // most informative error string we can find, and falls back to a stdout tail
  // so users at least see *something* instead of the bare `code 1`.
  function summarizeClaudeError(stdout, stderr, fallback) {
    const stderrTrim = String(stderr || "").trim();
    const stdoutText = String(stdout || "");

    // Pass 1: scan NDJSON for error-bearing events.
    const errorMessages = [];
    const lines = stdoutText.split("\n").filter(Boolean);
    for (const line of lines) {
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      if (!obj || typeof obj !== "object") continue;

      // result event flagged as error (most common path)
      if (obj.type === "result" && (obj.is_error === true || /error/i.test(obj.subtype || ""))) {
        const msg = obj.result || obj.error || obj.message;
        if (typeof msg === "string" && msg.trim()) errorMessages.push(msg.trim());
      }
      // system / init events with subtype=error (rare but possible)
      if (obj.type === "system" && /error/i.test(obj.subtype || "")) {
        const msg = obj.error || obj.message || obj.result;
        if (typeof msg === "string" && msg.trim()) errorMessages.push(msg.trim());
      }
      // assistant message with is_error flag
      if (obj.type === "assistant" && obj.is_error === true && obj.message) {
        const content = obj.message.content;
        if (Array.isArray(content)) {
          for (const c of content) {
            if (c && c.type === "text" && typeof c.text === "string") errorMessages.push(c.text.trim());
          }
        }
      }
      // top-level error field on any event
      if (typeof obj.error === "string" && obj.error.trim() && !errorMessages.includes(obj.error.trim())) {
        errorMessages.push(obj.error.trim());
      }
    }
    if (errorMessages.length) {
      return errorMessages.slice(0, 2).join(" | ").slice(0, 400);
    }

    // Pass 2: stderr (in case claude wrote anything there)
    if (stderrTrim) return stderrTrim.slice(0, 400);

    // Pass 3: stdout tail — strips JSON noise, keeps the last ~200 visible chars
    const tail = stdoutText.replace(/\s+/g, " ").trim().slice(-200);
    if (tail) return `${fallback || "claude exec failed"} (stdout tail: ${tail})`;

    return fallback || "claude exec failed";
  }

  // Extract and parse the first complete top-level JSON object from a free-form
  // text blob. The previous implementation used a greedy `/\{[\s\S]*\}/` regex
  // that grabbed from the FIRST `{` to the LAST `}`, which broke whenever the
  // model wrapped its JSON in markdown explanation that contained any other
  // `}` (think "outcomes": [{...}], or trailing "Note: see {related}").
  //
  // Strategy: walk char-by-char tracking string state and brace depth. Skip
  // until the first unquoted `{`, then read until the matching `}`. Try to
  // JSON.parse — if that succeeds, return the object; if it fails, continue
  // scanning past that block in case there's a *better* candidate later. On
  // total failure return null so callers fall through to a text-summary.
  // Attempt to fix unescaped double quotes inside JSON string values.
  // Common model mistake: {"detail":"确定以飞书"Home"主文档"} → parser breaks at inner "
  // Strategy: replace inner unescaped " with 「」 between JSON structural quotes.
  function sanitizeJsonQuotes(raw) {
    // Replace smart/curly quotes with Chinese quotes (they're unambiguous)
    let s = raw.replace(/[\u201C\u201D]/g, "\u300C").replace(/[\u2018\u2019]/g, "\u300E");
    // For straight double quotes inside string values: walk through and fix
    // This is a best-effort heuristic — not a full JSON parser
    const result = [];
    let inStr = false, escaped = false;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (escaped) { result.push(ch); escaped = false; continue; }
      if (ch === "\\") { result.push(ch); escaped = true; continue; }
      if (ch === '"') {
        if (!inStr) { result.push(ch); inStr = true; continue; }
        // We're inside a string and hit a ". Is this the closing quote?
        // Heuristic: closing quote is followed by :, ,, }, ], or whitespace
        const next = s[i + 1];
        if (!next || /[,:}\]\s]/.test(next)) {
          result.push(ch); inStr = false; // legitimate close
        } else {
          result.push("\u300C"); // replace rogue " with「
          // Find the matching close of this rogue quote pair
          const closeIdx = s.indexOf('"', i + 1);
          if (closeIdx > i + 1) {
            const afterClose = s[closeIdx + 1];
            if (afterClose && !/[,:}\]\s]/.test(afterClose)) {
              // The close quote is also rogue, replace it too
              // (handled naturally in the next iteration)
            }
          }
        }
      } else {
        result.push(ch);
      }
    }
    return result.join("");
  }

  function extractFirstJsonObject(text) {
    const s = String(text || "");
    let i = 0;
    while (i < s.length) {
      // Skip until next opening brace at depth 0
      while (i < s.length && s[i] !== "{") i++;
      if (i >= s.length) return null;
      const start = i;
      let depth = 0;
      let inString = false;
      let escape = false;
      for (; i < s.length; i++) {
        const ch = s[i];
        if (escape) { escape = false; continue; }
        if (inString) {
          if (ch === "\\") escape = true;
          else if (ch === '"') inString = false;
          continue;
        }
        if (ch === '"') { inString = true; continue; }
        if (ch === "{") depth++;
        else if (ch === "}") {
          depth--;
          if (depth === 0) {
            const candidate = s.slice(start, i + 1);
            try { return JSON.parse(candidate); }
            catch { /* malformed candidate — keep scanning */ }
            i++; // step past this `}` and look for the next `{`
            break;
          }
        }
      }
      if (depth !== 0) {
        // First pass failed — try sanitizing rogue quotes and re-parse
        if (s !== sanitizeJsonQuotes(s)) {
          const sanitized = extractFirstJsonObject(sanitizeJsonQuotes(s));
          if (sanitized) return sanitized;
        }
        return null;
      }
    }
    return null;
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

  // Knowledge compound output schema — passed to codex via --output-schema so
  // strict mode produces topAssets/unlinkedConnections/behaviorObservation
  // (matches the renderer in analytics.html). Without this, codex returns the
  // session-analysis schema (summary/keyTopics/outcomes) and the renderer is
  // empty.
  const KNOWLEDGE_COMPOUND_OUTPUT_SCHEMA = {
    type: "object",
    additionalProperties: false,
    properties: {
      topAssets: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            title: { type: "string" },
            sessions: { type: "array", items: { type: "string" } },
            why: { type: "string" },
          },
          required: ["title", "sessions", "why"],
        },
      },
      unlinkedConnections: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            a: { type: "string" },
            b: { type: "string" },
            insight: { type: "string" },
          },
          required: ["a", "b", "insight"],
        },
      },
      behaviorObservation: { type: "string" },
    },
    required: ["topAssets", "unlinkedConnections", "behaviorObservation"],
  };

  // callCodexCLI(codexPath, prompt, options?)
  //   options.cwd          — working dir for codex
  //   options.outputSchema — override default ANALYSIS_OUTPUT_SCHEMA;
  //                          pass `null` to omit --output-schema entirely.
  async function callCodexCLI(codexPath, prompt, options = {}) {
    const env = await sanitizeCliProxyEnv(buildCliEnv(), "codex");
    return new Promise((resolve, reject) => {
      const fullPrompt = buildInternalCliAnalysisPrompt(prompt);
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-codex-"));
      const outputFile = path.join(tmpDir, "last-message.txt");
      const schemaFile = path.join(tmpDir, "output-schema.json");
      // Resolve schema: explicit null = skip; undefined = default; object = use as-is
      const effectiveSchema = options && Object.prototype.hasOwnProperty.call(options, "outputSchema")
        ? options.outputSchema
        : ANALYSIS_OUTPUT_SCHEMA;
      if (effectiveSchema) {
        try { fs.writeFileSync(schemaFile, JSON.stringify(effectiveSchema)); } catch { /* ignore */ }
      }
      // Probe the installed codex once for the long-flags it supports — older
      // codex (≤ 0.117) doesn't recognize --ephemeral or --output-schema and
      // hard-fails with "error: unexpected argument" if we hand it the
      // 0.118+ arg set unconditionally.
      const caps = getCliCapabilities(codexPath, "exec");
      // Phase 0 cost/speed optimization (2026-04-07): force codex into fast
      // analysis mode. Without these, gpt-5.4 with `xhigh` reasoning_effort
      // routinely takes 90+ seconds. With them, the same task finishes in ~10s.
      const args = [
        "exec",
        "--skip-git-repo-check",
        "--json",
      ];
      // codex 0.118+ only — without it codex writes a session file to
      // ~/.codex/sessions/ which is harmless (codex JSONL monitor is fine
      // with extra entries), so degrading silently is acceptable.
      if (caps.has("--ephemeral")) args.push("--ephemeral");
      args.push(
        "--sandbox", "read-only",                // forbid any writes
        "-c", "model_reasoning_effort=low",      // gpt-5.4 default is xhigh — way too deep for analysis
        "-c", "tools.web_search=false",          // also avoids 'minimal' incompat error
      );
      // codex 0.118+ only — without strict schema we rely on the prompt
      // wording + extractFirstJsonObject() fallback to recover usable JSON.
      if (caps.has("--output-schema") && effectiveSchema) args.push("--output-schema", schemaFile);
      args.push(
        "-o", outputFile,
        "-",
      );
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

      child.stdin.end(fullPrompt);
    });
  }

  // ── Model + pricing detection ──
  //
  // Pricing table (USD per 1M tokens). Update as needed.
  // Prefer "alias" keys (haiku/sonnet/opus/gpt-5/etc) so user-config aliases work.
  // Each entry: { input, cachedInput (cache_read), cacheWrite (cache_creation), output }
  // cacheWrite defaults to 1.25× input (Anthropic 5-min cache); cachedInput defaults to 0.1× input.
  const MODEL_PRICING = {
    // Claude — official Anthropic prices per 1M tokens
    "claude-haiku-4-5": { input: 1.00, cachedInput: 0.10, cacheWrite: 1.25, output: 5.00 },
    "claude-sonnet-4-5": { input: 3.00, cachedInput: 0.30, cacheWrite: 3.75, output: 15.00 },
    "claude-opus-4-6": { input: 15.00, cachedInput: 1.50, cacheWrite: 18.75, output: 75.00 },
    "haiku": { input: 1.00, cachedInput: 0.10, cacheWrite: 1.25, output: 5.00 },
    "sonnet": { input: 3.00, cachedInput: 0.30, cacheWrite: 3.75, output: 15.00 },
    "opus": { input: 15.00, cachedInput: 1.50, cacheWrite: 18.75, output: 75.00 },
    // OpenAI — GPT-5 family per 1M tokens
    "gpt-5": { input: 1.25, cachedInput: 0.13, cacheWrite: 1.25, output: 10.00 },
    "gpt-5-mini": { input: 0.25, cachedInput: 0.025, cacheWrite: 0.25, output: 2.00 },
    "gpt-5.4": { input: 1.25, cachedInput: 0.13, cacheWrite: 1.25, output: 10.00 },
    "gpt-4o": { input: 2.50, cachedInput: 1.25, cacheWrite: 2.50, output: 10.00 },
    "gpt-4o-mini": { input: 0.15, cachedInput: 0.075, cacheWrite: 0.15, output: 0.60 },
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

  // Diagnostic helper for the Settings UI: report which CLIs were detected,
  // where they were found, and what search paths were tried for the missing
  // ones. Lets the user see "ah Codex isn't in any of these dirs, I'll point
  // it manually at /Users/me/.fnm/.../bin/codex".
  function getCliDiagnostics() {
    const out = {
      claude: null,
      codex: null,
      searchDirs: [],
      bundleCandidates: [],
      shell: process.env.SHELL || null,
    };
    try { out.searchDirs = getCommonCliSearchDirs(); } catch { }
    // Surface the Codex.app + Cursor/VS Code extension candidates so users
    // can verify Clawd checked the right place. We show all candidates (even
    // non-existent ones) so users on a fresh machine can see the search
    // surface area instead of an empty list.
    try { out.bundleCandidates = getBundledCodexCandidates(); } catch { }

    const claudePath = findClaudeBinary();
    out.claude = {
      found: !!claudePath,
      path: claudePath || null,
      version: claudePath ? getCliVersion(claudePath) : null,
      custom: !!getCustomCliPath("claude"),
      cooldown: getProviderCooldown("claude-code"),
    };

    const codexPath = findCodexBinary();
    out.codex = {
      found: !!codexPath,
      path: codexPath || null,
      version: codexPath ? getCliVersion(codexPath) : null,
      custom: !!getCustomCliPath("codex"),
      cooldown: getProviderCooldown("codex"),
    };

    return out;
  }

  // Test whether a user-supplied path is a valid CLI binary. Used by the
  // Settings UI's "Test" button so users can verify their custom path before
  // saving. Returns { ok, version, error }.
  function testCliPath(rawPath) {
    if (!rawPath || typeof rawPath !== "string") {
      return { ok: false, error: "empty path" };
    }
    const expanded = rawPath.trim().replace(/^~(?=\/)/, os.homedir());
    try {
      if (!fs.existsSync(expanded)) return { ok: false, error: "file not found: " + expanded };
      const version = getCliVersion(expanded);
      if (!version) return { ok: false, error: "binary did not respond to --version" };
      return { ok: true, version, path: expanded };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
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
    // Custom providers from the registry (added in v2)
    const customProviders = getProviderRegistry();
    for (const p of customProviders) {
      if (!p.enabled) continue;
      // Only skip if the exact same UUID id is already listed (avoid true duplicates).
      // Don't filter by type — multiple custom providers can share the same type (e.g. openai).
      const alreadyListed = options.some((o) => o.id === p.id);
      if (alreadyListed) continue;
      options.push({
        id: p.id,
        type: "api-custom",
        provider: p.type,
        label: p.name,
        model: p.model,
        baseUrl: p.baseUrl,
        pricingKey: resolvePricingKey(p.model),
      });
    }
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
    // Persist cacheable results to disk so daily reflection can read them after restart
    if (result._cacheable) _persistAnalysisResult(cacheKey, result);
    return result;
  }

  // ── Disk persistence for daily reflection ──

  let _diskCacheDebounce = null;

  function _persistAnalysisResult(cacheKey, result) {
    // Debounce writes — multiple analyses may run in quick succession (batch mode)
    if (_diskCacheDebounce) clearTimeout(_diskCacheDebounce);
    _diskCacheDebounce = setTimeout(() => {
      _diskCacheDebounce = null;
      try {
        const dir = path.dirname(analysisCachePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        let cache = {};
        try { cache = JSON.parse(fs.readFileSync(analysisCachePath, "utf8")); } catch { /* fresh */ }
        if (!cache.sessions) cache.sessions = {};
        // Strip internal fields, keep only what daily reflection needs
        const slim = {
          summary: result.summary || "",
          keyTopics: result.keyTopics || [],
          outcomes: result.outcomes || [],
          timeBreakdown: result.timeBreakdown || [],
          suggestions: result.suggestions || [],
          _mode: result._mode || "brief",
          _provider: result._provider || "",
          _ts: Date.now(),
        };
        cache.sessions[cacheKey] = slim;
        // Prune entries older than 7 days to prevent unbounded growth
        const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
        for (const [k, v] of Object.entries(cache.sessions)) {
          if (v._ts && v._ts < cutoff) delete cache.sessions[k];
        }
        fs.writeFileSync(analysisCachePath, JSON.stringify(cache));
      } catch (err) {
        console.warn("Clawd: failed to persist analysis cache:", err.message);
      }
    }, 500);
  }

  function loadPersistedAnalyses(startTs, endTs) {
    try {
      if (!fs.existsSync(analysisCachePath)) return [];
      const cache = JSON.parse(fs.readFileSync(analysisCachePath, "utf8"));
      if (!cache.sessions) return [];
      const results = [];
      for (const [key, entry] of Object.entries(cache.sessions)) {
        if (entry._ts && entry._ts >= startTs && entry._ts < endTs) {
          results.push({ cacheKey: key, ...entry });
        }
      }
      return results;
    } catch { return []; }
  }

  function clearAnalysisCaches() {
    sessionAnalysisCache.clear();
    onelinerCache.clear();
    return { ok: true };
  }

  // ── Brief mode prompt (default: concise + emotional value) ──
  function buildSessionBriefPrompt(detail) {
    let p = "你是用户的编程搭档。以下是用户与 AI agent 的对话摘要。\n";
    p += "请用简短、温暖的方式总结这段对话的核心收获。\n\n";
    p += buildSessionContext(detail);
    p += "\n请返回 JSON（不要 markdown code block），格式：\n";
    p += '{"summary":"1 句话概括核心收获，带情感色彩"';
    p += ',"keyTopics":["话题1","话题2"]';
    p += ',"outcomes":[{"headline":"3-4字成果","detail":"一句话具体说明"}]}\n';
    p += "要求：\n";
    p += "- summary：≤ 40 字，像队友一样说。用'搞定了''漂亮''辛苦了'这类语气，不要干列事实。\n";
    p += "- keyTopics：2-3 个，每个 ≤ 8 字。\n";
    p += "- outcomes：最多 2 条，headline 不加标点，detail 要具体。\n";
    p += "- 所有字段用中文。不要返回 suggestions 和 timeBreakdown。\n";
    p += "- **重要**：JSON 字符串值里不要出现未转义的双引号。引用名称请用「」或『』代替双引号。";
    return p;
  }

  // ── Detail mode prompt (full analysis) ──
  function buildSessionDetailPrompt(detail) {
    let p = "你是一个对话分析助手。以下是用户与 AI 编程 agent 的对话记录摘要。\n";
    p += "请从**用户视角**深度分析：用户想做什么、获得了什么成果、时间花在哪里。\n";
    p += "不要描述 agent 的工作流程，而是关注用户的意图和收获。\n\n";
    p += buildSessionContext(detail);
    p += "\n请返回 JSON（不要 markdown code block），格式：\n";
    p += '{"summary":"≤50字概括：做了什么+结果如何"';
    p += ',"keyTopics":["话题1","话题2","话题3"]';
    p += ',"outcomes":[{"headline":"3-4字短语","detail":"展开说明关键认知"}]';
    p += ',"timeBreakdown":[{"activity":"活动描述","percent":百分比}]';
    p += ',"suggestions":["建议"]}\n';
    p += "要求：\n";
    p += "- summary：**严格 ≤ 50 字**，一句话说清'做了什么 + 结果如何'。不要铺垫背景，不要描述过程。\n";
    p += "- keyTopics：3-5 个关键话题，每个 ≤ 10 字。\n";
    p += "- outcomes：3-5 条。headline 用 3-4 字（如'修路径''搭布局''定方案'），不加标点；detail 一句话展开关键认知。\n";
    p += "- timeBreakdown：3-5 条，从用户视角描述时间分配（'讨论架构设计'而非'调用 Read 工具'）。\n";
    p += "- suggestions：1-2 条简短实用的建议。做得好可以返回空数组。\n";
    p += "- 所有字段用中文。确保 JSON 完整闭合。\n";
    p += "- **重要**：JSON 字符串值里不要出现未转义的双引号。引用名称请用「」或『』代替双引号。";
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
      const fullPrompt = buildInternalCliAnalysisPrompt(prompt);
      // On Windows, spawning the .cmd shim requires shell:true, which routes
      // through cmd.exe. cmd.exe truncates multi-line args at the first
      // newline (our analysis prompt has 20+ lines), so Claude only sees the
      // internal marker and replies "What would you like me to do?". Pipe the
      // prompt via stdin to bypass the cmd.exe parser entirely. Other
      // platforms keep the -p path (no shell, no truncation, and stdin-based
      // invocation has subtly different behavior with some CLI versions).
      const viaStdin = isWindowsShellShim(claudePath);
      const args = [
        "-p", ...(viaStdin ? [""] : [fullPrompt]),
        "--output-format", "stream-json",
        "--verbose",                                            // required by Claude CLI 2.2+ with -p + stream-json
        "--tools", "",                                          // disable all built-in tools (-25K tokens)
        "--disable-slash-commands",                             // skip skill loading
        "--append-system-prompt", ANALYSIS_APPEND_SYSTEM_PROMPT, // nudge to JSON-only mode
      ];
      const child = spawnCli(claudePath, args, {
        env: buildCliEnv({ CLAUDE_CODE_ENTRYPOINT: "cli" }),
        stdio: [viaStdin ? "pipe" : "ignore", "pipe", "pipe"],
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
        fail(
          summarizeClaudeError(stdout, stderr, `claude exec 超时（${Math.round(timeoutMs / 1000)}s）`),
          { stdout, stderr, timedOut: true }
        );
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
          const fallbackMsg = `claude exec 退出异常${code !== null ? `（code ${code}）` : signal ? `（signal ${signal}）` : ""}`;
          return fail(
            summarizeClaudeError(stdout, stderr, fallbackMsg),
            { stdout, stderr, code, signal }
          );
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

      if (viaStdin) {
        child.stdin.on("error", (err) => fail(`claude stdin error: ${err.message}`, { stdout, stderr }));
        try {
          child.stdin.end(fullPrompt);
        } catch (err) {
          fail(`claude stdin write failed: ${err.message}`, { stdout, stderr });
        }
      }
    });
  }

  async function analyzeSession(detail, mode) {
    // Wrapper: guarantee _mode is on every result, regardless of which code path produced it
    const result = await _analyzeSessionImpl(detail, mode);
    if (result && typeof result === "object") result._mode = mode || "brief";
    return result;
  }

  async function _analyzeSessionImpl(detail, mode) {
    if (!detail) return null;
    const analysisMode = mode || "brief";
    const preferredProvider = detail._preferredProvider || "claude-code";
    const analysisSubjectId = detail.analysisId || detail.sessionId;

    // Check cache — invalidate if message count or provider changed
    const cacheKey = analysisCacheKey(analysisSubjectId, preferredProvider) + ":" + analysisMode;
    if (sessionAnalysisCache.has(cacheKey)) {
      const cached = sessionAnalysisCache.get(cacheKey);
      if (
        cached._analysisCacheVersion === ANALYSIS_CACHE_VERSION &&
        cached._msgCount === getDetailContextEntryCount(detail)
      ) {
        return cached;
      }
      // Content changed — re-analyze
      console.log(`Clawd analytics: session ${cacheKey} grew (${cached._msgCount} → ${getDetailContextEntryCount(detail)} entries), re-analyzing`);
      sessionAnalysisCache.delete(cacheKey);
    }

    const startTime = Date.now();
    const prompt = analysisMode === "detail" ? buildSessionDetailPrompt(detail) : buildSessionBriefPrompt(detail);
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
          obj._msgCount = getDetailContextEntryCount(detail);
          obj._analysisMs = Date.now() - startTime;
          obj._mode = analysisMode;
          return obj;
        };
        if (text) {
          // Try to extract a usable JSON object. extractFirstJsonObject() walks
          // balanced braces and tries JSON.parse on each candidate, returning
          // null if nothing parses. Critically, it does NOT throw — that means
          // a malformed-JSON response no longer gets misattributed as
          // "claude-cli failed" by the outer catch block.
          const parsed = extractFirstJsonObject(text);
          if (parsed) {
            const result = attachMeta(parsed);
            return maybeCacheAnalysisResult(cacheKey, result);
          }
          // Parse failed (or model returned no JSON at all). Log a clear,
          // non-misleading warning and fall back to a text-summary so the user
          // still sees *something* in the dashboard.
          console.warn(`Clawd analytics: ${cliName} returned unparseable JSON (${text.length} chars), falling back to text summary`);
          const trimmed = text.trim().slice(0, 300);
          const summary = trimmed || `${cliName} 返回了非结构化内容，无法解析为分析结果。请重试或切换到 API provider。`;
          const fallback = attachMeta({ summary, keyTopics: [], outcomes: [], timeBreakdown: [], suggestions: [] });
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
    // Check if preferredProvider is a custom registry provider UUID
    const customProvider = getProvider(preferredProvider);
    if (customProvider && !forcedApiProvider) {
      try {
        let text;
        if (customProvider.type === "claude") {
          text = await callClaude(customProvider.apiKey, customProvider.model, prompt, 500, customProvider.baseUrl);
        } else if (customProvider.type === "ollama") {
          text = await callOllama(customProvider.model, prompt, customProvider.baseUrl);
        } else {
          text = await callOpenAICompat(customProvider.apiKey, customProvider.model, prompt, customProvider.baseUrl);
        }
        if (!text) return null;
        const result = extractFirstJsonObject(text);
        if (!result) {
          const fallback = { summary: text.slice(0, 300), timeBreakdown: [], insights: [], suggestions: [], _msgCount: getDetailContextEntryCount(detail), _analysisMs: Date.now() - startTime };
          return maybeCacheAnalysisResult(cacheKey, fallback);
        }
        result._msgCount = getDetailContextEntryCount(detail);
        result._analysisMs = Date.now() - startTime;
        result._provider = customProvider.name;
        result._model = customProvider.model;
        return maybeCacheAnalysisResult(cacheKey, result);
      } catch (err) {
        return maybeCacheAnalysisResult(cacheKey, { summary: `分析失败 (${customProvider.name}): ${err.message}`, timeBreakdown: [], insights: [], suggestions: [] });
      }
    }

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
      // Use balanced-brace extractor; falls back to text summary on parse failure
      // instead of throwing into the outer catch (which would otherwise hide the
      // real reason behind a generic "分析失败" message).
      const result = extractFirstJsonObject(text);
      if (!result) {
        const fallback = { summary: text.slice(0, 300), timeBreakdown: [], insights: [], suggestions: [], _msgCount: getDetailContextEntryCount(detail), _analysisMs: Date.now() - startTime };
        return maybeCacheAnalysisResult(cacheKey, fallback);
      }
      result._msgCount = getDetailContextEntryCount(detail);
      result._analysisMs = Date.now() - startTime;
      return maybeCacheAnalysisResult(cacheKey, result);
    } catch (err) {
      return maybeCacheAnalysisResult(cacheKey, { summary: `分析失败: ${err.message}`, timeBreakdown: [], insights: [], suggestions: [] });
    }
  }

  function getAnalysisProvider() {
    return resolvePreferredAnalysisProvider(getAvailableAnalysisProviders(), getConfig());
  }

  // ── One-liner summaries (lightweight, for event cards) ──

  const onelinerCache = new Map();

  async function getSessionOneLiner(detail) {
    if (!detail) return null;
    if (onelinerCache.has(detail.sessionId)) return onelinerCache.get(detail.sessionId);

    const msgs = ((detail.conversation && detail.conversation.length)
      ? detail.conversation.slice(0, 6).map(m => (m && m.text ? `${m.role === "assistant" ? "助手" : "用户"}: ${m.text}` : ""))
      : (detail.userMessages || []).slice(0, 5).map(m => (m && m.text) || ""))
      .filter(Boolean)
      .join("\n");
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

    // Fallback to API — registry-first, then legacy fields
    const cfg = getConfig();
    // Try registry: use the "brief" default provider if set
    const registryProvider = getProvider(getDefaultProvider("brief"));
    if (registryProvider) {
      try {
        let text;
        if (registryProvider.type === "claude") {
          text = await callClaude(registryProvider.apiKey, registryProvider.model, prompt, 500, registryProvider.baseUrl);
        } else if (registryProvider.type === "ollama") {
          text = await callOllama(registryProvider.model, prompt, registryProvider.baseUrl);
        } else {
          text = await callOpenAICompat(registryProvider.apiKey, registryProvider.model, prompt, registryProvider.baseUrl);
        }
        const line = (text || "").trim().split("\n")[0].replace(/^["'""'']|["'""'']$/g, "").trim();
        if (line) { onelinerCache.set(detail.sessionId, line); return line; }
      } catch { /* fall through to legacy */ }
    }

    // Legacy fallback (for users not yet on v3 or with no registry provider)
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

  // ── Knowledge Compound Interest (multi-session cross-analysis) ──

  const KNOWLEDGE_COMPOUND_SYSTEM_PROMPT =
    "你的任务是分析一组对话记录，从中提炼出对话者的「知识复利资产」。\n\n" +
    "分析分三个层次：\n\n" +
    "1. 原子知识点：对话中明确学到或讨论过的具体事实、技术细节、方法论。\n" +
    "   列出每个知识点及其来源对话。\n\n" +
    "2. 隐含模式：\n" +
    "   - 跨对话反复出现的主题和关注点\n" +
    "   - 对话者做判断/决策时的隐含偏好和思维框架\n" +
    "   - 不同对话中的知识点之间存在但尚未被显式建立的连接\n" +
    "   - 对话者擅长但可能自己没意识到的思维能力\n\n" +
    "3. 复利潜力评估：\n" +
    "   对上述发现按「复利潜力」排序。高复利的标准是：\n" +
    "   - 跨领域可迁移（不只在一个场景有用）\n" +
    "   - 半衰期长（一年后还有用）\n" +
    "   - 已有多次复现（在不同对话中反复出现）\n" +
    "   - 可以形成网络效应（与其他知识点连接越多价值越大）\n\n" +
    "最终输出 JSON，格式如下：\n" +
    '{"topAssets":[{"title":"资产名","sessions":["会话标题1","会话标题2"],"why":"为什么有高复利潜力"}],' +
    '"unlinkedConnections":[{"a":"知识点A","b":"知识点B","insight":"为什么应该关联"}],' +
    '"behaviorObservation":"对话者在习惯层面可以调整的一件事"}\n\n' +
    "要求：\n" +
    "- topAssets：3-5 条最高复利资产\n" +
    "- unlinkedConnections：2-3 条未建立的连接\n" +
    "- behaviorObservation：1 条行为模式观察\n" +
    "- 所有字段用中文\n" +
    "- **重要**：JSON 字符串值里不要出现未转义的双引号。引用名称请用「」或『』代替双引号。";

  function buildKnowledgeCompoundPrompt(details) {
    let p = "以下是用户与 AI agent 的多段对话记录。请综合分析。\n\n";
    for (let i = 0; i < details.length; i++) {
      const d = details[i];
      p += `--- 对话 ${i + 1}`;
      if (d.title) p += `: ${d.title}`;
      p += " ---\n";
      p += buildSessionContext(d);
      p += "\n";
    }
    p += "\n请返回 JSON（不要 markdown code block）。";
    return p;
  }

  // analyzeKnowledgeCompound(details, options?)
  //   options.systemPrompt: override default system prompt
  //   options.provider: "claude-code" | "codex" | "api:claude" | "api:openai" | "api:ollama"
  //                     when omitted, auto-pick first available CLI, then config API.
  async function analyzeKnowledgeCompound(details, options = {}) {
    if (!details || !details.length) return null;
    const startTime = Date.now();
    const systemPrompt = (options && typeof options.systemPrompt === "string" && options.systemPrompt.trim())
      ? options.systemPrompt
      : KNOWLEDGE_COMPOUND_SYSTEM_PROMPT;
    const prompt = buildKnowledgeCompoundPrompt(details);

    // Resolve preferred provider
    let preferred = options && typeof options.provider === "string" ? options.provider : "";
    if (!preferred) {
      const available = getAvailableAnalysisProviders();
      const firstCli = available.find((p) => p.id === "claude-code" || p.id === "codex");
      if (firstCli) preferred = firstCli.id;
      else {
        const cfg = getConfig();
        preferred = cfg && cfg.provider ? `api:${cfg.provider}` : "claude-code";
      }
    }

    // Route 1: Claude CLI with --append-system-prompt (preserves system/user separation)
    if (preferred === "claude-code") {
      const claudePath = findClaudeBinary();
      if (!claudePath) return { error: true, summary: "Claude CLI 未找到。请安装 Claude Code 或改用其他 provider。" };
      try {
        const { text, usage, model, costUsd } = await callClaudeCLIWithSystem(claudePath, prompt, systemPrompt);
        const parsed = extractFirstJsonObject(text);
        if (parsed) {
          parsed._provider = "claude-code";
          parsed._model = model || getClaudeDefaultModel() || "unknown";
          parsed._analysisMs = Date.now() - startTime;
          if (usage) parsed._usage = usage;
          if (typeof costUsd === "number") parsed._cost = { usd: costUsd, source: "cli" };
          return parsed;
        }
        return { error: true, summary: "Claude CLI 返回内容无法解析为 JSON。" };
      } catch (err) {
        console.warn("Clawd knowledge-compound claude-code error:", err.message);
        return { error: true, summary: `Claude CLI 执行失败：${err.message}` };
      }
    }

    // Route 2: Codex CLI — no --append-system-prompt; fold system prompt into user prompt
    if (preferred === "codex") {
      const codexPath = findCodexBinary();
      if (!codexPath) return { error: true, summary: "Codex CLI 未找到。请安装 Codex 或改用其他 provider。" };
      try {
        const combined = systemPrompt + "\n\n" + prompt;
        // Override default analysis schema so codex returns
        // topAssets/unlinkedConnections/behaviorObservation; otherwise
        // strict-mode coerces output into summary/keyTopics/outcomes and the
        // renderer shows an empty card.
        const cliResult = await callCodexCLI(codexPath, combined, {
          outputSchema: KNOWLEDGE_COMPOUND_OUTPUT_SCHEMA,
        });
        const parsed = extractFirstJsonObject(cliResult.text);
        if (parsed) {
          parsed._provider = "codex-cli";
          parsed._model = cliResult.model || getCodexDefaultModel() || "unknown";
          parsed._analysisMs = Date.now() - startTime;
          if (cliResult.usage) parsed._usage = cliResult.usage;
          if (typeof cliResult.costUsd === "number") {
            parsed._cost = { usd: cliResult.costUsd, source: "cli" };
          } else if (cliResult.usage) {
            const est = estimateCost(cliResult.usage, parsed._model);
            if (est) parsed._cost = { usd: est.usd, source: "estimate", pricingKey: est.pricingKey };
          }
          return parsed;
        }
        return { error: true, summary: "Codex CLI 返回内容无法解析为 JSON。" };
      } catch (err) {
        console.warn("Clawd knowledge-compound codex error:", err.message);
        return { error: true, summary: `Codex CLI 执行失败：${err.message}` };
      }
    }

    // Route 3: API provider — registry-first, then legacy fields
    let apiProviderId = preferred;
    if (apiProviderId.startsWith("api:")) apiProviderId = apiProviderId.slice(4);
    const cfg = getConfig();

    // Try registry: explicit preferred provider, then "detail" mode default
    const registryProvider = getProvider(apiProviderId) || getProvider(getDefaultProvider("detail"));
    if (registryProvider) {
      try {
        const fullPrompt = systemPrompt + "\n\n" + prompt;
        const MAX_TOKENS = 2000;
        let text;
        if (registryProvider.type === "claude") {
          text = await callClaude(registryProvider.apiKey, registryProvider.model, fullPrompt, MAX_TOKENS, registryProvider.baseUrl);
        } else if (registryProvider.type === "ollama") {
          text = await callOllama(registryProvider.model, fullPrompt, registryProvider.baseUrl);
        } else {
          text = await callOpenAICompat(registryProvider.apiKey, registryProvider.model, fullPrompt, registryProvider.baseUrl, MAX_TOKENS);
        }
        const parsed = extractFirstJsonObject(text);
        if (parsed) {
          parsed._provider = registryProvider.name;
          parsed._model = registryProvider.model;
          parsed._analysisMs = Date.now() - startTime;
          return parsed;
        }
        return { error: true, summary: "API 返回内容无法解析为 JSON。" };
      } catch (err) {
        console.warn("Clawd knowledge-compound API error:", err.message);
        return { error: true, summary: `API 调用失败：${err.message}` };
      }
    }

    // Legacy fallback (for users not yet on v3 or with no registry provider)
    const provider = (PROVIDERS[apiProviderId] ? apiProviderId : (cfg && cfg.provider) || "claude");
    const apiKey = cfg && cfg.apiKey;
    if (PROVIDERS[provider] && PROVIDERS[provider].needsKey && !apiKey) {
      return { error: true, summary: "未配置 API Key，请先在设置中配置。" };
    }
    try {
      const model = (cfg && cfg.model) || (PROVIDERS[provider] && PROVIDERS[provider].defaultModel);
      const baseUrl = (cfg && cfg.baseUrl) || (PROVIDERS[provider] && PROVIDERS[provider].baseUrl);
      const fullPrompt = systemPrompt + "\n\n" + prompt;
      // Knowledge compound output is larger than brief analysis; bump max_tokens to 2000.
      const MAX_TOKENS = 2000;
      let text;
      if (provider === "claude") text = await callClaude(apiKey, model, fullPrompt, MAX_TOKENS);
      else if (provider === "ollama") text = await callOllama(model, fullPrompt, baseUrl);
      else text = await callOpenAICompat(apiKey, model, fullPrompt, baseUrl, MAX_TOKENS);
      const parsed = extractFirstJsonObject(text);
      if (parsed) {
        parsed._provider = provider;
        parsed._model = model;
        parsed._analysisMs = Date.now() - startTime;
        return parsed;
      }
      return { error: true, summary: "API 返回内容无法解析为 JSON。" };
    } catch (err) {
      console.warn("Clawd knowledge-compound API error:", err.message);
      return { error: true, summary: `API 调用失败：${err.message}` };
    }
  }

  // callClaudeCLI variant with custom system prompt for knowledge compound
  function callClaudeCLIWithSystem(claudePath, prompt, systemPrompt) {
    return new Promise((resolve, reject) => {
      const fullPrompt = buildInternalCliAnalysisPrompt(prompt);
      // See callClaudeCLI for rationale: cmd.exe truncates multi-line args.
      const viaStdin = isWindowsShellShim(claudePath);
      const args = [
        "-p", ...(viaStdin ? [""] : [fullPrompt]),
        "--output-format", "stream-json",
        "--verbose",
        "--tools", "",
        "--disable-slash-commands",
        "--append-system-prompt", systemPrompt,
      ];
      const child = spawnCli(claudePath, args, {
        env: buildCliEnv({ CLAUDE_CODE_ENTRYPOINT: "cli" }),
        stdio: [viaStdin ? "pipe" : "ignore", "pipe", "pipe"],
      });
      const timeoutMs = 120000; // longer timeout for multi-session
      const maxBytes = 4 * 1024 * 1024;
      let stdout = "";
      let stderr = "";
      let settled = false;

      function fail(message) {
        if (settled) return;
        settled = true;
        reject(new Error(message));
        try { child.kill(); } catch {}
      }

      const timer = setTimeout(() => fail("knowledge-compound CLI timed out"), timeoutMs);
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
        if (stdout.length > maxBytes) fail("output too large");
      });
      child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
      child.on("error", (err) => fail(err.message));
      child.on("close", (code) => {
        clearTimeout(timer);
        if (settled) return;
        if (code !== 0 && !stdout) { fail(`CLI exited ${code}: ${stderr.slice(0, 200)}`); return; }
        // Parse stream-json the same way as callClaudeCLI
        let text = "", usage = null, model = null, costUsd = null;
        try {
          for (const line of stdout.split("\n")) {
            if (!line.trim()) continue;
            const evt = JSON.parse(line);
            if (evt.type === "assistant" && Array.isArray(evt.message && evt.message.content)) {
              for (const block of evt.message.content) {
                if (block.type === "text") text += block.text;
              }
              usage = evt.message.usage || usage;
              model = evt.message.model || model;
            } else if (evt.type === "result") {
              if (typeof evt.cost_usd === "number") costUsd = evt.cost_usd;
              if (evt.result) text = evt.result;
            }
          }
        } catch {
          text = stdout;
        }
        if (!text) text = stdout;
        settled = true;
        resolve({ text, usage, model, costUsd });
      });

      if (viaStdin) {
        child.stdin.on("error", (err) => fail(`claude stdin error: ${err.message}`));
        try {
          child.stdin.end(fullPrompt);
        } catch (err) {
          fail(`claude stdin write failed: ${err.message}`);
        }
      }
    });
  }

  return { getApiKey, setApiKey, getConfig, setConfig, PROVIDERS, analyzeSession, getAnalysisProvider, getAvailableAnalysisProviders, findClaudeBinary, getSessionOneLiner, getCliDiagnostics, testCliPath, clearAnalysisCaches, loadPersistedAnalyses, analyzeKnowledgeCompound, getProviderRegistry, addProvider, updateProvider, deleteProvider, getProvider, testProvider, getDefaultProvider, setDefaultProvider, generateUUID, validateProvider };
};

module.exports.__test = {
  buildSessionContext,
  getDetailContextEntryCount,
  resolvePreferredAnalysisProvider,
  preferWindowsExecutable,
};
