# CHANGELOG_86: 拆 src/main/session/manager.ts 734 → 5 sibling 文件

**plan**: deep-review-and-split-20260513 Phase 4 Step 4.3 (sub-plan: phase4-manager-split-20260513) — Tier 3 manager.ts 收口

## 概要

把 `src/main/session/manager.ts` (734 LOC，超 500 护栏 47%) 拆成 4 个 sibling 文件 + 保留 manager-helpers.ts。最大子文件 manager.ts 439 LOC（margin 12%）。CLAUDE.md「单文件 ≤ 500 行」护栏全文件达成。

3 个 atomic commit 串行：enrich → team-coordinator → ingest-pipeline。每 commit 独立 typecheck + 5 文件 29 it 测试通过；commit 3 后全量 324 vitest 通过。

唯一行为变更：`_leaveAllActiveTeams` 与 `delete()` 段 1 dup 合并为 `leaveTeamsAndAutoArchive(sid, reason)`，archive reason 由参数 explicit map 区分（'last-lead-closed' / 'last-lead-deleted' DB 投影 100% 等价）。其它纯物理拆分。

走 `agent-deck:deep-code-review` SKILL R1 异构对抗（reviewer-claude + reviewer-codex teammate 设计层 review）共出 22 条 finding（HIGH 4 / MED 11 / LOW 3 / INFO 4）；lead 三态裁决后 9 条必修整合到实施（含 facade 反向裁决采纳取代 implements / top-level eventBus / typecheck cmd 订正 / 代码 diff 验证策略 / jsdoc 不行号），4 条写入 H5 follow-up。

## 变更内容

### 拆分 layout

```
src/main/session/
├── manager.ts                       (734 → 439 LOC)  facade — class + state + 11 lifecycle method + ingest 入口
├── manager-helpers.ts               (84  LOC, 不动)   pure helpers
├── manager-ingest-pipeline.ts       (224 LOC, 新)     5 段 pure 函数 + IngestContext facade 契约
├── manager-team-coordinator.ts      (158 LOC, 新)     3 个 team 联动 helper（含 dup 消除）
├── manager-enrich.ts                (55  LOC, 新)     2 个 read enrich 函数
├── lifecycle-scheduler.ts           (109 LOC, 不动)
└── summarizer.ts                    (418 LOC, 不动)
```

### Commit 1 — `b900e37` Phase 4 Step 4.3.1：抽 manager-enrich.ts (55 LOC) + 删 unused top-level import

- 新建 `manager-enrich.ts`：export `enrichRecordWithTeams(rec)` + `enrichRecordsWithTeamsBatch(recs)` 两 free function（搬自 SessionManagerClass.enrichWithTeams / enrichWithTeamsBatch）
- 改 `manager.ts`：class 保留同名 `enrichWithTeams` / `enrichWithTeamsBatch` thin wrapper 委托 free fn 维持 `sessionManager.enrichWithTeams(rec)` / `enrichWithTeamsBatch(recs)` 公共 API 不变（外部 caller src/main/index.ts:236 / ipc/sessions.ts:55 / mcp/handlers/list.ts:65 全部无感）；`list()` / `get()` 改调 free fn
- 顺手修：删 `manager.ts:11` top-level `import { agentDeckTeamRepo }` 行（剩余 4 处 lazy import 段不依赖 top-level；不删 typecheck noUnusedLocals 报错）

### Commit 2 — `79c4c65` Phase 4 Step 4.3.2：抽 manager-team-coordinator.ts (158 LOC) + 合并 leave→archive dup

- 新建 `manager-team-coordinator.ts`：3 个 export
  - `leaveTeamsAndAutoArchive(sid, reason: 'closed'|'deleted')` —— 合并自 class 内 `_leaveAllActiveTeams` (close/markClosed 用 reason='closed') + `delete()` 段 1 (reason='deleted')。两段实现结构 100% 等价：双层 try/catch + 同序 `leaveTeam → emit member-changed → countActiveLeads → 0-lead archive → emit team-updated`；唯一差异 archive reason 字符串，由 satisfies `Record<SessionEndReason, AgentDeckTeamArchiveReason>` map explicit 区分。jsdoc 顶部加 `@warning delete 路径必须 await`（FK ON DELETE RESTRICT 否则 DB 半态）。
  - `archiveTeamsIfOrphaned(sid)` —— 等价搬自 class `_archiveTeamsIfOrphaned`（archive(sessionId) 联动用）
  - `unarchiveTeamsForRevivedLead(sid)` —— 等价搬自 class `_unarchiveTeamsForRevivedLead`（unarchive(sessionId) 联动用，REVIEW_32 MED-7 守门只复活 'last-lead-archived'）
- 改 `manager.ts`：class lifecycle method 改调 free function（markClosed / close / archive / unarchive / delete）；delete() 段 1 整段删除，开头改单行 `await leaveTeamsAndAutoArchive(sessionId, 'deleted')`
- Import 策略：`eventBus` 用 top-level（与原 `_leaveAllActiveTeams` 一致；避免 close/markClosed 路径异常边界因 lazy await 多 microtask 漂移）；`agentDeckTeamRepo` 维持 lazy import 与 historical 模式对称（manager-enrich.ts 已 top-level import 它，已无真实 cycle，是过保护）

### Commit 3 — `0a920a0` Phase 4 Step 4.3.3：抽 manager-ingest-pipeline.ts (224 LOC) + IngestContext facade

- 新建 `manager-ingest-pipeline.ts`：
  - export `interface IngestContext` —— 5 行为方法契约（`hasSdkClaim` / `claimAsSdk` / `consumePendingSdkClaim` / `ensure` / `isRecentlyDeleted`），不暴露 raw Set / Map field
  - export 5 段 pure free function：`dedupOrClaim` / `ensureRecord` / `persistEventRow` / `persistFileChange` / `advanceState`。dedupOrClaim 5 个分支字字保留（含 REVIEW_5 H1 / REVIEW_12 Bug 5 / M3 team-* hook 早返 / sdkOwned dedup）；advanceState 状态机 + lifecycle 复活语义保留；其它 3 段照搬。
  - 文件头 jsdoc 写明 architectural rationale：「为何选 facade 而不 implements」（pipeline 函数收到 facade，cast `(ctx as any).sdkOwned` 返回 undefined / 闭包封装 raw state / 5 个 helper method 保持 private） + 「sessionManager 自身仍 cast 可达，H5 follow-up 评估升级 #sdkOwned 真私有」
- 改 `manager.ts`：
  - `SessionManagerClass` 加 `private readonly ingestCtx: IngestContext` 字段 + ctor 构造 `Object.freeze<IngestContext>({...5 closures...})`，闭包封装 `sdkOwned` / `pendingSdkCwds` / `recentlyDeleted` 三 private state
  - 删 class 内 5 段 private method（共 ~140 LOC）
  - `ingest()` 入口注释保留（CHANGELOG_20 / B 5 段架构 motivation + 「dedupOrClaim 必须最前 + 早返」硬约束），方法体改调 `dedupOrClaim(this.ingestCtx, event)` 等 free fn
  - `private sdkOwned` 字段加 jsdoc 警告「⚠ DO NOT migrate to ECMAScript `#sdkOwned`」（manager-public-api.test.ts:134 反射依赖 TS-private 是 compile-time-only 属性）
  - `UpsertOptions` 改 export（manager-ingest-pipeline.ts 的 IngestContext.ensure 需要共享类型）
  - 顺手清 unused import：LifecycleState / eventRepo / fileChangeRepo / extractCwd / nextActivityState（5 段抽出后顶层不再使用）

### SKILL R1 异构对抗 review 整合

reviewer-claude + reviewer-codex 双 teammate 各审 plan + 现场 grep 验证，共 22 条 finding（HIGH 4 / MED 11 / LOW 3 / INFO 4）。lead 三态裁决：
- 双方一致 ✅ 4 条（IngestContext 不能强制护 raw state / eventBus lazy vs top-level / 目录化前必停 dev / orphan team 35min 窗口非永久）
- 单方 HIGH lead 反向裁决 1 条：HIGH-B1（Object.freeze facade vs implements）— 复审后 lead **采纳 B 方案** 取代原 implements 路线（facade 闭包让 pipeline cast 不可达，又能让 5 个 helper method 保持 private）
- 其余 HIGH/MED 全数 ✅ 真问题整合到实施（详 commit 注释）

完整裁决见 plan `/Users/apple/.claude/plans/adaptive-orbiting-snowglobe.md` §SKILL R1 finding 整合裁决 节。

### H5 follow-up 列表（写入主 plan piped-fluttering-moth.md Phase 5）

1. **markDormant / markClosed dead-ish API**：lifecycle-scheduler 跳过它们直接 `sessionRepo.batchSetLifecycle` → orphan team membership ≤ 35min（TeamLifecycleScheduler D7 兜底归档 team 但 membership 残留）。评估「死代码删 / scheduler 改回走 D6」
2. **mock 缺 .get / .unarchive**：`manager-test-setup.ts:210-223 makeAgentDeckTeamRepoMock` 历史欠债（CHANGELOG_31 Bug 5），靠 short-circuit 不暴露。一旦未来 lead session 关联真实 membership 必须补
3. **leaveTeamsAndAutoArchive characterization test**：team-coordinator.ts dup 消除验证当前靠代码 diff，应补一个独立单测覆盖 `leaveTeam → member-changed → countActiveLeads → archive → team-updated`，分别断言 closed/deleted reason
4. **ECMAScript `#sdkOwned` 真私有升级**：SessionManagerClass `private sdkOwned` 升级到真私有 + manager-public-api.test.ts:134 反射测试改用 `hasSdkClaim` API 断言

## 验证

- `pnpm typecheck` 双端通过（每 commit 必跑）
- `pnpm vitest run src/main/session/__tests__/` 4 文件 29 it 全过（每 commit 必跑）
  - `manager-public-api.test.ts:134` 反射 `sdkOwned` 关键 it ✓（class 仍 OWN 字段，facade 闭包不影响）
  - `manager-ingest.test.ts` REVIEW_5 H1 关键 it ✓（dedupOrClaim 5 分支字字保留）
  - `manager-delete.test.ts` 3 it ✓（dup 消除路径行为等价；现 mock 走空 short-circuit 不真验链路，依赖代码 diff 验证 + commit message diff trail）
- `pnpm vitest run` 全量 324 tests 全过（commit 3 后跑）；3 个 "failed suites" 是 Electron / SQLite binding pre-existing infra 限制（HEAD baseline 同款，CHANGELOG_42 备案），与本拆分无关
- dev smoke 留 H5 完整冒烟一并做（纯物理拆分零业务行为变更 + dup 消除已 commit message 留 diff trail）
