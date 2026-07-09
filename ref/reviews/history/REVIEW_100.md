# REVIEW_100 — teamless-dm 特性 + universal-message-watcher 跨 adapter 投递引擎 deep-review（R1+R2 双轮异构对抗收口）

> 关联特性：teamless DM（commit `3a18030` `feat(mcp): teamless DM` / CHANGELOG_194）+ universal-message-watcher 跨 adapter 消息投递引擎
> 关联 commits：`15b0080`（R1 fix shutdown reschedule race）/ `73b6cbb`（R2 fix process 入口 guard 补全）
> 性质：滚动「全项目 deep review」Batch 2（debug/加固 —— 无新功能引入，归 reviews）
> follow-up issue：`7dcb0676`（teamless 表无界增长 + listBySession 全表扫描，out-of-scope）→ **✅ RESOLVED**（plan `message-retention-and-index-20260602` / CHANGELOG_201：v030 索引 + MessageLifecycleScheduler retention GC + UNION ALL 重写）

## 背景与诉求

用户「deep review 全项目，BUG 排查 + 代码优化」滚动任务，自主推进 + 自主 hand off。Batch 1（resume-history，REVIEW_99）R1→R4 收口后，按 churn / file-level-review-expiry 重算下一最大未审面 = **teamless-dm 特性 + universal-message-watcher**：
- `universal-message-watcher/index.ts`（537 LOC）：REVIEW_56 base 起 expired（commits=3 ≥ 3 阈值），teamless-dm 重写 124 行
- `universal-message-watcher/enqueue.ts`（95）+ `rate-limiter.ts`（85）：**never reviewed**
- `agent-deck-mcp/tools/handlers/send.ts`（173）：expired，teamless-dm +81 行（caller/target shared-team 解除限制的 3-way guard）
- `agent-deck-message-repo/dispatch.ts` + `_deps.ts` + `migrations/v027`：teamless team_id=NULL 路径

**teamless-dm 特性目标**（CHANGELOG_194）：`send_message` 原本要求 caller/target 共享 active team。teamless-dm 放宽：无 shared active team 且未显式传 teamId 时降级 teamless DM（team_id=NULL）—— 仍入 messages 表 + 注入 receiver SDK conversation，只是不进 TeamDetail；有 shared team 时 byte-identical 零改动。v027 migration 放松 `agent_deck_messages.team_id` NOT NULL。

## 方法

`agent-deck:deep-review` SKILL，2 轮异构对抗：
- **reviewer-claude**（claude-code adapter，Opus 4.7）`d753622d`
- **reviewer-codex**（codex-cli adapter，gpt-5.5 xhigh）`019e84f0`
- lead（本会话）三态裁决 + 现场验证（读码 trace lifecycle-hooks 竞争窗口 / sqlite3 CLI 复核 v027 / 全表扫描 EXPLAIN QUERY PLAN）+ 全 scope 文件独立通读

**scope**（8 文件全 repo root 内，无 sandbox cp）：见背景节文件清单。

## 轮次概览

| 轮 | reviewer-claude | reviewer-codex | lead 裁决 |
|---|---|---|---|
| R1 | 0 HIGH/0 MED/0 LOW + 3 INFO | 1 LOW（shutdown reschedule race）| LOW 验真 → fix（15b0080）；3 INFO 记录/接受 |
| R2（升维 arch/security/perf）| 0 新 HIGH/MED/LOW + 1 INFO（retention pre-existing）| 2 LOW（① 入口 guard 补全 ② 表增长）| LOW-① 验真 → fix（73b6cbb）；LOW-② → follow-up issue 7dcb0676 |

**both-agree 收口**：R2 双 reviewer 均明示「同意 conclude + 可合」，0 HIGH 0 真 MED 残留。

## R1 三态裁决 + 修复（commit 15b0080）

两 reviewer R1 均 **0 HIGH/0 MED**。

### ✅ LOW（reviewer-codex 单方 + lead 读码 trace 验真）— stop() 后仍 reschedule process() tick

- **链路**：`stop()`（index.ts）只清 poll/debounce/sweep timer + event listener，但不清 `rescheduleAfterCurrent` + `process()` finally 无 running guard。in-flight `process()` tick 期间 poll/event 置 `rescheduleAfterCurrent=true`，随后 before-quit（lifecycle-hooks.ts:82）调 `stop()`，当前 tick 结束仍 `setImmediate(process)` 再跑一轮 → shutdown 语义后继续 claim/deliver + 与 `adapterRegistry.shutdownAll()`（lifecycle-hooks.ts:90，在 watcher.stop() 之后）竞争。
- **验证**：lead 读码 trace 确认 stop→shutdownAll 顺序 + stop() 不清 flag + finally 无 guard。
- **修法**：加 `running` 状态闸门。start() 置 true / stop() 置 false + 清 rescheduleAfterCurrent / finally 仅 running 仍 true 才 setImmediate。+2 regression test。

### R1 INFO（reviewer-claude，3 条，记录/接受不修）

- **INFO-1**：watcher 对 from session `lifecycle==='closed'` 在 team+teamless 都未设闸门（只 gate target closed）。预先存在 + 对称（team 路径也不查 lifecycle）+ closed session SDK query 已 abort 实质不可达 → 非 teamless 引入，记录。
- **INFO-2**：teamless per-sender 桶跨所有 receiver 共享单桶（一个 sender 60/min 总额）。by-design 成本阀（§不变量 5）→ 接受。
- **INFO-3**：`resolveFromDisplayName` teamless 用 `session.title` / team 用 `membership.displayName`，纯展示层差异，二者都过 `sanitizeWireFieldName` wire 解析安全 → 记录。

## R2 三态裁决 + 修复（commit 73b6cbb）

R2 升维到架构耦合 / 安全 / 性能尾延迟。

### ✅ LOW-①（reviewer-codex 单方 + reviewer-claude 独立同款发现 + lead 验真）— process() 入口缺 stopped guard（15b0080 修不全）

- **链路**：commit 15b0080 只 gate「in-flight process() 的 finally 在 stop 后再 setImmediate」这条**调度点**，但**已 queued** 的 `setImmediate(process)` callback（stop 前已排入 event loop）拦不住 —— stop 清 timer/flag 后轮到该 callback 执行时仍进 `process()` 查库/claim/deliver。
- **双方独立共识**：reviewer-codex R2 直接提出；reviewer-claude R2 独立 trace 同一窗口「本来要挑这个洞」，验证后确认 lead 已堵（执行点 gate）。
- **修法**：`process()` 入口加 `if (!this.running) return` —— poll tick / debounce / setImmediate reschedule 三条异步 callback 路径的统一终极闸门（15b0080 是调度点 gate，本次是执行点 gate，双层）。替换原 finally-only 回归 test 为「入口 guard 早退不 claim/deliver pending（精确复刻 codex queued-callback-after-stop 场景）」+「finally 不 reschedule」；白盒直调 process() 的既有 backpressure test 补 running=true 前置。

> **这是 review loop 抓出 lead 自己上一个 fix（15b0080）不完整的价值** —— 单轮 review 会漏掉「调度点 gate 不等于执行点 gate」。

### → follow-up（issue 7dcb0676，out-of-scope 不阻塞收口）— LOW-②（reviewer-codex）teamless 表无界增长 + listBySession 全表扫描

- **问题**：v027 后 team_id=NULL 的 teamless 行无 team FK cascade 归宿，repo 无 purge/retention 路径（rg 无 DELETE FROM agent_deck_messages）；listBySession（crud.ts:93）`WHERE from_session_id = ? OR to_session_id = ?` 无对应索引 → sqlite3 EXPLAIN QUERY PLAN 实测 `SCAN agent_deck_messages` + `TEMP B-TREE`（对比 listByTeam 用 idx_messages_team_id_sent_at）。teamless DM 把全局表规模带进单 session 面板尾延迟。
- **裁决 LOW 不阻塞收口**：(a) 全表扫描预先存在（teamless 仅放大）(b) 修复 = retention/GC + 双索引 + UNION ALL 查询重写 = 非平凡 schema migration 需独立 plan (c) 尾延迟/容量非正确性 bug。
- **reviewer-claude R2 INFO-R2-1 独立同款确认**：`agent_deck_messages` 无任何 GC（from/to 无 FK + team row 正常流程从不 hardDelete）→ unbounded growth 是 pre-existing 全表性质，teamless 是边际增量。建议独立 follow-up（lifecycle-scheduler 加 `DELETE WHERE status IN ('delivered','failed','cancelled') AND sent_at < now-retentionMs`）。

## lead + 双 reviewer 现场验证为安全（focus 逐项，非 finding）

### ✅ v027 migration（headline risk）—— 双方独立 sqlite3 CLI 实证 PASS
plan spike 实证「v017-style 朴素重建（建 _new→copy→DROP old→RENAME）」在 foreign_keys=ON 下会**静默 null 掉所有 reply_to_message_id**（DROP old 触发 _new 自引用 FK 的 ON DELETE SET NULL，且 foreign_key_check 反而 PASS）。v027 用 **rename-old-first**（先 RENAME 旧表为 _old，用最终名建新表使自引用 FK 解析到自己，INSERT FROM _old，DROP _old 零 cascade）。
- **reviewer-codex**：sqlite3 CLI 实跑 exact v027 SQL，m2→m1 / m3→m2 reply chain 保留，FK 指向新表，teamless team_id=NULL insert 成功。
- **reviewer-claude**：独立跑 3 spike（朴素重建复刻坑 after-DROP=NULL + FK check PASS / rename-old-first PASS / v027 原文接真实 v010+v015 schema 端到端 3 级链全保留 + 5 idx 全在）；附验 defer_foreign_keys「非必需」属实 + 全仓仅一处自引用 FK 无外部引用。
- 回归测 `v027-migration.test.ts` sub-case B 锁 reply-chain 保留断言。

### ✅ session vs team 闸门分流完整正确（reviewer-claude 对照 commit diff 逐行 + reviewer-codex 确认）
session 级闸门（target not-found/closed/archived、from not-found/archived、adapter registered/canCollaborate）留在 `claimed.teamId !== null` 块**外**，team+teamless 都跑；team 级闸门（team exists/archived、from-to membership）移进块内仅 team 跑。teamless 威胁模型「双方存在且 live」即全部 auth（RFC §不变量 9 放弃 membership-ACL），无遗漏闸门。

### ✅ reply-chain pair-scope 防盗链 / 显式 teamId reject 不降级（send.ts，双方验）
`original.teamId !== teamId` 先挡跨 team/teamless 边界（`null!==null`=false 放行同 teamless，`'t1'!==null` 挡 team-chain）；teamless 再加双向 pair 校验（original 的 {from,to} == 当前 {caller,target}）防持任意 teamless messageId 挂无关 DM chain。`if (args.teamId)` 先校验不在 sharedTeams 即 reject，再 fallback teamless，无静默降级。

### ✅ wire format 注入安全（reviewer-claude mock 实测，R2 重点）
teamless 后任意 session 能 DM 任意 session，body 攻击者全控且 sanitizeWireFieldName 只过 displayName/adapterId 不过 body。但：真锚点在 position 0（buildWireBody prepend）；teammate 提取 regex `.match` 非 global = leftmost-match 永远命中真锚点；renderer parseWirePrefix `^`-anchored body 内伪造 unreachable；第二层 pair-scope DB 防御兜底。**唯一残留**：若未来改 regex 成 global+last-match 会 spoofable（反模式守门提醒，非 finding）。

### ✅ rate-limiter teamless 桶隔离 / team_id string|null 全链路 / dispatch 并发护栏（双方验）
`rateKey = teamId ?? 'from:<sid>'`，teamId 是 crypto.randomUUID 无冒号 → `from:` 前缀零碰撞；sweepEmptyBuckets 删窗口外桶安全。`AgentDeckMessage.teamId` / `MessageRow.team_id` / rowToRecord / 两 event payload / SendMessageResult / schema 全 `string|null` 无非空断言。teamless 重写只动 dispatchClaimed gate 段，process() single-flight + per-target rescue（REVIEW_86）+ cross-target secondary（REVIEW_56）+ claim 原子 RETURNING 全未触碰；findEligible* `ORDER BY sent_at ASC, rowid ASC` FIFO；excludeTargets 空数组走无 NOT-IN 分支。

### ✅ running guard fix 复核（双方）
start/stop 幂等（start `if (pollInterval) return` 早退在置 running 前 / stop 全 `if (timer)` 守护 + 置 running=false）；running vs pollInterval 双 flag 不冗余（pollInterval=timer 在跑 / running=语义 active，process() async gap 内只能靠 running 早退后续 reschedule），两 flag 永远同向设置无不一致窗口。

## 测试覆盖

- 新增 3 regression test（universal-message-watcher.test.ts）：stop() 清 flag+置 running=false / process() 入口 running=false 早退不 claim（复刻 codex queued-callback 场景）/ finally running guard 拦 setImmediate。
- 既有覆盖（双方确认）：findEligibleExcludingTargets 空 excludeTargets 分支 / retryAfterFail MAX_RETRY=3 边界 / claim 原子双 claim 第二次 null / v027 reply-chain 保留断言。
- **1354 tests 全过 + typecheck 双绿**（SQLite 真测 binding-gated skip 正常；两 reviewer 各自 Electron-as-node 跑 v027/message-repo 真测通过）。

## 收口状态

**Batch 2 收口（R1+R2 双轮异构对抗）**：
- **R1** 1 LOW（shutdown reschedule race）→ fix 15b0080 + 2 test。
- **R2**（升维 arch/security/perf）1 LOW（process 入口 guard 补全 15b0080）→ fix 73b6cbb + test 升级；双方独立同款发现，体现 review loop 抓 lead 自身不完整 fix 的价值。
- **headline risk v027 自引用 FK migration** 双方独立 sqlite3 CLI 实证 rename-old-first 保住 reply chain（含朴素重建静默 null 反例复刻）。
- **1354 tests + typecheck 双绿**。**双 reviewer R2 均明示 conclude + 可合，0 HIGH 0 真 MED 残留**。
- **Follow-up（不阻塞，issue 7dcb0676）**：teamless 放大 agent_deck_messages 表无界增长 + listBySession 全表扫描尾延迟（pre-existing 全表性质，需独立 retention/index plan）。
