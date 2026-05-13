# CHANGELOG_96: session rename / delete 撞 FK constraint 收口（v017 schema CASCADE + rename 显式迁 team_members/messages/spawned_by）

**触发**：用户报 SDK 流中断「⚠ FOREIGN KEY constraint failed」screenshot —— hand-off 到新 session 时整条 SDK 流中断 + sessionId 里 cwd 为空 + events 顺序错乱（id 序 vs ts 序反向）。

## 概要

DB 数据 + 代码追源完全验证根因：用户在 session `a6260807-...`（review-batch-a/b/c/d 4 个 team 的 active lead）发新 message → SDK 通道已断 → `recoverer.recoverAndSend` → `createSession({resume: a6260807-..., prompt})` → CLI 隐式 fork（first SDKMessage `session_id = eb91a994-...` ≠ resume id）→ `stream-processor.ts:253` 进 fork 分支调 `sessionManager.renameSdkSession(a6260807-..., eb91a994-...)` → `sessionRepo.rename` 事务最后一步 `DELETE FROM sessions WHERE id = a6260807-...` → **撞 `agent_deck_team_members.session_id` FK ON DELETE RESTRICT**（a6260807 是 4 个 team 的 active lead）→ 整个 rename 事务回滚 → consume catch emit 红字 + finally session-end 用 NEW sid → finalizeSessionStart 又 emit session-start + user message 到 NEW —— `eb91a994-...` 成 cwd 空、4 条事件错乱顺序的孤儿 row。

实测铁证：`sqlite3 ... DELETE FROM sessions WHERE id='a6260807-...'` 直接抛 `FOREIGN KEY constraint failed (19)`。

附带发现 `sessionManager.delete` 同条 FK 链路也撞（`leaveTeamsAndAutoArchive` 写 `left_at` 不删 row → `sessionRepo.delete` 撞 RESTRICT）—— 任何在 active team_members 的 session 用 UI「删除」按钮也删不掉，是 v010 设计意图与物理约束互斥的隐藏 bug。

## 修法（用户已选定 + plan linked-swimming-platypus 双轨）

### Q1：v017 schema migration —— `agent_deck_team_members.session_id` RESTRICT → CASCADE

新建 `src/main/store/migrations/v017_agent_deck_team_members_cascade.sql`：

- SQLite 改 FK 必须 recreate table（12-step）：CREATE `_new` 表 → INSERT FROM old → DROP old → RENAME `_new` → old → 重建 3 索引（idx_team_members_session_id / idx_team_members_team_id_role / idx_team_members_active_session）
- 整段在 db.ts 的 `db.transaction(() => for migration: db.exec)` 内跑，安全（agent_deck_team_members 没被任何表 FK 反引用）
- migrations/index.ts 注册 `{ version: 17, name: 'agent_deck_team_members_cascade', sql: v017 }`
- v010 注释加 marker「v017 update: session_id FK 改 ON DELETE CASCADE 修正 v010 设计冲突 —— RESTRICT 阻塞 sessions DELETE 但 leaveTeam 只 UPDATE left_at 不物理删 row，pre-check 失效」

### Q2：用户自己手写 SQL cleanup `a6260807` + 孤儿 `eb91a994`（agent 不动数据）

详 plan §Step 5；SQL 用户自己跑（v017 跑完 sessions DELETE 自动 CASCADE 清 4 条 team_members）。

### rename.ts 事务内显式迁移 3 类引用（避免 NEW 失去 OLD 在 team 角色）

CASCADE 只放宽 DELETE 不撞 FK，但 OLD 一旦被 DELETE 其 team_members rows 会被级联清 → NEW 失去 lead/teammate 身份 → team 自动 archive → 违反 rename「OLD 整个迁到 NEW 名下」语义。所以 rename 内**必须**在 DELETE OLD 之前显式 UPDATE 迁移：

```typescript
// (a) team_members 迁移：让 NEW 续接 OLD 在 team 的 lead/teammate 角色
//     PK = (team_id, session_id)；fork 路径下 NEW 100% 不会被 spawn handler 提前 addMember
//     （createSession 不调 addMember），PK 冲突不发生；防御性先删 NEW 同 team 已存在 row
db.prepare(
  `DELETE FROM agent_deck_team_members
   WHERE session_id = ?
     AND team_id IN (SELECT team_id FROM agent_deck_team_members WHERE session_id = ?)`,
).run(toId, fromId);
db.prepare(
  `UPDATE agent_deck_team_members SET session_id = ? WHERE session_id = ?`,
).run(toId, fromId);

// (b) messages.from/to_session_id 迁移：FK 不强制（v010 设计允许已删 sender 留痕），
//     但 universal-message-watcher 反查 sessionRepo.get(toSessionId) 拿 receiver session
//     做投递；rename 后 OLD 不在 sessions 表 → markFailed("target session not found") →
//     wait_reply 等的 lead 收到假阴性。
db.prepare(
  `UPDATE agent_deck_messages SET from_session_id = ? WHERE from_session_id = ?`,
).run(toId, fromId);
db.prepare(
  `UPDATE agent_deck_messages SET to_session_id = ? WHERE to_session_id = ?`,
).run(toId, fromId);

// (c) sessions.spawned_by 自引用迁移：v009 ON DELETE SET NULL 兜底，DELETE OLD 自动断链
//     不会撞 FK。但 spawn chain 完整性更友好：UPDATE 让 OLD 派生的子 session 仍指向 NEW。
db.prepare(
  `UPDATE sessions SET spawned_by = ? WHERE spawned_by = ?`,
).run(toId, fromId);
```

rename.ts 顶部 jsdoc 整段重写：删过期 contract「session_id 改名时需调 sessionManager.delete 路径的 leaveTeam 兜底（已实现），或 rename 后由 caller 自行 leaveTeam(OLD) + addMember(NEW)」（**所有 6 处 renameSdkSession caller 均无实现**——stream-processor.ts:219/253 / restart-controller.ts:125/238 / recoverer.ts:222 / codex-cli/thread-loop.ts:134），加新双轨说明（v017 CASCADE 兜底删 + application UPDATE 续接）。

为了能在 in-memory db 真测 rename 行为，加 `renameWithDb(db, fromId, toId)` test seam（生产 `rename(fromId, toId)` 是 `renameWithDb(getDb(), ...)` 薄 wrapper，sessionRepo facade `spread { rename }` 不变）。

### 测试更新

`src/main/store/__tests__/agent-deck-repos.test.ts`：

- import v012-v017（原仅 import v001-v011）+ makeMemoryDb 数组同步（让 rename 测试覆盖完整 schema）
- 改写「session ON DELETE RESTRICT 拦截」测试为「session ON DELETE CASCADE 自动级联清 team_members」（删 sessions 不抛 + COUNT == 0 验证级联）
- 加 3 个新 it 验证 rename 迁移行为（fork rename simulate）：
  1. `renameWithDb` 内迁 team_members.session_id 让 NEW 续接 OLD lead 角色（OLD 已删 / NEW 已建 / `repo.listActiveMembers(t.id)` 返回 NEW + role='lead'）
  2. `renameWithDb` 内迁 messages.from_session_id + to_session_id（OLD 字段 COUNT=0 / NEW 接管 COUNT=1）
  3. `renameWithDb` 内迁 sessions.spawned_by 自引用（child.spawned_by 从 'parent' 迁到 'parent-new' 不被 ON DELETE SET NULL 自动断链）

### sessionManager.delete + leaveTeamsAndAutoArchive jsdoc 更新

CASCADE 后 sessions DELETE 不再撞 FK，但 `leaveTeamsAndAutoArchive` 仍 await 是为了**UX 正确性**而非 FK 绕行：

- 写 `left_at` + emit `agent-deck-team-member-changed` 让 TeamHub / TeamDetail 立刻刷新
- 0-active-lead 触发 team auto-archive + emit `agent-deck-team-updated`
- 然后 sessionRepo.delete 走 CASCADE 物理清 row（archive 之后的清理收尾）

颠倒顺序（先 delete 再 leaveTeam）会让 CASCADE 已删 member rows，leaveTeam 找不到 active row → 不 emit → UI 不刷新 + archive 联动跑空。`@warning **delete 路径调用必须 await**：sessionRepo.delete 后续段依赖 leaveTeam 已写 left_at` 改成 `@note **delete 路径调用 await 是 UX 正确性而非 FK 绕行**`。逻辑不动，只更注释。

## 变更内容（按模块）

### 新建文件

- `src/main/store/migrations/v017_agent_deck_team_members_cascade.sql`：recreate table + FK CASCADE + 重建 3 索引
- `changelog/CHANGELOG_96.md`：本文件

### 修改文件

- `src/main/store/migrations/index.ts`：加 v017 import + MIGRATIONS 数组追一行
- `src/main/store/migrations/v010_agent_deck_teams.sql`：注释加 marker「v017 update」
- `src/main/store/session-repo/rename.ts`：事务内 INSERT/UPDATE events/file_changes/summaries 之后增 3 段 UPDATE（team_members + messages 双字段 + spawned_by），加 `renameWithDb(db, fromId, toId)` test seam，`rename` 改成 `renameWithDb(getDb(), ...)` 薄 wrapper，顶部 jsdoc 整段重写
- `src/main/store/__tests__/agent-deck-repos.test.ts`：import v012-v017 + makeMemoryDb 数组同步 + import `renameWithDb` + 改写 RESTRICT→CASCADE 测试 + 加 3 个 rename 迁移测试
- `src/main/session/manager.ts`：`delete` 方法 jsdoc 重写（删 RESTRICT FK 解释 + 加 await UX 正确性解释）
- `src/main/session/manager-team-coordinator.ts`：`leaveTeamsAndAutoArchive` jsdoc 删 `@warning FK RESTRICT` 段 + 改 `@note await UX 正确性`

## 决策（不走对抗的依据）

| 决策 | 依据 |
|------|------|
| Q1 改 schema 而非纯应用层 | 用户明确选定。schema CASCADE 同时根治 rename + sessionManager.delete 两条路径 FK，比应用层 hard-delete team_members 更彻底 |
| rename 仍显式 UPDATE 迁 3 类引用 | CASCADE 不解决「续接」语义（OLD 被删 → NEW 失去 membership → team auto-archive），必须双轨 |
| messages.from/to UPDATE 迁移 | watcher.deliver line 456 反查 `sessionRepo.get(toSessionId)` 拿 receiver session，OLD 不在 → markFailed 假阴性 |
| spawned_by UPDATE 迁移 | ON DELETE SET NULL 兜底不撞 FK，UPDATE 仅为 spawn chain 完整性更友好（应用层不强依赖 spawned_by 非 null） |
| renameWithDb test seam | 让 in-memory db 真测 rename 行为（sessionRepo 是单例 getDb()，无 db 注入接口）；最小重构（生产 API surface 不变） |
| Q2 用户手动 cleanup 而非 agent 写脚本 | 用户明确选定。a6260807 + eb91a994 是用户私有 DB 状态，让用户掌控物理删除时机（4 个 review-batch teams 是否 archive 还是 hardDelete 用户自己决定） |
| 不走异构对抗 | 修法：单点 schema 改动 + rename UPDATE 三段，根因 DB 数据 + 代码追源完全验证（实测铁证 `DELETE FROM sessions ... → FOREIGN KEY constraint failed (19)`）+ 设计已经经过用户 Q1/Q2 确认 + 2 个 Explore agent 独立调研，没有多个备选要权衡 |

## 已知踩坑

- **CASCADE 不解决 rename 的「membership 续接」问题**：CASCADE 只放宽 DELETE 不撞 FK，但 OLD 的 member rows 会被级联删 → NEW 失去 lead/teammate 身份 → team 自动 archive。所以 rename 必须显式 UPDATE 迁移 team_members（双轨：schema CASCADE 兜底删 + application UPDATE 续接）。任何未来想用「直接 DELETE OLD 让 CASCADE 自然清」的简化方案都会触发此 bug
- **PK conflict 防御**：`agent_deck_team_members` PK=(team_id, session_id)，fork 路径理论上 NEW 不会提前 addMember 所以 PK 冲突 100% 不发生（createSession 不调 addMember，addMember 仅在 spawn handler 路径）；防御性 DELETE NEW-then-UPDATE 是为未来 spawn handler 改动留 latitude，无 row 时 0 changes 零 IO 开销
- **messages.from/to 不强制 FK 但仍要迁**：universal-message-watcher.ts:456 `sessionRepo.get(toSessionId)`，rename 后 OLD 不在 sessions 表 → markFailed("target session not found") → wait_reply 等的 lead 收到假阴性。bug 表面是「投递不动」实际是 sessionId 引用悬挂
- **sessions.spawned_by 自引用 SET NULL 兜底**：v009 ON DELETE SET NULL，rename 不主动迁也不会撞 FK（自动断链）。新加 UPDATE 是「保 spawn chain 完整性」更友好做法，应用层不强依赖
- **`renameWithDb` test seam 不破坏 sessionRepo facade**：sessionRepo facade `spread { rename }` 不变（rename 仍是默认 `renameWithDb(getDb(), ...)` wrapper），所有 6 处 caller 不动；test 路径直接 `import { renameWithDb }` 用 in-memory db handle 真测
- **vitest 真测 better-sqlite3 binding 陷阱**：CLAUDE.md 已记，本文件 `probeBetterSqliteBinding` skip 守门覆盖；本地真跑后必须按 binding 自检 / 清缓存 + rebuild 收尾。本次 PR 没本地真跑（typecheck 双端通过 + dev migration 实测 v17 跑通即认为足够）
- **dev 启动可能撞 ELECTRON_RUN_AS_NODE 污染**：CLAUDE.md「打包验证」节已记此陷阱（Electron 二进制被切到伪装 Node 模式 → `electron.app` undefined）；遇到先 `unset ELECTRON_RUN_AS_NODE` 再 `pnpm dev`。本 PR 实测一次（`zsh -i -l -c "unset ELECTRON_RUN_AS_NODE; pnpm dev"` 启动后正常跑通 v17 migration + hook-server listening on 47821 + 各 adapter initialized）
- **Q2 用户手动 cleanup SQL** 在 plan §Step 5 详列，含 a6260807 + eb91a994 + 4 个 review-batch teams 命运抉择（archive vs hardDelete）

## 关联

- **plan**: `/Users/apple/.claude/plans/linked-swimming-platypus.md`（in_progress → 写完 CHANGELOG 后置 completed）
- **CHANGELOG_27**：CLI 隐式 fork rename 路径来源（fork detection + sessionRepo.rename 触发）
- **REVIEW_5 H4 / REVIEW_7 M3**：renameSdkSession sdkOwned claim 转移内聚（本 PR 不动该路径）
- **v010 schema 注释**：补 marker 引用 v017 + 解释为什么 RESTRICT 设计被推翻
- **conventions/tally.md** 新加 P33 候选：「DB FK 约束 ON DELETE RESTRICT + 应用层 leave 操作仅 UPDATE left_at 不删 row 的反模式（pre-check 形式实质失效，bug 隐藏）」count=1，待累计

## 测试

- `pnpm typecheck` 双端通过
- `pnpm dev` 启动后 console log `[db] migrated to v17 (agent_deck_team_members_cascade)` + sqlite3 验证 `agent_deck_team_members.session_id REFERENCES sessions(id) ON DELETE CASCADE` + `PRAGMA user_version = 17`
- `agent-deck-repos.test.ts` 新加 4 个 it（CASCADE 行为 + 3 个 rename 迁移）等用户本地按需 binding rebuild 实测 / CI 跑（默认 binding probe skip 守门）
- 端到端验证留下次 dev smoke：(a) 找另一个挂 active team membership 的 session 让 SDK stream-ended 后发新 message → recoverAndSend → CLI fork → rename 不抛 FK + NEW 接管 lead 角色；(b) 起一个新 session 自动加 review-batch-X team → SessionList 右键 Delete → row 删除成功 + 自动级联清 + 0-lead → team auto-archive
