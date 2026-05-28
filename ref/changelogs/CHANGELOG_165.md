# CHANGELOG_165 — personal task 不再 ingest team-task-* event + ActivityFeed 渲染补全 + dedupOrClaim 早返修订

## 概要

修 personal task 完成 / 创建在 SessionDetail ActivityFeed 与 TeamDetail EventsSection 喷出 `team-task-completed` / `team-task-created` 噪声的 design bug —— kind 名带「team」字与 personal task 语义不符(v024 plan 把 personal task 升为 first-class default 后,caller 跑自己 todo 仍喷一条「team-*」事件进事件流是噪声)。同时补全 ActivityFeed 对这家族 3 个 kind 的 SimpleRow 渲染(原走 default 只显示 `e.kind` 字符串没 description / teamName),并修订 `dedupOrClaim` 早返条件已与 CHANGELOG_56 §A 设计漂移的 jsdoc + source 限定。

## 行为契约变更

**`mcp__agent-deck__task_create` / `task_update`(status→completed) handler**:

| 之前 | 现在 |
|---|---|
| in-process transport + personal task(`teamId IS NULL`) → ingest `team-task-created` / `team-task-completed`(payload.teamName=null) | in-process transport + personal task → **skip ingest**(eventBus.emit('task-changed') 仍发) |
| in-process transport + team-bound task → ingest(payload.teamName=lookup) | 不变 |
| HTTP / stdio transport → skip ingest(D7) | 不变 |

**影响**:UI TasksSection / `task_list` / onTaskChanged 实时性不丢(eventBus 路径独立未受影响);events 表中 personal task 不再有 `team-task-*` row,SessionDetail ActivityFeed / TeamDetail EventsSection 不再出现「team-task-* @ <personal-task>」噪声行。**历史 events 表内已存在的 personal `team-task-*` row 不删**(走 a 方案 — 删历史不可逆,旧 SessionDetail 仍显示但新增不再有,随时间过时)。

## 变更内容

### Handler (源头守卫)
- `src/main/agent-deck-mcp/tools/handlers/task-update.ts:82-103` — `becameCompleted` 守卫加第四条件 `updated.teamId`(personal task `teamId IS NULL` skip ingest);`teamName` 直接 `agentDeckTeamRepo.get(updated.teamId)?.name`(原 ternary 删因守卫已 narrow)
- `src/main/agent-deck-mcp/tools/handlers/task-create.ts:72-95` — 对称加 `args.team_id` 守卫(truthy check 覆盖 null/undefined);`teamName` lookup 同款简化

### dedupOrClaim 早返修订
- `src/main/session/manager-ingest-pipeline.ts:83-102` — 早返条件去掉 `event.source === 'hook'` 限定(原 CHANGELOG_40 注释「SDK 通道不 emit 这些 kind」已与 CHANGELOG_56 §A 漂移 — sdk 源也 ingest team-task-*),仅按 kind 早返让 hook 源 + sdk 源都走早返不依赖兜底 5 段
- jsdoc 重写明示双源(hook from CLI builtin / sdk from mcp tool ingest)+ 现状说明(grep 0 处 source='hook' 的 team-task-* ingest 来源,保留兜底以备未来恢复)

### ActivityFeed SimpleRow 渲染补全
- `src/renderer/components/activity-feed/describe.ts:33-58` — 加 3 个 case:
  - `team-task-created` → `📌 新 task · <description>${teammateName ? ` (${teammateName})` : ''}${teamName ? ` @ <teamName>` : ''}`
  - `team-task-completed` → `✓ task 完成 · <description>${teammateName ? ` (${teammateName})` : ''}${teamName ? ` @ <teamName>` : ''}`
  - `team-teammate-idle` → `💤 队友空闲${teammateName ? ` · <teammateName>` : ''}${reason ? ` (<reason>)` : ''}`
- payload schema 兼容 CHANGELOG_40 §共享类型 `TeamTaskPayload` / `TeamTeammateIdlePayload`;handler 现仅 emit 子集时(`{teamName, taskId, description, assignee}`),`teammateName` / `reason` 缺失 graceful degrade

### 测试
- `src/main/agent-deck-mcp/__tests__/task-events.test.ts`:
  - L134 「personal task → ingest teamName=null」**反向**为「→ CHANGELOG_165 skip ingest」(`expect(ingest).not.toHaveBeenCalled()`)
  - L177 「personal pending→completed → ingest teamName=null」同款反向
  - L165 HTTP transport task_create fixture 改 `team_id: 'team-1'` team task(纯证 D7 transport 守卫,personal 已被新守卫吞无法纯证)
  - L247 HTTP transport task_update fixture 同款改 team task
- `src/main/agent-deck-mcp/__tests__/task-crud.test.ts`:
  - L142 「不传 team_id → ingest team-task-created(teamName=null)」反向为「→ skip ingest」
  - L237 「HTTP transport personal skip ingest」fixture 改 team task(纯证 D7)

## 验证

`pnpm typecheck` 0 error。test 改造仅契约反向 + fixture 收紧,未新增 testcase(原 covered 的 personal-ingest path 反向证 skip 即可)。

## 与历史关系

- CHANGELOG_40 引入 `team-task-*` AgentEventKind + CLI builtin hook 路径(M3 Agent Teams 数据流)
- CHANGELOG_56 §A 落地 mcp `task_create / task_update` handler ingest 这些 kind,与 hook 走同 kind 同视图
- v023 + v024 plan(2026-05-21 / 2026-05-25)让 personal task 成为 first-class default,但**没**重新评估 CHANGELOG_56 ingest 路径与 personal task 的语义匹配 — 本 CHANGELOG 补这个 design gap
- 同时本 CHANGELOG 修了 CHANGELOG_56 没补的 H1(describe.ts 缺 case,handler 写的 payload 没人渲染) + H2(dedupOrClaim 早返注释 + 条件与现实漂移)
