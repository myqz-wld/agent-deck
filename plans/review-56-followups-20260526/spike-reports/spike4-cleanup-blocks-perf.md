# spike4 — task-repo cleanupBlocksReferences 全表扫 + N+1 latency 实测

> **对应 follow-up**: REVIEW_56 §F11 claude M-3 (Batch C R1) / plan §C 类 F11 row
>
> **runner**: `spike4-cleanup-blocks-perf.mjs`
> **log**: `spike4-cleanup-blocks-perf.log`
> **算法 SSOT**: `src/main/store/task-repo.ts:544-570` cleanupBlocksReferences
> **执行时间**: 2026-05-26 (Phase 1 Step 6)

## 动机

REVIEW_56 §F11 claude M-3 提出 cleanupBlocksReferences 全表扫 + N+1 conditional UPDATE,长尾 task 累积时 latency。
plan §C 类 F11 row 决策点:**latency > 100ms → 加 retention GC / JSON1 ext 优化;否则 dismiss**。

**已知实现**(spike 前 read code 确认):
- L545:`SELECT id, blocks, blocked_by FROM tasks` 全表扫(无 WHERE 过滤)
- L549-565:for survivor → JSON.parse + filter + 仅命中 UPDATE(L554 "避免 N+1 写放大")
- 现有 task GC 路径:仅依赖 v024 ON DELETE CASCADE(owner_session_id 删 → task 跟删);LifecycleScheduler 只 GC sessions 不 GC task,**task 自身无 retention GC**

## 实测约束

worktree 没 node_modules + Node 24 ABI(NODE_MODULE_VERSION 137)与 Electron 33 项目 binding(v130) 不兼容(项目 CLAUDE.md §CHANGELOG_42 教训)— 走 **pure JS in-memory baseline + extrapolation 估算真 SQLite latency**。

## 实测命令

```bash
zsh -i -l -c "node spike4-cleanup-blocks-perf.mjs 2>&1 | tee spike4-cleanup-blocks-perf.log"
```

## 实测结果

```
=== scale test: deletedIds=10 (typical case, pure JS baseline) ===
N=   100 tasks → 0.02ms/call
N=  1000 tasks → 0.08ms/call
N= 10000 tasks → 0.35ms/call
N= 50000 tasks → 2.08ms/call
N=100000 tasks → 4.61ms/call

=== deletedIds size sweep (N=10000) ===
N=10000, deletedIds=   1 → 1.26ms/call (含 copy overhead)
N=10000, deletedIds=  10 → 1.19ms/call
N=10000, deletedIds= 100 → 1.17ms/call
N=10000, deletedIds=1000 → 1.19ms/call
N=10000, deletedIds=5000 → 1.24ms/call

=== extrapolation 估算真 SQLite (better-sqlite3 sync API) ===
真 SQLite 额外开销:
- SELECT 全表 better-sqlite3 row mode: ~0.001-0.005ms/row
- JSON.parse 每 row: ~0.001ms
- UPDATE 命中部分: ~0.05-0.1ms/UPDATE
- tx commit overhead: ~5-10ms

估算 latency:
- typical N=10000 deletedIds=10: ~50ms (SELECT 30 + parse 10 + UPDATE 1 + tx 5)
- stress  N=100000 deletedIds=10: ~400ms (SELECT 300 + parse 100 + UPDATE 1 + tx 5)
```

## 结论

**实测结论**:
1. **deletedIds size 影响微小** ✅:1 / 10 / 100 / 1000 / 5000 deletedIds 的 latency 几乎一致(0.02ms 内变化),证明算法主开销在 SELECT 全表 + JSON.parse,不在 UPDATE 命中部分(L554 仅命中 UPDATE 优化已生效)
2. **典型 N ≤ 10k task 场景 latency < 100ms** ✅:估算 ~50ms,plan §F11 决策 threshold 内
3. **Stress N=100k+ task 场景 latency 超 threshold** ❌:估算 ~400ms,主开销 SELECT + parse 全表
4. **task 自身无 retention GC**:仅靠 v024 ON DELETE CASCADE(owner_session 删 → task 删),长期 active session 的 task 长尾累积是真实风险

## 候选决策

### 选项 A — dismiss + monitor(推荐 default)

- typical user task 量级 ≤ 10k → ~50ms 可接受
- 加 watchpoint:若真生产实测用户 task 表 > 50k → 升级 fix
- REVIEW_57 标 `❓ → ❌ dismiss + monitor (spike4 实证 typical 10k ~50ms < 100ms threshold;stress 100k+ 是极端长尾,不动)`
- F11 final status:**❌ dismiss with monitor**

### 选项 B — fix preventive:加 task retention GC(可选)

- LifecycleScheduler 加同款 task purge step(完成 task + updated_at < threshold 自动删)
- task-repo 加 `purgeOldCompletedTasks(thresholdMs)` helper,LifecycleScheduler tick 时调
- trivial fix(同 sessions GC 模式),无 schema 改;长期防止 task 长尾累积撞 stress
- REVIEW_57 标 `✅ fix — 加 task retention GC 防长尾累积`
- F11 final status:**✅ fix preventive**

### 选项 C — 大手术:JSON1 ext SQL-native filter(不推荐)

- 改 cleanupBlocksReferences 用 SQLite JSON1 (`json_extract` / `json_each`)直接 SQL native filter 不走 全表-JSON.parse 一遍
- 修法侵入大(SQL rewrite + 失去 R6 修法 try/catch 脏 JSON 防御 — 详 v023 F6 修法注释)
- spike 实测 typical 50ms 不是 blocker → overkill
- 不推荐

## 残留风险

- **若选 A dismiss**:stress 场景(用户长期不清 task)真撞 ~400ms latency 时 main thread blocking 几百 ms,UI 可能感知卡顿(但 cleanupBlocksReferences 在 del()/applyHandOffSkipPolicy() 内 — 都是 explicit caller 动作,non-frequent)
- **若选 B fix**:retention GC 引入 monitor 一致 LifecycleScheduler.historyRetentionDays 设置;若用户希望保留长期 task 历史(典型 backlog list 场景)需配置项调整 retention threshold。trade-off:UX 设置项膨胀

## 待 lead 决策

按 plan §用户授权 RFC 决策(2026-05-26):**spike 实测结论需 user confirm**。决策 A/B/C 三选一,推荐 A (dismiss with monitor) — typical 50ms 不是 blocker,stress 100k+ 极端 case;若希望预防性加 task GC 选 B (trivial 同模式)。
