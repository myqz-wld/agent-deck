# spike1 — listBySession 全表扫描 + UNION ALL 双索引重写 + GC 索引实测

> plan message-retention-and-index-20260602 / 关联 issue 7dcb0676（REVIEW_100 R2 codex LOW-②）
> runner：`spike1-explain-query-plan.sql`；权威输出：`spike1-explain-query-plan.log`
> 环境：sqlite3 3.43.2（系统 CLI，与 better-sqlite3 11.10 同 SQLite 大版本，EXPLAIN QUERY PLAN 输出格式一致）

## 动机

issue 7dcb0676 提出两条结论待实证：
1. `listBySession` 的 `WHERE from_session_id=? OR to_session_id=?` 走全表 SCAN（teamless DM 放大全局表规模 → 单 session 面板尾延迟）
2. 修复方向：双索引 `(from,sent_at DESC)`+`(to,sent_at DESC)` + UNION ALL 重写 + GC retention

## 假设

- H1：当前 OR 查询无可用索引 → `SCAN agent_deck_messages` + `USE TEMP B-TREE FOR ORDER BY`
- H2：UNION ALL 改写后两路各走 `(session,sent_at DESC)` 索引 → 双 `SEARCH USING INDEX`，消灭全表 SCAN
- H3：UNION ALL 结果与 baseline OR 查询完全一致——正常数据 self-msg 不存在（无重复）；但 rename collision 可造 self-row，第二分支需 `from_session_id <> ?` guard 才保 byte-identical（Review R1 codex HIGH-2）
- H4：GC 查询 `status IN (terminal) AND sent_at < ?` 必须用 **partial `(sent_at) WHERE status IN (terminal)`** 才能沿索引 `LIMIT` early-stop；status-first `(status,sent_at)` 仍 `USE TEMP B-TREE` 全排 backlog 破 500 预算（Review R1 codex HIGH-1 修订，初版 H4 假设 `(status,sent_at)` 被推翻）

## 实测命令

复刻 v027 schema（team_id nullable）+ v010/v015 的 5 个原索引，灌 5000 行（50 session，from/to 错位避免 self-msg），`ANALYZE` 后 `EXPLAIN QUERY PLAN`。runner 经 Deep-Review R1/R2 迭代：加 listBySession 双索引、(3b) self-row guard 验证、(4a/4b) GC status-first vs partial 两段对比、(4c) partial 命中规则。详 `spike1-explain-query-plan.sql` + 权威输出 `spike1-explain-query-plan.log`。

## 实测结果（`spike1-explain-query-plan.log`）

### (1) baseline 当前 OR 查询 — 全表 SCAN（H1 ✅ 实证）

```
QUERY PLAN
|--SCAN agent_deck_messages
`--USE TEMP B-TREE FOR ORDER BY
```

→ issue 结论属实：单 session 面板查询扫全表，teamless DM 增加全局表规模直接带进尾延迟。

### (2) UNION ALL 双索引重写 — 双 SEARCH USING INDEX（H2 ✅ 实证）

```
QUERY PLAN
`--MERGE (UNION ALL)
   |--LEFT
   |  |--SEARCH agent_deck_messages USING INDEX idx_messages_from_session_sent_at (from_session_id=?)
   |  `--USE TEMP B-TREE FOR RIGHT PART OF ORDER BY
   `--RIGHT
      |--SEARCH agent_deck_messages USING INDEX idx_messages_to_session_sent_at (to_session_id=?)
      `--USE TEMP B-TREE FOR RIGHT PART OF ORDER BY
```

→ 全表 SCAN 消失，两路各走 `(session,sent_at DESC)` 索引。残留 `TEMP B-TREE FOR RIGHT PART OF ORDER BY` 仅对**单 session 命中子集**（几十~几百行）排序，与全表 5000 行 SCAN 是数量级差异。

> **形态依赖说明**：外层投影 `SELECT *` → `MERGE (UNION ALL)`（每路索引序，仅 RIGHT part temp sort）；外层显式列投影 → `CO-ROUTINE` + 整体 temp sort。**两者都消灭全表 SCAN**（核心目标），都走双 SEARCH USING INDEX。实现取 `SELECT *` 子查询 + 外层显式列投影剥离辅助 `_rid` 列（plan 即便退化成 CO-ROUTINE 形态仍是双 SEARCH）。

### (3) 正确性 — UNION ALL == baseline，无重复（H3 ✅ 实证）

```
or_cnt | union_all_cnt | self_rows
200    | 200           | 0
```

→ `union_all_cnt == or_cnt == 200`，`self_rows == 0`。**self-msg 不存在**（`crud.ts insert` 在 `from==to` 时直接 `throw MessageInvariantError`），所以 UNION ALL 永远不会对同一行计两次 → 无需 `UNION`（去重）/ `DISTINCT`，用 `UNION ALL`（不去重，更快）即正确。

补充实测（spike2 交互验证，记录于本节）：全部同毫秒 sent_at 的 5 行（m1..m5）下，UNION ALL `ORDER BY sent_at DESC, _rid DESC` 输出 `m5,m4,m3,m2,m1` 与 baseline OR 查询 byte-identical；status filter 分支（delivered → m5,m4,m3,m1 排除 pending m2）一致；分页 `LIMIT 2 OFFSET 0/2` 不重叠不漏（page1=m5,m4 / page2=m3,m2）。

→ **REVIEW_90 的 rowid 二级定序在 UNION ALL 下完整保留**：子查询 `SELECT *, rowid AS _rid`，外层 `ORDER BY sent_at DESC, _rid DESC`。注意必须用 `rowid` 而非 `id`（id 是 crypto.randomUUID 随机，rowid 单调随插入）。

> ⚠️ **「self-msg 不存在」只对 crud insert 成立，rename 路径例外（Review R1 codex HIGH-2）**：`crud.ts insert` 防 from==to，但 `session-repo/rename.ts:156-161` 分别 UPDATE from/to——rename A→B 时 `from=A,to=B` 行第一条 UPDATE 变 `from=B,to=B`（self-row）。lead sqlite3 复现：此时 OR 查询=1 行 / **无 guard UNION ALL=2 行**（重复）/ 第二分支加 `from_session_id <> ?` guard=1 行（修复）。**所以 D5 第二分支必须带 guard，不能裸 UNION ALL**。

### (4) GC 查询索引 — 必须 partial `(sent_at) WHERE status IN terminal`（H4 修订，Review R1 codex HIGH-1）

> **初版 spike 用 `(status, sent_at)` 复合索引，Deep-Review codex HIGH-1 指出仍 temp-sort 全 backlog，lead sqlite3 复测确认 → 改 partial index。**

```
-- status-first 复合索引 (status, sent_at)：仍 TEMP B-TREE（❌ 破 500 预算）
QUERY PLAN
|--SEARCH agent_deck_messages USING INDEX idx_messages_status_sent_at (status=? AND sent_at<?)
`--USE TEMP B-TREE FOR ORDER BY

-- partial 索引 (sent_at) WHERE status IN ('delivered','failed','cancelled')：无 temp sort（✅）
QUERY PLAN
`--SEARCH agent_deck_messages USING INDEX idx_messages_terminal_sent_at (sent_at<?)
```

→ **关键洞（codex HIGH-1）**：`status IN ('delivered','failed','cancelled')` 是 3 个值，`(status, sent_at)` 复合索引下每个 status 区段内 sent_at 有序但**跨 3 段无全局序** → `ORDER BY sent_at ASC LIMIT 500` 必须 `USE TEMP B-TREE` 把**全部**超期 terminal 行排完才能取前 500，O(N log N) per tick，catch-up 每轮重排全 backlog → 破坏「500 分批守主线程预算」。partial `(sent_at) WHERE status IN (terminal)` 把 terminal 行收敛进单一 B-tree 段，sent_at 直接有序 → LIMIT 500 沿索引早停，无 temp sort。

> ⚠️ **初版结论「总扫描量=超期行数（GC 本就要全删）」是错的**：catch-up 多轮场景下每轮都重新 temp-sort 整个 backlog（不只删的那 500），N 大时反复 O(N log N)。partial index 是正解。

## 结论

| 假设 | 状态 |
|---|---|
| H1 当前 OR 查询全表 SCAN | ✅ 实证 |
| H2 UNION ALL 双索引 → 双 SEARCH | ✅ 实证 |
| H3 UNION ALL == baseline（self-msg 无；rename self-row 需 guard） | ✅ 实证（含 Review R1 codex HIGH-2 修订：第二分支 guard） |
| H4 GC 索引 | ✅ 实证（含 Review R1 codex HIGH-1 修订：必须 partial 不是 status-first） |

**v029 加 3 索引**：`idx_messages_from_session_sent_at(from_session_id, sent_at DESC)` / `idx_messages_to_session_sent_at(to_session_id, sent_at DESC)` / `idx_messages_terminal_sent_at(sent_at) WHERE status IN ('delivered','failed','cancelled')`。
**crud.ts listBySession 改 UNION ALL**（两分支：无 status / 有 status filter），子查询 `SELECT *, rowid AS _rid`，**第二分支带 `AND from_session_id <> ?` guard**，外层显式列投影 + `ORDER BY sent_at DESC, _rid DESC`。

## 残留风险

1. **`idx_messages_to_session_id`（单列 to）冗余**：v029 加的 `idx_messages_to_session_sent_at(to, sent_at DESC)` 是它的超集前缀。但 `idx_messages_to_session_pending` 是部分索引（WHERE status IN pending/delivering）服务 backpressure，**不冗余**，保留。单列 `idx_messages_to_session_id` 保守保留（删它属额外 schema 变更，v029 定调纯加不动存量；Review R1 双方确认合理）。
2. **写放大**：每条 insert 多维护 2~3 个索引（teamless DM 高频时）。但 message insert 频率远低于读（每条 message 至少被 listBySession/listByTeam 读多次），读优化收益 > 写成本。
3. **listBySession 残留 TEMP B-TREE**：仅对单 session 命中子集排序，非全表。若未来单 session 消息数也爆炸（数万），可考虑 keyset 分页——但远超当前场景，不预先优化。
4. **GC partial index 已消 TEMP B-TREE**：见 (4) 节修订——partial `(sent_at) WHERE status IN terminal` 让 GC 查询沿索引 LIMIT 早停，守住 N6 500 预算。
