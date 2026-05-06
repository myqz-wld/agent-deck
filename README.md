# Agent Deck

通用 Coding Agent 驾驶舱。半透明毛玻璃悬浮窗，聚合多个 Claude Code 与 Codex CLI 会话，实时显示活动、文件改动 diff、阶段性总结；任何会话把控制权交回你时，立即颜色 + 声音 + 系统通知。

适合「同时驾驶多个 coding agent」的人 —— 你有 3 条 Claude Code 会话和 1 条 Codex 在跑，不必再轮流切终端窗口确认谁在等你；窗口悬浮在桌面角落，红闪烁徽标 + 提示音告诉你哪一条停了。

> 基于 Electron + React 19 + TypeScript + Vite + Tailwind 4 + better-sqlite3。

---

## 主要能力

- **半透明毛玻璃悬浮窗**：可拖动、可缩放、可折叠成胶囊；pin 模式下窗口几乎透明且置顶，能透着继续工作
- **多会话聚合**：应用内 SDK 创建（**内**）+ 外部终端 CLI hook 上报（**外**）共一份视图，三段 tab：实时 / 待处理 / 历史
- **活动流 + Diff + 总结**：每条会话点开看消息时间线、按文件分组的 Monaco DiffEditor、阶段性 LLM 一句话总结；Task 工具调用专门渲染（subagent 名 + 紫色 chip + prompt 全文折叠/展开）
- **控制权交接提醒**：waiting → 红闪烁 + 提示音 + 系统通知 + Dock 弹跳；finished → 黄 + 完成音；可逐项关闭，可换自定义提示音
- **三类人机交互内嵌响应**（仅 SDK 会话）：工具权限请求、Claude 主动询问、Plan mode 执行计划批准 —— 全部在活动流卡片里直接处理。批准 plan 时可选目标权限模式（默认 / 自动接受编辑 / 保持 Plan / 完全免询问）；切到「完全免询问」会自动重启 SDK 子进程
- **OS 级沙盒**（实验，默认关）：Claude Code SDK 子进程可启 `workspace-write` / `strict` 二档隔离（macOS Seatbelt / Linux bubblewrap），cwd 可写但 `~/.ssh` 等敏感目录禁读 + 网络默认禁；model 想联网时被 `SandboxNetworkAccess` 工具回路自动拦下并提示用 `dangerouslyDisableSandbox: true` 重试，最终仅 1 次弹框给用户审批 —— 与 Codex 子进程已有的 `workspace-write` 隔离对齐
- **Agent Teams 实验入口**（默认关）：开启后 NewSessionDialog 暴露 team 名输入框 + 自动回填模板 prompt；team 视图显示成员清单 / 应用内会话 / shared task list / 结构化 tasks（mcp__tasks__* 实时） / 三个新 hook 事件流（TaskCreated / TaskCompleted / TeammateIdle，mcp 写操作也会同步出现），需 Claude Code CLI ≥ v2.1.32
- **Teammate 权限自动放行**（默认 read-only）：teammate 走 inbox 协议不会回到 lead 的 canUseTool，所以 lead 的 permissionMode / settings.json 白名单对 teammate 失效；本应用层 inbox-watcher 按设置项主动放行只读工具（默认）/ 跟随 lead permissionMode（acceptEdits → 加放行 Edit/Write；bypassPermissions → 全放行）/ 关闭（每次都弹）三档，运行时即时切换
- **命令行入口**：`agent-deck new --cwd ... --prompt ...` 从任意终端拉起新会话
- **自带应用级约定 + skill / agent 注入**：每条应用内 SDK 会话都自动追加内置 CLAUDE.md 到 system prompt；可注入 agent-deck plugin 自带的 `deep-code-review` skill + `reviewer-claude` (Opus 4.7) / `reviewer-codex` (Codex CLI wrapper) 双异构对抗 subagent
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

- **Claude Code**：hook + SDK 双通道，能力全开（创建 / 中断 / 发消息 / 工具批准 / AskUserQuestion / ExitPlanMode / 切权限模式 / 安装 hook）
- **Codex CLI**：基于 `@openai/codex-sdk` 单 SDK 通道，支持创建 / 发消息 / 中断 / 恢复；不支持工具批准 / 主动询问 / Plan mode / 运行时切权限模式（codex SDK 物理不支持）
- **aider / generic-pty**：占位

新增 adapter 实现 `AgentAdapter` 接口注册即可。

### Diff 渲染

`DiffRegistry` + `DiffRendererPlugin` 接口。内置 text（Monaco DiffEditor，懒加载）/ image（侧并排 / after-only / 滑动对比三视图）/ pdf（占位）。新增渲染器在 `src/renderer/components/diff/install.ts` 注册即可。

MCP 图片工具按 `mcp__<server>__Image{Read,Write,Edit,MultiEdit}` 命名约定接入；图片二进制不进 IPC，renderer 通过 `loadImageBlob` 按需向主进程要 dataURL（带白名单 + 大小校验）。

### 间歇 LLM 总结

调度器隔几分钟扫一次 active+dormant 会话，按时间或事件数触发，三层降级：LLM oneshot（最便宜的 haiku）→ 最近一条 assistant 文字 → 事件 kind 统计。LLM 一句话描述「会话当前在做什么」，显示在卡片第二行 + SessionDetail「总结」tab。

---

## 安装与使用

### 平台支持矩阵

| 平台 | 状态 | 说明 |
|---|---|---|
| **macOS 12+ (Apple Silicon / Intel)** | **GA** | 主要开发与测试平台；毛玻璃 vibrancy / Dock bounce / 通知中心一应俱全 |
| **Windows 10 1703+ / 11** | **beta** | NSIS 安装包 + portable 双 target；wrapper 走 `agent-deck.cmd`；vibrancy 缺失（`titleBarStyle: hidden + frame: false` Win 也支持，但无毛玻璃）；Dock bounce 不存在（靠系统通知 + 声音提示）。Win 端真机 E2E 留待 CI 验证（参见 [REVIEW_21](reviews/REVIEW_21.md)） |
| **Linux** | dev only | `pnpm dev` 能跑；`dist:linux` 配了 AppImage target 但未单独验证；`paplay → aplay` 音效兜底链路在无 PulseAudio 的桌面会脆弱 |

### macOS：装 dmg

```bash
# 0. 杀掉所有旧实例（重装必做，否则 chunk hash 错配会让 monaco 等渲染成源码字符串）
pkill -f "Agent Deck.app/Contents/MacOS/Agent Deck" 2>/dev/null
pkill -f "Agent Deck Helper" 2>/dev/null

# 1. 出 dmg + .app
rm -rf release && pnpm dist:mac

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

### Windows：装 NSIS exe

在 Win 主机（不能在 mac 上交叉编译，REVIEW_21 #A13）：

```powershell
# 0. 装 native deps（首次 / 切 Node 版本时跑）
pnpm install
# postinstall 会自动 electron-builder install-app-deps，给 Electron 33 ABI v130 重 build better-sqlite3

# 1. 出 NSIS installer + portable .exe
pnpm dist:win
# 产物在 release\Agent Deck-<version>-x64.exe（installer）+ Agent Deck-<version>-x64.exe（portable）

# 2. 双击 installer 装到 %LOCALAPPDATA%\Programs\Agent Deck\（NSIS 默认 perMachine=false）
#    安装时勾选「加 PATH」可选，未勾的话 wrapper 路径在
#    %LOCALAPPDATA%\Programs\Agent Deck\resources\bin\agent-deck.cmd

# 3. 命令行加 wrapper（任选，让终端任意目录能跑 agent-deck ...）
$env:PATH += ";$env:LOCALAPPDATA\Programs\Agent Deck\resources\bin"
# 永久加进环境变量：
# [Environment]::SetEnvironmentVariable("PATH", $env:PATH, "User")
```

**Windows 已知差异**（与 macOS 对比）：

| 维度 | macOS 行为 | Windows 行为 |
|---|---|---|
| 窗口外形 | vibrancy under-window 真毛玻璃 + traffic-light hidden | `transparent + frame: false`；vibrancy / visualEffectState 静默 no-op，靠 CSS 兜底（视觉降级） |
| 提示音 | afplay 播 m4a / 系统 Glass+Tink 兜底 | PowerShell + PresentationCore.MediaPlayer 播 m4a / `[console]::beep` 兜底（Win Server Core 缺 PresentationCore） |
| 通知 | Notification + Dock bounce | Notification（通知中心）；无 Dock 概念（靠声音 + 通知双通道） |
| 默认安装目录 | `/Applications/Agent Deck.app` | `%LOCALAPPDATA%\Programs\Agent Deck\Agent Deck.exe` |
| CLI wrapper | `agent-deck`（POSIX bash，软链到 PATH） | `agent-deck.cmd`（cmd.exe / PowerShell 都能跑） |

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
- **Codex CLI**：在终端跑过 `codex auth`，应用直接复用 `~/.codex` 配置

`~/.claude/settings.json` 的 `env` 字段在启动时按白名单（`ANTHROPIC_*` / `CLAUDE_*` / 标准代理变量）注入到主进程，让 SDK 子进程拿到代理 / 自定义 base URL。其它键（如 `NODE_OPTIONS` / `PATH`）会被拒绝。

---

## 命令行接入

应用打包了平台 wrapper，软链到 PATH 后任意终端：

```bash
# macOS / Linux（POSIX bash wrapper）
agent-deck                                # 等价 agent-deck new --cwd "$PWD" --prompt "你好"
agent-deck --prompt "帮我看看这个 bug"    # wrapper 自动补 new 子命令
```

```cmd
REM Windows（cmd.exe / PowerShell 都能跑 agent-deck.cmd）
agent-deck                                REM 等价 agent-deck new --cwd "%CD%" --prompt "你好"
agent-deck --prompt "帮我看看这个 bug"    REM 自动补 new + --cwd "%CD%"
agent-deck new --cwd "C:\path\to\repo" --prompt "..."
```

完整子命令（macOS / Win 通用）：

```bash
agent-deck new \
  [--cwd <path>]                          # 缺省走 wrapper 取 $PWD / %CD%（裸调 .app/.exe 时取 ~ / %USERPROFILE%）
  [--prompt "..."]                        # 首条消息（缺省 "你好"，避免 SDK 卡 30s fallback）
  [--agent claude-code|codex-cli]
  [--model <name>]                        # 仅 claude-code
  [--permission-mode default|acceptEdits|plan|bypassPermissions]
  [--resume <sessionId>]                  # 续历史 jsonl
  [--no-focus]                            # 默认会拉前窗口 + 选中新会话
```

应用未启动时由 OS 自动拉起（macOS Launch Services / Win shell）；已启动时通过 `requestSingleInstanceLock` 转发参数到主实例。Linux 走 `agent-deck` POSIX wrapper（与 macOS 同款脚本，依赖 bash 4+）。

---

## 设置

⚙ 按钮打开设置面板，主要可改（每个 section 可点标题折叠 / 展开，状态 localStorage 持久化；默认仅「Claude Code Hook」展开）：

- **提醒**：声音开关、聚焦时静音、系统通知开关、自定义 waiting / finished 提示音（mp3 / wav / aiff / m4a / ogg / flac，带试听 + 重置）
- **生命周期**：active 窗口（分钟）/ closed 阈值（小时）/ 权限请求超时（秒；默认 300，超时按 deny + interrupt 处理避免会话死等）
- **间歇总结**：触发间隔 / 触发事件数 / 同时跑总结上限 / 单次 LLM 超时
- **窗口**：置顶时透明（看到下层桌面，默认开；关掉则置顶时仍是 macOS under-window 实玻璃，Windows 等其他平台无 vibrancy 效果）/ 开机自启
- **Claude Code Hook（系统钩子）**：一键安装 / 卸载到 `~/.claude/settings.json`（user 作用域）
- **Hook Server（本地端口）**：端口（重启 + 重新 install hook 才生效）；Bearer token 首启自动生成 256-bit hex 持久化，不在 UI 露出
- **外部工具**：Codex 二进制路径（留空用应用内置 vendored 版本，约 150MB / 平台）
- **应用约定（CLAUDE.md）**：直接编辑注入到所有 SDK 会话 system prompt 末尾的应用级约定文本，「恢复默认」回落内置；详细清单见 Header「📚 资产库」
- **内置 Skill 与 Agent（agent-deck plugin）**：注入 `deep-code-review` skill + `reviewer-claude` / `reviewer-codex` 双异构对抗 agents 的 toggle；完整清单与触发关键词见 Header「📚 资产库」
- **实验功能**：
  - **Agent Teams**：toggle；开启后 NewSessionDialog 出 team 名输入框 + 自动回填 prompt 模板。仅下次新建会话生效
  - **SDK Task Manager**：toggle；开启后 SDK 会话注入 `mcp__tasks__*` 系列结构化任务工具让多 Agent 跨会话协作管理结构化任务。当前会话 team 自动闭包注入到工具，写操作锁在自己 team；只读允许跨 team 协调。仅下次新建会话生效。完整工具清单见 Header「📚 资产库」
  - **Claude Code 沙盒**：三档下拉（关闭 / Workspace Write / Strict）；仅在 macOS（Seatbelt）/ Linux（bubblewrap）生效，**Windows 当前不支持 OS 级沙盒**（设置面板按平台只显示对应描述）；常用工具（git / pnpm / npm / yarn / bun / pip / cargo / go）默认豁免；切档仅下次新建会话生效

大部分设置即改即生效。Hook 安装与端口属于「需要重新安装 hook 才生效」类；Agent Teams / SDK Task Manager / 沙盒档位是 spawn-time 注入，仅下次新建会话生效。

Header 工具栏右侧的 **📚 资产库** 按钮独立 Dialog 集中展示「内置（agent-deck plugin）+ 用户自定义（`~/.claude/{agents,skills}/`）」两类 agents/skills/CLAUDE.md，并支持新建 / 编辑 / 删除用户 agent / skill；保存后 Claude Code SDK 默认加载（`settingSources: ['user', ...]`）下次新建会话即可见。

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
│   │   ├── claude-code/   hook 路由 + hook installer + SDK bridge + CLAUDE.md / skill / agents 注入 + sandbox-config（三档 OS 隔离配置）
│   │   ├── codex-cli/     @openai/codex-sdk 封装（pendingMessages 串行 turn + AbortController interrupt）
│   │   ├── aider/         占位
│   │   └── generic-pty/   占位
│   ├── session/           SessionManager / LifecycleScheduler / Summarizer
│   ├── teams/             Agent Teams M2/M3：team-fs（只读 ~/.claude/teams + tasks）+ team-watcher（chokidar 引用计数 + 60s grace）
│   ├── notify/            sound.ts（跨平台播放 + 防叠播 + 5s 上限）/ visual.ts（系统通知 + Dock）
│   ├── permissions/       会话详情「权限」tab 的扫描器（user / user-local / project / local 四层）
│   ├── bundled-assets.ts  agent-deck plugin 内置 agents/skills frontmatter 启动缓存（CHANGELOG_57）
│   ├── user-assets.ts     用户自定义 ~/.claude/{agents,skills}/ 管理（list/save 原子写/delete/reveal，CHANGELOG_57）
│   └── store/             better-sqlite3 + 迁移（user_version v1–v6，v6 加 sessions.team_name）+ repos + electron-store settings
├── preload/index.ts       contextBridge 暴露 window.api / window.electronIpc（含 process.platform 静态字段，CHANGELOG_57）
├── renderer/              React 19
│   ├── App.tsx            header（标题 / 统计 / pending chip / ＋ / 三个 tab + Teams tab / pin / 折叠 / 📚 / ⚙）
│   ├── components/        FloatingFrame · SessionList · SessionCard · SessionDetail ·
│   │                      PendingTab · pending-rows · PermissionsView · HistoryPanel ·
│   │                      NewSessionDialog · SettingsDialog (拆 9 个 settings/sections/*) ·
│   │                      AssetsLibraryDialog · assets/AssetEditor (CHANGELOG_57) ·
│   │                      ActivityFeed (Task 渲染) · diff/ ·
│   │                      TeamHub · TeamDetail (Agent Teams M2/M3 视图)
│   ├── stores/            Zustand session store
│   ├── hooks/             事件桥接
│   └── lib/               IPC 兜底 + selectors（selectLiveSessions / selectPendingBuckets）+ platform.ts (IS_DARWIN/IS_WIN/IS_LINUX renderer util，CHANGELOG_57)
└── shared/                types（不允许 import Electron / Node API）+ mcp-tools

resources/
├── icon.png               Dock / 窗口图标（1024×1024）
├── icon.ico               Win NSIS / portable 图标（多尺寸合一，由 pnpm icon:gen 生成）
├── icons/                 electron-builder 多分辨率
├── sounds/                内置 waiting / done 提示音
├── bin/
│   ├── agent-deck         macOS / Linux CLI wrapper（POSIX bash，chmod +x）
│   └── agent-deck.cmd     Windows CLI wrapper（cmd.exe / PowerShell 通用）
└── claude-config/         应用打包内置的 CLAUDE.md + plugin / skills，extraResources 复制到 .app

scripts/
├── gen-icon-ico.mjs       从 icon.png 生成 icon.ico（pnpm icon:gen）
└── verify-fts5.sh         sqlite3 CLI 真 SQL 集成校验
```

---

## 开发指南

```bash
pnpm typecheck       # 必跑
pnpm test            # vitest（纯函数单测）
pnpm test:fts5       # sqlite3 CLI 真 SQL 集成校验（FTS5 schema + 触发器 + MATCH 谓词，不依赖 better-sqlite3）
pnpm build           # 大改动跑
pnpm dist            # 出 dmg + .app
```

### 数据存储

SQLite 在应用 userData 目录下的 `agent-deck.db`：

- macOS：`~/Library/Application Support/agent-deck/`
- Windows：`%APPDATA%/agent-deck/`
- Linux：`~/.config/agent-deck/`

迁移按 `user_version` pragma 增量推进，目前 v6（v6 加 `sessions.team_name` + 部分索引，给 Agent Teams M1 用）。表：`sessions / events / file_changes / summaries / app_meta`。

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

每条都有过失败案例，详见对应 changelog / review：

- `package.json > build.mac.icon = "resources/icon.png"` 必须显式指定，否则 electron-builder 找 `resources/icons/` 多分辨率集不到 → dmg 打不出来
- `package.json > build.win.icon = "resources/icon.ico"` 同理；`.ico` 跑 `pnpm icon:gen` 从 `icon.png` 生成（已提交一份 279 KB 进 git，icon 改了再重生成）
- `extraResources` 必须把 `resources/bin → bin` 显式 copy，wrapper（`agent-deck` POSIX + `agent-deck.cmd` Win）才能进 .app / NSIS install dir
- 装包后必须 `codesign --force --deep --sign -` ad-hoc 重签（仅 macOS），否则签名 Identifier 是 `Electron` 与 `com.agentdeck.app` 不一致，通知 / Gatekeeper 错位
- 重装前必须 `pkill` 旧 main 进程（macOS）/ `taskkill /F /IM "Agent Deck.exe"`（Win），否则旧实例 + 新资源 → renderer chunk hash 错配 → monaco 等 dynamic import 显示成源码字符串
- `asarUnpack` 必须包含 `@openai/codex/**` + 所有平台子包（darwin / linux / win32 × arm64 / x64），否则打包后 codex spawn 报 ENOTDIR
- **Win 包不能在 mac 主机交叉编译**（optional deps `*-win32-*` 子包不会被装；postinstall 的 `electron-builder install-app-deps` 也只重 build 当前平台 ABI）。`pnpm dist:win` 必须在 Win 主机或 Win CI runner 跑（REVIEW_21 #A13）

### Windows 已知差异

- **vibrancy / 毛玻璃**：Win 上 `vibrancy` / `visualEffectState` 静默 no-op；`transparent + frame: false` 仍能起透明无标题栏窗口，但毛玻璃质感缺失（CSS `backdrop-filter` 无下层 app 像素源）
- **`isOurKill` SIGTERM**：Win32 `TerminateProcess` 不通过 POSIX signal 模型，`err.signal` 通常 null；现有代码靠 `\|\| err.killed === true` 兜底，仍正确（详见 `src/main/notify/sound.ts` 注释）
- **没有 Dock bounce**：Win 任务栏闪烁靠 Electron `BrowserWindow.flashFrame()` 走另一条 API，行为差异较大；by-design 仅 macOS 触发，Win 上 system notification + 声音已够提示
- **system beep**：Linux GUI 进程 stdout 无终端附着 `\\x07` 听不到；Win 用 PowerShell `[console]::beep(freq,ms)` 替代
- **CLI wrapper**：`agent-deck.cmd` 不做相对→绝对路径转换（cmd.exe quoting 限制），依赖 main process 的 `isAbsolute + resolve` 兜底

---

## 进一步阅读

仓库历史按「双轨」组织：

- [changelog/INDEX.md](changelog/INDEX.md) —— **功能变更**索引（新功能 / 行为修改 / API / 依赖升级）
- [reviews/INDEX.md](reviews/INDEX.md) —— **Debug / 性能 / 安全 review** 索引（不引入新功能，修问题或加固；含双对抗 Agent 三态裁决报告）
- [CLAUDE.md](CLAUDE.md) —— 给 Claude Code 在本仓库工作时的硬性约定 + 项目设计要点 + 「已审文件过期」机制（review 自动排程）

改任何模块前都建议浏览相关 changelog / review 条目，了解历史决策、避免推翻已有约定 / 重复踩坑。设计取舍（如「为什么 lifecycle 与 archived 正交」）通常在 changelog；过往 bug 与加固方案（含证据 + 三态裁决）在 reviews。
