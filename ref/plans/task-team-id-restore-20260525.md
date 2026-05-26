---
plan_id: "task-team-id-restore-20260525"
created_at: "2026-05-25T12:42:34+08:00"
worktree_path: "/Users/apple/Repository/personal/agent-deck/.claude/worktrees/task-team-id-restore-20260525"
status: "completed"
base_commit: "6cc7c6a96042d9828912421b95b7b78831e1d399"
base_branch: "main"
final_commit: "197c33942e62ac6dbcd6ab528ac37fffa4686393"
completed_at: "2026-05-25"
---
# Plan: task 表恢复 team_id 字段(nullable),消灭 lead 多 team task 串流 + hand_off ownership 边界

## 起源

REVIEW_53 fix(CHANGELOG_146) 在 v023 落地后,用户在「评估 mcp 格式一致性」过程中追加发现两个 RFC 未覆盖的边界缺陷:

1. **lead 多 team 时 task 跨 team 串流**:lead L 同时在 team A、team B,L 在 A 上下文 `task_create({subject:'A 专属任务'})` → owner=L,**无 team 标签**。team B 的 teammate Tb 调 `task_list()` → `getVisibleOwnerSessionIds(Tb)` 含 L(L 是 team B 的 active member)→ list 拿到 owner=L 的所有 task 包括 A 专属那条 🔥
2. **hand_off ownership 跨 team 边界缺位**:hand_off default baton 把 caller 全部 task 过继给 newSid,但 task 没 team 标签,过继后新 owner 与原 team 无 shared team → 新 session 撞 `isCallerAuthorizedToWrite` reject(F-R2-C 防御边界 jsdoc 已记但根因没解)

根因:v023 选择「team 是 derived 而非 stored」(reverse join `sessions → agent_deck_team_members` 算 team scope),消灭 global task 累积主目标达成,但**没**料到 lead 跨多 team 时 derived 算法会失真。

## 总目标

task 表恢复 `team_id TEXT NULL` 字段:
- **team_id != null** = team-bound task,可见性 / 写权限按 team 严格隔离
- **team_id IS NULL** = personal task(first-class 用例,无 team caller 也能用 task)
- **不复活 global task 累积问题**:owner_session_id NOT NULL 兜底 GC 不变,personal task 在 owner archive 后自动 CASCADE 删

修法核心:**team 从 derived 改回 stored**,team_id 作为权威字段;owner_session_id 仍 NOT NULL 兜底生命周期。两个字段各司其职:owner 管 GC,team 管 visibility/permission。

## 不变量

1. **task 必有 owner**:tasks.owner_session_id NOT NULL,CASCADE FK 兜底 GC(v023 不变量 1+2 沿用)
2. **personal task 是 first-class**:team_id IS NULL 是合法状态(RFC R1.Q1 用户强调「没有加入 team 也能起 task」)。personal task **仅 owner 可见可写**(含 task_get 也走 team-scoped read,详 §不变量 12 MED-1 修法 — Round 1)。**v023 → v024 推翻**(Round 2 HIGH-1):in-process caller 跨 team 读 task_get 的 use case + external mcp client 查自己已知 task_id 的 use case 都被 v024 推翻(详 D8)
3. **team task 严格隔离(read + write 对称)**:team_id != null 时 visibility(含 task_list / task_get) + 写权限 = caller 在该 team 是 active member(不再走 owner-derived sessions reverse join)。**task_get 不再 cross-team 可读**(MED-1 修法,Round 1)。**active = `agent_deck_team_members.left_at IS NULL AND agent_deck_teams.archived_at IS NULL` 双条件**(Round 2 MED-3 修法 — caller 主动 leave team 与 team archived 是两条独立路径,D3 read/write check 必走双条件)
4. **team 硬删 SET NULL 不复活 global task**:tasks.team_id ON DELETE SET NULL 让 team 删后 team task 退化为 personal task(仍挂 owner_session_id 名下)→ owner archive 后 CASCADE 删。**关键不同于 v007**:owner_session_id NOT NULL 仍兜底 GC,team_id NULL 不再是「累积入口」
5. **hand_off team_task_policy 三态 + archive_caller=false 优先级**:
   - 三态:`'clear-team'`(默认,过继 ownership + 设 team_id=null 变 personal) / `'preserve-team'`(过继 ownership 但保留 team_id) / `'skip'`(**handoff 时 handler 显式 `DELETE FROM tasks WHERE owner_session_id=callerSid AND team_id IS NOT NULL`** + cleanup blocks/blocked_by 引用 + emit task-changed deleted events;personal task 仍正常过继)
   - **'skip' 真删语义说明**(MED-1 修法,Round 2 user 拍板方案 A — 与 RFC mental model 一致):旧 plan 假设「caller archive 后 CASCADE 删」错误(`sessionManager.archive()` 仅 setArchived 不 DELETE FROM sessions,FK CASCADE 不触发);改为 handoff 时显式 SQL 删,语义干净零中间窗口
   - **archive_caller=false 优先级**:caller 显式 `archive_caller=false` 时**先于 reassign skip 整个过继逻辑**(沿用 v023 F1 修法),`team_task_policy` 不执行 — ok return `taskReassignment={status:'skipped', reason:'archive-caller-false', policy: <resolvedPolicy>}`(policy 字段仍透传 args.team_task_policy ?? 'clear-team' advisory — caller 知道传了什么但实际未执行)(MED-4 修法,Round 1 + Round 7 LOW-1 codex 补全 policy 字段)
   - **preserve-team caller 错配 warning 升级**(MED-7 + Round 2 MED-2 升级 + Round 3 HIGH-1 修正 + Round 4 HIGH-1 修正 — user 拍板方案 A soft warning):reassign 前 query caller owned distinct team_id(team_id IS NOT NULL),与 newSid handoff 后 active teams 比对;**有差集** → ok return `taskReassignment.policyWarning='preserve-team-unadopted-teams'` + `unadoptedTeamIds: string[]` 字段暴露根因(handler 不 hard reject 保留弹性,但 warning 让 caller 调试)。**newSid active teams 算法**(Round 4 HIGH-1 修正 — swap loop 有 **两处** teamsAdoptedCount++ 都需同步 push):phase15Detail 加新字段 `adoptedTeamIds: string[]`,**L814 firstTeam path** `teamsAdoptedCount++` 同时 `adoptedTeamIds.push(firstTeamId)` + **L839 rest loop** `teamsAdoptedCount++` 同时 `adoptedTeamIds.push(teamId)`(双方独立 grep 实证 L814 + L839 两处都 increment);newSidActiveTeamIds = `Set([...phase15Detail.adoptedTeamIds, ...(spawnData.teamId ? [spawnData.teamId] : [])])`。**enum 改名**:旧 `'preserve-team-without-adopt-teammates'` → 新 `'preserve-team-unadopted-teams'`(更精确)
6. **task_create 不传 team_id = personal task**:与 caller 是否在 team 无关,handler 不自动闭包(RFC R1.Q2 用户决策);caller 显式传 team_id 必须是 caller 自己所在的 active team(handler 校验);**ingest payload.teamName 字段同步**取自 args.team_id lookup,**不**走 `getCallerFirstTeamName(callerSid)` 避免多 team caller 显式传 team_id=B 但 first active team=A → payload 漂移到 A(MED-2 修法,Round 1)
7. **archived team filter 纪律**:agent_deck_teams.archived_at !== null 的 team 上 task 视为不可见(与 v023 F2 修法 + send_message active-shared filter 同款边界纪律)
8. **双端 prompt 资产同步 分层**(MED-3 修法,Round 1):
   - **Layer 1 — schemas.ts SSOT**(Step C1 改 zod `.describe('...')` 自动注入两端 SDK tool definitions):mcp tool args 字段定义(team_id / team_id_filter / team_task_policy 含义、enum 取值、约束)
   - **Layer 2 — convention docs**(Phase F1-F3 改 `resources/{claude-config/CLAUDE.md, codex-config/CODEX_AGENTS.md}` 双端 mirror):使用模式 + 决策依据(why personal default / why preserve-team caller 自负责任),**不**重复定义字段(SSOT 在 schemas.ts)
   - **Layer 3 — tool description**(Step C6 改 `src/main/agent-deck-mcp/tools/index.ts`):D2 personal default / D4 team_task_policy 三态 / D5 team_id_filter 三态 — 如不自动与 schemas describe 同源需手工同步
9. **migration 保留老数据**:v024 ALTER TABLE ADD COLUMN team_id TEXT NULL(RFC R2.Q3 用户决策)。老 task 自动 team_id=null 变 personal,行为兼容(老 task 本质无 team 标签)。**SQLite ALTER ADD COLUMN REFERENCES 是合法表达式**(v011_tasks_team_id.sql + v009_mcp_spawn_chain.sql production 实证,详 §已知踩坑 1 HIGH-1 修法)
10. **测试覆盖**:v024 migration test(ALTER 行为 + 老数据保留 + **v023→v024 跨版本 fixture 模拟真实升级路径**)+ task-repo test(team_id 写入 / list 过滤 / SET NULL 触发 / **cascade delete cross-team scenarios**)+ tools test(create 默认 personal / write permission team-scoped / **read permission team-scoped — task_get(含 external caller deny + in-process 跨 team reject + member left_at 路径 + team archived 路径)** / list team_id_filter 三态)+ hand_off test(三态 policy 分支 + 默认 clear-team + **`'skip' policy + archive_caller=true → handoff 时 handler 显式 DELETE team task + emit task-changed deleted events + caller archived 后 task 已不存在` assertion**(Round 2 MED-1 真删) + **preserve-team caller-as-teammate / lead 未 adopt → policyWarning='preserve-team-unadopted-teams' + unadoptedTeamIds 含正确 team_ids** assertion(Round 2 MED-2 升级)+ **archive_caller=false × 三 policy 组合断言**)
11. **现有不变量沿用**:`updatedAt` 不被 reassign 操作刷(v023 不变量 5)/ `reassignOwner` 仍是单 SQL 原子(`'skip'` 路径是独立 DELETE 不走 reassignOwner 接口)/ `caller==owner` 特例兜底防御深度(F-R2-C jsdoc 已记,但 D3 后 team task 路径**不再**走 owner-special-case — caller 必须在 team_id 是 active member 不论是否 owner)
12. **D3 签名 ripple — TaskRepo.delete predicate interface**(HIGH-2 修法,Round 1):`TaskRepo.delete` predicate 签名同步改成 `(id: string, task: Pick<TaskRecord, 'ownerSessionId' | 'teamId'>) => boolean`(或更直接 pass 整个 task);`task-repo.ts` deleteRecursive BFS pre-walk 拿到的 child 带 team_id 传 predicate;`task-delete.ts` cascade callsite 显式列出改造
13. **active-member 双条件定义 + member left_at 路径独立覆盖 + 反向镜像覆盖**(Round 2 MED-3 + Round 3 MED-2 修法):D3 active-member check 必走双条件 `agent_deck_team_members.left_at IS NULL AND agent_deck_teams.archived_at IS NULL`;member level 软退出(`left_at != null`)与 team level 硬归档(`archived_at != null`)是两条独立路径,test 必须**双路径分别覆盖**(不是合并测一条)。**反向镜像**(Round 3 MED-2):「caller leave team 后**其他 active member 仍能 read/write** task」是对称镜像 case — task-level 可见性是 per-active-member 不是 per-owner-leave,task 行不带 owner-leave 标志位;test 必须 case d 覆盖防 implementer 错误泛化「整 task 藏掉」(典型 use case lead 早退 reviewer 接手)。`agentDeckTeamRepo.findActiveMembershipsBySession` / `findSharedActiveTeams` 现有 SQL 已是双条件,本不变量是测试与文档纪律 align

## 设计决策(不再争论 — RFC 2 轮收口共识)

### D1: team_id 字段 NULLABLE(RFC R1.Q1 用户选 A + 强调「不加 team 也能起 task」)

tasks 表加 `team_id TEXT NULL REFERENCES agent_deck_teams(id) ON DELETE SET NULL`。NULL 表示 personal task(first-class 用例),非 NULL 表示 team-bound task。

**Why**: 用户原话「没有加入 team 也能起 task」明确 personal task 必须支持。NOT NULL 会强制所有 caller 必须先加入 team,破坏「lead 起 reviewer pair 不必加 team 也想用 task 跟踪」常见 use case。

**How to apply**: schema 加 `team_id TEXT NULL`,handler create 时未传 → null,与 caller 是否在 team **无关**(不自动闭包)。

### D2: task_create 不传 team_id = personal(RFC R1.Q2 用户选 A)

task_create handler 不再自动反查 caller 第一个 team 闭包 team_id(避免与「lead 多 team 串流」根因同型 — 隐式闭包等于 lead 都不知道 task 算给了哪个 team)。caller 显式传 team_id 才绑 team;不传就是 personal。

**Why**: 隐式闭包是「让 backend 替 caller 做决策」破坏显式控制。Personal default 让 caller 不感知 team 时也能用 task,完全无歧义。

**How to apply**: handler args.team_id optional;传时校验 caller 在该 team 是 active member(否则 reject);不传 → 落 null。

### D3: 写权限 team_id 决定(RFC R1.Q3 用户选 A)

- `team_id != null` → caller 必须在该 team 是 active member(单一 SQL JOIN agent_deck_team_members 验证)
- `team_id IS NULL` → caller == owner 才能写(personal task 不开放同 team 共享)

**Why**: team_id 是 team-bound task 的权威标签,直接按它判权限语义最清晰。Personal task 仅 owner 可见可写避免「lead 自己 personal task 被同 team teammate 偷看 / 偷改」。

**How to apply**(含 HIGH-2 修法 ripple,Round 1):
1. handler `isCallerAuthorizedToWrite(callerSid, task)` 改签名(从 `(callerSid, ownerSid)` 改成 `(callerSid, task)` 拿到 team_id);分支按 team_id null vs not null 走两套 check
2. **handler 镜像 isCallerAuthorizedToRead(callerSid, task)**:read 路径(task_get / task_list 团 visibility)对称按 team_id 判读权限(personal owner-only / team-bound active-member-only)(MED-1 修法,Round 1)
3. **TaskRepo.delete predicate 签名同步改造**(HIGH-2 + reviewer-codex MED-2 双方独立):
   - `TaskRepo.delete(id, opts)` predicate 签名从 `(id: string, ownerSessionId: string) => boolean` 改成 `(id: string, task: Pick<TaskRecord, 'ownerSessionId' | 'teamId'>) => boolean`
   - `task-repo.ts:319 deleteRecursive` BFS pre-walk 实现同步拿到 child 完整 task row 传 predicate
   - `task-delete.ts:71` cascade callsite 改 `predicate: (_id, child) => isCallerAuthorizedToWrite(callerSid, child)`
   - `task-delete.ts:33` root check 改 `isCallerAuthorizedToWrite(callerSid, target)`(同款 task 对象传递)
4. **ownerMap pre-walk 兼容性**:`task-delete.ts:47-67` 的 ownerMap(emit `task-changed` ownerSessionId 用)逻辑保留,但 BFS pre-walk 已能拿到 child 完整 task → 简化 ownerMap 为 fallback 用(若 future repo BFS 改 predicate 调用点不再 emit child task,fallback 走 root owner)

### D4: hand_off team_task_policy 3 态 enum 默认 'clear-team'(RFC R2.Q1 用户选 A)

hand_off_session args 加 optional `team_task_policy: 'clear-team' | 'preserve-team' | 'skip'`,默认 `'clear-team'`:

- **'clear-team'**(default): `UPDATE tasks SET owner_session_id=newSid, team_id=NULL WHERE owner_session_id=callerSid` — 过继 ownership 同时清 team_id 变 personal,保最大兼容性(newSid 拿到的 task 都可写)
- **'preserve-team'**: 仅过继 ownership 不动 team_id — caller 自行保证 adopt_teammates=true 让 newSid 接管 team 当 lead,否则 newSid 撞写权限 reject(预期行为,caller 自负责任)
- **'skip'**(Round 2 MED-1 修法,user 拍板方案 A — 真删,与 RFC mental model 一致): handler 显式 `DELETE FROM tasks WHERE owner_session_id=callerSid AND team_id IS NOT NULL` + cleanup blocks/blocked_by 引用 + emit task-changed deleted events(每行被删的 task 都 emit);personal task(team_id IS NULL) 仍正常过继给 newSid。**不依赖** caller archive 后 FK CASCADE(原 plan 假设 archive → CASCADE 删错误 — `sessionManager.archive()` 仅 setArchived 不 DELETE FROM sessions,FK CASCADE 不触发)

**优先级与 archive_caller=false 互动**(MED-4 修法,Round 1):
- caller 显式 `archive_caller=false` 时**先于** policy 执行 skip 整个 reassign 段(沿用 v023 F1 修法,caller 仍 active 继续 own 自己的 task)
- ok return `taskReassignment={status:'skipped', reason:'archive-caller-false', policy: <resolvedPolicy>}`(policy 字段仍透传 args.team_task_policy ?? 'clear-team' advisory — caller 知道传了什么但实际未执行)(Round 7 LOW-1 codex 补全 policy 字段)
- 文档化:`archive_caller=false` × `team_task_policy=*` 全部走 skip;policy 仅在 `archive_caller=true`(默认)路径生效

**preserve-team caller 错配 warning**(MED-7 修法,Round 1 + Round 2 MED-2 升级 — user 拍板方案 A soft warning):
- caller 显式 `team_task_policy='preserve-team'` 时,reassign 前 query caller owned distinct `team_id`(team_id IS NOT NULL),与 newSid handoff 后 active teams 比对:
  - newSid active teams = `adopt_teammates=true` 通过 swapLead 接管成功的 caller-as-lead teams ∪ args.team_name 显式让 newSid 进的 team(若有)
  - **caller-as-teammate teams**(adopt 路径 push failed reason='caller-not-lead-in-team')**不**进 newSid active teams — 这是 Round 2 MED-2 reviewer-codex 现场 grep `hand-off-session.ts:686-691` 实证 ✅
- **有差集**(caller owned 但 newSid 不在的 team_ids)→ ok return `taskReassignment.policyWarning='preserve-team-unadopted-teams'` + `unadoptedTeamIds: string[]` 字段含差集 team_id 列表
- handler **不 hard reject**(F-R2-C 防御深度同款理由 — 保留弹性,caller 显式选 preserve-team 接受降级);仅 warning 让 caller 知情决定 retry / 接受 newSid 拿到 task 但不可写
- **enum 改名**:旧 R1 提的 `'preserve-team-without-adopt-teammates'` → 新 `'preserve-team-unadopted-teams'`(更精确,涵盖 caller-as-teammate 场景 — `adopt_teammates=true` 也可能漏 teammate-only team)

**Why**: 用户「加一个参数 可选吧 这样更加灵活」明确要 caller 控制权。Default `clear-team` 最不破坏 caller 工作(personal 可写不丢 task);其他两态留 caller 显式精控。'skip' 真删走 user RFC mental model 一致路径;policyWarning 升级版完整覆盖 caller-as-teammate 场景避免被动调试地狱。

**How to apply**: hand_off-session handler reassign 段加 args.team_task_policy 分支,3 个 SQL/逻辑路径独立('skip' 走单独 DELETE 不走 reassignOwner 接口)+ ok return `taskReassignment` 字段加 `policy` field + 可选 `policyWarning` field + 可选 `unadoptedTeamIds: string[]` field 告诉 caller 走的哪条 / 是否触发错配 warning / 哪些 team_id 没被 adopt。

### D8: task_get external caller 路径 — flip EXTERNAL_CALLER_ALLOWED.task_get = false(Round 2 HIGH-1 修法,user 拍板方案 A)

v023 task_get 设计明示三处 commitment:
- `EXTERNAL_CALLER_ALLOWED.task_get = true`(types.ts:144 + jsdoc:126-127「task_list / task_get allow external(只读没 spoofing 风险;合法 read-only mcp client 查询自己已知 task_id 是合法 use case)」)
- `task-get.ts:1-7` file header「跨 team 只读」+ jsdoc「read-only cross-team visibility」
- `task-helpers.ts:8-9` jsdoc 「getVisibleOwnerSessionIds 跨 team / task_get 不限 team scope」

MED-1 修法把 task_get 改为严格 team-scoped read 后,这三处 commitment 直接被推翻。如不同步处理 → silent zombie(API contract 允许 external / 实际永 reject)。

**决策(user 拍板方案 A)**: `EXTERNAL_CALLER_ALLOWED.task_get` flip false,与 task_create/update/delete 同款 deny external 写权限对称。read scope 也走同款 deny。

**Why**: 与 task_create/update/delete 一致 deny external 对称语义;消除 silent zombie 状态;external mcp client 拿到明确 error 而非 silent reject 困惑。v024 后 task tool**仅** task_list / task_get(此处 flip false 后)的 `task_list` 仍 allow external — list 返空对未在 caller team 的 external client 是合理 (read-only cross-team **可见性 scope** allow external 不破坏 active member 边界)。

**How to apply**:
1. `src/main/agent-deck-mcp/types.ts:144` flip `task_get: true` → `task_get: false`
2. `src/main/agent-deck-mcp/types.ts:126-127` jsdoc 改写:`task_list allow external (返空对未在 caller team 的 external client 合理)`;**删** task_get 「allow external」段
3. `src/main/agent-deck-mcp/tools/handlers/task-get.ts:1-7` file header 删「跨 team 只读」,改成「按 D3 镜像 read 权限:personal owner-only / team-bound active-member-only;deny external」
4. `src/main/agent-deck-mcp/tools/handlers/task-get.ts:7` jsdoc 删 `read-only cross-team visibility` 描述
5. ~~`src/main/agent-deck-mcp/tools/handlers/task-helpers.ts:8-9` jsdoc 删 task_get 跨 team scope 描述~~ **(Round 3 LOW-1 修法 — reference 错;实际 task-helpers.ts:8-9 jsdoc 描述 `getVisibleOwnerSessionIds` 行为无 task_get 字样;改成:`grep "task_get|跨 team|cross-team|read-only" src/main/agent-deck-mcp/tools/handlers/task-helpers.ts` 确认无 stale 描述,如有则删 — 当前 grep 0 命中,nothing-to-do)**
6. handler body 加 `isCallerAuthorizedToRead(callerSid, t)` check(MED-1 修法落地)— external caller 已被 `withMcpGuard` 拦截不到 handler,本 check 仅服务 in-process caller 的 team scope 校验
7. 测试覆盖:external caller 调 task_get → withMcpGuard 拦截返 deny-external error + in-process caller 跨 team 调 → isCallerAuthorizedToRead reject(详 §测试覆盖矩阵)

**v023 → v024 use case 推翻明示**:
- **in-process lead 跨 team 看 teammate task** use case → 推翻(D3 严格 team-scoped 读)。lead 想看跨 team teammate task 应走「让 lead 加入对方 team 作为 active member」或显式 IPC TaskListByTeam(若 lead 在该 team active)
- **external mcp client 凭已知 task_id 查 task** use case → 推翻(D8 flip false)。external client 若需要查 task,只能走 task_list(allow external)拉自己可见 scope(对外部 client 是空)
- **IPC TaskListByTeam / AgentDeckTeamGetFull** 路径 → 已走严格 team_id 过滤(D7),不受 D8 影响

### D5: task_list 加 team_id_filter arg(RFC R2.Q2 用户选 A)

mcp `task_list` 加 optional `team_id_filter?: string | 'null-personal'`:

- 不传 → 默认返「caller 可见所有 task」(caller-owned personal ∪ caller 所在所有 active team 的 team task)
- 传具体 team_id → 返该 team 绑定的 task(caller 必须在该 team 是 active member,否则 reject)
- 传字面量 `'null-personal'` → 返 caller 自己的 personal task(owner == caller AND team_id IS NULL)

IPC `TaskListByTeam` / `AgentDeckTeamGetFull` 改走同款 team_id_filter 路径(team_id == X AND team active 严格过滤)。

**Why**: 用户原话「团队页面只显示对应 team 的 task」直接对应 team_id strict filter。`'null-personal'` 字面量让 caller 也能拉自己 personal task(不混 team task)。

**How to apply**: schemas.ts TASK_LIST_SCHEMA 加字段;handler 三态 if/else 分流;IPC TaskListByTeam 走 `taskRepo.list({teamId, limit})` 新接口。

### D6: v024 ALTER TABLE ADD COLUMN(RFC R2.Q3 用户选 B)

v024 migration:`ALTER TABLE tasks ADD COLUMN team_id TEXT NULL REFERENCES agent_deck_teams(id) ON DELETE SET NULL` + 加索引。老 task 自动 team_id=null 变 personal task(行为正确 — 老 task 本就无 team 标签)。

**Why**: dev 阶段虽可 drop 但 v023 是上个 cycle 刚做的(用户在用),没必要再 drop。ALTER 是安全的 schema 操作(SQLite 支持 ADD COLUMN with default),老数据自动兼容。

**How to apply**: 写 `v024_tasks_add_team_id.sql` ALTER + CREATE INDEX,注册到 `migrations/index.ts`。

### D7: UI 团队面板按 team_id 严格过滤(隐式从 D5 推导)

IPC `TaskListByTeam` / `AgentDeckTeamGetFull` 改成 `taskRepo.list({teamId, limit})` 走 D5 team_id_filter 路径。**不再** reverse join member sids(那是 v023 路径,造成 lead 多 team task 串流到团队面板的根因)。

**Why**: 用户原话「团队页面只显示对应 team_id 的 task」明确要严格按 team_id 过滤;旧 reverse join 同源根因要切干净。

**How to apply**: 改 `ipc/teams.ts:349 TaskListByTeam` + `:96 AgentDeckTeamGetFull` 两处 query。

## 步骤 checklist

### Phase A - Migration + 类型层
- [ ] Step A1: 写 `src/main/store/migrations/v024_tasks_add_team_id.sql` — **1:1 复用 v011_tasks_team_id.sql 模板**(HIGH-1 修法,Round 1):`ALTER TABLE tasks ADD COLUMN team_id TEXT REFERENCES agent_deck_teams(id) ON DELETE SET NULL` + `CREATE INDEX idx_tasks_team_id`。v011/v009 已 production 实证同款语句合法(详 §已知踩坑 1)— **无需 spike**
- [ ] Step A2: 注册 v024 到 `src/main/store/migrations/index.ts`
- [ ] Step A3: 改 `src/shared/types/task.ts`:TaskRecord 加 `teamId: string | null` 字段 + jsdoc 同步 v024 重设计

### Phase B - Repo 层
- [ ] Step B1: 改 `src/main/store/task-repo.ts`(HIGH-2 修法显式列出 ripple,Round 1 + Round 3 MED-1 新 applyHandOffSkipPolicy helper):
  - Row interface 加 team_id
  - create accept teamId
  - update 允许改 teamId(用于 hand_off clear-team)
  - list 加 teamId filter 参数(支持 string | 'null-personal' | undefined 三态)
  - reassignOwner 加 `policy` 参数让 hand_off 分支控制(`'clear-team' | 'preserve-team'`;**不**含 `'skip'` — skip 走新 applyHandOffSkipPolicy helper)
  - **`TaskRepo.delete(id, opts)` predicate 签名改造**:从 `(id: string, ownerSessionId: string) => boolean` 改成 `(id: string, task: Pick<TaskRecord, 'ownerSessionId' | 'teamId'>) => boolean`
  - **`deleteRecursive` BFS pre-walk 实现同步改造**:每个 child node 拿到完整 task row(或至少 ownerSessionId + teamId)传 predicate,不再只查 ownerSessionId
  - **新增 `applyHandOffSkipPolicy(callerSid, newSid)` repo-level helper**(Round 3 MED-1 修法 — 单 transaction 收口 'skip' 三件事原子性):
    - 签名:`applyHandOffSkipPolicy(callerSid: string, newSid: string): { deletedTeamTaskIds: string[]; reassignedPersonalCount: number }`
    - 实现:在单个 `db.transaction()` 内串行 4 步:
      1. `SELECT id FROM tasks WHERE owner_session_id=? AND team_id IS NOT NULL` → 拿 deletedTeamTaskIds snapshot(handler 后续 emit 用)
      2. chunked `DELETE FROM tasks WHERE id IN (?)`(CHUNK=500 防 IN 999 上限,参考 task-repo.ts:340-405 现有 chunked DELETE 模式)
      3. **blocks/blocked_by 引用 cleanup**:同 transaction 内 SELECT survivors → 过滤 blocks / blocked_by 引用 deletedTeamTaskIds 的项 → UPDATE 写回(与 taskRepo.delete cascade=false 现有 cleanup 模式同款 — task-repo.ts:364-403)
      4. `UPDATE tasks SET owner_session_id=? WHERE owner_session_id=? AND team_id IS NULL` → reassign 剩余 personal task(personal 仍正常过继 newSid)
    - transaction commit → return `{deletedTeamTaskIds, reassignedPersonalCount}`(deletedTeamTaskIds 让 handler 端 emit task-changed deleted events 每行调用)
- [ ] Step B2: task-repo test 加 case(Round 5 MED-1 修法 — applyHandOffSkipPolicy / cascade delete / reassignOwner policy / list filter 测试**全部 fold 到 Step G2** 单一 SSOT,B2 仅留 schema 改造 trivial scope):
  - team_id 字段 INSERT(create 含 teamId 落地行)
  - team_id 字段 FK SET NULL 触发(团 hard delete 后行 team_id 自动 null;`PRAGMA foreign_key_list(tasks)` 验 ON DELETE SET NULL constraint 注册)
  - (cascade delete cross-team / reassignOwner policy 两态 / applyHandOffSkipPolicy case A/B/C / list 三态 filter 全权交 Step G2,本 step 不重复列)

### Phase C - mcp handler 层
- [ ] Step C1: 改 `src/main/agent-deck-mcp/tools/schemas.ts`(MED-3 Layer 1 SSOT,Round 1 + Round 2 D8 / MED-2 升级):
  - TASK_CREATE_SCHEMA 加 `team_id` optional + **short-form** describe「team_id?: string — 不传 = personal(仅 owner 可见可写);传 = caller 必在该 active team(详 convention docs §task)」(Round 2 LOW-5 — Layer 1 内容粒度 short-form + cross-reference,不写 long-form usage)
  - TASK_LIST_SCHEMA 加 `team_id_filter` optional + **short-form** describe「team_id_filter?: string | 'null-personal' — undefined=caller 可见 scope / string=该 team(caller 必在) / 'null-personal'=caller 自己 personal task(详 convention docs §task)」
  - **TASK_GET_SCHEMA describe 改写**(MED-1 + Round 2 D8 修法):**删** 现有「跨 team 可读」描述,改为 short-form「按 D3 镜像 read 权限 + deny external(详 convention docs §task)」;caller_session_id describe 同步说明 external 被 EXTERNAL_CALLER_ALLOWED.task_get=false 拦截
  - TaskRecord 字段同步(从 @shared 拉)加 teamId
  - HAND_OFF_SESSION_SHAPE 加 `team_task_policy` enum optional + short-form describe「'clear-team'(default)/'preserve-team'/'skip' — archive_caller=false 时 policy 不执行(详 convention docs §hand_off)」
  - HandOffSessionResult.taskReassignment 加 `policy: 'clear-team' | 'preserve-team' | 'skip'` field + 可选 `policyWarning?: 'preserve-team-unadopted-teams'` field(Round 2 MED-2 升级 enum 改名)+ 可选 `unadoptedTeamIds?: string[]` field(差集 team_id 列表)
  - **HandOffSessionResult.adopted 加 `adoptedTeamIds: string[]` field surface**(Round 4 MED-1 修法 — observability gap;phase15Detail 已收集 adoptedTeamIds 后 spread 到 ok return adopted block,与 `preserved: string[]`(sids)对称暴露 caller `adoptedTeamIds`(team uuids)便于 diag policyWarning 来源):shape 加 `adoptedTeamIds: string[]`(default 空数组,non-adopt 路径 adopted=null 不出现该字段)
- [ ] Step C2: 改 `src/main/agent-deck-mcp/tools/handlers/task-create.ts`:
  - 加 team_id 校验(传时校验 caller 在该 team active member,否则 reject);不传 → null
  - **ingest payload.teamName 改造**(MED-2 修法,Round 1 + Round 2 LOW-3 修正 helper 名 + Round 3 MED-3 修正 method 名 — Round 2 写的 `findById` 不存在,实际接口 `get(teamId)`,grep `agent-deck-team-repo/index.ts:59-65` 实证 + hand-off-session.ts:464/508/513 多处用 `.get(...)`):L55-66 ingest payload 改 `teamName: args.team_id ? (agentDeckTeamRepo.get(args.team_id)?.name ?? null) : null` — 不再走 `getCallerFirstTeamName(callerSid)`(D2 落地后 first active team 不等于显式传的 team_id 会漂移)。`agentDeckTeamRepo` 已 imported 多处
- [ ] Step C3: 改 `src/main/agent-deck-mcp/tools/handlers/task-list.ts`:三态分流(undefined / 具体 team_id / 'null-personal');具体 team_id 时校验 caller 在该 team active member
- [ ] Step C4: 改 `src/main/agent-deck-mcp/tools/handlers/task-update.ts` + `task-delete.ts`(HIGH-2 显式 callsite,Round 1):
  - `task-update.ts`:isCallerAuthorizedToWrite(callerSid, existing) 改签名传整个 task
  - `task-delete.ts:33` root check:`isCallerAuthorizedToWrite(callerSid, target)` 传整个 task
  - **`task-delete.ts:71` cascade predicate callsite**:`predicate: (_id, child) => isCallerAuthorizedToWrite(callerSid, child)`(child 是 `Pick<TaskRecord, 'ownerSessionId' | 'teamId'>`)
  - 配合 Step B1 predicate signature 改造
- [ ] Step C5: 改 `src/main/agent-deck-mcp/tools/handlers/task-helpers.ts`(Round 1 含 MED-1 镜像):
  - `isCallerAuthorizedToWrite(callerSid, task)` 重写:按 team_id null vs not null 分支
  - **新增 `isCallerAuthorizedToRead(callerSid, task)` helper**(MED-1):read 路径对称(personal owner-only / team-bound active-member-only)
  - `getVisibleOwnerSessionIds` 标 deprecated → 改成 `getVisibleTaskScope(callerSid)` 返 `{teamIds: string[], includeOwnPersonal: true}` 让 query 端用 `(team_id IN teamIds) OR (team_id IS NULL AND owner_session_id == callerSid)` 一次 SQL 拿到
- [ ] Step C6: 改 `src/main/agent-deck-mcp/tools/index.ts` — **task 类 tool description**(MED-3 Layer 3,Round 1 + Round 2 LOW-4 拆分 + Round 3 LOW-2 显式 before/after 字符串):
  - `task_create` / `task_list` tool description 同步 D2 personal default / D5 team_id_filter 三态(若 tool description 不自动从 schemas describe 同源,需手工写)
  - **`task_get` tool description 显式改造**(Round 3 LOW-2 修法 — 防 implementer 漏改字符串):
    - **Before**(`tools/index.ts:389` 当前):`'Get a single task by id. Returns the task regardless of team scope (read-only cross-team visibility).'`
    - **After**(D8 后):`'Get a single task by id, scoped to caller team membership (team-bound task: caller must be active member; personal task: caller must be owner). Deny external caller (EXTERNAL_CALLER_ALLOWED.task_get=false).'`
  - **hand_off_session tool description 拆到 Step D3**(避免与 Phase D 边界模糊)
- [ ] **Step C7**: 改 `src/main/agent-deck-mcp/tools/handlers/task-get.ts`(MED-1 + Round 2 D8 修法,user 拍板方案 A flip false):
  - handler body 加 `isCallerAuthorizedToRead(callerSid, t)` check;不通过 → reject(语义对齐 update/delete write reject)
  - **`src/main/agent-deck-mcp/types.ts:144` flip `task_get: true` → `task_get: false`**(与 task_create/update/delete 同款 deny external 对称);external caller 走 withMcpGuard 入口 denyExternalIfNotAllowed 拦截返明确 error,**不再** silent reject
  - 同步删 `src/main/agent-deck-mcp/types.ts:126-127` jsdoc 中 task_get 「allow external」段;task_list 仍 allow external(read-only cross-team **可见性 scope** 不破坏 active member 边界)
  - 同步删 `src/main/agent-deck-mcp/tools/handlers/task-get.ts:1-7` file header 「跨 team 只读」+ jsdoc:7 「read-only cross-team visibility」描述
  - ~~同步删 `src/main/agent-deck-mcp/tools/handlers/task-helpers.ts:8-9` jsdoc task_get 跨 team scope 描述~~ **(Round 3 LOW-1 修法 — 该 reference 错,task-helpers.ts:8-9 jsdoc 实际描述 `getVisibleOwnerSessionIds` 行为无 task_get 字样;改成:`grep "task_get|跨 team|cross-team|read-only" src/main/agent-deck-mcp/tools/handlers/task-helpers.ts` 确认无 stale 描述,如有则删 — 当前 grep 0 命中,nothing-to-do)**
  - **更新现有 allow-external test 断言**(Round 4 MED-4 修法,reviewer-codex 现场 grep 8 处旧 contract):
    - `src/main/agent-deck-mcp/__tests__/task-external-caller.test.ts:45` 改 `expect(EXTERNAL_CALLER_ALLOWED.task_get).toBe(true)` → `toBe(false)`
    - `task-external-caller.test.ts:63-65` 移除 task_get 从「2 读 tool 全 ALLOW」HTTP case,改成「task_list 1 个 ALLOW」+ task_get 单独 DENY case
    - **`task-external-caller.test.ts:81-83` 同款改造 stdio 分支**(Round 5 MED-3 修法 — D8 flip false 必须双 transport 一致;codex 现场 nl -ba :63-83 实证 stdio 与 HTTP 两个 allow block 对偶):`it.each(['task_list','task_get'])` stdio ALLOW 改成 `it.each(['task_list'])` + task_get 独立 stdio DENY case
    - `src/main/agent-deck-mcp/__tests__/spoofing-attack-paths.test.ts:307-308` + `:316-322` 注释 + (A)+(B) it block 移除 task_get,改成 task_list 单独 ALLOW + task_get 单独 DENY case
    - `src/main/agent-deck-mcp/__tests__/task-crud.test.ts:7` jsdoc 删「task_get 跨 team 只读」描述 + `:331` `describe('task_get — 跨 team 只读', ...)` 改名 `describe('task_get — team-scoped read', ...)` + 内部断言改成 reject case(caller 不在 team_id 或 personal 非 owner → reject)
  - test 加 case:external caller 调 task_get → withMcpGuard 拦截返 deny-external error(不依赖 isCallerAuthorizedToRead 自然 reject)

### Phase D - hand_off 层
- [ ] Step D1: 改 `src/main/agent-deck-mcp/tools/schemas.ts`:已在 Step C1 SSOT 节 cover(team_task_policy enum / taskReassignment policy + policyWarning('preserve-team-unadopted-teams') + unadoptedTeamIds field — Round 2 MED-2 升级)
- [ ] Step D2: 改 `src/main/agent-deck-mcp/tools/handlers/hand-off-session.ts`(Round 1 含 MED-4 + MED-7 + Round 2 MED-1 + MED-2 + Round 3 HIGH-1 + MED-1):
  - reassign 段加 `args.team_task_policy ?? 'clear-team'` 三分支(clear-team / preserve-team / skip)
  - **archive_caller=false 优先级**:沿用现有 L878-880 skip 路径 `if (args.archive_caller === false) → taskReassignment = {status:'skipped', reason:'archive-caller-false'}`,**确保此分支先于 policy 判断**;ok return 中 policy 字段仍透传 args.team_task_policy ?? 'clear-team' 但 status=skipped 表明未执行
  - **'clear-team' 分支**:走 `taskRepo.reassignOwner(callerSid, newSid, {policy: 'clear-team'})` 单 SQL UPDATE owner + team_id=NULL
  - **'preserve-team' 分支**:走 `taskRepo.reassignOwner(callerSid, newSid, {policy: 'preserve-team'})` 单 SQL UPDATE owner 不动 team_id;**preserve-team safety 升级**(Round 2 MED-2 + Round 3 HIGH-1 + Round 4 HIGH-1 修正,user 拍板方案 A soft warning):
    - reassign 前 query caller owned distinct `team_id`(team_id IS NOT NULL)→ `Set<string> callerOwnedTeamIds`
    - **算 newSid handoff 后 active teamIds**(Round 3 HIGH-1 + Round 4 HIGH-1 修正 — `phase15Detail.preserved` 是 teammate sessionIds 不是 teamIds + swap loop **两处** teamsAdoptedCount++ 都需 push):
      - **方法 1(推荐 — 加 adoptedTeamIds 字段,Round 4 HIGH-1 完整 firstTeam + rest 双 push)**:`phase15Detail` 加新字段 `adoptedTeamIds: string[]`(初始 `[]`)
        - **L814 firstTeam path** `teamsAdoptedCount++` 同时 `adoptedTeamIds.push(firstTeamId)`
        - **L839 rest loop** `teamsAdoptedCount++` 同时 `adoptedTeamIds.push(teamId)`
        - 现场 grep 实证两处都 increment(L681 init `let teamsAdoptedCount = 0` + L814/L839 两处 ++)
        - 实施 hint:可重构 `processSwappedTeam(teamId)` helper 内统一 `adoptedTeamIds.push(teamId)` 集中责任,避免双 push 同步漂移
      - **方法 2(反算)**:从 adopt 流程 snapshot 拿 callerLeadMemberships teamIds(全部) `.filter(tid => !phase15Detail.failed.some(f => f.teamId === tid))` — 注意 `phase15Detail.failed.reason` 涵盖多种值全部都要过滤
      - 选方法 1(更直接,不易遗漏 failed reason 枚举值;实施重构 processSwappedTeam 集中 push 更安全)
    - 加 `args.team_name` 显式让 newSid 进的 team:`spawnData.teamId`(实际 team uuid,不是 team_name 字符串)加入集合;无 args.team_name 时 spawnData.teamId === null skip
    - 最终 `newSidActiveTeamIds = new Set([...phase15Detail.adoptedTeamIds, ...(spawnData.teamId ? [spawnData.teamId] : [])])`
    - 差集:`unadoptedTeamIds = [...callerOwnedTeamIds].filter(t => !newSidActiveTeamIds.has(t))`
    - 差集非空 → `taskReassignment.policyWarning = 'preserve-team-unadopted-teams'` + `unadoptedTeamIds: <差集>`
    - handler **不 reject**(soft warning,与 F-R2-C 防御深度 ergonomics 一致)
  - **'skip' 分支**(Round 2 MED-1 真删 + Round 3 MED-1 收口 + Round 4 HIGH-2/MED-2/MED-3 fix + Round 6 MED-1 fold — user 拍板方案 A,**新增 repo helper 单 transaction 收口三件事原子性 + handler safeEmit 显式调用 + DB throw fallback**):
    - **调 Step B1 新增 helper `taskRepo.applyHandOffSkipPolicy(callerSid, newSid)`**(Round 6 MED-1 fold 修法 — 与 R5 MED-1 同型 SSOT 修法,Step D2 不复述 4 步实现细节避免 SSOT 漂移)
      - **接口契约**(SSOT 在 Step B1 L186-193,本处仅引用):`(callerSid: string, newSid: string) => { deletedTeamTaskIds: string[]; reassignedPersonalCount: number }`
      - 行为:helper 走单 `db.transaction()` 内原子化 4 步(SELECT 团 task ids → chunked DELETE → blocks/blocked_by cleanup → reassign personal)— **详 Step B1 L186-193 实现指南**
      - return:handler 端用 `result.deletedTeamTaskIds` 做后续 safeEmit + 用 `result.reassignedPersonalCount + result.deletedTeamTaskIds.length` 做 ok return count
    - **handler 端 commit 后调 — 单一完整伪代码**(Round 4 MED-2 + MED-3 + Round 5 MED-4 + Round 6 MED-2 + Round 7 LOW-1 修法 — 整合 outer try/catch + 内嵌 safeEmit loop + 所有分支 assignment 必带 policy field 满足 schemas.ts taskReassignment shape required policy 契约;**`taskPolicy` const 必须在 reassign 段顶部声明(在 args.archive_caller / args.team_task_policy 三分支判断之前),让 4 个 assignment 路径(skip ok / skip failed / clear-team / preserve-team / archive_caller=false)共用同一外层 scope** — 下方伪代码块 L1 `const taskPolicy = ...` 仅是示意,implementer 实施时该 const 应放在 reassign 段顶部 / 三 branch if/else 之前,而非 'skip' 分支内 block scope):
      ```ts
      // Round 6 MED-2: 所有 taskReassignment assignment 必带 policy field 满足 schemas.ts shape required policy 契约
      const taskPolicy: 'clear-team' | 'preserve-team' | 'skip' = args.team_task_policy ?? 'clear-team';
      let taskReassignment: HandOffSessionResult['taskReassignment'];
      try {
        const result = taskRepo.applyHandOffSkipPolicy(callerSid, newSid);
        // safeEmit per id(Round 4 MED-3 — inner try/catch + continue,沿用 hand-off-session.ts:754-763 现有 safeEmit pattern)
        for (const id of result.deletedTeamTaskIds) {
          try {
            eventBus.emit('task-changed', {
              kind: 'deleted',
              taskId: id,
              task: null,
              ownerSessionId: callerSid,
              ts: Date.now(),
            });
          } catch (e) {
            console.warn(`[hand_off skip] emit task-changed deleted ${id} failed (continuing):`, e);
          }
        }
        taskReassignment = {
          status: 'ok',
          count: result.deletedTeamTaskIds.length + result.reassignedPersonalCount,
          policy: taskPolicy, // Round 6 MED-2: required field
        };
      } catch (e) {
        // Round 4 MED-2 DB throw fallback — applyHandOffSkipPolicy throw → catch → status='failed' 不抛错给 caller
        // (spawn/adopt 已 commit 不回滚 — v023 §不变量 12 同款 sane fallback)
        console.warn(`[mcp hand_off_session] applyHandOffSkipPolicy threw (continuing — spawn/adopt 已成功不回滚):`, e);
        taskReassignment = {
          status: 'failed',
          error: e instanceof Error ? e.message : String(e),
          policy: taskPolicy, // Round 6 MED-2: required field
        };
      }
      ```
      **嵌套层级语义**(Round 5 MED-4 显式锁住):
      - safeEmit loop **嵌入 outer try 内**(commit 后 result 可用),catch 分支自然跳过 emit(result 不存在)
      - safeEmit listener throw 走 **inner continue 不冒泡** outer catch — emit 失败不影响 taskReassignment=ok
      - DB throw 时 outer catch 设置 status='failed' + error 字段,**deletedTeamTaskIds 已 throw 不存在** emit 自然跳过(safeEmit loop 在 try 内,catch 不执行 emit)
      - **不抛错给 caller**(spawn/adopt 已 commit 不可逆 — v023 §不变量 12 同款);ok return 走 status='failed' + error 让 caller 知道 fallback
      - **policy field required**(Round 6 MED-2 修法):无论 ok / failed / skipped 哪条 assignment 路径,`policy: taskPolicy` 都必带,与 schemas.ts HandOffSessionResult.taskReassignment shape 契约对齐
    - **不**走 `taskRepo.delete(id, {cascade: false})` 逐个删(每次自开 transaction 撞 R3 MED-1 原子性问题)+ **不**走 `taskRepo.reassignOwner(_, _, {policy: 'skip'})`(Round 4 HIGH-2 修法 — Step B1 已明确 `reassignOwner` 只支持 `'clear-team' | 'preserve-team'` 不含 `'skip'`,personal task reassign 已并入 applyHandOffSkipPolicy step 4)
  - 透传 ok return:`policy` field(必带 — Round 6 MED-2)+ 可选 `policyWarning` field + 可选 `unadoptedTeamIds` field
  - **clear-team / preserve-team 分支同款 policy field**(Round 6 MED-2 修法):L242 `clear-team 分支` + L243-261 `preserve-team 分支` reassignOwner 调用后,assignment 同款用 `taskPolicy` 局部常量带 `policy: taskPolicy`(与 'skip' 分支单一伪代码块同款 pattern,SSOT 单一)
  - **archive_caller=false 优先级 policy 透传**(Round 6 MED-2 修法 — Round 5 在 D4 已 mention「policy 字段值不影响」但伪代码缺示例):assignment 改成 `taskReassignment = { status: 'skipped', reason: 'archive-caller-false', policy: taskPolicy }`(taskPolicy 仍取 args.team_task_policy ?? 'clear-team',不论实际有无执行 policy)
  - **`adopted.adoptedTeamIds` spread mapping 显式 wire**(Round 5 LOW-2 修法 — Step C1 仅 schema shape 加字段 / Step D2 上方仅讲 phase15Detail.adoptedTeamIds **内部** push,本处显式 wire ok return surface):handler return 段 ok return.adopted block 必须 **spread `adoptedTeamIds: phase15Detail.adoptedTeamIds`**(与 `preserved` 字段并列,确保 caller-facing surface 与 phase15Detail.adoptedTeamIds 同源,implementer 不能漏)
- [ ] **Step D3**(Round 2 LOW-4 修法,拆出 hand_off tool description + Round 3 LOW-4 补 unadoptedTeamIds 字段含义): 改 `src/main/agent-deck-mcp/tools/index.ts` — `hand_off_session` tool description 同步:
  - D4 team_task_policy 三态('clear-team' 默认 / 'preserve-team' / 'skip' 真删)
  - archive_caller=false 优先级(三态都被 skip,policy 字段透传但 status='skipped')
  - preserve-team policyWarning('preserve-team-unadopted-teams') 升级
  - **`ok return.taskReassignment.unadoptedTeamIds: string[]` 字段含义**(Round 3 LOW-4 修法 — Step C1 + D2 已加该字段但 tool description 未 surface):「preserve-team policy + 差集 team_id 列表(newSid 没成为 lead 的 team,这些 team 的 task 仍归 caller 但 handoff 后 caller 已 detach 无人可写;caller 应据此决定是否 retry adopt 或接受降级)」

### Phase E - IPC 层
- [ ] Step E1: 改 `src/main/ipc/teams.ts:349 TaskListByTeam`:改走 `taskRepo.list({teamId, limit})` 严格按 team_id 过滤
- [ ] Step E2: 改 `src/main/ipc/teams.ts:96 AgentDeckTeamGetFull` 内的 task 拉取段:同款 team_id 过滤

### Phase F - 应用打包 CLAUDE.md 双端同步(MED-3 Layer 2,Round 1 — 改成补充使用模式 + 决策依据,不重复定义字段)
- [ ] Step F1: 改 `resources/claude-config/CLAUDE.md` §task 进度跟踪节(**仅 Layer 2 内容**: 使用模式 + 决策依据;Round 4 LOW-2 修法 — Layer 1 SSOT 字段定义在 Step C1 schemas.ts / Step C7 types.ts + handler jsdoc 内 enforce,本节不重复列):
  - **write permission rule 使用模式** + why personal default 决策依据
  - **read permission rule 使用模式**(Round 3 LOW-3 修法 — D8 推翻 v023 cross-team 可读):「task_get 严格 team-scoped + deny external(v024 推翻 v023 lead 跨 team 看 teammate task / external mcp client 凭已知 id 查 task 两类 use case)」— 仅说**使用约定**(如「caller 必须 in-process transport 才能调 task_get」),**不**复述 Layer 1 字段(如 `EXTERNAL_CALLER_ALLOWED.task_get=false` 这种 SSOT 在 types.ts:144 enforce,F1 不列)
  - 字段定义 SSOT 在 schemas.ts(Step C1)+ types.ts(Step C7),本处只解释使用语义
- [ ] Step F2: 改 `resources/claude-config/CLAUDE.md` §archive_plan / §hand_off 节(team_task_policy 三态的**使用模式** + why preserve-team caller 自负责任 / why default clear-team 决策依据)
- [ ] Step F3: 改 `resources/codex-config/CODEX_AGENTS.md` 双端 mirror Step F1+F2 内容(语义对称,不引入差异)— **F1 含 D8 read 路径 use case 推翻必同步 codex 端**(Round 3 LOW-3)

### Phase G - 测试 + 验证
- [ ] Step G1: 新建 `src/main/store/__tests__/v024-migration.test.ts`(Round 1 含 MED-5):
  - sub-case A:v024 ALTER 行为(ADD COLUMN team_id / index idx_tasks_team_id 就位 / FK ON DELETE SET NULL 触发)
  - **sub-case B:v023→v024 跨版本 path fixture**(MED-5 修法):`applyMigrations(['001'...'v023']) → seed v023 fixture data(无 team_id 列的 task 行) → applyMigrations(['v024'])` → 验证老 task 字段 length 减 0 + team_id 列加 NULL 默认 + 老 task 行 team_id IS NULL 不丢
- [ ] Step G2: 改 `src/main/store/__tests__/task-repo.test.ts`:每个 create 调用补 teamId 默认 null 字段;加 D5 三态 list filter 用例;加 reassignOwner policy **两态**用例(`'clear-team' / 'preserve-team'` — Round 4 HIGH-2 修法,reassignOwner 不含 'skip';'skip' 走独立 applyHandOffSkipPolicy 测试);**加 cascade delete cross-team scenarios**(HIGH-2);**加 applyHandOffSkipPolicy 单 transaction 原子性测试**(Round 3 MED-1):
  - case A 正常 commit:caller 有 mixed team task + personal task → deletedTeamTaskIds 仅含 team task / reassignedPersonalCount 等于 personal task 数 / 其他 task 行不动
  - case B 事务中段 throw:mock chunked DELETE 第二批失败 → 整 transaction ROLLBACK,team task / personal task 全保留 owner=callerSid
  - case C blocks/blocked_by 引用 cleanup 正确:survivor task 的 blocks 列表 / blocked_by 列表过滤掉所有 deletedTeamTaskIds 引用
- [ ] Step G3: 改 `src/main/agent-deck-mcp/__tests__/task-*.test.ts`(Round 1 加 MED-1 + MED-2 + Round 2 D8 + MED-3 + Round 4 MED-4 列旧 test 改造):
  - create 不传 team_id 默认 personal
  - create 传 team_id 但 caller 不在该 team reject
  - **create multi-team caller 显式传 team_id=B(first active team=A)→ ingest payload.teamName=B**(MED-2 修法验证)
  - write permission team-scoped(`team_id != null` caller 必须在 team / `team_id IS NULL` caller==owner)
  - **read permission team-scoped — task_get**(MED-1 修法):caller 不在 team_id reject / caller != owner of personal task reject
  - **task_get external caller deny**(Round 2 D8):external caller(EXTERNAL_CALLER_ALLOWED.task_get=false)withMcpGuard 拦截返 deny-external error(不到 isCallerAuthorizedToRead)
  - **现有 allow-external test 断言改造**(Round 4 MED-4 修法 — 实施时 CI 不破):
    - `task-external-caller.test.ts:45` `EXTERNAL_CALLER_ALLOWED.task_get` 期望从 true → false;`:63-65` HTTP `it.each(['task_list','task_get'])` 移除 task_get,改成 `it.each(['task_list'])` ALLOW + task_get 独立 it block DENY;**`:81-83` stdio `it.each(['task_list','task_get'])` 同款改造**(Round 5 MED-3 — D8 双 transport 一致)
    - `spoofing-attack-paths.test.ts:307-308` + `:316-322` 注释 + (A)+(B) it block 同款改造(task_get 从 read-only 例外移出,独立 DENY case)
    - `task-crud.test.ts:7` jsdoc 删 「task_get 跨 team 只读」 + `:331` `describe('task_get — 跨 team 只读', ...)` 改名 `'task_get — team-scoped read'` + 内部 case 改成 D3 镜像 read 权限断言
  - **member left_at 路径独立 case**(Round 2 MED-3,与 team archived 路径独立):caller 创建 task in team A → caller leave team A(`agent_deck_team_members.left_at != null`)→ list / get / update / delete 全 reject
  - **team archived 路径独立 case**(同 v023 §不变量 7 纪律):caller 创建 task in team A → team A archived(`agent_deck_teams.archived_at != null`)→ list / get / update / delete 全 reject
  - **caller leave 反向覆盖 case d**(Round 3 MED-2 修法,**对称镜像** — caller 视角 reject + 其他 active member 仍可访问):caller A 创 task in team T → A leave T → teammate B(team T 仍 active member)调 task_list / task_get / task_update **不 reject** 仍能拿 task(task team_id=T 仍有效,task-level 可见性是 per-active-member 不是 per-owner-leave;典型 use case lead 早退 reviewer 接手)
  - list team_id_filter 三态
- [ ] Step G4: 改 `src/main/agent-deck-mcp/__tests__/hand-off-session.task-reassign.test.ts`(Round 1 含 MED-4 + MED-5 + MED-7 + Round 2 MED-1 真删 + MED-2 升级 + Round 4 HIGH-1 firstTeam case b + HIGH-2 删 reassignOwner 三态 + MED-2/3 fallback):
  - hand_off default 'clear-team' team_id 清空 / 'preserve-team' team_id 保留
  - **'skip' policy 真删 assertion**(Round 2 MED-1 + Round 4 MED-3 safeEmit):`'skip' + archive_caller=true → handoff 时 handler 立即调 applyHandOffSkipPolicy 单 transaction 删 caller owned team task(team_id IS NOT NULL)+ 每行用 safeEmit 调 task-changed deleted events(inner try/catch + continue)+ personal task(team_id IS NULL)仍正常过继 owner=newSid`;caller archive 后**不依赖** CASCADE — task 已在 handoff 时被显式 DELETE
  - **每个 policy × archive_caller=false 组合都 skip(taskReassignment.status='skipped', reason='archive-caller-false', **policy === expectedPolicy advisory 透传**)**(MED-4 + Round 7 LOW-1 codex 加 policy 断言)
  - **preserve-team caller-as-teammate + lead 未 adopt → policyWarning 升级 assertion**(Round 2 MED-2 升级 + Round 4 HIGH-1 firstTeam 完整覆盖):
    - case a:caller 是 team A lead + team B teammate,caller owned task(team_id=B),`preserve-team + adopt_teammates=true` → swapLead 接管 team A 成功但 team B 不接管(reason='caller-not-lead-in-team')→ `taskReassignment.policyWarning='preserve-team-unadopted-teams'` + `unadoptedTeamIds=['team-B']`
    - case b:caller 是 team A lead,task(team_id=A),`preserve-team + adopt_teammates=true` → swapLead 接管 team A 成功 → 无差集 → `taskReassignment.policyWarning` undefined / unadoptedTeamIds undefined。**Round 4 HIGH-1 firstTeam 显式断言**:case b 必须断言 `taskReassignment.policyWarning === undefined`(锁住「firstTeam adopted 后 adoptedTeamIds 含 firstTeamId」语义,防 implementer 漏 push firstTeamId 让 case b 误触发 false positive warning)
    - case c:caller 是 team A lead,task(team_id=A),`preserve-team + adopt_teammates !== true` → 无 swap 接管 → unadoptedTeamIds=['team-A'] + policyWarning
    - **case d firstTeam + rest 双 push 完整性**(Round 4 HIGH-1):caller 是 team A lead + team B lead(两个 caller-as-lead teams),task team_id=A + task team_id=B,`preserve-team + adopt_teammates=true` → swapLead 接管 A(firstTeam path L814)+ B(rest loop L839)两处都 push → `taskReassignment.policyWarning === undefined` + `phase15Detail.adoptedTeamIds=['A','B']`(锁住两处 push 完整性,缺一个 implementer 漏改某 path 会让该 case 触发 false positive warning)
  - **applyHandOffSkipPolicy DB throw fallback**(Round 4 MED-2):mock taskRepo.applyHandOffSkipPolicy throw new Error('DB locked') → ok return.taskReassignment={status:'failed', error:'DB locked'} + console.warn;**不抛错给 caller**(spawn/adopt 已成功不回滚);spawnedSid 仍正常 active + adopt 链已成功
  - **emit task-changed deleted safeEmit fallback**(Round 4 MED-3):mock eventBus listener throw on first deletedTeamTaskIds 元素 → console.warn 后**继续** emit 剩余 ids + ok return 不被该 throw 影响(taskReassignment.status='ok' 仍正常)
  - **adopted.adoptedTeamIds surface**(Round 4 MED-1):case b + case d 都额外断言 ok return `adopted.adoptedTeamIds === [firstTeamId, ...rest 成功 swap teamIds]` 顺序与 swap 序一致
- [ ] Step G5: `zsh -i -l -c "pnpm typecheck"` + `pnpm build` + `pnpm exec vitest run` 全过
  - **callout(LOW-2 修法,Round 1)**:跑 SQLite 真测(task-repo.test.ts 等)撞 `NODE_MODULE_VERSION 115 vs 130 / ERR_DLOPEN_FAILED` → 走项目 CLAUDE.md §打包配置 §跑 vitest SQLite 真测节 3 行清理脚本:
    ```bash
    rm -f ~/.npm/_prebuilds/*better-sqlite3*
    rm -rf node_modules/.pnpm/better-sqlite3@11.10.0/node_modules/better-sqlite3/build
    zsh -i -l -c "pnpm postinstall"
    ```

### Phase H - Deep Review + 收口
- [ ] Step H1: invoke `/agent-deck:deep-review` SKILL kind='mixed'(plan + code 实施一致性),scope 含本 plan + 主代码变更文件清单。reviewer 出 finding 修到 reviewer pair 0 HIGH 0 真 MED 收口
- [ ] Step H2: 写 CHANGELOG_149.md 引用本 plan + commit 进 main repo(archive_plan 不会自动写 changelog 引用)
- [ ] Step H3: 收口 archive_plan tool 归档(caller 必须先 `ExitWorktree(action: "keep")` 切回 main repo)

## 当前进度

- ✅ Step 0 RFC(2 轮 7 个决策点)已收口 — D1-D7 上方
- ✅ Step 1.5 Deep-Review Round 1-7 7 轮 fix loop 正式收口 — 详 §参考与 dependencies 末段完整记录(R1-R7 收敛趋势 + 异构对偶教科书级实证)
- ✅ Step 2 EnterWorktree 完成 — 主路径 (b) 显式 HEAD commit-ish 避开 v2.1.112 stale base bug;worktree HEAD == main repo HEAD `6cc7c6a` 双向 rev-parse 自检通过
- ✅ Phase A (Migration + 类型层) 完成 commit `c27d0de`:v024 SQL + index.ts 注册 + TaskRecord.teamId 字段
- ✅ Phase B (Repo 层) 完成 commit `c27d0de`:task-repo.ts Row/create/update/list 加 team_id + reassignOwner policy 两态 + delete predicate 改签名 + applyHandOffSkipPolicy 单 tx 4 步 helper + visibleScope OR 模式
- ✅ Phase C (mcp handler 层) 完成 commit `c27d0de`:7 个 step C1-C7 全 inline(schemas.ts SSOT / task-create team_id 校验 / task-list 三态分流 / task-update+delete 改 isCallerAuthorizedToWrite 签名 + cascade predicate 同款 / task-helpers 重写 + 新增 isCallerAuthorizedToRead + isCallerInTeam + getVisibleTaskScope + 删 getCallerFirstTeamName / tools/index.ts task_get tool description / task-get.ts handler D8 deny + types.ts flip task_get false)
- ✅ Phase D (hand_off 层) 完成 commit `9c46a1a`(本会话):
  - Step D2 hand-off-session.ts reassign 段大改造 — taskPolicy const 在 reassign 段顶部(L_taskPolicy)声明,5 路径(spawn-no-sid / archive-caller-false / skip-ok / skip-failed / reassignOwner-ok-failed)都带 `policy: taskPolicy`;三分支 if/else(clear-team / preserve-team / skip);clear-team/preserve-team 走 `reassignOwner({policy})`;**skip 走 `taskRepo.applyHandOffSkipPolicy` 单一伪代码 outer try/catch + safeEmit per-id task-changed deleted + DB throw fallback(status='failed' 不抛错给 caller)**;preserve-team safety 算法:reassign **之前** snapshot `taskRepo.findOwnedDistinctTeamIds(callerSid)`(新加 helper) → 与 `phase15Detail.adoptedTeamIds ∪ spawnData.teamId` 比对差集 → policyWarning='preserve-team-unadopted-teams' + unadoptedTeamIds;phase15Detail 加 `adoptedTeamIds: string[]` 字段,**processSwappedTeam helper 顶部集中 push**(plan §Step D2 R4 实施 hint — firstTeam path + rest loop 全靠 helper 内 push,双 push 漂移风险消除);HandOffSessionHandlerDeps seam 加 `applyHandOffSkipPolicy` + `findCallerOwnedTeamIds` + `reassignTaskOwner` 加 policy 参数;ok return.adopted block 加 `adoptedTeamIds: phase15Detail.adoptedTeamIds` spread mapping(R5 LOW-2 显式 wire)
  - Step D3 hand_off_session tool description 同步 — D4 三态 + archive_caller=false 优先级 + preserve-team policyWarning + unadoptedTeamIds 字段含义全 inline
  - task-repo.ts 加 `findOwnedDistinctTeamIds(callerSid): string[]` helper(实施层 implicit — Step B1 没显式列但 D2 preserve-team safety 算法 implicit 需要;单 SQL DISTINCT 避免 list 拉全部 task 然后 caller 端 map)
  - **typecheck 验证**: 5 处 ripple(hand-off-session.ts:877/880/892/898 漏 policy + :885 reassignOwner 缺 policy 参数 + :964 adopted 漏 adoptedTeamIds)全消除;剩余 7 处 task-repo.test.ts 错误属 Phase G2 范围
- ✅ Phase E (IPC) 完成 commit `39d180c`(本会话):
  - Step E1: ipc/teams.ts:349 TaskListByTeam handler 走 `taskRepo.list({teamIdFilter: teamId, limit: 200})` 严格按 team_id 过滤,不再 reverse join member sids
  - Step E2: ipc/teams.ts:113 AgentDeckTeamGetFull handler 内 task 拉取段同款 teamIdFilter 严格过滤
  - archived team filter 纪律保留(plan §不变量 7): team archivedAt !== null 时返 []
  - 消灭 v023「lead 多 team task 串流到团队面板」根因(plan §起源)
  - **typecheck 验证**: 0 处新 ripple,与 Phase D 后一致
- ✅ Phase F (双端 CLAUDE.md 同步) 完成 commit `06b4071`(本会话):
  - Step F1: resources/claude-config/CLAUDE.md §task 进度跟踪节加 v024 重设计说明(team_id stored / 可见性 / 写权限 按 team_id 决定 / task_get 严格 team-scoped + deny external / personal task first-class / hand_off team_task_policy 三态)
  - Step F2: resources/claude-config/CLAUDE.md §hand_off 节加 team_task_policy 三态使用模式 + why default clear-team / why preserve-team caller 自负责任
  - Step F3: resources/codex-config/CODEX_AGENTS.md 双端 mirror Step F1+F2 内容(语义对称,不引入差异)
  - 修法约束(plan §Step F Round 4 LOW-2): 仅 Layer 2 内容(使用模式 + 决策依据);Layer 1 SSOT 字段定义在 schemas.ts/types.ts/handler jsdoc 内 enforce
  - **typecheck 验证**: 0 处新 ripple(Phase F 文档无 TS 影响是预期)
- ⏳ Phase G (测试 + 验证) — 5 测试文件改造 + typecheck/build/vitest
- ⏳ Phase H (Deep Review + 收口) — invoke /agent-deck:deep-review SKILL kind='mixed' + CHANGELOG_149 + archive_plan

**Phase A-D 累计改动**: Phase D 在 hand-off-session.ts(reassign 段 + adopted block + phase15Detail) + task-repo.ts(findOwnedDistinctTeamIds helper + export) + tools/index.ts(hand_off_session tool description) 上叠加 commit(待 D 后续 commit)

**Phase E/F/G/H 等待 user confirm 继续推进 / hand off**

**当前 typecheck 暴露的 ripple**（Phase D 已 land,等 Phase G 修）:
- task-repo.test.ts:323/339 cascade predicate signature 旧 string 比较 (Phase G2 修)
- task-repo.test.ts:362/373/382/395/408 reassignOwner 缺 policy 参数 (Phase G2 修)

## 下一会话第一步(cold start 必读)

1. `Bash: cat /Users/apple/Repository/personal/agent-deck/.claude/plans/task-team-id-restore-20260525.md` 全文(看 §当前进度 + §步骤 checklist + §设计决策 D1-D8 + §不变量)
2. **当前进度速查**: Phase A/B/C/D/E/F 已全完(commits c27d0de → 06b4071),仅 Phase G(测试)+ Phase H(deep-review + 收口) 剩余
3. `EnterWorktree(path: "/Users/apple/Repository/personal/agent-deck/.claude/worktrees/task-team-id-restore-20260525")` 进 worktree(branch worktree-task-team-id-restore-20260525,base_commit c27d0de + Phase D/E/F commits)
4. 进 worktree 后**第一件事 `Bash: pwd` 自检** + 所有指向代码资产的路径加 `.claude/worktrees/task-team-id-restore-20260525/` 前缀(详 user CLAUDE.md §Step 2 末 callout)
5. **stale base 兜底自检**(MED-6 修法 — 普适纪律不应跳;Phase A-F 已多次 commit,worktree HEAD 应 = 最新 commit `06b4071`):
   ```bash
   git -C /Users/apple/Repository/personal/agent-deck/.claude/worktrees/task-team-id-restore-20260525 rev-parse HEAD
   git -C /Users/apple/Repository/personal/agent-deck rev-parse HEAD
   ```
   worktree HEAD 应 = `06b4071`(或之后 Phase G/H commits);main repo HEAD 应仍 = `6cc7c6a` 不变(本 plan worktree 改动未合回主线)。**与 §Step 1 plan 创建时 base_commit 一致性约束分开**:base_commit 标 plan 创建时的 main repo HEAD(`6cc7c6a`),worktree HEAD 可比 base_commit 新(本 plan 已多 commit)
6. **直接动手 Phase G** (Step G1-G5):
   - **Step G1**: 新建 `src/main/store/__tests__/v024-migration.test.ts` sub-case A(ALTER 行为 / index / FK SET NULL 触发)+ sub-case B(v023→v024 跨版本 fixture 模拟真实升级路径)
   - **Step G2**: 改 `src/main/store/__tests__/task-repo.test.ts` — 含**当前 typecheck 暴露的 7 处 ripple 必修**(323/339 cascade predicate signature 旧 string 比较 + 362/373/382/395/408 reassignOwner 缺 policy 参数);加 D5 三态 list filter / reassignOwner policy 两态(`'clear-team' / 'preserve-team'`) / applyHandOffSkipPolicy 三 case(case A 正常 / case B 中段 throw ROLLBACK / case C blocks/blocked_by cleanup) / cascade delete cross-team scenarios
   - **Step G3**: 改 `src/main/agent-deck-mcp/__tests__/task-*.test.ts` — create 默认 personal / create 传 team_id reject / multi-team caller payload.teamName / write/read 权限 team-scoped / task_get external deny / 已 read-only 测试断言改造(`task-external-caller.test.ts:45/63-65/81-83` + `spoofing-attack-paths.test.ts:307-308/316-322` + `task-crud.test.ts:7/331`)/ member left_at 路径 / team archived 路径 / caller leave 反向覆盖 case d / list team_id_filter 三态
   - **Step G4**: 改 `src/main/agent-deck-mcp/__tests__/hand-off-session.task-reassign.test.ts` — default 'clear-team' / 'preserve-team' / 'skip' 真删 assertion(applyHandOffSkipPolicy 单 tx + per-id safeEmit + 不依赖 CASCADE)/ 每 policy × archive_caller=false 组合 skip + policy 透传 / preserve-team policyWarning 升级 4 case(a/b/c/d 含 firstTeam + rest 双 push 完整性)/ DB throw fallback / emit listener throw 仍 continue / adopted.adoptedTeamIds surface / 5 路径都带 policy field 断言
   - **Step G5**: `zsh -i -l -c "pnpm typecheck"` + `pnpm build` + `pnpm exec vitest run` 全过 — 撞 SQLite binding ABI 时按 plan §已知踩坑 9 + Step G5 inline callout 走 3 行清理脚本
7. **Phase H 收口**:
   - Step H1: invoke `/agent-deck:deep-review` SKILL kind='mixed'(本 plan + 主代码变更文件清单)— **reviewer pair 仍在 team `deep-review-task-team-id-restore-20260525` 内 active**(reviewer-claude sid `70c6c924-0d49-4c6a-a784-53143cddd309` + reviewer-codex sid `019e5dd2-d566-72c3-b28d-3af0354a8a35`),可直接 send_message 复用而非重 spawn,保留 R1-R7 deep-review 跨轮 mental model
   - Step H2: 写 CHANGELOG_149.md 引用本 plan + commit 进 main repo
   - Step H3: 收口 archive_plan tool 归档(caller 必须先 `ExitWorktree(action: "keep")` 切回 main repo;调用时显式传 `changelog_id: "149"`)
8. **不重新讨论已记录的 §设计决策 D1-D8**;如需变更先告诉用户征得确认再改

## 已知踩坑

1. **SQLite ALTER ADD COLUMN REFERENCES 是合法表达式**(HIGH-1 修法,Round 1 — 双方独立现场实测推翻原假设):
   - v011_tasks_team_id.sql:18 + v009_mcp_spawn_chain.sql:21 production 实证 `ALTER TABLE ... ADD COLUMN <col> TEXT REFERENCES <tbl>(<col>) ON DELETE SET NULL` 已多版本 ship 通过
   - reviewer-codex 现场 `sqlite3 :memory:` `PRAGMA foreign_keys=ON; ALTER TABLE tasks ADD COLUMN team_id TEXT NULL REFERENCES agent_deck_teams(id) ON DELETE SET NULL; PRAGMA foreign_key_list(tasks);` 返 `agent_deck_teams|team_id|id|NO ACTION|SET NULL` 实测合法
   - **约束**:SQLite 仅要求新增列默认值为 NULL(SQLite 3.25+);本 plan 提案的 `TEXT NULL REFERENCES ... ON DELETE SET NULL` 完全满足
   - **Phase A1 行动**:复制 v011_tasks_team_id.sql 改名 v024 + 改注释,无 spike 必要;v024 migration test 加 `PRAGMA foreign_key_list(tasks)` 验证 + team hard delete 后 `team_id IS NULL` 验证(Phase G1)
2. **lead==caller==owner triple-equal 边界 + active-member 双路径**(Round 2 MED-3 升级):caller == owner 特例(F-R2-C jsdoc)在新 D3 路径仅 personal task 保留(team_id IS NULL → caller == owner 才能写),team task 路径**不再**走 owner-special-case — 改成 caller 必须在 team_id 是 active member(不论是否 owner)。**active = `agent_deck_team_members.left_at IS NULL AND agent_deck_teams.archived_at IS NULL` 双条件**;member level 软退出(`left_at != null`)与 team level 硬归档(`archived_at != null`)是两条独立路径,test 需**双路径分别覆盖**:
   - 路径 1(team archived):caller 创建 task in team A → team A archived → list/get/update/delete 全 reject
   - 路径 2(member left_at):caller 创建 task in team A → caller leave team A(`agent_deck_team_members.left_at != null`)→ list/get/update/delete 全 reject
3. **hand_off `'preserve-team'` 路径的责任契约与 policyWarning**(已升级到 §不变量 5 + D4,详 MED-7 Round 1 + Round 2 MED-2 升级):用户 D4 选 default 'clear-team' 但留 preserve-team 选项;handler reassign 前 query caller owned distinct `team_id` 与 newSid handoff 后 active teams 比对(差集 → `policyWarning='preserve-team-unadopted-teams'` + `unadoptedTeamIds: string[]` 字段)。**enum 改名 Round 2**:旧 `'preserve-team-without-adopt-teammates'`(R1 提)→ 新 `'preserve-team-unadopted-teams'`(更精确,涵盖 caller-as-teammate 场景)。handler **不 hard reject**(F-R2-C 防御深度同款理由,保留弹性),但 soft warning 让 caller 调试(测试矩阵 Step G4 锁住 3 个 case)
4. **task_list `'null-personal'` 字面量 (FROZEN,Round 1 LOW-1 修法)**:freeze decision = 使用 zod literal `z.union([z.string().uuid(), z.literal('null-personal')])`(literal 比 nullable 更显式 + caller call site 一眼看出语义 + zod union 表达力更强)。Step C1 按此实施不再争论。**Freeze 时机**:Step 1.5 Deep-Review Round 1 reviewer-claude LOW-1 提示后
5. **IPC TaskListByTeam 改造与现有 UI 渲染**:UI 团队面板已渲染 team task list,改成严格 team_id 过滤后**老数据**(team_id=null)在团队面板不再显示是预期行为。但用户体验上可能困惑「我之前明明在这个 team 创建的 task 怎么没了」— 答案是「之前 task 没绑 team_id 标签,现在 default personal」。可能需要 README / changelog 显式说明 migration 影响
6. **archived team filter 双路径同步**:Phase E1+E2 改完 IPC 后,确认仍按 §不变量 7 archived team filter(team.archived_at !== null 时返 []),与 v023 F2+F9 修法纪律对齐
7. **getVisibleOwnerSessionIds 半废 → getVisibleTaskScope 重命名**:v023 引入的 `getVisibleOwnerSessionIds(callerSid)` 在 D3 后只剩 task_list 默认 scope(不传 team_id_filter)使用 — Step C5 改成 `getVisibleTaskScope(callerSid)` 返 `{teamIds: string[], includeOwnPersonal: true}` 让 query 端用 `(team_id IN teamIds) OR (team_id IS NULL AND owner_session_id == callerSid)` 一次 SQL 拿到。**helper 重命名要 grep 全项目**(`getVisibleOwnerSessionIds` 是否还有 IPC / 其他 helper / test 引用),不只看 mcp handler
8. **changelog_id v.s. plan_id**:archive_plan tool 调用时建议显式传 `changelog_id`(CHANGELOG_149) 让 INDEX 4 列 smart update 自动写;不传走 placeholder `—`(详 user CLAUDE.md §Step 4 changelog_id 字段)
9. **better-sqlite3 binding ABI 踩坑**(LOW-2 修法,Round 1):Step G5 跑 SQLite 真测(task-repo.test.ts 等)若撞 `NODE_MODULE_VERSION 115 vs 130 / ERR_DLOPEN_FAILED` 错 → 按项目 CLAUDE.md §打包配置 §跑 vitest SQLite 真测节修(3 行清理脚本,详 Step G5 inline callout)。CHANGELOG_42 已记教训不本地 rebuild 污染 Electron 33 binding
10. **测试覆盖矩阵**(Step G 实施前再核对一遍,Round 1+2 已扩):
    - migration:v024 ALTER 行为 / 老数据保留 / **v023→v024 跨版本 fixture 模拟真实升级 path**(MED-5)/ index 就位 / FK SET NULL 触发
    - repo:create 含 teamId / list 三态 filter / SET NULL 触发(团 hard delete) / reassignOwner policy **两态**(`'clear-team' / 'preserve-team'`,Round 4 HIGH-2 / Round 5 MED-2 — `'skip'` 不在 reassignOwner 走 applyHandOffSkipPolicy) / applyHandOffSkipPolicy 三 case / **cascade delete cross-team scenarios**(HIGH-2)
    - mcp handler:create 默认 personal / create 传 team_id 但 caller 不在该 team reject / **multi-team caller 显式传 team_id=B(first=A)→ ingest payload.teamName=B**(MED-2)/ list 三态 / update/delete 写权限 team-scoped / **read 权限 team-scoped — task_get**(MED-1)/ **task_get external caller deny**(Round 2 D8 — withMcpGuard 拦截)/ **member left_at 路径独立 case**(Round 2 MED-3)/ **team archived 路径独立 case**(同 v023 纪律)
    - hand_off:default 'clear-team' / 'preserve-team' / **'skip' 真删 assertion**(Round 2 MED-1 — handoff 时立即 DELETE + emit task-changed deleted events,**不依赖** CASCADE)/ **每个 policy × archive_caller=false 都 skip**(MED-4)/ **preserve-team caller-as-teammate / lead 未 adopt → policyWarning='preserve-team-unadopted-teams' + unadoptedTeamIds 含正确 team_ids**(Round 2 MED-2 升级,3 case a/b/c)
    - IPC:TaskListByTeam team_id 严格过滤 / archived team 返 []
11. **`'skip' 真删` 实施收口 — 新 `applyHandOffSkipPolicy` repo helper**(Round 2 MED-1 + Round 3 MED-1 + Round 5 LOW-1 修法 — safeEmit 术语同步):**Round 2 提的「raw DELETE / 逐个 taskRepo.delete / deleteBatch helper 三选一」实施风险已被 Round 3 MED-1 否决 — 三套都不能原子化** (raw DELETE 后 taskRepo.delete 找不到 target 直接 return / 逐个 taskRepo.delete 每次自开 transaction 不能跨调用原子 / handler 显式 emit task-changed 不在 DB tx 内)。**最终方案**:Step B1 新增 `taskRepo.applyHandOffSkipPolicy(callerSid, newSid): { deletedTeamTaskIds: string[]; reassignedPersonalCount: number }` repo-level helper,单 `db.transaction()` 内原子化 4 步(SELECT 团 task ids → chunked DELETE → blocks/blocked_by cleanup → reassign personal);**handler commit 后 per-id safeEmit task-changed deleted event(inner try/catch + console.warn + continue 不阻断后续 ids;listener throw 仅 warn 不冒泡 outer fallback)**(Round 5 LOW-1 修正 — 旧描述写直接 `eventBus.emit` 容易让 implementer 把 safeEmit 当可选包装;实际 safeEmit 是必要 fallback pattern,沿用 hand-off-session.ts:754-763 现有 pattern,完整伪代码见 Step D2)

## 测试覆盖矩阵(Step G 落实)

| 测试文件 | 覆盖场景 |
|---|---|
| `src/main/store/__tests__/v024-migration.test.ts` 新建 | sub-case A:ALTER TABLE ADD COLUMN 行为 / index idx_tasks_team_id 就位 / FK ON DELETE SET NULL 触发(PRAGMA foreign_key_list 验)。**sub-case B:v023→v024 跨版本 fixture**(MED-5 — `applyMigrations(['001'...'v023']) → seed v023 fixture data → applyMigrations(['v024'])` 模拟真用户升级,验证老 task team_id IS NULL 不丢) |
| `src/main/store/__tests__/task-repo.test.ts` 改 | create 传 teamId / list 三态 filter(undefined / string / 'null-personal') / **reassignOwner policy 两态**(`'clear-team' / 'preserve-team'` — Round 4 HIGH-2 / Round 5 MED-2 修法,`'skip'` 不在 reassignOwner) / applyHandOffSkipPolicy 三 case(case A 正常 commit / case B 中段 throw 全 ROLLBACK / case C blocks/blocked_by cleanup 正确) / team hard delete → team_id 自动 SET NULL / **cascade delete cross-team scenarios**(HIGH-2 — root team A → child team B 且 owner 同时在 A 不得删 / root team A → child team A 且 owner 不共享 caller 可删) |
| `src/main/agent-deck-mcp/__tests__/task-*.test.ts` 改 + 新建 | create 不传 team_id 默认 personal / create 传 team_id 但 caller 不在该 team reject / **multi-team caller 显式 team_id=B(first=A)→ ingest payload.teamName=B**(MED-2)/ write permission team-scoped(`team_id != null` caller 必须在 team / `team_id IS NULL` caller==owner)/ **read permission team-scoped — task_get**(MED-1 — caller 不在 team_id reject / caller != owner of personal task reject)/ **task_get external caller deny**(Round 2 D8 — EXTERNAL_CALLER_ALLOWED.task_get=false withMcpGuard 拦截)/ **member left_at 路径独立**(Round 2 MED-3 — caller leave team → list/get/update/delete 全 reject)/ **team archived 路径独立**(同 v023 §不变量 7 — team archive → list/get/update/delete 全 reject)/ list team_id_filter 三态 |
| `src/main/agent-deck-mcp/__tests__/hand-off-session.task-reassign.test.ts` 改 | hand_off default 'clear-team' team_id 清空 / 'preserve-team' team_id 保留 / 与 adopt_teammates=true / **每个 policy × archive_caller=false 组合都 skip(taskReassignment.status='skipped', reason='archive-caller-false', policy 透传)**(MED-4 + Round 6 MED-2)/ **'skip' policy 真删 assertion**(Round 2 MED-1 + Round 4 MED-3 + Round 5 MED-4 — handoff 时 handler 调 applyHandOffSkipPolicy 单 transaction 删 team task + 每行用 **safeEmit**(inner try/catch + warn + continue)调 task-changed deleted events + personal 仍正常过继;**不**测「caller archive 后 CASCADE 删」因为 archive 不删 sessions 行)/ **applyHandOffSkipPolicy DB throw fallback assertion**(Round 4 MED-2 — mock throw → ok return taskReassignment={status:'failed', error, policy} + console.warn + 不抛错)/ **emit listener throw 仍 continue assertion**(Round 4 MED-3 — mock first emit listener throw → console.warn 后继续 emit 剩余 ids + taskReassignment.status='ok')/ **preserve-team policyWarning 升级 4 case**(Round 2 MED-2 + Round 4 HIGH-1 firstTeam 完整覆盖 — case a:caller=lead-A+teammate-B,task team_id=B,preserve-team+adopt=true → policyWarning='preserve-team-unadopted-teams' + unadoptedTeamIds=['team-B'];case b:caller=lead-A,task team_id=A,preserve-team+adopt=true → 无差集 policyWarning undefined(firstTeam 显式锁住);case c:caller=lead-A,task team_id=A,preserve-team+adopt !==true → unadoptedTeamIds=['team-A'];**case d:caller=lead-A+lead-B 双 caller-as-lead teams,preserve-team+adopt=true → adoptedTeamIds=['A','B'] L814+L839 双 push 完整性**)/ **adopted.adoptedTeamIds surface assertion**(Round 4 MED-1 + Round 5 LOW-2 spread mapping — case b + case d 都断言 ok return.adopted.adoptedTeamIds 顺序与 swap 序一致)/ **每个 assignment 路径都带 policy field assertion**(Round 6 MED-2 — clear-team / preserve-team / skip / archive_caller=false / fallback 5 路径都断言 taskReassignment.policy === <expected>) |
| `src/main/ipc/__tests__/teams.test.ts` 改(如有) | TaskListByTeam 严格 team_id 过滤 / archived team 返 [] / AgentDeckTeamGetFull 内 task 字段过滤 |

## 参考与 dependencies

- v023 plan(本 plan 是 v023 follow-up):`/Users/apple/Repository/personal/agent-deck/plans/task-mcp-owner-session-id-rewrite-20260521.md`
- v023 deep-review:REVIEW_53(2 MED + 4 LOW 全 land,但 lead 多 team 串流未覆盖 — 本 plan 补)
- **v011 migration 模板**:`src/main/store/migrations/v011_tasks_team_id.sql` — **v024 的 1:1 模板**(INFO-1 + HIGH-1 修法 Round 1 — v023 §58 显式记录 v007+v011 被合并删除,本 plan 是 v011 重引入,只改注释 + 改名)
- v009 反证 ALTER REFERENCES:`src/main/store/migrations/v009_mcp_spawn_chain.sql:21` `ALTER TABLE sessions ADD COLUMN spawned_by TEXT REFERENCES sessions(id) ON DELETE SET NULL` — 同款语句 production ship 实证(HIGH-1 修法 Round 1)
- 相关 CHANGELOG:CHANGELOG_144(v023 收口) / CHANGELOG_146(task mcp 合并 agent-deck-mcp namespace) / CHANGELOG_148(camelCase 统一,刚 commit)
- RFC 2 轮历史:本 plan 写作前的对话 conversation history(覆写 D1-D7)
- migration 编号:现有最大 v023,新增是 v024
- Round 1 deep-review fix:本会话 Step 1.5 Round 1 reviewer-claude(2 HIGH + 5 MED + 2 LOW + 1 INFO)+ reviewer-codex(0 HIGH + 3 MED + 1 LOW)= 去重后 2 HIGH + 7 MED + 2 LOW + 1 INFO 全 fix 进 plan(详上文各节 inline 修法 reference)
- Round 2 deep-review fix:本会话 Step 1.5 Round 2 reviewer-claude(1 HIGH-new + 1 MED-new + 3 LOW-new,**Round 1 fix 全 inline 0 漂移**)+ reviewer-codex(0 HIGH + 2 MED-new)= 去重后 **1 HIGH + 3 MED + 3 LOW 全 fix 进 plan**:
  - **Round 2 HIGH-1**(claude — task_get MED-1 ripple 漏 v023 commitment):新增 §设计决策 D8(flip EXTERNAL_CALLER_ALLOWED.task_get=false + 同步删 types.ts/task-get.ts/task-helpers.ts 三处 jsdoc + 明示 v023 use case 推翻);§不变量 2/3 加 v023 → v024 推翻 acknowledge;Step C7 升级 flip false + 显式 jsdoc 同步;Step C1 TASK_GET_SCHEMA short-form describe + caller_session_id 说明 external 拦截
  - **Round 2 MED-1**(codex — 'skip' + archive_caller=true CASCADE 断言错误):user 拍板方案 A 真删;§不变量 5 + D4 'skip' 描述改为「handoff 时 handler 显式 DELETE FROM tasks WHERE owner=caller AND team_id IS NOT NULL + cleanup blocks/blocked_by + emit task-changed deleted events」;Step D2 'skip' 分支独立 SQL + 显式实施细节;Step G4 改测真删行为而非 CASCADE;§已知踩坑 11 新增 'skip' 真删实施风险评估
  - **Round 2 MED-2**(codex — preserve-team policyWarning 漏 caller-as-teammate):user 拍板方案 A soft warning 升级;§不变量 5 + D4 preserve-team warning 节升级 enum(`'preserve-team-without-adopt-teammates'` → `'preserve-team-unadopted-teams'`);handler 检测逻辑改为 query caller owned distinct team_id vs newSid handoff 后 active teams 差集;Step D2 详细列出 swapLead `phase15Detail.preserved` 拿成功 lead teams + args.team_name membership 算 newSidActiveTeamIds 差集;Step C1 + Step G4 case a/b/c 全覆盖
  - **Round 2 MED-3**(claude — caller leave team 路径漏覆盖):§不变量 3 加 active 双条件定义 `left_at IS NULL AND archived_at IS NULL`;新增 §不变量 13 显式 member left_at 与 team archived 是独立路径;§已知踩坑 2 升级覆盖双路径;Step G3 加 member left_at 路径独立 case
  - **Round 2 LOW-3**(claude — Step C2 `lookupTeamName` 不存在):Step C2 改为 inline `agentDeckTeamRepo.findById(args.team_id)?.name ?? null`(repo 已 imported 多处)
  - **Round 2 LOW-4**(claude — Step C6 vs Step D1 hand_off tool description step granularity 不明):Step C6 改名仅 task 类 tool description;新增 Step D3 拆 hand_off tool description 进 Phase D
  - **Round 2 LOW-5**(claude — Layer 1/2 内容粒度 boundary 不明):Step C1 describe 全改 short-form「field 含义 + minimal 约束 + cross-reference convention docs §X」不写 long-form usage;Phase F 仍是 long-form usage + 决策依据,两层无重叠
- Round 3 deep-review fix:本会话 Step 1.5 Round 3 reviewer-claude(1 HIGH-new + 2 MED-new + 4 LOW-new,**Round 2 fix 全 inline 0 漂移**)+ reviewer-codex(0 HIGH + 3 MED-new)= 去重后 **1 HIGH + 3 MED + 4 LOW 全 fix 进 plan**:
  - **Round 3 HIGH-1**(双方独立 claude HIGH + codex MED — preserve-team 差集算 `phase15Detail.preserved` 字段语义错;preserved 实际是 teammate sessionIds 不是 teamIds):§不变量 5 + D4 算法升级 + Step D2 详列「phase15Detail 加新字段 `adoptedTeamIds: string[]`,swap loop L839 同时 push;newSidActiveTeamIds = Set([...adoptedTeamIds, ...(spawnData.teamId ? [spawnData.teamId] : [])])」
  - **Round 3 MED-1**(双方独立 — 'skip' 真删原子性矛盾:claude 强调两套方案矛盾 + emit 层级缺位;codex 强调三件事不能放同 transaction):**收口** Step B1 新增 `applyHandOffSkipPolicy(callerSid, newSid)` repo-level helper 单 db.transaction 内原子化 4 步(SELECT 团 task ids → chunked DELETE → blocks/blocked_by cleanup → reassign personal);handler commit 后按 returned deletedTeamTaskIds 显式 eventBus.emit task-changed deleted events 每行调用;Step D2 删旧两套方案描述;§已知踩坑 11 重写收口实施风险 + Step B2 加 applyHandOffSkipPolicy 原子性测试(case A 正常 / case B 中段 throw 全 ROLLBACK / case C cleanup 正确)
  - **Round 3 MED-2**(claude — Step G3 漏「caller leave 后其他 active member 仍能 read/write」反向覆盖):§不变量 13 加反向镜像段;Step G3 加 case d(caller A 创 task in team T → A leave T → teammate B 仍能 read/write task,典型 use case lead 早退 reviewer 接手)
  - **Round 3 MED-3**(codex — `agentDeckTeamRepo.findById` 不存在,实际接口 `get(teamId)` / `getByActiveName(name)`,grep findById 零命中):Step C2 改为 `agentDeckTeamRepo.get(args.team_id)?.name ?? null`;Round 2 fix 摘要 line 376 同步修正记录
  - **Round 3 LOW-1**(claude — D8 Step C7/HowToApply 第 5 步 `task-helpers.ts:8-9` reference 错):该 jsdoc 描述 `getVisibleOwnerSessionIds` 无 task_get 字样;D8 第 5 步 + Step C7 第 5 步标 ~~删除线~~ + 改成 grep 确认 nothing-to-do
  - **Round 3 LOW-2**(claude — Step C6 没显式列 `index.ts:389` 当前字符串):Step C6 加显式 Before(`'Get a single task by id. Returns the task regardless of team scope (read-only cross-team visibility).'`)/ After(`'Get a single task by id, scoped to caller team membership (team-bound task: caller must be active member; personal task: caller must be owner). Deny external caller (EXTERNAL_CALLER_ALLOWED.task_get=false).'`)字符串
  - **Round 3 LOW-3**(claude — Phase F1/F2/F3 只提 write permission,漏 D8 read 路径 + task_get deny external):Step F1 + F3 加「read permission rule 使用模式(D8 task_get team-scoped + deny external — v024 推翻 v023 lead 跨 team 看 teammate task / external mcp client 凭已知 id 查 task 两类 use case)」;Step F3 双端同步
  - **Round 3 LOW-4**(claude — Step D3 未 surface unadoptedTeamIds 字段含义):Step D3 加「ok return.taskReassignment.unadoptedTeamIds: string[] 含义 — preserve-team policy + 差集 team_id 列表(newSid 没成为 lead 的 team,这些 team 的 task 仍归 caller 但 caller 已 detach 无人可写;caller 应据此决定是否 retry adopt 或接受降级)」
- Round 4 deep-review fix:本会话 Step 1.5 Round 4 reviewer-claude(2 HIGH-new + 3 MED-new + 2 LOW-new,**Round 3 fix 全 inline 0 漂移**)+ **re-spawn 新 reviewer-codex Round 1 fresh full review**(老 codex Round 4 nudge 12+min 未 reply → user shutdown + re-spawn,新 codex sid 019e5dd2 fresh review 出 2 HIGH + 2 MED) = 去重后 **2 HIGH + 4 MED + 2 LOW 全 fix 进 plan**:
  - **Round 4 HIGH-1**(双方独立 claude HIGH + 新 codex HIGH — adoptedTeamIds 漏 firstTeam push):§不变量 5 + D4 algorithm 段 + Step D2 + §测试覆盖矩阵 全部改成「L814 firstTeam path + L839 rest loop 两处都 push adoptedTeamIds」(实施 hint:重构 processSwappedTeam helper 集中 push 避免双 push 漂移);Step G4 加 case b 显式断言 firstTeam adopted 后 policyWarning undefined + 新增 case d firstTeam + rest 双 push 完整性
  - **Round 4 HIGH-2**(双方独立 claude HIGH + 新 codex HIGH — D2 残留 reassignOwner({policy:'skip'}) 与 B1 helper 重复):删 plan L262-265 残留旧描述(personal task 仍走 reassignOwner({policy:'skip'}));Step B1 reassignOwner policy 类型显式 `'clear-team' | 'preserve-team'`(不含 'skip','skip' 走 applyHandOffSkipPolicy);Step G2 改 reassignOwner 两态测试 + applyHandOffSkipPolicy 三 case 测试(Step B2 重复 fold 进 G2 — 测试矩阵单一 SSOT)
  - **Round 4 MED-1**(claude — HandOffSessionResult.adopted 缺 adoptedTeamIds 对称 surface):Step C1 schemas.ts shape 加 `adoptedTeamIds: string[]` field(与 `preserved: string[]` sids 对称暴露 team uuids 便于 caller diag policyWarning 来源);Step G4 case b + case d 都额外断言 ok return.adopted.adoptedTeamIds 顺序
  - **Round 4 MED-2**(claude — applyHandOffSkipPolicy DB throw fallback 未 cover,沿用 v023 F3 sane fallback):Step D2 加 try/catch wrap + `taskReassignment = {status:'failed', error: e.message}` + `console.warn` + 不抛错给 caller(spawn/adopt 已 commit 不回滚);Step G4 加 mock throw fallback test
  - **Round 4 MED-3**(双方独立 claude MED + 新 codex MED — emit task-changed deleted events safeEmit 缺位):Step D2 emit 改 safeEmit pattern(per-id try/catch + console.warn + continue)沿用 hand-off-session.ts:754-763 现有 pattern;Step G4 加 mock listener throw 仍 continue test
  - **Round 4 MED-4**(新 codex 独有 — D8 没点名更新现有 allow-external test 断言,8 处旧 contract):Step C7 + Step G3 显式列改造 — `task-external-caller.test.ts:45` `EXTERNAL_CALLER_ALLOWED.task_get` toBe(true → false) + `:63-65` 移 task_get 出 read-only 例外 / `spoofing-attack-paths.test.ts:307-308` + `:316-322` 同款 / `task-crud.test.ts:7` jsdoc + `:331` describe 改名 + 内部断言改 reject
  - **Round 4 LOW-1**(claude — Round 2 LOW-3 fix 历史 mapping 表述歧义):本段已用清晰文字「F8 .get(teamId) 标 Round 3 待补 → Round 3 MED-3 已修正(.get(teamId) 替换 findById)」明示 fix path 一眼可见
  - **Round 4 LOW-2**(claude — Phase F1 列 Layer 1 SSOT 内容破坏 §不变量 8 边界):Step F1 改写「仅 Layer 2 内容:使用模式 + 决策依据」+ 显式指 Layer 1 字段定义 SSOT 在 Step C1 schemas.ts + Step C7 types.ts 内 enforce,F1 不复述 EXTERNAL_CALLER_ALLOWED.task_get=false 等 Layer 1 SSOT 内容
- Round 5 deep-review fix:本会话 Step 1.5 Round 5 reviewer-claude(0 HIGH + 2 MED-new + 1 LOW-new,**Round 4 fix 全 inline 0 drift**)+ 新 reviewer-codex(0 HIGH + 2 MED-new + 1 LOW-new)= 完全 0 overlap 互补,去重后 **0 HIGH + 4 MED + 2 LOW 全 fix 进 plan**(**R5 首轮 0 HIGH 设计稳定**):
  - **Round 5 MED-1**(claude — Step B2 vs G2 applyHandOffSkipPolicy 测试描述字符级 100% 重复,Round 4 fix 摘要宣告 fold 但实际 B2 没真删):Step B2 删 applyHandOffSkipPolicy / cascade delete / reassignOwner 两态 / list filter 描述,只留 schema 改造 trivial scope(team_id 字段 INSERT + FK SET NULL 触发 + PRAGMA foreign_key_list 验);applyHandOffSkipPolicy / cascade / reassignOwner / list filter 全权交 Step G2
  - **Round 5 MED-2**(codex — 测试覆盖矩阵表 line 422 仍写 `reassignOwner policy 三态(... / skip)` 与 Step G2 line 318 已修正两态不一致 — HIGH-2 fix 漂移到第三处):测试覆盖矩阵表 row 2 改 `reassignOwner policy 两态(clear-team / preserve-team)` + applyHandOffSkipPolicy 三 case;§参考 §测试覆盖矩阵 第 10 条同款修正
  - **Round 5 MED-3**(codex — D8 旧 allow-external 测试清单漏 task-external-caller.test.ts:81 stdio ALLOW case;codex nl -ba 实证 :63-65 HTTP block + :81-83 stdio block 对偶,plan 只列 HTTP):Step C7 + Step G3 加 `:81-83 stdio` 同款改造(it.each 移除 task_get + 独立 stdio DENY case)
  - **Round 5 MED-4**(claude — Step D2 'skip' 分支 safeEmit + outer try/catch + DB throw fallback 三块分散列出,伪代码 2 用 `// ... safeEmit loop` 注释占位让 implementer 严格 literal 读会误把 safeEmit 放 outer try 外让 fallback emit gap):Step D2 'skip' 重写**单一完整伪代码块** — outer try 内 inline safeEmit loop + catch fallback,显式锁住嵌套层级语义(safeEmit listener throw 走 inner continue 不冒泡 outer catch;DB throw 走 outer catch + deletedTeamTaskIds 不存在 emit 自然跳过)
  - **Round 5 LOW-1**(codex — §已知踩坑 11 仍写直接 `eventBus.emit` 未同步 safeEmit 术语):§已知踩坑 11 改成 「handler commit 后 per-id safeEmit task-changed deleted event(inner try/catch + console.warn + continue;listener throw 仅 warn 不冒泡 outer fallback)」+ 引用 hand-off-session.ts:754-763 现有 pattern + 完整伪代码见 Step D2
  - **Round 5 LOW-2**(claude — Step C1 ↔ Step D2 adoptedTeamIds 同源 spread mapping 没显式 wire,implementer 可能漏 spread phase15Detail.adoptedTeamIds → ok return.adopted.adoptedTeamIds):Step D2 末尾加显式 mapping 「handler return 段 ok return.adopted block 必须 spread `adoptedTeamIds: phase15Detail.adoptedTeamIds`(与 `preserved` 字段并列)确保同源,implementer 不能漏」
- Round 6 deep-review fix:本会话 Step 1.5 Round 6 reviewer-claude(0 HIGH + 1 MED + 0 LOW,**首次 0 LOW**)+ reviewer-codex(0 HIGH + 1 MED + 1 LOW)= 完全 0 overlap 互补,去重后 **0 HIGH + 2 MED + 1 LOW 全 fix 进 plan**(**R6 连续两轮 0 HIGH design 完全稳定**):
  - **Round 6 MED-1**(claude — Step B1 (L188-193) vs Step D2 (L263-268) applyHandOffSkipPolicy 4 步实现描述字符级 95%+ 重复 SSOT 漂移已实证 — Step D2 step 3 多句「但在新 helper 内一次性处理批量 deletedTeamTaskIds 不是逐个 BFS」,Step B1 无):Step D2 L263-268 fold 改成只引用 Step B1 helper 接口契约 `(callerSid, newSid) => {deletedTeamTaskIds, reassignedPersonalCount}`,4 步实现细节 SSOT 单一在 Step B1。与 Round 5 MED-1 (B2 vs G2 fold 进 G2) 同型修法
  - **Round 6 MED-2**(codex — schema 加 required `taskReassignment.policy` field 但 Step D2 单一伪代码 + archive_caller=false 示例缺 policy 字段,implementer TS 编译失败 / schema 漂移):Step D2 加 `const taskPolicy = args.team_task_policy ?? 'clear-team'` 局部常量;所有 5 个 assignment 路径(skip ok / skip failed / clear-team / preserve-team / archive_caller=false)都带 `policy: taskPolicy` field;伪代码块显式 `policy: taskPolicy` inline + 嵌套语义节加「policy field required」段;Step G4 加每个 assignment 路径都断言 taskReassignment.policy === <expected>
  - **Round 6 LOW-1**(codex — 测试覆盖矩阵表 hand_off row 仍写「emit deleted events 每行 emit」+ 3 case a/b/c,没同步 safeEmit / case d / adoptedTeamIds surface):测试覆盖矩阵表 row 4 同步成 摘要版「'skip' policy 真删 + per-id safeEmit + DB throw fallback + emit listener throw 仍 continue + preserve policyWarning 升级 4 case(含 case d L814+L839 双 push 完整性)+ adopted.adoptedTeamIds surface + 每个 assignment 路径都带 policy field」
- Round 7 deep-review 收口 fix:本会话 Step 1.5 Round 7 **正式收口** — reviewer-claude(0 HIGH + **0 真 MED** + 1 LOW)+ reviewer-codex(0 HIGH + **0 真 MED** + 1 LOW),**双 reviewer 都明确给出「Round 7 可收口」verdict**,达 SKILL §收口规则 0 HIGH 0 真 MED 阈值。2 处 LOW 收口 polish fix:
  - **Round 7 LOW-1**(codex — 不变量 5 / D4 / G4 矩阵表 3 处 archive_caller=false 示例缺 policy 字段示例性补全):3 处 abbreviated object/assertion 加 `policy: <resolvedPolicy>` advisory(caller 知道传了什么但实际未执行 policy)— Step G4 矩阵表加 archive_caller=false × 全部 assignment path 断言 `policy === expectedPolicy`
  - **Round 7 LOW-2**(claude — Step D2 `taskPolicy` 局部常量 scope 不明,伪代码块 L270 const 在 'skip' block scope 但 L312-313 prose 暗示外层 scope 自相矛盾):伪代码块前置说明加段「**`taskPolicy` const 必须在 reassign 段顶部声明(在 args.archive_caller / args.team_task_policy 三分支判断之前),让 4 个 assignment 路径(skip ok / skip failed / clear-team / preserve-team / archive_caller=false)共用同一外层 scope** — 下方伪代码块 L1 `const taskPolicy = ...` 仅是示意,implementer 实施时该 const 应放在 reassign 段顶部 / 三 branch if/else 之前,而非 'skip' 分支内 block scope」

**Plan §Step 1.5 Deep-Review 总收敛趋势**(7 轮 fix loop 完整记录):
- R1: 2 HIGH + 7 MED + 2 LOW(设计 + ripple)
- R2: 1 HIGH + 3 MED + 3 LOW(design 边界)
- R3: 1 HIGH + 3 MED + 4 LOW(实现细节)
- R4: 2 HIGH + 4 MED + 2 LOW(fix 引入新矛盾 — 老 codex shutdown + re-spawn)
- R5: 0 HIGH + 4 MED + 2 LOW(**首轮 0 HIGH design 稳定**,polish 收敛)
- R6: 0 HIGH + 2 MED + 1 LOW(连续两轮 0 HIGH + 首次 0 LOW)
- R7: 0 HIGH + 0 真 MED + 1 LOW(**正式收口** — 双方独立 verdict ✅)

**异构对偶价值实证**(7 轮全程):
- 7 轮 reviewer-claude × reviewer-codex 完全 0 overlap finding(无任何 round 有重叠 — 教科书级互补)
- claude 强项「应用层架构 / 设计漂移 / 双端 SSOT 同步纪律 / 测试矩阵盲区 / plan 内部一致性 / 跨 step ripple」反复命中
- codex 强项「实现细节 / SQL 原子性 / FK / chunked SQL 边界 / migration 实测 / schema vs handler 字段一致性 / 旧 test contract grep / 术语漂移」反复命中
- R4 老 codex shutdown + re-spawn 后 fresh 跑 R1 fresh review 仍能独立挖出 HIGH-1/HIGH-2 同款根因 → 异构对偶不依赖跨轮 mental model 持久化
- 教科书级 case:R1 SQLite ALTER ADD COLUMN REFERENCES 假设错误(claude HIGH-1 + codex sqlite3 实测)/ R3 phase15Detail.preserved 字段语义错(claude HIGH + codex MED)/ R4 adoptedTeamIds 漏 firstTeam push(claude HIGH + 新 codex HIGH)/ R5 全部 0 overlap 互补
