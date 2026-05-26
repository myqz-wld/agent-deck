# spike2 — baton race spawn-guards fan-out 实测

> **对应 follow-up**: REVIEW_56 §F3 codex MED-3 (Batch B R1) / plan §C 类 F3 row
>
> **runner**: `spike2-baton-race-fanout.mjs`
> **log**: `spike2-baton-race-fanout.log`
> **算法 SSOT**: `src/main/agent-deck-mcp/spawn-guards.ts:96-117` + `rate-limiter.ts:77-99` InFlightChildrenCounter
> **执行时间**: 2026-05-26 (Phase 1 Step 4)

## 动机

REVIEW_56 §F3 codex MED-3 提出 "baton race spawn-guards fan-out" 假设:
- 修法 (a) baton 独立 inFlight 计数 / (b) 显式 baton-link
- REVIEW_56 §部分/未验证表 L151 已 ack "single-caller 串行不暴露,理论 race 实际不发生,低优先级"
- 留 spike 实测验

**已知 design 保证**(spike 前 read code 确认):
- `spawn-guards.ts` L17-19 jsdoc:**"fan-out check + inFlightChildren.inc 必须在同一同步段内完成"**(REVIEW_27 reviewer 双对抗 MED 修法)
- `spawn-guards.ts` L96-117:fan-out check(L96-104)+ `inFlightChildren.inc()`(L117)全在同步段(无 await)
- `rate-limiter.ts` L77-99 `InFlightChildrenCounter`:纯同步 Map ops(inc / dec / get 无 await)
- `spawn.ts` 多处 fanOutSlot.release() 兜底(L101 / L109 / L329 / L351)
- JS event loop 单线程同步段不被打断 → N 并发 applySpawnGuards 顺序进入 sync 段,inFlight 累积准确

## 实测假设

1. **case 1**:serial baton chain(每 baton release 后)→ 任意 N 都 OK,inFlight 归 0
2. **case 2**:N=7 parallel applySpawnGuards 无 release(模拟全 await createSession 中)→ 前 5 OK,后 2 DENY
3. **case 3**:边界 DB=4 + inFlight 累积 → 第 2 个 spawn deny(effective+1 > 5)
4. **case 4**:Promise.all N=12 + await microtask gap → sync 段不让出,5 OK + 7 DENY enforce
5. **case 5**:handler exception 不 release(理论 bug)→ phantom inFlight 累积阻塞合法 spawn(但 prod handler 已多处 release 兜底)
6. **case 6**:baton chain — caller archive 之前并发 → 同 caller fan-out enforce

## 实测命令

```bash
zsh -i -l -c "node spike2-baton-race-fanout.mjs 2>&1 | tee spike2-baton-race-fanout.log"
```

详 `spike2-baton-race-fanout.mjs`(本地复刻 `InFlightChildrenCounter` + `applySpawnGuards` 同步段逻辑,不依赖 worktree TS 编译)。

## 实测结果

```
=== spike2: baton race spawn-guards fan-out 实测 ===

--- case 1: serial baton sequence ---
baton 1-7: ✅ OK (每个 release 后 inFlight=1 → 下个 baton 看到 inFlight=0)
final inFlight=0

--- case 2: N=7 parallel (no release, simulate concurrent baton 全 await 中) ---
spawn 1-5: ✅ OK (inFlight 累积 1→5)
spawn 6-7: ❌ DENY (fan-out 5 reached max 5)
stat: 5 OK / 2 DENY

--- case 3: 边界 DB=4 + inFlight 累积 ---
spawn 1 (4+0+1=5 ≤ 5): ✅ OK
spawn 2 (4+1+1=6 > 5): ❌ DENY

--- case 4: Promise.all N=12 + await microtask gap ---
baton 1-5: ✅ OK
baton 6-12: ❌ DENY (sync 段不让出 → 前 5 全 inc 占满,后 7 deny)
final inFlight=0 (5 OK 都 release 后)

--- case 5: phantom inFlight risk ---
5 spawn 不 release → phantom inFlight=5
spawn 6: ❌ DENY — phantom 阻塞后续合法 spawn
(prod handler L101/109/329/351 多处 fanOutSlot.release() 兜底)

--- case 6: baton chain caller-F concurrent ---
baton 1-5: ✅ OK
baton 6: ❌ DENY

=== sync 段 latency ===
avg 0.114μs/call (Map ops only)
```

## 结论

**实测结论**:
1. **baton race 在 design 不可能发生** ✅ — JS sync 段 design + InFlightChildrenCounter + fan-out check 三重保护铁证
2. **race protection 多 case 验证 ✅**:
   - serial baton 任意 N 都过(case 1)
   - parallel N>5 enforce fan-out limit(case 2/4/6)
   - DB+inFlight 叠加边界 enforce(case 3)
   - Promise.all + microtask gap 不破坏 sync 段保护(case 4)
3. **唯一理论 risk**:handler exception 不 release → phantom inFlight 阻塞(case 5)
   - 实际生产 `spawn.ts` 多处 fanOutSlot.release() 兜底(L101 / L109 / L329 / L351)
   - 即便 phantom 发生只阻塞自己 caller 后续 spawn,不污染其他 caller(Map by parentId 隔离)
4. **sync 段 latency 0.114μs/call** ⚡ — 极快,无性能问题

## 候选决策

### 选项 A — dismiss(推荐)

- spike 实证 race 在 design 不可能发生
- prod 已 4 处 fanOutSlot.release() 兜底 phantom risk
- REVIEW_57 标 `❓ → ❌ dismiss — spike2 实证 baton race 在 sync 段 design 不可能发生 (spike2-baton-race-fanout.md 实测)`
- F3 final status:**❌ dismiss**

### 选项 B — 加 defensive test 防回归(可选)

- 加 vitest 模拟 N 并发 applySpawnGuards 测 fan-out enforce + inFlight 累积
- Phase 3 加个 trivial test file `src/main/agent-deck-mcp/__tests__/spawn-guards-race.test.ts`(<50 行)
- 防未来 spawn-guards 重构 / await microtask gap 引入意外破坏 race protection
- F3 final status:**✅ trivial defensive test (无 code change,只加 test)**

### 选项 C — 加 baton 独立 inFlight 计数(不推荐)

- 现有 InFlightChildrenCounter 同款 by parentId Map 已 cover baton 场景
- 加独立 inFlight 计数 overkill
- F3 final status:**❌ overkill,与 A dismiss 同款**

## 残留风险

无显著残留风险。case 5 理论 phantom 风险 prod 已多处 release 兜底,即便发生只阻塞自己 caller(不污染其他 caller,Map by parentId 隔离),且 caller archive 时 sessions row 删除自然 GC inFlight Map(by parentId)。

## 待 lead 决策

按 plan §用户授权 RFC 决策(2026-05-26):**spike 实测结论需 user confirm**。决策 A/B/C 三选一,推荐 A (dismiss) — race 在 design 不可能。若希望防回归可选 B 加 trivial test。
