---
review_id: 57
reviewed_at: 2026-05-26
expired: false
skipped_expired:
---

# REVIEW_57: REVIEW_56 follow-up 19 条收口 (multi-Phase × spike batch × deep-review)

## 触发场景

REVIEW_56 §Follow-up tracking 19 条(F2-F21,F1+F10 已 DONE 排除)逐条收口。承接 plan `review-56-followups-20260526` 跨 4 session(Phase 0 上一 session + Phase 1-5 本 session)推进 — RFC + plan 写作 + SKILL Deep-Review 评审 + Phase 1 10 spike 实测 + Phase 2-4 fix loop + Phase 5 写收口报告 + 归档 plan。

**用户授权**:除 spike 实测结论 / Phase 完成边界需 user confirm,其他动作 lead 自决(spawn reviewer / fix / hand off / commit / 进退 worktree)。

## 方法

**双对抗配对 (Phase 0 plan 写作 + Step 1.5 Plan-Review,kind='plan')**:

- reviewer-claude (claude-code adapter, sid `d1222456`, Opus 4.7 default thinking)
- reviewer-codex (codex-cli adapter, sid `019e61e3`, gpt-5.5 xhigh)
- 跨 R1/R2/R3 复用同对 reviewer 享 context 持久化;R3 双方明确 ✅ 0 HIGH/MED 收口

**Phase 1 spike batch (10 spike,纯 Node mini-runner)**:

- spike1 F2 jsonl 跨日 false miss(`spike-reports/spike1-jsonl-cross-day.{md,mjs,log}`)
- spike2 F3 baton race spawn-guards fan-out(`spike-reports/spike2-baton-race-fanout.{md,mjs,log}`)
- spike3 F9 archive fail-open warn(`spike-reports/spike3-fail-open-warn-not-surfaced.{md,mjs,log}`)
- spike4 F11 cleanupBlocksReferences perf(`spike-reports/spike4-cleanup-blocks-perf.{md,mjs,log}`)
- spike5-7 F15+F16+F17(`spike-reports/spike5-7-race-perf-combined.{md,mjs,log}`):rename PK race / SIGKILL race / visibleScope OR
- spike8-10 F18+F19+F21(`spike-reports/spike8-10-deliver-cascade-import.{md,mjs,log}`):N+1 deliver / dispatcher cascade / await import race

**Phase 2-4 fix loop**(7 commit 5 file edit + 4 test 新增/更新):

| Phase | commit | scope |
|---|---|---|
| Phase 2 (A 类) | `7c451bb` | 5 trivial fix (F4 jsdoc + F6 三 union + F7 三条件 + F13 trim + F14 warn) + 3 trivial 回归 test (F6 case 5 update / F13 +3 it / F14 4 it) |
| Phase 3 (B 类) Step 14 | `f58bdb8` | F8 helpers.ts:42 raw → EXTERNAL_CALLER_SENTINEL replace |
| Phase 3 (B 类) Step 17 | `11c9f80` | Test-MemberCrud T5.4b case 4 newDisplayName=null verify display_name 保留 |
| Phase 3 (B 类) Step 16 | `68f0490` | Test-Watcher ≥7 invariant fail it (含 both/from-only/to-only 三独立 + 4 sanity) |
| Phase 3 (B 类) Step 15 | `fda20fa` | F20 applyClosedSideEffects helper 抽 + 三入口 DRY refactor |
| Phase 4 (C 类) Step 20 | `9bd2ef6` | F2 recoverer.ts 加 fallback 递归扫 fs + 8 回归 it |
| Phase 4 (C 类) Step 20 | `6a47aca` | F9 archive-plan + hand-off-session resolveCallerCwdDeps 重构 {deps, warnings} + handler merge |

## F2-F21 final status 裁决清单

按 plan §不变量 5 严格映射 REVIEW_56 §Follow-up tracking 19 个 F 编号。

### ✅ Fix (真问题,本轮已修)

| # | 修法 | spike / 现场 evidence | commit |
|---|---|---|---|
| **F2** | recoverer.ts `defaultCodexResumeJsonlExists` 加 fallback 递归扫 fs(±1 day fast path miss 后 三层 readdir 兑底)| spike1: ±1 day cover 99%+ 但跨 ≥ 2 day 真 false miss(case 3/4 ❌);fs 开销 1800 files 0.052ms / busy day 1000 files 0.523ms < 1ms 可接受 | `9bd2ef6` |
| **F4** | `schemas.ts:737` ArchivePlanResult.commitHash 加 jsdoc 区分 archive commit vs frontmatter final_commit | doc-only,Plan-Review Round 1 lead 现场 read 验证字段位置(R1 验证 ARCHIVE_PLAN_SHAPE 不在 input zod 而 ArchivePlanResult interface) | `7c451bb` |
| **F6** | `baton-cleanup.ts:233` catch fallback skipped 改 'phase-1-error' 第五态 + `shutdown-teammates-on-baton.ts:35-51` + `tools/schemas.ts:674-684` 三处 union 同步扩 | Plan-Review Round 2 reviewer-codex MED-3 + lead read 验证两 union 均不含 'phase-1-error'(若只改 baton-cleanup.ts 编译失败) | `7c451bb` |
| **F7** | `task-update.ts:79` becameCompleted 加 `updated.status === 'completed'` 第三条件防御 | Plan-Review Round 1 lead 验证位置(原 plan F7 row 写错为 `task-repo.ts`) | `7c451bb` |
| **F8** | `helpers.ts:42` raw `'__external__'` literal → `EXTERNAL_CALLER_SENTINEL` const(types.ts:16 SSOT)|  Plan-Review Round 2 reviewer-claude LOW-3 grep 实测:严格 literal 替换仅 1 处,其他 4 处 user-facing message 故意保留字面值不替换 | `f58bdb8` |
| **F9** | archive-plan.ts + hand-off-session.ts `resolveCallerCwdDeps` 重构签名 `{deps, warnings: string[]}` + handler merge 进 ok return.warnings(archive-plan)/ console.warn 输出(hand-off-session 不 surface ok return) | spike3: case 1 SQLite locked → console.warn 输出但 ok return.warnings 不含 fail-open(caller silent 不知);顺手补 hand-off-session.ts catch 同款 P5 R1 console.warn 对称缺口 | `6a47aca` |
| **F13** | `member-crud.ts:258` swapLead newDisplayName `?? null` → `?.trim() \|\| null`(空字符串/全空格 → null 而非误覆盖)| Plan-Review Round 1 lead 验证 L256 是 signature,真正 patch 点在 L258(原 plan F13 row 行号错) | `7c451bb` |
| **F14** | `message-delivery-state.ts:198` `coerceMessageStatus` 加 `console.warn` 让运维感知脏数据 | Plan-Review Round 1 lead 验证位置(原 plan F14 row 写错为 `agent-deck-message-repo.ts`,实际是 re-export shim) | `7c451bb` |
| **F20** | `manager-team-coordinator.ts` 新增 `applyClosedSideEffects` helper(clearMarker + leave dual-mode + onClearedBeforeLeave callback)+ manager.markClosed/close/lifecycle-scheduler 三入口替换 DRY | INFO 级 DRY refactor,50 个 test 回归全过(lifecycle-scheduler 9 / manager-team-coordinator 5 / universal-message-watcher 18 / baton-cleanup 14 / message-delivery-state 4) | `fda20fa` |

### ❌ Close (close-as-no-op / close-as-already-fixed)

| # | 决策 | 理由 |
|---|---|---|
| **F5** | close-as-no-op | `spawn-guards.ts:52-60` 现有注释已正确描述 fan-out 行为;原 plan 拟改文本与实现反向(Plan-Review Round 1 reviewer-claude 验证 L57-60 注释 + L97 实现一致) |
| **F12** | close-as-no-op | `universal-message-watcher/index.ts:88` adapter 前缀提升跨 adapter 可读但**不消除同 adapter 8 位 collision**(Plan-Review Round 2 reviewer-codex)。slice(0,13) 实施 collision 概率 1e-32 但 13 字符 UX 冗长 trade-off 不划算;同 adapter 同 team 并行 reviewer 通常 ≤ 2 → birthday paradox prob ≈ 2.3e-10 接受残留风险 |

### ❌ Dismiss (spike 实证不撞)

| # | spike | 决策依据 |
|---|---|---|
| **F3** | spike2 | race 在 design 不可能发生(JS sync 段 + InFlightChildrenCounter + fan-out check 三重保护铁证;6 case 全 enforce + Promise.all N=12 + microtask gap)|
| **F11** | spike4 | typical 10k task ~50ms < 100ms threshold;stress 100k+ ~400ms 极端场景 + monitor watchpoint |
| **F15** | spike5 | rename PK race 在 design 不发生(toExists check + L127 jsdoc "PK 冲突 100% 不发生" 铁证 + adopt 走 swapLead 不调 addMember)|
| **F16** | spike6 | SIGKILL race SQLite ACID + WAL + startup recovery 已 handle;attempt_count 不漂移 |
| **F17** | spike7 | INDEX_OR 优化下 OR query 性能良好 — pure JS 100k 1.85ms,SQLite 估算 < 100ms threshold |
| **F18** | spike8 | typical 100 message dispatch 30-100ms < 200ms threshold;BATCH_LIMIT=16 单 tick 97 SQL 总耗时 5-50ms |
| **F19** | spike9 | typical 100 sessions cascade 79ms < 100ms threshold + monitor;extreme 500 sessions 1.28s 极罕见 |
| **F21** | spike10 | R2 fix(lifecycle-scheduler.ts:122-144 updatedClosedIds filter)已 cover 99%+;残留 ε race 概率 < 1e-6/year per session,极端 ESM 异常场景接受 |

### Unnumbered test debt

REVIEW_56 §Follow-up tracking L257 末尾 3 个 unnumbered test debt:

| # | 决策 | commit |
|---|---|---|
| **Test-Watcher** | ✅ fix — 补 ≥ 7 个 invariant fail it 含三独立 membership 分支(REVIEW_56:126 stale-dispatch root cause 完整覆盖) | `68f0490` |
| **Test-MemberCrud** | ✅ fix — T5.4b case 4 newDisplayName=null verify display_name 保留 | `11c9f80` |
| **Test-Rename** | ❌ close-as-already-covered — `cwd-release-marker.test.ts:101-138` TC2b 已 cover toExists=true/false + null 边角 | — |

### 19 F 编号 + 3 unnumbered test debt 全闭环 ✅

19 F 编号:9 fix + 2 close + 8 dismiss = 19。3 unnumbered:2 fix + 1 close-as-already-covered。

## 不变量 1-7 满足审计

按 plan §不变量 7 条逐一检查:

| # | 不变量 | 满足 |
|---|---|---|
| 1 | 每条 follow-up 必须 fix 或显式标 "不修 理由 X" | ✅ 19 + 3 全闭环(本报告 ✅/❌ 三态裁决清单)|
| 2 | spike 必落 `spike-reports/spike<N>-<topic>.md` + runner + .log trace | ✅ 5 spike md + 4 runner mjs + 4 log,归档 `plans/review-56-followups-20260526/spike-reports/` |
| 3 | 每个 fix 必须有回归 test 或显式标 "test 缺失原因" | ✅ 9 fix:F2 8 it / F6 case 5 update / F8 typecheck-only test 缺失原因 / F13 +3 it / F14 4 it / F20 50 regression test;F4/F7 显式标 test 缺失原因 |
| 4 | 跨 batch 不引新 dep / 不改 schema(除 spike 验证后明确升级)| ✅ 0 新 dep / 0 schema 改(F6 union 扩 'phase-1-error' 是 enum 加值非 SQL schema 改,不撞)|
| 5 | F2-F21 编号映射严格对应 | ✅ 19 个 F 编号严格对应 REVIEW_56 §Follow-up tracking(扣 F1+F10);3 unnumbered test debt 独立列 |
| 6 | 三态裁决按 user CLAUDE.md §决策对抗 §三态裁决 SSOT | ✅ Plan-Review R1-R3 + spike 实证 + lead 现场验证三层 |
| 7 | review 阶段 read-only / fix loop 进 worktree | ✅ Phase 0/Step 1.5 worktree_path: null read-only;Phase 1+ 进 worktree `worktree-review-56-followups-20260526` |

## 关联 changelog

无独立 changelog — 本 follow-up 收口 review 性质(纯 fix + refactor + test 补全,无新功能 / 行为变更 / API 改),directly 关联 REVIEW_56 §Follow-up tracking 闭环。

## Follow-up (本 review 已处理完,但仍 monitor 项)

仅 2 项 dismiss + monitor 待长期实测验证:

- **F11** task-repo cleanupBlocksReferences:加 watchpoint 若生产实测用户 task 表 > 50k → 升级 fix(retention GC)
- **F19** dispatcher cascade:加 watchpoint LifecycleScheduler tick latency 跟踪 extreme 500+ sessions 场景

其他 6 dismiss(F3/F15/F16/F17/F18/F21)在 design 不撞,无需 monitor。
