# Clawd 桌宠 — 开发计划

## 项目概述

一个桌面宠物（Windows + macOS），基于 Claude Code 吉祥物 Clawd（像素风螃蟹），能感知 Claude Code 的工作状态并做出对应动画反应。

**已完成里程碑**：MVP → 状态感知 → 交互打磨 → 生命感（眼球追踪/点击反应/睡眠序列）→ macOS 适配 → GitHub 发布（v0.3.2）→ 终端定位（v0.3.3）→ 权限审批气泡（v0.3.4）→ blocking 权限审批（v0.3.5）

---

## 当前待办

### 未完成的零散项

- [ ] 光标离开屏幕或距离太远时，眼睛回到默认位置
- [ ] 考虑添加自定义动画（PixelLab.ai 或 Piskel 手绘）

### 借鉴 Notchi 的改进（2026-03-23 调研 [sk-ruban/notchi](https://github.com/sk-ruban/notchi)）

**优先级 1 — 音效系统**（🚧 进行中，遇到 autoplay policy 阻塞）

给桌宠加短音效，增强"生命感"。

- [ ] 通知/完成/错误等关键状态切换时播放短音效（⚠️ `98cad6f` WIP：隐藏窗口 autoplay policy 阻止音频播放，待解决）
- [ ] 右键菜单 + 托盘添加静音/取消静音开关
- [ ] 终端聚焦时自动静音（用户正在写代码不要吵）
- [ ] 同一 session 短时间内不重复播放（冷却机制）
- [ ] DND/sleeping 状态下不播音效

**优先级 1.5 — 随 Claude Code 自动启动（✅ 已合并，PR #12 by yujiachen-y，2026-03-25）**

社区贡献。托盘菜单"随 Claude Code 启动" checkbox，开启后注册 SessionStart hook 自动拉起桌宠。

- [x] `hooks/auto-start.js`：健康检查 `127.0.0.1:23333`，未运行时 spawn 启动（支持源码 / exe / .app）
- [x] `hooks/install.js`：`registerHooks({ autoStart })` + `unregisterAutoStart()` + `isAutoStartRegistered()`
- [x] `main.js`：托盘 checkbox、偏好持久化、i18n（en/zh）
- ⚠️ 仅限 Claude Code，Codex 等其他 agent 不走 hook 系统，需 M3 多 agent 适配时统一处理启动策略

**优先级 2 — Hook 卸载脚本**

用户卸载应用后不要在 `~/.claude/settings.json` 里留垃圾。

- [ ] 新增 `hooks/uninstall.js`，从 settings.json 中移除所有 Clawd hook 条目
- [ ] 仅删除 Clawd 自己注册的条目，不动其他 hook
- [ ] 右键菜单"卸载 Hooks"选项 或 应用退出时提示

---

## 借鉴 Masko Code 的改进（2026-03-24 调研 [RousselPaul/masko-code](https://github.com/RousselPaul/masko-code)）

> Masko Code 是 Swift 原生 macOS 应用，支持 Claude Code / Codex / Copilot 三个 agent。
> 它在"工具"维度很强（权限审批、终端跳转、多 agent），但缺少桌宠灵魂（无眼球追踪、无物理反应、无睡眠序列）。
> 以下是我们要借鉴的三个核心功能。

### M1. VS Code 扩展精确终端 tab 跳转（优先级：高）

**现状**：我们用 `EnumWindows` + 窗口标题匹配，能定位到正确的**窗口**，但同一窗口内多个终端 tab 无法区分。

**目标**：写一个极简 VS Code/Cursor 扩展（~30 行），通过 URI scheme + PID 匹配精确切到对应终端 tab。

**Masko 的实现（23 行）**：
```javascript
// vscode://masko.terminal-focus?pid=12345
vscode.window.registerUriHandler({
  async handleUri(uri) {
    const pid = parseInt(new URLSearchParams(uri.query).get('pid'));
    for (const terminal of vscode.window.terminals) {
      if (await terminal.processId === pid) {
        terminal.show(false);
        return;
      }
    }
  }
});
```

**实施要点**：
- [x] 创建 `extensions/vscode/` 目录，编写扩展（package.json + extension.js）
- [x] 注册 URI handler：`vscode://clawd.clawd-terminal-focus?pids=<PID_CHAIN>`（PID 链匹配，兼容中间进程）
- [x] `focusTerminalWindow()` 优先用 URI scheme 跳转，fallback 到现有 EnumWindows 方案
- [x] 支持 VS Code + Cursor（`vscode://` vs `cursor://`，hook 自动检测 code.exe/cursor.exe）
- [x] 自动安装（Electron 启动时检测 `~/.vscode/extensions` 和 `~/.cursor/extensions`，自动复制扩展）
- [x] macOS 兼容（`shell.openExternal()` 跨平台，macOS 额外检测 full comm path 解决 Electron binary 名问题）

**工作量**：小（扩展本身 ~30 行，主要工作在集成和自动安装）

### M2. 崩溃恢复 + 进程存活检测（优先级：高）

**现状**：如果 Clawd 在 Claude Code 运行中重启，会一直停在 idle 直到下一个 hook 事件。无法检测孤儿会话。

**目标**：定期检测 Claude Code / Codex 进程是否还活着，自动清理孤儿会话，支持会话重新激活。

**Masko 的实现**：
- 每 2 分钟 `pgrep` 检查进程存活
- 1 小时以上无活动的孤儿会话自动 end
- 每 3 秒轮询 transcript JSONL 尾部 4KB，检测 `[Request interrupted by user]`
- 会话结束后如果新事件到来，可以重新激活

**实施要点**：
- [ ] 新增 `sessionReconciler` 定时器（2 分钟间隔）
- [ ] Windows：`Get-Process` / `wmic` 检查 claude.exe / codex.exe 进程是否存活
- [ ] macOS：`pgrep -f claude` / `pgrep -f codex`
- [ ] 孤儿会话判定：进程已死 + 最后活动超过 N 分钟 → 自动 `updateSession(sid, "sleeping")`
- [ ] 中断检测：定期读 transcript 文件尾部，检测 `[Request interrupted by user]`（可选，优先级低）
- [ ] 会话重新激活：已 end 的 session 收到新事件时重新 activate

**工作量**：中等

### M3. 多 Agent 适配器架构（优先级：中）

**现状**：所有代码硬编码绑定 Claude Code。hook 脚本、事件映射、状态机都混在一起。

**目标**：抽象出 Agent 适配层，让支持新 agent（Codex、Copilot）只需新增配置 + hook 脚本，不碰核心逻辑。

**Masko 的架构（端口-适配器模式）**：
```
AgentAdapter 协议（端口）
  ├─ ClaudeCodeAdapter → HTTP hook (curl POST, 阻塞式 PermissionRequest)
  ├─ CodexAdapter      → 日志轮询 (~/.codex/sessions/*.jsonl, 1s 间隔)
  └─ CopilotAdapter    → 复用 HTTP server (注入 source:"copilot" 字段)

MaskoEventBus（回调转发）
  → EventProcessor（统一处理）
  → SessionStore（跨 agent 会话追踪）
  → OverlayStateMachine（动画状态切换）
```

**Codex CLI 的现实限制（2026-03-24 更新）**：
- **Windows 上 hooks 完全禁用**（源码 hardcoded，非 bug）
- 仅 4 个事件：SessionStart、UserPromptSubmit、PreToolUse、Stop
- 没有 HTTP hook 类型，只有 command
- PreToolUse 只能 deny，不能 approve（不能做 bubble 审批）
- 没有 PostToolUse、SubagentStart/Stop、Notification、PermissionRequest
- Masko 的解决方案：不用 hook，**日志轮询** `~/.codex/sessions/*.jsonl`

**实施方案**：

不搞 Masko 那种重度 OOP 适配器（我们是 Node.js 单文件架构），用轻量配置驱动：

```javascript
// agents/claude-code.js
module.exports = {
  name: "Claude Code",
  processNames: { win: ["claude.exe"], mac: ["claude"] },
  hookScript: "clawd-hook.js",
  eventMap: {
    SessionStart: "idle", UserPromptSubmit: "thinking",
    PreToolUse: "working", PostToolUse: "working",
    // ... 完整映射
  },
  supportsHttpHook: true,       // 支持 blocking 权限审批
  supportsPermissionApproval: true,
};

// agents/codex.js
module.exports = {
  name: "Codex CLI",
  processNames: { win: ["codex.exe"], mac: ["codex"] },
  sessionLogDir: "~/.codex/sessions",  // 日志轮询路径
  eventSource: "log-poll",             // 不走 hook，走日志轮询
  eventMap: {
    SessionStart: "idle", UserPromptSubmit: "thinking",
    PreToolUse: "working", Stop: "attention",
  },
  supportsHttpHook: false,
  supportsPermissionApproval: false,   // 只能聚焦终端
};
```

- [ ] 提取 `agents/` 配置目录，每个 agent 一个配置文件
- [ ] `main.js` 的 `updateSession()` 从 agent 配置读事件映射（替代硬编码）
- [ ] 新增 Codex 日志轮询模块（`agents/codex-log-monitor.js`）
  - 监听 `~/.codex/sessions/*.jsonl` 文件变化
  - 增量读取新行，解析 record type → 映射为统一事件
  - 注入到现有 `updateSession()` 流程
- [ ] Codex hook 安装脚本（macOS/Linux 用 command hook，Windows 用日志轮询 fallback）
- [ ] 会话来源标记：`AgentSession` 加 `agentSource` 字段，右键菜单/dashboard 显示来源图标
- [ ] 权限 bubble 根据 agent 能力调整 UI（Codex：只显示 "Jump to Terminal" 按钮，不显示 Allow/Deny）

**工作量**：大（涉及架构重构 + Codex 日志解析 + 新 hook 脚本 + UI 适配）

---

## 第五阶段：效率工具化

**目标：Clawd 不只是陪伴，还能提升工作效率。**

### 5.1 终端定位（✅ 已完成，Windows + macOS）

点击桌宠跳转回正在运行 Claude Code 的终端窗口。

**Windows（已完成）：**
- [x] Hook 脚本走进程树找到终端应用 PID（不依赖终端名字，自动兼容所有终端）
- [x] 预热 PowerShell + ALT 键绕过 + SetForegroundWindow 激活窗口（秒跳）
- [x] 多会话时，跳转到当前最高优先级的会话对应窗口
- [x] 单击即跳转（所有状态），不影响双击/四击反应动画
- [x] 多窗口终端焦点：EnumWindows + 窗口标题匹配（v0.3.5）

**macOS（✅ 已验证，PR #10 by PixelCookie-zyf，2026-03-23）：**
- [x] 预留 macOS 分支（`isMac` 判断），osascript 激活框架已写
- [x] 需要辅助功能权限（Accessibility）——实测 System Events 授权后正常工作
- [x] 实机测试通过（macOS 26.3.1 + Ghostty，`getStablePid()` 进程树遍历 + `focusTerminalWindow()` osascript 激活均正常）
- [x] VS Code / Cursor 集成终端已验证

### 5.2 自动更新（✅ 已完成）

用户不需要手动下载安装包。

- [x] 集成 `electron-updater`，基于 GitHub Releases 检查更新
- [x] 启动时静默检查，有新版本时托盘/右键菜单提示
- [x] 用户确认后自动下载并提示重启（Windows）
- [x] macOS：检测到新版本后打开 GitHub Releases 页面手动下载（无 Apple 签名，无法自动更新）
- [x] DND/mini 模式下静默检查不弹窗，防重复点击

### 5.3 Session Dashboard + 快速切换（✅ 已完成，Windows + macOS）

多会话用户一眼看清所有会话状态，支持鼠标和键盘两种入口。macOS Cmd+Click 及多会话显示已验证通过（PR #10，2026-03-23）。

**右键菜单（鼠标入口）：**
- [x] `buildSessionSubmenu()` 数据逻辑：遍历 sessions Map，过滤/排序/格式化
- [x] 右键菜单添加 "Sessions" 子菜单，显示每个 session 的状态 + 时长
- [x] 点击某个会话 → `focusTerminalWindow(sourcePid)` 跳转终端
- [x] 无 sourcePid 的会话显示为 disabled（不可点击）
- [x] 无活跃会话时显示灰色提示
- [x] 中英文国际化

**全局快捷键（键盘入口）：**
- [x] 注册全局快捷键（Ctrl+Shift+S），按下时 `Menu.popup()` 弹出同一个 session 菜单
- [x] 选择后跳转到对应终端窗口

### 5.5 权限审批气泡（✅ 已完成，Windows + macOS）

直接在桌宠气泡里批准/拒绝 Claude Code 的工具调用，不用切回终端。

- [x] 研究 Claude Code hook 的 `PermissionRequest` 双向通信机制（HTTP hook type 原生支持请求-响应）
- [x] 设计气泡 UI（现代简洁风：白底圆角卡片、彩色工具 pill、Allow/Deny 按钮）
- [x] HTTP hook 注册（PermissionRequest 事件，`/permission` 端点 long-poll）
- [x] 超时处理：不自动 deny，HTTP hook timeout 600s，Claude Code 超时后 fallback 到终端
- [x] 动态渲染 Claude Code 的 `permission_suggestions`（Always allow / Auto-accept edits 等）
- [x] Windows 透明窗口点击修复（显式 focus）
- [x] 固定屏幕位置（右下角，紧贴任务栏）
- [x] 深色/亮色双主题（CSS 变量 + `prefers-color-scheme`，跟随系统）
- [x] 右滑入场动画（`translateX` + spring easing）
- [x] 卡片自适应高度（无 suggestion 时自动缩短）
- [x] DND 开启时自动 dismiss 已弹出的气泡（deny）
- [x] 无效 suggestion 索引防御（deny 而非静默放行）
- [x] `setMode` 响应补全 `destination` 字段（符合 Claude Code schema）
- [x] Windows 反斜杠路径兼容（suggestion label 分割）
- [x] macOS 验证通过：透明窗口无需 `focus()` hack，Allow/Deny/suggestions 均正常（PR #10，2026-03-23）
- [x] 多气泡堆叠：toast 风格从下往上叠，动态高度测量（v0.3.5）
- [x] 真正的 blocking 审批：移除 command hook 干扰 + 删除 "User answered in terminal" 误判（v0.3.5）

详细实施方案见 `docs/plan-permission-bubble.md`。

---

## 搁置 / 暂缓 / 未来可能

### 非交互式 Session 过滤（未来 maybe）

`claude -p` 管道调用时跳过 hook 事件，避免批量脚本让桌宠疯狂闪切。Notchi 的做法是在 hook 脚本里检测父进程是否带 `-p`/`--print` 参数。目前鹿鹿的使用场景全是交互式，暂时不需要。

---

## 竞品调研备忘

### Masko Code（2026-03-24 调研）

**项目**：[RousselPaul/masko-code](https://github.com/RousselPaul/masko-code)，Swift 原生 macOS 应用，263 星

**技术栈差异**：

| 维度 | Clawd | Masko |
|------|-------|-------|
| 运行时 | Electron (Node.js) | Swift 原生 |
| 动画 | SVG（DOM 操作 + 眼球追踪） | HEVC 视频（Alpha 通道透明） |
| 窗口 | 1 个透明窗口 + N 个 bubble | 3 个 NSPanel（吉祥物 + HUD + 权限面板） |
| Agent | 仅 Claude Code | Claude Code + Codex + Copilot |
| 状态机 | 硬编码优先级状态机 | JSON 配置驱动（可换角色） |
| 权限 | HTTP hook blocking + bubble UI | 完整审批系统（队列 + 键盘 + 折叠） |
| 终端跳转 | EnumWindows + 窗口标题 | 13 种终端分级 + VS Code 扩展精确到 tab |
| 平台 | Windows + macOS | 仅 macOS |

**我们的优势**：眼球追踪、点击/拖拽反应、睡眠序列、极简模式、DND、跨平台、像素风美术
**Masko 的优势**：权限审批完整度、终端跳转精度、多 Agent 支持、崩溃恢复、可换角色

**已借鉴**：blocking 权限审批（v0.3.5）
**待借鉴**：VS Code 扩展 tab 跳转（M1）、崩溃恢复（M2）、多 Agent 适配（M3）

### Codex CLI Hooks 系统（2026-03-24 调研）

**关键发现**：

- Hooks 引擎名为 `ClaudeHooksEngine`（直接借鉴 Claude Code 协议）
- **Windows 上 hooks 完全禁用**（源码 hardcoded）
- 仅 4 个事件：SessionStart、UserPromptSubmit、PreToolUse、Stop
- 没有 HTTP hook 类型，只有 command
- PreToolUse 只能 deny，不能 approve
- 缺失：PostToolUse、SubagentStart/Stop、Notification、PermissionRequest、SessionEnd 等
- stdin JSON 格式与 Claude Code 高度相似（session_id、cwd、hook_event_name 等）
- hooks.json 配置格式与 Claude Code 的 settings.json hooks 几乎相同
- 社区在催更多事件（Issue #2109，69+ 评论），截至 2026-03-24 未落地
- **对我们的影响**：Codex 支持必须走日志轮询（`~/.codex/sessions/*.jsonl`），不能依赖 hook

---

## 技术决策记录

| 决策 | 选择 | 理由 |
|------|------|------|
| 桌面框架 | Electron | 新手友好、Node.js 生态、透明窗口一行配置 |
| 动画格式 | SVG（CSS 动画驱动） | 透明背景、可操作内部 DOM（眼球追踪）、无损缩放 |
| 状态通信 | 本地 HTTP 服务（127.0.0.1:23333） | 零延迟、无文件并发问题、hook 脚本只需一个 POST 请求 |
| 美术风格 | 像素风 | 跟随官方 Clawd 设计 |
| 权限审批通信 | HTTP hook blocking（非 command hook） | Claude Code 原生支持 HTTP hook 的请求-响应模式，command hook 只能 fire-and-forget |
| Codex 事件源 | 日志轮询（非 hook） | Codex Windows hooks 禁用 + 事件集合太少，日志文件包含完整信息 |

---

## 风险与备选方案

| 风险 | 备选方案 |
|------|---------|
| Electron 内存占用太大 | 迁移到 Tauri（前端代码可复用） |
| ~~权限审批的双向通信复杂度高~~ | ~~先做只读通知，后续迭代双向~~ ✅ 已通过 HTTP hook 解决 |
| 自动更新签名问题 | Windows 未签名会触发 SmartScreen，评估代码签名成本 |
| Codex 日志格式变更 | 日志轮询绑定 JSONL 格式，格式变更需跟进适配 |
| VS Code 扩展分发 | 自动安装到扩展目录 vs 发布到 Marketplace（后者需审核） |
