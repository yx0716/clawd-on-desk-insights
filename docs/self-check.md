# Clawd Analytics — Quick Self-Check / 快速自检表

> Install the app, then walk through this checklist to verify everything works.
> 安装后按此表逐项检查，确认 analytics 功能是否正常。

## 1. Prerequisites / 前置条件

| # | Check | How | Expected |
|---|-------|-----|----------|
| 1 | OS | — | macOS / Windows / Linux |
| 2 | Node.js | `node -v` | v18+ |
| 3 | At least one AI agent installed | `claude --version` or `codex --version` | Returns a version number |

## 2. Log Paths / 日志路径

Check that your AI agent has generated session logs on disk.

| # | Agent | macOS / Linux | Windows |
|---|-------|---------------|---------|
| 4 | Claude Code | `ls ~/.claude/projects/` | `dir %USERPROFILE%\.claude\projects\` |
| 5 | Codex CLI | `ls ~/.codex/sessions/` | `dir %USERPROFILE%\.codex\sessions\` |
| 6 | Cursor Agent | `ls ~/.cursor/projects/` | `dir %USERPROFILE%\.cursor\projects\` |

**Linux users**: If your agent uses XDG paths, logs may be at `$XDG_CONFIG_HOME/claude/projects/` or `$XDG_DATA_HOME/codex/sessions/` instead. The app checks both locations.

## 3. AI Analysis / AI 分析能力

The dashboard uses a local CLI (preferred, free) or an API key to generate session summaries.

| # | Check | How | Expected |
|---|-------|-----|----------|
| 7 | Claude CLI available | `which claude` (Mac/Linux) / `where claude` (Win) | Returns a path |
| 8 | Codex CLI available | `which codex` / `where codex` | Returns a path |
| 9 | Or: API Key configured | Dashboard → Settings (gear icon) → API Key field | Non-empty |

**If neither CLI is found**: Open Dashboard → Settings → manually enter the CLI path, or enter an API Key for Claude / OpenAI / Ollama as fallback.

## 4. Feature Verification / 功能验证

| # | Feature | Action | Expected Result |
|---|---------|--------|-----------------|
| 10 | Dashboard opens | Right-click pet → Analytics, or `Cmd/Ctrl+Shift+Alt+A` | Window appears |
| 11 | Timeline has data | Look at the Timeline section | At least one day with colored blocks |
| 12 | Sessions list | Look at the Sessions section (left panel) | At least one session card |
| 13 | AI analysis | Click a session card | Right panel shows analysis (or loading spinner) |
| 14 | Zoom works | Mouse wheel on Timeline area | Time axis zooms in/out |
| 15 | Keyboard pan | Arrow keys ← → (when not in a text field) | Timeline pans left/right |
| 16 | Rename works | Click pencil icon → type new name → Enter | Name updates in both Timeline and Sessions |

## 5. Troubleshooting / 故障排除

| Symptom | Likely Cause | Solution |
|---------|-------------|----------|
| Timeline is blank | No session logs found at expected paths | Run check #4-6 above |
| "No sessions" | No recent AI activity, or wrong time range | Switch to Week or Month tab |
| AI analysis fails | CLI not found and no API key | Run check #7-9; configure in Settings |
| "CLI not detected" | Non-standard install path | Settings → enter custom CLI path |
| 0 sessions on Windows | ~~CRLF line ending parsing bug~~ (fixed in v0.6+) | Update to latest version |
| Dashboard won't open | Electron window issue | Try `Cmd/Ctrl+Shift+Alt+A` shortcut |

## 6. Supported Platforms / 平台支持状态

| Component | macOS | Windows | Linux |
|-----------|-------|---------|-------|
| Log scanning (Claude/Codex/Cursor) | ✅ | ✅ | ✅ |
| AI analysis (local CLI) | ✅ | ✅ | ✅ |
| AI analysis (API fallback) | ✅ | ✅ | ✅ |
| Config storage | ✅ | ✅ | ✅ |
| XDG path support | N/A | N/A | ✅ |
| Timeline zoom / pan | ✅ | ✅ | ✅ |
| Session rename | ✅ | ✅ | ✅ |

### Known Limitations

- **Codex sessions > 30 days old** may not appear in "find session" lookups (scan window is capped)
- **Symlinked log directories** are followed implicitly; duplicate sessions may appear if multiple symlinks point to the same files
- **Very long sessions** (100+ messages) may produce truncated AI analysis summaries
