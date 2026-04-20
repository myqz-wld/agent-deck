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
- **Agent 适配器插件化**（首期只实现 Claude Code，预留 codex-cli / aider / generic-pty 占位）
- **Diff 渲染器插件化**（首期 Monaco 文本 diff，预留 image / pdf 占位）

---

## 功能总览

### 半透明毛玻璃悬浮窗
- macOS `vibrancy: under-window` + CSS `backdrop-filter: blur(36px) saturate(220%) brightness(0.92)` 双层模糊；带 SVG turbulence 噪点纹理 + 内阴影做 Acrylic 质感
- 默认尺寸 520×680，右上角偏内出现；可拖动 / 缩放 / 折叠为胶囊
- 默认（无 pin）底色加深到 `rgba(12,14,20,0.78)` —— 浅色桌面背景下文字也清晰；pin 模式（📌）下背景更通透（`rgba(18,18,24,0.2) + blur(18px)`），关掉 vibrancy 让你能透过窗口继续工作
- 全局快捷键 `Cmd/Ctrl+Alt+P` 切换 pin

### 会话列表（实时 / 历史）
- **实时**：分两段显示 active 与 dormant 的会话，按 `last_event_at` 倒序
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
- 弹窗表单：Agent / cwd（带「选择…」目录选择器）/ **首条消息（必填）** / 模型 / 权限模式 / System Prompt（可选）
- 首条消息为什么必填：SDK streaming 协议要求 CLI 子进程必须收到 stdin 首条 user message 才会启动；空 prompt 会卡死直到 30s fallback，所以表单层强制必填
- 模型选项：按本地 settings.json / Sonnet 4.5 / Opus 4.7 / Haiku 4.5
- 权限模式：default / acceptEdits / plan / bypassPermissions（用户上次选过的会持久化在 `sessions.permission_mode`，下次切回 detail 自动还原）
- 创建后自动切到「实时」并选中

### 命令行新建会话（macOS）
- 等价于在 ＋ 弹窗里点「确定」，但适合从终端直接拉起 / 在脚本里串
- wrapper 脚本：`resources/bin/agent-deck`（已 chmod +x），打包后位于 `Agent Deck.app/Contents/Resources/bin/agent-deck`
- 推荐做软链：`ln -sf "/Applications/Agent Deck.app/Contents/Resources/bin/agent-deck" /usr/local/bin/agent-deck`，从此终端直接 `agent-deck ...`
- **最简用法**（参数全默认）：
  ```bash
  agent-deck                                     # 等价 agent-deck new --cwd "$PWD" --prompt "你好"
  agent-deck --prompt "帮我看看这个 bug"        # 自动补 new 子命令
  ```
  没传 `--cwd` 时取当前 PWD；没传 `--prompt` 时默认填 `"你好"`，避免 SDK 卡 30s fallback 才显出会话（你也可以显式 `--prompt ""` 强制为空，会话会卡 30s 才出现）
- **完整用法**：
  ```bash
  agent-deck new \
    [--cwd <path>]                        # 缺省取当前 PWD；wrapper 会把相对路径转绝对
    [--prompt "..."]                      # 首条消息（缺省 "你好"，避免 SDK 卡 30s fallback）
    [--agent claude-code]                 # 默认 claude-code，未来其他 SDK adapter 接入时换
    [--model <name>]                      # 等价表单的模型字段
    [--permission-mode default|acceptEdits|plan|bypassPermissions]
    [--system-prompt "..."]
    [--resume <sessionId>]                # 续历史 jsonl，对应 detail 底部「恢复会话」
    [--no-focus]                          # 默认会拉前窗口 + 选中新会话；加这个静默新建
  ```
- 应用未启动 → macOS 自动拉起；已启动 → `requestSingleInstanceLock()` 的 `second-instance` 事件转发参数到主实例处理
- 默认行为：把窗口 `show()+focus()`，再 emit `event:session-focus-request`，renderer 切到「实时」并选中新会话
- 解析失败（缺 --cwd / --permission-mode 取值非法）→ stderr + Electron `dialog.showErrorBox` 双通道报错
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
- 鉴权：SDK 自己按 `ANTHROPIC_API_KEY` → `~/.claude/.credentials.json` 找（应用不读不覆盖；跑过 `claude login` 即可）
- **`~/.claude/settings.json` 的 `env` 字段在 bootstrap 时被 `applyClaudeSettingsEnv()` 注入到主进程 `process.env`**：用户在 settings.json 里配置的代理（`ANTHROPIC_BASE_URL`）/ Bearer token（`ANTHROPIC_AUTH_TOKEN`）/ 模型映射，SDK spawn 的 CLI 子进程会继承到，避免「shell 里有冲突 env」或「SDK env 隔离」导致的 Invalid API key
- 真实 session_id 由 SDK 第一条消息携带，应用启动后等到再返回
- SDK 通道 emit 的事件打 `source: 'sdk'`；hook 通道回环到同 sessionId 的事件被 `SessionManager.sdkOwned` 集合自动去重
- **30s fallback / tempKey 重命名**：CLI 启动后 30s 仍未发任何 SDKMessage（鉴权失败 / 模型不可用 / 代理超限），会用 `tempKey` 顶上并 emit 一条错误 message 让 UI 立刻看到原因；后续真实 `session_id` 到达时调 `SessionManager.renameSdkSession(tempKey, realId)` 把 sessions 行 + events / file_changes / summaries 子表整体迁移，renderer 通过 `event:session-renamed` 同步迁移 selectedId 与所有 by-session 状态，用户保持在 detail 不被踢回主界面
- **cwd 待领取标记**（`expectSdkSession`）：SDK spawn 之前先注册 cwd → 60s 内首发的同 cwd hook 事件自动归 SDK 所有，避免 hook 通道领先到达时出现「内 / 外」两份重复会话；`realpath` + 尾斜杠归一，并对单 pending 做模糊匹配兜底（macOS `/private/var ↔ /var` 等）

### Hook 通道（外部 CLI 会话）
- 内嵌 fastify HTTP server (默认 `127.0.0.1:47821`)
- HookInstaller：在「设置」点「安装到 ~/.claude/settings.json」会写入 6 条 hook（SessionStart / PreToolUse / PostToolUse / Notification / Stop / SessionEnd），每条命令带 `# agent-deck-hook` 标记，便于一键卸载
- payload 翻译：PostToolUse(Edit/Write/MultiEdit) → `tool-use-end` + `file-changed`（含 before/after，喂给 DiffCollector）
- Hook 通道事件打 `source: 'hook'`

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
- 也可在底部 Composer 上切换权限模式（default / acceptEdits / plan / bypassPermissions）；切到 `bypassPermissions` 需要在新建会话时就选好（CLI 子进程必须以 `--allow-dangerously-skip-permissions` 启动才生效）
- **超时自动 abort**：超过 `permissionTimeoutMs`（默认 300s）未响应 → 自动按 deny+interrupt 处理 + 推一条警告 message 到时间线 + emit `permission-cancelled`，UI 自动移除按钮，避免会话死等
- **Claude 自动取消时弹 toast**：SDK 主动 abort 一条 pending（流终止 / interrupt / 上层超时）时，SessionDetail 顶部弹 5s 的「Claude 自动取消了一条权限请求」灰色 toast，让用户知道按钮消失不是自己点掉的
- **renderer 重启 / HMR / 切会话**：自动从主进程拉一次真实 pending 列表（IPC `adapter:list-pending` / `adapter:list-pending-all`），重建 store；不然事件流里的 `permission-request` 会被错渲成「已处理」按钮不显示 → SDK 死锁
- **header pending 计数**：右上角 `⚠ N 待处理` chip，把当前所有 SDK 会话的未响应权限/提问加总；点击跳到首个有 pending 的会话
- **sendMessage 时还有 pending → 推警告**：避免用户以为 Claude 死了（SDK query() 在等 canUseTool resolve，新消息会进队列但短时间内不被消费）

### Claude 主动询问（AskUserQuestion，仅 SDK 会话）
- Claude 调用 `AskUserQuestion` 工具时，canUseTool 走独立分支（不走通用权限请求 UI）
- 直接在**活动流内嵌渲染** `AskRow`：绿边高亮卡片 + header 显示「❓ Claude 在询问你 · 已选 N/M」+ **header 右侧实色「提交回答」按钮**（CHANGELOG_11：之前透明按钮藏在卡片末尾用户找不到 → 改成实色 + 顶到 header + 底部再放一个兜底 + 进度文字「还有 X 题未选 / 已选满，可提交」）
- 每个 question 一行；options 用按钮（**点击 = toggle**，不再「单选立即提交」—— 所有题型统一一种交互更可预期，避免用户以为按错了没法回头）
- 每题最后有「其他（可选）」自由输入框
- 用户提交后，答案被拼成可读文本塞进 deny.message 反馈给 Claude，Claude 看到 tool_result 含答案就基于答案继续对话
- **超时自动跳过**：超过 `permissionTimeoutMs` 未答复 → 自动给 SDK 一个「用户超时未回答」的空答案 + 推警告 message，避免 Claude 永远卡在等回答
- 外部 CLI 会话只展示，不允许操作（hook 通道没有 canUseTool 通路）

### SessionDetail 面板（点击卡片打开）
- 头部：来源徽标（**内** / **外**）+ title + cwd + 返回按钮
- 顶部 toast：「Claude 自动取消了一条权限请求 / 提问」5s 灰带（如有）—— 已不再有顶部 banner，PermissionRow / AskRow 全部下放到活动流内嵌
- 三个 Tab：
  - **活动**：ActivityFeed 时间线
    - **message** 事件用对话气泡渲染：用户消息（绿色背景，右对齐，标记「你」）；Claude 回复（边框灰背景，左对齐，标记「Claude」）；错误消息（红框）；完整文字、保留换行、不截断
    - **tool-use-start**：`🔧 工具名 · 入参摘要` 单行；Edit / Write / MultiEdit 自动展开 Monaco DiffViewer 在行内（`overflow-hidden h-72`，一眼看到 Claude 写了什么）
    - **tool-use-end**：默认折叠成 `▸ 工具名 完成`；点击展开 `toolResult` 完整内容（pre 等宽，最高 64 行可滚）
    - **waiting-for-user (permission-request)** → PermissionRow 内嵌 + 操作按钮（header 右对齐）+ Edit/Write/MultiEdit diff 行内
    - **waiting-for-user (ask-user-question)** → AskRow 内嵌 + 选项 toggle + 「已选 N/M」+ 实色「提交回答」按钮
    - 其他事件单行简述：`📝 file_path`、`✅ 一轮完成`、`⏹ 会话结束 · reason`、`⚪ 提问已被 SDK 取消` 等
  - **改动**：按文件分组（按钮带改动次数小角标）+ Monaco DiffEditor + 同文件多次改动的时间线（语言自动识别 ts/js/py/go/rust/json/md/css/html/yaml/sh/java/c/cpp）；文件按最近改动时间倒序排列，默认选中最近的文件 + 该文件最新一次改动
  - **总结**：最新一条 LLM 总结（高亮）+ 历史展开
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
- **降级策略**（依次尝试）：
  1. 通过 SDK `query()` oneshot 跑本地 OAuth + plan 模式，让模型用一句话描述「在做什么」（`settingSources: []` 避免 hook 回环；模型选取链 `ANTHROPIC_DEFAULT_HAIKU_MODEL` → `ANTHROPIC_MODEL` → `'haiku'` alias 兜底，让最便宜最快的模型干这个最轻的活）
  2. 失败 → 取最近一条 assistant 文字（截 100 字）
  3. 再失败 → 事件 kind 统计兜底
- 显示在 SessionCard 第二行（一句话）+ SessionDetail「总结」Tab（带历史）

### Diff 插件架构
- `DiffRegistry` 单例 + `DiffRendererPlugin` 接口（`kind` / `priority` / `canHandle` / `Component`）
- 内置三个 renderer：`text`（Monaco DiffEditor，懒加载）/ `image`（占位）/ `pdf`（占位）
- 新增 renderer：在 `src/renderer/components/diff/install.ts` 注册即可，按 `kind` 分发

### Adapter 插件架构
- `AdapterRegistry` 单例 + `AgentAdapter` 接口（`capabilities` / `init` / `shutdown` / `createSession?` / `interruptSession?` / `sendMessage?` / `respondPermission?` / `setPermissionMode?` / `installIntegration?`）
- 已实现：**Claude Code**（hook + SDK 双通道）
- 占位骨架：codex-cli / aider / generic-pty（实现指引在源文件注释里）
- UI 通过 `capabilities` 过滤，能力为 false 的 adapter 不出现在选择列表

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
- **间歇总结**：时间触发（分钟）/ 事件数触发 / 同时跑总结上限
- **窗口**：开机自启（始终置顶由 header 📌 按钮 / 全局快捷键管理，不在面板里重复）
- **HookServer**：端口（重启生效）

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
│   │   │   └── sdk-bridge.ts     query() AsyncGenerator 封装；canUseTool / 权限响应 / 切模式
│   │   ├── codex-cli/index.ts    占位
│   │   ├── aider/index.ts        占位
│   │   └── generic-pty/index.ts  占位
│   ├── session/
│   │   ├── manager.ts            事件汇集 + 状态机 + sdkOwned 去重 + 归档/复活 + cwd 待领取标记 + renameSdkSession (tempKey→realId 整体迁移)
│   │   ├── lifecycle-scheduler.ts active → dormant → closed 推进
│   │   ├── diff-collector.ts     file-changed 事件落库（轻封装）
│   │   └── summarizer.ts         LLM 总结调度（节流 + 并发上限 + 降级；prompt 标注「Claude 一侧的行为」防止 LLM 把动作误总结成「用户…」）
│   ├── notify/
│   │   ├── sound.ts          afplay / paplay / powershell 跨平台播放（防叠播 + 5s 上限 + before-quit 清理）
│   │   └── visual.ts         系统通知 + Dock 弹跳（不做窗口闪屏）
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
    ├── App.tsx               header（标题/统计/⚠pending 计数 chip/＋/tab/pin/折叠/⚙）+ main + dialogs；mount 时拉一次 listAdapterPendingAll 重建 store
    ├── main.tsx              React 挂载 + ErrorBoundary + 全局 error/unhandledrejection 兜底
    ├── components/
    │   ├── FloatingFrame.tsx     毛玻璃容器（pin/无 pin 两套 background + backdrop-filter）
    │   ├── SessionList.tsx       active / dormant 分段
    │   ├── SessionCard.tsx       状态徽标 + 来源徽标 + 实时活动行 + 总结行 + 右键菜单（归档/重新激活/删除）
    │   ├── SessionDetail.tsx     头部 / 自动取消 toast / 3 Tab / 底部 composer（权限模式下拉 + 输入框 + 恢复会话 + 中断）；PermissionRequests / AskUserQuestionPanel 仍 export 备 banner 模式回切
    │   ├── HistoryPanel.tsx      关键字搜索 / 仅归档筛选 / 归档|取消归档|删除
    │   ├── NewSessionDialog.tsx  ＋ 按钮的弹窗表单（首条消息必填校验）
    │   ├── SettingsDialog.tsx    设置面板（含 DEFAULT_SETTINGS 兜底 + getSettings/hookStatus 异步错误显示）
    │   ├── ActivityFeed.tsx      MessageBubble / PermissionRow（内嵌按钮 + diff）/ AskRow（toggle + 实色提交按钮）/ ToolStartRow（内嵌 diff）/ ToolEndRow（折叠展开 result）/ SimpleRow
    │   ├── SummaryView.tsx
    │   ├── StatusBadge.tsx
    │   └── diff/
    │       ├── DiffViewer.tsx    入口分发
    │       ├── registry.ts
    │       ├── install.ts        启动注册内置 renderer
    │       └── renderers/        TextDiffRenderer (Monaco) / ImageDiffRenderer / PdfDiffRenderer
    ├── stores/session-store.ts   Zustand：sessions / recentEvents / summaries / latestSummary / pendingPermissions / pendingAskQuestions；setPendingRequests / setPendingRequestsAll（拉取重建）；renameSession（SDK fallback 整体迁移）
    ├── hooks/use-event-bridge.ts onSessionUpserted / onSessionRemoved / onSessionRenamed / onAgentEvent / onSummaryAdded 桥接
    ├── lib/ipc.ts                动态 channel 兜底
    └── styles/globals.css        Tailwind 4 + frosted-frame Acrylic CSS（默认底色加深，pin 模式高透明）

resources/
├── icon.png                 Dock / 窗口图标（1024×1024）
├── icons/                   electron-builder 多分辨率
├── sounds/                  内置 waiting / done 提示音
└── bin/agent-deck           macOS CLI wrapper（chmod +x；打包后位于 .app/Contents/Resources/bin/）
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
# 1. 出 dmg + .app
rm -rf release && pnpm dist

# 2. 覆盖到 /Applications（旧版需先 rm，cp -R 不会清残留）
rm -rf "/Applications/Agent Deck.app"
cp -R "release/mac-arm64/Agent Deck.app" /Applications/

# 3. 清掉 quarantine，否则未签名 .app 首次开会被 Gatekeeper 拦
xattr -dr com.apple.quarantine "/Applications/Agent Deck.app"

# 4. 软链 wrapper 到 PATH（一次性）
ln -sf "/Applications/Agent Deck.app/Contents/Resources/bin/agent-deck" /usr/local/bin/agent-deck

# 5. 验证：从任意目录拉起一条会话
agent-deck new --prompt "ping"
```

打包配置上有两个不能改回去的设定（CHANGELOG_16）：
- `package.json > build.mac.icon = "resources/icon.png"` —— 没这一行 electron-builder 会找 `resources/icons/` 多分辨率集，找不到就报 `icon directory ... doesn't contain icons` 然后 dmg 出不来
- `package.json > build.extraResources` 把 `resources/bin → bin` —— 不显式拷的话 `Agent Deck.app/Contents/Resources/bin/agent-deck` 不会出现，wrapper 链就断了

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
4. **`~/.claude/settings.json` 的 `env` 字段**会在应用启动时被 `applyClaudeSettingsEnv()` 注入到主进程 `process.env`，让 SDK spawn 出来的 CLI 子进程能拿到代理配置（`ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` / 模型映射等）。这一步是为了避免「shell env 与 settings.json env 冲突」或「SDK 默认 env 隔离」造成 Invalid API key

---

## changelog

每次改动写入 `changelog/` 文件夹，规则见 `CLAUDE.md`。索引在 `changelog/INDEX.md`。
