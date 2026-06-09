# CLAUDE.md

> 本文件保留 **agent-deck 项目专属 design invariant**（§项目特定约定 / §仓库基础 / §验证流程 / §打包与本地安装）+ 普通终端 Claude 跑本仓库时的最低入口规则。Codex 对偶入口是 `AGENTS.md`；共享仓库规则以本文件为准，`AGENTS.md` 只补 Codex 入口差异，避免双写漂移。
>
> **应用 SDK 会话内**额外加载 `resources/claude-config/CLAUDE.md` 获取 Agent Deck 协议约定。changelog / review / convention / file-size / flow-architecture diagram 等项目产物有用户 skills 时可自动化；没有这些 skills 时，按本文件最小规则和 `ref/` 现有索引/模板相邻格式执行。Agent Deck 内置 baseline 不依赖用户侧 skills。

## 仓库基础

- macOS 环境，包管理器用 pnpm
- Node.js ≥ 18（推荐用 nvm 管理）

---

## 改动后必做（最低操作指南）

> 本节保留本仓库的最低闭环执行流程。用户安装的 project skills 可增强产物生成与检查；缺失时直接沿用 `ref/changelogs/`、`ref/reviews/`、`ref/conventions/`、`ref/flows/`、`ref/architecture/` 的现有 INDEX 和相邻文件格式。

1. **改用户可见行为 / 文件结构 / 启动方式**（UI / 设置项 / 快捷键 / 项目结构 / 端口 / 依赖 / 验证步骤）→ 改对应章节 `README.md`；纯 bug 修复 / 内部重构不动 README
2. 改功能前先读当前项目已有的约定、changelog、review 记录；优先从对应 `ref/*/INDEX.md` 进入，再读相关条目
3. 改长生命周期 prompt 资产前，按“内置资产自闭环原则”审计；当前环境有 prompt-asset 维护 skill 时，用它负责 inventory、备份、去重和 review，不要把 Agent Deck 必要行为外包给用户侧 skill

---

## 项目特定约定（设计要点速查）

反复出现过的设计决定，改动前注意：

### 鉴权与会话边界

- 应用**不读不写**任何 API Key。所有 SDK 调用走本地 `~/.claude/.credentials.json`（OAuth）
- 间歇总结的 SDK oneshot 设 `settingSources: []`，避免 hook 回环到自己
- 应用内会话的 SDK 设 `settingSources: ['user', 'project', 'local']`，等价于在该 cwd 跑 `claude`

### 跨会话协作 / MCP 边界

- 跨 adapter 协作走 Agent Deck Universal Team Backend + Agent Deck MCP tools；不要恢复旧 inbox-based Agent Teams backend。
- Teammate 调工具走 teammate 自己会话的 permission / sandbox 边界；lead 不代批权限，不把 lead 的 `permissionMode` / allowlist 套到 teammate。
- Agent Deck MCP server 默认开启；关闭 `enableAgentDeckMcp` 时，新建 SDK 会话不挂 agent-deck MCP tools，Codex 自动注入的 `mcp_servers.agent-deck` 段也会移除。
- Claude / Codex 应用提示词资产必须成对审计：`resources/claude-config/CLAUDE.md` ↔ `resources/codex-config/CODEX_AGENTS.md`，skills 目录同名文件也要检查对偶。adapter 工具差异允许措辞不同，但协议语义不能单边漂移。

### 内置资产自闭环原则（重要）

Agent Deck 内部资产必须在 Agent Deck bundle 内自闭环；这是本项目的核心设计原则之一，不是实现细节。`resources/claude-config/`、`resources/codex-config/`、内置 `agent-deck-plugin` agents/skills、注入 SDK 的 MCP tool description 都必须在 Agent Deck baseline 内自洽生效。用户不安装任何额外 skill 时，Agent Deck 内置行为仍必须完整可用。

根 `README.md`、`CLAUDE.md`、`AGENTS.md`、`resources/README.md` 也是长期 prompt 资产；修改时按同一原则审计自闭环、触发条件、边界和本地链接。通用 prompt-asset inventory、备份、去重和 review 流程由维护 workflow 承担，不写进 Agent Deck runtime baseline。

用户安装的 skills 是增强层，不是 Agent Deck 内置行为的依赖层。把弱相关内容拆出去时，只能从内置资产中删除，或保留一份自闭环的最小规则；**不得**把必要行为替换成“去用某个用户侧 skill / 详见外部 skill”或 `$some-skill` 指针。Agent Deck 自带并随应用打包的 internal agents / skills / resources 可以互相引用作为内部闭环，但引用方仍要保留触发条件、边界和失败动作等执行所需的最小信息。

### 事件去重与生命周期

- `AgentEvent.source = 'sdk' | 'hook'`；SDK 接管的 sessionId 加入 `SessionManager.sdkOwned`，hook 同 id 事件被丢弃
- `lifecycle` (`active` / `dormant` / `closed`) 与 `archived_at` **正交**。归档只打标记，取消归档清标记回到原 lifecycle（不粗暴重置 dormant）。LifecycleScheduler 跳过 `archived_at IS NOT NULL`
- `SessionManager.consumePendingSdkClaim` 不准做「全局 fuzzy 匹配」；cwd 别名靠 `normalizeCwd` 内的 `realpathSync`

### 会话恢复 / 断连 UX（resume 优先）

总纲：resume 必须保持同一会话身份 + detail 连续性。**凡让用户感觉「像新开了个会话 / 跳回列表 / 还要点恢复按钮」的路径都是 bug**。

- **断连自愈下沉到 adapter owner 层**：`sdk-bridge.sendMessage` 内部检测 `!sessions.has(sessionId)` → 自动调 `recoverAndSend`：从 sessionRepo 拿 cwd / permissionMode → 单飞调 `createSession({resume,prompt,cwd,permissionMode})` 完整复用 H4/H1 护栏。renderer 端 `sendAdapterMessage` 不再判断「断连 vs 真错」，更不应该靠 `msg.includes('not found')` 这类字符串匹配触发恢复
- **单飞**：`recovering: Map<sessionId, Promise<void>>` 保证同 sessionId 并发 sendMessage 只起一次 createSession（避免起多个 SDK CLI 子进程 + 按次计费）；后续等待者拿到 inflight 完成后**重新走完整 sendMessage** 把它们的 text 正常 push（不要塞进同一个 createSession 的首条 prompt）
- **占位 message**：进入恢复立刻 emit 一条 `{kind:'message', text:'⚠ SDK 通道已断开，正在自动恢复…'}` 非 error 占位，让用户在 SDK fallback 期间（最长 30s）看到状态而非哑巴 busy；恢复失败时再补一条 `error: true` 的「⚠ 自动恢复失败：…」message
- **不要在 `recoverAndSend` 内自拼 emit/upsert/rename**：必须完整复用 `createSession`，让 `expectSdkSession(cwd) → claimAsSdk(opts.resume) → dedupOrClaim B 分支兜底 → waitForRealSessionId(_, _, opts.resume)` 全套护栏按原样跑。任何捷径都会重打开「两条 active record」bug
- **从 sessionRepo 补回 permissionMode**：用户上次主动选过的 `acceptEdits / plan / bypassPermissions` 必须复原，恢复路径不能默认 `default` 把用户辛苦切到的模式悄悄重置
- **内部 sessionId 切换**走 `sessionManager.renameSdkSession` + 子表整体迁移，不要 delete + new（仅 SDK fallback `tempKey→realId` 路径用；resume 路径下 sessionId 保持不变）
- **CLI 隐式 fork 两种边界兜底**：Claude Code CLI 在 SDK streaming input + resume + 新 prompt 下行为不可控，应用层必须双重兜底：
  - **第一种（软 fork，jsonl 在）**：CLI 给一个新 session_id（与官方 SDK 文档「forkSession=false 默认续同 ID」不符，实测铁证）。`sdk-bridge.consume` 内 first realId 拿到时若 `realId !== opts.resume` → `sessionManager.releaseSdkClaim(OLD_ID) + renameSdkSession(OLD_ID, realId)`，把 OLD_ID 的 DB record + 子表整体迁到 NEW_ID 名下
  - **第二种（hard fail，jsonl 不在）**：CLI `--resume <sid>` 找不到对应 jsonl 文件直接抛 "No conversation found"，consume 吞错只 emit message 不抛错，createSession 走 30s fallback 注册无 SDK 状态的占位 session。`recoverAndSend` **预检** jsonl 存在性（不依赖 SDK 错误字符串匹配），不在则走不带 resume 的新建 createSession + 事后手工 `renameSdkSession(OLD_ID, newRealId)` 把应用层 events / file_changes / summaries 子表迁到新 ID
- renderer 端 `historySession` 是本地 state（store 不知道）→ `App.tsx` 必须单独 listen `onSessionRenamed` 把 `historySession.id` 也切到 NEW_ID 否则死循环
- **detail 视图权威**：所有 detail 渲染的 record 必须以 `store.sessions` Map 为权威；本地临时 state（如 App.tsx 的 `historySession`）只在 Map 还没 upsert 的瞬间兜底，参考 `sessions.get(historySession.id) ?? historySession` 兜底链

### 总结调度（summarizer）

- 三层降级：LLM oneshot → 最近一条 assistant 文字 → 事件 kind 统计
- `eventsSince === 0` 时跳过；全局 `summaryMaxConcurrent`（默认 2），超出本轮等下次扫描
- LLM oneshot 失败要透传 stderr 给上层，方便定位（避免吞掉 ENOTDIR 等致命错）

### 主进程模块通信 / IPC 边界

- 模块单例通过 `setX` / `getX` 暴露（如 `getLifecycleScheduler()`），不要在 `ipc.ts` 直接 import 实例对象（循环依赖 / 时序问题）
- 跨进程事件统一走 `event-bus.ts` + `safeSend` 兜底 `isDestroyed`，不要直接调 `webContents.send`
- `ipc.ts` 的 `SettingsSet` handler 是**即改即生效**中转点：每加一个新设置项，必须在这里加分发逻辑，否则「能改但不生效」
- `shared/types.ts` 只允许标准库类型，不准 import Electron / Node API
- preload `window.api` 是强类型 facade；动态 channel 用 `window.electronIpc.invoke()` 兜底
- HMR 只动 renderer；改 main / preload **必须重启 dev**

### 资源清理 & TOCTOU 防线

- 任何 `try { await ... }` 链涉及「释放标记 / 清 Map / 注销 listener」的，**必须包 try/catch/finally**，失败路径也要清理
- 主进程读用户输入路径前**先 `realpath` 再校验白名单 + ext**（防 symlink TOCTOU 越权）
- `before-quit` listener 不是 promise-aware：异步清理必须 `event.preventDefault()` → 跑完 → `app.exit()`

### 弃用字段清理

- `settings-store.ts` 的 `REMOVED_KEYS` 数组：删字段后把名字加进来，每次启动会自动 `delete` 历史持久化的孤儿字段

### 毛玻璃 CSS 陷阱

- `.frosted-frame > *:not(.absolute):not(.fixed)` 强加 `position: relative` —— 不要去掉这条，但要排除 absolute / fixed，否则 dialog 会被拍回文档流被裁掉

---

## 反复反馈 / 同类问题 → 升级约定（最低操作指南）

用户给出纠正性 / 偏好性反馈，或 Coding Agent 在 review / 修 bug 时发现同类工程问题，记录到 `ref/conventions/` 的现有索引/相邻格式；有 project engineering skill 时可用它辅助。到达升级门槛时优先走 `agent-deck:simple-review` 做三态裁决；review skill 不可用时把证据和候选规则交给 user 确认。一次性请求和 trivial 观察不升级。

---

## 验证流程

改完代码：

```bash
pnpm typecheck       # 必跑
pnpm build           # 大改动跑
```

改 main / preload → **重启 dev**：

```bash
# kill 干净
lsof -ti:47821,5173 2>/dev/null | xargs -r kill -9
pkill -f "electron-vite dev" 2>/dev/null
pkill -f "Electron.app/Contents/MacOS/Electron" 2>/dev/null

# 重启（在仓库根目录跑）
pnpm dev
```

改 renderer → 等 HMR 自动推送，无需重启。

---

## 打包与本地安装（macOS）

每次想体验「装好的版本」或者验证 wrapper 能不能从 .app 找到 → 完整跑一遍：

```bash
# 0. 杀掉所有旧实例（必做；见下面规则清单）
pkill -f "Agent Deck.app/Contents/MacOS/Agent Deck" 2>/dev/null
pkill -f "Agent Deck Helper" 2>/dev/null

# 1. 出 dmg + .app（约 1 分钟）
rm -rf build/dist && pnpm dist

# 2. 覆盖安装到 /Applications（已有同名 .app 时必须先 rm，cp -R 不会清残留）
rm -rf "/Applications/Agent Deck.app"
cp -R "build/dist/mac-arm64/Agent Deck.app" /Applications/

# 3. ad-hoc 重签名（见下面规则清单）
codesign --force --deep --sign - "/Applications/Agent Deck.app"

# 4. 清掉 quarantine 属性
xattr -dr com.apple.quarantine "/Applications/Agent Deck.app"

# 5. 软链 wrapper 到 PATH（一次性）
ln -sf "/Applications/Agent Deck.app/Contents/Resources/bin/agent-deck" /usr/local/bin/agent-deck
```

### 打包配置规则

- **`mac.icon: "resources/icon.png"` 必须有**：`buildResources` 默认查 `resources/icons/` 多分辨率集，单文件需显式指定
- **`extraResources` 必须把 `resources/bin` 显式 copy 到 `bin`**：`buildResources` 不会被打进 .app
- **ad-hoc 重签必须做（第 3 步）**：electron-builder 跳过签名时 codesign Identifier 是 `Electron`，与 Info.plist 的 `com.agentdeck.app` 不一致，macOS 通知中心 / Gatekeeper 按 Identifier 注册会归错位
- **重装前必须 pkill 旧进程（第 0 步）**：macOS 复用同 bundle id 活进程，旧 main + 新 .app 资源错配，dynamic import 拿到的 chunk hash 对不上 → renderer 直接显示一坨 monaco 源码
- **SDK / codex native binary 必须 unpack**：直接 spawn `app.asar/...` 路径会 ENOTDIR，需要 `build.asarUnpack` + 主进程 `pathToClaudeCodeExecutable` / `codexPathOverride` 显式传 unpacked 路径
- **验证 wrapper 前必须 `unset ELECTRON_RUN_AS_NODE`**：Claude Code（以及任何 Electron 宿主）在跑工具调用时把 `ELECTRON_RUN_AS_NODE=1` 透到 child shell。设置后 `MacOS/Agent Deck` 二进制会切到「伪装成 Node」模式：`--version` 返回 `v20.18.3`（Electron 内置 Node 版本，**不是说包错了**），第一个非 self CLI 参数被当 entry script 解析。直接症状：`agent-deck new --cwd ... --prompt ...` 报 `Error: Cannot find module '<cwd>/new'`。**这不是打包 bug，是验证环境污染**——不要因此去改 wrapper / 打包配置。验证步骤前面加 `unset ELECTRON_RUN_AS_NODE` 即可；终端里直接跑通常没事（除非也是 Electron 启动的）
- **跑 vitest SQLite 真测前后必须保护 better-sqlite3 binding**（证据：CHANGELOG_42）：`pnpm exec vitest run src/main/store/__tests__/task-repo.test.ts` 在 `nvm use 20.18.3`（系统 Node 20）下能跑通，但 prebuild-install 会**直接覆盖** `build/Release/better_sqlite3.node` 为 Node 20 ABI 版（v115），把 Electron 33 用的 v130 binding 顶掉。结果下次启动 dev / 已装 .app 时报 `NODE_MODULE_VERSION 115 vs 130 ... ERR_DLOPEN_FAILED`，bootstrap 就挂。`pnpm postinstall` 看到 `.forge-meta` 标记「已 rebuild」会跳过，**修不了**——必须先清 npm 全局 prebuild cache + 删 build 目录强制重下：
  ```bash
  rm -f ~/.npm/_prebuilds/*better-sqlite3*
  rm -rf node_modules/.pnpm/better-sqlite3@11.10.0/node_modules/better-sqlite3/build
  zsh -i -l -c "pnpm postinstall"
  ```
  执行规则：(a) 默认走 task-repo.test.ts 顶部的 binding 自检 skip 守门（CI / 其他 Node 版本会自动跳过），不主动跑 SQLite 真测；(b) 真要本地实测时按上面三行清理脚本收尾，**别忘清缓存**——只 `pnpm postinstall` 不够，cache 命中又会拉错 ABI。

### 验证

```bash
unset ELECTRON_RUN_AS_NODE  # 必做：避免 Electron 二进制被切到 Node 伪装模式（详见上面规则清单）
"/Applications/Agent Deck.app/Contents/Resources/bin/agent-deck" new --cwd "$PWD" --prompt "ping"
# 应用拉起 / 已运行实例新建一条会话；wrapper 自动补 cwd 与 new 子命令
```
