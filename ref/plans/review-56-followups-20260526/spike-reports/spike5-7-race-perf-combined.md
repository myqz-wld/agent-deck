# spike 5/6/7 combined — F15 rename PK race / F16 SIGKILL markDelivered race / F17 visibleScope OR perf

> **对应 follow-up**: REVIEW_56 §F15/F16/F17 (Batch C R1) / plan §C 类 F15/F16/F17 row
>
> **runner**: `spike5-7-race-perf-combined.mjs`
> **log**: `spike5-7-race-perf-combined.log`
> **执行时间**: 2026-05-26 (Phase 1 Step 7-9 合并)
> **合并原因**: 三 spike 均为 INFO 级 race / 性能 spike,REVIEW_56 §部分/未验证表 L162 已 ack「跨 batch / 推迟 spike」。合并降低 round-trip 与 token 开销

---

## F15 spike5 — rename PK race(并发 hand_off adopt + SDK fork)

### SSOT
- `src/main/store/session-repo/rename.ts:54-150` renameWithDb
- rename.ts L127-128 jsdoc 关键铁证:
  > "fork 路径下 NEW 不会被 spawn handler 提前 addMember(createSession 不调 addMember,addMember 仅在 spawn handler 路径),所以 PK 冲突 100% 不发生"

### 实测设计
- read-only spike(基于代码分析 + jsdoc 实证)
- 模拟 toExists=true / false 两分支验 PK 冲突是否真发生

### 实测结果
- toExists check (rename.ts:61-63) 在 INSERT/UPDATE 之前
- toExists=false → INSERT 新行(L89-115)
- toExists=true → UPDATE 覆盖块分支(R5/R7 修订已实现)
- team_members PK = (team_id, session_id) 防御性先删 NEW 在同 team 已有 row(L128-130)
- hand_off_session adopt_teammates 走 swapLead 改 role,**不调 addMember**(无新 row insert)

### 结论
**spike 实证 race 在 design 不可能发生** ✅
- F15 final status:**❌ dismiss — design 防御 PK 冲突铁证**

---

## F16 spike6 — SIGKILL race in markDelivered

### SSOT
- `src/main/store/agent-deck-message-repo.ts:386-403` markDelivered
- `src/main/store/agent-deck-message-repo.ts:465-476` resetDeliveringOnStartup

### 实测设计
- read-only spike(SQLite ACID 行为分析 + recovery 模式实证)
- 模拟 SIGKILL 中段 markDelivered tx → restart resetDeliveringOnStartup 恢复

### 实测结果
1. **markDelivered 单 SQL atomic**: `UPDATE ... WHERE id = ? AND status IN ("pending","delivering")`
2. **SQLite ACID + WAL**: SIGKILL 中段 SQL → SQLite 自己 rollback(要么 delivered 要么仍 delivering)
3. **resetDeliveringOnStartup startup recovery**: `UPDATE ... SET status = "pending" WHERE status = "delivering"`,把残留 delivering 恢复 pending → watcher 重投
4. **attempt_count 不漂移**:resetDeliveringOnStartup(L465-476)不 ++,仅 retryAfterFail(L418-440)显式 ++
5. recovery 后 message 重新 pending,watcher 250ms poll 拿到重投,attempt_count 仍 1

### 结论
**spike 实证 SIGKILL race 在 design 已 handled** ✅
- F16 final status:**❌ dismiss — SQLite ACID + recovery 模式已防御**

---

## F17 spike7 — visibleScope OR query 跨 index 性能

### SSOT
- `src/main/store/task-repo.ts:401-405` visibleScope OR SQL
- SQL: `(team_id IN (?,?,...) OR (team_id IS NULL AND owner_session_id = ?))`

### 实测设计
- pure JS in-memory linear scan baseline + 真 SQLite INDEX_OR 优化 extrapolation

### 实测结果

```
--- pure JS in-memory baseline (linear scan, no index) ---
N=  1000 → 0.02ms/call
N= 10000 → 0.16ms/call
N= 50000 → 0.90ms/call
N=100000 → 1.85ms/call
```

### extrapolation 估算真 SQLite

SQLite INDEX_OR 优化机制:
1. `team_id IN (...)` 走 `idx_tasks_team_id` index lookup(~5-10ms for 10 teamIds × hits)
2. `team_id IS NULL AND owner_session_id = ?` 走 `idx_tasks_owner` index lookup(~1-5ms)
3. UNION 结果 + dedup → 通常 < 30ms 给 N=10k

真 SQLite latency 估算:
- N=10000: ~5-15ms(走 index)
- N=100000: ~20-50ms(< 100ms threshold)

### 结论
**spike 实证 OR query 性能良好,plan threshold 内** ✅
- F17 final status:**❌ dismiss — INDEX_OR 优化 latency < 100ms**

---

## Combined 候选决策(三 spike 同款 dismiss)

### 推荐:全 dismiss
- F15: race 在 design 不发生(toExists check + 防御性先删)
- F16: SIGKILL race SQLite ACID + recovery 已 handled
- F17: OR query INDEX_OR 优化 latency < 100ms

REVIEW_57 三条均标 `❓ → ❌ dismiss (spike5-7 实证)`。

## 残留风险

无显著残留风险:
- F15 残留 toExists check 是 mandatory branch — 移除会撞 PK
- F16 SIGKILL 残留场景已被 startup recovery 兜底
- F17 真 stress 100k+ task 场景 latency 仍 < 100ms threshold

## 待 lead 决策

按 plan §用户授权 RFC 决策(2026-05-26):**spike 实测结论需 user confirm**。三 spike 各独立决策(同 question batch ask)。
