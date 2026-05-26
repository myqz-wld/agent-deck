---
review_id: 56
reviewed_at: 2026-05-26
expired: false
skipped_expired:
---

# REVIEW_56: deep code review main 进程最近 3 个月 churn 文件汇总（Batch A/B/C × R1-R4）

## 触发场景

用户主动触发「main 进程最近 3 个月 churn 文件 deep review」 + 走 `agent-deck:deep-review` SKILL teammate 模式（kind='code',多轮异构对抗 + 三态裁决 + fix loop 收口)。覆盖 plan `deep-code-review-main-3m-20260525` 三 batch 共 31 文件 ~22k churn LOC,挖深层 bug(race / leak / 边角 / 架构 / 安全 / 测试盲区 / 性能尾延迟)。

用户授权独立推进("我要离开一会儿,你一路推进,自己决定 hand off 的时机")— lead 三 batch 串行推进 + 跨 batch hand_off baton 接力(commit fdd5468 → c0d988c → 81dac1d 跨 3 个 caller session 完成全 plan)。

## 方法

**双对抗配对**(应用 `agent-deck:deep-review` SKILL teammate 模式):

- **Batch A**: reviewer-claude (claude-code adapter, sid `1834a55f`, Opus 4.7 default thinking) + reviewer-codex (codex-cli adapter, sid `019e5f7d`, gpt-5.5 xhigh)
- **Batch B**: reviewer-claude (sid `0719e88c`) + reviewer-codex (sid `019e5fa9`)
- **Batch C**: reviewer-claude (sid `a2d69d55`) + reviewer-codex (sid `019e5ff7`)

每个 batch 跨 R1+R2+(R3+R4 视情况) 复用同对 reviewer 享 context 持久化;跨 batch shutdown 重 spawn 新一对(scope 互相独立,旧 mental model 复用价值低 + 释放 SDK live query / event listener 资源)。

**范围**: 31 文件累积 ~22.3k churn LOC(plan §D1 三 batch 拆分 + Batch B/C scope 调整)。

```text
Batch A (Adapter + Session lifecycle, 10 文件 ~13.4k LOC):
- src/main/adapters/claude-code/sdk-bridge.ts + sdk-bridge/{recoverer, index, restart-controller, stream-processor}.ts
- src/main/adapters/codex-cli/{sdk-bridge.ts, sdk-bridge/index.ts, sdk-bridge/recoverer.ts}
- src/main/session/{manager, summarizer}.ts

Batch B (agent-deck-mcp 协议层, 10 文件 ~5.9k LOC, plan §scope 调整):
- src/main/agent-deck-mcp/spawn-guards.ts + tools/handlers/{hand-off-session, hand-off-session-impl, archive-plan-impl, archive-plan, spawn, send, baton-cleanup}.ts
- src/main/agent-deck-mcp/tools/{schemas, index}.ts

Batch C (Store + Teams + IPC, 11 文件 ~3.0k LOC, plan §scope 调整):
- src/main/store/session-repo/{index, rename, lifecycle, archive}.ts
- src/main/store/agent-deck-team-repo/{index, member-crud}.ts
- src/main/store/agent-deck-message-repo.ts
- src/main/store/task-repo.ts
- src/main/teams/universal-message-watcher/{index, team-event-dispatcher}.ts
- src/main/ipc/teams.ts
```

**机器可读范围**(File-level Review Expiry 用;按字典序、去重):

```review-scope
src/main/adapters/claude-code/sdk-bridge.ts
src/main/adapters/claude-code/sdk-bridge/index.ts
src/main/adapters/claude-code/sdk-bridge/recoverer.ts
src/main/adapters/claude-code/sdk-bridge/restart-controller.ts
src/main/adapters/claude-code/sdk-bridge/stream-processor.ts
src/main/adapters/codex-cli/sdk-bridge.ts
src/main/adapters/codex-cli/sdk-bridge/index.ts
src/main/adapters/codex-cli/sdk-bridge/recoverer.ts
src/main/agent-deck-mcp/spawn-guards.ts
src/main/agent-deck-mcp/tools/handlers/archive-plan-impl.ts
src/main/agent-deck-mcp/tools/handlers/archive-plan.ts
src/main/agent-deck-mcp/tools/handlers/baton-cleanup.ts
src/main/agent-deck-mcp/tools/handlers/hand-off-session-impl.ts
src/main/agent-deck-mcp/tools/handlers/hand-off-session.ts
src/main/agent-deck-mcp/tools/handlers/send.ts
src/main/agent-deck-mcp/tools/handlers/spawn.ts
src/main/agent-deck-mcp/tools/index.ts
src/main/agent-deck-mcp/tools/schemas.ts
src/main/ipc/teams.ts
src/main/session/manager.ts
src/main/session/summarizer.ts
src/main/store/agent-deck-message-repo.ts
src/main/store/agent-deck-team-repo/index.ts
src/main/store/agent-deck-team-repo/member-crud.ts
src/main/store/session-repo/archive.ts
src/main/store/session-repo/index.ts
src/main/store/session-repo/lifecycle.ts
src/main/store/session-repo/rename.ts
src/main/store/task-repo.ts
src/main/teams/universal-message-watcher/index.ts
src/main/teams/universal-message-watcher/team-event-dispatcher.ts
```

**约束**: skip CHANGELOG 1-148 已修过 / 不变量 1 每 batch 必一对异构 reviewer 同时起 / 不变量 3 未验证强制降级非 HIGH / 不变量 4 review 阶段 read-only 仅 fix loop 进 worktree / 不变量 5 batch 串行不并行 / 不变量 6 跨 batch 必新 reviewer 对。Finding 输出契约: 文件:行号 + 代码片段 ≤ 6 行 + 验证手段 + 严重度分组(HIGH/MED/LOW/INFO/*未验证*)。

## 三态裁决结果

### ✅ 真问题 (双方独立提出 / 一方提出且现场实践验证成立)

#### Batch A (commits: 05eed6f → 0fd161e)

| # | 严重度 | 文件:行号 | 问题 | A | B | 验证手段 |
|---|---|---|---|---|---|---|
| A1 | HIGH | adapters/codex-cli/sdk-bridge/recoverer.ts:312 + index.ts:432-468 | codex resume 路径 cli sid 维度未消费,jsonl 缺失时 NEW realId 没替换 OLD applicationSid | 双方独立提出 | 双方独立提出 | jsonl 路径预检 + facade resumeMode/resumeCliSid 消费实证 |
| A2 | MED | adapters/codex-cli/sdk-bridge/restart-controller.ts | sandbox restart 3 并发 race | reviewer-codex | — | grep restart 路径 + 推理 while loop re-check |
| A3 | MED | session/summarizer.ts | rename 漏迁 inFlight | reviewer-codex | — | grep summarizer rename listener + 分析 finally currentSid |
| A4 | MED | adapters/codex-cli/sdk-bridge/index.ts | facade resume return cli sid 而非 applicationSid | reviewer-codex (R2) | — | 对比 spawn 主路径返 applicationSid |
| A5 | MED | adapters/codex-cli/sdk-bridge/index.ts | facade 2 层兜底 → 3 层(加 sessionRepo 中间层) | reviewer-claude (R2) | — | grep cross-adapter parity + 对照 claude facade |
| A6 | LOW | adapters/codex-cli/sdk-bridge/sdk-bridge.ts | thread-loop case 3 warn wording 不涵盖 fork + fresh-cli-reuse-app 两条路径 | reviewer-claude (R2) | — | 读 case 3 wording + 修法对齐 |
| A7 | LOW | session/summarizer.ts | summarize inner catch 写 OLD lastErrorBySession | reviewer-codex (R2) | — | grep inner catch sid 路径 + 加 sessionRepo.get 预检短路 |

#### Batch B (commits: 8a268bf → c0400e2 → fdd5468)

| # | 严重度 | 文件:行号 | 问题 | A | B | 验证手段 |
|---|---|---|---|---|---|---|
| B1 | MED | agent-deck-mcp/tools/handlers/archive-plan-impl.ts | archive_plan commitHash 错指向 worktree merge tip 而非 archive commit | reviewer-codex | — | 读 archive 流程 + 修法 archive 后重新 rev-parse |
| B2 | MED | agent-deck-mcp/tools/handlers/baton-cleanup.ts | shutdown_baton_teammates archived team ghost — caller 侧未过滤 archivedAt | reviewer-codex | — | 读 baton-cleanup phase 1 + caller 侧二次过滤 archivedAt |
| B3 | LOW | agent-deck-mcp/tools/handlers/hand-off-session-impl.ts | worktree exists hard reject 阻断 cold-start conventional 路径 | reviewer-codex | — | 读 cold-start path validation + 修法 conventional 路径放宽 warn |
| B4 | MED | agent-deck-mcp/tools/handlers/hand-off-session-impl.ts | worktree subtree 严格化(非 main-repo subtree 路径反 reject) | reviewer-codex (R2) + reviewer-claude (R2) | 双方独立提出 | impl 返 worktreeExists flag + handler 4 case 决策 |
| B5 | MED | agent-deck-mcp/tools/handlers/baton-cleanup.ts | shutdown-teammates seam 缺 deps 注入 | reviewer-codex (R2) | — | grep getTeam helper 引用 + 加 deps + try/catch fail-open |
| B6 | MED | agent-deck-mcp/tools/handlers/baton-cleanup.ts + tools/schemas.ts | skipped 第四态 'all-lead-teams-archived' + schemas type 同步 | reviewer-claude (R2) | — | 读 helper 返回 + tool description 同步 4 态 enum |
| B7 | HIGH (R3 blocker) | agent-deck-mcp/tools/handlers/baton-cleanup.ts | wrapper 收口 'all-lead-teams-archived' 分支 | reviewer-codex (R3) | — | 读 wrapper handler + 加 all-lead-teams-archived 显式分支 |

#### Batch B Follow-up #1 — Test fixture 适配 dual hash (commit c0d988c)

| # | 严重度 | 文件:行号 | 问题 | A | B | 验证手段 |
|---|---|---|---|---|---|---|
| F1 | CRITICAL | archive-plan*.test.ts × 6 file | Batch B R2 commit c0400e2 改 ok.commitHash 指向 archive commit (而非 worktree merge tip),test fixture 没适配 → 7 test fail | lead 现场验证 | — | git stash 验证 pre-existing fixture mismatch + 25 makeDeps fixture 适配 dual hash + 7 commitHash assertion 修订 |

#### Batch C (commits: 2f57550 → 0b91642 → 81dac1d)

| # | 严重度 | 文件:行号 | 问题 | A | B | 验证手段 |
|---|---|---|---|---|---|---|
| C1 | HIGH | session/lifecycle-scheduler.ts:69-77 | dormant→closed 路径 batchSetLifecycle 绕过 sessionManager.markClosed 三入口副作用(clearCwdReleaseMarker + leaveTeamsAndAutoArchive) → UI 幽灵成员 user-visible + cwd_release_marker 残留 latent risk + 0-lead auto-archive 联动缺失 | reviewer-codex (R1) | reviewer-claude (反驳轮独立验证 invariant 显式破坏) | grep batchSetLifecycle 路径 + 对照 manager.ts:333-345/374-389 invariant 显式声明 + 修法方案 B 保留 batch SQL + 补齐两副作用 |
| C2 | MED | store/agent-deck-team-repo/member-crud.ts:317-326 | swapLead case 4 (active+teammate promote) newDisplayName=null 无防御,SQL 静默清空 NEW 行已有 displayName | reviewer-claude (R1) | — | 对比 case 3 (L307-316) 显式 `if (newDisplayName !== null)` 防御 vs case 4 缺防御,jsdoc 自承 case 4 非 dead code |
| C3 | MED | store/session-repo/rename.ts:189 | rename 同段唯一 INTEGER NOT NULL 字段(spawn_depth)用 truthy `> 0` check 把 OLD root session 身份丢失,语义不一致同段 string\|null 字段 | reviewer-claude (R1) | — | 对比同段 9 字段 truthy pattern + cwd_release_marker L220 同款"会话身份相关无条件覆盖"语义 |
| C4 | MED | teams/universal-message-watcher/index.ts:268 + ipc/teams.ts:155-163 + send.ts:53 | watcher.deliver claim 后不重验,enqueue 与 dispatch 之间发生 team archive / from leave / to leave / from archived / target archived 任一种 → claim 后 dispatch 已 stale,ipc/teams archive 不 cancel pending | reviewer-codex (R1) | — | 读 send.ts:53-78 enqueue 校验 + ipc/teams.ts:155-163 archive 不 cancel + watcher deliver 不重验,加 5 项 invariant claim 后重验 |
| C5 | MED | teams/universal-message-watcher/index.ts:197 + store/agent-deck-message-repo.ts findEligible | starvation guard 只 deliver candidates[0] 不解决 cross-target starvation;single target 撑爆 BATCH_LIMIT=16 时 target-Y 等数分钟 | reviewer-codex (R1) | — | 读 findEligible `ORDER BY sent_at ASC LIMIT 16` 全局 FIFO + starvation guard 推演 + 加 findEligibleExcludingTargets 二阶段公平 helper |
| C6 (R2 fix-to-fix) | MED | session/lifecycle-scheduler.ts | 同 tick purge race (R1 fix 引入):scheduler 同 tick fire-and-forget leaveTeamsAndAutoArchive 让出 microtask + purge 抢先 batchDelete sessions → CASCADE 删 team_members → helper 跑空 leave + 0-lead auto-archive 漏触发 | reviewer-codex (R2) | — | 读 manager-team-coordinator.ts:59 await import 让出 microtask + retention 阈值重合场景 + 修法选项 (b) updatedClosedIds Set + purge filter |
| C7 (R2) | LOW | session/lifecycle-scheduler.ts | scheduler emit 'session-upserted' 用清 marker 之前的 rec → renderer store 收到 stale marker | reviewer-codex (R2) | — | 读 batchSetLifecycle 内 SELECT 拿 rec + clear 在 fetch 之后 + 修法 sessionRepo.get(rec.id) re-fetch + null fallback |
| C8 (R3) | LOW | session/lifecycle-scheduler.ts:95 | clearCwdReleaseMarker 无 try/catch 错误隔离,batch for loop 抛错传染 N-1 剩余 rec | reviewer-claude (R3) | — | 读 batch loop 缺 try/catch + 对比 manager.ts markClosed 单 sid blast radius + 修法 try/catch 兜底 |

#### Batch B + C 累积 INFO 顺手修

| # | 严重度 | 文件:行号 | 问题 | A | B | 修法 |
|---|---|---|---|---|---|---|
| INFO-2 (Batch C R1) | INFO | store/agent-deck-team-repo/member-crud.ts:240-244 | swapLead jsdoc 列了 3 case,代码有 4 case (case 4 非 dead code) | reviewer-claude (R1) | — | jsdoc 补 case 4 文档与代码对齐 |

### ❌ 反驳 (被对抗或现场核实证伪)

| 报告方 | 报项 | 反驳依据 (验证手段 + 结论) |
|---|---|---|
| Batch A R1 reviewer-claude (R1 INFO 1 项) | sdk-bridge.ts 某无关声明 | reviewer-codex 反驳 + lead 现场 grep 证伪,撤销 |
| Batch B reviewer-claude (R2 多条 ❓) | spawn-guards.ts 注释 vs 实现不一致 LOW | 反驳轮 reviewer-codex 实证注释表述等价于实现,LOW-2 spawn-guards 注释只需 doc-only update,不构成 invariant 漂移 |
| Batch C R3 reviewer-claude (LOW-2 自我修正) | lead R3 prompt focus 1 第二条 "purgeIds filter O(N*M) Set lookup" | claude 自证伪:`Set.prototype.has` 是 V8 amortized O(1) 不是 O(N*M),ECMAScript spec 21.2.3.5 + V8 hash table 实现铁证;此处是 lead R3 prompt 误判修正 |

### ❓ 部分 / 未验证 (双方角度不同 / 一方提出但未实践验证)

| 现场 | A 视角 | B 视角 | 是否已验证 | 结论 |
|---|---|---|---|---|
| Batch A R2 codex MED-1 jsonl 跨日 false miss | reviewer-codex 提出: 跨日 + 二次 fresh fallback 罕见 race | — | 否,纯推理无 spike 实测 | follow-up #2 留 spike (defaultCodexResumeJsonlExists fallback 递归扫,fs 开销但简单) |
| Batch B R1 codex MED-3 baton race spawn-guards fan-out | reviewer-codex 提出: baton 独立 inFlight 计数 / 显式 baton-link | — | 否,single-caller 串行不暴露 | follow-up #3 (理论 race 实际不发生,低优先级) |
| Batch B R2 claude M1 archive_plan dual hash schema doc | reviewer-claude 提出: schemas.ts ARCHIVE_PLAN_SHAPE commitHash 缺 「archive commit hash, NOT worktree merge tip」 doc | — | 否,纯 doc gap 非 production bug | follow-up #4 (1 行 doc 修订) |
| Batch B R2 claude L2 spawn-guards 注释 vs 实现一致性 | reviewer-claude 提出: spawn-guards.ts:56-60 注释表述与实现不严格对齐 | — | 否,部分反驳 | follow-up #5 (注释清理 1 行) |
| Batch B R2 claude L3 baton-cleanup phase 1 throw fallback | reviewer-claude 提出: skipped 加 'phase-1-error' 第五态明确区分 | — | 否,LOW console.warn 已兜底 | follow-up #6 (可保持现状) |
| Batch B R1 claude H-cand-1 task-update becameCompleted | reviewer-claude 提出: 1 行防御性 `&& updated.status === 'completed'` | — | 否,当前 invariant 安全 | follow-up #7 (纯防御 trivial) |
| Batch B R1 claude M1 stdio hardcode | reviewer-claude 提出: 抽 EXTERNAL_TRANSPORTS Set 集合化判断 | — | 否,architecture 稳定无 immediate impact | follow-up #8 (前瞻优化) |
| Batch B R1 claude M2 archive-plan.ts fail-open warn | reviewer-claude 提出: 重构 resolveCallerCwdDeps 签名返 `{deps, warnings}` | — | 否,无 SQLite locked fixture 实测 | follow-up #9 (修法侵入大,纯优化) |
| Batch C R1 claude M-3 task-repo cleanupBlocksReferences | reviewer-claude 提出: 全表扫 + N+1 conditional UPDATE,长尾 task 累积时 latency | — | 否,纯推理无生产数据 + JSON1 ext 修法侵入大 | follow-up #11 (10k+ task 时再 EXPLAIN QUERY PLAN 实测) |
| Batch C R1 claude L-1 resolveFromDisplayName uuid 前 8 位 fallback | reviewer-claude 提出: collision 概率 5e-12 但 UI 区分困难 | — | 否,UX 微小瑕疵不影响功能 | follow-up #12 (LOW UX) |
| Batch C R1 claude L-2 swapLead `??` 不防御空字符串 | reviewer-claude 提出: 接口 invariant 不严格 | — | 否,空字符串作为 displayName 罕见 | follow-up #13 (LOW UX) |
| Batch C R1 claude INFO-1 coerceMessageStatus 静默吞脏数据 | reviewer-claude 提出: 加 console.warn 让运维感知 | — | 否,trade-off 不是 bug | follow-up #14 (优化项) |
| Batch C R1 claude Q-1/Q-2/Q-3 跨 batch / 推迟 spike | reviewer-claude 提出: rename PK 防御 / resetDeliveringOnStartup attempt_count 边界 / task-repo visibleScope OR 跨 index 性能 | — | 否,跨 batch scope 推迟 | follow-up #15-17 (需 spike) |
| Batch C R2 claude LOW-1 N+1 SQL deliver 5 SQL/message | reviewer-claude 提出: BATCH_LIMIT=16 单 tick 80+ SQL,主线程 occupancy 高峰 ~40% | — | 否,perf trade-off 接受 (perf-critical 才升级) | follow-up #18 (benchmark spike 决定) |
| Batch C R2 claude INFO-1 emit 顺序窗口 | reviewer-claude 提出: emit session-upserted 先于 team-member-changed 几 ms | — | 否,< 1 frame 不算 user-visible | 不修 |
| Batch C R2 claude INFO-2 deliver invariant check 冗余 | reviewer-claude 提出: 第 7 项 check 等价于后两项独立分支 | — | 否,reason precision 取舍 | 不修 |
| Batch C R2 claude ❓-1 大批量 dispatcher cascade | reviewer-claude 提出: 100+ dormant→closed 触发的 emit chain 总 mem / latency | — | 否,需 spike 实测 | follow-up #19 (需 spike) |
| Batch C R3 claude INFO-3 closed session 副作用契约三处重复 | reviewer-claude 提出: manager.markClosed / manager.close / scheduler 三处 verbatim 相同副作用,DRY 抽 helper | — | 否,non-invariant DRY 优化 | follow-up #20 (可选抽 helper applyClosedSideEffects) |
| Batch C R3 claude ❓-1 helper await import 60s+ 卡死 | reviewer-claude 提出: R2 修法假设 helper 60s 内跑完,理论上 ESM module load 异常 → 下一 tick purge 仍撞 ε race | — | 否,需 spike 实测 vi.fn(import).mockImplementation(...delay 60s+...) | follow-up #21 (concept-level race 残留) |
| Batch C R3 codex INFO-1 multi-row test payload id 断言 | reviewer-codex 提出: Test 1 用 sid-A 单值 mock,multi-row 没断言每条 payload id | — | 是,本轮已 land 修法(R3 commit 81dac1d 同时满足 claude INFO-2) | 已 fix |

---

### Follow-up #10 (本批 land,但归类提及)

| # | 严重度 | 文件:行号 | 问题 | 状态 |
|---|---|---|---|---|
| F10 | MED | node_modules electron@33.4.11 binary 缺 dist/ | worktree node_modules electron postinstall 没跑成功导致 handler.test.ts 全 8 test fail import-time NODE_MODULE_VERSION 错位 | 已 fix (本会话 worktree-local node install.js 重装,不入 git) |

## 修复 (commit 落地)

### HIGH

| # | 文件 | commit | 修法 |
|---|---|---|---|
| A1 | adapters/codex-cli/sdk-bridge/recoverer.ts:312 + index.ts:432-468 | 05eed6f | jsonl 路径预检 + facade 消费 resumeMode/resumeCliSid |
| C1 | session/lifecycle-scheduler.ts | 2f57550 → 0b91642 | 方案 B 保留 batch SQL + 补齐 markClosed 三入口副作用(clearCwdReleaseMarker + leaveTeamsAndAutoArchive fire-and-forget) + R2 codex MED-1 修法 (b) updatedClosedIds Set + purge filter |
| B7 | agent-deck-mcp/tools/handlers/baton-cleanup.ts | fdd5468 | wrapper 'all-lead-teams-archived' 分支显式收口 |

### MED

| # | 文件 | commit | 修法 |
|---|---|---|---|
| A2 | adapters/codex-cli/sdk-bridge/restart-controller.ts | 05eed6f | sandbox restart while loop re-check 防 3 并发 race |
| A3 | session/summarizer.ts | 05eed6f | rename per-promise listener + finally 用 currentSid 防漏迁 inFlight |
| A4 | adapters/codex-cli/sdk-bridge/index.ts | 0fd161e | facade resume return applicationSid (与 spawn 主路径对偶) |
| A5 | adapters/codex-cli/sdk-bridge/index.ts | 0fd161e | 加 sessionRepo 中间层兜底(2 层 → 3 层) |
| B1 | agent-deck-mcp/tools/handlers/archive-plan-impl.ts | 8a268bf | archive 后重新 rev-parse 拿 archiveCommit |
| B2 | agent-deck-mcp/tools/handlers/baton-cleanup.ts | 8a268bf | caller 侧二次过滤 archivedAt |
| B4 | agent-deck-mcp/tools/handlers/hand-off-session-impl.ts | c0400e2 | impl 返 worktreeExists flag + handler 4 case 决策 |
| B5 | agent-deck-mcp/tools/handlers/baton-cleanup.ts | c0400e2 | getTeam? 加 deps + try/catch fail-open |
| B6 | agent-deck-mcp/tools/handlers/baton-cleanup.ts + tools/schemas.ts | c0400e2 | helper + schemas type 同步 'all-lead-teams-archived' 第四态 |
| C2 | store/agent-deck-team-repo/member-crud.ts:317-326 | 2f57550 | case 4 加 newDisplayName !== null 防御 + else 仅 SET role |
| C3 | store/session-repo/rename.ts:189 | 2f57550 | 改 `if (toExists)` 无条件覆盖 spawn_depth (与 cwd_release_marker L220 同款) |
| C4 | teams/universal-message-watcher/index.ts:268 | 2f57550 | deliver claim 后重验 5 项 invariant (target archived / from not found / from archived / team archived / both memberships) |
| C5 | teams/universal-message-watcher/index.ts:197 + store/agent-deck-message-repo.ts | 2f57550 | starvation guard 二阶段公平兜底 + 新 findEligibleExcludingTargets helper |
| C6 (R2) | session/lifecycle-scheduler.ts | 0b91642 | 修法选项 (b) updatedClosedIds Set + purge filter (避免同 tick microtask race) |

### LOW

| # | 文件 | commit | 修法 |
|---|---|---|---|
| A6 | adapters/codex-cli/sdk-bridge/sdk-bridge.ts | 0fd161e | thread-loop case 3 warn wording 涵盖 fork + fresh-cli-reuse-app 两条路径 |
| A7 | session/summarizer.ts | 0fd161e | inner catch 加 sessionRepo.get 预检短路 |
| B3 | agent-deck-mcp/tools/handlers/hand-off-session-impl.ts | 8a268bf | conventional 路径 worktree exists 放宽 warn 不 reject |
| C7 (R2) | session/lifecycle-scheduler.ts | 0b91642 | emit 'session-upserted' 前 sessionRepo.get(rec.id) re-fetch + null fallback |
| C8 (R3) | session/lifecycle-scheduler.ts:95 | 81dac1d | clearCwdReleaseMarker try/catch 错误隔离 (batch loop 不传染) |

### INFO

| # | 文件 | commit | 修法 |
|---|---|---|---|
| INFO-2 (Batch C) | store/agent-deck-team-repo/member-crud.ts:240-244 | 2f57550 | jsdoc 补 case 4 文档 |

### Test 补全

| # | 文件 | commit | 修法 |
|---|---|---|---|
| Test-F1 | archive-plan*.test.ts × 6 file (25 fixture + 7 commitHash assertion) | c0d988c | 适配 Batch B R2 dual hash 修法 (ok.commitHash = archive commit, frontmatter final_commit = worktree merge tip) |
| Test-Lifecycle | session/__tests__/lifecycle-scheduler.test.ts (新建 9 tests) | 0b91642 → 81dac1d | R1 codex HIGH-1 副作用契约 (2) + R2 codex MED-1 purge filter 阈值重合/不重合/historyRetentionDays=0 (3) + R2 codex LOW-1 emit fresh + null fallback (2) + R3 reviewer-claude LOW-1 try/catch 隔离契约 (1) + INFO-1 batch 返空 edge case (1) |
| Test-Watcher | teams/__tests__/universal-message-watcher.test.ts (fixture 升级) | 2f57550 | nextTeamResult / nextMembershipResult 全局变量 + agentDeckTeamRepo.get / findActiveMembershipIn override + findEligibleExcludingTargets stub + nextSessionResult 类型加 archivedAt?: number \| null |

## Follow-up tracking (本 review 不修,记录待 fix)

下次 plan / 接续 session 优先处理(按 plan §Follow-up tracking #2-21 + 本 review #11-21):

1. **DONE** ~~F1 CRITICAL — codex MED-3 archive-plan test fixture dual hash 适配~~ (commit c0d988c)
2. **F2 codex MED-1** recoverer.ts jsonl 跨日 false miss (Batch A R2)
   - 修法: 持久化 cli_session_started_at 字段 / fallback 递归扫 `~/.codex/sessions/**/-<threadId>.jsonl`
3. **F3 codex MED-3** baton race spawn-guards fan-out (Batch B R1)
4. **F4 claude M1** archive_plan dual hash schema doc (Batch B R2)
5. **F5 claude L2** spawn-guards 注释 vs 实现一致性 (Batch B R2)
6. **F6 claude L3** baton-cleanup phase 1 throw fallback 'phase-1-error' 第五态 (Batch B R2)
7. **F7 claude H-cand-1** task-update becameCompleted 防御 (Batch B R1)
8. **F8 claude M1** stdio hardcode 抽 EXTERNAL_TRANSPORTS Set (Batch B R1)
9. **F9 claude M2** archive-plan.ts fail-open warn 不 surface (Batch B R1)
10. **DONE** ~~F10 archive-plan.handler.test.ts Electron binary 缺失~~ (本会话 node install.js 重装)
11. **F11 claude M-3** task-repo cleanupBlocksReferences 全表扫 + N+1 (Batch C R1)
12. **F12 claude L-1** resolveFromDisplayName uuid 8 位 fallback collision (Batch C R1)
13. **F13 claude L-2** swapLead `??` 空字符串防御 (Batch C R1)
14. **F14 claude INFO-1** coerceMessageStatus console.warn 让运维感知 (Batch C R1)
15. **F15-17 claude Q-1/Q-2/Q-3** rename PK 防御 / resetDeliveringOnStartup attempt_count 边界 / task-repo visibleScope OR 跨 index (Batch C R1 推迟 spike)
18. **F18 claude LOW-1** N+1 SQL deliver 5 SQL/message benchmark spike (Batch C R2)
19. **F19 claude ❓-1** 大批量 dormant→closed 并发 emit 风暴 dispatcher cascade spike (Batch C R2)
20. **F20 claude INFO-3** closed session 副作用契约三处重复 抽 helper (Batch C R3)
21. **F21 claude ❓-1** helper await import 60s+ 卡死 ε race spike (Batch C R3)

**剩余 watcher / member-crud / rename 回归测试补全** (claude MED-1 部分 + codex INFO-1 同款) — 5 invariant fail 分支 / cross-target fair tier 真触发 / member-crud case 4 (newDisplayName=null + 'X') / rename cwd_release_marker (toExists=true / false 两 case) — 关键路径 lifecycle-scheduler 已补,其他列 follow-up。

## 关联 changelog

- (待写 CHANGELOG_X) 本 review 主体即修复(Batch A 2 commits + Batch B 3 commits + Batch C 3 commits + 2 follow-up commit) 共 8 fix commit chain

## Agent 踩坑沉淀(如有)

本次 review 提炼出以下 agent-pitfall 候选:

- **EnterWorktree CLI v2.1.112 stale base bug** — 已知踩坑 plan §已知踩坑 (本 plan 进 worktree 用 Bash + path 主路径 (b) 而非 name 单步,绕过)
- **mcp task_update status enum** — `active` 不是 `in_progress` (与 user CLAUDE.md 原生 TaskUpdate 不同,踩过坑)
- **ScheduleWakeup 仅 /loop 模式可用** — 普通 SDK session 不能用于「定时 nudge reviewer 卡死」
- **fire-and-forget catch microtask race** — leaveTeamsAndAutoArchive 加 fire-and-forget 引入同 tick microtask race fix-to-fix regression (codex MED-1) — 经验:任何 `void asyncFn().catch(...)` 让出 microtask 都需考虑同步路径继续执行的 race(本批已落 plan §F1c follow-up)

(同主题再撞 2 次会触发升级为 `conventions/<X>-<topic>.md`)
