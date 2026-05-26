# CHANGELOG_115

## 概要

`codex-sdk-bridge-tests-20260515` plan 落地：codex sdk-bridge 单测套件 + LOW double rename owner cleanup（REVIEW_40 R2 reviewer-claude INFO-T 横向技术债收口 + reviewer-codex LOW 顺手清）。

REVIEW_40 落地的 HIGH-A (single-flight) / HIGH-B (recoverer) / MED-D (thread-loop case 3 rename) / MED-E (jsonl pre-check) / MED-A (emit session-upserted) **修前全无 unit test 守门**，仅 manual / 生产实测发现 bug。本 plan 镜像 claude `__tests__/sdk-bridge.recovery.test.ts` + `sdk-bridge.consume-fork.test.ts` 两套范式给 codex sdk-bridge 加同款测试守门，行为零变化。

## 变更内容

### Phase 1 - codex `_setup.ts` + `sdk-bridge.recovery.test.ts`（commit `db45318`）

- **新文件 `src/main/adapters/codex-cli/__tests__/sdk-bridge/_setup.ts`**：镜像 claude `_setup.ts` TestBridge extend pattern，抽 `TestCodexBridge` extend `CodexSdkBridge` + `emits` 模块级 array + `makeBridge()` factory。`TestCodexBridge` override `createSession` / `cwdExists` / `codexResumeJsonlExists` 三个 protected method 让单测不依赖真 fs / 真 codex CLI 子进程。**与 claude `_setup.ts` 关键差异**：codex method 名 `cwdExists` / `codexResumeJsonlExists`（不是 jsonlExists）+ 没有 `summariseForHandOff`（recoverer 不接 LLM 摘要 prepend，详 recoverer.ts L29-33）+ per-session 沙盒字段 `codexSandbox`（不是 claudeCodeSandbox）+ 还有 `model` 字段（fallback 路径需透传 sessionRepo.model 否则 DB / spawn 不一致）。
- **新文件 `src/main/adapters/codex-cli/__tests__/sdk-bridge.recovery.test.ts` 15 cases**：覆盖 HIGH-B `recoverAndSend` / MED-E jsonl pre-check / LOW-A cwd 启发式 fallback / R2-2 cwdFellBack 保留对话历史 / 单飞 / placeholder 5s dedup / MAX_LENGTH / archived → unarchive / codexSandbox+model 透传（HIGH-1 等价）共 15 case。
- **电源切断 6 个入口模块 vi.mock**（绕过 vitest node 环境下 electron 模块的 'failed to install'）：codex-binary / image-uploads / paths / settings-store / codex-config/agent-deck-mcp-injector / codex-instance-pool。

### Phase 2 - `sdk-bridge.consume-fork.test.ts`（commit `9f4cdb1`）

- **新文件 `src/main/adapters/codex-cli/__tests__/sdk-bridge.consume-fork.test.ts` 9 cases**：覆盖 ThreadLoop.runTurnLoop thread.started 三态（case 1 新建 / case 2 resume 同 id / **case 3 resume 不同 id — symmetry-plan P2 MED-D 核心 fix 目标**）+ intentionallyClosed 静默 catch（REVIEW_4 H1+M5 守门）+ RestartController HIGH-A 单飞（2 并发同 sid 串行）+ MED-A emit `session-upserted` 前置 / 回滚双路径 + handoffPrompt 空 / record 不存在边界。
- **未覆盖留 follow-up**：R2-1 sessions cleanup（resume earlyErrCb path）+ R3-1 late earlyErr cleanup（30s timeout 后）— 这两个修复点位于 `createSession` resume path 的 `earlyErrCb` wrapper 内，需要真 createSession + fake codex SDK + 控制 thread.runStreamed 抛错，测试 infra 工作量较大；本 plan 范围内留 follow-up，后续可补 fake codex SDK module 让真 createSession 跑起来。

### Phase 3 - `restart-controller.ts` double rename owner cleanup（commit `c4c84ea`）

- **`src/main/adapters/codex-cli/sdk-bridge/restart-controller.ts:113-128` 删 post-rename 防御 block**：删 `if (newRealId !== sessionId) { ... renameSdkSession + console.warn + try/catch ... }` 共 23 行删除 + 16 行注释更新（净 -8 LOC，文件 178 → 170 LOC）+ 删 unused `sessionManager` import。
- **删除理由（thread-loop case 3 已 owner rename）**：symmetry-plan P2 MED-D 落地后（commit `6e0eb37`），`thread-loop.ts:229-261` case 3 在 `ev.thread_id !== internal.threadId` 时已：(1) sessions Map 切 key（delete oldId + set newId）；(2) `internal.threadId` 切到 newId；(3) 调 `sessionManager.renameSdkSession(oldId, newId)`。所以 `createSession` resume path `await runTurnLoop` 拿到 `firstIdCb(newId)` 时，rename 已经发生，`handle.sessionId === newId`。restart-controller 这里再调一次 `renameSdkSession` 是 idempotent no-op（`sessionRepo/rename.ts:60` `if (!fromRow) return` 静默走 no-op），但 `console.warn` 会多打一次，误导日志读者以为这里是 owner 实际是 thread-loop case 3。删除让 SSOT 集中在 thread-loop case 3 single owner。

### Phase 4 - 收口

- 不单建 review（本 plan 是 test infrastructure + LOW cleanup 横向技术债，无新发现 fix-to-fix bug）。
- archive_plan tool 自动归档：plan frontmatter `status: completed` + `final_commit` + ff-merge worktree branch → main + mv plan → `<main-repo>/plans/`。

## 测试结果

- **`pnpm typecheck`**：双端 0 错。
- **`pnpm exec vitest run src/main/adapters/codex-cli/__tests__/`**：48/48 通过（24 translate + 15 recovery + 9 consume-fork）。
- 全套 vitest 在主仓库 jsonless 环境下 524 全过；worktree 跑全套有 11 文件 / 9 case Electron native binary 安装失败（pre-existing 与本 plan 无关，详「已知踩坑」）。

## 已知踩坑

- **vitest 在 worktree 跑时 Electron native binary 安装失败**：worktree 第一次 `pnpm install` 时 `electron-rebuild` 拉 node-pty native module build 失败，但 vitest 本身能跑（worktree 跑 codex-cli/__tests__/ 全过）。主仓库无此问题。打 vi.mock 6 个入口模块（codex-binary / image-uploads / paths / settings-store / mcp-injector / instance-pool）绕过 electron 链。这与 CHANGELOG_101/104/105 同款 worktree 跑测的已知 infra 问题。
- **TestBridge override `createSession` 后 ensureCodex / loadCodexSdk 不会被调**：所以 `loadCodexSdk` mock 只需 `makeBareSdkLoaderMock()` bare stub 即可，不需 mockResolvedValue。
- **`runTurnLoop intentionallyClosed catch` 静默退出守门**：`thread.runStreamed` 抛 error 时若 `internal.intentionallyClosed=true` → `internal.currentTurn=null + break`，**不**emit `finished:interrupted`（REVIEW_4 H1+M5：避免 manager 把已删 session 复活成幽灵）。
- **restart-controller test 用 `vi.spyOn(eventBus, 'emit')` 而非 mock module**：eventBus 是 module-level singleton，spy + restore 模式比独立 mock 模块简洁。

## commit list

- `db45318` test(codex-bridge): _setup.ts + sdk-bridge.recovery.test.ts 15 cases (codex-tests-plan P1)
- `9f4cdb1` test(codex-bridge): sdk-bridge.consume-fork.test.ts 9 cases (codex-tests-plan P2)
- `c4c84ea` refactor(codex-bridge): restart-controller 删 double rename owner 冗余 (codex-tests-plan P3)

详 [`plans/codex-sdk-bridge-tests-20260515.md`](../plans/codex-sdk-bridge-tests-20260515.md)。
