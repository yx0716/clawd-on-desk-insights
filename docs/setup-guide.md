# Setup Guide

[Back to README](../README.md)

## Agent Setup

**Claude Code** — works out of the box. Hooks are auto-registered on launch. Versioned hooks (`PreCompact`, `PostCompact`, `StopFailure`) are registered only when Clawd can positively detect a compatible Claude Code version; if detection fails (common for packaged macOS launches), Clawd falls back to core hooks and removes stale incompatible versioned hooks automatically.

**Codex CLI** — works out of the box. Clawd polls `~/.codex/sessions/` for JSONL logs automatically.

**Copilot CLI** — requires manual hook setup. See [copilot-setup.md](copilot-setup.md) for instructions.

**Kiro CLI** — run `npm run install:kiro-hooks` if you want hooks registered before launching Clawd. Kiro's built-in `kiro_default` agent is not backed by an editable JSON file, so Clawd creates a custom `clawd` agent and re-syncs it from the latest `kiro_default` each time Clawd starts, then appends hooks. Use `kiro-cli --agent clawd` for a new chat, or `/agent swap clawd` inside an existing Kiro session, when you want hooks enabled. On macOS, state-driven animations have been verified; native terminal permission prompts such as `t / y / n` still need to be answered in the terminal.

## Remote SSH (Claude Code & Codex CLI)

<img src="../assets/screenshot-remote-ssh.png" width="560" alt="Remote SSH — permission bubble from Raspberry Pi">

Clawd can sense AI agent activity on remote servers via SSH reverse port forwarding. Hook events and permission requests travel through the SSH tunnel back to your local Clawd — no code changes needed on the Clawd side.

**One-click deploy:**

```bash
bash scripts/remote-deploy.sh user@remote-host
```

This copies hook files to the remote server, registers Claude Code hooks in remote mode, and prints SSH configuration instructions.

**SSH configuration** (add to your local `~/.ssh/config`):

```
Host my-server
    HostName remote-host
    User user
    RemoteForward 127.0.0.1:23333 127.0.0.1:23333
    ServerAliveInterval 30
    ServerAliveCountMax 3
```

**How it works:**
- **Claude Code** — command hooks on the remote server POST state changes to `localhost:23333`, which the SSH tunnel forwards back to your local Clawd. Permission bubbles work too — the HTTP round-trip goes through the tunnel.
- **Codex CLI** — a standalone log monitor (`codex-remote-monitor.js`) polls JSONL files on the remote server and POSTs state changes through the same tunnel. Start it on the remote: `node ~/.claude/hooks/codex-remote-monitor.js --port 23333`

Remote hooks run in `CLAWD_REMOTE` mode which skips PID collection (remote PIDs are meaningless locally). Terminal focus is not available for remote sessions.

> Thanks to [@Magic-Bytes](https://github.com/Magic-Bytes) for the original SSH tunneling idea ([#9](https://github.com/rullerzhou-afk/clawd-on-desk/issues/9)).

## WSL (Windows Subsystem for Linux)

If you run Claude Code inside WSL while Clawd runs on the Windows host, hooks can POST directly to `127.0.0.1:23333` — no SSH tunnel needed, because WSL2 shares localhost with Windows by default.

**Setup:**

```bash
# Inside your WSL shell:
mkdir -p ~/.claude/hooks

# Copy hook files from the Windows-side repo (adjust the /mnt/ path to your Clawd location)
cp /mnt/d/animation/hooks/{server-config,json-utils,shared-process,clawd-hook,install}.js ~/.claude/hooks/

# Register hooks in remote mode
node ~/.claude/hooks/install.js --remote
```

If you have SSH enabled in WSL, the one-click deploy script also works:

```bash
# From Windows (Git Bash / PowerShell):
bash scripts/remote-deploy.sh youruser@localhost
```

After setup, start Clawd on Windows and run Claude Code in WSL — Clawd reacts to your sessions automatically. Permission bubbles work too.

> **Note:** WSL2 localhost forwarding requires Windows 10 build 18945+ (enabled by default). If it doesn't work, check that `localhostForwarding=true` is not disabled in `%USERPROFILE%\.wslconfig`.

## macOS Notes

- **From source** (`npm start`): works out of the box on Intel and Apple Silicon.
- **DMG installer**: the app is not signed with an Apple Developer certificate, so macOS Gatekeeper will block it. To open:
  - Right-click the app → **Open** → click **Open** in the dialog, or
  - Run `xattr -cr /Applications/Clawd\ on\ Desk.app` in Terminal.

## Linux Notes

- **From source** (`npm start`): `--no-sandbox` is passed automatically to work around chrome-sandbox SUID requirements in dev mode.
- **Packages**: AppImage and `.deb` are available from [GitHub Releases](https://github.com/rullerzhou-afk/clawd-on-desk/releases). After deb install, the app icon appears in GNOME's app menu.
- **Terminal focus**: uses `wmctrl` or `xdotool` (whichever is available). Install one for session terminal jumping to work: `sudo apt install wmctrl` or `sudo apt install xdotool`.
- **Auto-update**: when running from a cloned repo, "Check for Updates" performs `git pull` + `npm install` (if dependencies changed) and restarts the app automatically.
