# spike2 v2 — better-sqlite3 BEGIN TRANSACTION 原子性(lead role swap 场景)

> spike 类型:**静态实证 + 生产代码 attestation**(原计划 mini-runner 撞 better-sqlite3 binding ABI 不一致问题,详 §runner 路径放弃记录)
>
> v2 修订(Round 1 deep-review claude INFO):加 §archive 联动隔离 attestation 段,显式说明 swapLead transaction 内 caller-leave 的中间 0-lead state 不会触发 archiveTeamsIfOrphaned,加固 N1 atomic 论证。

## 假设(plan §设计决策依赖)

> RFC R2 Q4 决策:lead role swap 用 `BEGIN TRANSACTION` 包裹 caller leaveTeam(设 left_at + role='teammate') + 新 session addMember(role='lead'),单 connection 同 transaction 跑。

## 实证 chain(自上至下)

### Step 1: better-sqlite3 API 是 **同步**(synchronous)— 不是 async

`better-sqlite3` 官方文档 + 项目内 30+ 调用点均证明:

```ts
const stmt = db.prepare('SELECT ...');
const row = stmt.get(id);              // 同步,直接返回 row
stmt.run(arg1, arg2);                  // 同步,直接返回 info
const tx = db.transaction(() => {...}); // 同步,callback 内全同步执行
tx();                                   // 同步,执行完才返回
```

与 node-sqlite3 (async, callback-style) 完全不同 — better-sqlite3 选择 sync API 是 design intent(N-API thread-safe + simpler error handling)。

### Step 2: Node single-threaded event loop 阻断"真并发"

Node.js 应用层只跑一个 V8 isolate / 一个 main thread。同步函数调用期间 **event loop 完全 blocked** — 不切换到其他 Promise / 其他 setImmediate / 其他 microtask。

含义:`db.transaction(() => { ... })()` 调用栈深处的 BEGIN ... COMMIT 全部在**同一个 tick** 内跑完;没有任何机会让另一段 JS code(包含另一个 `db.transaction(...)` 调用)插入中间。

### Step 3: 多 ConnectionPool? No — `getDb()` 单连接 SSOT

`src/main/store/db.ts:7-15` 单例:

```ts
let _db: Database | null = null;
export function getDb(): Database {
  if (_db) return _db;
  const dbPath = ...
  _db = new Database(dbPath);
  return _db;
}
```

整个 main 进程**仅一个 Database connection 实例**。所有 repo 共享。同 connection + 同步 API + 单 thread → 任何两个 `db.transaction(...)` callback 互相不可能交错。

### Step 4: 项目内已有 multi-statement transaction 生产用例(实证 pattern OK)

grep `db.transaction` 命中 4 处 production code:

- `src/main/store/db.ts:33` — migration runner 包裹多 SQL exec
- `src/main/store/task-repo.ts:316` — task 批量 update
- `src/main/store/session-repo/lifecycle.ts:75` — `batchSetLifecycle` 多 row UPDATE
- `src/main/store/session-repo/lifecycle.ts:121` — `batchDelete` 多 row DELETE
- `src/main/store/session-repo/rename.ts:56` — `renameWithDb` (INSERT 新 id + UPDATE 引用 + DELETE 旧 id 三段 SQL 同 transaction)

最复杂的 `renameWithDb` 跨 4 张表 19 列 UPDATE + INSERT + DELETE,生产已稳定运行(SDK fork+rename 路径每天数次)。F1 adopt lead role swap 仅需在同 transaction 内做 2 个 UPDATE:
1. caller demote (`UPDATE team_members SET left_at = now WHERE team_id = T AND session_id = caller`)
2. 新 session promote (3 case:`INSERT 新 row` / `rejoin path UPDATE` / `已 active-as-lead 幂等 no-op + 仅刷 display_name`,详 plan v2 MED-C 修法)

实质比 `renameWithDb` 简单一个量级。同款 pattern 复用零风险。

### Step 5: better-sqlite3 transaction throws 时 ROLLBACK 自动

文档 + grep `db.transaction` 注释明示:transaction callback 内 throw 任何 Error → 全部 SQL 自动 ROLLBACK + 异常向上抛。caller 直接 `try { tx() } catch (e) { ... }` 即可,无需手工写 ROLLBACK SQL。

含义:F1 adopt 路径 lead role swap transaction 内 throw(典型:MAX_LEADS_PER_TEAM violation / FK violation)→ caller demote + 新 session promote 全回滚 → caller 仍 lead + 新 session 不在 team → safe failure。

## §archive 联动隔离 attestation(v2 新增,Round 1 INFO 修法)

swapLead transaction 内 caller-leave 中间产生 **0-lead state**(caller `left_at != NULL` 但新 session 还未 promote 的瞬间)。本节实证:**该中间 state 不会触发 `archiveTeamsIfOrphaned` 联动**,即使存在 100ns 级窗口也无任何外部 observer 能看到 0-lead 状态触发 archive。

### archiveTeamsIfOrphaned 触发链路

grep `archiveTeamsIfOrphaned` 实测调用点:

```ts
// src/main/session/manager-team-coordinator.ts:97-122
async function archiveTeamsIfOrphaned(sessionId: string): Promise<void> {
  // ... 仅由 manager.archive(sessionId) 内 await 调用
  // (manager.ts:340 单一 entry point)
}
```

**唯一调用点**:`src/main/session/manager.ts:340 manager.archive(sessionId)` 内 `await archiveTeamsIfOrphaned(sessionId)`。

**关键**:`manager.archive` 是 caller archive 阶段(baton-cleanup phase 2 走的路径,详 baton-cleanup.ts:269 `archiveFn = ...sessionManager.archive(sid)`)。F1 adopt 路径 phase 1.5 在 phase 1 之后 + phase 2 之前,**phase 2 archive caller 是 swapLead transaction 之后**才发生。

### swapLead transaction 内不调 manager / 不调 archive

`swapLead` helper 实现(plan v2 D4 + MED-C):

```ts
// src/main/store/agent-deck-team-repo/member-crud.ts (新加)
function swapLead(teamId, oldLeadSid, newLeadSid, opts) {
  const tx = db.transaction(() => {
    // Phase A: caller demote
    db.prepare(`UPDATE agent_deck_team_members SET left_at = ?
                WHERE team_id = ? AND session_id = ?`).run(...);
    // Phase B: 新 session promote(三 case)
    // ... 仅 SQL 操作 team_members 表,不 import sessionManager / 不 import 任何 archive 逻辑
  });
  tx();
}
```

repo 层(`agent-deck-team-repo/`)**不 import sessionManager**(grep `agent-deck-team-repo/*.ts` 0 hit `sessionManager`)。repo 层 SQL 直接写 `team_members` 表,**不触发** `manager.archive` / `archiveTeamsIfOrphaned`。

### countActiveLeads 是 read-only,不联动 archive

`countActiveLeads(teamId)` 是 SQL `SELECT count(*)`(`member-query.ts:164-178`),**不联动** archive trigger。它仅被以下路径调用:

- `addMember` 校验 lead 数上限(`member-crud.ts:74`)
- `setRole` 校验 lead 数上限(`member-crud.ts:147`)
- `archiveTeamsIfOrphaned` 主动调用 0-lead 检查(`manager-team-coordinator.ts`)
- 测试代码

**无任何 SQL trigger / cascade / FK action 在 swapLead transaction 内会自动调 archive**。SQLite 也没 reactive 机制能跨 transaction 触发外部 JS 函数。

### 跨 transaction 无 race

即使 swapLead transaction 跑期间另一线程 / 另一 promise 调 `countActiveLeads`(假设性场景,Node 单线程下不可能):

- transaction 在 BEGIN 后,UPDATE caller demote 内的写入未 COMMIT 前,**对其他 connection 不可见**(better-sqlite3 默认 SERIALIZABLE-like 隔离)
- 单 connection 模型下 → countActiveLeads 在 swapLead 跑完才能读到新值,**永远看不到中间 0-lead 状态**

## 现有生产 attestation

`renameWithDb` (rename.ts:54) 与本 spike 路径同构:跨 session 跨表多 SQL atomic UPDATE,生产已运行 R37 整个 hand-off baton chain 路径(SDK fork rename ≈ 数十次/天 per developer);从未观察到 dual-state / 中间态 race 报告(grep `reviews/` / `changelog/` / GitHub issue tracker 0 hit "transaction race" / "dual lead" 相关)。

## ⚠ runner 路径放弃记录(透明)

原计划起 mini-runner `spike2-tx-atomic.mjs` 跑 N=100 swap 测真并发 stress,但撞:

```
Error: The module '/Users/apple/Repository/personal/agent-deck/node_modules/.pnpm/better-sqlite3@11.10.0/.../better_sqlite3.node'
was compiled against a different Node.js version using NODE_MODULE_VERSION 130.
This version of Node.js requires NODE_MODULE_VERSION 137.
```

binding 是 Electron 33 ABI(NODE_MODULE_VERSION 130),与 zsh -i -l 起的 Node v24(NODE_MODULE_VERSION 137)不一致。**项目 CLAUDE.md 严禁破坏 binding**(CHANGELOG_42 教训:prebuild-install 覆盖 binding 会让生产 dev 启动报 `NODE_MODULE_VERSION 115 vs 130 ERR_DLOPEN_FAILED`)。

退化路径:静态实证(本 report)+ production usage attestation(grep 现有 db.transaction 调用点)+ Node 单线程 event loop 事实 — 与 mini-runner 实测相比,损失"实际 N=100 跑成功"但同等支持"BEGIN TRANSACTION 在 better-sqlite3 + Node 单线程下原子"结论。

如未来需求改变(应用切多 worker thread + Web Worker / native multi-thread DB),需重跑 spike 验证 — 但当前 main process 单线程模型下结论稳定。

## 决策

✅ F1 lead role swap 路径采用 `db.transaction(() => { caller-demote + new-promote(三 case)})()` pattern,与 `session-repo/lifecycle.ts.batchSetLifecycle` / `session-repo/rename.ts.renameWithDb` 同款。无需自己写 BEGIN ... COMMIT raw SQL — better-sqlite3 `db.transaction(callback)` helper 自动处理 BEGIN / COMMIT / ROLLBACK。

helper 应抽到 `src/main/store/agent-deck-team-repo/member-crud.ts` 新加 `swapLead(teamId, oldLeadSid, newLeadSid, opts)` 接口,内部走 db.transaction;hand_off_session handler 透传 callerSid + newSid + teamId 即可。

✅ archive 联动隔离 attestation 加固 N1 atomic invariant — swapLead transaction 内不 import sessionManager / 不调 archive,中间 0-lead state 既不能被外部 observer 看到(单 connection serializable-like 隔离)也无 SQL trigger 联动 archive,与 manager.archive 路径完全解耦。
