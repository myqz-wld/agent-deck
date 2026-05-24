---
plan_id: "task-mcp-owner-session-id-rewrite-20260521"
created_at: "2026-05-21T19:15:00+08:00"
worktree_path: "/Users/apple/Repository/personal/agent-deck/.claude/worktrees/task-mcp-owner-session-id-rewrite-20260521"
status: "completed"
base_commit: "619dca703eaa56e39497bdac80e5daa5253b53bb"
base_branch: "main"
final_commit: "eb90a8e44d34679054caf27f26fd105fda992671"
completed_at: "2026-05-21"
---
# Plan: task mcp 从 team_id 模型重设计为 owner_session_id 纯模型

## 总目标

把 `mcp__tasks__*` 工具的数据模型从「team_id 闭包 + global task」改为「owner_session_id 必填 + sessions reverse join 拿 team scope」，消灭 global task 累积问题（root cause 见 REVIEW_49）。

**起源**：用户报「task mcp，global 现在的设计是有问题的，会一直累积」。现状有三种路径会落 global task（team_id=NULL）：① caller session 无 team 时 task_create 闭包 NULL ② team 硬删 ON DELETE SET NULL ③ caller 显式传 team_id=null。task 表无 cleanup / TTL，completed task 永久存活。

**RFC 3 轮收口共识**（本会话）：
- core model: `owner_session_id NOT NULL REFERENCES sessions(id) ON DELETE CASCADE`，drop `team_id` 与 `team_name` 列
- 可见性：sessions reverse join（owner_sid → sessions.team_id → 同 team active member 可读）
- 写权限：同 team active member 都能写（含 owner / lead / teammate；之前 REVIEW_49 修法的"global 谁都能改"语义下沉到"同 team 谁都能改"）
- hand_off 过继：`hand_off_session` tool 内部 UPDATE tasks SET owner_session_id = newSid WHERE owner_session_id = oldSid
- GC：复用现有 `LifecycleScheduler.historyRetentionDays` + task FK ON DELETE CASCADE，archived + N 天 TTL 自动 GC sessions row 时 cascade 删 task
- Migration：v023 DROP TABLE tasks + CREATE TABLE 全新 schema（drop 所有现有 task 行 — 用户明示 dev 阶段可接受）

**修法核心**：DB schema 单字段 owner_session_id 拿掉所有 team-related 复杂；team scope 推到 query 层 join sessions 算；hand_off 自动过继 task 让 baton 单向交接语义自然成立。

## 不变量

1. **task 必有 owner**：tasks.owner_session_id NOT NULL，无 global task 概念
2. **CASCADE 删 task**：owner session 被 sessionRepo.delete 时（CASCADE）task 自动删 — 不留 orphan
3. **同 team 写权限**：caller_session_id 与 task.owner_session_id 必须共享一个 active team（含 caller == owner 这个特例）才允许 update/delete；跨 team 写仍 reject
4. **hand_off 过继**:hand_off_session spawn 新 session 后 + adopt 流程完成后 + archive caller 之前调 `reassignOwner`,把 caller 拥有的所有 task 原子转给新 session。**默认成功路径(reassignOwner 无 SQL 错误 + `archive_caller=true`)不留窗口**;reassignOwner 抛错(SQLite locked / FK 异常)时 baton 仍继续,失败原因暴露在 ok return `taskReassignment.status='failed'` + `error` 字段,由 `LifecycleScheduler.historyRetentionDays` TTL GC 作 best-effort 兜底(失败概率低)。`archive_caller=false` 路径跳过过继(caller 仍 active 继续 own 自己 task,`taskReassignment.status='skipped'+reason='archive-caller-false'`)— **deep-review Round 1 F1 修法**(reviewer-codex MED-2 + reviewer-claude MED-c1 双方独立)
5. **team_name 兼容代码全删**：v007 的 team_name 列 + tools.ts / task-repo.ts 内 team_name 兼容 helper 一并清，与 team_id 同步 drop
6. **没有「彻底删除」UI 改动需求**：复用现有 LifecycleScheduler + sessionRepo.delete 即可（archive 后 N 天 TTL 自动跑，settings.historyRetentionDays 已存）
7. **mcp__tasks__ tool description SSOT 同步**：`src/main/agent-deck-mcp/tools/schemas.ts` task tools description 更新（不再说 team_id 闭包，改说 owner_sid 自动 = caller_session_id + team scope reverse join）
8. **应用打包 CLAUDE.md + CODEX_AGENTS.md §task 进度跟踪节同步**：`resources/claude-config/CLAUDE.md` + `resources/codex-config/CODEX_AGENTS.md` **双端同步**改约定描述(deep-review Round 2 F8 修法 — 修前只同步 claude-config 漏 codex-config,codex SDK 会话仍按旧 team_id 模型推理)。两个 hand_off_session §app-only 差异节也同步加 task 自动过继 + ShutdownAllTeammates 不对称段
9. **测试覆盖**：v023 migration 单测（drop + create 行为）+ task-repo.ts 单测（owner_session_id 写入 / sessions join 拿 team） + tools.ts 单测（写权限 same team check + hand_off 过继）

## 设计决策（不再争论 — RFC 3 轮共识）

### D1: Core model = owner_session_id NOT NULL（RFC 第 1 轮 Q1 选 A 修正版）

用户 RFC 第 1 轮 Q1 选「A. 纯 owner_session_id（消灭 global+team）」但加约束「teammate 能看到 + hand_off 需要过继」。第 2 轮 Q1 澄清矛盾后选「B. 仅 owner_sid，team 跨 sessions 表 reverse join」。

最终决议：tasks 表只存 owner_session_id 单字段；team scope 在 query 层 reverse join `sessions.team_id`（owner_sid → sessions → team_id）。task 表 schema 简单，team 关系 derived。

### D2: 写权限 = 同 team active member（RFC 第 3 轮 Q2 选 B）

用户 RFC 第 3 轮 Q2 选「B. 同 team 都能写」。写权限放宽到「caller 与 task owner 共享 active team」即可写。与 REVIEW_49 「global task 谁都能改」精神延续 — 单用户单进程信任模型。

实施：tools.ts task_update / task_delete handler 加 `findSharedActiveTeams(callerSid, ownerSid)` 检查，命中 ≥ 1 个 team 通过。caller == owner 是特例（自己 team 必交集）。

### D3: hand_off 过继 = atomic UPDATE owner_session_id（RFC 第 1 轮 Q1 用户原始要求）

`hand_off_session` tool 在 spawn 新 session 之后、archive caller 之前，原子 SQL `UPDATE tasks SET owner_session_id = ? WHERE owner_session_id = ?` 把 caller 拥有的 task 全部过继给新 session。

实施：`src/main/agent-deck-mcp/tools/handlers/hand-off-session.ts` 加 step（spawn 完成且新 session id 已落 DB 后调）。失败处理：UPDATE 失败仅 warn（不阻塞 hand_off ok return — task 过继是 nice-to-have，hand_off baton 本质是 session 接力）。

### D4: GC = 复用 LifecycleScheduler + ON DELETE CASCADE（RFC 第 3 轮 Q2 = B）

不引入新 GC 机制。现有 `LifecycleScheduler.historyRetentionDays > 0` 自动跑 `findHistoryOlderThan` → `sessionRepo.delete`，sessionRepo.delete 触发 sessions row DELETE → 新 schema 的 ON DELETE CASCADE 让 task 自动删。

**用户期望「archived + N 天 TTL 自动 GC」机制已存在**，新 schema 只需配合 FK 类型即可。无需改 LifecycleScheduler / sessionRepo / settings。

### D5: Migration = DROP TABLE + CREATE TABLE（RFC 第 3 轮 Q1 选 A）

用户 RFC 第 3 轮 Q1 选「A. drop 所有现有 task（最干净）」。v023 migration 直接 DROP TABLE tasks + CREATE TABLE 全新 schema，废弃 v007/v011 的所有列（team_name / team_id 全删）。

副作用：用户当前 dev 阶段所有 task 数据丢失（含本会话刚跑期间创建的 6 个 task — 但本会话 task 都跟踪 review/fix 流程，不是长期 work item，丢失可接受）。

### D6: reverse join 查询语义

task_list 默认行为：

```sql
-- 拉 caller 同 team 所有 active session 的 task
SELECT t.* FROM tasks t
  JOIN sessions s ON t.owner_session_id = s.id
  JOIN agent_deck_team_members tm_self ON tm_self.session_id = ? -- caller_sid
  JOIN agent_deck_team_members tm_owner
    ON tm_owner.team_id = tm_self.team_id
    AND tm_owner.session_id = s.id
  WHERE tm_self.left_at IS NULL
    AND tm_owner.left_at IS NULL
  ORDER BY t.updated_at DESC
  LIMIT ? OFFSET ?;
```

边界：
- caller 无 team membership → 仅返 caller 自己拥有的 task（owner_sid == caller_sid）
- caller 在多 team → UNION 所有 team 内 session 的 task（去重 by task.id）
- task_get 不限 team（任何人可查任何 task by id — 与 REVIEW_49 「读跨 team 视性」同款）

## 步骤 checklist

- [x] Step 0: 进 EnterWorktree（plan-driven，新会话 cold start 必走）
- [x] Step 1: 写 v023 migration `src/main/store/migrations/v023_tasks_owner_session_id_rewrite.sql`（DROP + CREATE 全新 schema）
- [x] Step 2: 注册 v023 到 `src/main/store/migrations/index.ts`
- [x] Step 3: 改 `src/shared/types/task.ts` TaskRecord 类型（drop teamId/teamName，add ownerSessionId）
- [x] Step 4: 改 `src/main/store/task-repo.ts`（drop team_id/team_name 字段，add owner_session_id，list 加 ownerSessionIds IN 过滤，新增 reassignOwner）
- [x] Step 5: 改 `src/main/task-manager/tools.ts` 5 个 handler（task_create 闭包 owner_sid = caller_session_id / task_list 改 reverse join visible scope / task_update / task_delete 写权限 same-team check）+ 同步 server.ts + sdk-bridge/mcp-server-init.ts 签名
- [x] Step 6: 改 `src/main/agent-deck-mcp/tools/handlers/hand-off-session.ts` 加 task 过继 step（UPDATE owner_session_id，spawn 后 + adopt 后 + archive caller 前，失败 warn 不阻塞）+ handlerDeps test seam
- [x] Step 7: 改 `src/main/agent-deck-mcp/tools/schemas.ts` hand_off_session description 加 task 过继提示（task tool description 在 task-manager/tools.ts 内联已 Step 5 更新）
- [x] Step 8: 改 `resources/claude-config/CLAUDE.md` §task 进度跟踪节 + §hand_off 节同步 v023 描述
- [x] Step 9: 清残留 dead code + ipc/teams.ts 两处 taskRepo.list({teamId}) 改成 ownerSessionIds IN reverse join
- [ ] Step 10: 改 / 加测试：v023 migration 单测 + task-repo 测改写 + tools.crud / tools.read-ingest 重写 + hand_off-session.ts 加过继测
- [ ] Step 11: typecheck + build + 全套 vitest 通过
- [ ] Step 12: invoke `/agent-deck:deep-review` SKILL kind='mixed' (plan + code 实施一致性) — reviewer 出 finding 修到共识
- [ ] Step 13: 收口 — archive_plan tool 归档 plan + commit

## 当前进度

- ✅ RFC 3 轮收口（前会话）
- ✅ Spike 0.5：sessions reverse join 可行性已验证
- ✅ schema 现状已读（v007 + v011）
- ✅ historyRetentionDays + LifecycleScheduler.findHistoryOlderThan 现状已读
- ✅ **本会话完成 Step 0-9**：migration + 类型 + repo + tools + hand_off 过继 + ipc/teams reverse join + 应用打包 CLAUDE.md 同步 + 主代码 typecheck 全过
- ⏳ 剩余 Step 10-13：测试重写（旧 tools.crud / tools.read-ingest / task-repo test 全 outdated 需重写 + 新增 v023 migration test + hand_off reassignTaskOwner test）+ vitest/build + deep-review SKILL + archive_plan

## 下一会话第一步（cold start 必读）

1. `Bash: cat /Users/apple/Repository/personal/agent-deck/.claude/plans/task-mcp-owner-session-id-rewrite-20260521.md` 全文（看 §当前进度 / §步骤 checklist Step 1-9 ✅ + Step 10-13 ⏳）
2. **worktree 已存在**（前会话用 EnterWorktree 进过）→ 新会话 cold start 直接 `EnterWorktree(path: "/Users/apple/Repository/personal/agent-deck/.claude/worktrees/task-mcp-owner-session-id-rewrite-20260521")` 进入
3. `git -C <worktree_path> rev-parse HEAD` 自检（前会话改了 Step 1-9 但未 commit，worktree HEAD 仍 == base_commit `619dca7`，改动在 worktree dirty 中；运行 `git -C <worktree_path> status` 看 12+ 文件 unstaged）
4. **优先收尾 Step 10**（旧 test 全 outdated 需重写，101 typecheck errors 集中在 `src/main/store/__tests__/task-repo.test.ts` / `src/main/task-manager/__tests__/tools.crud.test.ts` / `src/main/task-manager/__tests__/tools.read-ingest.test.ts`）：
   - **删** `tools.crud.test.ts` + `tools.read-ingest.test.ts` 旧 schema 测试 → 重写覆盖新 owner_session_id model（test 矩阵详 §测试覆盖矩阵节）
   - **改** `task-repo.test.ts`：每个 create 调用补 ownerSessionId 字段（fixture 用 makeSession 建一个真 sessions row 拿 sid 当 owner）；list 改用 ownerSessionIds IN；删 teamName/teamId 断言
   - **新增** `src/main/store/__tests__/v023-migration.test.ts`：用 in-memory db 跑 migrations，verify tasks 表 schema（owner_session_id NOT NULL FK / ON DELETE CASCADE 触发 / 老数据被 DROP）
   - **新增** `src/main/agent-deck-mcp/__tests__/hand-off-session.task-reassign.test.ts`：mock `reassignTaskOwner` test seam，verify hand_off spawn 后调用且失败 warn 不阻塞 ok return
5. **Step 11** `zsh -i -l -c "pnpm typecheck"` + `pnpm build` + `pnpm exec vitest run` 全过
6. **Step 12** invoke `/agent-deck:deep-review` SKILL kind='mixed'，args 含本 plan 路径 + 主代码变更文件清单（`v023_*.sql` / `task.ts` / `task-repo.ts` / `tools.ts` / `server.ts` / `mcp-server-init.ts` / `hand-off-session.ts` / `schemas.ts` / `ipc/teams.ts` / `resources/claude-config/CLAUDE.md`）
7. **Step 13** archive 走 `mcp__agent-deck__archive_plan({ plan_id, worktree_path, base_branch: "main", changelog_id?: "<X>" })` — caller 必须先 `ExitWorktree(action: "keep")` 切回 main repo。先写 CHANGELOG_<X>.md 引用本 plan + commit 进 main repo（archive_plan 不会自动写 changelog 引用）
8. **不重新讨论已记录的 §设计决策 D1-D6**；如需变更先告诉用户征得确认再改

## 已知踩坑

1. **sessions 表 row delete cascade 链**：v007/v011 task 表用 ON DELETE SET NULL，新 schema 改 CASCADE → 删 session 的副作用变大（task 真删而非 orphan）。需 verify 现有 sessionRepo.delete 调用点（含 LifecycleScheduler.findHistoryOlderThan 触发）都接受新 cascade 行为
2. **hand_off_session 过继时机**：spawn 完成 + 新 session id 已落 DB 之后才能 UPDATE owner_session_id（否则 FK 引用不存在 → INSERT/UPDATE 失败）。确认 hand-off-session.ts 实现 spawn step 完成后能拿 newSid 同步可见在 DB
3. **多 team caller 的 task 过继边界**：caller 在多 team 时，过继是把 caller 拥有的所有 task 全转给 newSid（不论 team 归属）— 新 session 加哪些 team 由 hand_off args.team_name / adopt_teammates 决定，task 自然跟新 session 的 team membership 走 reverse join 算可见性
4. **multi-row hand_off 过继的 SQL 一致性**：caller 拥有的 task 可能有几十条（长会话累积），UPDATE 用单 SQL `WHERE owner_session_id = ?` 一次更新即可，无需循环。但要包在 hand_off_session step 的事务里（hand_off_session 整体不是事务，task 过继可独立 — 失败 warn 不阻塞）
5. **DROP TABLE 后历史 mcp__tasks__ 调用方对旧 task id 的引用全失效**：本会话刚 task_create 的 6 个 task id 在 v023 后失效，新会话 cold start 不能用旧 id 查 task。新会话应重新 task_create 跟踪 task-mcp-rewrite 实施进度
6. **team_name 列删除是 destructive，需谨慎**：v007 的 team_name 是兼容字段，已无新写入（CHANGELOG_45 起改用 team_id）。drop 安全。但要 grep 项目内是否还有读 team_name 的 dead code — 一并清
7. **archive_caller=false 路径 task 不过继**(deep-review Round 1 F1 修法):caller 仍 active 时跳过 reassignOwner,caller 保留自己 task 写权限(走 caller==owner 特例);ok return `taskReassignment.status='skipped'+reason='archive-caller-false'`。注意:该路径 caller 与 newSid 默认无 shared team(除非显式传 `team_name` / `adopt_teammates=true`),新 session 的 task_list 看不到 caller 的 task,需通过 explicit team 沟通
8. **ShutdownAllTeammates 不调 reassignOwner**(deep-review Round 1 F7 文档化):IPC `AgentDeckTeamShutdownAllTeammates` / hand_off baton-cleanup phase 1 关闭 teammate 时不过继 teammate task → teammate task 留在已关闭 sid 名下,被 `LifecycleScheduler.historyRetentionDays` TTL GC 触发 `sessionRepo.delete` 时 CASCADE 删。设计取舍:teammate context 已死 task 本质无主,删干净是合理设计(与 hand_off caller→newSid 主语义不对称但合理 — caller 是「接力」teammate 是「关闭」)。若产品需要 lead 接管 teammate 遗留 task 需另外加 `reassignOwner(teammateSid, leadSid)` 调用(目前未实现)
9. **task_list visible scope 需过滤 archived team**(deep-review Round 1 F2 修法):`agentDeckTeamRepo.findActiveMembershipsBySession` 只过滤 `left_at IS NULL` 不过滤 team archived,与 write 路径 `findSharedActiveTeams` 强制 team archived 过滤边界不一致 → 修前 caller 在 archived team 的 ghost membership 让 task_list 看得到但 task_update 拒(读写视野不一致)。修后 `getVisibleOwnerSessionIds` 用 `agentDeckTeamRepo.get(teamId).archivedAt === null` 二查过滤(与 adopt Phase 7 同款纪律)
10. **reassignOwner 不刷 updated_at**(deep-review Round 1 F5 修法):reassign 是 owner 换不是 task content 改,不算用户「修改」task → 保留原 updated_at 让 list 默认 `ORDER BY updated_at DESC` 排序保持稳定。修前刷 updated_at 让 hand_off baton 后所有过继 task 浮顶 UI stale
11. **ipc/teams.ts archived team filter 双路径同步**(deep-review Round 2 F9 修法):MCP `task_list` 经 `getVisibleOwnerSessionIds` 在 R1 F2 加了 archived team filter,但 Team IPC 两条读路径(`AgentDeckTeamGetFull` / `TaskListByTeam`)仍直接走 `listActiveMembers` 不过滤 team archived → archived team detail 仍显示成员 live task。修法:两 IPC handler 加 `agentDeckTeamRepo.get(teamId).archivedAt !== null → return [] (或 {tasks:[]})` 短路,与 F2 同款纪律
12. **codex-config CLAUDE.md 必须与 claude-config CLAUDE.md 同步**(deep-review Round 2 F8 修法):应用打包资产含两份独立加载的 CLAUDE.md(`resources/claude-config/CLAUDE.md` for claude SDK / `resources/codex-config/CODEX_AGENTS.md` for codex SDK)— **改 task / hand_off 协议时必须双端同步**(plan §不变量 8 已涵盖此约束)。reviewer scope 检查不变量时确保两文件都覆盖,避免 codex SDK 会话被旧约定误导

## 测试覆盖矩阵（Step 10 落实）

| 测试文件 | 覆盖场景 |
|---|---|
| `src/main/store/__tests__/v023-migration.test.ts` 新建 | DROP TABLE + CREATE TABLE 行为；老数据是否被清；新 schema 字段就位 |
| `src/main/store/__tests__/task-repo.test.ts` 改 | owner_session_id INSERT/UPDATE/DELETE；sessions reverse join 查 team scope；caller 多 team / 单 team / 无 team 三场景 |
| `src/main/task-manager/__tests__/tools.test.ts` 改 | task_create 闭包 caller_session_id；task_update/delete 写权限 same-team check；caller != owner 但 same team 写允许；caller != owner 且 cross team 写 reject |
| `src/main/agent-deck-mcp/tools/handlers/__tests__/hand-off-session.test.ts` 改 | hand_off 后 caller 拥有的 task 全部 owner_session_id 转新 sid；多 row 过继；过继失败 warn 不阻塞 ok return |
| 集成测试：sessionRepo.delete cascade 路径 | LifecycleScheduler.findHistoryOlderThan → sessionRepo.delete 后 task 是否随 CASCADE 删；orphan 0 行 |

## 参考与 dependencies

- 现状摸底（本会话 Explore agent + Read）：tasks 表 schema (v007/v011) / LifecycleScheduler.historyRetentionDays / sessionRepo.delete CASCADE 链 / agentDeckTeamRepo.listActiveMembers
- RFC 3 轮历史：本会话对话 conversation history（覆写 design 决策 D1-D6）
- 相关 review：REVIEW_49 R3 task tool 跨 team bug 修法（"global task 谁都能改" — 本 plan 把语义下沉到"同 team 谁都能改"）
- 相关 changelog: CHANGELOG_45（agent_deck_teams 三表引入，team_id 模型）
- migration 编号：现有最大 v022（CHANGELOG_142 codex session detail bug fix），新增是 v023
