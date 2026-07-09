# CHANGELOG_84

## 拆 pty-bridge.ts 506 → pty-bridge/ 5 文件（plan deep-review-and-split-20260513 Phase 3 Step 3.1）

## 概要

`src/main/adapters/generic-pty/pty-bridge.ts` 是 adapter 层 Tier 2 风险中等的目标文件（506 行 / 9 method / 含 IdleDetector callback / fileWatcher 异步 close / killTimer race）。本次按 plan §步骤 checklist Phase 3 Step 3.1 拆为 `pty-bridge/` 目录 5 文件，每个 ≤ 280 行。typecheck 双端通过 + 31 个 pty-bridge 单测 + 7 个 adapter shared 单测全过。

外部 caller import 路径不变（`from './pty-bridge'` / `'../generic-pty/pty-bridge'`），TS module resolution 自动 resolve 到 `pty-bridge/index.ts`。`GenericPtyBridge` class surface + `ADAPTER_ID_GENERIC_PTY` / `ADAPTER_ID_AIDER` 常量 + 新增 type re-export 100% 一致。

## 变更内容

### 拆分（src/main/adapters/generic-pty/pty-bridge.ts → src/main/adapters/generic-pty/pty-bridge/）

按「state ownership + 关注点」分组，与 plan §步骤 checklist Phase 3 Step 3.1 设计一致：

- `pty-bridge/index.ts` (274 行) — facade `class GenericPtyBridge`：保留 sessions Map / spawnHelperReady / opts 三个 class state owner；保留 `createSession` 主体（160 行：spawn → setup state → emit session-start → 注册 listener via factory → emit 首条 prompt）；其他 method 委托到 sub-module 函数
- `pty-bridge/pty-session-state.ts` (91 行) — type/常量集中区：`PtySessionState` / `GenericPtyBridgeOptions` / `CreatePtySessionInput` interface + `KILL_GRACE_MS` / `MAX_PROMPT_LENGTH` / `ADAPTER_ID_*` 常量。所有 sub-module 共享 import，避免双处 hardcode 漂移
- `pty-bridge/spawn-helper.ts` (49 行) — `chmodSpawnHelper(adapterId)` pure function：实际 chmod 0o755 实现 + app.asar/unpacked 路径正则替换（REVIEW_24 MED-Claude3）。promise 单飞 state（`spawnHelperReady`）保留在 class facade，避免破坏 instance-scoped 单飞语义
- `pty-bridge/lifecycle.ts` (104 行) — `closeSessionImpl` + `shutdownAllImpl` module-level 函数：单 session SIGTERM → 10s grace → SIGKILL 兜底 + 进程级 cleanup。注释保留 REVIEW_24 codex MED 1/2 完整说明
- `pty-bridge/message-io.ts` (150 行) — `sendMessageImpl` / `interruptImpl` + `makeStdoutListener` / `makeExitListener` factory 函数：onData / onExit native callback 用 factory pattern 封装 closure ref，让 createSession 一行调用

### 不修改业务行为

本拆分**仅文件物理拆分**，不修任何业务逻辑 / API surface / 行为：
- 9 个 method 签名 100% 一致；listener factory 注入参数与原 closure ref 等价
- emit 顺序 / SIGTERM/SIGKILL 时序 / fileWatcher.close fire-and-forget 与原 await 行为 100% 一致
- `GenericPtyBridge` 默认 export class 的 method 名 / 参数顺序 100% 一致；`__debugSessionCount` / `__debugGetSession` 测试便利方法保留
- 透传 re-export `ADAPTER_ID_GENERIC_PTY` / `ADAPTER_ID_AIDER` + `PtySessionState` / `GenericPtyBridgeOptions` / `CreatePtySessionInput` type，外部 caller 零改动

## 测试

- `pnpm typecheck` 双端（node + web）通过
- `pnpm exec vitest run src/main/adapters/generic-pty/__tests__/pty-bridge.test.ts` 31/31 通过
- `pnpm exec vitest run src/main/adapters/generic-pty/__tests__/adapter.test.ts` 7/7 通过（覆盖 generic-pty + aider 双 adapter 共享 class 路径）
- dev smoke test 留 H5 完整冒烟一并做（纯物理拆分零业务行为变更）

## 关联

- plan `~/.claude/plans/piped-fluttering-moth.md` Phase 3 Step 3.1
- CHANGELOG_83 (Step 2.3 拆 session-repo) — 同 plan Phase 2 Tier 1 收口
- 下一步 Step 3.2：瘦身 `sdk-bridge/index.ts` (816 行) 到 ≤ 500
