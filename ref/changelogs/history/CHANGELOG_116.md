# CHANGELOG_116

## 概要

CHANGELOG_115 §Phase 2 末尾留下的 R2-1 sessions cleanup + R3-1 late earlyErr cleanup 两个 follow-up 守门补齐 — `sdk-bridge/index.ts:337-388` createSession resume path 的 earlyErrCb wrapper 两条路径（commit `6e0eb37` R2-1 + commit `726af8d` R3-1）至此从「无 unit test 守门 / 仅生产实测发现 bug」升级到「3 case unit test 端到端守门」。行为零变化（纯 test infrastructure 加），fix 代码本身（commit `6e0eb37` / `726af8d`）不动。

## 变更内容

### 新文件 `src/main/adapters/codex-cli/__tests__/sdk-bridge.early-err-cleanup.test.ts`（3 cases）

- **case 1 (R2-1 path 1)**：`thread.runStreamed` 立即抛错 → earlyErrCb wrapper cleanup（`sessions.delete + releaseSdkClaim`）+ `emit finished:error` 一次 + reject Promise；同时验证 30s warn message **不**触发（runStreamed 立即 reject 已 clearTimeout）+ R3-1 path 2 的 late error message **不**误触发。
- **case 2 (R3-1 path 2)**：`vi.useFakeTimers()` 推进 30s 触发 fallback setTimeout → createSession resolve(opts.resume) → 然后再 reject runStreamed 模拟 late earlyErr → cleanup（`sessions.delete + releaseSdkClaim`）+ `emit finished:error` 一次 + emit late error message（"30s timeout 后 late error"）+ createPromise 已 resolve 不抛。
- **case 3 (R2-1 联合 recoverer)**：第一次 createSession resume 触发 R2-1 path → cleanup → 再 sendMessage 应走 `recoverer.recoverAndSend` 自愈路径（`sessions Map miss + sdkClaim release` → `sessionRepo.get` 调 + emit placeholder 「⚠ Codex 通道已断开,正在自动恢复」）。验证 cleanup 不仅同步发生，还确保后续 sendMessage 真走 recoverer 而非直接 throw。

### 测试 infra 关键差异（与 P1/P2 已有 _setup.ts TestCodexBridge 模式不同）

- **不复用 `TestCodexBridge / makeBridge`**：earlyErrCb wrapper 在真 `createSession` 内部 closure 里，必须真跑 createSession（而非 override createSession 的捷径）。本文件直接 `new CodexSdkBridge({ emit })` 裸用。
- **fake codex SDK 注入**：`vi.mock('@main/adapters/codex-cli/sdk-loader', () => ({ loadCodexSdk: vi.fn() }))` + beforeEach `vi.mocked(loadCodexSdk).mockResolvedValue({ Codex: class { resumeThread, startThread } })` 注入 fake `Codex` 类，其 `resumeThread / startThread` 返 `ControlledThread`（test-only `vi.fn` 返 pending Promise，外部通过 `rejectStreamed / resolveStreamed` 控制 fulfill 时机）。
- **fake codex SDK 不抽到 `_setup.ts`**：仅本 follow-up 用到，其他 P1/P2 test 不复用；放局部避免 `_setup.ts` 暴露 module-level mutable `nextThread` 让 recovery / consume-fork 误用。
- **bare loadCodexSdk mock 不复用 `makeBareSdkLoaderMock()`**：factory 返 `{ loadSdk: vi.fn() }`（claude 端 export 名）；codex 端 export 名是 `loadCodexSdk` — inline `{ loadCodexSdk: vi.fn() }` 避免 factory naming mismatch。

### 守门覆盖（与 fix 代码 commit hash 一一对应）

- `6e0eb37` R2-1 sessions cleanup → case 1 + case 3 守门
- `726af8d` R3-1 late earlyErr cleanup → case 2 守门
- 两路径共享的 `emit finished:error` 一次保证 → case 1 / case 2 各自断言 `finishedErr.length === 1`
- 两路径共享的 cleanup 让后续 sendMessage 走 recoverer → case 3 端到端联合验证

## 测试结果

- **`pnpm typecheck`**：双端 0 错。
- **`pnpm exec vitest run src/main/adapters/codex-cli/__tests__/`**：51/51 通过（24 translate + 15 recovery + 9 consume-fork + **3 early-err-cleanup**），无 regression。

## 已知踩坑

- **case 3 stderr 噪音**：本 case 用裸 cwd `/tmp/r3` 不存在 → recoverer 走 cwd fallback 启发式命中 `/tmp` + 同时 `startedAt=1` 让 jsonl 探测扫到 1970 路径 missing → fresh thread fallback + rename。这两条 console.warn 是 recoverer 真实路径的副作用，**不影响本 case 核心断言**（R2-1 cleanup 让 sendMessage 进 recoverer 入口 + emit placeholder + sessionRepo.get 调）。要消除噪音需 mock `facade.cwdExists / jsonlExistsThunk`（即换回 `TestCodexBridge` override 模式），与本文件「必须真跑 createSession」的设计目标冲突，接受 stderr 噪音换 cleanup → recoverer 端到端守门。
- **R3-1 case fake timers 时序**：`vi.useFakeTimers()` 后 `vi.advanceTimersByTimeAsync(0)` flush microtasks + `vi.advanceTimersByTimeAsync(30_001)` 触发 fallback；afterEach `vi.useRealTimers()` 防漏 cleanup 影响下一 case。
- **不走对抗 review**：纯 test infrastructure 加 + fix 代码本身（CHANGELOG_115 / REVIEW_40 已对抗 review × 三态裁决过）不动；行为正确性靠 vitest 实践验证（51/51 通过）远比文本对抗 review 直接。

## 不变量复述

- 行为零变化（fix 代码 `6e0eb37` / `726af8d` 字节不动，仅加 1 个 test 文件 ~280 LOC）
- typecheck 双端 + 全套 codex __tests__/ 51/51 全过
- fake codex SDK helper 局部封装不污染 P1/P2 _setup.ts

## commit list

- `<TBD>` test(codex-bridge): sdk-bridge.early-err-cleanup.test.ts 3 cases (codex-tests-plan follow-up R2-1 + R3-1 守门)

详 [`plans/codex-sdk-bridge-tests-20260515.md`](../../plans/history/codex-sdk-bridge-tests-20260515.md)（CHANGELOG_115 主 plan）+ [`reviews/REVIEW_40.md`](../../reviews/history/REVIEW_40.md)（R2-1 / R3-1 起源）。
