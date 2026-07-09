---
plan_id: "message-retention-and-index-20260602"
created_at: "2026-06-02"
worktree_path: "/Users/apple/Repository/personal/agent-deck/.claude/worktrees/message-retention-and-index-20260602"
status: "completed"
base_commit: "6c26d5f"
base_branch: "main"
issue_id: "7dcb0676-8ee0-425a-a514-a016449c76f4"
final_commit: "5dbbf41df34562d125a099e2820d75cd467e4682"
completed_at: "2026-06-02"
---
# message retention GC + listBySession 索引/查询重写

> 关联 issue：`7dcb0676`（REVIEW_100 Batch 2 teamless-dm deep-review R2 reviewer-codex LOW-②，lead 裁决真但 out-of-scope → follow-up）
> 关联 review：`ref/reviews/REVIEW_100.md` §R2 → follow-up 节

## 总目标

修复 `agent_deck_messages` 表两个独立问题（一次 v029 migration 收口）：

1. **容量 / 无界增长**：表只增不减。`from_session_id`/`to_session_id` 无 FK（故意 design，留痕 closed/deleted sender），`team_id` FK 虽 `ON DELETE CASCADE` 但 team 几乎从不物理删（archive 只打标记），teamless 行 `team_id=NULL` 更不参与 cascade。session 被 `LifecycleScheduler.batchDelete` purge 时 messages 完全不删 → 全仓无任何 message DELETE/retention 路径。teamless DM 放大此问题（任意两 session 可互发）。
2. **尾延迟 / 全表扫描**：`listBySession` 的 `WHERE from=? OR to=?` 无可用索引 → spike 实证走 `SCAN agent_deck_messages` + `TEMP B-TREE`。teamless DM 把全局表规模直接带进单 session 面板（SessionDetail「跨会话消息」tab）尾延迟。

## 不变量（必须守住）

1. **N1 from/to 无 FK 不动**：`from_session_id`/`to_session_id` 故意无 FK（v010 注释明文「允许已 closed/已删的 sender 留痕」）。v029 **只加索引，不加 FK、不动表结构**（避免 v027 自引用 FK 整表重建陷阱）。
2. **N2 listBySession 结果 byte-identical**：UNION ALL 重写后，所有分支（无 status / status filter / 分页 offset / 同毫秒 rowid 二级定序 / **self-row 坏数据**）输出必须与 baseline OR 查询**完全一致**。spike 已实证常规分支；self-row（rename collision 制造 from==to）必须靠第二分支 `from_session_id <> ?` guard 防重复（Review R1 codex HIGH-2）。
3. **N3 rowid 二级定序保留（REVIEW_90）**：同毫秒 sent_at 下必须 `ORDER BY sent_at DESC, rowid DESC`（rowid 非 id——id 是随机 UUID）。UNION ALL 子查询 `SELECT *, rowid AS _rid`，外层按 `sent_at DESC, _rid DESC`。
4. **N4 GC 只删 terminal + 超期**：仅 `status IN ('delivered','failed','cancelled') AND sent_at < now - retentionMs`。**pending/delivering 在途永不删**（避免删掉 watcher 还要投递的消息）。teamless 与 team **统一阈值**（RFC 裁决：pre-existing 全表性质，不对 teamless 用更激进阈值）。
5. **N5 reply_to_message_id 自引用 FK 完整**：GC 删行时 `reply_to_message_id REFERENCES ... ON DELETE SET NULL` 会把引用被删行的 reply 行的 `reply_to_message_id` 置 NULL。这是可接受的（被删的是超期 terminal 消息，reply chain 元数据本就是 best-effort）。**不需要**特殊处理，但回归测试要覆盖「删父消息后 reply 行 reply_to_message_id 变 NULL 且行本身保留」。
6. **N6 GC 分批 + catch-up**：单轮最多删 500 行（仿 `findHistoryOlderThan` / `issueRepo.listForGc`），剩余下轮续。删满 limit → 调度短延迟 catch-up tick（仿 IssueLifecycleScheduler）。防 retention 0→非0 首次启用或高积压时一次同步删上万行卡主线程。
7. **N7 messageRetentionDays=0 关闭 GC**：与 historyRetentionDays / issueResolvedRetentionDays 同款语义，0 = 永久保留。
8. **N8 测试不动既有契约**：现有 `agent-deck-message-repo.test.ts` 的 listBySession 断言（含 REVIEW_90 rowid 定序回归）必须仍全过——UNION ALL 是实现替换不是契约变更。

## 设计决策（不再争论）

> RFC 2 轮（AskUserQuestion）+ spike1 实证，全部选推荐项。

### D1 scope = GC + 索引双修（RFC Q1）
两个问题根治。一次 v029 migration 加全部 3 索引，crud.ts 改查询 + 新增 MessageLifecycleScheduler。

### D2 独立 MessageLifecycleScheduler（RFC Q2 + Q1-第2轮）
仿 `src/main/store/issue-lifecycle-scheduler.ts`：独立 6h tick + 30s catch-up 续删 + 自己的 settings 字段。**不**塞进 `LifecycleScheduler.scan()`（那里已有 REVIEW_56/99 race fix 的复杂逻辑 + 60s tick 对 day 单位的 message GC 偏频繁 + 与 session GC 耦合）。单一职责。

### D3 messageRetentionDays 独立字段，默认 30（RFC Q3）
- 新增 `AppSettings.messageRetentionDays`，default 30（与 historyRetentionDays 一致起步，用户可单独调）。
- **统一阈值**：teamless（team_id=NULL）与 team 消息同一 retention，不分桶（RFC Q4 裁决 — codex 强调 teamless 放大 vs claude 认为 pre-existing 全表性质，采 claude 视角：统一更简洁，teamless 只是边际增量）。
- 已知 trade-off：messageRetentionDays < historyRetentionDays 时，SessionDetail「跨会话消息」tab 可能比 session 本身先空。可接受——该 tab 本是 DB 视角兜底视图（reply 早已注入 SDK conversation，CHANGELOG_100）。jsdoc 注明此语义。

### D4 v030 纯加 3 索引（RFC Q3-第2轮 + spike1 + Review R1 codex HIGH-1 修订）

> **migration 编号 v029→v030（实施期发现）**：worktree base `6c26d5f`（比 plan 原 base `38285fe` 新）已含 `v029_sessions_network_dirs.sql`（commit `95caa4a`）。本 plan migration 改用 **v030**，文件名 `v030_agent_deck_messages_indexes.sql`。

```sql
-- listBySession UNION ALL 两分支（D5）
CREATE INDEX IF NOT EXISTS idx_messages_from_session_sent_at ON agent_deck_messages(from_session_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_to_session_sent_at   ON agent_deck_messages(to_session_id, sent_at DESC);
-- GC partial index（Review R1 codex HIGH-1：必须 partial sent_at，不是 (status,sent_at)）
CREATE INDEX IF NOT EXISTS idx_messages_terminal_sent_at
  ON agent_deck_messages(sent_at) WHERE status IN ('delivered','failed','cancelled');
```
不动表结构（无整表重建 → 零数据迁移风险，不撞 v027 自引用 FK 陷阱）。

> **为何 GC 用 partial index 不用 `(status, sent_at)`（Review R1 codex HIGH-1 ✅ lead sqlite3 实测）**：`status IN ('delivered','failed','cancelled')` 是 3 个值，`(status, sent_at)` 复合索引下每个 status 区段内 sent_at 有序但**跨 3 段无全局序** → `ORDER BY sent_at ASC LIMIT 500` 必须 `USE TEMP B-TREE FOR ORDER BY` 把**全部**超期 terminal 行排完再取前 500，O(N log N) per tick，catch-up 每轮重复全排 → 破坏 N6「500 分批守主线程预算」。改 `(sent_at) WHERE status IN (terminal)` 部分索引把 terminal 行收敛进单一 B-tree 段，sent_at 直接有序 → LIMIT 500 沿索引早停，无 temp sort。实测：status-first → `SEARCH + USE TEMP B-TREE`；partial → `SEARCH idx_messages_terminal_sent_at (sent_at<?)` 无 temp sort（spike1-explain-query-plan 已更新此对比）。

> **⚠️⚠️ INDEXED BY 强制 hint（实施期 SQLite 真测发现，对 HIGH-1 fix 的关键强化）**：仅建 partial index **不够**——本表另有 v010 既有 `idx_messages_status_last_attempt(status, last_attempt_at)` 也能服务 `status IN (...)` 谓词。**生产 DB 从不跑 ANALYZE**（db.ts / migrations 全无），缺统计信息时 SQLite optimizer **偏好 status 等值索引**（status_last_attempt）→ 走它 + `USE TEMP B-TREE` 全排 backlog，恰好退回 HIGH-1 要修的破预算行为（即便 partial index 已建！）。实测铁证：无 ANALYZE 选 status_last_attempt + temp sort；ANALYZE 后才选 partial。**修法**：`gc.ts LIST_EXPIRED_FOR_GC_SQL` 加 `INDEXED BY idx_messages_terminal_sent_at` 查询 hint，不依赖统计信息强制走 partial → 无 ANALYZE 也无 temp sort。代价：索引被删/改名 → 查询 fail-loud 报错（非静默退化），对 GC 关键查询是优点（v030 test 锁索引存在）。这是 Step 7 EXPLAIN 测试失败暴露的——若只信 spike（spike 跑了 ANALYZE）会漏。

### D5 UNION ALL 重写 listBySession（spike1 + Review R1 codex HIGH-2 修订）
子查询 `SELECT *, rowid AS _rid FROM ... WHERE from_session_id=?` UNION ALL `... WHERE to_session_id=? AND from_session_id <> ?`，外层显式列投影（剥离 `_rid`）+ `ORDER BY sent_at DESC, _rid DESC LIMIT ? OFFSET ?`。两分支（无 status / 有 status filter）各自重写。

**第二分支 `AND from_session_id <> ?` 去重 guard 必须有（Review R1 codex HIGH-2 ✅ lead sqlite3 复现）**：正常 self-msg（from==to）insert 时 throw 不存在（crud.ts:32-36，spike 实证 self_rows=0），但 `session-repo/rename.ts:156-161` 分别 UPDATE from/to_session_id——rename A→B 时一条 `from=A, to=B` 的历史行第一条 UPDATE 把 `from=A→B` → 变 `from=B, to=B`（self-row）。此时 baseline OR 查询返 1 行，**无 guard 的 UNION ALL 返 2 行**（同一行被两分支各计一次）→ SessionDetail 重复显示，违反 N2 byte-identical。第二分支加 `from_session_id <> ?`（同一 sessionId 占位）把「from 与 to 都等于本 session」的 self-row 从第二分支排除，第一分支已计 → 总计 1 行。lead sqlite3 实测：OR=1 / 无 guard UNION ALL=2 / 有 guard=1。status filter 分支同理：`... WHERE to_session_id=? AND status=? AND from_session_id <> ?`。

### D6 GC 调度细节（仿 IssueLifecycleScheduler）
- DEFAULT_TICK_INTERVAL_MS = 6h；DEFAULT_GC_BATCH_LIMIT = 500；DEFAULT_CATCH_UP_DELAY_MS = 30s。
- scan()：`messageRepo.listExpiredForGc({retentionDays, now, limit})` 拿超期 terminal id → `batchHardDelete` 单事务删 → 删了行 emit 一次 purged 事件（见 D7）。
- retentionDays=0 → 跳过（早退）。
- **catch-up 守门 `hitLimit && deletedCount > 0`（Review R1 claude LOW ✅ 对齐 issue-lifecycle-scheduler.ts:131）**：删满 limit（=可能还有积压）**且本轮真删了行** → scheduleCatchUpTick（one-shot，已有 pending 不重排）。`deletedCount === 0`（全 race / 全 throw）不排，防空转死循环。单写者 SQLite 下 race 近不可能，但为 parity + 防御补上。

### D7 GC 事件 / repo 接口（renderer 订阅已确认 + Review R1 MED 双方独立定稿）
- 新增 `messageRepo.listExpiredForGc(opts: {retentionDays, now, limit}): string[]`（`SELECT id WHERE status IN ('delivered','failed','cancelled') AND sent_at < (now - retentionDays*86400_000) ORDER BY sent_at ASC LIMIT limit`，走 D4 partial index）。
  - **⚠️ terminal status 必须内联 literal SQL，不能参数化（Review R2 codex 实测 partial index 命中规则）**：partial index `WHERE status IN ('delivered','failed','cancelled')` 只在查询 WHERE 与 index 定义**字面同序同值**时命中。codex sqlite3 3.43.2 实测：`status IN (?,?,?)` 参数化占位 **不命中** / 单值 equality 不命中 / IN 值顺序不同不命中 / `OR` 展开恰好命中但不如 literal IN 稳。故 `status IN ('delivered','failed','cancelled')` 必须**内联硬编码**进 SQL 字符串（与 v029 partial WHERE 逐字一致），仅 `threshold`(sent_at) / `limit` 参数化。这是命中 partial index 的硬前提，实现时不可图省事参数化 status。
- 新增 `messageRepo.batchHardDelete(ids): string[]`（仿 session `batchDelete` 单事务逐条 `DELETE FROM agent_deck_messages WHERE id=?`，返回真正删除的 id）。
  - **defense-in-depth（Review R1 claude INFO，可选）**：DELETE WHERE 可再带 `AND status IN ('delivered','failed','cancelled')`——terminal 是吸收态（state-machine.ts 6 个 UPDATE 的 WHERE 全要求 pending/delivering，无一匹配 terminal，claude 逐条验过），listExpiredForGc 选中到 batchHardDelete 之间 terminal 不会复活，by-id 删本就安全；带上是双保险，零成本。
  - reply_to 自引用 FK `ON DELETE SET NULL` 自动把引用被删行的 reply 行 `reply_to_message_id` 置 NULL（见 N5），reply 行本身保留。
- **事件 = 必须 emit（已确认 renderer 实时订阅）**：`src/renderer/components/SessionDetail/MessagesPanel.tsx:43` 是 listBySession 的实时消费者——`listAgentDeckMessagesBySession({sessionId,limit:100})` 拉数据 + `:61` `onAgentDeckMessageChanged` 200ms 节流后**整体重拉**（不解析 payload）。`TeamDetail/index.tsx:83` 同款订阅。GC 删除若不 emit，已打开的 MessagesPanel / TeamDetail 会显示陈旧（含已删）消息直到下次手动触发。
- **emit 方案定稿 = 新增 `agent-deck-message-purged` 事件（Review R1 codex MED-1 + claude MED-2 双方独立提出 → 定稿，不再二选一）**。复用逐条 `status-changed` 语义错（消息是 DELETE 不是 status 变）+ 最多 500 次 emit 各建 payload 过 16ms debouncer 浪费。落地 3 细节（claude 补，否则踩坑）：
  1. **EventMap 加** `'agent-deck-message-purged': [{ count: number }]`（event-bus.ts:99-101 段，与两个现有 message 事件同区）。
  2. **bootstrap-wiring.ts:194-199 加 listener** 把 purged 桥到同一 `messageChangedSender`。⚠️ **关键陷阱**：`messageChangedSender` 的 pickKey 是 `(item) => ${item.kind}:${item.messageId}`（_deps.ts:60）——purged 事件**无单条 messageId**，listener 必须传**合成固定 messageId**（如 `messageId: 'purged:gc'`）才能 burst 合并成一次 IPC；直接接现有 sender 不传会得 `undefined` key。形如 `eventBus.on('agent-deck-message-purged', (p) => messageChangedSender({ kind: 'purged', teamId: null, messageId: 'purged:gc', payload: p }))`。
  3. **scheduler 每批 emit 一次**（scan 内 batchHardDelete 单事务删完后，`deletedCount > 0` 才 emit），catch-up 多轮则每轮一次。
- renderer 侧**零改动**（MessagesPanel:61 + TeamDetail:83 都整体 refetch 不解析 payload，已核对）→ 聚合到同一 `IpcEvent.AgentDeckMessageChanged`，既有订阅自动覆盖。

### D8 接入点（5 处，全仿 issueScheduler）
1. `src/main/index/_deps.ts`：`BootstrapState.messageScheduler` 字段 + factory null 初始化。
2. `src/main/index/bootstrap-infra.ts` Phase 7：`new MessageLifecycleScheduler({messageRetentionDays}).start()` + `setMessageLifecycleScheduler()`。
3. `src/main/index/lifecycle-hooks.ts` before-quit：`state.messageScheduler?.stop()` + `setMessageLifecycleScheduler(null)`。
4. `src/main/ipc/settings.ts`：`applyMessageGcThreshold` apply hook（in `messageRetentionDays` → updateThresholds）+ 加进 APPLY_FNS。
5. `src/main/index/__tests__/_deps.test.ts`：state 初始化加 `messageScheduler: null`。

## 步骤 checklist

- [x] **Step 1 — v030 migration**（done）：写 `src/main/store/migrations/v030_agent_deck_messages_indexes.sql`（D4 三索引：2 个 `(session, sent_at DESC)` + 1 个 partial `(sent_at) WHERE status IN terminal`，纯 CREATE INDEX IF NOT EXISTS）。**双处注册（Review R1 claude MED ✅）**：① `migrations/index.ts` 加 v030 import + MIGRATIONS 数组（生产路径）；② `src/main/store/__tests__/agent-deck-repos/_setup.ts` import + exec 数组加 v030（测试 harness 硬编码不读 MIGRATIONS 注册表，漏则索引测试断言失败 + 既有测试误绿掩盖）。**编号 v029→v030**：base 已含 v029_sessions_network_dirs。
- [x] **Step 2 — crud.ts listBySession UNION ALL 重写**（done，D5）：两分支（无 status / status filter）重写，第二分支带 `AND from_session_id <> ?` 去重 guard（防 rename collision self-row 重复），保 N2/N3 byte-identical。
- [x] **Step 3 — repo GC 接口**（done，D7）：`_deps.ts` interface 加 `listExpiredForGc` + `batchHardDelete` + `ListExpiredForGcOptions`；新建 `agent-deck-message-repo/gc.ts`（`LIST_EXPIRED_FOR_GC_SQL` export const，含 `INDEXED BY` hint + 内联 status literal + defense status guard）；facade re-export + 装配 createGc。
- [x] **Step 4 — MessageLifecycleScheduler**（done，D2/D6）：新建 `src/main/store/message-lifecycle-scheduler.ts`（仿 issue-lifecycle-scheduler.ts），含 start/stop/updateThresholds/scan/scheduleCatchUpTick（守门 `hitLimit && deletedCount > 0`）+ 单例 hook + scan throw try/catch + emit `agent-deck-message-purged`（deletedCount>0 才 emit）。
- [x] **Step 5 — settings 字段 + 事件**（done，D3/D7）：`defaults.ts` 加 `messageRetentionDays: 30`；`app-settings.ts` 加字段 + jsdoc（trade-off）；`LifecycleSection.tsx` 加 NumberInput（min=0）；`event-bus.ts` EventMap 加 `agent-deck-message-purged`；`bootstrap-wiring.ts` 加 purged listener（合成固定 messageId `'purged:gc'`）。
- [x] **Step 6 — 接入 5 点**（done，D8）：① `_deps.ts` BootstrapState 加 `messageScheduler` + factory null（含注释 5→泛化）；② `bootstrap-infra.ts` Phase 7 启动 + setMessageLifecycleScheduler；③ `lifecycle-hooks.ts` before-quit stop + set(null)；④ `settings.ts` applyMessageGcThreshold + 进 APPLY_FNS；⑤ `_deps.test.ts` 6→7 字段 + 文案同步。
- [x] **Step 7 — 测试**（done，Review R1 codex LOW-1 + claude LOW 补强）：
  - **v029 migration test**：`PRAGMA index_list` 验 3 新索引存在 + `sqlite_master.sql` 验 `idx_messages_terminal_sent_at` 定义确为 `ON agent_deck_messages(sent_at) WHERE status IN ('delivered','failed','cancelled')`（不只验 index name，验 partial WHERE 字面）。
  - **GC EXPLAIN 回归断言（Review R2 codex MED + claude LOW 强化）**：EXPLAIN 必须跑 **gc.ts 的 `LIST_EXPIRED_FOR_GC_SQL` 真实常量**（Step 3 export，不是测试自写查询——否则 gc.ts literal 漂移无守护），同时断言 ① 不含 `SCAN agent_deck_messages` ② **不含 `TEMP B-TREE`** ③ detail 含 `USING INDEX idx_messages_terminal_sent_at`。⚠️ 只断言「不含 SCAN」抓不住 R1 HIGH-1 回归——坏方案 `(status,sent_at)` 本身就是 `SEARCH`（非 SCAN）能过「no SCAN」但仍 `USE TEMP B-TREE` 全排 backlog 破 N6。三条合一 + 跑真常量才锁死回归。
  - **listBySession UNION ALL 回归**：复用既有断言（N8）+ 补 **self-row/rename-collision case**（raw insert 一条 from==to 行 → OR 与 UNION ALL+guard 都返 1 行）+ status filter + 分页组合。listBySession 的 EXPLAIN 用宽松否定式（不含 `SCAN agent_deck_messages`，不钉精确 plan 树——形态依投影/SQLite 版本变会脆，claude LOW）。
  - **GC repo test**：`delivered/failed/cancelled 超期删` / `pending 超期不删` / **`delivering 超期不删`**（N4 明列两态，原只写 pending）/ `non-terminal 超期保留` / 分批 limit / `删父消息后 reply 行 reply_to_message_id 变 NULL 且行保留`（N5）。
  - **scheduler test**（仿 lifecycle-scheduler.test.ts）：retentionDays=0 跳过 / 删满 catch-up 续删 / `deletedCount=0 不排 catch-up` / stop 清 timer（含 catchUpTimer）。
  - **settings apply hook test** + **purged 事件 bridge test**：apply hook 实质 = scheduler.updateThresholds（已被 scheduler test 覆盖）；purged bridge dedup = makeDebouncedTeamSender per-key 合并（已被 `_deps.test.ts` 覆盖）+ EventMap 类型由 typecheck 保证。与项目既有 apply-hook 粒度一致（applyLifecycleThresholds/applyIssueGcThresholds 均无独立薄 wrapper 测试）。
  - **实施期补测（INDEXED BY 发现）**：GC EXPLAIN 测试初版失败暴露「无 ANALYZE optimizer 误选 status_last_attempt + temp sort」→ gc.ts SQL 加 `INDEXED BY idx_messages_terminal_sent_at` 修复；该 EXPLAIN 测试现锁死「真走 partial 无 temp sort」（不依赖 ANALYZE）。
- [x] **Step 8 — typecheck + 全测**（done）：typecheck node/web 双绿；全量 **127 文件 / 1779 tests 全过**（Electron-as-node ABI 130 匹配，SQLite 真测全跑 0 skip，含新增 49 测试）。
- [x] **Step 9 — Deep-Review**（done，plan 实施后 mixed review）：reviewer-claude `db34952c` + reviewer-codex `019e8844` 异构对抗。codex 0 finding（sqlite3 实测全契约）+ claude 4 INFO（INDEXED BY 必要性双方独立 sqlite3 实测铁证 / gcBatchLimit clamp+GC_BATCH_LIMIT SSOT / 注释措辞 / batchHardDelete 简化），3 fold + 1 确认非问题；双方明示可合。
- [x] **Step 10 — 文档 + 归档**（done）：CHANGELOG_201 + INDEX 行 + README 消息保留设置项 + REVIEW_100 follow-up resolved 标记。worktree rebase 到 main（base 落后，bootstrap-infra.ts 自动三方合并无冲突）后 ff-merge + archive_plan。

## 当前进度

- ✅ RFC 2 轮对齐（全推荐项）+ spike1 实证（spike-reports/spike1-explain-query-plan.{sql,md,log}）。
- ✅ plan 文件写完。
- ✅ **Step 1.5 Deep-Review Round 1 完成**（reviewer-claude Opus 4.7 `36b488bb` + reviewer-codex gpt-5.5 xhigh `019e8808` 异构对抗）：
  - **codex HIGH-1**（GC status-first 索引 temp-sort 全 backlog 破 N6 500 预算）✅ lead sqlite3 实测真 → 改 D4 第三索引为 partial `(sent_at) WHERE status IN terminal`。
  - **codex HIGH-2**（rename 旁路 UPDATE 造 self-row → UNION ALL 重复破 N2）✅ lead sqlite3 复现真 → D5 第二分支加 `from_session_id <> ?` guard。
  - **MED 双方独立**（D7 事件方案欠定）✅ → 定稿新增 `agent-deck-message-purged` 事件 + claude 补 pickKey 合成 messageId wiring 细节。
  - **claude MED**（`_setup.ts` 硬编码 migration 列表漏 v029 → 测试误绿）✅ lead 读码真 → Step 1 双处注册。
  - **4 LOW**（catch-up deletedCount>0 守门 / EXPLAIN 宽松否定式 / 测试矩阵补 delivering+self-row / _deps.test 7字段）✅ 全 fold 进 D6/Step 7/Step 6。
  - 全部 fold 进 plan。
- ✅ **Step 1.5 Deep-Review Round 2 收口**（同一对 reviewer 复用）：
  - **codex R2 MED**（Step 7「no SCAN」断言抓不住 R1 HIGH-1 回归——status-first 也是 SEARCH，真坏点是 TEMP B-TREE）✅ → Step 7 三条合一断言（no SCAN + no TEMP B-TREE + USING idx_messages_terminal_sent_at）+ D7 加 literal SQL 约束（partial index 命中需 status 内联不可参数化）。
  - **codex R2 LOW**（spike runner/report 残留旧 status-first）✅ → 重写 runner 两段对比 + (3b) self-row + (4c) 命中规则，重跑固化 .log（0 parse error 全实证），report H3/H4 假设同步。
  - **claude R2 LOW**（Step 7 EXPLAIN 应跑 gc.ts 真实 SQL 常量而非测试自写，否则 gc.ts literal 漂移无守护 HIGH-1 可静默复活）✅ → Step 3 抽 `LIST_EXPIRED_FOR_GC_SQL` export const + Step 7 跑真常量。
  - **双方独立实测复现** codex 两个 HIGH（claude 自跑 sqlite3 `/tmp/r2-*.sql` 非仅信 lead/codex）+ partial-index literal-match 双方独立收敛同一结论 → 强交叉验证。
  - **收口共识**：reviewer-codex「fold MED 后可进 worktree」+ reviewer-claude「0 HIGH/0 新 MED，同意 conclude」。0 HIGH/MED 残留，所有 LOW 已 fold。
- ✅ **进 worktree 实施 Step 1-8 完成**（worktree `message-retention-and-index-20260602`，base `6c26d5f`）：
  - migration 编号 v029→**v030**（base 已含 v029_sessions_network_dirs）。21 文件改动（16 改 + 5 新）。
  - **实施期发现并修复 INDEXED BY 缺陷**（见 §已知踩坑）：仅 partial index 不够，无 ANALYZE 时 optimizer 误选 status_last_attempt + temp sort，破 HIGH-1 fix → gc.ts SQL 加 `INDEXED BY` 强制 hint。Step 7 EXPLAIN 测试暴露（spike 跑了 ANALYZE 会漏）。
  - typecheck 双绿 + **127 文件 / 1779 tests 全过**（Electron-as-node 0 skip，含新增 49 测试）。
- ⏭ 下一步：**Step 9 实施后 Deep-Review**（mixed review 代码实施 vs plan 一致性）→ Step 10 文档归档。

## 下一会话第一步

1. `Bash: cat /Users/apple/Repository/personal/agent-deck/.claude/plans/message-retention-and-index-20260602.md` 读全 plan（已实施到 Step 8，进度节为准）。
2. 进 worktree：`EnterWorktree(path: "/Users/apple/Repository/personal/agent-deck/.claude/worktrees/message-retention-and-index-20260602")`（用 path）。
3. **Step 9 实施后 Deep-Review**：invoke `/agent-deck:deep-review` args `{kind:'mixed', paths:[worktree 内 gc.ts / crud.ts / message-lifecycle-scheduler.ts / v030*.sql / bootstrap-wiring.ts / settings.ts + plan]}`（验代码实施 vs plan 一致性）。
4. Review 通过 → Step 10：README + REVIEW_100 follow-up 标记 + issue resolved + CHANGELOG + archive_plan。
5. ⚠️ 跑 worktree 测试：worktree 无 node_modules，用 Electron binary `/Users/apple/Repository/personal/agent-deck/node_modules/.pnpm/electron@33.4.11/.../Electron` + `ELECTRON_RUN_AS_NODE=1` 跑主仓库 vitest entry，cwd=worktree（详会话记录；勿 symlink node_modules 进 worktree 会被 vitest 建 .vite 缓存污染，跑完即清）。

## 已知踩坑

- **v027 自引用 FK 陷阱**：messages 表有 `reply_to_message_id` 自引用 FK，整表重建会静默 null 掉所有 reply 链（spike1-migration-self-ref-fk.md 实证）。**v030 纯加索引规避此坑**（不重建表）。
- **rowid vs id**：UNION ALL 子查询排序必须用 `rowid`（单调随插入）不是 `id`（随机 UUID）。
- **rename collision 制造 self-row（Review R1 codex HIGH-2）**：`session-repo/rename.ts:156-161` 分别 UPDATE from/to，rename A→B 时 `from=A,to=B` 行会变 `from=B,to=B`。UNION ALL 必须靠第二分支 `from_session_id <> ?` guard 去重，否则 SessionDetail 重复显示。**self-msg insert 防不住此路径**（那只防 crud insert，不防 rename UPDATE）。
- **GC 必须用 partial index 不是 (status,sent_at)（Review R1 codex HIGH-1）**：status-first 复合索引下 `status IN (3值)` 跨段无全局 sent_at 序 → `USE TEMP B-TREE` 全排 backlog 破 500 预算。partial `(sent_at) WHERE status IN terminal` 才能沿索引 LIMIT 早停。spike1 已更新此对比实证。
- **⚠️ partial index 还需 INDEXED BY 强制 hint（实施期 SQLite 真测发现）**：仅建 partial index 不够——v010 既有 `idx_messages_status_last_attempt(status,last_attempt_at)` 也服务 `status IN` 谓词，**生产 DB 从不 ANALYZE**（db.ts/migrations 全无），缺统计时 optimizer 偏好 status 等值索引 → 仍 temp sort 全 backlog（HIGH-1 复活）。gc.ts `LIST_EXPIRED_FOR_GC_SQL` 加 `INDEXED BY idx_messages_terminal_sent_at` 强制走 partial（不依赖 ANALYZE）。代价：索引删/改名查询 fail-loud（对 GC 是优点，v030 test 锁索引存在）。**教训：spike 跑 ANALYZE 会掩盖此问题，靠 EXPLAIN 测试在「无 ANALYZE 的真实 makeMemoryDb」下才暴露**。
- **_setup.ts 双处注册（Review R1 claude MED）**：测试 harness `agent-deck-repos/_setup.ts` 硬编码 migration import + exec 数组不读 MIGRATIONS，新 migration 必须 `migrations/index.ts` + `_setup.ts` 双处加，否则索引测试断言失败（且既有测试误绿掩盖）。
- **单列 idx_messages_to_session_id 冗余但保留（双方确认）**：新 `(to, sent_at DESC)` 是其超集前缀；v010 从无单列 `from` 索引故新 `(from, sent_at DESC)` 纯增益无冗余。v030 定调纯加不删存量，单列 to 保守保留（边际写放大，可接受）。
- **better-sqlite3 binding ABI**：跑 SQLite 真测前后保护 binding（CHANGELOG_42 教训）。worktree 跑测试用主仓库 Electron binary（ABI 130）+ ELECTRON_RUN_AS_NODE，不碰 binding 文件零 corruption。
