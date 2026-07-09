# spike2 — architecture/flows 图通俗化 audit

> Phase 3 Step 3.1 spike (read-only audit)。基线 commit `9d55c64`(Phase 2 收口),scope 17 张 puml (8 architecture + 9 flows) + 2 份 INDEX.md。
> 评判标准:user CLAUDE.md / 应用打包 CLAUDE.md §D7 「架构图通俗化方法论」(≤ 5 层 / ≤ 12 节点 / 节点名优先用日常术语 / INDEX 概要列 ≤ 80 字白话)。
> **本 spike 是 read-only,不动 .puml / 不动 INDEX**;输出重写计划供 Step 3.2 / 3.3 / 3.4 实施。

## 动机

Phase 1 §当前进度 已确认两份 INDEX.md 概要列 "写满 LOC + commit hash 需重写"(plan §D7);plan §不变量「架构图不删信息只换形式」要求宏观重写但保留 design invariant。Step 3.1 spike 量化当前违规程度 + 制定分级重写策略 + 与 user confirm 后进 Step 3.2-3.4。

## 实测数据汇总

### LOC + node 数(实测命令:`wc -l ref/architecture/*.puml ref/flows/*.puml` + `grep -cE "^(participant|actor|component|state|database|node|cloud|queue|interface|usecase|class|object|enum|package|folder|frame|rectangle|card|control|boundary|entity)\b"`)

| 文件 | LOC | grep node | 实际复杂度 |
|---|---|---|---|
| **architecture (8 张, 总 1021 LOC)** | | | |
| agent-deck-mcp-architecture | 192 | 13 | 13 packages 嵌套 + 30+ component |
| hand-off-session-architecture | 144 | 11 | 11 packages + 20+ component |
| archive-plan-architecture | 129 | 11 | 11 packages + 20+ component |
| hand-off-session-state-machine | 134 | 6 | 6 entity 并行 state |
| sdk-bridge-state-machine | 121 | 5 | 5 entity 并行 state |
| sdk-bridge-architecture | 109 | 5 | 5 packages + 20+ component |
| archive-plan-state-machine | 105 | 5 | 5 entity 并行 state |
| universal-message-status-state-machine | 87 | 5 | 5 state 单 entity |
| **flows (9 张, 总 1185 LOC)** | | | |
| hand-off-session-decision | 174 | 0 (activity) | 6 partition + 多嵌套 if/elseif |
| hand-off-session-flow | 166 | 11 | 8 alt block + 多 note |
| archive-plan-precheck-decision | 154 | 0 (activity) | 5 partition + 嵌套 |
| archive-plan-flow | 143 | 10 | 7 步 sequence + 9 note |
| sdk-bridge-recovery-decision | 121 | 0 (activity) | 5 partition |
| sdk-bridge-resume-recovery-flow | 117 | 9 | 6 partition |
| universal-message-dispatch-decision | 112 | 0 (activity) | 多 partition + SQL 细节 |
| universal-message-dispatch-flow | 112 | 8 | 7 loop + SQL 细节 |
| agent-deck-mcp-tool-call-flow | 86 | 10 | 6 alt block |

**totals**: 17 张图 = 2206 LOC,architecture 平均 128 LOC,flows 平均 132 LOC。

### INDEX.md 概要列长度抽样

`ref/architecture/INDEX.md` 8 行,每行 200-400+ 字:
- agent-deck-mcp-architecture 概要 = 350+ 字,含 LOC × 4 / commit × 3 / REVIEW × 1 / 内部 module 名 × 10+
- archive-plan-architecture 概要 = 300+ 字,含 LOC × 3 / commit × 1 / batch reference × 3 / 内部 module 名 × 10+
- hand-off-session-state-machine 概要 = 280+ 字,含 plan-id × 1 / batch reference × 1 / 内部 module 名 × 15+

`ref/flows/INDEX.md` 9 行,每行 150-250 字:
- hand-off-session-flow 概要 = 250 字,含 plan-id × 1 / CHANGELOG × 1 / phase × 4 / 内部 module 名 × 10+
- archive-plan-precheck-decision 概要 = 230 字,含 LOC × 0 / commit × 1 / 内部细节 × 20+
- universal-message-dispatch-decision 概要 = 200 字,含 REVIEW × 1 / 内部细节 × 12+

**结论**: 17 行概要全部严重超 D7 「≤ 80 字白话」标准(平均超 3-5 倍)。

## 普遍问题(17 张图汇总 + 2 INDEX)

### 问题 A: 节点 / 层 / 复杂度严重超 D7 上限

D7 标准:**≤ 5 层 / ≤ 12 节点**。

实测违规:
- `agent-deck-mcp-architecture` 13 packages × 30+ component 元素,**最严重**
- `archive-plan-architecture` / `hand-off-session-architecture` 各 11 packages × 20+ component
- `hand-off-session-decision` 6 partition + 多嵌套 if/elseif(把代码逻辑直译成 activity 图)
- `hand-off-session-state-machine` 6 entity 并行 state(单图塞 6 个独立状态机)
- flows 大量 sequence 图 8+ alt block(过度展开分支)

### 问题 B: 术语堆砌(codename / 内部 module 文件名直接进图)

D7 要求:**节点名优先用日常术语,括号注内部名**。

实测违规(每张图都有):
- module 文件名直接出现: `archive-plan-impl.ts` / `hand-off-session-impl.ts` / `sdk-bridge/index.ts` / `recoverer.ts` / `restart-controller.ts` / `precheck-helpers.ts` / `index-sync-helpers.ts` / `_shared/default-impl-deps.ts` / `thread-options-builder.ts` / `create-session-rollback.ts` / `resume-path-await.ts` / `codex-recoverer-messages.ts` / `mcp-session-token-map.ts` / `codex-jsonl-fallback.ts` / `baton-cleanup.ts` / `shutdown-teammates-on-baton.ts` / `adopted-teams-context-block.ts`
- 内部 helper 函数名: `withMcpGuard` / `EXTERNAL_CALLER_ALLOWED` / `runBatonCleanup` / `shutdownTeammatesOnBaton` / `archiveSourceSessionWithEmit` / `clearCwdReleaseMarker` / `resolveCallerCwdDeps` / `mergeCallerCwd` / `swapLead` / `findEligible` / `findEligibleExcludingTargets` / `claim` / `markDelivered` / `retryAfterFail` / `applyHandOffSkipPolicy` / `reassignTaskOwner` / `findCallerOwnedTeamIds` / `maybeJsonlFallback` / `recoverAndSend` / `renameSdkSession` / `releaseSdkClaim` / `pushUserMessage`
- API 字段名: `cwdReleaseMarker` / `archived_at` / `handOffMode` / `spawn-link` / `spawn_depth` / `extra_allow_write` / `excludeSessionIds` / `excludeTargets` / `permission_responder` / `team_task_policy` / `BATCH_LIMIT` / `BACKOFF_TIERS` / `MAX_RETRY`

### 问题 C: metadata 进图(LOC / commit hash / REVIEW 引用 / 修法标签)

D7 要求:**图本身去 LOC / commit hash / version 等 metadata,INDEX.md 第 3 列承载**。

实测违规(17 张图无一例外):
- LOC 直接写图中: `archive-plan-impl.ts (1281 LOC)` / `hand-off-session.ts 1249 LOC` / `hand-off-session-impl.ts 357 LOC` / `archive-plan.ts 285 LOC` / `recoverer.ts (662 LOC)` / `index.ts 793 LOC` / `index.ts 874 LOC` / `recoverer.ts 597 LOC` / `thread-options-builder.ts (49 LOC)` / `create-session-rollback.ts (96 LOC)` / `resume-path-await.ts (191 LOC)` / `adapters/types.ts 558 LOC`
- 第 1 行 ' commit 注释含 commit hash + batch 标签: `commit: 7475b75 (批 A) + d5549c6 + 5d389cf (批 C) + 8a41517 (hand-off plantUML)` / `commit: 627a0c2 + 5b66cd8 (批 B)` / `commit: d5549c6 (deep-review 批 C 收口)`
- REVIEW reference 进 note / package 名: `REVIEW_36 R2 HIGH-B + MED-C` / `REVIEW_56 §F9` / `REVIEW_59 批 A R2 反驳轮升` / `REVIEW_60 R1 codex MED-1 修法` / `REVIEW_60 R2 reviewer-claude HIGH 修法` / `REVIEW_60 R3 修法` / `REVIEW_60 R4 §保护清单 7 条` / `REVIEW_61 R1 LOW-α 修法` / `REVIEW_32 HIGH-1`
- 修法标签: `F1/F2/F6/F9/F10` / `批 A R1 F1 拆分` / `批 B R4 split refactor` / `H5 修法` / `P5 R1 reviewer-codex HIGH-2`
- plan id 进 note: `plan hand-off-session-adopt-teammates-20260520 P3` / `v024 plan task-team-id-restore-20260525`
- CHANGELOG reference: `CHANGELOG_109 抽 helper` / `CHANGELOG_99 cwd resilience` / `CHANGELOG_169 §保护清单` / `CHANGELOG_171 D follow-up`

### 问题 D: note 块过长(单 note ≥ 5 行)

D7 隐含:**note 留语义说明,细节去 ADR / REVIEW.md**。

实测违规:
- `archive-plan-state-machine.puml` N1 note 大段 20+ 行,塞失败兜底逐 phase 细节 + 与 hand_off baton 时序对比
- `hand-off-session-state-machine.puml` N1 note 25+ 行,塞 6 entity 联动 + 双模式差异 + 失败兜底 + 与 archive_plan 对比
- `sdk-bridge-state-machine.puml` N1 note 27+ 行,塞关键不变量 + cross-adapter parity + 失败兜底
- `universal-message-status-state-machine.puml` N1 note 18 行,塞所有 WHERE 子句 SQL 细节
- `agent-deck-mcp-architecture.puml` 散布 note bottom 段累计 15+ 行,塞 handOffMode 防御机制细节

### 问题 E: 跨图重复度高(同 component 在多张图重复出现)

architecture 8 张图共享大量 component:
- `withMcpGuard / EXTERNAL_CALLER_ALLOWED / sessionRepo / agentDeckTeamRepo / agentDeckMessageRepo / taskRepo / sessionManager / eventBus / SDK subprocess` 出现 ≥ 4 次
- `agent-deck-mcp-architecture` 与 `archive-plan-architecture` / `hand-off-session-architecture` / `sdk-bridge-architecture` 大量 component 重叠

未做的: 概览图 + 子主题图分层(让概览图承载 cross-cutting 组件,子主题图只画自己的差异)。

## Tier 分级 + 重写策略

按 LOC + 违规严重度排序。

### Tier 1: 严重违规(必须重画 — 8 张)

**全部超 D7 上限 + 大量 metadata 堆砌 + 复杂度过高**:

1. `agent-deck-mcp-architecture.puml` (192) — 缩 13 packages → 5 大块(transport / handler / impl+helpers / store / 外部组件)
2. `hand-off-session-decision.puml` (174) — 缩 6 partition → 3 大段(模式分流 / spawn+adopt / cleanup),去 metadata
3. `hand-off-session-flow.puml` (166) — 缩 8 alt block → 4 主路径,去 LOC / REVIEW reference
4. `archive-plan-precheck-decision.puml` (154) — 缩 5 partition → 3(预检 / 7 步 / cleanup),把 metadata 进 INDEX
5. `hand-off-session-architecture.puml` (144) — 缩 11 packages → 5 大块,去 §保护清单 metadata
6. `archive-plan-flow.puml` (143) — 缩 9 note → 4,去 LOC,note 留语义说明
7. `hand-off-session-state-machine.puml` (134) — 缩 25 行 N1 → 8 行,只留 6 entity 名 + 时序
8. `archive-plan-architecture.puml` (129) — 缩 11 packages → 5 大块,去 batch 标签

### Tier 2: 中度违规(简化 — 9 张)

**普遍 LOC 较小但单点细节超载**:

9. `sdk-bridge-recovery-decision.puml` (121) — 5 partition → 3 段,去 REVIEW reference
10. `sdk-bridge-state-machine.puml` (121) — 27 行 N1 → 8 行,只留 5 entity 名 + cross-adapter parity 一句
11. `sdk-bridge-resume-recovery-flow.puml` (117) — 6 partition → 3 段,去 LOC 注释
12. `universal-message-dispatch-decision.puml` (112) — 去 SQL WHERE 子句细节,note 留语义说明
13. `universal-message-dispatch-flow.puml` (112) — 去 SQL 细节 / RETURNING / regex
14. `sdk-bridge-architecture.puml` (109) — 5 packages 已合规,但去 LOC + R4 helper 标签
15. `archive-plan-state-machine.puml` (105) — 20 行 N1 → 8 行,只留 5 entity 名 + 失败兜底一句
16. `universal-message-status-state-machine.puml` (87) — 18 行 N1 WHERE 子句细节移到 ADR / REVIEW_61
17. `agent-deck-mcp-tool-call-flow.puml` (86) — 6 alt block → 4,去 EXTERNAL_CALLER_ALLOWED 字符串细节

### Tier 3: INDEX.md 概要列(重写 — 2 份)

`ref/architecture/INDEX.md` 8 行 + `ref/flows/INDEX.md` 9 行,**全部重写概要列**:
- 概要列 ≤ 80 字白话:典型 「archive_plan 收口流程图:7 步 git ff-merge + mv plan + worktree 删除 + 失败兜底」
- LOC / commit hash / REVIEW reference / 修法标签 / plan id **全部移到第 3 列**「关联 plan / commit」
- 第 3 列允许 markdown link list: `[REVIEW_59](../reviews/REVIEW_59.md) / [REVIEW_60](../reviews/REVIEW_60.md) / commit d5549c6`

## 通俗化术语映射(D7 落地参考)

实施 Step 3.2 / 3.3 时按本映射表替换:

| 原术语(codename / module 名) | 通俗术语 |
|---|---|
| `agent-deck-mcp` | MCP 服务器(括号注 codename) |
| `withMcpGuard` wrapper | 入口权限拦截器 |
| `EXTERNAL_CALLER_ALLOWED` config | 外部调用白名单配置 |
| `StreamableHTTPServerTransport` | HTTP /mcp 入口 |
| `HandlerContext` | tool 调用上下文 |
| `withMcpGuard` | 入口拦截 |
| `handler facade` | tool 入口层 |
| `impl 主体` | 业务实现层 |
| `_shared/default-impl-deps.ts` | fs/git 公共助手 |
| `runBatonCleanup` | baton 收尾流程 |
| `shutdownTeammatesOnBaton` | 关闭 teammate 助手 |
| `archiveSourceSessionWithEmit` | 归档 caller 助手 |
| `precheck-helpers.ts` | 预检助手 |
| `index-sync-helpers.ts` | INDEX 同步助手 |
| `sessionRepo / agentDeckTeamRepo / agentDeckMessageRepo / taskRepo` | 4 张数据表(会话 / 团队 / 消息 / 任务) |
| `agent-deck.sqlite (WAL 单进程)` | SQLite 数据库 |
| `sessionManager` | 会话管理器 |
| `LifecycleScheduler` | 生命周期调度器 |
| `TeamLifecycleScheduler` | team 30min 自动归档 |
| `spawn-controller / spawn-guards` | spawn 控制器 + 三道防御 |
| `universal-message-watcher` | 消息派发轮询器(250ms) |
| `adapter.receiveTeammateMessage` | adapter 收消息接口 |
| `wire prefix [msg id][sid sid]` | 消息前缀(含 id / sender) |
| `claudeCodeAdapter / codexCliAdapter` | claude / codex 适配器 |
| `cli_session_id` | CLI 端 session id |
| `cwdReleaseMarker` | worktree 标记 |
| `archived_at` | 归档时间戳 |
| `lifecycle (active/dormant/closed)` | 生命周期(active/dormant/closed) |
| `recoverAndSend` | sendMessage 自愈 |
| `recovering Map (single-flight)` | 单飞锁(防并发自愈) |
| `renameSdkSession` | session id 重命名 |
| `jsonl-missing fallback` | jsonl 缺失兜底 |
| `cwd 启发式 fallback` | cwd 失效兜底 |
| `swapLead` | 转交 lead 角色 |
| `team_task_policy` | task 过继策略(三态) |
| `applyHandOffSkipPolicy` | skip 策略原子操作 |
| `handOffMode` | hand-off 模式(跳防御 + 不写 spawn-link) |
| `spawn-link` | spawn 父子关系 |

## 工作量估算

- **Tier 1 重画 (8 张)**: ~30-40 LOC delta 每张(平均缩 30%)+ 节点合并 + 术语替换,每张 ~25-35min
- **Tier 2 简化 (9 张)**: ~15-25 LOC delta 每张(平均缩 20%)+ note 删 metadata + 术语替换,每张 ~15-20min
- **Tier 3 INDEX (2 份)**: 每行重写 80 字白话 + 第 3 列改 markdown link list,每份 ~15min
- **总工作量估算**: ~5-7h(单会话内可完成,不必跨 hand off)
- **预期 LOC delta**: -300 ~ -500 LOC(大量删 metadata + 合并节点 + 简化 note)

## 重写后预期效果(对照 D7 验收标准)

每张图:
- [ ] ≤ 5 层(architecture 顶层 package ≤ 5 / flows partition ≤ 4)
- [ ] ≤ 12 节点(architecture 顶层 component ≤ 12 / flows participant ≤ 10)
- [ ] 节点名优先用日常术语(括号注 codename 仅 component diagram 才出现)
- [ ] 图本身去 LOC / commit hash / REVIEW reference / 修法标签 metadata
- [ ] note 块 ≤ 5 行,只留语义说明(SQL / WHERE / 行号细节移到 ADR / REVIEW.md)
- [ ] design invariant 不丢(reviewer / lead 仍能据图理解机制)

INDEX.md:
- [ ] 第 4 列概要 ≤ 80 字白话
- [ ] 第 3 列「关联 plan / commit」承载 LOC / commit / REVIEW link

## 残留风险

- **R1**: D7 「不删信息只换形式」与精简 metadata 之间张力 — 部分 REVIEW reference / batch 标签是 design 决策溯源 evidence,完全删可能让未来重审找不到来源。**修法**: 这些 metadata 移到 INDEX 第 3 列(markdown link to REVIEW.md / CHANGELOG.md)替代图内堆砌
- **R2**: 6 entity 并行 state machine 缩节点可能影响 design invariant 完整性 — 但 N1 大段 note 已属 ADR 内容不是图本身,**修法**: note 摘要保留(列出 entity 名 + 1 句 cross-machine 时序),细节进 REVIEW.md 引用
- **R3**: agent-deck-mcp-architecture 是顶层 overview 图,13 packages 削到 5 packages 可能丢「整体架构感」— **修法**: 拆成「概览图 (5 packages 顶层) + 子主题图(8 张专题已存在)」,顶层图加 cross-ref 到子图
- **R4**: 通俗化术语后 reviewer 需重新学习对应关系 — **修法**: 每张图首条 note 加「术语对照表」cross-ref 到 INDEX.md 或 ADR

## 与 user confirm 计划(进 Step 3.2 前必走)

按 plan §下一会话第一步 step 5 「Step 3.1 spike report 完成后, 与 user confirm 通俗化重写计划再进 Step 3.2-3.3 实际重写」。

**confirm 范围**:
1. **Tier 1 / Tier 2 分级是否合理**(是否同意 8 张严重 + 9 张中度划分)
2. **通俗化术语映射表**(是否同意通俗化方向,有无术语取舍偏好)
3. **R3 「概览图 + 子主题图分层」是否实施**(影响 agent-deck-mcp-architecture 单张重写策略)
4. **是否同意一次性重写 17 张图 + 2 INDEX**(预估 5-7h 单会话内完成)还是按 Tier 拆 step / commit

confirm 通过 → 起 Step 3.2 (architecture 重写) → Step 3.3 (flows 重写) → Step 3.4 (INDEX 重写) → Step 3.5 flow-arch-plantuml SKILL 评审。
