# Agent Deck

通用 Coding Agent 驾驶舱。半透明毛玻璃悬浮窗，聚合多个 Claude Code 与 Codex CLI 会话，实时显示活动、文件改动 diff、阶段性总结；任意会话把控制权交回你时，立即颜色 + 声音 + 系统通知。

适合「同时驾驶多个 coding agent」的人 —— 你有 3 条 Claude Code 会话和 1 条 Codex 在跑，不必再轮流切终端窗口确认谁在等你；窗口悬浮在桌面角落，红闪烁徽标 + 提示音告诉你哪一条停了。

> 基于 Electron + React 19 + TypeScript + Vite + Tailwind 4 + better-sqlite3。

---

## 主要能力

- **半透明毛玻璃悬浮窗**：可拖动可缩放可折叠成胶囊；pin 模式下窗口几乎透明且置顶，能透着继续工作
- **多会话聚合**：应用内 SDK 创建（**内**）+ 外部终端 CLI hook 上报（**外**）共一份视图，三段 tab：实时 / 待处理 / 历史
- **活动流 + Diff + 总结**：每条会话点开看消息时间线、按文件分组的 Monaco DiffEditor、阶段性 LLM 一句话总结
- **控制权交接提醒**：waiting → 红闪烁 + 提示音 + 系统通知 + Dock 弹跳；finished → 黄 + 完成音；可逐项关闭，可换自定义提示音
- **三类人机交互内嵌响应**（仅 SDK 会话）：工具权限请求、Claude 主动询问、Plan mode 执行计划批准 —— 全部在活动流卡片里直接处理
- **命令行入口**：`agent-deck new --cwd ... --prompt ...` 从任意终端拉起新会话
- **自带 CLAUDE.md + skill 注入**：每条应用内会话都自动追加一份应用级约定到 system prompt，可在设置面板直接编辑
- **多 Adapter**：Claude Code（hook + SDK 双通道）+ Codex CLI（单 SDK 通道）；预留 aider / generic-pty 接口

---

## 核心概念

### 会话来源：内 vs 外

每条会话对应一个 cwd 下的一次 coding agent 运行。

- **内（SDK 通道）**：在 ＋ 弹窗或 `agent-deck new` 命令行创建，应用通过 SDK 把 CLI 子进程拉起来；事件标 `source: 'sdk'`，能拦工具调用、能中断、能续接
- **外（Hook 通道）**：终端里直接 `claude` / `codex`，安装好的 hook 把事件 POST 到内嵌 HTTP server（默认 `127.0.0.1:47821`，Bearer token 鉴权）；事件标 `source: 'hook'`，只读不能反向操作

SDK 接管的 sessionId 加入 `sdkOwned`，hook 通道同 id 事件被丢弃，避免重复显示。

### 生命周期与归档（正交）

`lifecycle` 与 `archived_at` 是两个独立维度。

| 状态 | 何时进入 |
|---|---|
| `active` | 默认；最近 active 窗口（默认 30 min）内有事件 |
| `dormant` | 超过 active 窗口没事件；SDK 通道 `session-end` 也归此 —— 流终止但历史 jsonl 还在，可 resume |
| `closed` | Hook 通道 `session-end`（终端 CLI 真退出）或 dormant 超过 closed 阈值（默认 24 h） |
| `archived_at IS NOT NULL` | 用户手动归档；与 lifecycle 完全独立，取消归档后保留原 lifecycle |

closed 后再来同 sessionId 事件 → 自动复活回 active。归档跳过 lifecycle 推进，不参与时间衰减。

### 控制权交接判定

每条事件被翻译成会话 activity，决定卡片颜色与是否触发提醒：

| activity | 颜色 | 提醒 |
|---|---|---|
| idle | 灰 | — |
| working | 绿脉冲 | — |
| waiting | 红闪烁 | 提示音 + 系统通知 + Dock 弹跳 |
| finished | 黄 | 完成提示音（轻） |

不做窗口整体闪屏 —— 太抢眼；状态徽标动画 + 声音 + 系统通知已足够。

### Adapter 架构

`AgentAdapter` 接口声明 `capabilities`，UI 按能力自动隐藏不支持的字段。

- **Claude Code**：hook + SDK 双通道，能力全开（创建/中断/发消息/工具批准/AskUserQuestion/ExitPlanMode/切权限模式/安装 hook）
- **Codex CLI**：基于 `@openai/codex-sdk` 单 SDK 通道，支持创建/发消息/中断/恢复；不支持工具批准 / 主动询问 / Plan mode / 运行时切权限模式（codex SDK 物理不支持）
- **aider / generic-pty**：占位

新增 adapter 实现 `AgentAdapter` 接口注册即可。

### Diff 渲染

`DiffRegistry` + `DiffRendererPlugin` 接口。内置 text（Monaco DiffEditor，懒加载）/ image（侧并排 / after-only / 滑动对比三视图）/ pdf（占位）。新增渲染器在 `src/renderer/components/diff/install.ts` 注册即可。

MCP 图片工具按 `mcp__<server>__Image{Read,Write,Edit,MultiEdit}` 命名约定接入；图片二进制不进 IPC，renderer 通过 `loadImageBlob` 按需向主进程要 dataURL（带白名单 + 大小校验）。

### 间歇 LLM 总结

调度器隔几分钟扫一次 active+dormant 会话，按时间或事件数触发，三层降级：LLM oneshot（最便宜的 haiku）→ 最近一条 assistant 文字 → 事件 kind 统计。LLM 一句话描述「会话当前在做什么」，显示在卡片第二行 + SessionDetail「总结」tab。

---

## 安装与使用

### macOS：装 dmg

```bash
# 0. 杀掉所有旧实例（重装必做，否则 chunk hash 错配会让 monaco 等渲染成源码字符串）
pkill -f "Agent Deck.app/Contents/MacOS/Agent Deck" 2>/dev/null
pkill -f "Agent Deck Helper" 2>/dev/null

# 1. 出 dmg + .app
rm -rf release && pnpm dist

# 2. 装到 /Applications（旧版要先 rm，cp -R 不会清残留）
rm -rf "/Applications/Agent Deck.app"
cp -R "release/mac-arm64/Agent Deck.app" /Applications/

# 3. ad-hoc 重签（让签名 Identifier 与 com.agentdeck.app 一致）+ 清 quarantine
codesign --force --deep --sign - "/Applications/Agent Deck.app"
xattr -dr com.apple.quarantine "/Applications/Agent Deck.app"

# 4. 软链命令行 wrapper（可选，让终端任意目录能跑 agent-deck ...）
ln -sf "/Applications/Agent Deck.app/Contents/Resources/bin/agent-deck" /usr/local/bin/agent-deck
```

每一步的根因详见「开发指南 → 打包必须知道的几件事」。

### 开发模式

```bash
pnpm install
pnpm rebuild better-sqlite3 electron esbuild   # 给当前 Electron 重编 native module
pnpm dev                                        # electron-vite + HMR
```

HMR 只对 renderer 生效；改了 `src/main/**` 或 `src/preload/**` 必须重启 dev。

### 鉴权（首次使用前）

应用 **不读不写任何 API Key**。

- **Claude Code**：跑过 `claude login`（订阅或 Console 账户都行）。SDK 自己读 `~/.claude/.credentials.json`；`~/.claude/settings.json` 的 `permissions / hooks / env / mcpServers` 全部继承（等价于在该 cwd 跑 `claude`）
- **Codex CLI**：在终端跑过 `codex auth`，agent-deck 直接复用 `~/.codex` 配置

`~/.claude/settings.json` 的 `env` 字段在启动时按白名单（`ANTHROPIC_*` / `CLAUDE_*` / 标准代理变量）注入到主进程，让 SDK 子进程拿到代理 / 自定义 base URL。其它键（如 `NODE_OPTIONS` / `PATH`）会被拒绝。

---

## 命令行接入

应用打包了 macOS shell wrapper `resources/bin/agent-deck`，软链到 PATH 后任意终端：

```bash
agent-deck                                # 等价 agent-deck new --cwd "$PWD" --prompt "你好"
agent-deck --prompt "帮我看看这个 bug"    # wrapper 自动补 new 子命令

agent-deck new \
  [--cwd <path>]                          # 缺省走 wrapper 取 $PWD（裸调 .app 时取 ~）
  [--prompt "..."]                        # 首条消息（缺省 "你好"，避免 SDK 卡 30s fallback）
  [--agent claude-code|codex-cli]
  [--model <name>]                        # 仅 claude-code
  [--permission-mode default|acceptEdits|plan|bypassPermissions]
  [--resume <sessionId>]                  # 续历史 jsonl
  [--no-focus]                            # 默认会拉前窗口 + 选中新会话
```

应用未启动时 macOS 自动拉起；已启动时通过 `requestSingleInstanceLock` 转发参数到主实例。Linux / Windows 没打包 wrapper，直接调主进程二进制（参数语义一致）。

---

## 设置

⚙ 按钮打开设置面板，主要可改：

- **提醒**：声音开关、聚焦时静音、系统通知开关、自定义 waiting / finished 提示音（mp3/wav/aiff/m4a/ogg/flac，带试听 + 重置）
- **生命周期**：active 窗口（分钟）/ closed 阈值（小时）/ 权限请求超时（秒；默认 300，超时按 deny+interrupt 处理避免会话死等）
- **间歇总结**：触发间隔 / 触发事件数 / 同时跑总结上限 / 单次 LLM 超时
- **窗口**：开机自启
- **Claude Code Hook**：一键安装/卸载到 `~/.claude/settings.json`（user 作用域）
- **HookServer**：端口（重启 + 重新 install hook 才生效）；Bearer token 首启自动生成 256-bit hex 持久化，不在 UI 露出
- **外部工具**：Codex 二进制路径（留空用应用内置 vendored 版本，约 150MB / 平台）
- **应用约定（CLAUDE.md）**：直接编辑注入到所有 SDK 会话 system prompt 末尾的应用级约定文本，「恢复默认」回落内置

大部分设置即改即生效。Hook 安装与端口属于「需要重新安装 hook 才生效」类。

---

## 项目结构

```
src/
├── main/                  Electron 主进程
│   ├── index.ts           启动入口（DB → adapters → HookServer → window → IPC → CLI argv）
│   ├── cli.ts             agent-deck new 子命令解析；首启 + second-instance 共用
│   ├── window.ts          FloatingWindow（vibrancy / pin / compact）
│   ├── ipc.ts             所有 IPC handler 集中点；设置变更的运行时分发也在这里
│   ├── event-bus.ts       主进程内事件总线
│   ├── hook-server/       共享 fastify 实例 + RouteRegistry（adapter 动态注册路由）
│   ├── adapters/
│   │   ├── claude-code/   hook 路由 + hook installer + SDK bridge + CLAUDE.md/skill 注入
│   │   ├── codex-cli/     @openai/codex-sdk 封装（pendingMessages 串行 turn + AbortController interrupt）
│   │   ├── aider/         占位
│   │   └── generic-pty/   占位
│   ├── session/           SessionManager / LifecycleScheduler / Summarizer
│   ├── notify/            sound.ts（跨平台播放 + 防叠播 + 5s 上限）/ visual.ts（系统通知 + Dock）
│   ├── permissions/       会话详情「权限」tab 的扫描器（user / user-local / project / local 四层）
│   └── store/             better-sqlite3 + 迁移（user_version v1–v4）+ repos + electron-store settings
├── preload/index.ts       contextBridge 暴露 window.api / window.electronIpc
├── renderer/              React 19
│   ├── App.tsx            header（标题 / 统计 / pending chip / ＋ / 三个 tab / pin / 折叠 / ⚙）
│   ├── components/        FloatingFrame · SessionList · SessionCard · SessionDetail ·
│   │                      PendingTab · pending-rows · PermissionsView · HistoryPanel ·
│   │                      NewSessionDialog · SettingsDialog · ActivityFeed · diff/
│   ├── stores/            Zustand session store
│   ├── hooks/             事件桥接
│   └── lib/               IPC 兜底 + selectors（selectLiveSessions / selectPendingBuckets）
└── shared/                types（不允许 import Electron / Node API）+ mcp-tools

resources/
├── icon.png               Dock / 窗口图标（1024×1024）
├── icons/                 electron-builder 多分辨率
├── sounds/                内置 waiting / done 提示音
├── bin/agent-deck         macOS CLI wrapper（chmod +x；打包后位于 .app/Contents/Resources/bin/）
└── claude-config/         自带 CLAUDE.md + plugin/skills/，extraResources 复制到 .app
```

---

## 开发指南

```bash
pnpm typecheck       # 必跑
pnpm build           # 大改动跑
pnpm dist            # 出 dmg + .app
```

### 数据存储

SQLite 在应用 userData 目录下的 `agent-deck.db`：

- macOS：`~/Library/Application Support/agent-deck/`
- Windows：`%APPDATA%/agent-deck/`
- Linux：`~/.config/agent-deck/`

迁移按 `user_version` pragma 增量推进，目前 v4。表：`sessions / events / file_changes / summaries / app_meta`。

### 关键端口

- `47821` HookServer（设置面板可改）
- `5173` vite renderer dev server

### 验证 Hook 通道

```bash
# Bearer token 在首启自动生成，存于 settings 的 hookServerToken 字段
curl -sS -X POST http://127.0.0.1:47821/hook/sessionstart \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer <token>" \
  -d '{"session_id":"test-001","cwd":"<任意目录>"}'
```

### 打包必须知道的几件事

每条都有过失败案例，详见对应 changelog：

- `package.json > build.mac.icon = "resources/icon.png"` 必须显式指定，否则 electron-builder 找 `resources/icons/` 多分辨率集不到 → dmg 打不出来（CHANGELOG_16）
- `extraResources` 必须把 `resources/bin → bin` 显式 copy，wrapper 才能进 .app（CHANGELOG_16）
- 装包后必须 `codesign --force --deep --sign -` ad-hoc 重签，否则签名 Identifier 是 `Electron` 与 `com.agentdeck.app` 不一致，通知 / Gatekeeper 错位（CHANGELOG_21）
- 重装前必须 `pkill` 旧 main 进程，否则 macOS 复用旧实例 + 新资源 → renderer chunk hash 错配 → monaco 等 dynamic import 显示成源码字符串（CHANGELOG_26）
- `asarUnpack` 必须包含 `@openai/codex/**` + 所有平台子包（darwin / linux / win32 × arm64 / x64），否则打包后 codex spawn 报 ENOTDIR（CHANGELOG_43）

---

## 进一步阅读

- [CLAUDE.md](CLAUDE.md) —— 给 Claude Code 在本仓库工作时的硬性约定 + 项目设计要点
- [changelog/INDEX.md](changelog/INDEX.md) —— 全部 CHANGELOG 索引；改任何模块前都建议浏览相关条目，了解历史决策与已经踩过的坑
