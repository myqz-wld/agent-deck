---
review_id: 58
reviewed_at: 2026-05-27
expired: false
skipped_expired:
---

# REVIEW_58: resume / SDK 断连自愈路径 user message 不渲染 bug 修复（双轮异构对抗 deep-review）

## 触发场景

用户截图实测 bug：resume / SDK 断连自愈场景下用户发送的消息在 detail view 不渲染（看到「⚠ SDK 通道已断开，正在自动恢复…」占位 + 后续 assistant「✅ 一轮完成」，但自己发的 user message bubble 消失）。用户主动指出 bug 并要求 deep code review，聚焦 functional bug + code quality。

## 方法

**deep-review SKILL 多轮异构对抗**（`agent-deck:deep-review`）：

- **Reviewer A**: `reviewer-claude` teammate（claude-code adapter，Opus 4.7，default thinking）
- **Reviewer B**: `reviewer-codex` teammate（codex-cli adapter，gpt-5.5 xhigh），native cross-adapter pair

**范围**：10 个文件（sdk-bridge resume / 断连自愈主路径）+ 2 个 recovery test 文件

```text
src/main/adapters/{claude-code,codex-cli}/sdk-bridge/
  ├ recoverer.ts             # recoverAndSend 主体（断连自愈入口）
  ├ jsonl-fallback.ts        # claude only — maybeJsonlFallback helper
  ├ session-finalize.ts      # claude only — finalizeSessionStart helper
  ├ index.ts                 # createSession + sendMessage facade
  ├ stream-processor.ts      # SDK 流消费 / first realId / fork detect (claude only — codex 走 thread-loop)
  └ restart-controller.ts    # 冷切 permissionMode / sandbox（claude only）
src/main/adapters/{claude-code,codex-cli}/__tests__/sdk-bridge.recovery.test.ts
```

**机器可读范围**（File-level Review Expiry 用）：

```review-scope
src/main/adapters/claude-code/__tests__/sdk-bridge.recovery.test.ts
src/main/adapters/claude-code/sdk-bridge/index.ts
src/main/adapters/claude-code/sdk-bridge/jsonl-fallback.ts
src/main/adapters/claude-code/sdk-bridge/recoverer.ts
src/main/adapters/claude-code/sdk-bridge/restart-controller.ts
src/main/adapters/claude-code/sdk-bridge/session-finalize.ts
src/main/adapters/claude-code/sdk-bridge/stream-processor.ts
src/main/adapters/codex-cli/__tests__/sdk-bridge.recovery.test.ts
src/main/adapters/codex-cli/sdk-bridge/index.ts
src/main/adapters/codex-cli/sdk-bridge/recoverer.ts
```

**约束**：每条 finding 必须含文件:行号 + ≤6 行代码片段 + 验证手段；弱断言关键词仅允 *未验证* 条目；HIGH/MED 严格分级；双方独立提出 OR 单方 + 现场验证才 ✅。

## 三态裁决结果

### ✅ 真问题（双方独立提出 / 一方提出且现场实践验证成立）

| # | 严重度 | 文件:行号 | 问题 | A (claude) | B (codex) | 验证手段 |
|---|---|---|---|---|---|---|
| 1 | HIGH | `claude-code/sdk-bridge/index.ts:484-507` + `codex-cli/sdk-bridge/index.ts:757-760` | `bridge.sendMessage if (!s)` 断连分支直接委托 `recoverAndSend` 返回，**入口不 emit user message**；emit 责任全下放下游 `finalizeSessionStart` (在 `await waitForRealSessionId` 后) / `maybeJsonlFallback` (在 `await ctx.createSession` 后) / 30s setTimeout fallback (完全不 emit) / createSession catch path (完全不 emit) → 跨 SDK 启动时序窗口 + 失败路径完全丢用户输入 | HIGH-2 (R1) — 不对称分析 | HIGH-1 (R1) — emit 责任全下放 5 条路径 | 双方独立提出（异构强冗余即算验证）+ lead grep `role: 'user'` 三处 emit 点确认 |
| 2 | MED | `claude-code/__tests__/sdk-bridge.recovery.test.ts:95+222+...` + `codex-cli/__tests__/sdk-bridge.recovery.test.ts` | recovery test 4 个核心 case (normal resume / jsonl-missing / cwd-fallback / setTimeout fallback) 全部不断言 `{kind:'message', payload:{role:'user'}}` event，bug 能通过当前测试集 | — | MED (R1 单方) | lead 现场实证：grep `role: 'user'` 在 `__tests__/` 内只有 `jsonl-fallback.test.ts` 1 处 + read recovery test L95-135 / L222-276 确认仅断言 `placeholders` 与 `createCalls` |
| 3 | MED (R2 收口) | `claude-code/sdk-bridge/recoverer.ts:289-300` + `codex-cli/sdk-bridge/recoverer.ts:218-240` | R1 修法把 emit user message 放在 cwd precheck 之后；cwd 全 miss `emit cwd missing error + throw` 路径下 user emit 永不执行 → 与 R1 治的截图 bug 同款症状（cwd 被删 / 跨设备同步丢失场景） | MED-1 (R2) | MED (R2) | 双方独立提出 + lead 读 fix 后行序 line 289 throw 在 line 356 emit user message 之前确认 |

### ❌ 反驳（被对抗或现场核实证伪）

| 报告方 | 报项 | 反驳依据 |
|---|---|---|
| reviewer-claude R1 HIGH-1 *未验证* | `jsonl-fallback emit user message 时序跨 stream-processor S6 fork detect renameSdkSession 窗口致 OLD bucket 重生不渲染` | 现场证伪：plan reverse-rename-sid-stability-20260520 实施后 stream-processor.consume 在 resume 路径下不调 `sessionManager.renameSdkSession`（line 322 `isNewSpawn = !resumeId && resumeMode !== 'fresh-cli-reuse-app'` → resume 路径 isNewSpawn=false 跳过 spawn rename + line 362 fork detect 改走 `sessionManager.updateCliSessionId` 只动 `cli_session_id` 列不动 sessions.id），sessions.id 永远 = applicationSid 稳定，不存在「rename → moveMapKey → OLD bucket 重生」场景。reviewer-claude R1 自己明确披露未读 stream-processor.ts 是 *未验证* 根因推论 |

### ❓ 未验证 / 未达共识

| 报告方 | 报项 | 状态 |
|---|---|---|
| reviewer-claude R1 LOW-4 *未验证* | 占位 message 5s dedup 与 user message 无关 | INFO 性质，无紧迫验证压力 |
| reviewer-claude R1 INFO-5 | fresh-cli-reuse-app 路径 emit user message 责任转移 jsdoc 时序 race 风险未显式标注 | 文档建议，本轮修法已通过 `skipFirstUserEmit` 字段 jsdoc 明确「触发场景」+「不影响其他副作用」边界，覆盖该建议 |

### INFO（reviewer-claude R2 反审 5 维度上下文）

- **INFO-1**: `restart-controller` 调 `maybeJsonlFallback` 不传 `skipFirstUserEmit` → helper 默认 emit handoffPrompt = 期望行为（restart 入口本身不 emit user message 让 helper 作为唯一 emit 点），不构成双气泡
- **INFO-2**: `setTimeout 30s fallback` (`stream-processor.waitForRealSessionId`) 不涉及 user message emit（只 emit error message），修法前后行为字面等价
- **INFO-3**: emit 顺序 user message → placeholder → await createSession → session-start，renderer 按 ts 排序 user message 仍在最前，不破渲染
- **INFO-4**: claude 4 处守门（finalize + maybeJsonlFallback + recoverAndSend 入口 + createSession opts 透传）vs codex 1 处守门（resume path 内 if 守门）是 inline vs helper 抽象差异，不构成真问题
- **INFO-5**: API surface `skipFirstUserEmit` 默认 false / undefined 向后兼容，jsdoc 明确「caller 不该传」+「触发场景」+「不影响其他副作用」

## 修复条目

### HIGH ✅ 修法（双方共识真问题）

**Bug 根因**：`bridge.sendMessage if (!s)` 断连分支与 live 主路径 emit 时机不对称 — live 主路径在 SDK 启动前立即 emit `role:'user'` message，断连路径委托 `recoverAndSend` 后入口只 emit 占位 message，**emit user message 责任全下放给 5 条下游路径**（normal resume → finalize / jsonl-missing fallback → helper / cwd-fallback → 下游 helper / 30s setTimeout fallback → 完全不 emit / createSession catch → 完全不 emit），跨 SDK 实际 spawn 时序 + 失败路径完全丢失用户输入。

**修法**（emit user message 收口到 `recoverAndSend` 入口 + 下游 `skipFirstUserEmit` 守门）：

1. **claude `recoverer.ts:257-303`**：`sessionRepo.get` 后立即跑长度校验 + emit user message（**位置在 cwd precheck 之前** — R2 MED-1 修订让 cwd 全 miss throw 路径也保留 events 入库）
2. **claude `recoverer.ts:455+502`** + **`jsonl-fallback.ts` ctx**：normal resume + maybeJsonlFallback 调 `createThunk` / helper 显式传 `skipFirstUserEmit: true`
3. **claude `sdk-bridge/index.ts:204-225` (createSession opts) + `:481` (finalize 透传)**：新增 `skipFirstUserEmit?: boolean` 字段，透传给 `finalizeSessionStart`
4. **claude `session-finalize.ts:75-91` + `:170-184`**：`FinalizeSessionStartArgs` 加 `skipFirstUserEmit` + emit user message 前 `if (!skipFirstUserEmit)` 守门
5. **claude `jsonl-fallback.ts:138-149` + `:289-302`**：`JsonlFallbackOptsBase` 加 `skipFirstUserEmit` + emit user message 前 `if (!opts.skipFirstUserEmit)` 守门
6. **codex `recoverer.ts:206-250`**：对称 claude — 长度校验 + emit user message 提前到 cwd precheck 之前
7. **codex `recoverer.ts:400+432`**：两个 `createThunk` 调用（jsonl-missing fallback + normal resume）显式传 `skipFirstUserEmit: true`
8. **codex `sdk-bridge/index.ts:388-404` (createSession opts) + `:553-572` (resume path emit 守门)**：新增 `skipFirstUserEmit?: boolean` 字段，resume path emit user message 前 `if (!opts.skipFirstUserEmit)` 守门

**reviewer R2 反审结论**：0 HIGH 引入新问题；R1 ✅ HIGH 修法正确解决用户截图 bug，5 个怀疑维度（双气泡 / 失败路径 / 顺序 / 跨 adapter 对称性 / API surface）全过。

### MED ✅ 修法（recovery test 回归 + R2 cwd 全 miss 边角）

9. **claude `__tests__/sdk-bridge.recovery.test.ts:960+`**：补 5 个 regression test（normal resume / jsonl-missing fallback / createSession 失败 / attachments 透传 / **R2 cwd 全 miss path user message 仍 emit 入 events**）
10. **codex `__tests__/sdk-bridge.recovery.test.ts:633+`**：补 5 个对称 regression test

### R2 MED-1 ✅ 收口修法（双方共识）

11. **claude `recoverer.ts:263-303`** + **codex `recoverer.ts:212-250`**：把长度校验 + emit user message 整段移到 sessionRepo.get 之后、cwd precheck 之前，让 cwd missing fallback 全 miss throw 路径也保留 events 入库 — 用户体感「看到 cwd missing error 红字 + 自己的 message bubble 仍在」帮助决策

## 验证

```bash
pnpm typecheck                                  # ✓ pass
pnpm exec vitest run src/main/adapters/         # ✓ 22 文件 / 227 test 全 pass
                                                #   含 11 个新 regression test 锁定本次修法
```

## 修后行为合约

- **用户体感与 live 主路径一致**：断连恢复路径下用户发消息 → 立即看到自己的 message bubble → 再看到「⚠ SDK 通道已断开，正在自动恢复…」占位 → SDK 实际跑完拿到 assistant message
- **失败/边界路径不丢用户输入**：createSession catch / setTimeout 30s fallback / cwd missing 全 miss throw / 长度校验通过后任意 throw 路径都保留 events 入库
- **不双气泡**：4 处 emit 责任路径通过 `skipFirstUserEmit` 字段守门避免重复 emit
- **跨 adapter 对称**：claude / codex 两端均修，emit 时机一致

## 关联 changelog

无（纯 bug fix，无新功能 / API / 行为修改 — 仅修复用户截图实测 bug + 加固边角 case + 补 regression test）。
