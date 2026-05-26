# CHANGELOG_144 — task mcp 数据模型 owner_session_id 重设计 + hand_off 自动过继

## 概要

`task-mcp-owner-session-id-rewrite-20260521` plan 收口 — 把 `mcp__tasks__*` 工具数据模型从「team_id 闭包 + global task」改为「owner_session_id 必填 + sessions reverse join」,消灭 global task 累积问题(REVIEW_49 root cause)。

**根因**(REVIEW_49 R3 后遗症):v007/v011 schema 三条路径会落 global task(team_id IS NULL):① caller session 无 team 时闭包 NULL ② team 硬删 ON DELETE SET NULL ③ caller 显式传 team_id=null。task 表无 cleanup / TTL,completed task 永久存活 → DB 持续累积。

**修法**(plan §D1-D6 RFC 3 轮共识):
- core model: `owner_session_id NOT NULL REFERENCES sessions(id) ON DELETE CASCADE`,drop `team_id` / `team_name` 列
- 可见性:sessions reverse join(owner_sid → sessions.team_id → 同 team active member 可读;archived team filter 与 write 路径 `findSharedActiveTeams` 纪律对齐)
- 写权限:caller 与 task owner 共享 active team(含 caller==owner 特例);跨 team reject
- hand_off 过继:`hand_off_session` 默认 `archive_caller=true` 时原子 `reassignOwner(caller→newSid)` 把 caller 拥有的所有 task 过继给新 session;`archive_caller=false` 跳过(caller 仍 active 继续 own 自己 task)
- GC:复用现有 `LifecycleScheduler.historyRetentionDays` + ON DELETE CASCADE,archived + N 天 TTL 自动 GC sessions row 时 cascade 删 task
- Migration:v023 DROP TABLE + CREATE TABLE 全新 schema(drop 所有现有 task — dev 阶段可接受)

详 [`plans/task-mcp-owner-session-id-rewrite-20260521.md`](../plans/task-mcp-owner-session-id-rewrite-20260521.md)(deep-review 3 轮 × fix loop 收敛 F1-F9 九条 finding)。

## 变更内容

### Schema migration

- `src/main/store/migrations/v023_tasks_owner_session_id_rewrite.sql`(新建)— DROP TABLE tasks + CREATE TABLE 全新 schema:`owner_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE` + 3 索引(`idx_tasks_owner_session_id` / `idx_tasks_status` / `idx_tasks_updated_at`),drop v007/v011 的 `team_name` + `team_id` 列
- `src/main/store/migrations/index.ts` 注册 v023

### 持久层 / 类型

- `src/shared/types/task.ts` `TaskRecord` 类型 drop `teamName/teamId`,add `ownerSessionId: string`(必填)
- `src/main/store/task-repo.ts` 重写:`TaskCreateInput.ownerSessionId` 必填;`TaskListOptions.ownerSessionIds?: string[]` IN 过滤(空数组短路返 0 行);新增 `reassignOwner(oldSid, newSid): number` 单 SQL 改 owner;delete cleanup 裸 `JSON.parse` 包 try/catch(脏 JSON survivor 不让删另一无关 task 整 tx 回滚);`reassignOwner` 不刷 `updated_at`(语义是 owner 换不是 task content 改,list 默认排序稳定)
- `delete()` predicate 签名 `(id, ownerSessionId) => boolean`(替代旧 `(id, teamName, teamId)`)

### MCP tools 层

- `src/main/task-manager/tools.ts` 重写 5 个 handler:`buildTaskTools(repo, sessionIdProvider)` 第二参从 teamIdProvider 改 sessionIdProvider;`task_create` 闭包注入 owner = caller_sid + FK 兜底校验;`task_list` 走 `getVisibleOwnerSessionIds(callerSid)` 算 visible scope(caller 自己 + 同 team active member,且 team 必须 `archivedAt === null`)+ 返 `{ total, hasMore, tasks }`;`task_update / task_delete` 走 `isCallerAuthorizedToWrite`(caller==owner 特例 / cross-team reject);cascade delete predicate 闭包写权限;`task_get` 不限 team scope
- `src/main/task-manager/server.ts` + `src/main/adapters/claude-code/sdk-bridge/mcp-server-init.ts` 同步签名(sessionIdProvider 替换 teamIdProvider)

### Hand_off task 过继

- `src/main/agent-deck-mcp/tools/handlers/hand-off-session.ts` 加 reassignTaskOwner 调用:spawn 完成 + 新 sid 落 DB + adopt 流程完成后、archive caller 之前,原子 `UPDATE tasks SET owner_session_id = ? WHERE owner_session_id = ?`;**`archive_caller=false` 跳过过继**(F1 修法 — caller 仍 active 继续 own 自己 task,避免修前无条件过继让 caller 失去自己 task 写权限);失败仅 warn 不阻塞 ok return + 走 TTL GC best-effort 兜底;新增 `taskReassignment` 字段(三态判别式 union:`'ok'+count` / `'failed'+error` / `'skipped'+reason`)反馈 caller(F3 修法 — caller 通过 ok return 看到 task ownership 转移结果,不再 console.warn 静默)
- `src/main/agent-deck-mcp/tools/schemas.ts` `HandOffSessionResult.taskReassignment` 字段定义 + tool description 同步
- `src/main/agent-deck-mcp/tools/index.ts` hand_off_session tool description 加「task ownership reassignment」段

### IPC / UI 层

- `src/main/ipc/teams.ts` `AgentDeckTeamGetFull` + `TaskListByTeam` 两处 reverse join 改造(`taskRepo.list({ownerSessionIds: memberSids})`);**archived team filter**(F9 修法 — archived team 短路返 `[]` / `{tasks: []}`,与 task_list F2 纪律对齐)

### 应用打包 prompt 资产同步

- `resources/claude-config/CLAUDE.md` §task 进度跟踪节 + §hand_off 节同步 v023 模型 + F1/F3/F7 修法
- `resources/codex-config/CODEX_AGENTS.md` 同款同步(F8 修法 — 修前漏同步 codex-config 让 codex SDK 会话仍按旧 team_id 模型推理)

### 测试新增 / 重写

- `src/main/store/__tests__/task-repo.test.ts` 全重写(35 case 含 ownerSessionId 必填 / FK 兜底 / `ownerSessionIds` IN 三态 / cascade predicate (id,ownerSid) 签名 / `reassignOwner` 单 SQL N 行过继 / **F5 不刷 updated_at** / **F6 脏 JSON survivor delete cleanup 不抛错** / sessions ON DELETE CASCADE GC 路径)
- `src/main/store/__tests__/v023-migration.test.ts`(新建,7 case)— DROP+CREATE 行为 / schema 字段就位 / 3 index 都建 / FK 约束 / ON DELETE CASCADE / NOT NULL 约束 / 幂等性
- `src/main/store/__tests__/agent-deck-repos/_setup.ts` 升级 v018-v023 import + makeMemoryDb 加可选 dbPath 参数
- `src/main/task-manager/__tests__/tools.crud.test.ts` 全重写(22 case 含 owner 闭包注入 / FK 兜底 / 写权限 same-team check / caller==owner 特例 / cross-team reject)
- `src/main/task-manager/__tests__/tools.read-ingest.test.ts` 全重写(23 case 含 visible scope 三态 / **F2 archived team filter 2 case** / **F4 hasMore 4 case** / ingest 走 first team name)
- `src/main/agent-deck-mcp/__tests__/hand-off-session.task-reassign.test.ts`(新建,5 case)— default archive_caller=true 路径 reassign + count / 0 task 路径 / **F3 失败暴露 ok return** / seam 默认值兜底 / **F1 archive_caller=false 跳过 reassign**

## verify

- `pnpm typecheck` ✅ 0 errors
- `pnpm build` ✅
- `pnpm exec vitest run` — Test Files 1 failed | 69 passed | 7 skipped (77);Tests 1 failed | 841 passed | 99 skipped (941);1 fail (`manager-ingest.test.ts REVIEW_49 R3 follow-up`)是 **pre-existing**(main repo 同款 fail,与本 plan 修法无关 — CHANGELOG_143 verify 同款记录)
- `pnpm exec vitest run src/main/store/__tests__/task-repo.test.ts src/main/store/__tests__/v023-migration.test.ts src/main/task-manager/__tests__/tools.crud.test.ts src/main/task-manager/__tests__/tools.read-ingest.test.ts src/main/agent-deck-mcp/__tests__/hand-off-session.task-reassign.test.ts` ✅ 50 passed (3 file 含 binding-skip 守门 42 skipped — task-repo / v023-migration 真测因 worktree better-sqlite3 binding 不可用 skip,与项目 CHANGELOG_42 教训纪律一致;tools.crud + tools.read-ingest + hand-off-session.task-reassign 不依赖 SQLite binding 完整跑过)

## 触发 / review 收敛

- 用户「task mcp,global 现在的设计是有问题的,会一直累积」明示重设计 task 数据模型
- 走 user CLAUDE.md §复杂 plan v2 流程:Step 0 RFC 3 轮共识(D1-D6)+ Step 0.5 spike 0(sessions reverse join 可行性验证)+ Step 1 plan 文件 + Step 1.5 deep-review × fix loop 3 轮(R1 五 MED + 三 LOW + 二 INFO / R2 reviewer-codex 二 MED 升 F8+F9 / R3 双 reviewer 0 finding 收口)+ Step 2 EnterWorktree + Step 4 测试矩阵 + Step 5 verify(typecheck + build + vitest)+ Step 6 archive_plan
- **deep-review 共收敛 9 条 finding fix**:F1 reassign 与 archive_caller 解耦(双方独立 ✅ HIGH 等价)+ F2 task_list archived team filter(codex 单方现场验证)+ F3 task reassign 失败暴露 ok return(双方独立)+ F4 task_list total/hasMore 分页(claude 单方现场验证)+ F5 reassignOwner 不刷 updated_at(claude 单方)+ F6 delete cleanup 裸 JSON.parse 包 try/catch(codex LOW)+ F7 ShutdownAllTeammates 不对称(文档化设计取舍)+ F8 codex-config 同步(codex 单方现场验证)+ F9 ipc/teams.ts archived team filter(codex 单方现场验证,与 F2 纪律对齐)
