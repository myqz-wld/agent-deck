---
spike_id: spike1-sdk-interrupt
plan_id: deep-review-batch-a1-b-followup-r3-20260519
runner: spike1-sdk-interrupt-runner.mjs
sdk_version: 0.2.118
date: 2026-05-19
---

# Spike 1 — SDK query.interrupt() 边界行为实测

## 动机

H1 race 修法选项 (A) abort consume 的核心假设：在 setTimeout fallback fire 时调 `internal.query.interrupt()` 能让 `for await (msg of internal.query)` 抛错走 catch + finally，**不让** SDK 后续 emit 真实 first session_id frame 触发 consume L221 first-id 路径覆盖 fallbackId。

需实测的三边界（来自 RFC Q2 决策）：
1. **first id 未到达时**调 interrupt() —— SDK 是否仍 emit first id frame？
2. **first id 到达后立即**调 interrupt() —— SDK 是否仍 emit 后续 frame？
3. **interrupt() 调后**整体 stream 行为（resolve 时机 / 终止类型 / frame 总数）。

## 假设 vs 实证

| 假设 | 实证结果 | 状态 |
|---|---|---|
| 1. interrupt() 在 first id 之前调可阻止 SDK emit first id frame | **推翻** —— SDK 仍 emit first session_id frame（case A: t=2759ms） | ❌ 假设错 |
| 2. interrupt() 调后 SDK 立即停 emit 后续 frame | **推翻** —— SDK 一波 emit 完所有 7 个 frame（hook_started ×2 + hook_response ×2 + init + user + result） | ❌ 假设错 |
| 3. interrupt() resolve 时机 | **新发现** —— 在 SDK 回复一波 frame 之后才 resolve（不是立即） | ⚠️ 注意 |
| 4. interrupt() 让 result 类型变 error_during_execution | **确认** —— 替代 success，与 SDK 'subtype' 文档一致 | ✅ |

## 实测命令

```bash
# baseline (不 interrupt 看流自然完成)
zsh -i -l -c "node spike1-sdk-interrupt-runner.mjs ping"

# case A: interrupt @ ~50ms (first id 期望 ~2700ms 才到)
zsh -i -l -c "node spike1-sdk-interrupt-runner.mjs A"

# case B: interrupt 在 first id 到达 frame 同步路径上立即调
zsh -i -l -c "node spike1-sdk-interrupt-runner.mjs B"
```

## 实测结果

### baseline (case ping)

```
[t=     0ms] SPIKE START case=ping
[t=     7ms] query() returned q type=object
[t=  4446ms] frame #1 type=system subtype=hook_started sid=64481905
[t=  4446ms] ==> first session_id seen sid=64481905
[t=  4446ms] frame #2 type=system subtype=hook_started sid=64481905
[t=  4446ms] frame #3 type=system subtype=hook_response sid=64481905
[t=  4446ms] frame #4 type=system subtype=hook_response sid=64481905
[t=  4466ms] frame #5 type=system subtype=init sid=64481905
[t=  8237ms] frame #6 type=assistant sid=64481905
[t=  8321ms] frame #7 type=assistant sid=64481905
[t=  8396ms] frame #8 type=result subtype=success sid=64481905
```

正常完成：8 frames，first id 在 t=4446ms（hook_started frame 携带），result subtype=success @ t=8396ms。

### case A — interrupt() 在 first id **之前** 调

```
[t=     0ms] SPIKE START case=A
[t=     8ms] query() returned q type=object
[t=    59ms] -> interrupt() called (A: ~50ms before first id expected)
[t=  2759ms] frame #1 type=system subtype=hook_started sid=c5fe8982
[t=  2759ms] ==> first session_id seen sid=c5fe8982
[t=  2759ms] frame #2 type=system subtype=hook_started sid=c5fe8982
[t=  2759ms] frame #3 type=system subtype=hook_response sid=c5fe8982
[t=  2759ms] frame #4 type=system subtype=hook_response sid=c5fe8982
[t=  2764ms] <- interrupt() RESOLVED (A: ~50ms before first id expected)
[t=  2775ms] frame #5 type=system subtype=init sid=c5fe8982
[t=  2782ms] frame #6 type=user sid=c5fe8982
[t=  2782ms] frame #7 type=result subtype=error_during_execution sid=c5fe8982
```

**关键观察**：
- interrupt() @ t=59ms（first id 期望 ~2700ms 后到）
- SDK 仍 emit **7 个 frame**，first session_id 在 t=2759ms 第一个 hook_started 上
- interrupt() 在 t=2764ms RESOLVE（在 hook frames 之后）
- 后续 init + user + result(error_during_execution) 仍正常 emit

### case B — interrupt() 在 first id **之后** 立即调

```
[t=     0ms] SPIKE START case=B
[t=  4142ms] frame #1 type=system subtype=hook_started sid=e8a045d0
[t=  4142ms] ==> first session_id seen sid=e8a045d0
[t=  4142ms] -> interrupt() called (B: immediately after first id)
[t=  4142ms] frame #2 type=system subtype=hook_started sid=e8a045d0
[t=  4142ms] frame #3 type=system subtype=hook_response sid=e8a045d0
[t=  4142ms] frame #4 type=system subtype=hook_response sid=e8a045d0
[t=  4148ms] <- interrupt() RESOLVED (B: immediately after first id)
[t=  4158ms] frame #5 type=system subtype=init sid=e8a045d0
[t=  4164ms] frame #6 type=user sid=e8a045d0
[t=  4164ms] frame #7 type=result subtype=error_during_execution sid=e8a045d0
```

与 case A 结构完全一致 — frame 数 / 类型 / 顺序都相同。SDK 不区分 first-id 之前 / 之后调 interrupt()。

## 核心结论

**`internal.query.interrupt()` 不阻止 SDK 一波 in-flight frame burst（含 first session_id frame）**。

H1 race 修法选项 (A) abort consume 单独**不充分**：
- fallback fire 时调 interrupt() 不能避免 SDK 之后 emit first id frame
- consume `for await` 仍会接收 first id frame → L221 first-id 路径仍执行 → 覆盖 fallbackId（race 仍在）

## 修法决策 — 升级为 (C) 双保险

**(A) abort consume**：
- 用途：减少 detached SDK 子进程在 fallback 之后继续跑 LLM 调用的开销（result 走 error_during_execution 而非 continue 跑模型推理）；省 token cost
- **不能**作为 race 唯一护栏

**(B) consume L221 first-id 路径加 guard**：
- 必须 — 真正的 race 护栏
- 加 `if (!realId && !internal.realSessionId && ...)` 检查 internal.realSessionId 是否已被 setTimeout fallback 设置
- 已设 → skip 整个 first-id mutation 块（不再 mutate sessions Map / not call renameSdkSession）
- finally cleanup 用 `realId ?? internal.realSessionId ?? tempKey` 三档链确保 sessions.delete 拿到正确 sid

## 残留风险

1. **interrupt() resolve 时机**：实测在 first id frame 之后才 resolve，意味着如果 caller `await internal.query.interrupt()` 然后立即检查 sessions Map 状态，可能仍处于 in-flight 期间 — Phase 2 修法注意：**setTimeout fallback fire 路径不要 await interrupt() 之后再做 Map 切换**，让 (B) guard 在 consume 内 detached path 处理；fallback 自己只 fire-and-forget interrupt() + 立即做 Map switch + emit + resolve。
2. **error_during_execution result frame 仍 emit**：SDK 把 interrupt 当成「执行中错误」记录到 result frame；consume translate 路径会 emit 一条 message — 需要 Phase 2 修法在 expectedClose 时 skip translate 这条 result 避免 UI 红字（与 closeSession 现有 expectedClose 模式同款）。
3. **超长 in-flight burst 是否会有 race window**：实测 hook_started → result 全部 7 frame 在 ~30ms 内 emit 完成，consume guard 内 sync check 足够覆盖 — 不需要额外 setImmediate / queueMicrotask 排序。

## Phase 2 修法 checklist 关键 items（plan §Phase 2 用）

- [ ] stream-processor.ts setTimeout fallback fire 路径加 `internal.expectedClose = true; void internal.query?.interrupt?.()`（fire-and-forget，不 await）
- [ ] stream-processor.ts consume L221 first-id 路径加 guard：`if (internal.realSessionId !== null && internal.realSessionId !== realId) { /* skip mutation */ continue; }`
- [ ] stream-processor.ts consume finally cleanup 用 `realId ?? internal.realSessionId ?? tempKey` 三档链
- [ ] sdk-message-translate.ts 收到 result frame 时若 internal.expectedClose=true 则 skip emit error message（与现有 catch 块 expectedClose 模式同款）
- [ ] index.ts createSession throw 路径同款（A1-HIGH-1 codex H2）：catch 内 set expectedClose=true + void interrupt() 再 throw

## 残余 spike (留 Phase 2 验证 — 不必前置)

- (R1) consume guard skip 后 SDK 仍 emit 后续 frame（init / user / result），translate 是否仍 push 进 internal Maps？检查 translate 内部对 expectedClose 的反应（已在现有 catch 块覆盖，但 finally 清理路径需复核）
- (R2) renameSdkSession 是否在 toExists=false 分支会清错 row（fallback 路径没 INSERT NEW_ID record）
