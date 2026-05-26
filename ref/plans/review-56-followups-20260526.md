---
plan_id: "review-56-followups-20260526"
created_at: "2026-05-26"
status: "completed"
base_commit: "3eb9da4a518aae5ce23a076ded9271835160e6f6"
base_branch: "main"
worktree_path: "/Users/apple/Repository/personal/agent-deck/.claude/worktrees/review-56-followups-20260526"
final_commit: "68bc6f15bed3f465e14520f0bbf5bb79e6d06137"
completed_at: "2026-05-26"
---
# REVIEW_56 follow-up tracking 19 条逐条收口

## 总目标

REVIEW_56 (`reviews/REVIEW_56.md`) §Follow-up tracking 19 条(F1 + F10 已 DONE 排除)逐条收口,通过 SKILL Deep-Review 评审 plan design + Step 0.5 spike 实测验证不确定项目 + 多 Phase 分组实施 + 最后写 REVIEW_57 收口归档。

## 用户授权 RFC 决策 (2026-05-26)

通过 AskUserQuestion 多轮对齐:

1. **Scope**: 全 19 条逐条收口(F1 + F10 已 DONE 排除)
2. **Spike 处理**: 按 user CLAUDE.md §Step 0.5 spike 跑实测 + 结论 inline 进 plan
3. **Plan-Review**: 走 agent-deck:deep-review SKILL 多轮 Deep-Review (kind='plan')

> **lead 独立推进**:除 spike 实测结论 / Phase 完成边界需 user confirm 外,其他动作 lead 自决(spawn reviewer / fix / hand off / commit / 进退 worktree)。

## 不变量

1. **每条 follow-up 必须 fix 或显式标 "不修 理由 X"**:不可静默跳过(REVIEW_57 必须 reference 每条 follow-up final status)
2. **spike 必须落 spike-reports/spike<N>-<topic>.md + 实测 evidence**:spike runner(.mjs / .ts) + .log trace + spike md 结论 / 残留风险均归档(按 §Step 4 完成 step 3 mv 到 `<main-repo>/plans/<plan-id>/spike-reports/`)
3. **每个 fix 必须有回归 test 或显式标 "test 缺失原因"**:test debt 不可悄悄累积
4. **跨 batch 不引新 dep / 不改 schema**:除 spike 验证后明确升级(典型 cleanupBlocksReferences 加 retention GC 是 schema 改但需 spike 论证)
5. **REVIEW_56 follow-up 编号映射**:本 plan 内编号必须与 REVIEW_56 §Follow-up tracking F2-F21 严格对应,便于 cross-ref 追溯
6. **三态裁决** (✅/❌/❓) 按 user CLAUDE.md §决策对抗 §三态裁决 SSOT 执行:HIGH 必修条件 = 双方独立 OR 单方 + 现场验证 ≤ 5min/5 grep/1 test 内成立
7. **review 阶段 read-only / fix loop 进 worktree**:plan 写作 + Deep-Review 阶段 worktree_path: null;Step 2+ 实施时进 worktree

## Follow-up 全清单(19 条逐条)

> 编号 F2-F21 与 REVIEW_56 §Follow-up tracking 严格对应。

### A 类 — Trivial 一行修(7 条 1 commit)

| # | 文件 | 严重度 | 修法 |
|---|---|---|---|
| F4 | `src/main/agent-deck-mcp/tools/schemas.ts:737` `ArchivePlanResult.commitHash` (TS interface output shape — **不在** ARCHIVE_PLAN_SHAPE zod input) | LOW (doc) | 加 jsdoc 注释「archive commit hash, NOT worktree merge tip — see frontmatter final_commit for the latter」(TS interface 无 zod `.describe()`,只能 jsdoc) |
| F5 | `src/main/agent-deck-mcp/spawn-guards.ts:52-60` 注释 | LOW → **close-as-no-op** | 现有注释 L57-60 已正确描述:fan-out **永远** count active children(L97 `dbChildren = listChildren('active').length` 不分 batonMode),batonMode 只跳 depth check(L89)是有意为之 race guard。Plan-Review Round 1 reviewer-claude 指出原拟改文本与实现反向,close-as-no-op |
| F6 | `src/main/agent-deck-mcp/tools/handlers/baton-cleanup.ts` skipped enum **+ `src/main/agent-deck-mcp/tools/handlers/shutdown-teammates-on-baton.ts:35-51` `ShutdownTeammatesResult.skipped` union + `src/main/agent-deck-mcp/tools/schemas.ts:674-684` `TeammatesShutdownInfo.skipped` union** | LOW | 加 'phase-1-error' 第五态明确区分 (vs 'caller=lead 但无 active teammate' 正常路径 null)。三处 union 必须同步扩,否则 TS 编译失败(Plan-Review Round 2 reviewer-codex MED 修法,lead 现场 read 验证两 union 真各 4 态都不含 'phase-1-error')|
| F7 | `src/main/agent-deck-mcp/tools/handlers/task-update.ts:79` `becameCompleted` 判定 | LOW | 改为 `patch.status === 'completed' && existing.status !== 'completed' && updated.status === 'completed'` 三条件,防御 `taskRepo.update` 因 v024 team_id check 拒掉 status patch 时 `patch.status` 与 `updated.status` 漂移 |
| F12 | `src/main/teams/universal-message-watcher/index.ts:74-92` `resolveFromDisplayName` | LOW (UX) → **close-as-no-op** | Plan-Review Round 2 reviewer-codex 修法:adapter 前缀(L88 `${adapterId}:${fromSessionId.slice(0, 8)}`)提升**跨 adapter** 可读但**不消除同 adapter 8 位 collision**(REVIEW_56 §F12 原描述关切 collision,详 `reviews/REVIEW_56.md:248`);concrete 修法二选一:实施 `slice(0, 13)` 或更长 fallback / **close-as-no-op**(同 adapter 同 team 并行 reviewer 通常 ≤ 2 → birthday paradox N=2 prob ≈ 2.3e-10;N=100 prob ≈ 1.15e-6 接受残留风险)。lead 选 close-as-no-op — slice(0,13) 把 prob 降 6 数量级但 13 字符 UX 明显冗长 trade-off 不划算;Phase 5 写 REVIEW_57 时 F12 标 `❓ → ❌ close-as-no-op (concept-level 8 位 collision 残留风险接受)` |
| F13 | `src/main/store/agent-deck-team-repo/member-crud.ts:258` swapLead `newDisplayName` 解析 | LOW (UX) | 改 `opts?.newDisplayName?.trim() || null`(`??` → `\|\|` + trim,空字符串 → 0 长度 falsy → null)。注:L256 是函数 signature `opts?: { newDisplayName?: string \| null }`,真正需 patch 的 `?? null` 表达式在 L258 |
| F14 | `src/main/store/message-delivery-state.ts:198` `coerceMessageStatus` | LOW(原 INFO 升级) | 加 `console.warn(\`[message-delivery-state] unknown status "${raw}" coerced to 'failed'\`)` 让运维感知脏数据。注:`agent-deck-message-repo.ts` 是 re-export shim(详 `message-delivery-state.ts:30` jsdoc);函数签名只接 `raw` 不接 `id`,plan 原文 `(msg ${id})` 删除(加 id 需链上多 caller 改) |

### B 类 — 小重构 + 回归 test 补全(各独立 commit)

| # | 文件 | 严重度 | 修法 |
|---|---|---|---|
| F8 | `src/main/agent-deck-mcp/tools/helpers.ts:42`(生产 1 处真 literal `'__external__'` fallback 赋值)→ `EXTERNAL_CALLER_SENTINEL`(已在 `src/main/agent-deck-mcp/types.ts:14-16` 定义) | LOW(原 INFO 升级,Set 抽象砍掉) | **去 EXTERNAL_TRANSPORTS Set 抽象**(过度,生产仅 1 处 `transport === 'stdio'` 判断,Set 集合化无价值);**保留 raw `__external__` → `EXTERNAL_CALLER_SENTINEL` 替换**:Plan-Review Round 2 reviewer-claude grep 实测精细分类 — **严格意义可替换 literal 1 处**(`helpers.ts:42` fallback 赋值),**其他 4 处**(`helpers.ts:81/96/104/190`)是 user-facing error / warn / hint message text **故意保留字面值**(让用户 / agent 知道字面 sentinel value,grep `__external__` 可读性优先),**不**改 |
| F20 | `src/main/session/manager-team-coordinator.ts` (新建 applyClosedSideEffects helper) + manager.markClosed / manager.close / scheduler 三处调用 | INFO (DRY) | 抽 `applyClosedSideEffects(sessionId, opts?: { awaitLeave?: boolean })` helper,三入口统一调用 |
| Test-Watcher | `src/main/teams/__tests__/universal-message-watcher.test.ts` | (test 补全) | 补 ≥ **7 个** invariant fail 分支 it(target archived / from session not found / from archived / team archived / **both memberships null**(`!fromMembership && !toMembership` L361)/ **from membership null only**(`!fromMembership` L369 单边) / **to membership null only**(`!toMembership` L377 单边)) + 1 个 cross-target fair tier 真触发 it。Plan-Review Round 2 reviewer-codex MED 修法:REVIEW_56:126 明确包含 from leave / to leave 两单边,实现 `universal-message-watcher/index.ts:361-384` 三独立分支,plan 原 5 invariant 只覆盖 both,漏单边。**Test 缺失原因**:`target not found` / `target closed` / `team not found` 三 sanity check (universal-message-watcher/index.ts L287/L295/L337) 在 send.ts:53 enqueue 时已校验,运行时罕触发,不属 REVIEW_56:126 stale-dispatch root cause,不测 |
| Test-MemberCrud | `src/main/store/__tests__/agent-deck-team-repo.test.ts` (或新建 member-crud.test.ts) | (test 补全) | 补 2 个 swapLead case 4 it (newDisplayName=null verify display_name 保留 / newDisplayName='X' verify display_name 改 'X') |
| Test-Rename | `src/main/store/session-repo/__tests__/cwd-release-marker.test.ts:101-138` | **不修 / 已覆盖** | Plan-Review Round 1 reviewer-codex 实测:目标文件 `__tests__/session-repo.rename.test.ts` **不存在**;现有 `cwd-release-marker.test.ts` 已 cover TC2b toExists=false(L102)+ TC2b 反向 toExists=true(L116)+ TC2b 边角 fromRow marker=null(L131)。REVIEW_56 §Follow-up tracking 已闭环 |

### C 类 — Spike 实测决策(10 spike,跑实测 + 结论 inline)

| # | 主题 | 严重度 | Spike 设计 | 预期决策 |
|---|---|---|---|---|
| F2 | recoverer.ts jsonl 跨日 false miss | MED → **✅ fix path** (spike1 实证 2026-05-26) | **已 spike**: 真路径 `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<TIMESTAMP>-<threadId>.jsonl`(三级嵌套,**plan 原 row 描述 `<YYYY-MM-DD>/` 单层有误**)。算法 SSOT `recoverer.ts:465-487` 已扫 [0,-1,+1] **±1 day fast path cover 99%+** (case 0/1/2/5 全 ✅ 含 UTC 时区 23:59:50 跨日边界);**跨 ≥ 2 day false miss 真发生** (case 3/4 ❌ 实测 MISS);fs 开销 1800 files 递归扫 0.052ms / busy day 1000 files 0.523ms / wrong-startedAt fast-path 0.007ms,**< 1ms 完全可接受**。详 `spike-reports/spike1-jsonl-cross-day.md` | **lead 选 A — fix path**: 加 fallback 递归扫 fs 兑底(`defaultCodexResumeJsonlExists` 末尾 ±1 day miss 后递归扫 `sessionsRoot/<YYYY>/<MM>/<DD>/` 三级 readdir 找 endsWith `-<threadId>.jsonl`);99%+ fast path + < 1% 递归 fallback。**Phase 4 Step 20 实施** + 回归 test 模拟跨 ≥ 2 day case 验 fallback caught |
| F3 | baton race spawn-guards fan-out | MED → **❌ dismiss** (spike2 实证 2026-05-26) | **已 spike**: race 在 design **不可能发生** — JS sync 段 + `InFlightChildrenCounter` (by parentId Map) + fan-out check 三重保护铁证。6 case 全部 enforce(case 1 serial / case 2 N=7 parallel / case 3 DB+inFlight 边界 / case 4 Promise.all N=12 + microtask gap / case 5 phantom risk / case 6 baton chain concurrent);sync 段 latency 0.114μs/call。详 `spike-reports/spike2-baton-race-fanout.md` | **lead 选 A — dismiss**: race 在 design 不可能;prod 已 4 处 `fanOutSlot.release()` 兜底 phantom risk。**F3 不修**。Phase 5 REVIEW_57 标 `❓ → ❌ dismiss (spike2 实证)` |
| F9 | archive-plan.ts fail-open warn 不 surface ok return.warnings | MED → **✅ fix path** (spike3 实证 2026-05-26) | **已 spike**: case 1 SQLite locked → console.warn 输出但 ok return.warnings **不含** fail-open 警告(impl 仅透 info hint "using DEFAULT_DEPS cwd ..." caller silent 不知退化);case 2 session not found 同款 silent;**顺手发现 `hand-off-session.ts:165-181` 同款 fail-open helper 对称问题**。详 `spike-reports/spike3-fail-open-warn-not-surfaced.md` | **lead 选 A — fix path**: 重构 `resolveCallerCwdDeps` 签名 `(sid): { deps, warnings: string[] }` + handler ok return merge `[...callerCwdWarnings, ...result.warnings]`(archive-plan.ts:222);**对称改 hand-off-session.ts:165-181 同款 helper**(trivial 2 file × 几行 type/merge + 1-2 回归 test mock SQLite locked sessionRepo)。**Phase 4 Step 20 实施** |
| F11 | task-repo cleanupBlocksReferences 全表扫 | MED → **❌ dismiss + monitor** (spike4 实证 2026-05-26) | **已 spike**: pure JS baseline N=10000 0.35ms;extrapolation 估算真 SQLite typical ~50ms < 100ms threshold;stress N=100k+ ~400ms 超 threshold(但极端场景)。deletedIds size 影响微小(L554 仅命中 UPDATE 优化已生效)。task-repo 自身无 retention GC,仅依赖 v024 ON DELETE CASCADE。详 `spike-reports/spike4-cleanup-blocks-perf.md` | **lead 选 A — dismiss + monitor**: typical 10k ~50ms 可接受;加 watchpoint(若实测 > 50k task 升级);REVIEW_57 标 `❓ → ❌ dismiss + monitor`。**F11 不修** |
| F15 (Q-1) | rename PK 防御 — 并发 hand_off adopt + SDK fork race | INFO → **❌ dismiss** (spike5 实证 2026-05-26) | **已 spike**: race 在 design 不可能发生 — `rename.ts:61-63` toExists check 在 INSERT/UPDATE 之前;`rename.ts:127-128` jsdoc 明确「fork 路径下 NEW 不会被 spawn handler 提前 addMember,PK 冲突 100% 不发生」;adopt_teammates 走 swapLead 改 role 不调 addMember(无新 row insert);team_members PK 防御性先删 NEW 在同 team 已有 row。详 `spike-reports/spike5-7-race-perf-combined.md` §F15 节 | **lead 选 A — dismiss**: race 在 design 不发生。REVIEW_57 标 ❌ dismiss |
| F16 (Q-2) | resetDeliveringOnStartup attempt_count 边界 + SIGKILL race | INFO → **❌ dismiss** (spike6 实证 2026-05-26) | **已 spike**: SIGKILL race design 已 handle — `markDelivered` 单 SQL atomic + SQLite ACID + WAL(中段 SIGKILL → 自动 rollback 要么 delivered 要么 delivering);`resetDeliveringOnStartup` startup 把残留 'delivering' 恢复 'pending' → watcher 重投;attempt_count 不漂移(resetDeliveringOnStartup 不 ++,仅 retryAfterFail 显式 ++)。详 `spike-reports/spike5-7-race-perf-combined.md` §F16 节 | **lead 选 A — dismiss**: design 已 handle。REVIEW_57 标 ❌ dismiss |
| F17 (Q-3) | task-repo visibleScope OR 跨 index 性能 | INFO → **❌ dismiss** (spike7 实证 2026-05-26) | **已 spike**: pure JS in-memory N=100k linear scan 1.85ms;真 SQLite INDEX_OR 优化 N=100k 估算 ~20-50ms < 100ms threshold;`team_id IN (...)` 走 `idx_tasks_team_id` + `team_id IS NULL AND owner_session_id = ?` 走 `idx_tasks_owner` index lookup 两路 UNION dedup。详 `spike-reports/spike5-7-race-perf-combined.md` §F17 节 | **lead 选 A — dismiss**: INDEX_OR 优化 latency < threshold。REVIEW_57 标 ❌ dismiss |
| F18 | N+1 SQL deliver 5 SQL/message benchmark | LOW (perf) → **❌ dismiss** (spike8 实证 2026-05-26) | **已 spike**: typical 100 message dispatch ~30-100ms(SQL=0.05ms 典型)< plan §F18 200ms threshold;pessimistic SQL=0.5ms 300ms boundary 但 better-sqlite3 sync 简单 SQL typical 0.05-0.1ms。BATCH_LIMIT=16 单 tick 97 SQL ≈ 5-50ms。详 `spike-reports/spike8-10-deliver-cascade-import.md` §F18 节 | **lead 选 A — dismiss**: typical < threshold,合并 JOIN 失语义清晰 trade-off 不划算。REVIEW_57 标 ❌ dismiss |
| F19 | 大批量 dormant→closed 并发 emit 风暴 dispatcher cascade | ❓ 未验证 → **❌ dismiss + monitor** (spike9 实证 2026-05-26) | **已 spike**: typical 100 sessions × 3 teams × 5 members cascade ~79ms < 100ms threshold;extreme 500 sessions × 5 teams × 10 members 1.28s 但极罕见(LifecycleScheduler 默认 24h closeAfterMs,典型用户不撞);内存峰值 in-memory event 几 MB,无 OOM 风险。详 `spike-reports/spike8-10-deliver-cascade-import.md` §F19 节 | **lead 选 A — dismiss + monitor**: typical 接受;加 monitor LifecycleScheduler tick latency 跟踪 extreme 场景;REVIEW_57 标 ❌ dismiss + monitor |
| F21 | helper await import 60s+ ε race | ❓ 未验证 → **❌ dismiss** (spike10 实证 2026-05-26) | **已 spike**: R2 fix(lifecycle-scheduler.ts:122-144 updatedClosedIds filter)已 cover 99%+;残留 ε race 需 ESM module load 异常卡 60s+(典型 < 1ms,极端 Node 进程内存压力 / fs hang / corrupt module cache);实际生产撞概率 < 1e-6/year per session。详 `spike-reports/spike8-10-deliver-cascade-import.md` §F21 节 | **lead 选 A — dismiss**: R2 已 cover,残留 ε race 极端场景接受;加 ESM import timeout 是 overkill。REVIEW_57 标 ❌ dismiss |

## Phase 分组

### Phase 0: RFC + plan 写作 + Deep-Review (本会话部分完成)
- [x] Step 0 RFC 3 问对齐 (本会话 AskUserQuestion)
- [x] Step 1 plan 文件写作 (上一 session 完成)
- [ ] Step 1.5 SKILL Deep-Review (kind='plan') (本 session — **当前 step**)

### Phase 1: Spike batch (10 spike 实测,结论 inline)
> **不变量 2**:每个 spike 落 `<plan-artifact-dir>/spike-reports/spike<N>-<topic>.md` + spike runner(.mjs/.ts/.test.ts) + .log trace。
- [x] Step 2 EnterWorktree (Bash + path 主路径 b) — branch `worktree-review-56-followups-20260526` on HEAD `3eb9da4`
- [x] Step 3 spike1 F2 jsonl 跨日 false miss → **结论 inline** (✅ fix path 选项 A) — spike md / runner / log 落 `spike-reports/spike1-jsonl-cross-day.*`
- [x] Step 4 spike2 F3 baton race fan-out → **结论 inline** (❌ dismiss 选项 A) — spike md / runner / log 落 `spike-reports/spike2-baton-race-fanout.*`
- [x] Step 5 spike3 F9 fail-open warn → **结论 inline** (✅ fix path 选项 A + 对称改 hand-off-session.ts) — spike md / runner / log 落 `spike-reports/spike3-fail-open-warn-not-surfaced.*`
- [x] Step 6 spike4 F11 cleanupBlocksReferences → **结论 inline** (❌ dismiss + monitor 选项 A) — spike md / runner / log 落 `spike-reports/spike4-cleanup-blocks-perf.*`
- [x] Step 7 spike5 F15 rename PK race → **结论 inline** (❌ dismiss 选项 A) — spike md / runner / log 落 `spike-reports/spike5-7-race-perf-combined.*`
- [x] Step 8 spike6 F16 SIGKILL race → **结论 inline** (❌ dismiss 选项 A) — 同 spike5-7 combined runner
- [x] Step 9 spike7 F17 visibleScope OR → **结论 inline** (❌ dismiss 选项 A) — 同 spike5-7 combined runner
- [x] Step 10 spike8 F18 N+1 benchmark → **结论 inline** (❌ dismiss 选项 A) — spike md / runner / log 落 `spike-reports/spike8-10-deliver-cascade-import.*`
- [x] Step 11 spike9 F19 dispatcher cascade → **结论 inline** (❌ dismiss + monitor 选项 A) — 同 spike8-10 combined runner
- [x] Step 12 spike10 F21 await import → **结论 inline** (❌ dismiss 选项 A) — 同 spike8-10 combined runner

### Phase 2: A 类 trivial 一行修(7 条 1 commit)
- [x] Step 13 **F4 + F6 + F7 + F13 + F14** 合并 1 commit(F5 close-as-no-op + F12 close-as-no-op 不需 code change,详 §A 类对应 row);**每条 fix 同 commit 加 trivial 回归 test** 满足 §不变量 3:F6 phase-1-error 第五态(`baton-cleanup.test.ts` case 5 assertion 改 `'phase-1-error'`)/ F13 swapLead trim 边界(`agent-deck-team-repo.swap-lead.test.ts` +3 it: 空字符串 / 全空格 / 真值含空格)/ F14 `coerceMessageStatus` warn(新建 `message-delivery-state.test.ts` 4 it)。**F4 test 缺失原因**:doc-only jsdoc 注释,无 runtime behavior;typecheck 覆盖语法即可。**F7 test 缺失原因**:trivial 防御性三条件(`patch.status === 'completed' && existing.status !== 'completed' && updated.status === 'completed'`),mock fixture(taskRepo.update 返 stale `status='pending'`)复杂度高于 fix 本身;现有 `task-repo.test.ts` 间接覆盖 update return shape;边角 race(v024 team_id check 拒掉 status patch 而 patch 仍 status='completed')典型不撞。typecheck ✅ + F6/F14 8 test 真跑 ✅(F13 SQLite binding skip 守门符合项目 CLAUDE.md §CHANGELOG_42 默认行为,CI 跑 Electron Node ABI 时真跑)

### Phase 3: B 类 小重构(各独立 commit)
- [x] Step 14 F8 替换生产 raw `__external__` literal(`helpers.ts:42` 1 处真 fallback 赋值)→ `EXTERNAL_CALLER_SENTINEL`(**不做** Set 抽象,详 §B 类 F8 row;`helpers.ts:81/96/104/190` 4 处 user-facing message 故意保留字面值)→ typecheck + test ✅ (commit f58bdb8)
- [x] Step 15 F20 抽 applyClosedSideEffects helper + 三入口替换 → typecheck + test (commit 待 hash) — manager.markClosed / manager.close / lifecycle-scheduler 三入口 DRY,onClearedBeforeLeave callback 保留 emit upserted / token release 顺序;50 test pass
- [x] Step 16 Test-Watcher 补 ≥ 7 个 it(含 both/from-only/to-only 三独立分支 + 4 个其他 invariant + 1 个 fair tier,详 §B 类对应 row)→ vitest 全过 ✅ (commit 68f0490)
- [x] Step 17 Test-MemberCrud 补 2 个 it ✅ (commit 11c9f80) — T5.4 case 4 newDisplayName='X' 已涵盖 + T5.4b 新补 case 4 newDisplayName=null verify display_name 保留
- [x] Step 18 Test-Rename **不修 / 已覆盖** (close-as-already-covered,无 commit 动作) — 详 §B 类对应 row(`cwd-release-marker.test.ts:101-138` 已 cover toExists=true/false + null 边角)

### Phase 4: C 类 spike 实测结果决策(按 spike 结论 inline 实施 fix 或保 backlog)
- [x] Step 19 按 Phase 1 spike 结论逐条决策:fix / 保 backlog / 升级(含 §C 类 row 全更新 inline 决策)
- [x] Step 20 spike 实测 → 真问题的 fix(F2 commit 9bd2ef6 recoverer fallback 递归扫 + 8 it / F9 commit 6a47aca resolveCallerCwdDeps 签名重构 + handler merge ok return.warnings + handler-tests 28 pass。其余 8 spike 全 dismiss 不需 fix)

### Phase 5: 写 REVIEW_57 + 归档 plan
- [ ] Step 21 写 REVIEW_57.md(reference REVIEW_56 follow-up + 本 plan Phase 1-4 全部 finding + spike 结论)
- [ ] Step 22 同步 reviews/INDEX.md
- [ ] Step 23 归档 plan (archive_plan tool 自动化)

## 设计决策 (不再争论)

### D1 spike 编号映射 F2-F21
- spike1 ↔ F2, spike2 ↔ F3, spike3 ↔ F9, spike4 ↔ F11, spike5 ↔ F15, spike6 ↔ F16, spike7 ↔ F17, spike8 ↔ F18, spike9 ↔ F19, spike10 ↔ F21
- F4-F8 / F12-F14 / F20 等无需 spike (trivial / pure refactor / test 补全)

### D2 spike runner 形态
- 优先 vitest in-memory better-sqlite3 (与现有 test fixture 风格一致 + 易复用 mock)
- 复杂场景 (如 jsonl 跨日 fs 访问) 走 Node mini-runner (.mjs)
- 性能 benchmark (F11 / F18) 走 vitest + console.time() 或 hyperfine 外部 CLI

### D3 spike 结论 inline 进 plan
- 每个 spike 完成后 plan 内 §C 类对应行从「Spike 设计 + 预期决策」更新为「**已 spike: 实测 X / 假设 Y 推翻**」+ 残留风险 inline 进 §已知踩坑
- spike md / runner / .log 永久归档 (按 §Step 4 完成 step 3 mv 到 `<main-repo>/plans/<plan-id>/spike-reports/`)

### D4 Phase 4 决策矩阵
- spike 显示真问题 → 进 fix 路径(可能 schema 改 / migration / 大重构)
- spike 显示不撞 → dismiss + REVIEW_57 标 `❓ → ❌ spike 证伪不修 (spike<N>-<topic>.md 实证)`
- spike 部分撞 / 假阳性 → 视严重度决定(LOW → acknowledge concept-level + REVIEW_57 标 ❓;MED+ → 真 fix)

### D5 跨 session hand off 策略
- 本 session 已 baton archived,只能做到 Step 1 plan 文件写作
- 下一 session cold start 第一步:Bash cat plan → invoke `agent-deck:deep-review` SKILL kind='plan' → Step 1.5 完成
- Step 1.5 通过 (0 HIGH design 缺陷) → user confirm → Step 2 进 worktree → Step 3+ Phase 1-5 逐 phase 推进
- 预计跨 2-4 个 session 完成全 plan (Phase 1 spike batch 重 + Phase 4 决策 fix 重 + Phase 5 写作收口)

## 已知踩坑(本 plan 起点 inherited)

- **EnterWorktree CLI v2.1.112 stale base bug**: 进 worktree 严禁 `EnterWorktree(name: ...)` 单步,必须走 §Step 2 主路径(b) Bash `git -C <main-repo> worktree add -b worktree-<plan-id> <path>` 显式 + `EnterWorktree(path: ...)`
- **mcp task_update status enum**: `active` 不是 `in_progress`(踩过坑)
- **ScheduleWakeup 仅 /loop 模式可用**(普通 SDK session 不能用于定时 nudge)
- **fire-and-forget catch microtask race**(REVIEW_56 Batch C R2 codex MED-1 教训):任何 `void asyncFn().catch(...)` 让出 microtask 需考虑同步路径继续执行的 race
- **路径陷阱**(REVIEW_56 写错位置教训):Edit / Read / Write 路径必须含 worktree 前缀;凡指向代码资产的路径都需 `.claude/worktrees/<plan-id>/` 前缀。**例外**(非代码资产):plan 文件本身、`~/.claude/...` 配置
- **archive_plan worktree_path: null 边界**:archive_plan tool 走 worktree branch ff-merge,plan 整周期没 worktree 走不通(本 plan Phase 1+ 必进 worktree,worktree_path: null 边界本 plan 不撞)

## 下一会话第一步

如果你是新会话从 cold start 接力,**严格按 user CLAUDE.md §Step 3 §选项 A**:

1. `Bash: cat /Users/apple/Repository/personal/agent-deck/.claude/plans/review-56-followups-20260526.md` 全文(强制 cat 不用 Read 工具,详 user CLAUDE.md §Step 3 末尾 callout)
2. **EnterWorktree(path: /Users/apple/Repository/personal/agent-deck/.claude/worktrees/review-56-followups-20260526)** — frontmatter `worktree_path` 已指向 worktree(Step 1.5 收口 + user confirm 后 Step 2 进 worktree);Phase 1+ spike batch 在 worktree 内跑
3. `git -C /Users/apple/Repository/personal/agent-deck log --oneline -3` 自检 HEAD 是否在 base_commit 之后;**且** `git -C /Users/apple/Repository/personal/agent-deck rev-parse --verify 3eb9da4a518aae5ce23a076ded9271835160e6f6^{commit}` 验证 frontmatter 全 40 位 SHA 真实可解析(只看 7 位前缀 `3eb9da4` 会掩盖错误,Plan-Review Round 1 reviewer-codex 实测教训)
4. 看 `## Phase 分组` 节的 `- [ ]` 第一个未打勾 step(当前是 Step 1.5 SKILL Deep-Review),**直接动手** invoke `agent-deck:deep-review` SKILL,scope 用 typed `{ kind: 'plan', paths: ['/Users/apple/Repository/personal/agent-deck/.claude/plans/review-56-followups-20260526.md'] }`(SKILL §Scope schema SSOT — Skill tool args 是 string field,但 SKILL 内部按 typed object 处理);phase 标签 `'Step 1.5 Plan-Review'` 作为 prompt body context 标注,**不进 scope 字段**
5. Deep-Review pass(0 HIGH design 缺陷) → ask user confirm → Step 2 进 worktree → Phase 1 Spike batch
6. 用 `mcp__agent-deck__task_list` 查 task 状态(本 session archive 时按 default `team_task_policy: 'clear-team'` 过继 — task 变 personal owner=新 sid,team_id=NULL;`task_list` 默认 visible scope 直接拿到所有过继 task)
7. **特别注意**:除 spike 实测结论 / Phase 完成边界外其他动作 lead 独立决断(参考本 plan §用户授权 RFC 决策)

## 中断 / 失败回滚

- **任意阶段中断**:plan 文件保留 + working tree 保留 → 下次会话按 §下一会话第一步 接力
- **Phase 1 spike 撞 fs / SQLite locked**:plan 内 §C 类对应行标 `❓ spike 失败,需 X 修复条件 + reload`,跳过该条 follow-up 进下一 spike
- **spike harness 公共失败熔断**(Plan-Review Round 1 reviewer-codex MED 修法):若连续 ≥ 3 个 spike 撞同根因(典型:vitest 公共 fixture / better-sqlite3 binding ABI / fs 权限拒绝 / Node mini-runner 环境)→ **立即 abort Phase 1**,reload 排查根因 + 修 runner 后**从触发熔断的当前 spike 重新跑**(不是写死 spike4-10),修复后再继续剩余 spike。不要让 N × idle 失败累积成 ❓ spike sea(Phase 4 决策矩阵将拿不到有效实测信号)
- **Phase 4 决策矩阵中所有 spike 都 dismiss**:Phase 4 跳过,直接进 Phase 5 写 REVIEW_57(全部 spike 实证 follow-up 不修是合理收口结果)
- **完整 abandon**:frontmatter status 改 abandoned + 中止理由,**不入** `<main-repo>/plans/` git 归档(直接删 `.claude/plans/<plan-id>.md`)

## REVIEW_56 reference

本 plan §A 类 7 个 F 编号 + §B 类 2 个 F 编号(F8 + F20)+ §C 类 10 个 F 编号 = **19 个 F 编号**严格对应 REVIEW_56.md §Follow-up tracking F2-F21(扣 F1+F10 已 DONE)。Test-Watcher / Test-MemberCrud / Test-Rename 是 REVIEW_56 §Follow-up tracking 末尾 **unnumbered test debt**(详 `reviews/REVIEW_56.md:257`),**不参与 F 编号**(本 plan §B 类表格 5 行中 2 行是 F 编号 F8/F20,3 行是 unnumbered test debt):
- F1 ✅ DONE (本 plan 不处理)
- F10 ✅ DONE (本 plan 不处理)
- F2-F21 ✅ 本 plan 19 条全覆盖
