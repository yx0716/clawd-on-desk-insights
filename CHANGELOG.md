# Changelog

## v0.6.0 — AI Agent Analytics Dashboard

First release of **clawd-on-desk-insights**, forked from [rullerzhou-afk/clawd-on-desk](https://github.com/rullerzhou-afk/clawd-on-desk).

### New: Insights Dashboard

- **Timeline view** — horizontal time blocks per day, color-coded by project, with adjustable time range
- **Distribution panel** — donut chart of time spent per project
- **Trend panel** — daily activity bar chart
- **Session cards** — grouped by day, showing first user message as preview
- **AI session analysis** — click any session for deep analysis: outcomes, time breakdown, key topics, and suggestions
- **Batch pre-analysis** — choose scope (today / 3 days / week / last N sessions) and provider (Claude Code or Codex) at startup
- **Smart caching** — auto-invalidates when session content grows; no redundant API calls
- **Local data scanning** — reads conversation history from `~/.claude/projects/`, `~/.codex/sessions/`, `~/.cursor/projects/`
- **Quick access** — tray menu or `Cmd/Ctrl+Shift+Alt+A`

### Inherited from upstream

All original clawd-on-desk features: desktop pet animations, multi-agent support (Claude Code, Codex, Copilot, Gemini, Cursor), permission bubbles, mini mode, eye tracking, terminal focus, remote SSH, and auto-update.
