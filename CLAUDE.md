# CLAUDE.md

> 给 Claude Code 在本仓库工作时的硬性约定。
>
> 通用约定（输出语言 / 运行时 / 决策对抗 / codex 模板）见 `~/.claude/CLAUDE.md`，本仓库的 `resources/claude-config/CLAUDE.md` 必须与之保持一致。本文件只放 **agent-deck 专属**约定。

## 仓库基础

- macOS 环境，包管理器用 pnpm
- Node.js 由 nvm 管理；项目要求 Node ≥ 18

---

## 改动后必做

### 1. 判断是否要更新 README.md

**README.md 是「功能总览」**：用户视角的能力清单。三个判断问题：

1. 新增 / 修改了**用户可见行为**？（UI 控件、设置项、快捷键、状态显示、提醒方式）→ 改对应章节
2. 改动了**文件结构 / 新建模块**？→ 改「项目结构」节
3. 改动了**启动方式 / 端口 / 依赖 / 验证步骤**？→ 改「开发与运行」节

纯 bug 修复 / 内部重构（不改用户感知）→ 不动 README.md，写到 reviews/ 或 changelog/。

### 2. 写 changelog 或 review（**必做，二选一**）

**边界**（CHANGELOG_16 重定义）：

| 类型 | 写到 | 例子 |
|---|---|---|
| **功能变更**（新功能 / 行为修改 / API / 依赖升级） | `changelog/` | 新建 PendingTab、升 SDK 0.2.118、加 `agent-deck new` |
| **Debug / 性能 / 安全 review**（不引入新功能，修问题或加固） | `reviews/` | REVIEW_1 的 8 处修复、TOCTOU、内存泄漏 |

#### `changelog/` 规则

- 文件名 `CHANGELOG_X.md`，X 递增整数。新建前 `ls changelog/` 找最大 X
- **小改动**（一两个文件、几十行同主题）→ 追加到最新 `CHANGELOG_X.md`
- **大改动**（多模块 / 上百行 / 新功能）→ 新建 `CHANGELOG_X+1.md`
- 每次改 `changelog/` 都要同步 `changelog/INDEX.md`（简表：`[CHANGELOG_X.md](CHANGELOG_X.md) | 一句话概要`）
- 单文件结构：标题 + 概要（2-3 行） + 变更内容（按模块 bullet）。**不要写"踩坑细节 / 推演过程"**——那些去 `reviews/`

#### `reviews/` 规则（命名跟 changelog 对齐）

- 文件名 `REVIEW_X.md`，X 递增整数。新建前 `ls reviews/` 找最大 X
- 每次 review 一个文件，结构：触发场景 + 方法（双对抗 Agent / 范围 / 工具）+ 三态裁决清单 + 修复条目
- 同步更新 `reviews/INDEX.md`（简表：`[REVIEW_X.md] | 主题 | 严重度分布 | 修复数`）
- 触发：周期性 debug / code review / 性能 audit / 安全审查 / 大重构前的健康检查

### 3. 改功能前先读 changelog + reviews

修改任何模块前，**先 `ls changelog/ reviews/` + 浏览相关条目**，了解历史决策、避免推翻已有约定 / 重复踩坑。设计取舍（"为什么 lifecycle 与 archived 正交"）通常在 changelog；过往 bug / 加固方案在 reviews。

---

## 项目特定约定（设计要点速查）

反复出现过的设计决定，改动前注意：

### 鉴权与会话边界

- 应用**不读不写**任何 API Key。所有 SDK 调用走本地 `~/.claude/.credentials.json`（OAuth）
- 间歇总结的 SDK oneshot 设 `settingSources: []`，避免 hook 回环到自己
- 应用内会话的 SDK 设 `settingSources: ['user', 'project', 'local']`，等价于在该 cwd 跑 `claude`

### 事件去重与生命周期

- `AgentEvent.source = 'sdk' | 'hook'`；SDK 接管的 sessionId 加入 `SessionManager.sdkOwned`，hook 同 id 事件被丢弃
- `lifecycle` (`active`/`dormant`/`closed`) 与 `archived_at` **正交**。归档只打标记，取消归档清标记回到原 lifecycle（不粗暴重置 dormant）。LifecycleScheduler 跳过 `archived_at IS NOT NULL`
- SessionManager.consumePendingSdkClaim 不准做"全局 fuzzy 匹配"（CHANGELOG_16 / REVIEW_1 修过）；cwd 别名靠 `normalizeCwd` 内的 `realpathSync`

### 会话恢复 / 断连 UX（resume 优先）

总纲：resume 必须保持同一会话身份 + detail 连续性。**凡让用户感觉「像新开了个会话 / 跳回列表 / 还要点恢复按钮」的路径都是 bug**。

- **断连自愈下沉到 adapter owner 层**：sdk-bridge.sendMessage 内部检测 `!sessions.has(sessionId)` → 自动调 `recoverAndSend`：从 sessionRepo 拿 cwd / permissionMode → 单飞调 `createSession({resume,prompt,cwd,permissionMode})` 完整复用 H4/H1 护栏。renderer 端 `sendAdapterMessage` 不再判断「断连 vs 真错」，更不应该靠 `msg.includes('not found')` 这类字符串匹配触发恢复（CHANGELOG_26 / B 方案）
- **单飞**：`recovering: Map<sessionId, Promise<void>>` 保证同 sessionId 并发 sendMessage 只起一次 createSession（避免起多个 SDK CLI 子进程 + Anthropic 按次计费）；后续等待者拿到 inflight 完成后**重新走完整 sendMessage** 把它们的 text 正常 push（不要塞进同一个 createSession 的首条 prompt）
- **占位 message**：进入恢复立刻 emit 一条 `{kind:'message', text:'⚠ SDK 通道已断开，正在自动恢复…'}` 非 error 占位，让用户在 SDK fallback 期间（最长 30s）看到状态而非哑巴 busy；恢复失败时再补一条 `error: true` 的「⚠ 自动恢复失败：…」message
- **不要在 recoverAndSend 内自拼 emit/upsert/rename**：必须完整复用 createSession，让 `expectSdkSession(cwd) → claimAsSdk(opts.resume) → dedupOrClaim B 分支兜底 → waitForRealSessionId(_, _, opts.resume)` 全套 REVIEW_5 H4/H1 护栏按原样跑。任何捷径都会重打开「两条 active record」bug
- **从 sessionRepo 补回 permissionMode**：用户上次主动选过的 `acceptEdits / plan / bypassPermissions` 必须复原，恢复路径不能默认 'default' 把用户辛苦切到的模式悄悄重置
- **内部 sessionId 切换**走 `sessionManager.renameSdkSession` + 子表整体迁移，不要 delete + new（仅 SDK fallback `tempKey→realId` 路径用；resume 路径下 sessionId 保持不变，sdk-bridge H4 / CHANGELOG_24）
- **CLI 隐式 fork 兜底**：Claude Code CLI 在 SDK streaming input + resume + 新 prompt 下**隐式 fork**，first session_id ≠ opts.resume，与 sdk.d.ts:1255-1258 文档「forkSession=false 默认续同 ID」不符（实测铁证 REVIEW_6 / CHANGELOG_27）。CLI native binary 内置行为应用层关不掉，sdk-bridge.consume 必须有 fork detection 分支 → `sessionManager.releaseSdkClaim(resumeId) + renameSdkSession(resumeId, realId)` 把 OLD_ID 的 DB record + 子表整体迁到 NEW_ID 名下，让历史"续上"NEW_ID。renderer 端 historySession 是本地 state（store 不知道）→ App.tsx 必须单独 listen `onSessionRenamed` 把 historySession.id 也切到 NEW_ID 否则死循环
- **detail 视图权威**：所有 detail 渲染的 record 必须以 `store.sessions` Map 为权威；本地临时 state（如 App.tsx 的 `historySession`）只在 Map 还没 upsert 的瞬间兜底，参考 `sessions.get(historySession.id) ?? historySession` 兜底链（CHANGELOG_25）

### 总结调度（summarizer）

- 三层降级：LLM oneshot → 最近一条 assistant 文字 → 事件 kind 统计
- `eventsSince === 0` 时跳过；全局 `summaryMaxConcurrent`（默认 2），超出本轮等下次扫描
- LLM oneshot 失败要透传 stderr 给上层（CHANGELOG_15 ENOTDIR 教训）

### 主进程模块通信 / IPC 边界

- 模块单例通过 `setX` / `getX` 暴露（如 `getLifecycleScheduler()`），不要在 ipc.ts 直接 import 实例对象（循环依赖 / 时序问题）
- 跨进程事件统一走 `event-bus.ts` + `safeSend` 兜底 `isDestroyed`，不要直接调 `webContents.send`
- `ipc.ts` 的 `SettingsSet` handler 是**即改即生效**中转点：每加一个新设置项，必须在这里加分发逻辑，否则「能改但不生效」
- `shared/types.ts` 只允许标准库类型，不准 import Electron / Node API
- preload `window.api` 是强类型 facade；动态 channel 用 `window.electronIpc.invoke()` 兜底
- HMR 只动 renderer；改 main / preload **必须重启 dev**

### 资源清理 & TOCTOU 防线

- 任何 `try { await ... }` 链涉及"释放标记 / 清 Map / 注销 listener"的，**必须包 try/catch/finally**，失败路径也要清理（CHANGELOG_16 / REVIEW_1：releasePending 漏掉的教训）
- 主进程读用户输入路径前**先 `realpath` 再校验白名单 + ext**（防 symlink TOCTOU 越权）
- `before-quit` listener 不是 promise-aware：异步清理必须 `event.preventDefault()` → 跑完 → `app.exit()`

### 弃用字段清理

- `settings-store.ts` 的 `REMOVED_KEYS` 数组：删字段后把名字加进来，每次启动会自动 `delete` 历史持久化的孤儿字段

### 毛玻璃 CSS 陷阱

- `.frosted-frame > *:not(.absolute):not(.fixed)` 强加 `position: relative` —— 不要去掉这条，但要排除 absolute/fixed，否则 dialog 会被拍回文档流被裁掉

---

## 反复反馈 / 反复踩坑 → 升级约定（自维护机制）

避免用户重复给同样反馈、避免 agent 重复栽相同坑：候选放 `.claude/conventions-tally.md`，count ≥ 3 升级到本文件。

### 两类候选（同一文件，分 section）

| 类型 | 触发条件 | 升级目的地 |
|---|---|---|
| **用户反馈** (`# 用户反馈候选`) | 用户给「纠正性 / 偏好性」反馈：「不要…」「应该…」「我已经说过…」「以后…」「记住…」「每次…」 | 「项目特定约定」最贴合的小节 |
| **Agent 踩坑** (`# Agent 踩坑候选`) | Coding Agent 在 review / 修 bug / 排查时**自己**发现踩了同类坑，或 review 报告里反复出现同类问题（典型：try/finally 漏 cleanup、TOCTOU、N+1 查询、async listener 不被 await） | 「项目特定约定」对应小节，或独立「资源清理 / 防御性编码」节 |

### 操作流程

1. 读 `.claude/conventions-tally.md`，找语义相近的已有条目
   - 找到 → `count` +1，更新 `last_at` 为今天日期
   - 没找到 → 新增条目（`count: 1`），写在对应 section
2. **count 到 3** → 这是「约定升级」决策，按通用 CLAUDE.md「决策对抗」节走**双对抗三态裁决**：
   - 起两个独立异构 Agent，各自评审升级提案：措辞是否准确 / 边界是否清晰 / 与已有约定有无冲突 / 升级到哪一节最合适
   - 三态结果汇总后告诉用户「这条 [反馈/踩坑] 累计 3 次，对抗审视结论 ✅/❌/⚠️ 如下，要升级吗？」
   - 用户确认后才写入「项目特定约定」相应小节，从 tally 删除该条目
3. count < 3 → 静默更新 tally，不打扰用户

### 边界

- **不计**一次性请求（"帮我改这个 bug"）
- **不计** trivial 反馈（"这里改个名字"）
- 用户反馈：必须是**工程偏好 / 设计取舍 / 工作流偏好**
- Agent 踩坑：必须是**模式化问题**（一类问题反复出现），不是单点 bug
- 30 天未更新且 count < 3 → 下次扫描可主动清理

> tally 是 Claude Code 的内部状态，**不要手工管理**。

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

每次想体验"装好的版本"或者验证 wrapper 能不能从 .app 找到 → 完整跑一遍：

```bash
# 0. 杀掉所有旧实例（必做！见下面踩坑清单）
pkill -f "Agent Deck.app/Contents/MacOS/Agent Deck" 2>/dev/null
pkill -f "Agent Deck Helper" 2>/dev/null

# 1. 出 dmg + .app（约 1 分钟）
rm -rf release && pnpm dist

# 2. 覆盖安装到 /Applications（已有同名 .app 时必须先 rm，cp -R 不会清残留）
rm -rf "/Applications/Agent Deck.app"
cp -R "release/mac-arm64/Agent Deck.app" /Applications/

# 3. ad-hoc 重签名（见下面踩坑清单）
codesign --force --deep --sign - "/Applications/Agent Deck.app"

# 4. 清掉 quarantine 属性
xattr -dr com.apple.quarantine "/Applications/Agent Deck.app"

# 5. 软链 wrapper 到 PATH（一次性）
ln -sf "/Applications/Agent Deck.app/Contents/Resources/bin/agent-deck" /usr/local/bin/agent-deck
```

### 打包配置已踩的坑（别再回退）

- **`mac.icon: "resources/icon.png"` 必须有**：`buildResources` 默认查 `resources/icons/` 多分辨率集，单文件需显式指定（CHANGELOG_9）
- **`extraResources` 必须把 `resources/bin` 显式 copy 到 `bin`**：`buildResources` 不会被打进 .app（CHANGELOG_9）
- **ad-hoc 重签必须做（第 3 步）**：electron-builder 跳过签名时 codesign Identifier 是 `Electron`，与 Info.plist 的 `com.agentdeck.app` 不一致，macOS 通知中心 / Gatekeeper 按 Identifier 注册会归错位（CHANGELOG_9）
- **重装前必须 pkill 旧进程（第 0 步）**：macOS 复用同 bundle id 活进程，旧 main + 新 .app 资源错配，dynamic import 拿到的 chunk hash 对不上 → renderer 直接显示一坨 monaco 源码（CHANGELOG_9）
- **SDK / codex native binary 必须 unpack**：直接 spawn `app.asar/...` 路径会 ENOTDIR，需要 `build.asarUnpack` + 主进程 `pathToClaudeCodeExecutable` / `codexPathOverride` 显式传 unpacked 路径（CHANGELOG_14 / CHANGELOG_15）

### 验证

```bash
"/Applications/Agent Deck.app/Contents/Resources/bin/agent-deck" new --cwd "$PWD" --prompt "ping"
# 应用拉起 / 已运行实例新建一条会话；wrapper 自动补 cwd 与 new 子命令
```
