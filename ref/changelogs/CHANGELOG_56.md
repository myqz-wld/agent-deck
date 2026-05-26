# CHANGELOG_56: TeamDetail 结构化 tasks UI + Teammate 权限 auto-approve

## 概要

两件事一份 PR（用户拍板「A 先 B 后一份 PR」）。

**A — 结构化 tasks UI 接入 + 事件流补条目**（CHANGELOG_43 task store 缺最后一环 renderer 消费）：TeamDetail 加新 section 「结构化 tasks (mcp)」 实时显示 SQLite tasks 表（订阅 onTaskChanged 重拉）；mcp `task_create / task_update(→completed)` handler 同步 ingest `team-task-created/completed` AgentEvent 到 events 表，让 TeamDetail「hook 事件流」section 也能显示 mcp 操作（与 CLI 内置 TaskCreated/TaskCompleted hook 走同 kind 同视图）。

**B — Teammate 权限 auto-approve**：Agent Teams in-process backend 的 teammate 调工具走 inbox 协议（`~/.claude/teams/<X>/inboxes/team-lead.json`），**不会**回到 lead 的 SDK canUseTool（CHANGELOG_45 第一句铁证），所以 lead 的 `permissionMode` / `READ_ONLY_TOOLS` 白名单 / settings.json `permissions.allow` 在 teammate 这边全失效，每个工具调用都从 inbox 文件转一圈到 UI 弹给用户。新增设置项 `autoApproveTeammateMode: 'off' | 'read-only' | 'follow-lead'`（默认 `'read-only'`），inbox-watcher 检测到 `permission_request` 时按档位主动写 inbox response allow 跳过 UI 弹框。

## A 变更内容

### 共享 IPC 通道 (`src/shared/ipc-channels.ts`)
- `IpcInvoke.TaskListByTeam: 'task:list-by-team'` 新增

### 主进程 IPC handler (`src/main/ipc/teams.ts`)
- `TaskListByTeam` handler：调 `taskRepo.list({teamName, limit: 200})` 返回 `{tasks}`；显式 throw `IpcInputError` 当 `parseTeamName` 返回 null（避免污染走 `task-repo.ts:237-238` 的「仅查全局任务」语义）

### Preload facade (`src/preload/index.ts`)
- `listTeamTasks(name)` 暴露

### Renderer TeamDetail (`src/renderer/components/TeamDetail/`)
- 新增 `McpTasksSection.tsx`（5 状态 chip + activeForm 紫色 chip + labels 灰 chip + description 折叠 + updatedAt + ID 短显示）
- `index.tsx` 在「共享 task list」与「hook 事件流」之间插入 `<McpTasksSection name={name} />`
- 订阅 `onTaskChanged` 后 filter `e.teamName === name` 整体重拉（与既有 onAgentEvent 同款不 debounce）

### A3 mcp ingest AgentEvent（事件流补条目）

#### `src/main/task-manager/tools.ts`
- `buildTaskTools(repo, teamNameProvider, sessionIdProvider?)` 加第三参数 lazy session id 工厂
- `task_create` handler 成功后 ingest `team-task-created` AgentEvent（agentId='claude-code', source='sdk'，复用既有 kind 不动 `findTeamEvents` SQL / TeamEventRow / 类型定义）
- `task_update` handler 仅当 status 从非 completed 变成 completed 时 ingest `team-task-completed`（避免每次属性 update 都污染事件流）
- `task_delete` 不 ingest（既有 kind 集无 deleted 语义；强行复用 created 会让事件流误显示「又创建了一次」）
- sid=null 时跳过 ingest（不抛错，与 teamNameProvider 「lead 还没建 team」窗口宽容策略一致）

#### `src/main/task-manager/server.ts`
- `getTasksMcpServerForSession(teamNameProvider, sessionIdProvider?)` 加第二参数透传

#### `src/main/adapters/claude-code/sdk-bridge/index.ts`
- 调用点加第二参数 `() => internal.realSessionId ?? tempKey`（与 teamNameProvider 同款 lazy）

#### `src/main/task-manager/__tests__/tools.test.ts`
- mock `@main/session/manager` 的 `sessionManager.ingest`
- 加 `buildToolsWithSession` helper（注入 sessionId）
- 新 describe `A3 sessionIdProvider → ingest team-task-* AgentEvent`：9 个 case 覆盖决策矩阵（create / update→completed / update 改 priority 不 ingest / update active 不 ingest / delete 不 ingest / sid=null 不 ingest / 不传 provider 向后兼容 / 写权限拒不 ingest）；total 37 → 37 case（既有 28 + 新 9 + 0 修改既有 = 37）

## B 变更内容

### B1 共享白名单常量 (`src/shared/constants/read-only-tools.ts` 新增)
- `READ_ONLY_TOOLS: ReadonlySet<string>`（搬自 `sdk-bridge/constants.ts`，8 个工具）
- `EDIT_TOOLS: ReadonlySet<string> = new Set(['Edit','Write','MultiEdit','NotebookEdit'])`（follow-lead acceptEdits 档用）
- helper `isTaskMcpTool(name)` / `isImageReadTool(name)` —— image read 直接复用 `IMAGE_TOOL_SUFFIXES[0]` 避免双处字面量漂移
- `sdk-bridge/constants.ts` 改 re-export 保持向后兼容（can-use-tool.ts import 路径不变）
- shared 文件零 import Node/Electron API，符合 `shared/types.ts:5` 边界

### B2 设置项 (`src/shared/types/settings.ts` + `src/main/store/settings-store.ts` + `src/main/ipc/settings.ts`)
- `AppSettings.autoApproveTeammateMode: 'off' | 'read-only' | 'follow-lead'`（默认 `'read-only'`）
- `_helpers.ts` 加 `parseAutoApproveTeammateMode` 白名单校验 helper
- `SettingsSet` handler 加分支：null / 非白名单 → throw / 兜底回默认 `'read-only'`
- **不需要 apply 函数**：inbox-watcher 每次 processInboxFile 都从 `settingsStore.get('autoApproveTeammateMode')` 读 current 值（运行时即时生效，与 sandbox 「下次新建会话生效」语义不同）

### B3 决策逻辑 (`src/main/teams/auto-approve.ts` 新增)
- `shouldAutoApprove(toolName, mode, leadPermissionMode) → AutoApproveDecision` 纯函数
  - `mode='off'` → 永不
  - read-only / follow-lead 都先过 read-only 白名单（READ_ONLY_TOOLS / __ImageRead / mcp__tasks__*）
  - follow-lead + lead bypassPermissions → 全放行
  - follow-lead + lead acceptEdits + 命中 EDIT_TOOLS → 放行
  - 其他 → fallback（read-only 档不在白名单的工具 / follow-lead 档但 lead default/plan/null）
- `lookupLeadPermissionMode(teamName) → Promise<PermissionMode | null>` 三级回退（reviewer-claude MED 修复）：
  1. 优先 `team-fs.readTeamConfig(teamName).raw.leadSessionId`（fs SSOT，CHANGELOG_46 已确立）
  2. 退化 `sessionRepo.findByTeamName(teamName)` 过滤 source='sdk' 取 lastEventAt 最新（不过滤 lifecycle / archivedAt，「lead 离线但 teammate 还在跑」是合理边界）
  3. 都没找到 → null（→ shouldAutoApprove 走 `follow-lead-fallback` 降级 read-only）
- 任何 IO / parse 失败一律 swallow 到 console.warn，inbox-watcher 调用方 hot path 不能因为读 config 失败炸链

### B4 inbox-watcher 接入 (`src/main/teams/inbox-watcher.ts`)
- `processInboxFile` 在 `if (sub.type === 'permission_request')` 分支内、原 `entryRef.seenRequestIds.add(req.request_id)` 之后、`activePermissions.set(...)` 之前插入 auto-approve 判断
- **关键护栏**（reviewer 双对抗 4 处 HIGH/MED 修复）：
  - **同步 `seenRequestIds.add` 在前**：dedup 真正护栏，防 await lookupLeadPermissionMode / appendInboxMessage 期间另一波 file change 重入又走一次 try（reviewer-codex MED）
  - **嵌套 try/catch 区分 append-fail vs emit-fail**（reviewer-claude HIGH + reviewer-codex HIGH）：
    - append 失败 → 回滚 `seenRequestIds.delete` + 设 `activePermissions` + emit `team-permission-requested` 走 UI 兜底（避免「auto-approve 静默失败 + lead inbox 不再变化」死锁——chokidar 不会因 teammate inbox 写失败而 fire processInboxFile）
    - append 成功 → dedup 必须保留（绝不能 delete）；emit `team-permission-resolved` 抛错只 warn，不回滚——否则下次 lead inbox change 重读 entries 会让该 entry 再走一遍 try → 重复 append 双 response
  - 不写 `activePermissions` Map（成功路径）：该 Map 用于 idle_notification cancel pending，已 resolved 没什么可 cancel
  - `slugifyMemberName(fromAgentId)`：fromAgentId 可能含特殊字符必须 slugify
- `fromAgentId='team-lead'` 是 inbox 协议常量，与 IPC TeamRespondPermission handler (ipc/teams.ts:142) 同款，CLI 端默认接受此 from（CHANGELOG_45 实测）
- console.log 输出 `[inbox-watcher] auto-approve <toolName> for <agentId> (<reason>, leadMode=<mode>)` 让用户在 main 终端看到决策轨迹（reviewer-codex LOW 修复 follow-lead-fallback 静默降级）

### B5 SettingsDialog UI (`src/renderer/components/SettingsDialog.tsx`)
- 在 Agent Teams toggle 下方加三档 select 行（与 claudeCodeSandbox 同款 select 模板）
- 加灰色注释行说明三档语义 + 「运行时即时生效」与 sandbox 「下次新建会话生效」对比

## 文档同步

- `CLAUDE.md`「项目特定约定」节加「Teammate 权限边界」小节
- 本 changelog + INDEX.md 索引

## 验证

- `pnpm typecheck` 通过
- `pnpm exec vitest run` 全过：189 passed | 26 skipped (215 total) —— 26 skipped 是 task-repo SQLite binding 不可用的合规 skip
- 手测：默认 read-only 档 spawn teammate 调 Read 不弹（log `read-only-whitelist`）；切 follow-lead + lead bypassPermissions 调 Bash 不弹（log `follow-lead-bypass`）；切 off 全弹

## 关联 review

- 实施前走双异构对抗 review（reviewer-claude Opus 4.7 + reviewer-codex gpt-5.5 xhigh），4 个 HIGH/MED 修法落地（详见 plan「HIGH 修复确认」段）：
  1. `settingsStore.get('autoApproveTeammateMode')` 必传 key（`get(key)` 强签名 `settings-store.ts:9`）
  2. A1 IPC handler 显式 throw IpcInputError（防 `taskRepo.list({teamName: null})` 走全局任务语义）
  3. B4 catch 嵌套 + append 失败 emit UI 兜底 + append 成功 emit 抛错不回滚 dedup
  4. B3 lookupLeadPermissionMode 优先 fs SSOT (config.json.leadSessionId)
- LOW polish：isImageReadTool 复用 IMAGE_TOOL_SUFFIXES[0] 不二重定义字面量；archived lead 边界文档化；fromAgentId 协议常量加注释；follow-lead-fallback 加 console.log

## 备注

- **不动文件**：`task-repo.ts` / `event-repo.ts` / `event-bus.ts` / `inbox-protocol.ts` / `~/.claude/tasks/` 与 `~/.claude/teams/` fs（严守 team-fs.ts「应用绝对不写」）
- **N+1 IPC 不 debounce**：与 TeamDetail 既有 onAgentEvent listener 同款，常规批量（≤ 10 条）无感；agent 一次性 100 条边界场景未来按需加 30ms leading debounce（reviewer 双方 LOW 标已知行为）
- **chokidar handler 早退保护**：`appendInboxMessage` 写到 teammate inbox（`<team>/inboxes/teammate-A.json`）的事件被 inbox-watcher handler 第一行 `if (filepath !== expectedLeadInbox) return`（`inbox-watcher.ts:118`）早退，不会触发 processInboxFile 重入；但 lead inbox 后续被写时 entries 数组会重读，所以 dedup 必须正确保留
