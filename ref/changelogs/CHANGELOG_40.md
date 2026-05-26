# CHANGELOG_40: Agent Teams M3 — 实时 hook 事件 + 操控面板

## 概要

CHANGELOG_39 的 M2 让用户能从 fs 看到 team 成员与 task list；M3 把 Claude Code v2.1.32+ 实验特性的 3 个新 hook event（**TaskCreated** / **TaskCompleted** / **TeammateIdle**）接入应用，让 team 内活动从「事后翻 fs 文件」升级为「毫秒级实时事件流」。同时补两个体验缺口：(1) **「给 teammate 下指令」入口**——TeamDetail 内一个 textarea + 按钮，应用包装成 `Tell teammate <name>: <text>` 自动塞 lead session 的 sendMessage（in-process backend 下应用层无法直接对 teammate 发消息的折中方案）；(2) **force-cleanup 按钮**——兜底 Claude in-process backend cleanup 上游 bug（teammate `shutdown_approved` 后 config.members 不移除 → TeamDelete 永远拒绝），手动 `rm -rf ~/.claude/teams/<name>` 与 `~/.claude/tasks/<name>` 残留。

不做 CLI 版本检测：hook-installer 一并把 3 个新 event 注入到 `~/.claude/settings.json`，老版本 CLI 不识别会**静默忽略**（与 settings.json 不冲突），用户升级到 v2.1.32+ 后自动开始飞回——不增加额外配置开关 / 启动 gating，避免实验特性 schema 演进时多一道判断。

## 变更内容

### 共享类型 (`src/shared/types.ts`)

- `AgentEventKind` 加 `'team-task-created'` / `'team-task-completed'` / `'team-teammate-idle'`
- 新增 `TeamTaskPayload`（cwd / teamName / teammateName / taskId / description / assignee / dependsOn / status / **raw 全量原始 hook payload**）
- 新增 `TeamTeammateIdlePayload`（cwd / teamName / teammateName / lastTask / reason / raw）
- `TeamSnapshot` 加 `events: AgentEvent[]` 字段（最近 100 条 team-* event，TeamDetail 时间线用）

### IPC 通道 (`src/shared/ipc-channels.ts`)

- `IpcInvoke` 加 `TeamForceCleanup`

### Hook 注入 (`src/main/adapters/claude-code/hook-installer.ts`)

`HOOK_EVENTS` 数组加 `TaskCreated` / `TaskCompleted` / `TeammateIdle`。install / uninstall / status 自动覆盖（既有逻辑按数组遍历，零改动逻辑），settings.json 中以 `# agent-deck-hook` 标记识别本应用注入条目，**与用户原 hooks merge 而非 overwrite**（既有逻辑保留）。

### Hook 路由 (`src/main/adapters/claude-code/hook-routes.ts`)

加 3 条 `makeRoute`：`/hook/taskcreated` / `/hook/taskcompleted` / `/hook/teammateidle`（hook-installer 的 `buildCommand` 走 `event.toLowerCase()` 拼路径，对齐这 3 个新 endpoint）。

### Translate 层 (`src/main/adapters/claude-code/translate.ts`)

新增 3 个 translate 函数 + 1 个共享 `TeamHookPayload` 接口 + 2 个 picker helper（`pickDescription` / `pickDependsOn`）。**字段提取宽容**——schema 仍在演进，每个字段都按 `typeof === 'string'` / `Array.isArray` 守卫挑出来，缺失兜底 undefined；同时把整个 `p` 塞进 `payload.raw` 让 UI 能 fallback 显示完整 JSON。兼容字段名变体（agentType / agent_type、sessionId / session_id、status / state、depends_on / dependencies、teammate_name / agent_name 等）。

### SessionManager ingest (`src/main/session/manager.ts`)

`dedupOrClaim` 加 team-* event 早返：

```typescript
if (event.source === 'hook' && (event.kind === 'team-task-created' || ...)) {
  return { skip: false };
}
```

放在「sdkOwned dedup」之前——**lead session 是 SDK 接管的，所有 team-* hook event 都会被既有 hook+sdkOwned 守卫吞掉，M3 数据流整套失效**。team-* event 只来自 hook 通道（SDK 不 emit），保留它们对 SDK 通道双写不重复。后续 ensureRecord / persistEventRow / advanceState 走标准流程；`nextActivityState` 的 default 分支返回 current，team-* event 自然不推进 activity 状态。

### Event 查询 (`src/main/store/event-repo.ts`)

新增 `findTeamEvents(teamName, limit = 100)`：JOIN `events` 与 `sessions`（按 `team_name` 过滤）+ kind IN team-* → ts DESC LIMIT。一次 IPC 拉全 team 的活动流。

### Team-fs 改造 (`src/main/teams/team-fs.ts`)

- `getTeamSnapshot(name, sessions, events)` 函数签名加 `events` 参数 → 写入返回的 snapshot
- 新增 `forceCleanupTeam(name)`：path 校验后 `await fs.promises.rm(target, { recursive: true, force: true })` 删两个目录，返回实际删掉的路径列表
- import 加 `rm` from `node:fs/promises`

### IPC handler + Preload

- `main/ipc.ts`：`TeamGet` 内调 `eventRepo.findTeamEvents` 把 events 传给 `getTeamSnapshot`；新增 `TeamForceCleanup` handler，调 `forceCleanupTeam(teamName)` 返回 `{ removed: string[] }`
- `preload/index.ts`：加 `forceCleanupTeam(name)` wrapper

### Renderer TeamDetail (`src/renderer/components/TeamDetail.tsx`)

3 段新增 + 1 段改造：

- **「hook 事件流」section**：渲染 `snap.events`，每条用 `TeamEventRow` 子组件显示图标（➕/✅/💤）+ kind label + 按 payload 提取的 `teammate / desc / lastTask / reason` 文案 + 时间戳；空列表时显示「需要 v2.1.32+ + 安装 hook」提示
- **「给 teammate 下指令」section**：`SendToTeammate` 子组件，含 lead session 显示（`pickLeadSession` 按 lifecycle active > dormant > closed + lastEventAt 排序挑一个）+ teammate 名 input + members 名快速选择按钮列 + textarea + 发送按钮；提交时拼 `Tell teammate <name>: <text>` 调 `sendAdapterMessage`
- **「残留清理」section**：`ForceCleanupButton` 子组件，点击走 `confirmDialog`（destructive）+ 调 `forceCleanupTeam(name)` IPC + 显示删除结果 + 300ms 后调 `onCleaned`（=onBack）让 TeamHub 自动刷新
- **useEffect 监听 `onAgentEvent`**：team-* event 来时（且 sessionId 属于当前 team 的 sessions）触发 refresh —— hook-server 写 events 表后只 emit AgentEvent，不会触发 fs watch，必须独立 listener

## 已知限制

- **schema 演进风险**：3 个 hook event 是 v2.1.32+ 实验特性，payload 字段名可能调整。translate.ts 已宽容兜底（缺字段 undefined + raw 备查），但若关键字段（如 task.description）改名，TeamEventRow 渲染会显示「(no desc)」直到 translate 跟进
- **lead session 是猜测**：SendToTeammate 用 `pickLeadSession` 按 lifecycle 排序挑一个 SDK session 作为 lead 候选——一个 team 在 in-process 模式下应用层只看到 lead 一条 session，所以这通常是对的；但若用户用 archive / 多次 reactivate 制造了多条同 team session，可能挑错。M3 不做 lead 显式标记（hook payload 给的 session_id = lead）→ 后续可在 sessions 表加 `is_team_lead` 列改进
- **force-cleanup 不检测活跃 teammate**：用户得自己确认。M3 hook 接入后理论可以「最近 N 秒无 TeammateIdle 也无活动 → 视为可清理」，但这是 false negative 风险（TeammateIdle 可能本来就该 emit 但卡住没 emit），先让用户人工判断更稳
- **不做 CLI 版本 gating**：HOOK_EVENTS 数组直接加 3 个新 event，老版本 CLI 静默忽略；用户在 v2.1.32+ 之前看到的就是「hook 事件流空着」，UI 上有提示文案

## 验证

- `pnpm typecheck` 通过 ✅
- `pnpm build` 通过 ✅
- 重启 dev 后用户验证（前置：CLI ≥ v2.1.32 + 安装好 hook + agentTeamsEnabled = true）：
  1. 点设置面板「安装到 ~/.claude/settings.json」 → 检查 settings.json 含 9 个 hook event 注入（原 6 个 + TaskCreated / TaskCompleted / TeammateIdle）
  2. 跑一次 agent teams 测试（用 Step 2 的 prompt 让 Claude 建 team + spawn teammate + 完成 1 个 task）
  3. TeamHub 进 demo-team → TeamDetail「hook 事件流」section 应该出现 ➕ TaskCreated / ✅ TaskCompleted / 💤 TeammateIdle 条目（按 ts 倒序）
  4. 试「给 teammate 下指令」：填 teammate 名 + 一句话 → 发送 → lead session detail 应该看到 `Tell teammate X: ...` 这条 user message + Claude 转给 teammate 的反馈
  5. cleanup 卡住时点「强制清理 fs 残留」 → confirm → 删后 TeamHub 列表里该 team 自动消失
  6. 试 IPC 越权 `forceCleanupTeam('../../etc')` → 主进程 throw IpcInputError，不删盘

## M3 verify 实跑发现 + 后续修复

实际跑 verify（用户实跱）暴露了几个边界问题，全部已修。

### 1. Claude Code v2.1.32 lead 缺 TaskCreate 工具集

CLI 工具清单里**没有** `TaskCreate` / `TaskList` / `TaskUpdate`（虽然 TeamCreate 文档里提到了）；lead 只有 `TodoWrite`，但 TodoWrite 写到 session UUID 隔离的个人 todo store（`~/.claude/todos/<sid>/`），**与 team task list（`~/.claude/tasks/<team>/`）完全独立**，不触发 TaskCreated/TaskCompleted hook。**这是 Claude Code 实验特性的不完整**，agent-deck 应用层无法绕过。

应对：用 curl 直接 POST 到 hook-server endpoint 模拟 hook payload 验证应用层链路（translate + ingest + UI 渲染）通过——这是 component-level 验证，等 Claude Code 后续版本补 TaskTool 暴露给 lead 后**应用层 0 改动直接 work**。

```bash
# 模拟 TaskCreated（替换 token / lead_sid）
curl -sS -X POST http://127.0.0.1:47821/hook/taskcreated \
  -H "Authorization: Bearer <hook_token>" -H "Content-Type: application/json" \
  -H "X-Agent-Deck-Origin: cli" \
  -d '{"session_id":"<lead_sid>","cwd":"/x","team_name":"m3final","teammate_name":"echo-bot","task":{"id":"task-1","description":"...","status":"in_progress"}}'
```

应用层：translate.ts 字段提取 → ingest team-* 早返（manager.ts dedupOrClaim 早返路径）→ events 表持久化（event-repo 写入）→ TeamDetail「hook 事件流」section 渲染——四层全部 verified。

### 2. in-process backend cleanup bug 是间歇性的

之前测试报告说 in-process backend cleanup 永远卡住（greeter teammate `shutdown_approved` 后 config.members 不移除），但本次 verify 时 echo-bot 同条件（同 in-process / general-purpose）走完 `shutdown_approved` 后**自动从 members 数组移除**，TeamDelete 顺畅成功。说明这是 Claude Code 的**间歇性 bug 不是永久挂死**——**force-cleanup 按钮仍是必要兜底**（万一下次又卡住）。

### 3. force-cleanup 按钮 UX polish

`setTimeout(onCleaned, 300)` 太短 + 绿字色 `text-deck-muted/80` 10px 太淡，用户根本看不到「已删除 N 个目录」反馈就被 onBack 切走。改：

- 延时 300ms → 1200ms（让用户看清反馈）
- 绿字色 `text-status-working` 11px font-medium + ✓ 前缀
- 失败时 `text-status-waiting` 红色明确区分

### 4. C 方案：watcher unlinkDir → 自动 unset sessions.team_name

之前的设计：cleanup（无论 Claude 自然 cleanup 还是 force-cleanup）只清 fs，**不动 DB sessions.team_name** → cleanup 后 m3final 仍出现在 TeamHub（因为 distinctTeamNames 仍包含），用户困惑「明明删了为啥还在」。

C 方案：`team-watcher` 监听到 `~/.claude/teams/<name>/` 整个目录的 `unlinkDir` 事件 → main bootstrap eventBus listener 调用 `sessionRepo.clearTeamName(name)` 自动把该 team 名下所有 sessions 的 team_name 设 NULL → distinctTeamNames 不再返回该 name → TeamHub 自然移除；同时 emit session-upserted 让 SessionCard 的 team chip 也消失。**sessions 本身不删**，历史 tab 仍能找到。

具体改动：

- `session-repo.ts` 加 `clearTeamName(teamName): string[]`：先 SELECT 收集 affected ids，再 UPDATE SET NULL，返回 ids
- `main/index.ts` 桥接区改 `eventBus.on('team-data-changed', ...)` 加 unlinked 分支：调 clearTeamName + 遍历 affected ids emit session-upserted

行为：
- Claude TeamDelete 自然成功 → fs unlinkDir → 自动 unset → TeamHub 移除 ✅
- 用户 force-cleanup 按钮 → fs unlinkDir → 同上 ✅
- 外部 `rm -rf ~/.claude/teams/<name>/` → 同上 ✅

**C 方案盲区 + 后续修复**（实跑 verify 暴露）：

C 方案纯靠 chokidar `unlinkDir` 事件触发，对**「fs 早就被外部清干净，但应用 DB 还残留 team_name」**这种状态无效——典型场景：Claude 自然 cleanup 已经成功（fs 删了，但当时 watcher 还没装 unlinkDir 监听）/ 用户 dev 重启间隔有人 rm -rf 了 fs / 历史遗留状态。这种情况下 force-cleanup 调用时 fs 没东西可删，watcher 不触发任何事件，C 方案纯 watcher 路径漏掉。

修法：**`forceCleanupTeam` IPC handler 主动调 `sessionRepo.clearTeamName`**——不依赖 chokidar 事件路径。force-cleanup 按钮的语义本就是「让这个 team 彻底消失」，所以无论 fs 是否有东西可删，都主动 unset DB team_name + emit session-upserted。

具体改动：
- `main/ipc.ts` `TeamForceCleanup` handler：`forceCleanupTeam(name)` 之后**总是**调 `sessionRepo.clearTeamName(name)` + 遍历 affected emit session-upserted；返回值新增 `unsetSessions: number` 字段
- `preload/index.ts` `forceCleanupTeam` 返回类型同步加 `unsetSessions`
- `TeamDetail.tsx` ForceCleanupButton 显示 `已删除 N 个目录，解绑 M 个会话`（任一非 0 都有反馈）

修复后行为矩阵：

| 场景 | fs 删除 | DB 解绑 | TeamHub 移除 |
|---|---|---|---|
| Claude 自然 cleanup（watcher 在监听） | unlinkDir 触发 | C 方案路径自动 unset | ✅ |
| 用户 force-cleanup（fs 还有内容） | rm -rf 删 + unlinkDir 触发 | IPC 主动 unset + C 方案重复 unset（幂等无副作用） | ✅ |
| 用户 force-cleanup（fs 早就空 / DB 残留） | rm 没东西删 → unsetSessions > 0 | **IPC 主动 unset 兜底** ✅ | ✅ |
| 外部 rm -rf（watcher 在监听） | unlinkDir 触发 | C 方案路径自动 unset | ✅ |

### 5. ensureWithinRoot symlink 边界两次修复（详见 CHANGELOG_39 后续修复段）

M3 verify 时暴露 M2 写的 ensureWithinRoot 不够 robust：
- 单边 realpath 不一致 → ~/.claude → ~/.claude-default symlink 链下误报越权
- 修第一次后又踩 target 不存在路径下回退到 resolved 与 root realpath 形态不对称的边界
- 最终修法：target 存在用两边 realpath；target 不存在用两边 resolve（同形态对齐）

### 6. M1 引入的 SQLite placeholder bug（详见 CHANGELOG_35 后续修复段）

session-repo `rename()` 的 INSERT 多算了 1 个 `?`（13 列对 14 placeholder），普通 upsert 路径不触发，CLI 隐式 fork rename 时才挂掉。M3 verify 期间 SDK fallback 路径触发了，已补回 13/13/13 对齐。

## 收口判定（M3 完整 verified ✅）

| 维度 | 状态 |
|---|---|
| M3 hook 接入应用层链路 | ✅（TeammateIdle 真实端到端 + TaskCreated/TaskCompleted curl 模拟全验证 translate→ingest→UI） |
| Claude 实际触发 Task* hook | ❌ 上游限制（v2.1.32 lead 没 TaskTool 暴露），等 future CLI 自动 work |
| SendMessage 工具可用 | ✅（teammate alive 时） |
| force-cleanup 按钮（包括 UX polish） | ✅ |
| Claude 自然 cleanup（间歇性可成功） | ✅ |
| C 方案 unlinkDir 自动 unset | ✅ TeamHub 不再残留 cleanup 后的空 team |
