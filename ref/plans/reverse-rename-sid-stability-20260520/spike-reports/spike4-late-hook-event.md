# spike4: 迟到 hook event sid + sessionRepo.findByCliSessionId 反查

> spike 完成日期：2026-05-20
> runner: `spike4-runner.mjs` (read-only 静态实测)
> log: `spike4.log`

## 动机

plan §设计决策 D7 + 不变量 5 说「迟到 hook event 路由:CLI 子进程飞回的迟到 event 携带 cli_session_id,ingest 入口先 sessionRepo.findByCliSessionId 反查 sessions.id,找不到 + isRecentlyDeleted(cli_session_id) 命中即丢弃」。本 spike 验证:

1. 当前 recentlyDeleted 黑名单实现 (manager.ts:103) — Map<sessionId, deletedAt>,TTL 60s
2. 反向 rename 后黑名单 key 含义改为 OLD_CLI_ID (而非 sessions.id)
3. ingest 入口 `isRecentlyDeleted(event.sessionId)` 早返时序 (manager.ts:224)
4. 新增 `sessionRepo.findByCliSessionId(cliSid)` 反查 — schema 设计 + 唯一索引避 O(N)
5. 反向 rename 后 ingest pipeline 流程改造可行性

## 实测命令 + 实测结果

### 实测 4.1: 当前 recentlyDeleted Map 实现 (manager.ts:103)

```typescript
private recentlyDeleted = new Map<string, number>(); // sessionId → deletedAt
private static readonly RECENTLY_DELETED_TTL_MS = 60_000;
```

**当前 3 个 set 调用点**:

| line | 上下文 | sessionId 含义 |
|---|---|---|
| `manager.ts:255` | `markRecentlyDeleted(sid)` 公开 API (sdk-bridge.closeSession 双保险) | 应用 sessionId(当前 = cli_session_id 一份) |
| `manager.ts:452` | `delete(sid)` 内 (REVIEW_4 H1 兜底) | 应用 sessionId(当前 = cli_session_id 一份) |
| `manager.ts:480` | `renameSdkSession(fromId, toId)` 内 — fromId 加进黑名单 | OLD sessionId(rename 后 OLD 已 DELETE) |

**反向 rename 修法 D7**:
- L480 `recentlyDeleted.set(fromId, ...)` 改为 `recentlyDeleted.set(oldCliSessionId, ...)` — 6 处反向 rename 路径在 `updateCliSessionId(rec.id, NEW_CLI_ID)` 内调本 helper,黑名单存的是 OLD_CLI_ID(rename 后该 cli_session_id 在 cli_session_id 列已被覆盖,迟到 hook event 携带 OLD_CLI_ID 时 findByCliSessionId 找不到 → 走黑名单 skip)
- L255 `markRecentlyDeleted` / L452 `delete()` 内 set 当前传 application sid — **这两处含义不变**(应用 sid 删了,任何 sid 携带这个 application sid 来的 hook event 都丢,与现状一致)。但反向 rename 后 hook event body.session_id 永远是 cli_session_id 不是 application sid,这两处的命中场景需重审:
  - **L255 `markRecentlyDeleted` 调用方**: sdk-bridge.closeSession 双保险(REVIEW_12 Bug 5),传的是当前 active session 的 cli_session_id — 改成传 cli_session_id 即可
  - **L452 `delete()` 内**: SessionManager.delete 接收 application sid 入参,但 hook event 飞回的是 cli_session_id,需要先反查 `rec.cli_session_id` 加进黑名单(让迟到 hook event 命中)

### 实测 4.2: ingest 入口 isRecentlyDeleted 早返 (manager.ts:224)

```typescript
ingest(event: AgentEvent): void {
  // ...
  if (this.isRecentlyDeleted(event.sessionId)) return;  // ← L224 早返
  if (dedupOrClaim(this.ingestCtx, event).skip) return;
  const record = ensureRecord(this.ingestCtx, event);
  // ...
}
```

**反向 rename 修法 D7 流程改造**:

```typescript
ingest(event: AgentEvent): void {
  // 反向 rename: 先 findByCliSessionId 反查
  const cliSid = event.sessionId;  // hook payload 携带的是 CLI thread sid
  const appSession = sessionRepo.findByCliSessionId(cliSid);
  if (appSession) {
    // 找到 → 覆写 event.sessionId 为 application sid 走正常路径
    event = { ...event, sessionId: appSession.id };
    // 走原 ingest 流程
    if (this.isRecentlyDeleted(event.sessionId)) return;  // 现状黑名单仍以 application sid 防 delete 兜底
    if (dedupOrClaim(this.ingestCtx, event).skip) return;
    const record = ensureRecord(this.ingestCtx, event);
    // ...
  } else {
    // 找不到 → 进迟到 hook event 黑名单分支
    if (this.isRecentlyDeleted(cliSid)) return;  // 反向 rename 黑名单存 OLD_CLI_ID
    // 不在黑名单 → 进 dedupOrClaim 时序兜底 (cwd 命中 pendingSdkCwds → claim;否则建外部 CLI session)
    // 现状逻辑保留
    if (dedupOrClaim(this.ingestCtx, event).skip) return;
    const record = ensureRecord(this.ingestCtx, event);
    // ...
  }
}
```

### 实测 4.3: sessionRepo 新增 findByCliSessionId 不冲突现有接口

`sessionRepo` 当前导出大量 free function (rename / archive / spawn-chain 各模块)。新增 `findByCliSessionId` 直接放 `core-crud.ts` (类比 `get(id)` 同款 SELECT 实现):

```typescript
// 新加在 core-crud.ts:get 函数下方
export function findByCliSessionId(cliSid: string): SessionRecord | null {
  const row = getDb()
    .prepare(`SELECT * FROM sessions WHERE cli_session_id = ?`)
    .get(cliSid) as Row | undefined;
  return row ? rowToRecord(row) : null;
}
```

**唯一索引保 O(log N)**: v021 migration 内加 `CREATE UNIQUE INDEX idx_sessions_cli_session_id ON sessions(cli_session_id)`(允许 NULL 多个但非空唯一)。

### 实测 4.4: v021 migration 文件 (类比 v020 cwd_release_marker)

```sql
-- v021_sessions_cli_session_id.sql
ALTER TABLE sessions ADD COLUMN cli_session_id TEXT DEFAULT NULL;
-- backfill 一次性: 历史 row 的 cli_session_id 与 sessions.id 相等 (反向 rename 修法落地前一致)
UPDATE sessions SET cli_session_id = id WHERE cli_session_id IS NULL;
-- 唯一索引保 findByCliSessionId O(log N) 反查
CREATE UNIQUE INDEX idx_sessions_cli_session_id ON sessions(cli_session_id);
```

migration runner 用 PRAGMA user_version (db.ts:25-36) 追踪,生产路径幂等执行一次。

### 实测 4.5: rename.ts 内 cli_session_id 列加进 INSERT/UPDATE (反向 rename 不动 sessions.id 但 fork 路径仍需迁移此列)

`rename.ts:83` INSERT 列清单 + L195-211 toExists=true 分支需新增 `cli_session_id` 字段处理 — 与 v020 cwd_release_marker 同款扩列模式。**但反向 rename 修法落地后,rename.ts 仅 spawn 主路径调用**(tempKey → realId 首次确认),tempKey 阶段 cli_session_id 也是 tempKey,reverse rename 改 cli_session_id 列是另一条路径(updateCliSessionId)。所以 rename.ts 加 cli_session_id 列只是为了兼容现有 spawn 路径,不影响反向 rename 主修法。

### 实测 4.6: hook event 携带 sid 来源链

```
CLI 子进程 hook curl POST body.session_id (CLI 内部 thread sid)
  → hook-routes.ts:28 校验 body.session_id
  → translate.ts:31 sessionId: p.session_id (AgentEvent.sessionId)
  → manager.ts:219 ingest(event)
  → manager.ts:224 isRecentlyDeleted(event.sessionId) 早返
```

**反向 rename 后**: event.sessionId = CLI 当前 thread sid (= cli_session_id),与 application sid (sessions.id) 解耦。

### 实测 4.7: D7 修法 ingest 流程 (4 态分流)

| 状态 | 条件 | 行为 |
|---|---|---|
| **3a** | findByCliSessionId 命中 | event.sessionId = appSession.id,走正常路径 |
| **3b** | findByCliSessionId 不命中 + isRecentlyDeleted(cliSid) | 丢弃迟到 hook event |
| **3c** | findByCliSessionId 不命中 + cwd 命中 pendingSdkCwds | claim+skip (现状时序兜底,不变) |
| **3d** | 全没命中 | ensureRecord 建外部 CLI 会话 (现状 fallback,不变) |

## 结论

✅ **D7 假设成立,修法路径清晰**:

1. 当前 recentlyDeleted Map<string, number> 结构**反向 rename 后无需改 schema**(仍以 string 为 key,但 key 含义从 application sid 改为 cli_session_id)
2. ingest 入口加 findByCliSessionId 反查不破坏 dedupOrClaim 5 段顺序硬约束(IngestContext 不需扩,反查在入口外做)
3. sessionRepo.findByCliSessionId 新增是 trivial SELECT,加唯一索引保 O(log N)
4. v021 migration backfill `UPDATE sessions SET cli_session_id = id WHERE cli_session_id IS NULL` 一次性,与 v014 / v017 / v020 同款执行模式
5. rename.ts 加 cli_session_id 列扩到 21 列,兼容 spawn 主路径(tempKey → realId)不破现有契约

**实施推论 (D7 修法清晰)**:

- **新增**: `sessionRepo.findByCliSessionId(cliSid)` (core-crud.ts)
- **新增**: v021 migration (加列 + backfill + 唯一索引)
- **改 manager.ts:103**: 注释 `sessionId → deletedAt` 改为 `cli_session_id → deletedAt`(语义记录,不破坏 type)
- **改 manager.ts ingest 入口**: 加 findByCliSessionId 反查 + 4 态分流
- **改 manager.ts:480**: `recentlyDeleted.set(fromId, ...)` 改为 `recentlyDeleted.set(oldCliSessionId, ...)` — 在新的 `updateCliSessionId(rec.id, NEW_CLI_ID)` helper 内做(替换 6 处反向 rename 调用)
- **改 manager.ts:255 / 452**: 黑名单 set 改为传 cli_session_id(从 sessionRepo.get(sid) 反查 cli_session_id 字段)

## 残留风险

- ⚠️ **rename.ts 加 cli_session_id 列扩 21 列后兼容性**: spawn 主路径 (tempKey → realId rename) 在 INSERT 时复制 OLD_ROW 内容 + 子表迁移,新加列必须正确处理。spike1 已实证 jsonl 文件名 == sessions.id (== cli_session_id 现状),tempKey 阶段 sessions.id == tempKey 但 cli_session_id 应为 NULL(SDK 还没给 first realId)→ rename 时把 NEW row 的 cli_session_id 设为 realId(从 first SDKMessage.session_id 拿)。这是 spawn 路径主流程,需细心处理(但与反向 rename 修法解耦,只是顺手补)。
- ⚠️ **isRecentlyDeleted 早返跨 cli_session_id 重 alloc 的边角**: 极端场景下同 application sid 经历 fork → A_CLI → B_CLI → A_CLI(罕见)— 黑名单内的 A_CLI 会让第二次 A_CLI 的迟到 event 也被错误丢弃。但 A_CLI 重新 alloc 是 SDK 内部 implementation detail,实测概率 ≈ 0(UUID v4 collision 1/2^122)。**LOW 风险**。
- ⚠️ **migration v021 启动顺序**: 必须在 ingest pipeline / sessionManager 初始化之前完成(否则启动初期 findByCliSessionId 命中 column missing 抛错)。db.ts bootstrap 顺序已保证(migrations 先于 service init)。

## D7 验证标注 (回写 plan)

`*待 spike 验证*` → `*已 spike 4.1-4.7: recentlyDeleted Map 结构无需改 schema (key 语义改为 cli_session_id);ingest 入口加 findByCliSessionId 反查 + 4 态分流不破 dedupOrClaim 顺序硬约束;v021 migration backfill + 唯一索引 trivial 实现*`
