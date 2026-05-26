# CHANGELOG_48: fs watcher symlink path mismatch fix + Agent Teams 权限审批 UX 三件套

## 概要

CHANGELOG_45 inbox-watcher 落地后实测 PendingTab 在用户 `~/.claude → .claude-default` symlink 环境下**完全不弹** teammate 审批表单。debug 链路自下而上排查（DB events 表 + 现场制造测试 entry），最终静态 audit 锁定 chokidar 在 macOS fsevents 下回 handler 的 `filepath` 是 realpath 化路径，与代码里 raw symlink path 严格 `!==` 比较永远 true → handle 永远 early return → emit 永远不 fire。同根因牵连 inbox-watcher / team-coordinator / team-watcher 三处 fs 通道**全静默失效**。详见 [REVIEW_16](../reviews/REVIEW_16.md)。

修完 fs watcher 后顺手做 Agent Teams 权限审批 UX 三件配套（用户提出 + 验证）：① systemPrompt 硬约束 lead 不插手 teammate 权限协议 ② teammate idle 触发 pending permission cancel 通路（emit team-permission-cancelled + activity-feed 标灰）③ PendingTab 上 TeamPermissionRow 整体可点击跳转 lead session detail（参考 session header 同款 onOpenSession）。

## 变更内容

### fs watcher symlink path mismatch fix（HIGH，独立 review）

#### `src/main/teams/inbox-watcher.ts:19-21,66-77`

`import { existsSync, mkdirSync, realpathSync } from 'node:fs'` + subscribe 入口先 `mkdirSync(inboxesDirRaw, { recursive: true })` 兜底（首次 subscribe 时 inboxes/ 可能还不存在），后 `realpathSync(inboxesDirRaw)` 缓存 `inboxesDir` + cache `expectedLeadInbox = join(inboxesDir, 'team-lead.json')`；handle / unlink 内部直接用 cached `expectedLeadInbox` 比较（不再每次重新调 `getInboxPath`）；删除现已不用的 `getInboxPath` import。

#### `src/main/teams/team-coordinator.ts:31,46-52,77-103,108-122`

`import { existsSync, realpathSync } from 'node:fs'` + class 加 `private realRoot: string | null = null` 字段（startFsWatcher 时缓存）+ `processConfigFile` 用 `this.realRoot ?? getTeamsRoot()` 做 startsWith / slice 前缀比对。

#### `src/main/teams/team-watcher.ts:21,69-77`

`import { existsSync, realpathSync } from 'node:fs'` + subscribe 入口 `teamsRootReal = existsSync(getTeamsRoot()) ? realpathSync(...) : ...` 同模式 + `teamDir = join(teamsRootReal, name)` / `tasksDir = join(tasksRootReal, name)`；`dispatchByPath(p)` 内 `p === teamDir / startsWith(teamDir + '/')` 比较自然匹配 chokidar 给的 realpath。

#### 设计原则

不改 `getInboxesRoot()` / `getTeamsRoot()` 的语义（避免动 `appendInboxMessage` 写文件路径与 log 显示语义），只在 fs watcher subscribe 入口做最小侵入 realpath 化（~30 行 diff）。

### #1 — systemPrompt 硬约束 lead 不插手 teammate 权限协议

#### `~/.claude/CLAUDE.md` + `resources/claude-config/CLAUDE.md` 决策对抗节后新增 `## Agent Teams`

精简到 1 个段落：「chat 里看到 stringified JSON 含 `type='permission_request'`（CLI 把 inbox 协议消息当 user message 推给你）：别 SendMessage 劝 teammate 放弃 / 改方法 / abort，也别 SendMessage 回 `permission_response`（协议只支持 `shutdown / plan_approval`）。等真人在宿主 PendingTab 批，期间做其他不依赖该 teammate 该 tool call 的工作。」

实证生效：events 43839/43840/43842/43843 lead chat 双重 thinking + message 实证「**按约定不 SendMessage 劝阻、stick to the agreement**」+ teammate idle 后 lead 主动停手等真人决策。

### #2 — teammate idle 触发 pending permission cancel 通路

#### `src/shared/types.ts` + `src/main/event-bus.ts`

新增 `TeamPermissionCancelled` payload type（reason: 'teammate-idle' / 'teammate-shutdown' / 'unknown'）+ event-bus 加 `'team-permission-cancelled'` event。

#### `src/main/teams/inbox-protocol.ts`

新增 `IdleNotificationSubMessage` type（实证 reviewer-codex 完成 Round 1 后写到 team-lead.json 的 entry：`{type:'idle_notification', from:'reviewer-codex', timestamp}`）+ parseSubMessage 加分支。

#### `src/main/teams/inbox-watcher.ts`

`Entry` 加 `activePermissions: Map<requestId, {fromAgentId, payload}>` 跟踪当前 pending；`processInboxFile` 改双遍扫：第一遍识别新 permission_request → emit + 加 active map；第二遍识别 idle_notification → 找该 teammate 名下所有 active permission emit `team-permission-cancelled`（reason='teammate-idle'）+ 从 active map 删；`markResponded` 同步删 active 防 cancel 误算已响应。

#### `src/main/adapters/claude-code/translate.ts` + `src/main/index.ts:217-235`

新增 `translateTeamPermissionCancelled`（kind='waiting-for-user' + payload type='team-permission-cancelled'）；main bridge 加 `eventBus.on('team-permission-cancelled', ...)`：① safeSend `IpcEvent.TeamPermissionResolved` 复用通道清 pending（payload schema 兼容）② sessionManager.ingest cancelled AgentEvent 让 activity-feed 留 cancelled marker。

#### `src/renderer/stores/session-store.ts`

新增 `isTeamPermissionCancelled` type guard + pushEvent reducer 分支从 `pendingTeamPermissionsBySession` 删该 requestId（recentEvents 保留 cancelled event 让 activity-feed 标灰）。

### #2 配套 — lead session detail 也展示 teammate 权限审批

#### `src/renderer/components/activity-feed/index.tsx`

加 `pendingTeamPermissions` selector + `pendingTeamPermIds` / `cancelledTeamPermIds` Set + RowProps 加对应字段 + dispatch 分支 `type === 'team-permission-request'` → 渲染 `TeamPermissionRow`（pending-rows 现有组件复用）。activity-feed 端 row 不传 `onJump`（自身已在 lead session detail 里）。

#### `src/renderer/components/pending-rows/index.tsx` `TeamPermissionRow`

加 `wasCancelled?: boolean` prop，三态 cardClass / statusText / statusColor：等待中（橙）/ 已被 teammate 取消（idle，灰）/ 已响应（绿淡）。

### #3 — PendingTab 上 TeamPermissionRow 点击跳转 lead session detail

#### `src/renderer/components/pending-rows/index.tsx` `TeamPermissionRow`

加 `onJump?: () => void` prop；`<li>` 加 `onClick={onJump ? () => onJump() : undefined}` + `cursor-pointer hover:bg-white/[0.04]`（仅 onJump 传入时才生效）；按钮组外层 `onClick={(e) => e.stopPropagation()}` 防点击允许 / 拒绝时误触跳转。

#### `src/renderer/components/PendingTab.tsx:298`

`<TeamPermissionRow>` 渲染处加 `onJump={() => onOpenSession(session.id)}`，参考同文件 line 176 session header `onClick` 同款语义。

### 关联

- [REVIEW_16](../reviews/REVIEW_16.md)：fs watcher symlink path mismatch 完整诊断 + 三态裁决 + Agent 踩坑沉淀（候选 P22 进 tally）

## 验证

- `pnpm typecheck` ✅
- 现场注入 fake permission_request → events 表多 row payload `team-permission-request`（id 43837 实证）
- 现场注入 idle_notification → events 表多 row payload `team-permission-cancelled` reason `teammate-idle`（id 43846 实证）
- main 终端 log fs watcher path 已 realpath 化为 `.claude-default`
- lead chat 实证不主动 SendMessage 劝 teammate 放弃（events 43839-43844）
