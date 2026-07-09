# CHANGELOG_201 — agent_deck_messages retention GC + listBySession 索引/查询重写

## 概要

修复 `agent_deck_messages` 表两个独立问题（一次 v030 migration + 独立 GC scheduler 收口）：

1. **容量 / 无界增长**：表此前只增不减。`from_session_id` / `to_session_id` 故意无 FK（v010 设计，留痕
   closed/deleted sender），`team_id` FK 虽 `ON DELETE CASCADE` 但 team 几乎从不物理删（archive 只打标记），
   teamless DM（v027 team_id 可空）行更不参与 cascade。session 被 `LifecycleScheduler.batchDelete` purge 时
   messages 完全不删 → 全仓无任何 message DELETE/retention 路径。teamless DM 放大此问题（任意两 session 可互发）。
2. **尾延迟 / 全表扫描**：`listBySession` 的 `WHERE from=? OR to=?` 无可用索引 → 全表 `SCAN` + `TEMP B-TREE`。
   teamless DM 把全局表规模直接带进单 session 面板（SessionDetail「跨会话消息」tab）尾延迟。

来源：REVIEW_100（Batch 2 teamless-dm deep-review）R2 reviewer-codex LOW，lead 裁决真但 out-of-scope →
follow-up issue `7dcb0676`。plan `message-retention-and-index-20260602`（RFC 2 轮 + spike1 EXPLAIN 实证 +
plan design deep-review R1/R2 + 实施后 mixed deep-review，全程异构对抗 reviewer-claude Opus 4.7 + reviewer-codex gpt-5.5）。

## 设计要点

- **方案 = 索引 + GC 双修**（不动表结构）：v030 纯加 3 索引规避 v027 自引用 FK 整表重建陷阱（`reply_to_message_id`
  自引用 FK 在整表重建时静默 null，spike 实证）。`from`/`to` 无 FK 设计保持不变。
- **listBySession UNION ALL 重写**：`WHERE from=? OR to=?`（两谓词无法都索引 → 全表 SCAN）改 UNION ALL 双分支，
  各走 `(from, sent_at DESC)` / `(to, sent_at DESC)` 索引消灭全表扫描。子查询 `SELECT *, rowid AS _rid`，外层显式
  列投影剥离 `_rid` + `ORDER BY sent_at DESC, _rid DESC` 保 REVIEW_90 rowid 二级定序。**对 caller byte-identical**
  （N2，含 status filter / 分页 / 同毫秒 tie 序）。
- **self-row guard（deep-review R1 codex HIGH-2）**：第二分支必带 `AND from_session_id <> ?`。正常 self-msg
  (from==to) insert 时 throw 不存在，但 `session-repo/rename.ts` 分别 UPDATE from/to——rename A→B 时 `from=A,to=B`
  行会变 `from=B,to=B`(self-row)，无 guard 被两分支各计一次破 byte-identical。
- **GC partial index（deep-review R1 codex HIGH-1）**：GC 查询 `status IN (terminal) AND sent_at < ?` 用 partial
  `(sent_at) WHERE status IN ('delivered','failed','cancelled')`，**不是** `(status, sent_at)`——后者跨 3 status
  段无全局 sent_at 序 → `USE TEMP B-TREE` 全排 backlog 破 500 分批预算。
- **⚠️ INDEXED BY 强制 hint（实施期 SQLite 真测发现，对 HIGH-1 fix 的关键强化）**：仅建 partial index 不够——
  v010 既有 `idx_messages_status_last_attempt(status, last_attempt_at)` 也服务 `status IN` 谓词，**生产 DB 从不
  ANALYZE**（db.ts/migrations 全无），缺统计信息时 optimizer 偏好 status 等值索引 → 仍 `TEMP B-TREE` 全排 backlog
  （HIGH-1 复活）。`gc.ts LIST_EXPIRED_FOR_GC_SQL` 加 `INDEXED BY idx_messages_terminal_sent_at` 强制走 partial。
  双 reviewer impl-review 各自 sqlite3 实测确认：不加 hint 选 status_last_attempt + temp sort，加后走 partial 无 temp
  sort，删索引 fail-loud（对 GC 关键查询是优点）。Step 7 EXPLAIN 测试在「无 ANALYZE 的真实 makeMemoryDb」下暴露
  （spike 跑了 ANALYZE 会掩盖）。
- **status literal 内联（deep-review R2 codex）**：partial index 命中需查询 `status IN (...)` 与 index WHERE **字面
  同序同值**（实测参数化 IN(?,?,?) / 单值 / 顺序不同均不命中）。`LIST_EXPIRED_FOR_GC_SQL` status 三值内联硬编码，
  仅 threshold/limit 参数化；export const 让测试 EXPLAIN 真常量锁 literal 漂移（R2 claude LOW）。
- **独立 MessageLifecycleScheduler**（不塞进 session LifecycleScheduler）：仿 IssueLifecycleScheduler，6h tick +
  30s catch-up 续删（删满 limit 且 deletedCount>0 才排，防空转）。单一职责，不与 session GC 的 REVIEW_56/99 race
  fix 逻辑耦合。
- **GC 删除范围**：仅 `status IN (delivered/failed/cancelled) AND sent_at < now - Nd`，pending/delivering 在途永不删
  （N4）。terminal 是吸收态（state-machine 6 UPDATE 全要求 pending/delivering），by-id 删无 TOCTOU 复活风险；
  batchHardDelete 仍带 defense-in-depth status guard。reply_to 自引用 FK ON DELETE SET NULL 删父消息后 reply 行
  reply_to 变 NULL 行保留（N5）。
- **统一阈值 messageRetentionDays（默认 30，0=关闭）**：teamless 与 team 消息同一 retention 不分桶（RFC 裁决：
  pre-existing 全表性质，teamless 只是边际增量）。trade-off：< historyRetentionDays 时跨会话消息 tab 可能比 session
  先空（可接受——tab 是 DB 视角兜底，reply 早注入 SDK）。
- **purged 事件**：GC 删完 emit `agent-deck-message-purged { count }`（deletedCount>0 才 emit），bootstrap-wiring
  合成固定 messageId `'purged:gc'` 桥到同一 `AgentDeckMessageChanged` IPC（防 debouncer pickKey undefined），
  renderer（MessagesPanel / TeamDetail 订阅 onAgentDeckMessageChanged）整体重拉刷掉已删消息，零 renderer 改动。
- **GC_BATCH_LIMIT SSOT（impl-review claude INFO-1）**：repo cap 与 scheduler hitLimit 判定共用 `GC_BATCH_LIMIT=500`
  常量 + scheduler clamp，消除「caller 传 gcBatchLimit>cap → hitLimit 永 false 不排 catch-up」foot-gun。

## 变更内容

### Migration（v030，双处注册）
- **新建 `src/main/store/migrations/v030_agent_deck_messages_indexes.sql`**：3 索引 `idx_messages_from_session_sent_at`
  / `idx_messages_to_session_sent_at` / partial `idx_messages_terminal_sent_at`，纯 CREATE INDEX IF NOT EXISTS
  不动表结构。注册 `migrations/index.ts`（v030）+ `__tests__/agent-deck-repos/_setup.ts`（测试 harness 硬编码不读
  MIGRATIONS，必双处加）。**编号 v030**：base 已含 v029_sessions_network_dirs（CHANGELOG_198）。

### Repo 层
- `agent-deck-message-repo/crud.ts`：`listBySession` OR → UNION ALL 双索引重写（两分支带 self-row guard）。
- **新建 `agent-deck-message-repo/gc.ts`**：`listExpiredForGc`（走 partial index + INDEXED BY hint）+ `batchHardDelete`
  （单事务 + defense status guard）；`LIST_EXPIRED_FOR_GC_SQL` + `GC_BATCH_LIMIT` export const。
- `agent-deck-message-repo/_deps.ts`：interface 加 `listExpiredForGc` / `batchHardDelete` + `ListExpiredForGcOptions`。
- `agent-deck-message-repo.ts`（facade）：装配 createGc + re-export `GC_BATCH_LIMIT` / `LIST_EXPIRED_FOR_GC_SQL`。

### Scheduler + 接入
- **新建 `src/main/store/message-lifecycle-scheduler.ts`**：start/stop/updateThresholds/scan/scheduleCatchUpTick +
  单例 hook + scan throw try/catch + emit purged。
- 接入 5 点：`index/_deps.ts`（BootstrapState 加 messageScheduler）/ `bootstrap-infra.ts`（Phase 7 启动）/
  `lifecycle-hooks.ts`（before-quit stop）/ `ipc/settings.ts`（applyMessageGcThreshold + APPLY_FNS）/
  `index/__tests__/_deps.test.ts`（6→7 字段）。

### 事件 + settings
- `event-bus.ts`：EventMap 加 `agent-deck-message-purged`。
- `index/bootstrap-wiring.ts`：purged listener（合成固定 messageId）。
- `shared/types/settings/{defaults,app-settings}.ts`：`messageRetentionDays`（默认 30 + jsdoc trade-off）。
- `renderer/components/settings/sections/LifecycleSection.tsx`：「跨会话消息保留（天，0=关闭 GC）」NumberInput。

## 测试

- **新建 `message-lifecycle-scheduler.test.ts`**（14 tests）：阈值 0 跳过 / 超期删 + emit purged / deletedCount=0 不
  emit / scan throw 不崩 / catch-up 删满续删 + deletedCount=0 不排 + 删<limit 不排 / stop 清 catchUpTimer /
  updateThresholds 热更新（含改 0 关闭）/ start-stop idempotent。
- **新建 `v030-migration.test.ts`**（5 tests）：3 索引存在 / partial WHERE 字面 / 双索引复合 / listBySession UNION ALL
  EXPLAIN 走双索引无 SCAN（无 status + status filter 两分支）。
- **扩 `agent-deck-message-repo.test.ts`**（+19）：self-row guard byte-identical（OR vs UNION ALL+guard）/ guard 不漏
  正常行 / GC terminal 超期删 + pending/delivering 不删 + 未超期保留 + retentionDays=0 / limit 分批 / batchHardDelete
  defense guard / reply_to SET NULL / GC EXPLAIN 跑 LIST_EXPIRED_FOR_GC_SQL 真常量（无 SCAN + 无 TEMP B-TREE + 命中
  partial index 三条合一锁 HIGH-1 回归）。
- 全量 **1780 tests 全绿**（Electron-as-node ABI 130，0 skip 0 regression）+ typecheck node/web 双绿。

## Deep-Review（全程异构对抗）

- **plan design review R1**：codex HIGH-1（GC partial index）+ HIGH-2（UNION ALL self-row guard）均 lead sqlite3
  复现验真；双方 MED（D7 purged 事件定稿）+ claude MED（_setup.ts 双处注册）+ 4 LOW，全 fold。
- **plan design review R2**：codex MED（EXPLAIN 断言三条合一锁 HIGH-1 回归）+ literal 内联约束 + claude LOW
  （EXPLAIN 跑真常量）；双方收口共识。
- **实施后 mixed review**：codex 0 finding（sqlite3 实测全契约）+ claude 4 INFO（INDEXED BY 必要性双方独立实测铁证 /
  gcBatchLimit clamp / 注释措辞 / batchHardDelete 简化），3 fold + 1 确认非问题（listBySession 残留 temp btree 是
  单 session 有界设计预期）；双方明示可合。
