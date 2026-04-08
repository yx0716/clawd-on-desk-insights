<div align="center">

# clawd-on-desk-insights
## A local-first analytics dashboard for your AI coding sessions

> "Among all the bubbles you've shared with your Agent — what's surfacing?"

[![Local-First](https://img.shields.io/badge/Local--First-8b5cf6)](#why-it-exists)
[![License: MIT](https://img.shields.io/badge/License-MIT-3178c6)](./LICENSE)
[![Platform](https://img.shields.io/badge/Platform-macOS%20%7C%20Windows%20%7C%20Linux-111827)](#getting-started)
[![Powered by Claude · Codex](https://img.shields.io/badge/Powered_by-Claude%20%C2%B7%20Codex-d97757)](#getting-started)
[![Built on Electron](https://img.shields.io/badge/Built_on-Electron-47848f)](#about-the-fork)

<p>
  <a href="#why-it-exists">Why</a> ·
  <a href="#what-the-dashboard-does">Features</a> ·
  <a href="#getting-started">Quick Start</a> ·
  <a href="#faq">FAQ</a> ·
  <a href="README.zh-CN.md">中文版</a>
</p>

</div>

<table align="center">
  <tr>
    <td width="50%" align="center" valign="top">
      <img src="assets/screenshot-timeline-1.png" alt="时间线面板" />
      <br /><sub><b>时间线视图</b> —— 每段会话的轨迹</sub>
    </td>
    <td width="50%" align="center" valign="top">
      <img src="assets/screenshot-ai-analysis.png" alt="AI 会话分析" />
      <br /><sub><b>AI 会话复盘</b> —— 你的尝试和收获</sub>
    </td>
  </tr>
</table>


**Clawd-on-desk-insights automatically scans the conversations you've already had with Claude Code, Codex CLI, Cursor and other agents, and turns them into a timeline plus AI-generated session summaries.** No more scrolling through endless chat history — it builds the knowledge cards for you.

Every conversation leaves an **imprint**. No idea you tried, no bug you wrestled with, no decision you made together with the Agent is ever wasted — they all come back into view in the **Analytics Dashboard**.

All data stays on your machine. AI analysis runs through your own local `claude` / `codex` CLI (or an API / Ollama backend you configure). Your conversations never touch a third party.

> Supports Windows 11, macOS, and Ubuntu/Linux. Requires Node.js.

## Why it exists

A day of vibe coding — five sessions open, three projects touched, two approaches debated with the Agent, terminal closed. You feel exhausted 🥱 but can't quite recall what you accomplished.

Or maybe the conversations *were* productive 🥂, but going back through the raw history to review them feels like a chore.

This project takes that weight off your shoulders 🎒: every conversation you've had with an AI agent is already sitting on your disk as JSONL (`~/.claude/projects/`, `~/.codex/sessions/`, `~/.cursor/projects/`) — it's just that nobody normally opens them. The insights dashboard turns those raw logs into a scrollable timeline and AI-generated review summaries.

Next time you want to recall *"what did I actually do today"*, *"which session had that working solution"*, or *"how did we end up handling that library last week"* — let the dashboard handle it.

## What the Dashboard does

| Capability | What you get |
|---|---|
| **Timeline view** | Visualize every session by date / project / agent / duration — at a glance, see when you worked, on what, and for how long |
| **Local history scan** | Reads `~/.claude/projects/`, `~/.codex/sessions/`, `~/.cursor/projects/` directly. No upload, no telemetry |
| **AI session review** | Per-session summary from the *user's* point of view: what you were trying to do, what you walked away with, key topics, time breakdown |
| **Flexible backends** | Local `claude` CLI, local `codex` CLI, or fall back to a configured API provider / Ollama — your choice, your keys |
| **Batch pre-analysis** | Pre-compute summaries for recent sessions and reuse provider-aware cached results |
| **Cost tracking** | See token usage and cost per analysis run |
| **Quick access** | Open from the tray menu, the right-click menu on the pet, or a global shortcut |

### See it in action

<table align="center">
  <tr>
    <td width="25%" align="center" valign="top">
      <img src="assets/screenshot-dashboard-menu.gif" alt="Open the dashboard" />
      <br /><sub><b>① Open</b><br/>right-click → Dashboard</sub>
    </td>
    <td width="25%" align="center" valign="top">
      <img src="assets/screen-shot-select-AI-provider.gif" alt="Pick a provider" />
      <br /><sub><b>② Pick a provider</b><br/>Local CLI / API / Ollama</sub>
    </td>
    <td width="25%" align="center" valign="top">
      <img src="assets/screenshot-ai-provider-settings.gif" alt="Tweak settings" />
      <br /><sub><b>③ Tweak settings</b><br/>gear ⚙ → AI Provider</sub>
    </td>
    <td width="25%" align="center" valign="top">
      <img src="assets/screenshot-ai-analysis.gif" alt="Run analysis" />
      <br /><sub><b>④ Run analysis</b><br/>batch or per-session</sub>
    </td>
  </tr>
</table>

## Getting Started

### 1. Install and run

```bash
git clone https://github.com/yx0716/clawd-on-desk-insights.git
cd clawd-on-desk-insights
npm install
npm start
```

Once it launches, a small crab (the default theme) appears on your desktop — that's the Clawd pet, and **every entry point to the dashboard goes through it**.

### 2. Open the Analytics Dashboard

There are three ways to open it — pick whichever feels natural:

- **Right-click the desktop pet** → choose **Analytics Dashboard** from the context menu
- **Click the tray icon** (menu bar on macOS, system tray on Windows/Linux) → **Analytics Dashboard**
- **Keyboard shortcut**: macOS `⌘ + Shift + Option + A` / Windows · Linux `Ctrl + Shift + Alt + A`

<p align="center">
  <img src="assets/screenshot-dashboard-menu.gif" width="720" alt="Right-click menu showing Analytics Dashboard">
</p>

The first time you open it, you'll see your timeline immediately — it just reads the session logs already on your disk. **No setup required for that part.**

### 3. Configure an AI provider for session summaries

The timeline works out of the box. But to make the dashboard automatically **generate a recap summary for each session**, you need to point it at something that can call a large language model — what we call an **AI Provider** (the analysis backend).

**What's a "provider"?** Plain answer: it's *whoever reads your conversation logs and writes the summary*. You have three options:

| Provider type | What it is | Setup | Best for |
|---|---|---|---|
| **Local CLI** *(recommended)* | Reuses the `claude` (Claude Code) or `codex` CLI you already have installed. Uses your existing subscription, no extra API charges. | **Nothing — auto-detected** | Anyone already using Claude Code or Codex — zero overhead |
| **API key** | An API key from Anthropic, OpenAI, or another provider. Pay-per-token. | Paste your key into the dashboard settings | Users without a local CLI who don't mind a small token cost |
| **Ollama** | A locally-hosted open model server (e.g. Ollama). | Point the dashboard at your Ollama endpoint | Fully offline, never sends data to the cloud |

> **💡 Strong recommendation**: if you already have Claude Code or Codex CLI installed, **do nothing** — the dashboard auto-detects them and reuses your existing subscription quota. Cheapest and easiest path.

<p align="center">
  <img src="assets/screen-shot-select-AI-provider.gif" width="720" alt="Selecting and configuring an AI Provider in action">
</p>

### 4. Where to configure / change the provider later

If you skipped step 3, or you want to switch providers later, you can open **AI Provider Settings** at any time:

Open the Analytics Dashboard → click the **gear icon ⚙** in the top-right → **AI Provider Settings** dialog appears.

<p align="center">
  <img src="assets/screenshot-ai-provider-settings.gif" width="720" alt="AI Provider Settings dialog">
</p>

The dialog has two sections:

- **LOCAL CLI DETECTION** — shows whether the dashboard found `claude` and `codex` on your machine. Green dot = found (with version + path); red dot = missing. **If you already see green dots, you're done — nothing to configure.**
- **API PROVIDER (FALLBACK)** — only kicks in when no local CLI is available. Pick a provider (Claude / OpenAI / Ollama / …), paste an API key, and you're set.

> **Tip**: if your `claude` or `codex` was installed via **NVM, fnm, or Volta**, auto-detection may miss it. Run `which claude` or `which codex` in your terminal and paste the output into the **Claude binary path** / **Codex binary path** override field.

### 5. Trigger AI analysis

Once your provider is set up, **how do you actually make the dashboard read your conversations and produce summaries?** Two paths — pick whichever (or combine them):

#### Method A: Batch pre-analysis (auto-prompted on dashboard open)

Every time you open the Analytics Dashboard, if there are unanalyzed sessions, the dashboard **automatically pops up a dialog** — `Pre-analyze Sessions` — letting you analyze a whole time range in one go.

Available scopes:

- **Today** — every session from today
- **3 Days** — the last 3 days
- **Week** — the last 7 days
- **Custom** — your last N sessions

Pick a scope, hit confirm, and the dashboard runs through them with an `Analyzing 1/N`, `2/N`, ... progress bar in the background. **Already-analyzed sessions are auto-skipped** (per-provider cache), so re-clicking never wastes tokens.

<p align="center">
  <img src="assets/screen-shot-select-AI-provider.gif" width="720" alt="Batch pre-analysis and per-session analysis in action">
</p>

> **Best for**: first-time users, monthly retrospectives, catching up on a backlog.

#### Method B: Click a single session (from the timeline or the sessions list)

If you **only want to review one specific session**, no batch needed, just click it:

- **From the timeline** — in Timeline view, click any colored block (each block is a session) and the detail card slides out on the right
- **From the Sessions list** — click any session card in the right-side list

Either way, the dashboard will:

1. Show the **cached summary first** if it exists (sessions previously batch-analyzed are tagged `Analyzed` and open instantly)
2. If not yet analyzed, the click **immediately kicks off a single-session analysis** — the card shows an `Analyzing…` tag, and the result appears in seconds to tens of seconds

<p align="center">
  <img src="assets/screenshot-ai-analysis.gif" width="720" alt="Triggering single-session analysis from the timeline">
</p>

> **Best for**: you already know which session you want to revisit, ad-hoc lookups, day-to-day "scrolling through" history.

#### How to combine the two

- **First time using it** → run **Method A on Week** once, or pick a custom range/count for the sessions you want analyzed (a few minutes, costs more tokens upfront, but every record opens instantly afterwards)
- **Daily use** → after that initial batch, switch to **Method B — pick specific sessions** as needed; only fresh ones require a manual trigger
- **Token-sensitive** → use **Method B on demand**, only analyze the sessions you actually want to read — not a single wasted cent

> **About cost**: Local CLI (Claude Code / Codex subscription) analysis **uses your existing subscription quota** — typically no extra charges. In API key mode, the dashboard shows **token usage and cost** in the top status bar after each analysis completes, so you always know what you're spending.

## FAQ

**Q: Does the dashboard need internet?**
Scanning and the timeline are **fully offline**. Whether AI summaries need internet depends on which provider you pick: Local CLI uses whatever network stack Claude Code / Codex normally use; Ollama is fully offline; API key mode talks to the cloud.

**Q: Are my conversations uploaded anywhere?**
No. Clawd Insights collects zero telemetry. The provider step is *your* CLI or *your* API key calling *the model you chose* directly — no third-party server in the middle.

**Q: I don't have Claude Code or Codex. Can I still use it?**
Yes. You can use the timeline view alone (completely free, no LLM required), or paste an Anthropic / OpenAI API key into AI Provider Settings to enable the cloud path.

## About the Fork

This is a fork of [`rullerzhou-afk/clawd-on-desk`](https://github.com/rullerzhou-afk/clawd-on-desk) — a desktop pet that reacts to your coding agent in real time. The pet is still here (animations, permission bubbles, multi-agent state tracking), but the focus of *this* fork is the insights layer on top.

Multi-agent support carried over from upstream: **Claude Code**, **Codex CLI**, **Copilot CLI**, **Gemini CLI**, **Cursor Agent**, **Kiro CLI**, and **opencode**. Note that the analytics scanner currently covers Claude Code, Codex CLI, and Cursor Agent only — the other agents still drive pet animations, but their histories aren't yet wired into the dashboard.

For the full feature list of the desktop pet (animations, permission bubbles, mini mode, click reactions, themes, remote SSH, etc.), see the [upstream README](https://github.com/rullerzhou-afk/clawd-on-desk).

## License

Source code: [MIT License](LICENSE).

**Artwork (assets/) is NOT covered by MIT.** All rights reserved by their respective copyright holders. See [assets/LICENSE](assets/LICENSE).

- **Clawd** character is the property of [Anthropic](https://www.anthropic.com). Unofficial fan project, not affiliated with Anthropic.
- **Calico cat (三花猫)** artwork by 鹿鹿 ([@rullerzhou-afk](https://github.com/rullerzhou-afk)). All rights reserved.
- **Third-party contributions**: copyright retained by respective artists.
