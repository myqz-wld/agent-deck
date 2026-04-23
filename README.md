# Agent Deck

通用 Coding Agent 驾驶舱。半透明毛玻璃悬浮窗，聚合多个 Claude Code（以及未来的其他 coding agent）会话，实时显示活动、文件改动 diff、阶段性总结，控制权交回人时立即声音 + 颜色提醒。

> 基于 Electron + React 19 + TypeScript + Vite + Tailwind CSS 4 + better-sqlite3。

---

## 设计目标

日常并发用多个 Claude Code 终端时，难以察觉哪个会话停下等待人介入；本应用要解决：

1. **半透明悬浮窗**始终可见在桌面角落，不抢工作区焦点
2. **多会话聚合视图**，控制权交回人时给出**颜色 + 声音**提醒
3. **阶段性 LLM 总结**告诉你「会话现在在做什么」
4. **点击会话**查看活动流与文件改动 **diff**

两条扩展性约束：
- **Agent 适配器插件化**（已实装 Claude Code + Codex CLI，预留 aider / generic-pty 占位）
- **Diff 渲染器插件化**（首期 Monaco 文本 diff，预留 image / pdf 占位）

---

## 功能总览

### 半透明毛玻璃悬浮窗
- macOS `vibrancy: under-window` + CSS `backdrop-filter: blur(36px) saturate(220%) brightness(0.92)` 双层模糊；带 SVG turbulence 噪点纹理 + 内阴影做 Acrylic 质感
- 默认尺寸 520×680，右上角偏内出现；可拖动 / 缩放 / 折叠为胶囊
- 默认（无 pin）底色加深到 `rgba(12,14,20,0.78)` —— 浅色桌面背景下文字也清晰；pin 模式（📌）下背景更通透（`rgba(18,18,24,0.2) + blur(18px)`），关掉 vibrancy 让你能透过窗口继续工作
- pin 模式下背后切 app / 滚动 / 视频时，主进程 100ms 一次 `webContents.invalidate()` 让 NSWindow 重新与桌面合成（10fps 下层桌面感知率，CHANGELOG_24/35 演进）；CSS 端 pin 态隐藏 `::before` 噪点层避免 `mix-blend-mode: overlay` 把文字层缓存进 offscreen group surface（CHANGELOG_35 修文字残影根因）；create 时 `setBackgroundThrottling(false)` 防 macOS 后台节流压制 invalidate
- 全局快捷键 `Cmd/Ctrl+Alt+P` 切换 pin

### 会话列表（实时 / 待处理 / 历史）
- **实时**：分两段显示 active 与 dormant 的会话，按 `last_event_at` 倒序
- **待处理**：把所有有未响应请求（permission / ask-user-question / exit-plan-mode）的会话按 section 平铺一屏，**直接在此响应**不必跳到具体会话；每个 section 提供「全部允许 / 全部拒绝」批量按钮（仅作用于权限请求 + ExitPlanMode，AskUserQuestion 必须人审具体选项不参与批量）；section 标题整行可点击跳到该会话的 SessionDetail；过滤口径与「实时」一致（归档 + closed 不进列表）
- **历史**：closed + 已归档会话；支持按 cwd / 关键字搜索、仅看归档筛选
- 每张卡片显示：
  - 状态徽标（idle 灰 / working 绿脉冲 / waiting 红闪烁 / finished 黄 / dormant 暗灰 / closed/archived 划线灰）
  - 来源徽标（**内** = 应用内 SDK 创建 / **外** = 外部终端 CLI）
  - **当前在干嘛**（实时行）：`🔧 Edit · …/main.ts`、`🔧 Bash · pnpm test`、`📝 …/main.ts`、`💬 文字片段`、`⚠ 等待你的输入`、`✅ 一轮完成` 等
  - **总结**（一句话）：LLM 生成的「目前在做什么」描述；缺失时回退到最近一条 assistant 文字 / 最后回退到事件统计
- 右键菜单：归档 / 重新激活 / 删除

### 会话生命周期（lifecycle 与 archived 正交）
| 状态 | 何时进入 |
|---|---|
| `active` | 默认，最近 `activeWindowMs`（默认 30 min）内有事件 |
| `dormant` | 超过 `activeWindowMs` 没事件；**SDK 通道 `session-end` 也归此**（流终止但 `~/.claude/projects/<cwd>/<sid>.jsonl` 历史还在，可 resume） |
| `closed` | **Hook 通道 `session-end`**（终端 CLI 真退出，没法续）**或** dormant 超过 `closeAfterMs`（默认 24 h） |
| `archived_at IS NOT NULL` | 用户手动归档（与 lifecycle 正交，取消归档后保留原 lifecycle） |
- `LifecycleScheduler` 每分钟扫描 `last_event_at`，按阈值推进 active → dormant → closed
- closed 后再来同 sessionId 的事件 → 自动复活回 active
- 历史面板的「取消归档」 = 清掉 `archived_at`，会话回到原 lifecycle（如 dormant）
- SDK 与 Hook 通道对 `session-end` 的差异化处理写在 `SessionManager.ingest()` —— SDK 流终止不视为「会话死了」，给用户留 resume 的口子

### 应用内新建会话（＋ 按钮）
- 弹窗表单：**Agent**（claude-code / codex-cli）/ cwd（**留空默认用户主目录 `~`**，带「选择…」目录选择器）/ **首条消息（必填）** / 模型 / 权限模式
- 首条消息为什么必填：SDK streaming 协议要求 CLI 子进程必须收到 stdin 首条 user message 才会启动；空 prompt 会卡死直到 30s fallback，所以表单层强制必填
- **字段按 agent capabilities 自动隐藏**：选 codex-cli 时隐藏「模型」「权限模式」两个字段（codex SDK 不支持运行时切权限模式；模型选项写的是 claude 模型名，对 codex 不适用）。submit 时隐藏字段不传给 IPC。
- 模型选项（仅 claude-code）：按本地 settings.json / Sonnet 4.5 / Opus 4.7 / Haiku 4.5
- 权限模式（仅 claude-code）：default / acceptEdits / plan / bypassPermissions（用户上次选过的会持久化在 `sessions.permission_mode`，下次切回 detail 自动还原）
- 创建后自动切到「实时」并选中
- **不再支持自定义 systemPrompt**：固定走 Claude Code 默认 system prompt + agent-deck 自带 CLAUDE.md 追加（详见「Agent Deck 自带 CLAUDE.md + skill 注入」节）；自定义 systemPrompt 会进 SDK isolation mode 与 agent-deck 约定冲突，索性去掉

### 命令行新建会话（macOS）
- 等价于在 ＋ 弹窗里点「确定」，但适合从终端直接拉起 / 在脚本里串
- wrapper 脚本：`resources/bin/agent-deck`（已 chmod +x），打包后位于 `Agent Deck.app/Contents/Resources/bin/agent-deck`
- 推荐做软链：`ln -sf "/Applications/Agent Deck.app/Contents/Resources/bin/agent-deck" /usr/local/bin/agent-deck`，从此终端直接 `agent-deck ...`
- **最简用法**（参数全默认）：
  ```bash
  agent-deck                                     # 等价 agent-deck new --cwd "$PWD" --prompt "你好"
  agent-deck --prompt "帮我看看这个 bug"        # 自动补 new 子命令
  ```
  没传 `--cwd` 时 wrapper 用当前 PWD 兜底，裸调 .app 二进制（不走 wrapper）则用用户主目录 `~`；没传 `--prompt` 时默认填 `"你好"`，避免 SDK 卡 30s fallback 才显出会话（你也可以显式 `--prompt ""` 强制为空，会话会卡 30s 才出现）
- **完整用法**：
  ```bash
  agent-deck new \
    [--cwd <path>]                        # 缺省 wrapper 取当前 PWD、否则取 ~；wrapper 会把相对路径转绝对
    [--prompt "..."]                      # 首条消息（缺省 "你好"，避免 SDK 卡 30s fallback）
    [--agent claude-code]                 # claude-code（默认）/ codex-cli
    [--model <name>]                      # 等价表单的模型字段
    [--permission-mode default|acceptEdits|plan|bypassPermissions]
    [--resume <sessionId>]                # 续历史 jsonl，对应 detail 底部「恢复会话」
    [--no-focus]                          # 默认会拉前窗口 + 选中新会话；加这个静默新建
  ```
- 应用未启动 → macOS 自动拉起；已启动 → `requestSingleInstanceLock()` 的 `second-instance` 事件转发参数到主实例处理
- 默认行为：把窗口 `show()+focus()`，再 emit `event:session-focus-request`，renderer 切到「实时」并选中新会话
- 解析失败（`--permission-mode` 取值非法等）→ stderr + Electron `dialog.showErrorBox` 双通道报错
- AGENT_DECK_APP 环境变量可覆盖默认 `/Applications/Agent Deck.app` 路径
- 不打包 Linux/Windows wrapper —— 这两个平台直接调主进程二进制（参数语义一致）

### 会话恢复（resume）
- SDK 通道任何原因终止（dev 重启 / 流出错 / 用户中断 / 30s fallback 后），会话被标 dormant 但 `~/.claude/projects/<cwd>/<sid>.jsonl` 完整保留
- 在该会话的 SessionDetail 底部输入框发消息，会捕获 `not found` 错误 → 显示「会话已断开」红条 + **「恢复会话」按钮**
- 点恢复 = 调 `createAdapterSession({ cwd, prompt, resume: sessionId })`，SDK 会让 CLI 子进程加载历史 jsonl 续上对话；第一条 SDKMessage 的 `session_id` 就是这个 sid，无缝接续
- 输入框的文字采用乐观清空策略，恢复失败时退回输入框 + 显示错误，避免 SDK fallback 30s 等待期间用户以为没生效

### Claude Code SDK 通道（应用内会话）
- 用 `@anthropic-ai/claude-agent-sdk` 的 `query()` AsyncGenerator
- **完全复用本地 `~/.claude` 配置**：`settingSources: ['user', 'project', 'local']`，等价于在该 cwd 跑 `claude`（共享 hooks / MCP / agents / permissions / system prompt）
- **Agent Deck 自带 CLAUDE.md + skill 注入到所有会话**（不管 cwd）：见下面「Agent Deck 自带 CLAUDE.md + skill 注入」节
- 鉴权：SDK 自己按 `ANTHROPIC_API_KEY` → `~/.claude/.credentials.json` 找（应用不读不覆盖；跑过 `claude login` 即可）
- **`~/.claude/settings.json` 的 `env` 字段在 bootstrap 时被 `applyClaudeSettingsEnv()` 按白名单注入到主进程 `process.env`**：用户在 settings.json 里配置的代理（`ANTHROPIC_BASE_URL`）/ Bearer token（`ANTHROPIC_AUTH_TOKEN`）/ 模型映射，SDK spawn 的 CLI 子进程会继承到，避免「shell 里有冲突 env」或「SDK env 隔离」导致的 Invalid API key。**白名单**：`ANTHROPIC_*` / `CLAUDE_*` / 标准代理变量（HTTP_PROXY / HTTPS_PROXY / NO_PROXY / ALL_PROXY 大小写两份），其它键统一拒绝并 warn — 防止 settings.json 里夹带 `NODE_OPTIONS` / `PATH` 等危险键污染 process.env
- 真实 session_id 由 SDK 第一条消息携带，应用启动后等到再返回
- SDK 通道 emit 的事件打 `source: 'sdk'`；hook 通道回环到同 sessionId 的事件被 `SessionManager.sdkOwned` 集合自动去重
- **30s fallback / tempKey 重命名**：CLI 启动后 30s 仍未发任何 SDKMessage（鉴权失败 / 模型不可用 / 代理超限），会用 `tempKey` 顶上并 emit 一条错误 message 让 UI 立刻看到原因；后续真实 `session_id` 到达时调 `SessionManager.renameSdkSession(tempKey, realId)` 把 sessions 行 + events / file_changes / summaries 子表整体迁移，renderer 通过 `event:session-renamed` 同步迁移 selectedId 与所有 by-session 状态，用户保持在 detail 不被踢回主界面
- **cwd 待领取标记**（`expectSdkSession`）：SDK spawn 之前先注册 cwd → 60s 内首发的同 cwd hook 事件自动归 SDK 所有，避免 hook 通道领先到达时出现「内 / 外」两份重复会话；`realpath` + 尾斜杠归一，并对单 pending 做模糊匹配兜底（macOS `/private/var ↔ /var` 等）

### Agent Deck 自带 CLAUDE.md + skill 注入
- 应用打包了一份**自带 CLAUDE.md + skill 集合**（`resources/claude-config/`），在 `sdk-bridge.ts` 创建会话时通过 SDK options 注入到**所有应用内会话**，与 cwd 无关。
- **CLAUDE.md** 走 SDK 的 `systemPrompt: { type: 'preset', preset: 'claude_code', append: <自带 CLAUDE.md 文本> }`：保留 Claude Code 默认 system prompt（工具描述/tone/安全约定），把 agent-deck 的约定追加到末尾。实际位置在 user/project/local 三层 CLAUDE.md 全部加载完之后，LLM 上下文末尾位置 instruction following 最强。**SDK 不支持「中间插入」中间层 CLAUDE.md**，只能追加到末尾。
- **Skill** 走 SDK 的 `plugins: [{ type: 'local', path: <agent-deck-plugin 绝对路径> }]`：plugin manifest 在 `resources/claude-config/agent-deck-plugin/.claude-plugin/plugin.json`，每个 skill 在 `agent-deck-plugin/skills/<name>/SKILL.md`，自动以 `agent-deck:<skill-name>` 命名空间注册（与用户 `~/.claude/skills/` + 项目 `.claude/skills/` 完全不冲突）。
- **路径分流**：`sdk-injection.ts` 的 `getAgentDeckPluginPath` 与 `getAgentDeckSystemPromptAppend` 用 `app.isPackaged` 区分 dev / prod；prod 路径走 `process.resourcesPath/claude-config/...`（package.json 的 `build.extraResources` 把 `resources/claude-config` 复制到 `Contents/Resources/claude-config`）。
- **summarizer 不注入**：间歇总结 oneshot 仍是 isolation mode（`settingSources: []` + 自己的 systemPrompt），多余 skill 会引诱模型乱调，多余 CLAUDE.md 会污染总结质量。
- **不动用户 ~/.claude**：agent-deck 不写任何用户配置文件；自带配置完全独立，跟随应用打包发布。

### Hook 通道（外部 CLI 会话）
- 内嵌 fastify HTTP server (默认 `127.0.0.1:47821`)
- **Bearer token 鉴权**：所有 `/hook/*` 路由强制校验 `Authorization: Bearer <token>`。token 在首次启动由 `settings-store` 自动生成 32 字节随机 hex（256-bit）并持久化到 `agent-deck-settings.json` 的 `hookServerToken` 字段，install hook 时把 token 嵌入 curl 命令的 Authorization 头。**用户不在 UI 上修改 token**；防止本机其他进程（多用户 / 容器 / 恶意 npm post-install）直接 curl 伪造 AgentEvent 污染 SQLite
- HookInstaller：在「设置」点「安装到 ~/.claude/settings.json」会写入 6 条 hook（SessionStart / PreToolUse / PostToolUse / Notification / Stop / SessionEnd），每条命令带 `# agent-deck-hook` 标记，便于一键卸载。**写 settings.json 用 temp+rename 原子写**，避免崩溃 / 断电留半个 JSON 把用户的 hooks/permissions/mcpServers/env 配置全弄丢
- payload 翻译：PostToolUse(Edit/Write/MultiEdit) → `tool-use-end` + `file-changed`（含 before/after，喂给 DiffCollector）
- Hook 通道事件打 `source: 'hook'`

### Codex CLI SDK 通道（应用内会话）
- 用 `@openai/codex-sdk` 的 `Codex.startThread() / resumeThread()` + `thread.runStreamed(input, { signal })` AsyncGenerator
- **二进制策略**：`@openai/codex-sdk` 强制 dependency `@openai/codex` → 当前平台 vendored 二进制（如 `@openai/codex-darwin-arm64` ≈150MB）通过 npm optionalDependencies 跟随安装，**随 .app 打包**。设置面板「外部工具 → Codex 二进制路径」可填外部 codex 路径覆盖（`codexPathOverride`）
- **鉴权完全外部**：agent-deck 不读不写 `~/.codex/config.toml` / 环境变量；首次用前先在终端跑 `codex auth` 自己配好
- **默认安全策略**写死：`approvalPolicy: 'never'` + `sandboxMode: 'workspace-write'` + `additionalDirectories: []`，**不暴露给 UI**。codex SDK 是单工通道（stdin 写完即关），无法回应批准请求 → `'never'` 是唯一稳妥默认；`'workspace-write'` 让 OS sandbox（macOS seatbelt / Linux landlock）兜底，限制子进程只能写 `workingDirectory + additionalDirectories` 范围内的路径
- **同 thread 串行 turn**：codex CLI 的 `~/.codex/sessions` 文件不允许同 thread 并发 → `pendingMessages: string[]` 队列 + `turnLoopRunning` flag 串行 flush。用户连发 5 条消息时第 1 条立即 spawn codex，2-5 条排队
- **interrupt = AbortController.abort()**：每个 turn 一个 controller，按钮触发 abort → SDK 透传 `signal` 到 `child_process.spawn` → SIGTERM。turn reject + emit `finished({ subtype: 'interrupted' })`。**thread.id 不变**，下条 sendMessage 重新 `runStreamed` 续上（codex CLI 冷启动 + resume，从 `~/.codex/sessions/<id>.jsonl` 重放历史）。**注意**：SIGTERM 杀整个进程树，codex 正在跑的 shell 命令（`npm install` 等）会被同时中断
- **能力边界**（与 Claude Code SDK 通道对比，详见 CHANGELOG_41）：
  - ✅ createSession / sendMessage / interrupt / resume / 事件流（`agent_message → message`、`command_execution → tool-use`、`file_change → file-changed × N`、`mcp_tool_call/web_search → tool-use`、`reasoning/todo_list → message`）
  - ❌ canUseTool / 工具批准回调（SDK 无）
  - ❌ AskUserQuestion（SDK 无反向问询事件）
  - ❌ ExitPlanMode / plan mode（SDK 无）
  - ❌ 运行时 setPermissionMode（`approvalPolicy` 仅在 startThread 时设一次）
  - ❌ installIntegration / hook（codex 无 hook 机制）
- **file-changed 无 diff**：codex 的 `FileChangeItem` 不暴露 before/after 文本，UI 只能显示「修改了 X 文件」+ changeKind（add/delete/update）

### 控制权交接判定（颜色 + 声音 + 系统通知）
| AgentEvent | activity | 颜色 | 声音 |
|---|---|---|---|
| `session-start` | `idle` | 灰 | — |
| `tool-use-start` / `message` / `file-changed` | `working` | 绿脉冲 | — |
| `waiting-for-user` | `waiting` | **红闪烁徽标** | `waiting.mp3` + 系统通知 + Dock 弹跳 |
| `finished` | `finished` | 黄 | `done.mp3`（轻） |
- 设置面板可关声音 / 系统通知 / 「窗口聚焦时静音」
- **自定义提示音**：「等待用户提示音」/「完成提示音」可选本地 `mp3 / wav / aiff / m4a / ogg / flac` 文件，旁边带「试听」按钮，「重置」回退到默认
- **播放保护**：全局只允许 1 个播放器子进程同时跑（新触发会 SIGTERM 旧的，避免叠音）；最长 5 秒，超长音频自动截断
- 没设自定义、`resources/sounds/` 内置 mp3 也缺时，回退到 macOS 系统提示音（waiting → Glass，finished → Tink）
- 跨平台播放命令：macOS `afplay` / Linux `paplay → aplay` / Windows PowerShell + PresentationCore `MediaPlayer`（支持 mp3，不像 SoundPlayer 只支持 wav）
- 不做窗口整体闪屏 —— 太抢眼；靠卡片状态徽标的脉冲动画 + 声音 + 系统通知 + Dock 弹跳已足够

### 工具权限请求（仅 SDK 会话）
- SDK 通道注入 `canUseTool` callback：每次工具调用 → emit `waiting-for-user`（payload 是 `PermissionRequest`）
- UI 直接在**活动流内嵌渲染** `PermissionRow`：红边高亮卡片 + 工具名 + 时间 + 操作按钮组**在 header 行右对齐**（永远在 diff 之上、不被 diff 遮挡）
- **Edit / Write / MultiEdit 的 toolInput 翻译成 Monaco DiffViewer 直接画在 PermissionRow 行内**（`toolInputToDiff()`），一眼看到 Claude 要改什么再决定；其他工具则展开 JSON
- 按钮：**允许本次** / **始终允许**（SDK 给了 suggestions 才显示）/ **拒绝**
- 已响应的请求行变成「⚪ 已处理」灰带状态，不再可点
- 外部 CLI 的 `waiting-for-user` 是 hook 的 Notification，没有响应通路，UI 上只展示 + 提示「请回到终端窗口操作」
- 也可在底部 Composer 上切换权限模式（default / acceptEdits / plan / bypassPermissions）；切到 `bypassPermissions` **会先弹 confirm 提示**：该模式需要在新建会话时就选好（CLI 子进程必须以 `--allow-dangerously-skip-permissions` 启动才生效），运行时切换可能被 SDK 静默忽略
- **超时自动 abort**：超过 `permissionTimeoutMs`（默认 300s）未响应 → 自动按 deny+interrupt 处理 + 推一条警告 message 到时间线 + emit `permission-cancelled`，UI 自动移除按钮，避免会话死等
- **Claude 自动取消时弹 toast**：SDK 主动 abort 一条 pending（流终止 / interrupt / 上层超时）时，SessionDetail 顶部弹 5s 的「Claude 自动取消了一条权限请求」灰色 toast，让用户知道按钮消失不是自己点掉的
- **renderer 重启 / HMR / 切会话**：自动从主进程拉一次真实 pending 列表（IPC `adapter:list-pending` / `adapter:list-pending-all`），重建 store；不然事件流里的 `permission-request` 会被错渲成「已处理」按钮不显示 → SDK 死锁
- **header pending 计数**：右上角 `⚠ N 待处理` chip，把当前所有 SDK 会话的未响应权限/提问/计划批准（PermissionRequest / AskUserQuestion / ExitPlanMode）加总；点击**打开「待处理」tab**（一屏看全所有 pending 并直接响应，不再像 CHANGELOG_10 时只能跳第一个 pending 会话）；tab 名右侧也带相同 badge 数
- **sendMessage 时还有 pending → 推警告**：避免用户以为 Claude 死了（SDK query() 在等 canUseTool resolve，新消息会进队列但短时间内不被消费）
- **sendMessage 字节 / 队列上限**：单条消息 > 100KB 直接拒绝；待发送队列 > 20 条拒绝排队（SDK 阻塞在 canUseTool 时用户连发不会无限累积内存 + 撞 token 计费）

### Claude 主动询问（AskUserQuestion，仅 SDK 会话）
- Claude 调用 `AskUserQuestion` 工具时，canUseTool 走独立分支（不走通用权限请求 UI）
- 直接在**活动流内嵌渲染** `AskRow`：绿边高亮卡片 + header 显示「❓ Claude 在询问你 · 已选 N/M」+ **header 右侧实色「提交回答」按钮**（CHANGELOG_11：之前透明按钮藏在卡片末尾用户找不到 → 改成实色 + 顶到 header + 底部再放一个兜底 + 进度文字「还有 X 题未选 / 已选满，可提交」）
- 每个 question 一行；options 用按钮（**点击 = toggle**，不再「单选立即提交」—— 所有题型统一一种交互更可预期，避免用户以为按错了没法回头）
- 每题最后有「其他（可选）」自由输入框
- 用户提交后，答案被拼成可读文本塞进 deny.message 反馈给 Claude，Claude 看到 tool_result 含答案就基于答案继续对话
- **超时自动跳过**：超过 `permissionTimeoutMs` 未答复 → 自动给 SDK 一个「用户超时未回答」的空答案 + 推警告 message，避免 Claude 永远卡在等回答
- 外部 CLI 会话只展示，不允许操作（hook 通道没有 canUseTool 通路）

### 执行计划批准（ExitPlanMode，plan mode 下）
- Plan 模式下 Claude 完成规划后会调用 `ExitPlanMode` 工具向用户提议「请批准执行」。canUseTool 走独立分支（不走通用权限请求 UI，跟 AskUserQuestion 同一套架构）
- 活动流内嵌渲染 `ExitPlanRow`：绿边卡片 + header「📋 Claude 提议了一个执行计划」 + **header 右侧两按钮**：
  - **「批准计划，开始执行」**（实色绿）→ SDK 返回 `behavior: 'allow' + updatedInput 透传`，CLI 收到 tool_result 自动退出 plan mode、按非 plan 模式继续后续工具调用
  - **「继续规划」**（次按钮）→ 第一次点击展开「可选反馈」输入框，让用户告诉 Claude「哪里需要调整」（留空也能提交，提交后 SDK 返回 `behavior: 'deny' + 含反馈的 message`，Claude 留在 plan mode 修改计划）
- plan 内容用 **`MarkdownText` 完整渲染**（react-markdown + remark-gfm，标题 / 列表 / 表格 / 任务列表 / 代码块 / 链接全支持），不是一坨 JSON
- **超时自动按「继续规划」**：超过 `permissionTimeoutMs` 未响应 → SDK 收到 `keep-planning + 反馈「用户超时未响应」`，Claude 留在 plan mode 不会打断 turn（区别于普通 permission timeout 的 interrupt）
- 外部 CLI 会话（hook 通道）走 `tool-use-start` 路径：活动流也展开 plan markdown 让你能看到内容，但**只读不能批准**（必须回到对应终端窗口操作）
- 底部 toast「Claude 自动取消了一次计划批准请求」5s 灰带（SDK abort / interrupt 触发时）

### SessionDetail 面板（点击卡片打开）
- 头部：来源徽标（**内** / **外**）+ title + cwd + 返回按钮
- 顶部 toast：「Claude 自动取消了一条权限请求 / 提问 / 计划批准请求」5s 灰带（如有）—— 已不再有顶部 banner，PermissionRow / AskRow / ExitPlanRow 全部下放到活动流内嵌
- 四个 Tab：
  - **活动**：ActivityFeed 时间线
    - **message** 事件用对话气泡渲染：用户消息（绿色背景，右对齐，标记「你」）；Claude 回复（边框灰背景，左对齐，标记「Claude」）；错误消息（红框）；完整文字、保留换行、不截断
    - 气泡头部右侧的 **MD/TXT** 切换按钮：把气泡正文从纯文本切到 Markdown 渲染（`react-markdown` + `remark-gfm`，支持表格 / 任务列表 / 删除线 / 代码块 / 链接）；**每条消息独立切换、互不级联**（CHANGELOG_34 推翻 CHANGELOG_27 的「切单条 = 切全局」取舍）；默认 plaintext，切单条只改本条本地 state，**不持久化**（CHANGELOG_35 删 render-mode.ts，localStorage 也不再用）；切过的 bubble 卸载（切会话 / 重启）后回到默认；error 消息和空消息不显示按钮、强制 plaintext 保留堆栈结构
    - **tool-use-start**：`🔧 工具名 · 入参摘要` 单行；Edit / Write / MultiEdit 自动展开 Monaco DiffViewer 在行内（`overflow-hidden h-72`，一眼看到 Claude 写了什么）；ExitPlanMode（hook 通道）展开 markdown plan 让你能看到外部 CLI 提议的计划全文（只读）
    - **tool-use-end**：默认折叠成 `▸ 工具名 完成`；点击展开 `toolResult` 完整内容（pre 等宽，最高 64 行可滚）
    - **waiting-for-user (permission-request)** → PermissionRow 内嵌 + 操作按钮（header 右对齐）+ Edit/Write/MultiEdit diff 行内
    - **waiting-for-user (ask-user-question)** → AskRow 内嵌 + 选项 toggle + 「已选 N/M」+ 实色「提交回答」按钮
    - **waiting-for-user (exit-plan-mode)** → ExitPlanRow 内嵌 + markdown 渲染的 plan + 「批准计划，开始执行」/「继续规划（可选反馈）」二选一按钮
    - 其他事件单行简述：`📝 file_path`、`✅ 一轮完成`、`⏹ 会话结束 · reason`、`⚪ 提问已被 SDK 取消` 等
  - **改动**：按文件分组（按钮带改动次数小角标）+ Monaco DiffEditor + 同文件多次改动的时间线（语言自动识别 ts/js/py/go/rust/json/md/css/html/yaml/sh/java/c/cpp）；文件按最近改动时间倒序排列，默认选中最近的文件 + 该文件最新一次改动
  - **总结**：最新一条 LLM 总结（高亮）+ 历史展开
  - **权限**：按当前会话 cwd 解析三层 Claude Code settings.json（user / project / local），**只读展示**
    - 顶部「生效合并」面板：按 SDK `settingSources: ['user','project','local']` 顺序合并 `permissions` 字段（`allow` / `deny` / `ask` / `additionalDirectories` 累加去重，每条规则旁标注来源 chip `[U]/[P]/[L]`；`defaultMode` 取 local→project→user 倒序首个非空，标注来源）
    - 三层卡片各一张：路径、是否存在、整段 settings.json pretty-print（轻量 JSON 高亮，无 monaco 依赖）
    - 「打开」按钮：通过 `shell.openPath` 用系统默认应用打开（main 端白名单校验 path 必须是该 cwd 的三个候选路径之一，杜绝任意路径打开）；agent-deck 不写任何配置文件，改规则走外部编辑器
    - 解析失败：红色错误条 + 仍展示原文，方便排错；JSON 文件不存在：「未配置」灰字 + 仍展示推断路径
    - 「刷新」按钮手动重新拉；切 tab / 切会话自动拉一次；不上 file watcher（避免噪音）
    - 当 cwd 等于 home 目录时，project 与 user 路径相同，给出黄色提示
- 底部输入区：
  - **SDK 会话** → 权限模式下拉 + 输入框（Enter 发送 / Shift+Enter 换行；中文 IME 拼写期间不会被吞）+ 发送 / 中断按钮；sendMessage 抛 `not found` 时显示「会话已断开」红条 + **「恢复会话」**按钮
  - **外部 CLI** → 灰条「请回到对应终端窗口直接操作」

### 间歇 LLM 总结
- 调度器每隔 `summaryIntervalMs/2`（默认 2.5 min）扫一次 active+dormant 会话
- **触发条件**（顺序判断）：
  1. `inFlight` 跳过（同会话上次 LLM 还在跑）
  2. **新事件数为 0** → 跳过（避免反复跑出一模一样的总结）
  3. 时间到 (`summaryIntervalMs`) **或** 新事件数 ≥ `summaryEventCount` 任一满足
  4. **全局并发上限** (`summaryMaxConcurrent`，默认 2)：到顶就退出本轮，下次扫描重新评估
- **单次 oneshot 超时** (`summaryTimeoutMs`，默认 60s)：底层 cli.js 卡在等 result（代理超时 / 鉴权死锁 / API 限流）时优先 `q.interrupt()` 优雅清子进程，兜底 throw 让外层走最近一条 assistant 文字 / 事件统计降级；防止单个卡死永久占用 inFlight 槽把整个 Summarizer 锁死
- **设置面板改 `summaryIntervalMs` 即改即生效**：调用 `summarizer.setIntervalMs(ms)` 重启 setInterval，不需要重启应用
- **降级策略**（依次尝试）：
  1. 通过 SDK `query()` oneshot 跑本地 OAuth + plan 模式，让模型用一句话描述「在做什么」（`settingSources: []` 避免 hook 回环；模型选取链 `ANTHROPIC_DEFAULT_HAIKU_MODEL` → `ANTHROPIC_MODEL` → `'haiku'` alias 兜底，让最便宜最快的模型干这个最轻的活）
  2. 失败 → 取最近一条 assistant 文字（截 100 字）
  3. 再失败 → 事件 kind 统计兜底
- 显示在 SessionCard 第二行（一句话）+ SessionDetail「总结」Tab（带历史）

### Diff 插件架构
- `DiffRegistry` 单例 + `DiffRendererPlugin` 接口（`kind` / `priority` / `canHandle` / `Component`）
- 内置三个 renderer：`text`（Monaco DiffEditor，懒加载）/ `image`（按需 dataURL，支持 side / after-only / slide 三种视图）/ `pdf`（占位）
- 新增 renderer：在 `src/renderer/components/diff/install.ts` 注册即可，按 `kind` 分发
- `DiffViewer` 接收可选 `sessionId` 用 `SessionContext` 注入，让图片渲染器能调 `window.api.loadImageBlob` 按需读盘

### MCP 图片工具支持
- 识别命名规范 `mcp__<server>__ImageRead/ImageWrite/ImageEdit/ImageMultiEdit`（后缀匹配，server 名不锁死）
- 工具 `tool_result.content` 里放一个 `text` block，`text` 是 `JSON.stringify(<ImageToolResult>)`（详见 `src/shared/types.ts`）；agent-deck 解析后翻译成 `file-changed` 事件
- ImageRead 在活动流的工具卡片里直接展示缩略图；ImageWrite/Edit/MultiEdit 进入「改动」时间线，DiffViewer 用 `ImageDiffRenderer` 左右并排
- 图片二进制不进 IPC：事件 / DB 只存 `ImageSource`（`{kind:'path', path}`），renderer 通过 `window.api.loadImageBlob(sessionId, source)` 按需向主进程要 dataURL；主进程做白名单（path 必须出现在该 session 的 `file_changes` / `tool-use-start` 事件里）+ ext + size（≤20MB）校验，失败返回 `{ok:false, reason}` 由 UI 显示「图片不可读」灰底兜底
- ImageMultiEdit 拆成 N 条 `file-changed`（同一 `filePath`，metadata 带 `editIndex/total/prompt`），让按文件分组 + ChangeTimeline 天然展示「演进步骤」
- MCP server 单独维护（不在本仓库），按上述协议实现即可被 agent-deck 自动接入

### Adapter 插件架构
- `AdapterRegistry` 单例 + `AgentAdapter` 接口（`capabilities` / `init` / `shutdown` / `createSession?` / `interruptSession?` / `sendMessage?` / `respondPermission?` / `setPermissionMode?` / `installIntegration?` / `setCodexCliPath?`）
- 已实现：
  - **Claude Code**（hook + SDK 双通道，capabilities 全开）
  - **Codex CLI**（基于 `@openai/codex-sdk`，单 SDK 通道，capabilities = `canCreateSession + canInterrupt + canSendMessage`；不支持 hook / 工具批准 / AskUserQuestion / ExitPlanMode / 运行时切权限模式 —— SDK 物理不支持，详见 CHANGELOG_41）
- 占位骨架：aider / generic-pty（实现指引在源文件注释里）
- UI 通过 `capabilities` 过滤：能力为 false 的 adapter 不出现在选择列表；NewSessionDialog 按 `canSetPermissionMode` 隐藏权限模式字段；SessionDetail ComposerSdk 按 `agentId` 切 placeholder 文案与权限 select 显隐

### 持久化（SQLite）
- 应用 userData 目录下的 `agent-deck.db`（macOS 在 `Application Support/agent-deck/`，Windows 在 `%APPDATA%/agent-deck/`，Linux 在 `~/.config/agent-deck/`）
- 表：`sessions` / `events` / `file_changes` / `summaries` / `app_meta`
- 迁移系统（`db.ts` 内联 SQL，按 `user_version` pragma 增量推进）：
  - **v1** init（建表 + 索引）
  - **v2** 加 `sessions.source`（'sdk' | 'cli'）
  - **v3** 把 archived 从 lifecycle 拆为独立 `archived_at` 列（旧 `lifecycle='archived'` 行回填到 `closed` + `archived_at = COALESCE(archived_at, ended_at, last_event_at)`）
  - **v4** 加 `sessions.permission_mode`（持久化 SDK 通道用户上次选过的权限模式；CLI 通道字段无意义恒为 NULL）
- 应用启动恢复未归档会话；启动时执行 `LifecycleScheduler.scan()` 一次，把停机期间该过期的会话推进

### 设置面板（⚙）
- **Claude Code Hook**：安装 / 卸载（user 作用域，写 `~/.claude/settings.json`）
- **提醒**：声音 / 聚焦时静音 / 系统通知 / **测试系统通知**（弹一条横幅验证 OS 权限，dev 模式下首次需要在 系统设置 → 通知 → Electron 里允许）/ **自定义提示音**（waiting & finished 各自选 mp3 + 试听 + 重置）
- **生命周期**：`activeWindowMs`（分钟）/ `closeAfterMs`（小时）/ `permissionTimeoutMs`（秒，0=不超时；默认 300，超时把权限请求当 deny+interrupt 处理，避免会话死等）—— 即改即生效
- **间歇总结**：时间触发（分钟，**即改即生效**）/ 事件数触发 / 同时跑总结上限 / `summaryTimeoutMs`（单次 LLM 总结超时秒数，0=不超时；默认 60）
- **窗口**：开机自启（始终置顶由 header 📌 按钮 / 全局快捷键管理，不在面板里重复）
- **HookServer**：端口（重启 + 重新 install hook 才生效）。鉴权 token 不在 UI 露出，由 settings-store 在首次启动自动生成 32 字节随机 hex 并固定持久化
- **外部工具**：「Codex 二进制路径」(`codexCliPath`)。留空 = 用应用内置 codex（`@openai/codex-sdk` 跟随安装的 vendored 二进制，~150MB / 平台，已打包进 .app）；填路径 = 覆盖为外部 codex（如自装的更新版 `which codex` 给的路径）。即改即生效（清掉 Codex 实例，下次新建会话用新 path）；不影响在跑的会话。agent-deck **不读不写** codex 鉴权（`~/.codex/config.toml` / 环境变量），首次用前先在终端跑 `codex auth` 自己配好

### 快捷键
- `Cmd/Ctrl+Alt+P` —— 切换 pin（窗口置顶 + vibrancy 切换）
- SessionDetail 输入框：`Enter` 发送 · `Shift+Enter` 换行（中文 IME 上屏的 Enter 不会触发发送）

---

## 项目结构

```
src/
├── main/                    Electron 主进程
│   ├── index.ts             启动入口（DB → adapters → HookServer → window → IPC → CLI argv）
│   ├── cli.ts               命令行子命令（agent-deck new --cwd ...）：argv 解析 + applyCliInvocation；首启 + second-instance 共用
│   ├── window.ts            FloatingWindow（半透明 vibrancy、compact 折叠）
│   ├── ipc.ts               所有 IPC handler 集中点
│   ├── event-bus.ts         主进程内事件总线（agent-event / session-upserted 等）
│   ├── hook-server/         共享 fastify 实例 + RouteRegistry（adapter 动态注册路由）
│   ├── adapters/
│   │   ├── types.ts         AgentAdapter / AdapterContext / PermissionMode 接口
│   │   ├── registry.ts      AdapterRegistry 单例
│   │   ├── claude-code/
│   │   │   ├── index.ts     ClaudeCodeAdapter 主体（init 注册 hook 路由 + 创建 SDK bridge）
│   │   │   ├── hook-routes.ts    6 条 hook 路由，emit 时打 source: 'hook'
│   │   │   ├── hook-installer.ts 写入 / 卸载 ~/.claude/settings.json
│   │   │   ├── translate.ts      hook payload → AgentEvent
│   │   │   ├── settings-env.ts   bootstrap 时把 ~/.claude/settings.json 的 env 注入主进程
│   │   │   ├── sdk-injection.ts  自带 CLAUDE.md + plugin 路径定位（dev/prod 分流），sdk-bridge createSession 时注入到所有 SDK 会话
│   │   │   └── sdk-bridge.ts     query() AsyncGenerator 封装；canUseTool / 权限响应 / 切模式
│   │   ├── codex-cli/
│   │   │   ├── index.ts          CodexCliAdapter 主体（init 创建 SDK bridge；不注册 hook 路由）
│   │   │   ├── sdk-loader.ts     @openai/codex-sdk 动态 import（绕开 vite 静态分析对 ESM-only 的 require 转译）
│   │   │   ├── sdk-bridge.ts     CodexSdkBridge：thread.started → realId 同步（30s fallback）+ pendingMessages 串行 turn 队列（codex 同 thread 不能并发）+ AbortController interrupt（SIGTERM 子进程，下次 sendMessage 同 thread 续）
│   │   │   └── translate.ts      codex 8 种事件 + 8 种 item → AgentEvent 映射（command_execution → tool-use；agent_message/reasoning → message；file_change → file-changed × N，before/after 都是 null；mcp_tool_call/web_search/todo_list/error 映射详见 CHANGELOG_41）
│   │   ├── aider/index.ts        占位
│   │   └── generic-pty/index.ts  占位
│   ├── session/
│   │   ├── manager.ts            事件汇集 + 状态机 + sdkOwned 去重 + 归档/复活 + cwd 待领取标记 + renameSdkSession (tempKey→realId 整体迁移)；ingest 真状态变化才走 upsert+广播，仅 lastEventAt 推进走轻量 setActivity 不广播（避免 IPC 风暴）；归档与 lifecycle 严格正交，事件不会自动 unarchive
│   │   ├── lifecycle-scheduler.ts active → dormant → closed 推进
│   │   └── summarizer.ts         LLM 总结调度（节流 + 并发上限 + 单次超时 + 降级；setIntervalMs 即改即生效；prompt 标注「Claude 一侧的行为」防止 LLM 把动作误总结成「用户…」）
│   ├── notify/
│   │   ├── sound.ts          afplay / paplay / powershell 跨平台播放（防叠播 + 5s 上限 + before-quit 清理）
│   │   └── visual.ts         系统通知 + Dock 弹跳（不做窗口闪屏）
│   ├── permissions/
│   │   └── scanner.ts        会话详情「权限」tab 的数据源：读 user / project / local 三层 settings.json，按 SDK 顺序合并；只读，不写
│   └── store/
│       ├── db.ts             better-sqlite3 + 迁移系统（v1–v4 内联 SQL，按 user_version 推进）
│       ├── session-repo.ts   sessions 表 CRUD（含 listActiveAndDormant / listHistory / setPermissionMode / rename）
│       ├── event-repo.ts     events 表 CRUD
│       ├── file-change-repo.ts
│       ├── summary-repo.ts   含 latestForSessions（窗口函数批量取最新）
│       ├── settings-store.ts electron-store v8 + 弃用字段自动清理（REMOVED_KEYS 数组）
│       └── migrations/v001_init.sql  历史脚本（实际逻辑在 db.ts 内联）
├── preload/index.ts          contextBridge 暴露 window.api / window.electronIpc
└── renderer/                 React 19
    ├── App.tsx               header（标题/统计/⚠pending chip/＋/3 个 tab：实时·待处理·历史/pin/折叠/⚙）+ main + dialogs；mount 时拉一次 listAdapterPendingAll 重建 store；pending chip 与「待处理」tab badge 共享 selectPendingBuckets 计数口径
    ├── main.tsx              React 挂载 + ErrorBoundary + 全局 error/unhandledrejection 兜底
    ├── components/
    │   ├── FloatingFrame.tsx     毛玻璃容器（pin/无 pin 两套 background + backdrop-filter）
    │   ├── SessionList.tsx       active / dormant 分段
    │   ├── SessionCard.tsx       状态徽标 + 来源徽标 + 实时活动行 + 总结行 + 右键菜单（归档/重新激活/删除）
    │   ├── SessionDetail.tsx     头部 / 自动取消 toast / 4 Tab / 底部 composer（权限模式下拉 + 输入框 + 恢复会话 + 中断）；PermissionRequests / AskUserQuestionPanel 仍 export 备 banner 模式回切
    │   ├── PendingTab.tsx        集中「待处理」面板：按会话分组（PendingSection），整行可点跳到 SessionDetail；每 section 「全部允许 / 全部拒绝」批量按钮（仅作用于 PermissionRequest + ExitPlanModeRequest，AskUser 不参与）；pending 内容直接复用 pending-rows 的 PermissionRow / AskRow / ExitPlanRow（含 Monaco diff、选项、markdown 全部保留）
    │   ├── pending-rows/index.tsx PermissionRow / AskRow / ExitPlanRow / toolInputToDiff —— 三个 Row 与 ActivityFeed 和 PendingTab 共用，pending 三态视觉与按钮逻辑都在这里
    │   ├── PermissionsView.tsx   会话详情「权限」tab：调 scanCwdSettings 拿三层 settings.json，渲染合并视图 + 三层卡片 + 轻量 JSON 高亮 + 「打开」（shell.openPath）按钮 + 刷新
    │   ├── HistoryPanel.tsx      关键字搜索 / 仅归档筛选 / 归档|取消归档|删除
    │   ├── NewSessionDialog.tsx  ＋ 按钮的弹窗表单（首条消息必填校验）
    │   ├── SettingsDialog.tsx    设置面板（含 DEFAULT_SETTINGS 兜底 + getSettings/hookStatus 异步错误显示）
    │   ├── ActivityFeed.tsx      MessageBubble（含 MD/TXT 切换按钮）/ ActivityRow（派遣三类 waiting-for-user 事件到 pending-rows 的 PermissionRow / AskRow / ExitPlanRow，渲染历史三态：等待中 / 已响应 / 已被 SDK 取消）/ ToolStartRow（内嵌 diff 走 pending-rows 的 toolInputToDiff，ExitPlanMode hook 通道展开 plan，mcp ImageRead 直接缩略图）/ ToolEndRow（折叠展开 result）/ SimpleRow
    │   ├── MarkdownText.tsx      MessageBubble + ExitPlanRow 共用受限 Markdown 渲染器（react-markdown + remark-gfm，链接强制系统浏览器，pre/table 加 overflow）
    │   ├── ImageThumb.tsx        通用图片缩略图组件（xs/sm/md/lg），包装 ImageBlobLoader
    │   ├── SummaryView.tsx
    │   ├── StatusBadge.tsx
    │   └── diff/
    │       ├── DiffViewer.tsx    入口分发（接 sessionId 通过 SessionContext 注入给图片渲染器）
    │       ├── SessionContext.ts sessionId 的 React Context（让 ImageDiffRenderer 能调 loadImageBlob）
    │       ├── registry.ts
    │       ├── install.ts        启动注册内置 renderer
    │       └── renderers/
    │           ├── TextDiffRenderer.tsx     Monaco 懒加载
    │           ├── ImageDiffRenderer.tsx    side / after-only / slide 三视图，header 显 NEW / prompt / editIndex
    │           ├── ImageBlobLoader.tsx      模块级 LRU + render-prop，调 window.api.loadImageBlob 拿 dataURL
    │           └── PdfDiffRenderer.tsx      占位
    ├── stores/session-store.ts   Zustand：sessions / recentEvents / summaries / latestSummary / pendingPermissions / pendingAskQuestions / pendingExitPlanModes；setPendingRequests / setPendingRequestsAll（拉取重建，3 路 pending 同步）；renameSession（SDK fallback 整体迁移）
    ├── hooks/use-event-bridge.ts onSessionUpserted / onSessionRemoved / onSessionRenamed / onAgentEvent / onSummaryAdded 桥接
    ├── lib/
    │   ├── ipc.ts                动态 channel 兜底
    │   └── session-selectors.ts  selectLiveSessions（archivedAt === null && lifecycle ∈ {active, dormant}，App.tsx header stats 与 SessionList 共用）+ selectPendingBuckets（按会话聚合 pending，同口径过滤；waiting 优先 + lastEventAt 倒序，PendingTab 唯一数据源）+ sumPendingBuckets（让 chip 与 tab badge 走同一份计数）
    └── styles/globals.css        Tailwind 4 + frosted-frame Acrylic CSS（默认底色加深，pin 模式高透明）

resources/
├── icon.png                 Dock / 窗口图标（1024×1024）
├── icons/                   electron-builder 多分辨率
├── sounds/                  内置 waiting / done 提示音
├── bin/agent-deck           macOS CLI wrapper（chmod +x；打包后位于 .app/Contents/Resources/bin/）
└── claude-config/           **Agent Deck 自带 CLAUDE.md + skill 集合**，extraResources 复制到 .app/Contents/Resources/claude-config/
    ├── CLAUDE.md            自带应用级约定，sdk-bridge createSession 时通过 systemPrompt.append 注入到所有会话
    └── agent-deck-plugin/   SDK plugin 根（manifest + skills/）
        ├── .claude-plugin/plugin.json
        └── skills/<name>/SKILL.md   自带 skill，SDK 自动以 `agent-deck:<name>` 命名空间注册
```

---

## 开发与运行

### 首次准备
```bash
pnpm install
pnpm rebuild better-sqlite3 electron esbuild   # 给当前 Electron 重编 native module
```

### 开发模式
```bash
pnpm dev           # electron-vite + HMR
```
- HMR 只对 renderer 生效；改了 `src/main/**` 或 `src/preload/**` 必须重启 dev
- 改了 `AppSettings` 字段后，前端有 `DEFAULT_SETTINGS` 兜底，但要写入新字段必须重启 main

### 类型检查 / 构建 / 打包
```bash
pnpm typecheck
pnpm build
pnpm dist          # 产出 release/Agent Deck-x.y.z.dmg + release/mac-arm64/Agent Deck.app
```

### 安装到本机（macOS，非签名）
```bash
# 0. 杀掉所有旧实例（必做！macOS 复用同 bundle id 的活进程，
#    不杀会出现「旧 main + 新资源」chunk hash 错配，monaco 等 dynamic import 会被
#    渲染成一坨 plain text 源码——CHANGELOG_26 实测踩坑）
pkill -f "Agent Deck.app/Contents/MacOS/Agent Deck" 2>/dev/null
pkill -f "Agent Deck Helper" 2>/dev/null

# 1. 出 dmg + .app
rm -rf release && pnpm dist

# 2. 覆盖到 /Applications（旧版需先 rm，cp -R 不会清残留）
rm -rf "/Applications/Agent Deck.app"
cp -R "release/mac-arm64/Agent Deck.app" /Applications/

# 3. ad-hoc 重签：把签名 Identifier 从 'Electron' 拉回 'com.agentdeck.app'
#    （不签的话 macOS 通知中心 / Gatekeeper 会按 Electron 注册，与 Info.plist 不一致）
codesign --force --deep --sign - "/Applications/Agent Deck.app"

# 4. 清掉 quarantine，否则未签名 .app 首次开会被 Gatekeeper 拦
xattr -dr com.apple.quarantine "/Applications/Agent Deck.app"

# 5. 软链 wrapper 到 PATH（一次性）
ln -sf "/Applications/Agent Deck.app/Contents/Resources/bin/agent-deck" /usr/local/bin/agent-deck

# 6. 验证：从任意目录拉起一条会话
agent-deck new --prompt "ping"
```

打包配置上有几个不能改回去的设定（CHANGELOG_16 / CHANGELOG_21 / CHANGELOG_26）：
- `package.json > build.mac.icon = "resources/icon.png"` —— 没这一行 electron-builder 会找 `resources/icons/` 多分辨率集，找不到就报 `icon directory ... doesn't contain icons` 然后 dmg 出不来
- `package.json > build.extraResources` 把 `resources/bin → bin` —— 不显式拷的话 `Agent Deck.app/Contents/Resources/bin/agent-deck` 不会出现，wrapper 链就断了
- `codesign --force --deep --sign -` 必须做，让 .app 的签名 Identifier 与 CFBundleIdentifier 一致；否则系统通知 / 权限设置可能挂在「Electron」名下找不到
- 重装前 `pkill` 必须做（步骤 0），否则旧 main 进程被 macOS 复用，renderer 的 chunk hash 与新 .app 资源对不上，dynamic import 拉错文件会被当 plain text 渲染（窗口里直接出现 monaco-editor 源码片段）

### 验证 Hook 通道（无需 dev 窗口）
```bash
curl -sS -X POST http://127.0.0.1:47821/hook/sessionstart \
  -H 'Content-Type: application/json' \
  -d '{"session_id":"test-001","cwd":"<任意目录>"}'
# {"ok":true}
```

### 查 SQLite
打开应用 userData 目录下的 `agent-deck.db`（路径见上文「持久化」一节），用 `sqlite3` 或任意 GUI 客户端查询：
```sql
SELECT id, source, lifecycle, activity FROM sessions;
```

### 关键端口
- `47821` —— HookServer（设置面板可改，重启生效）
- `5173` —— vite renderer dev server

---

## 鉴权与本地配置复用

应用**完全不管 API Key**，所有 SDK 通道（包括应用内会话与间歇总结）都走 `~/.claude` 本地凭证：

1. SDK 自己按 `ANTHROPIC_API_KEY` → `~/.claude/.credentials.json` 找
2. 跑过 `claude login` 即可（订阅会员或 Console 账户都行）
3. 应用内会话还会读取 `~/.claude/settings.json` + 项目级 `.claude/settings.json`，跟终端 `claude` 完全等价
4. **`~/.claude/settings.json` 的 `env` 字段**会在应用启动时被 `applyClaudeSettingsEnv()` **按白名单**注入到主进程 `process.env`，让 SDK spawn 出来的 CLI 子进程能拿到代理配置（`ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` / 模型映射等）。这一步是为了避免「shell env 与 settings.json env 冲突」或「SDK 默认 env 隔离」造成 Invalid API key。**白名单**：`ANTHROPIC_*` / `CLAUDE_*` / 标准代理变量（HTTP_PROXY / HTTPS_PROXY / NO_PROXY / ALL_PROXY 大小写两份），其它键拒绝并 warn — 防止 settings.json 被夹带 `NODE_OPTIONS` / `PATH` / `ELECTRON_RUN_AS_NODE` 等危险键污染信任链
5. **HookServer Bearer token**：所有 hook 路由用首启自动生成的 256-bit hex token 鉴权（不需要也不应该手动配置）。hook 命令在 install 时把 token 嵌入 `Authorization` 头；防止本机其它进程伪造事件污染 SQLite

---

## changelog

每次改动写入 `changelog/` 文件夹，规则见 `CLAUDE.md`。索引在 `changelog/INDEX.md`。
