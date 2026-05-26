# CHANGELOG_149 — v024 task 表恢复 team_id 字段（NULLABLE）+ hand_off team_task_policy 三态 + task_get team-scoped read

## 概要

REVIEW_53 fix（CHANGELOG_146）v023「task team scope 从 stored 改 derived」（reverse join sessions → agent_deck_team_members 算）落地后，用户在「评估 mcp 格式一致性」过程中追加发现两个 RFC 未覆盖的边界缺陷：(1) **lead 多 team 时 task 跨 team 串流**（lead L 在 team A 创 task，team B teammate Tb 通过 owner-derived reverse join 看到 A 专属任务）；(2) **hand_off ownership 跨 team 边界缺位**（baton 后新 owner 与原 team 无 shared team 撞 isCallerAuthorizedToWrite reject）。

修法核心：**team 从 derived 改回 stored** — `tasks.team_id TEXT NULL REFERENCES agent_deck_teams(id) ON DELETE SET NULL`。owner_session_id NOT NULL 仍兜底 GC（不复活 v023 之前的 global task 累积问题）。两字段各司其职 — owner 管 GC，team 管 visibility/permission。

**RFC 2 轮收口 7 个决策点 D1-D7（D8 Round 2 HIGH-1 ripple 加） + Step 1.5 Deep-Review 7 轮 fix loop 收敛**（R1: 2 HIGH+7 MED+2 LOW → R5: 0 HIGH+4 MED+2 LOW 首轮 design 稳定 → R7: 0 HIGH+0 真 MED+1 LOW 双方独立 verdict ✅ 收口）+ Phase A-G 8 commit + Phase H deep-review code 实施验证收口。

## 变更内容

### Phase A — Migration + 类型层

- **新建** `src/main/store/migrations/v024_tasks_add_team_id.sql`：1:1 复用 v011 模板（HIGH-1 修法 — sqlite3 :memory: 实测 ALTER REFERENCES 合法），`ALTER TABLE tasks ADD COLUMN team_id TEXT REFERENCES agent_deck_teams(id) ON DELETE SET NULL` + `CREATE INDEX idx_tasks_team_id ON tasks(team_id) WHERE team_id IS NOT NULL`（部分索引零浪费）
- **改** `src/main/store/migrations/index.ts`：注册 v024
- **改** `src/shared/types/task.ts`：`TaskRecord.teamId: string | null`

### Phase B — Repo 层

- **改** `src/main/store/task-repo.ts`：
  - Row interface + create + update + list 加 `team_id`
  - `list(opts)` 新 `teamIdFilter: string | 'null-personal' | undefined` 三态 + `visibleScope: { teamIds: string[]; callerSid: string }` OR 模式（`(team_id IN teamIds) OR (team_id IS NULL AND owner_session_id == callerSid)` 一次 SQL 拿 caller 可见全部）
  - `reassignOwner` 加 `policy: 'clear-team' | 'preserve-team'` 参数（不含 'skip'）
  - **`delete` predicate 签名改造（HIGH-2）**：`(id, child: Pick<TaskRecord, 'ownerSessionId' | 'teamId'>) => boolean`，配合 `deleteRecursive` BFS pre-walk 拿 child 完整 task 让 isCallerAuthorizedToWrite 按 child.team_id 判
  - **新增 `applyHandOffSkipPolicy(callerSid, newSid): { deletedTeamTaskIds, reassignedPersonalCount }`**（Round 3 MED-1 收口）：单 db.transaction() 内原子化 4 步（SELECT 团 task ids → chunked DELETE → blocks/blocked_by cleanup → reassign personal）
  - **新增 `findOwnedDistinctTeamIds(callerSid): string[]`**（Round 4 HIGH-1 支撑）：单 SQL DISTINCT 拿 caller owned non-null team_id 列表

### Phase C — mcp handler 层（5 task handler + helpers）

- **改** `src/main/agent-deck-mcp/tools/schemas.ts`（Layer 1 SSOT，short-form describe + cross-reference）：
  - `TASK_CREATE_SCHEMA` 加 `team_id` optional + `TASK_LIST_SCHEMA` 加 `team_id_filter` optional zod literal `z.union([z.string().uuid(), z.literal('null-personal')])`
  - `TASK_GET_SCHEMA` describe 改写为「team-scoped + deny external」（D8 推翻 v023 cross-team 可读）
  - `HAND_OFF_SESSION_SHAPE` 加 `team_task_policy: 'clear-team' | 'preserve-team' | 'skip'` enum optional + `HandOffSessionResult.taskReassignment` 加 `policy` required field + `policyWarning?: 'preserve-team-unadopted-teams'` + `unadoptedTeamIds?: string[]`
  - `HandOffSessionResult.adopted` 加 `adoptedTeamIds: string[]` field（与 `preserved: string[]` sids 对称暴露 caller team uuids 便于 diag — Round 4 MED-1）
- **改** `src/main/agent-deck-mcp/tools/handlers/task-create.ts`：
  - 加 `args.team_id` 校验（`isCallerInTeam(callerSid, args.team_id)` 否则 reject）
  - **ingest payload.teamName 改取 `agentDeckTeamRepo.get(args.team_id)?.name`**（MED-2 修法：multi-team caller 显式 team_id=B 不漂移到 first active team A；Round 3 MED-3 修正：`get(teamId)` 不是 `findById`）
- **改** `src/main/agent-deck-mcp/tools/handlers/task-list.ts`：D5 三态分流（visibleScope OR 模式 / specific teamId 校验 caller 在 team / `'null-personal'` ownerSessionIds=[caller]）
- **改** `src/main/agent-deck-mcp/tools/handlers/task-update.ts` + `task-delete.ts`：
  - `isCallerAuthorizedToWrite(callerSid, existing)` 改签名传整个 task（HIGH-2）
  - `task-delete.ts:71` cascade predicate `(_id, child) => isCallerAuthorizedToWrite(callerSid, child)`
- **改** `src/main/agent-deck-mcp/tools/handlers/task-helpers.ts`（重写）：
  - `isCallerAuthorizedToWrite(callerSid, task)` 按 `task.teamId` null/non-null 分支
  - 新增 `isCallerAuthorizedToRead(callerSid, task)` 镜像 write（D3 read/write 镜像）
  - 新增 `isCallerInTeam(callerSid, teamId)` 双条件 active member check（agentDeckTeamRepo.findActiveMembershipsBySession + 二查 team archivedAt === null）
  - 新增 `getVisibleTaskScope(callerSid)` 替代 `getVisibleOwnerSessionIds`，返 `{teamIds: string[], includeOwnPersonal: true}`
  - **删** `getCallerFirstTeamName`（v023 ingest payload.teamName 用，v024 后被 D2 漂移问题推翻）
- **改** `src/main/agent-deck-mcp/tools/handlers/task-get.ts`（D8 修法）：
  - 加 `isCallerAuthorizedToRead(callerSid, t)` check
  - **flip `EXTERNAL_CALLER_ALLOWED.task_get: true → false`**（types.ts:144 + jsdoc 删 「allow external」段）
  - 删 file header / jsdoc「跨 team 只读」描述
- **改** `src/main/agent-deck-mcp/tools/index.ts`：`task_get` tool description 显式改 Before/After 字符串（Round 3 LOW-2 防 implementer 漏改）

### Phase D — hand_off 层

- **改** `src/main/agent-deck-mcp/tools/handlers/hand-off-session.ts`（reassign 段大改造）：
  - `taskPolicy` const 在 reassign 段顶部声明（在三分支判断之前）让 5 路径共用同一 scope（R7 LOW-2）
  - **5 路径都带 `policy: taskPolicy` field**（spawn-no-sid / archive-caller-false / skip-ok / skip-failed / clear-team / preserve-team — R6 MED-2）
  - **`taskPolicy === 'skip'`**：调 `taskRepo.applyHandOffSkipPolicy` seam（HandOffSessionHandlerDeps.applyHandOffSkipPolicy）+ handler commit 后 per-id `safeEmit task-changed deleted`（inner try/catch + console.warn + continue — Round 4 MED-3 沿用 hand-off-session.ts:754-763 现有 safeEmit pattern）+ DB throw fallback `taskReassignment={status:'failed', error, policy: taskPolicy}`（不抛错给 caller — Round 4 MED-2）
  - **`taskPolicy === 'preserve-team'`** safety 算法（Round 4 HIGH-1 完整 firstTeam + rest 双 push）：
    - `phase15Detail.adoptedTeamIds: string[]`（替代 R3 误用的 `phase15Detail.preserved` — preserved 是 teammate sids 不是 teamIds）
    - `processSwappedTeam(teamId)` helper 顶部集中 `adoptedTeamIdsList.push(teamId)`（firstTeam path L832 + rest loop L862 都调，集中责任避免双 push 漂移）
    - `findCallerOwnedTeamIds(callerSid)` seam（HandOffSessionHandlerDeps.findCallerOwnedTeamIds，default `taskRepo.findOwnedDistinctTeamIds`）
    - `newSidActiveTeamIds = new Set([...phase15Detail.adoptedTeamIds, ...(spawnData.teamId ? [spawnData.teamId] : [])])`
    - 差集非空 → `policyWarning='preserve-team-unadopted-teams'` + `unadoptedTeamIds`（handler 不 hard reject，soft warning 让 caller 知情）
  - **`taskPolicy === 'clear-team'`**（default）：reassignOwner({policy:'clear-team'}) UPDATE owner + team_id=NULL
  - **archive_caller=false 优先级**：先于 policy 执行 skip 整段 reassign，policy advisory 透传 `taskReassignment={status:'skipped', reason:'archive-caller-false', policy: taskPolicy}`
  - **`adopted.adoptedTeamIds` spread mapping**（R5 LOW-2 显式 wire）：return 段 ok return.adopted block spread `adoptedTeamIds: phase15Detail.adoptedTeamIds`（与 `preserved` 并列）
- **改** `src/main/agent-deck-mcp/tools/index.ts`：`hand_off_session` tool description 同步 D4 三态 + archive_caller=false 优先级 + preserve-team policyWarning + unadoptedTeamIds 字段含义

### Phase E — IPC 层

- **改** `src/main/ipc/teams.ts`：
  - `:349 TaskListByTeam` 走 `taskRepo.list({teamIdFilter: teamId, limit: 200})` 严格按 team_id 过滤
  - `:113 AgentDeckTeamGetFull` 内 task 拉取段同款 teamIdFilter 严格过滤
  - archived team filter 纪律保留（plan §不变量 7）：team archivedAt !== null 时返 []
  - **消灭 v023「lead 多 team task 串流到团队面板」根因**（plan §起源）

### Phase F — 双端打包 CLAUDE.md / CODEX_AGENTS.md 同步（Layer 2 仅使用模式 + 决策依据）

- **改** `resources/claude-config/CLAUDE.md` §task 进度跟踪节 + §archive_plan / §hand_off 节：
  - write/read permission rule 使用模式 + why personal default 决策依据
  - team_task_policy 三态使用模式 + why preserve-team caller 自负责任 / why default clear-team
  - D8 task_get team-scoped + deny external（v023 cross-team 可读两类 use case 推翻）
  - 字段定义 SSOT 在 schemas.ts/types.ts，本节不重复列（R4 LOW-2 修法）
- **改** `resources/codex-config/CODEX_AGENTS.md`：双端 mirror 同款内容（语义对称不引入差异）

### Phase G — 测试 + 验证（5 测试文件 + G0 setup 加 v024 + G5 typecheck/build/vitest）

- **改** `src/main/store/__tests__/agent-deck-repos/_setup.ts`：`makeMemoryDb` 加 v024 import 与 for-loop（让 task-repo 等 SQLite 真测能跑全 v001-v024 schema）
- **新建** `src/main/store/__tests__/v024-migration.test.ts`：
  - sub-case A：v024 ALTER TABLE ADD COLUMN 行为 / `idx_tasks_team_id` 部分索引就位 / `PRAGMA foreign_key_list` 验 FK ON DELETE SET NULL constraint / hard delete agent_deck_teams 触发 SET NULL
  - sub-case B：v023→v024 跨版本升级 fixture（MED-5 修法）— `applyMigrations(['001'...'v023']) → seed 5 老 task → applyMigrations(['v024'])` 验老数据保留 + 自动 team_id=NULL
- **改** `src/main/store/__tests__/task-repo.test.ts`：
  - 7 处 ripple 修（cascade predicate signature 改 `(_, child) => child.ownerSessionId === ...` + reassignOwner 5 处加 `{policy:'clear-team'}` 参数）
  - v024 新 case 块：create with teamId / update teamId / list 三态 filter（visibleScope OR 模式 + teamIdFilter 三态）/ reassignOwner policy 两态 / **applyHandOffSkipPolicy 三 case**（A 正常 commit / B 中段 throw FK 全 ROLLBACK / C blocks/blocked_by cleanup）/ findOwnedDistinctTeamIds / team hard delete → SET NULL / **cascade delete cross-team scenarios**（HIGH-2 — 同 team 通过 / 跨 team 跳过）
- **改** `src/main/agent-deck-mcp/__tests__/task-crud.test.ts`：整重写为 v024 mock 模式（`isCallerAuthorizedToWrite/Read` + `isCallerInTeam` + `getVisibleTaskScope` 替代 v023 `findSharedActiveTeams`）— task_create/update/delete D3 + task_get D8 + task_list D5 + member left_at 路径 + team archived 路径 + caller leave 反向 case d
- **改** `src/main/agent-deck-mcp/__tests__/task-events.test.ts`：D2 teamName 取 args.team_id lookup（多 team caller 显式 team_id=B 不漂移到 A）+ team task / personal task 双路径
- **改** `src/main/agent-deck-mcp/__tests__/task-external-caller.test.ts` + `spoofing-attack-paths.test.ts`：D8 task_get flip false（task_create/update/delete/task_get DENY × 2 transport HTTP+stdio + task_list ALLOW + describe 重命名 read-only 例外不再含 task_get）
- **改** `src/main/agent-deck-mcp/__tests__/hand-off-session.task-reassign.test.ts`：整重写 v024 三态 — clear-team default + preserve-team safety 4 case（含 firstTeam push 完整性 / case d 双 push 完整性 / safety query throw fallback）+ skip 真删（applyHandOffSkipPolicy 被调 + per-id emit + DB throw fallback + emit listener throw safeEmit fallback）+ archive_caller=false × 三态 advisory 透传 + 5 路径都带 policy field + seam default fallback

### 验证

- `pnpm typecheck` ✅ 通过（0 errors，6 轮 typecheck — Phase A-G 每 phase 后跑）
- `pnpm build` ✅ 通过（仅 1 dynamic-import warning rollup chunking 提示，与本 plan 无关）
- `pnpm exec vitest run` ✅ 1038 tests / 900 PASS / 137 skipped（better-sqlite3 ABI v130 vs vitest Node v137 mismatch — 与本 plan 无关，task-repo 等 SQLite 真测在 Electron runtime 下能跑）/ 1 pre-existing fail（`session/__tests__/manager-ingest.test.ts > REVIEW_49 R3 follow-up` 与本 plan 无关 — diff vs main HEAD 0 改动 manager-ingest）

## Plan & Review reference

- Plan: [`plans/task-team-id-restore-20260525.md`](../plans/task-team-id-restore-20260525.md)
- 起源: REVIEW_53 fix（CHANGELOG_146）落地后用户在「评估 mcp 格式一致性」过程中追加发现的两个 RFC 未覆盖边界缺陷
- Step 1.5 Deep-Review 7 轮 fix loop（R1-R7）收敛趋势 + 异构对偶教科书级实证（claude / codex 全程 0 overlap finding）详 plan §参考与 dependencies 末段完整记录

## v023 → v024 推翻明示（user-facing breaking）

- **lead 多 team 时 task 跨 team 串流**：消灭。lead 在 team A 创 task 不再被 team B teammate 通过 owner-derived reverse join 看到（D7 严格按 team_id 过滤）
- **in-process lead 跨 team 看 teammate task** use case：推翻（D3 严格 team-scoped 读）。lead 想看跨 team teammate task 应走「让 lead 加入对方 team active member」或显式 IPC TaskListByTeam（caller 在该 team active 才能调）
- **external mcp client 凭已知 task_id 查 task** use case：推翻（D8 flip false）。external client 仅能走 `task_list`（allow external）拉自己可见 scope（外部 client 是空）
- **hand_off ownership 跨 team 边界**：default 'clear-team' 把 team_id 清成 NULL 让 newSid 拿到 task 都可写（最大兼容）；'preserve-team' 让 caller 自负责任（adopt_teammates=true 让 newSid 接管 team）；'skip' 真删 caller team task + 仅过继 personal

## 不复活 global task 累积（plan §不变量 4）

- `tasks.owner_session_id NOT NULL FK → sessions(id) ON DELETE CASCADE` 仍兜底 GC：team 硬删触发 `team_id ON DELETE SET NULL`，task 退化 personal 仍挂 owner 名下；owner archive → LifecycleScheduler.historyRetentionDays TTL GC → CASCADE 删 task
- `team_id IS NULL` 不再是「累积入口」（v023 之前的 v007/v011 时代痛点已通过 v023 owner_session_id NOT NULL 改造解决，v024 不复活）
