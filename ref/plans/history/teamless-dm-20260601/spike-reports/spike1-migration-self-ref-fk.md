# Spike 1 — 放松 `agent_deck_messages.team_id` NOT NULL（自引用 FK 表重建）

> 状态：**已完成**。结论：v017-style 朴素重建会**静默 null 掉所有 reply chain**；正确手法是 rename-old-first。

## 动机

「任意发送消息」需要 teamless DM（无 shared team 时也能发）。核心阻塞：`agent_deck_messages.team_id` 是 `NOT NULL REFERENCES agent_deck_teams(id)`。SQLite 不支持 `ALTER COLUMN` 去 NOT NULL → 必须整表重建（v014 DROP COLUMN / v017 FK 改动同款 12-step 流程）。

## 假设（spike 前）

1. 直接照搬 v017 的 `_new` 临时表 + `INSERT FROM old` + `DROP old` + `RENAME` 即可放松 NOT NULL。
2. 迁移在 `db.ts` 的 `foreign_keys=ON` + `db.transaction()` 内跑没问题（v017 就是这么跑的）。

## 实测环境

- `sqlite3` 3.43.2 CLI（better-sqlite3 11.10 bundle 更新版，但 DDL/FK/ALTER 重建语义自 3.35 (2021) 稳定，3.43 覆盖）。
- **为何不用 better-sqlite3 JS**：binding 是 Electron 33 ABI（NODE_MODULE_VERSION 130），独立 node 跑不起来（CLAUDE.md 明确禁止 rebuild binding 否则污染 Electron）。spike 主题是纯 SQL/DDL/FK 语义，`db.transaction()` 只是发 `BEGIN;...;COMMIT;`，CLI 完全等价且零副作用（不碰真实 DB / 不碰 binding）。
- runner 源码：`spike1-migration-runner.sql`（同目录）。

## 关键发现：朴素重建静默损坏 reply chain ❌

模拟真实约束（`foreign_keys=ON` + 事务内）跑 v017-style 重建：

```
SETUP: rows=2  (m2.reply_to_message_id='m1')
CASE-A REBUILD: OK (committed, FK stayed ON)
VERIFY self-FK preserved: FAIL   ← m2.reply_to 被 null 掉了！
VERIFY foreign_key_check: PASS    ← 注意：完整性检查反而 PASS（坑！）
VERIFY teamless insert: PASS
```

**机制（已逐步定位）**：

```
after-copy m2.reply_to=m1      ← INSERT INTO _new 后数据正确
after-DROP m2.reply_to=NULL    ← DROP TABLE old 之后被 null 掉
```

`DROP TABLE agent_deck_messages`（旧表）在 `foreign_keys=ON` 下会对旧表所有 row 做隐式 DELETE。此刻 `_new` 表的自引用 FK `reply_to_message_id REFERENCES agent_deck_messages(id) ON DELETE SET NULL` **按表名解析仍指向正在被 DROP 的旧表** → 旧表每行被删都触发 `_new` 里引用它的 reply 行 `SET NULL`。

**v017 为何没踩**：v017 重建的是 `agent_deck_team_members`，没有任何表（包括它自己）引用它 → DROP 不触发任何 cascade。`agent_deck_messages` **引用自己**（v015 的 reply_to_message_id），这是质的区别。

**为何 `foreign_key_check` PASS 极具迷惑性**：null 掉 reply_to 后数据「完整性」上确实无违规（null 是合法值），所以静态检查发现不了。只有显式断言「reply chain 应保留」才抓得到 → **若不写这条断言，bug 会静默上线，所有历史 reply 对话链在升级瞬间断裂**。

## Fix 验证

| 方案 | 手法 | 结果 |
|---|---|---|
| FIX 1 | `PRAGMA defer_foreign_keys=ON` 后照旧重建 | ❌ FAIL — defer 只推迟约束**检查**，不推迟 cascade **动作**，`SET NULL` 照样触发 |
| FIX 2 | `PRAGMA legacy_alter_table=ON` 包住 RENAME | ❌ FAIL — 只影响 RENAME 时对引用方的改写，DROP 阶段的 cascade 已先发生 |
| **FIX 3** | **rename-old-first**：先把旧表 `RENAME TO _old` → 用**最终名**建新表（自引用 FK 解析到自己）→ `INSERT FROM _old` → `DROP _old`（无人引用 _old → 零 cascade）| ✅ **PASS** |

FIX 3 鲁棒性补测：
- **行序无关**：`ORDER BY sent_at DESC` 强制 reply 行先于被引用行插入，仍 PASS（`m2→m1`、`m3→m2` 多级链全保留）。
- **`defer_foreign_keys` 非必需**：FIX 3a（不加 defer）与 FIX 3b（加 defer）都 PASS。**保险起见保留 defer**（自引用 FK 在 bulk INSERT 中途的瞬态可被推迟到 COMMIT 校验，零成本防御未来行序/批量边界变化）。

## 最终迁移骨架（已实证）

```sql
-- v027_agent_deck_messages_team_id_nullable.sql
PRAGMA defer_foreign_keys=ON;                          -- 防御性；FIX 3 证明非必需但零成本
ALTER TABLE agent_deck_messages RENAME TO agent_deck_messages_old;
CREATE TABLE agent_deck_messages (                     -- 用最终名建，自引用 FK 解析到自己
  ...
  team_id TEXT REFERENCES agent_deck_teams(id) ON DELETE CASCADE,   -- 去掉 NOT NULL
  ...
  reply_to_message_id TEXT REFERENCES agent_deck_messages(id) ON DELETE SET NULL
);
INSERT INTO agent_deck_messages SELECT <13 列> FROM agent_deck_messages_old;
DROP TABLE agent_deck_messages_old;                    -- 无人引用 _old → 零 cascade
-- 重建全部 5 个 index
```

## Post-migration invariant（全 PASS）

1. teamless insert（`team_id=NULL`）✅
2. 自引用 FK 仍 enforce（reply 指向不存在 msg 被拒）✅
3. `team_id` 非空值仍 enforce team FK（插 ghost team 被拒）✅
4. team CASCADE 仍工作（删 team → 该 team 消息级联删）✅
5. teamless 消息不受 team CASCADE 影响（`team_id=NULL` 不被任何 team 删除波及）✅

## 残留风险

- **R1（已缓解）**：迁移**必须**在 plan 实施时把「reply chain 保留」写进 vitest 真测断言（不能只靠 `foreign_key_check`）。SQLite 真测受 CLAUDE.md ABI 守门约束（task-repo.test.ts 顶部 binding 自检 skip）→ 走同款 skip-guard 模式。
- **R2**：迁移在已有大量历史消息的 DB 上是 O(n) 全表 copy。单人本地应用消息量级（≤ 数千）无虑；首跑在 bootstrap 事务内，失败即整体回滚 + fatal（与 v014/v017 同款风险面，非新增）。
- **R3**：`agent_deck_messages` 是否被**其他**表反向引用？已查：仅 `reply_to_message_id` 自引用，无外部表 FK 指向它 → rename-old-first 的「无人引用 _old」前提成立。
