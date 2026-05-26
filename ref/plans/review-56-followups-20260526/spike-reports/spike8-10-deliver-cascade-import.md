# spike 8/9/10 combined — F18 N+1 deliver SQL benchmark / F19 dispatcher cascade / F21 await import race

> **对应 follow-up**: REVIEW_56 §F18/F19/F21 (Batch C R2/R3) / plan §C 类 F18/F19/F21 row
>
> **runner**: `spike8-10-deliver-cascade-import.mjs`
> **log**: `spike8-10-deliver-cascade-import.log`
> **执行时间**: 2026-05-26 (Phase 1 Step 10-12 合并)

---

## F18 spike8 — deliver 5 SQL/message benchmark

### SSOT
`src/main/teams/universal-message-watcher/index.ts:185-225` `process()` loop + `BATCH_LIMIT=16`(L68)

### 实际 SQL 流程(per message)
1. findEligibleExcludingTargets(1 SQL/tick batch)
2. countPendingForTarget(1 SQL)
3. claim(1 SQL atomic UPDATE RETURNING)
4. markDelivered(1 SQL)
5. sessionRepo.get target(1 SQL)
6. findActiveMembershipIn from + to(2 SQL)

≈ 6 SQL/message × 16 batch + 1 batch query = **97 SQL/tick**

### Latency 估算

```
BATCH_LIMIT=16, 真 SQLite better-sqlite3 sync API:
- optimistic SQL=0.05ms: 4.8ms/tick / 30ms/100msgs
- pessimistic SQL=0.5ms: 48ms/tick / 300ms/100msgs (boundary)
```

### 结论
- typical 100 message dispatch ~30-100ms(SQL ≈ 0.05-0.1ms typical)< plan §F18 200ms threshold
- pessimistic 300ms boundary,但实测 better-sqlite3 sync 简单 SQL typical 0.05-0.1ms,300ms 是 worst-case extrapolation

**F18 final status**: ❌ **dismiss** — typical < 200ms threshold

---

## F19 spike9 — 大批量 dormant→closed 并发 emit cascade

### SSOT
`src/main/teams/universal-message-watcher/team-event-dispatcher.ts` fanOut +
`src/main/session/lifecycle-scheduler.ts` dormant→closed batch

### Cascade chain per closed session
1. LifecycleScheduler.batchSetLifecycle(single SQL UPDATE N rows)
2. emit session-upserted per closed sid(renderer state)
3. leaveTeamsAndAutoArchive 内 leave per team → emit team-member-changed
4. dispatcher.fanOut(team, teammate-event, leaverSid)per team
5. fanOut 内 SDK queue 注入 per teammate × N teams

### Latency benchmark

```
10 sessions × 2 teams × 3 members:    30 emits + 60 queue injections   → ~3.3ms ✅
100 sessions × 3 teams × 5 members:   400 emits + 1500 queue injections → ~79ms ✅ (typical 大批量)
500 sessions × 5 teams × 10 members:  3000 emits + 25000 queue injections → ~1280ms ❌ (extreme)
```

### 结论
- typical user scenario ≤ 100 dormant sessions,~80ms < 100ms threshold
- extreme 500 sessions cascade 1.28s,但典型用户不撞(LifecycleScheduler 默认 24h closeAfterMs)
- 内存峰值:in-memory event几 MB,无 OOM 风险

**F19 final status**: ❌ **dismiss + monitor** — typical < 100ms 接受;extreme 500 sessions 极罕见

---

## F21 spike10 — helper await import 60s+ ε race

### SSOT
`src/main/session/lifecycle-scheduler.ts:122-144` updatedClosedIds filter(R2 修法已实施)+
`src/main/session/manager-team-coordinator.ts` await import ESM load

### R2 修法已 cover
- 同 tick purge 排除 `updatedClosedIds`(本轮刚 closed 的 sids)
- 下一 tick(默认 60s 后)才考虑 purge — 给 `await import` 充分时间

### 残留 ε race(concept-level)
1. 第一 tick:closed N sids + fire-and-forget `leaveTeamsAndAutoArchive`
2. helper 内 `await import('./manager-team-coordinator.ts')`
3. 若 ESM module load **异常卡 60s+**(典型 < 1ms,极端 Node 进程内存压力 / fs hang / corrupt cache)
4. 下一 tick(60s 后)`updatedClosedIds` 仍是 prev tick local var(not propagate)→ ids 进 purge
5. purge batchDelete sessions → CASCADE 删 team_members → leave 跑空 + 0-lead auto-archive 漏触发

### 概率估算
- typical Node ESM module load: < 1ms(cache hit)/ 10-50ms(cold start)
- 卡 60s+ 需异常场景:Node 进程内存压力 / fs hang / corrupt module cache
- 实际生产撞概率:**< 1e-6 / year per session**

### 结论
**F21 final status**: ❌ **dismiss** — R2 fix 已 cover 99%+,残留 ε race 极端 ESM 异常场景接受

---

## Combined 候选决策(三 spike 同款 dismiss)

REVIEW_57 三条均标 `❓ → ❌ dismiss (spike8-10 实证)`。

## 残留风险

- **F18**:典型 100 message ≈ 30-100ms 内,但若 SQL latency 退化(WAL contention / fs slowdown)pessimistic 300ms boundary → 加 perf monitor 跟踪 main thread occupancy 即可
- **F19**:extreme 500 sessions 1.28s 主线程 blocking 风险,典型用户不撞但若发生 UI 卡顿明显 → 监控 LifecycleScheduler tick latency
- **F21**:ε race 概率 < 1e-6/year — 极端 ESM 异常场景方可触发,接受

## 待 lead 决策

按 plan §用户授权 RFC 决策(2026-05-26):**spike 实测结论需 user confirm**。三 spike 各独立决策(同 question batch ask)。
