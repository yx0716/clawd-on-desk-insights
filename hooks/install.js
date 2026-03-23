#!/usr/bin/env node
// Clawd Desktop Pet — Hook Installer
// Safely merges hook commands into ~/.claude/settings.json
// Does NOT overwrite existing hooks — appends to arrays

const fs = require("fs");
const path = require("path");
const os = require("os");

const HOOK_EVENTS = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
  "PostCompact",
  "Notification",
  "PermissionRequest",
  "Elicitation",
  "WorktreeCreate",
];

const MARKER = "clawd-hook.js";
const HTTP_MARKER = "23333/permission";

// HTTP hooks: PermissionRequest uses bidirectional HTTP hook for permission decisions.
// Claude Code fires PermissionRequest for tools needing approval (primarily Bash).
// Edit/Write permissions are handled by Claude Code's own permission mode — not our hook.
const HTTP_HOOKS = {
  PermissionRequest: {
    matcher: "",
    hook: {
      type: "http",
      url: "http://127.0.0.1:23333/permission",
      timeout: 600,
    },
  },
};

/**
 * Register Clawd hooks into ~/.claude/settings.json.
 * Safe to call multiple times — skips already-registered hooks.
 * @param {object} [options]
 * @param {boolean} [options.silent] - suppress console output (for auto-registration)
 * @returns {{ added: number, skipped: number }}
 */
function registerHooks(options = {}) {
  const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
  let hookScript = path.resolve(__dirname, "clawd-hook.js").replace(/\\/g, "/");
  // In packaged builds, __dirname points to app.asar (virtual); the actual
  // unpacked file lives under app.asar.unpacked (see package.json asarUnpack).
  hookScript = hookScript.replace("app.asar/", "app.asar.unpacked/");

  // Read existing settings
  let settings = {};
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
  } catch (err) {
    if (err.code !== "ENOENT") {
      throw new Error(`Failed to read settings.json: ${err.message}`);
    }
  }

  if (!settings.hooks) settings.hooks = {};

  let added = 0;
  let skipped = 0;
  let changed = false;

  for (const event of HOOK_EVENTS) {
    if (!Array.isArray(settings.hooks[event])) {
      // Preserve existing non-array config by wrapping it
      const existing = settings.hooks[event];
      settings.hooks[event] = existing && typeof existing === "object" ? [existing] : [];
      changed = true;  // format was normalized, need to persist
    }

    // Check if our hook is already registered (search nested hooks arrays too)
    const alreadyExists = settings.hooks[event].some((entry) => {
      if (!entry || typeof entry !== "object") return false;
      // Flat format: { type, command }
      if (typeof entry.command === "string" && entry.command.includes(MARKER)) return true;
      // Nested format: { matcher, hooks: [{ type, command }] }
      if (Array.isArray(entry.hooks)) {
        return entry.hooks.some((h) => h && typeof h.command === "string" && h.command.includes(MARKER));
      }
      return false;
    });

    if (alreadyExists) {
      skipped++;
      continue;
    }

    // Use nested format to match Claude Code's expected structure
    settings.hooks[event].push({
      matcher: "",
      hooks: [
        {
          type: "command",
          command: `node "${hookScript}" ${event}`,
        },
      ],
    });
    added++;
  }

  // Register HTTP hooks (permission decision collection)
  for (const [event, { matcher, hook }] of Object.entries(HTTP_HOOKS)) {
    if (!Array.isArray(settings.hooks[event])) {
      settings.hooks[event] = [];
      changed = true;
    }

    // Check if HTTP hook already registered (by URL marker + matcher)
    const httpExists = settings.hooks[event].some((entry) => {
      if (!entry || typeof entry !== "object") return false;
      // Flat format: { type: "http", url }
      if (entry.type === "http" && typeof entry.url === "string" && entry.url.includes(HTTP_MARKER)) return true;
      // Nested format: { matcher, hooks: [{ type: "http", url }] }
      if (Array.isArray(entry.hooks)) {
        return entry.hooks.some((h) => h && h.type === "http" && typeof h.url === "string" && h.url.includes(HTTP_MARKER));
      }
      return false;
    });

    if (httpExists) {
      skipped++;
      continue;
    }

    settings.hooks[event].push({
      matcher,
      hooks: [hook],
    });
    added++;
  }

  // Only write if something changed (avoid unnecessary disk I/O)
  if (added > 0 || changed) {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
  }

  if (!options.silent) {
    console.log(`Clawd hooks installed to ${settingsPath}`);
    console.log(`  Added: ${added} hooks`);
    if (skipped > 0) console.log(`  Skipped: ${skipped} (already registered)`);
    console.log(`\nHook events: ${HOOK_EVENTS.join(", ")}`);
    if (Object.keys(HTTP_HOOKS).length > 0) {
      console.log(`HTTP hooks: ${Object.keys(HTTP_HOOKS).join(", ")}`);
    }
  }

  return { added, skipped };
}

// Export for use by main.js
module.exports = { registerHooks };

// CLI: run directly with `node hooks/install.js`
if (require.main === module) {
  try {
    registerHooks();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
