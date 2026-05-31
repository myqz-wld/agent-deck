# REVIEW_71 — 全项目 deep review 批 A1：MCP hand-off orchestration

- 日期: 2026-05-31
- 类型: Debug / 功能 BUG + 代码优化 + 文字措辞（全项目 deep review 第一批）
- 触发: 用户「deep review 下项目，聚焦功能 BUG、代码优化和文字措辞优化，我要离开一会儿，你一路推进，自主决定 hand off 时机」。授权写入 plan `deep-review-project-20260531`。
- 关联: plan deep-review-project-20260531 / worktree-deep-review-project-20260531 / base commit 7f96617
- 方法: 多轮异构对抗（reviewer-claude Opus 4.7 + reviewer-codex gpt-5.5 xhigh，in-process SDK teammate）+ 反驳轮 + 三态裁决。lead 自己 pre-read 全 7 文件建 adjudication 基线 + 现场验证关键机制。
- 收口: R1 双 reviewer 各出 finding（无重叠，全单方）→ 交叉反驳轮（codex HIGH → claude 反驳 / claude MED-1 → codex 反驳）→ 三态裁决 3 条 ✅。typecheck 双配置 clean + 全量 agent-deck-mcp 560 passed / 3 skipped（含 2 新增回归 test）。

## 范围（批 A1）

MCP hand_off_session（跨会话 baton 接力）核心 orchestration，7 文件 ~2000 LOC：
- src/main/agent-deck-mcp/tools/handlers/hand-off-session-impl.ts
- src/main/agent-deck-mcp/tools/handlers/hand-off-session/_deps.ts
- src/main/agent-deck-mcp/tools/handlers/hand-off-session/cwd-resolver.ts
- src/main/agent-deck-mcp/tools/handlers/hand-off-session/handler-main.ts
- src/main/agent-deck-mcp/tools/handlers/hand-off-session/task-reassign-coordinator.ts
- src/main/agent-deck-mcp/tools/handlers/hand-off-session/team-adopt-coordinator.ts
- src/main/agent-deck-mcp/tools/handlers/shutdown-baton-teammates.ts

> 该子系统经多轮历史 review（REVIEW_32/33/36/37/56 + 多个 plan），代码极成熟。本轮聚焦 adoptTeammates 路径（最新 Phase 6/7 引入）的未覆盖边角。

## 三态裁决（3 ✅ 必修 + 1 INFO 文档漂移）

### ✅ HIGH-2 `adoptTeammates:true + archiveCaller:false` 无 guard → caller 被踢出所有 team 却仍存活
reviewer-claude 提（判 MED）→ reviewer-codex 反驳轮独立判 **HIGH** → lead 裁 HIGH（正常文档化输入可达，破坏 schema 承诺）。

- **文件**: `team-adopt-coordinator.ts:107`（validateAdoptTeammatesArgs N2.c guard 只拦 teamName）+ `schemas.ts:668`（refine 只拦 teamName）+ `handler-main.ts:291`（phase 1.5 swapLead 触发只看 adoptTeammates，与 archiveCaller 无关）
- **后果链**（双 reviewer 一致 + lead 代码路径追踪）：两 flag 各自被 schema 文档为合法，但组合后 ① phase 1.5 swapLead **无条件** demote caller（member `left_at=now`，离开所有 adopted team）② runTaskReassignment 因 `archiveCaller===false` 走 skip → task 不过继，caller 仍 owner ③ baton-cleanup `archiveCaller===false` → caller 不归档仍 active。**净结果**：caller 仍存活但已离队 → 其 team-bound task `isCallerInTeam` false 失去读写范围（owner 语义与权限语义漂移）+ 与 preserved teammate 不再共享 active team → `send_message` 撞 no-shared-team，**直接打破 `archiveCaller:false` schema 承诺「caller 仍可看 reviewer reply」**。
- **验证**: grep 确认无该组合 guard（只有 N2.c teamName）；读 handler-main.ts:291 触发条件不含 archiveCaller；读 member-crud Phase A demote 写 left_at；无 test 覆盖该组合。
- **修复**: 与 N2.c 同款双层防御 — `validateAdoptTeammatesArgs`（handler 入口，生产路径走 SHAPE）+ `HAND_OFF_SESSION_ARGS_SCHEMA.refine`（schema 层）双拦 `adoptTeammates===true && archiveCaller===false` → err。
- **回归 test**: `hand-off-session.adopt-teammates.test.ts` 「REVIEW_71 handler 防御」— 同传立即 reject + spawn/swapLead/archive 全 0 调用（零半提交）。

### ✅ MED-1 `processSwappedTeam` 内 list/get 裸调用无 try/catch → swapLead 成功后 DB 异常致半提交
reviewer-codex 提（判 HIGH）→ reviewer-claude 反驳轮 mechanism 100% 确认（4 前提逐一核实）/ 独立判 **MED** → lead 裁 MED（机制真实必修，但触发需罕见基础设施故障）。

- **文件**: `team-adopt-coordinator.ts:342`（listMembersFn 裸调用）+ `:349`（循环内 getSessionFn 裸调用）
- **不对称**: 同函数下方 emit/notify 全用 `safeEmit` 包裹（L377-406，注释明示「不让 side-effect 异常打断 swap 主流程」），但上半段 list/get 漏防 = half-wrap oversight。`processSwappedTeam` 整个函数体都是 swapLead commit 之后的 post-commit bookkeeping。
- **半提交机制**（双 reviewer + lead 三方核实）：`withMcpGuard`（helpers.ts:137-143）**不** try/catch handler 本体（仅 deny + validate 后 `return handler(...)`）。任一 list/get 抛错 → 从 runPhase15AdoptSwapLeadLoop 冒泡穿透 → 此时 firstTeam swapLead **已 commit**（caller demote + newSid 升 lead）+ 新 session **已 spawn**，但 task reassignment + runBatonCleanup（含 archive caller）**未跑** → caller 被 demote 离队却未归档 + task 未过继的脏态。即使上层框架 catch 转 tool error 也无法回滚已 commit 的 swapLead。
- **严重度刻度**（claude 反驳轮核心）：触发需 SQLite locked / disposed connection，且发生在「同连接 swapLead transaction 刚成功 commit 微秒后」窗口几乎不可达（若连接已死 swapLead 自己就抛了走 fatal abort 干净路径）。无数据丢失、可人工恢复 → MED 而非 HIGH。但 fix 极廉价 + 后果脏，按 safeEmit 同款哲学补防护。
- **修复**: listMembersFn 包 try/catch（失败 → team-level `list-members-error` failed + teammates=[]）；循环内 getSessionFn 包 try/catch（失败 → push `lifecycle-query-error` failed + continue）。
- **回归 test**: `hand-off-session.adopt-teammates.test.ts` 「REVIEW_71 fail-soft」— listAllMembersForAdopt 抛错时 handler 仍 ok return + archive caller 仍跑 + failed 含 list-members-error（修前会冒泡致 tool error + 半提交）。

### ✅ INFO 文档漂移 `spawnData.teamId` → `findActiveMembershipIn`（文字措辞）
reviewer-claude 单方 + lead grep 核实。

- **文件**: `task-reassign-coordinator.ts:70`（jsdoc）+ `schemas.ts:956`（jsdoc）+ `tools/index.ts:258`（tool description，model-facing）
- **问题**: CHANGELOG_169 F5 已把 preserve-team safety 的 newSidActiveTeamIds 来源从「信任 spawnData.teamId」改为「findActiveMembershipIn 实测」（代码正确），但 3 处 jsdoc/description 仍写 `∪ spawnData.teamId`，同文件内与正确注释（L13/198/259）不一致，误导维护者 + model。
- **修复**: 3 处统一改为 `∪ findActiveMembershipIn 实测`（并注明 CHANGELOG_169 F5 起不再信任 spawnData.teamId）。

## ❌/❓ 已综合（不修）

### ❓ codex MED：partial adopt 失败 team 的 teammate 泄漏（验证为真，列 follow-up 留用户决策）
- **文件**: `handler-main.ts:331`（无条件传 adoptTeammates:true 给 baton-cleanup）+ `baton-cleanup.ts:234`（adopt=true 全局跳过 shutdown）
- **机制确认**（lead 读 archiveTeamsIfOrphaned manager-team-coordinator.ts:101-126）：非 firstTeam swapLead 失败时只 push failed + continue，但 handler 仍向 baton-cleanup 传 adoptTeammates:true → cleanup 对 adopt=true **无条件** skip shutdown。失败 team 既没被新 session 接管（swap 失败），也没 teammate shutdown；caller archive 后 team auto-archive 只更新 `archived_at` **不关闭 teammate session** → 失败 team 的 teammate 泄漏（占内存 + SDK live query）。
- **不立即修的理由**（lead 授权边界）：fix 是 design-level（baton-cleanup 需 team-scoped：对 adoptedTeamIds 跳过、对 failed lead-team 执行 shutdown；或把任何 non-first lead-team swap failure 提升 fatal）。两种方案各有 tradeoff，且触发需「multi-team adopt + 非 firstTeam swapLead 失败」双重罕见条件，会改动 partial-adopt 语义 + 可能破坏现有 locked test。按用户「不做超出范围的功能性改动 / 涉及设计取舍留用户确认」边界，列为**已验证 follow-up** 留用户回来定方案。

## 验证

- typecheck: tsconfig.node.json + tsconfig.web.json 均 exit 0
- test: 全量 agent-deck-mcp 35 文件 560 passed / 3 skipped（含 2 新增回归 test）
- 关键核实：现有 56 个 adopt/task-reassign/baton-cleanup test 全过（新 guard 不破坏既有，因无 test 组合 adoptTeammates:true + archiveCaller:false）

## Follow-up（留用户决策）

1. **[MED 已验证] partial adopt 失败 team teammate 泄漏** — 见上 ❓ 节。需 design 决策：baton-cleanup team-scoped shutdown vs non-first swap failure 提升 fatal。
2. **[LOW] 同 callerSessionId 在 handler 内 sessionRepo.get 重复反查 2 次**（cwd-resolver.ts:69 + :131）— PK lookup 极快，纯优化，可合并传 row。
3. **[LOW] 显式 args.cwd 无 existsSync 预检**（仅 auto-default 有）— caller 显式责任 + spawn 报错不静默，优先级低。
