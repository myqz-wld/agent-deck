---
review_id: 110
reviewed_at: 2026-06-02
expired: false
skipped_expired:
---

# REVIEW_110: shutdown race — closeDb 后 adapter 尾包走 ingest→getDb() throw unhandledRejection 噪音

## 触发场景

issue tracker（log-triage Batch 9 / REVIEW_107 发现）上报的退出期竞争：应用日志 `~/Library/Logs/Agent Deck/main-2026-06-01.log:1802` 在 `universal-message-watcher stopped` 之后出现 unhandledRejection：

```
Unhandled rejection Error: Database not initialized. Call initDb() first.
  at getDb (build/main/index.js:485)
  at Object.findByCliSessionId (build/main/index.js:2746)
  at SessionManagerClass.ingest (build/main/index.js:3933)
  at Object.emit (build/main/index.js:18031)
```

**根因**：before-quit cleanup 的 `finally` 块跑 `closeDb()`（REVIEW_104 MED-B 为 WAL checkpoint 不变量把 closeDb 提前到 finally 无条件执行）后 `dbInstance=null`，但 adapter in-flight 尾包（`adapterRegistry.shutdownAll()` drain 完成前已 emit 的事件 / 迟到 SDK 流尾包）仍会走 emit thunk（`bootstrap-infra.ts:131`）→ `sessionManager.ingest()` → `findByCliSessionId`（ingest 第一处 DB 访问）→ `getDb()` → `db.ts:52` throw → 在 adapter async for-await 流上变 unhandledRejection。

**严重度（low / 非 crash）**：`logger.ts:84` 设计 unhandledRejection 仅落盘不强退（避免 stray rejection 杀进程）→ 非 crash 非数据丢失，是**退出期 log 噪音**。4 天日志仅 1 次，纯 shutdown 竞争窗口。REVIEW_104 MED-C 已为 `session-upserted` listener 加 try/catch 防同款 getDb() throw，但只覆盖那一条 listener，**ingest 自身 DB 访问路径未加 shutdown guard = 不对称裂口**。

## 方法

**异构对抗配对**（走 `agent-deck:simple-review` SKILL，inline §三态裁决 + §Finding 输出契约）：
- reviewer-claude：claude-code adapter，Opus 4.7 default thinking；`647e1380`
- reviewer-codex：codex-cli adapter，gpt-5.5 xhigh；`019e880f`
- teamId `47aefa1d-2520-44d4-a868-13a3c88cb138`（已 shutdown）

**范围**：3 文件生产改动（~40 行）+ 2 测试文件

```text
src/main/store/db.ts                 — dbClosed flag + isDbClosed() helper + closeDb try/finally
src/main/session/manager.ts          — ingest() 入口 isDbClosed() guard
src/main/index/bootstrap-infra.ts    — emit sink isDbClosed() guard（护 ingest + routeEventToNotification 两消费者）
src/main/store/__tests__/db-shutdown-guard.test.ts        — 新增（init-never vs closed 区分）
src/main/session/__tests__/manager-ingest.test.ts         — 新增 3 guard test
```

**机器可读范围**：

```review-scope
src/main/index/bootstrap-infra.ts
src/main/session/manager.ts
src/main/store/db.ts
```

**约束**：focus 5 维度（init-never vs closed 区分 / 与 REVIEW_104 before-quit WAL ordering 交互 / guard 放置完整性 / closeDb 抛错状态正确性 / 测试 mock + 回归哨兵有效性）。

## 三态裁决结果

### ✅ 真问题（双方独立提出 / 一方提出且现场实践验证成立）

| # | 严重度 | 文件:行号 | 问题 | A(claude) | B(codex) | 验证手段 |
|---|---|---|---|---|---|---|
| MED-1 | MED | manager-ingest.test.ts:584-586（旧） | `getDb` 回归哨兵 vacuous + 注释 false-claim：mock 的 `findByCliSessionId` 纯内存遍历不路由 `getDb`，挪 guard 也恒 0 次 → `not.toHaveBeenCalled()` 恒真 | MED（实测「挪 guard 后 16/16 仍过」证伪旧哨兵 + 删 guard 后 behavioral 断言才抓到） | LOW（读 mock + core-crud trace 确认纯内存不触 getDb） | **双方独立** + claude 实测复现：移 guard 到 findByCliSessionId 后 → 旧哨兵不 fail；新哨兵（spy findByCliSessionId）→ fail |
| LOW-1 | LOW | db.ts:92-96（旧） | `closeDb()` 若 `dbInstance.close()` 抛错（WAL checkpoint 失败），`dbInstance=null` 被跳过 → `dbClosed=true + dbInstance≠null` 中间态；initDb `if(dbInstance)return` 在 `dbClosed=false` reset 之前 → 未来「关闭后重开」返 broken instance + 永卡 isDbClosed()=true | LOW（读码 trace closeDb + initDb 控制流；今天无 reopen 路径触发故 LOW） | — | claude 单方 + lead 复核；探针 mock close() throw 实测 finally 清空后 initDb 返新 instance + isDbClosed reset |

### ❌ 反驳（被对抗或现场核实证伪）

| 报告方 | 报项 | 反驳依据（验证手段 + 结论） |
|---|---|---|
| —（无） | — | 本轮无 finding 被反驳 |

### ❓ 部分 / 未验证

| 现场 | A 视角 | B 视角 | 是否已验证 | 结论 |
|---|---|---|---|---|
| focus #1 init-never vs closed | 未发现任何路径把 init-never 误判 closed，设计成立 | dbClosed 仅 closeDb 置 true、module 初值 false，启动期 getDb 照常 loud throw | 双方独立读码验证 | ✅ clean，区分成立 |
| focus #2 与 REVIEW_104 ordering | closeDb 幂等 + finally 无条件跑不变量未受 flag 影响 + EADDRINUSE 不双跑 | 同结论 | 双方读码 | ✅ clean，无冲突 |
| focus #3 guard 完整性 | token-usage 早返分支已被 guard 挡（guard 在 :331，token-usage 在 :370 后）；summarizer/scheduler 在途 getDb 属 scope 外 + 各有 try/catch | emit sink 挡住 notification 路径 sessionManager.get | 双方读码 + lead trace | ✅ clean（INFO：scope 外路径各有保护，本 plan 不处理记录在案）|
| focus #4 closeDb 抛错状态 | 中间态存在但今天无触发（→ LOW-1 已修） | flag 先置 true 与「拒绝后续写」语义一致 | 见 LOW-1 | ✅ 已修 |

## 修复（commit 见 worktree shutdown-ingest-db-guard-20260602）

### MED
1. **db.ts** — 新增 module-level `dbClosed` flag + `isDbClosed()` export：`closeDb()` 置 true（先于 close），`initDb()` 复位 false。**区分 init-never（dbClosed=false → getDb 仍 loud throw 不掩盖启动 bug）vs closed（dbClosed=true → caller drop）**——issue 核心约束。
2. **manager.ts ingest() 入口第一行** `if (isDbClosed()) return;`（在 findByCliSessionId 之前）—— 主修法，护所有 ingest caller（adapter emit / mcp task / team-permission）。
3. **bootstrap-infra.ts emit sink 顶端** `if (isDbClosed()) return;` —— 同时护 `routeEventToNotification`（对 finished/waiting 事件 sessionManager.get→getDb，虽 event-router 自身 try/catch 兜住但产噪音 log），消除 REVIEW_104 只补一条 listener 的不对称裂口。
4. **MED-1 测试修法**（review 采纳 option ②）：manager-ingest.test.ts 删 vacuous `getDb` 哨兵 + false-claim 注释，改 spy `sessionRepo.findByCliSessionId`（ingest 第一处真 repo 访问）：closed case 断言 0 次 / not-closed 对偶 case 断言 ≥1 次 + 新增 closed token-usage case。**实测哨兵有效**：临时挪 guard 到 findByCliSessionId 后 → 2 case FAIL，恢复后全过。

### LOW
1. **db.ts closeDb()** — `dbInstance = null` 放进 `try { dbInstance.close() } finally { dbInstance = null }`，消除 close() 抛错中间态，让防御性 reopen robust（LOW-1）。

## 收口

**单次异构对抗 + 一轮 fix（Round 2 双方 both-agree conclude），0 HIGH 0 真 MED 0 真 LOW 残留**。
- reviewer-codex R2：spy findByCliSessionId 锁住 guard 位置不变量 + token-usage case 锁不被挪到早返后 + not-closed 对偶证明 spy 非失效断言；无新遗漏，同意 conclude。
- reviewer-claude R2：两条 fix 独立实测复现（MED：挪 guard → 2 case FAIL；LOW：探针 mock close() throw → finally 清空 → initDb 返新 instance + isDbClosed reset）；0 HIGH/MED/LOW 残留，同意 conclude；acknowledge focus #3 token-usage 子问 clean。

**验证**：dual typecheck（tsconfig.node + tsconfig.web）双绿；全量 vitest **1742 passed | 236 skipped** 零回归（+6 新测试：3 db-shutdown-guard + 3 manager-ingest guard）。

## 遗留 follow-up（非阻塞）

- **summarizer / scheduler 在途 getDb**（INFO，scope 外）：summarizer 在途 LLM `.then(()=>summaryRepo.insert)` 在 closeDb 后 10s race 窗口内可 resolve → getDb throw，但被同链 `.catch` 兜成 warn log（非 unhandledRejection、非 crash）。scheduler 三件都在 closeDb 前 `.stop()`，在途 tick 风险更低。均属本次「adapter 尾包」scope 之外、各有保护，不要求本次处理，仅记录完整性。

## 关联

- REVIEW_104（before-quit WAL 不变量 + session-upserted listener try/catch）—— 本次补齐 ingest 自身 + emit sink 的对称 guard
- REVIEW_107（Batch 9 log triage 发现本 issue）
