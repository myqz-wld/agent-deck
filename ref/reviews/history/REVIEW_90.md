# REVIEW_90 — 全项目 deep review 批 G3：agent-deck-message-repo 持久层

- 日期: 2026-06-01
- 类型: Debug / 功能 BUG（投递 FIFO + UI 显示排序确定性）+ 文档漂移修复（全项目 deep review 第二十批，Batch G 子批 G3）
- 触发: 用户「deep review 下项目，自主一路推进 + 自主 hand off」授权（plan deep-review-project-20260531）
- 关联: plan deep-review-project-20260531 / REVIEW_89（G2 list rowid DESC 同毫秒先例）/ REVIEW_84（event-formatter same-ms tie-breaker 先例）/ REVIEW_86（universal-message-watcher dispatch 消费语义，F2 已审）/ CHANGELOG_100（删 reply_message/wait_reply/check_reply）/ CHANGELOG_105/109（message-repo 拆分 + message-delivery-state SSOT）
- 方法: 多轮异构对抗（reviewer-claude Opus 4.7 + reviewer-codex gpt-5.5，fresh pair dr-project-g3-20260531，换 caller hand-off 重 spawn）+ 三态裁决 + lead 现场 `sqlite3 :memory:` 实证 + **SQLite binding rebuild 真测**（16 test + 2 fix temp-revert 非空）+ Electron binding 还原。
- 收口: R1→R3 三轮。**R1+R2 异构互补盲点收敛为同根问题双侧对称修法**：同毫秒 `sent_at` 无 total order，list 读侧（rowid DESC newest-first）+ dispatch FIFO 侧（rowid ASC oldest-first）。R3 双方独立确认「可合」+ 0 HIGH/MED 残留。

## 范围（批 G3）

agent-deck-message-repo 持久层 facade + 4 子模块 ~663 LOC（`agent_deck_messages` 表 CRUD + 投递状态机）：

| 文件 | LOC | 职责 |
|---|---|---|
| `agent-deck-message-repo.ts` | 111 | facade（factory + singleton lazy + back-compat re-export）|
| `agent-deck-message-repo/_deps.ts` | 201 | MessageRow + rowToRecord + getById + 4 Input shapes + Repo interface |
| `agent-deck-message-repo/crud.ts` | 121 | insert（self-loop/body 校验）/get/listByTeam/listBySession |
| `agent-deck-message-repo/dispatch.ts` | 88 | findEligible/findEligibleExcludingTargets/countPendingForTarget |
| `agent-deck-message-repo/state-machine.ts` | 142 | claim/markDelivered/markFailed/retryAfterFail/cancel/resetDeliveringOnStartup |

> `message-delivery-state.ts`（G4 scope，常量 + 纯 helpers + buildFindEligibleWhereSql + coerceMessageStatus）作只读上下文，本批不报 finding。

## 异构对抗价值（同根问题双侧对称暴露）

R1+R2 两轮把「同毫秒 `sent_at` 无 total order」的**两个对称面**完整挖出，是异构互补盲点的教科书样例：

- **R1**：reviewer-claude（LOW）+ reviewer-codex（MED）**双方独立**抓到 **list 读侧**（`listByTeam`/`listBySession` `ORDER BY sent_at DESC`）
- **R2**：reviewer-codex **单方**抓到 **dispatch FIFO 侧**（`findEligible`/`findEligibleExcludingTargets` `ORDER BY sent_at ASC`）——reviewer-claude R2 复查 R1 fix「可合」但未覆盖此对称面（其 R2 聚焦 LIMIT clamp / excludeTargets 边界数学 / reset-deliver 时序，未查 sort tie-breaker）

list 侧用 `rowid DESC`（newest-first，匹配「最新在前」jsdoc）；dispatch 侧用 `rowid ASC`（oldest-first，锁 FIFO）——方向相反但同根。

## MED ✅ [R1，双方独立 + lead sqlite3 实证] list 同毫秒 `ORDER BY sent_at DESC` 缺 tie-breaker

`crud.ts` 四处 SELECT（listByTeam ±status / listBySession ±status）仅 `ORDER BY sent_at DESC`。insert 内部 `const now = Date.now()`，背靠背 insert 落同一毫秒 → 同 `sent_at` tie 无 total order。

**lead sqlite3 实证**（复刻 v010 schema + idx_messages_team_id_sent_at，5 行同 sent_at=1700000000000 按 m1..m5 插入）：
- current `ORDER BY sent_at DESC` → 返回 `m1 m2 m3 m4 m5`（**插入序 oldest-first**），**违背 crud.ts jsdoc「最新在前」契约**（应 m5..m1）
- 分页 `LIMIT 2 OFFSET 0/2` → page1=[m1,m2] page2=[m3,m4]，跨页边界落在同毫秒 tie 组上 → 无稳定 contract
- 修法 `ORDER BY sent_at DESC, rowid DESC` → 返回 `m5 m4 m3 m2 m1` ✅ newest-first 确定序

**关键陷阱（双 reviewer + 先例 REVIEW_89/84 一致）**：tie-breaker **必须 `rowid` 不能 `id`**——messages.id 是 `crypto.randomUUID()` 随机值，`id DESC` tie 内仍乱序；v010 schema `id TEXT PRIMARY KEY` 非 WITHOUT ROWID → 有隐式 rowid 单调随插入。reviewer-codex R3 额外确认 `id TEXT PRIMARY KEY` 不 alias rowid（无 WITHOUT ROWID），`rowid` 可用。

**修法**：4 处 SELECT 全部 `ORDER BY sent_at DESC` → `ORDER BY sent_at DESC, rowid DESC`（crud.ts）。listBySession 走全表 SCAN + TEMP B-TREE（与 listByTeam 索引路径不同 plan，reviewer-claude EXPLAIN 确认），rowid 二级排序在两 plan 下都稳定。

## MED ✅ [R2，reviewer-codex 单方 + lead sqlite3 实证] dispatch FIFO 同毫秒 `ORDER BY sent_at ASC` 缺 tie-breaker

`dispatch.ts` 的 `findEligible` + `findEligibleExcludingTargets` 注释/interface 承诺 `sent_at ASC` FIFO，但 SQL 仅 `ORDER BY sent_at ASC`。同毫秒入队多条（含 fresh `last_attempt_at=NULL` 与 retry 混合）时 query plan 走 `idx_messages_status_last_attempt(status,last_attempt_at)` 后 temp sort，同 `sent_at` tie 受扫描序影响。

**lead sqlite3 实证**（复刻 schema + idx_messages_status_last_attempt）：
- m1-old-retry（先插，attempt=1 last_attempt_at=1000）+ m2-new-fresh（后插同毫秒，last_attempt_at=NULL），now=3000 都 eligible
- EXPLAIN：`SEARCH USING INDEX idx_messages_status_last_attempt` + `USE TEMP B-TREE FOR ORDER BY`
- current `ORDER BY sent_at ASC` → 返回 `m2-new-fresh, m1-old-retry, m3-newer`（**后插的 fresh 排到先插的 retry 前，违背 FIFO**）
- 修法 `ORDER BY sent_at ASC, rowid ASC` → 返回 `m1-old-retry, m2-new-fresh, m3-newer` ✅ oldest-first FIFO

**功能影响**（比 list 侧更实质）：watcher process() 的 per-target rescue（firstSkippedByTarget 取 FIFO head）+ `findEligibleExcludingTargets`（cross-target starvation「拉最早 pending」）都依赖 FIFO 确定性。同毫秒抖动会让退避重试的旧消息被新消息插队。

**修法**：两处 SQL `ORDER BY sent_at ASC` → `ORDER BY sent_at ASC, rowid ASC`（dispatch.ts）+ _deps.ts FIFO jsdoc 同步。**零 perf 回归**（reviewer-claude R3 EXPLAIN 对比）：`ASC` vs `ASC, rowid ASC` query plan 完全相同（index search + temp b-tree），rowid 是 temp b-tree 里已存在的免费二级 key。

## INFO ✅ [R1，双方独立] jsdoc / DDL 注释漂移

- `_deps.ts:79/89/146/147` 活跃 TS jsdoc 仍引用 CHANGELOG_100 已删的 `reply_message`/`wait_reply`/`check_reply` 工具 → 改为 `send_message + replyToMessageId` 当前语义（crud.ts:114 已正确文档化删除）
- `v010:95`（messages PK）+ `v010:20`（teams PK）DDL 注释 `nanoid N 字符` 与 `crypto.randomUUID()`（36-char）漂移 → 改注释（migration 无 hash 校验，注释纯 readability；v015 migration 注释作历史冻结记录保留）

## ❌ 不改（R1 reviewer-claude 3 INFO，lead 裁决 by-design / 非 G3）

- **`.run()`+getById vs claim RETURNING 风格不一致**：better-sqlite3 同步 + 单进程 + 单线程 event loop，run↔getById 无 await 不可 interleave，getById 必见刚更新行 → 无正确性差异，仅风格（可选统一，非必修）
- **retryAfterFail SELECT-then-UPDATE 时序**：SELECT cur → check status → UPDATE 间无 await，同步单进程无 TOCTOU；MAX_RETRY 失败分支 WHERE `IN('pending','delivering')` 比 normal 分支 `='delivering'` 宽松但已被 `cur.status==='delivering'` guard，无害
- **markDelivered 接纳 `status='pending'`（spawn 捷径）的理论 double-delivery**：lead 读 spawn.ts:527-536 确认 insert→markDelivered **同步背靠背无 await gap**，watcher（同一 JS event loop）不可 interleave；属 spawn 编排层非 G3 SQL 层，repo markDelivered 行为正确，by-design

## 测试

worktree node_modules 软链主仓库 → better-sqlite3 binding 是 Electron ABI130，vitest 默认 node 跳过。SQLite 真测走 binding rebuild：`nvm use 20.18.3` + `prebuild-install --runtime node --target 20.18.3` → 跑测 → `cp /tmp/better_sqlite3.electron.bak <binding>` 还原 Electron（size 1885024）。

新增 2 回归 test（state-machine describe block，用 raw `db.prepare(INSERT)` 注入同 `sent_at`——insert() 无法注入）：

1. **`listByTeam / listBySession 同毫秒用 rowid DESC 稳定定序`**：5 行同 sent_at，断言三视角（listByTeam / listBySession sB / listBySession sA）均 newest-first `mm5..mm1` + 分页 page1=[mm5,mm4]/page2=[mm3,mm2] 无重复漏行。temp-revert 去 rowid DESC → FAIL（返回插入序 mm1..mm5）
2. **`findEligible 同毫秒用 rowid ASC 锁 FIFO`**：混合 fresh(last_attempt_at=NULL) + retry(attempt=1,last_attempt_at=1000) 同 sent_at，now=3000 三条 eligible，断言 `[fe1-old-retry, fe2-new-fresh, fe3-newer]` FIFO + findEligibleExcludingTargets 排除 sZ 仍取 fe1。temp-revert 去 rowid ASC → FAIL（返回 fe2 在 fe1 前）

结果：**SQLite 真测 16 passed**（14 pre-existing + 2 新增）；typecheck 双配置全绿；Electron binding 已还原。

## 收口

R1→R3 三轮异构对抗 + 三态裁决。**2 MED ✅（同根同毫秒 tie-breaker 双侧对称）+ 2 INFO ✅ jsdoc/DDL drift + 3 INFO ❌ by-design 不改**。R3 双方独立确认「可合」：reviewer-codex 复查两处 SQL + jsdoc + 回归 test + 额外 sqlite3 验证 NOT IN/空 fallback 分支 + 确认 rowid 可用（无 WITHOUT ROWID）；reviewer-claude R2 已「可合」+ R3 复查 R2 dispatch fix。0 HIGH/0 MED 残留，2 fix 全 temp-revert 非空。

## Follow-up（非阻塞）

- **[INFO 测试盲区] findEligibleExcludingTargets「空数组 fallback（不拼 NOT IN ()）/ NOT IN 排除」两契约仅集成层间接覆盖**（reviewer-claude R2）——本批回归 test 已含 FIFO + 非空 excludeTargets 路径，但「空数组 fallback」repo 层无直接锁（lead+reviewer R1 已 sqlite3 验证 `NOT IN ()` 确为 syntax error 证明 length>0 guard 必要，当前实现正确）。补 repo unit test 仅提升回归防护，非必修。
