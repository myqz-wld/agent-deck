# CHANGELOG_52: 第三轮大文件拆分（claude sdk-bridge / codex sdk-bridge / session-store / manager.test）激进拆 class

## 概要

CHANGELOG_50/51 两轮拆分后，剩 4 个 >500 行文件全部在「不动保护清单」里。用户决策走最激进方案 C（拆 class，按 OO 职责分配 sub-class + facade 委托），完成第三轮。**第一次真正动 sub-class 边界**：原 ClaudeSdkBridge / CodexSdkBridge class 内部按职责拆为多个合作 sub-class，state 通过 ctx 注入，class state ownership 由 facade 重新组织。13 atomic commits（+1 audio 资源 commit），每步 typecheck + 关键 vitest 通过；最终 `pnpm build` + 6 套核心 vitest 共 76/76 全过。

| 文件 | 行数变化 | 拆分形式 |
|---|---|---|
| `claude-code/sdk-bridge.ts` | 1972 → 删除（迁到 `sdk-bridge/index.ts` 839 facade）| 拆 5 sub-class + canUseTool 工厂 + 3 纯函数模块 |
| `codex-cli/sdk-bridge.ts` | 559 → 删除（迁到 `sdk-bridge/index.ts` 253 facade）| 拆 ThreadLoop sub-class + codex-binary helper + 2 模块 |
| `session-store.ts` | 534 → 473 | 抽 8 type-guards 到 `event-type-guards.ts` |
| `manager.test.ts` | 561 → 删除 | 拆 3 describe 文件 + 1 共享 setup |

**最终 >500 行文件**：仅剩 `sdk-bridge/index.ts` (839)，是 facade 持 sessions Map / recovering Map / permissionTimeoutMs 的 state ownership 必须集中处。

## 变更内容

### Step 1. `src/main/session/__tests__/manager.test.ts` 561 → 4 文件

- 新增 `manager-test-setup.ts` (~205 行)：共享 mock Map / makeEvent / resetMocks + makeXxxRepoMock 工厂（vi.mock factory body 复用）
- 拆 `manager-ingest.test.ts` (~250)：原 ingest describe 7 个 it (CHANGELOG_15/16/REVIEW_5)
- 拆 `manager-public-api.test.ts` (~135)：原 public API describe 4 个 it (REVIEW_4 L8 + REVIEW_7 M3)
- 拆 `manager-delete.test.ts` (~135)：原 delete describe 3 个 it (REVIEW_4 H1)
- vi.mock 必须每个 test 文件顶部重复 4 段（vitest hoist 约束，跨文件 import 不会被 hoist）

### Step 2. `src/renderer/stores/session-store.ts` 534 → 473

- 新增 `event-type-guards.ts` (~93)：抽出 8 个 isXxx type guards（isPermissionRequest / isTeamPermissionRequest / isTeamPermissionCancelled / isAskUserQuestion / isExitPlanMode / isPermissionCancelled / isAskQuestionCancelled / isExitPlanCancelled）
- session-store.ts 顶部 `import { isXxx } from './event-type-guards'`，删除原 8 个函数定义
- 行为字节级等价：函数签名 / 实现完全一致，仅文件位置改变

### Step 3. `claude-code/sdk-bridge.ts` 1972 → `sdk-bridge/index.ts` 839 facade + 7 sub-module

按职责切分 5 sub-class + canUseTool 工厂：

```
src/main/adapters/claude-code/sdk-bridge/
├── index.ts                       (839) — Facade（state ownership：sessions Map + recovering Map + permissionTimeoutMs；createSession / sendMessage / closeSession / restartWithPermissionMode / setPermissionMode / 6 respond/list wrapper / consume wrapper）
├── constants.ts                   ( 51) — AGENT_ID / MAX_MESSAGE_BYTES / MAX_PENDING_MESSAGES / READ_ONLY_TOOLS / PLACEHOLDER_DEDUP_MS
├── types.ts                       ( 76) — SdkSessionHandle / SdkBridgeOptions / Pending* / InternalSession
├── sdk-message-translate.ts       (254) — translateSdkMessage / maybeEmitFileChanged / maybeEmitImageFileChanged（纯函数）
├── permission-responder.ts        (323) — PermissionResponder class：6 respond/list + 3 timeout 方法
├── can-use-tool.ts                (334) — makeCanUseTool 工厂：5 分支 (READ_ONLY / SandboxNetworkAccess / AskUserQuestion / ExitPlanMode / 默认权限)
├── recoverer.ts                   (265) — SessionRecoverer class：recoverAndSend + placeholderEmittedAt 独占 Map
└── stream-processor.ts            (266) — StreamProcessor class：consume + waitForRealSessionId + makeUserMessage + createUserMessageStream
```

**关键设计点**（吸收 Plan agent 5 finding）：

- **F1 修法**（responder→lifecycle 第二条循环依赖）：facade ctor 给 PermissionResponder 传 RestartThunk arrow `(sid, mode, prompt) => this.restartWithPermissionMode(...)`，闭包 this 晚解析；同款 thunk 给 SessionRecoverer 传 createThunk + sendThunk + jsonlExistsThunk
- **F2 修法**（recovering Map SHARED）：recovering 提到 facade，与 sessions 同级 readonly Map ref；recoverer 通过 ctx.recovering 读写，lifecycle 仍直接 this.recovering（同一 Map ref）—— 单飞 invariant 跨 sub-class 一致
- **F3 修法**（3b commit setTimeout 引用）：抽 PermissionResponder 同 commit 把 createSession 内 3 处 setTimeout(this.timeoutXxx) 改 setTimeout(this.responder.timeoutXxx) + 临时 restartWithPermissionMode wrapper 兜中间态 typecheck
- **F4 修法**（ctx readonly）：3 个 sub-class ctx interface 全部 readonly 字段，TS 强制不能 reassign sessions Map
- **F5 修法**（TS module resolution）：3a-3f 期间保留 sdk-bridge.ts 文件，靠 moduleResolution: node「文件优先于目录」让 import 站点零变更；3g 删 sdk-bridge.ts 文件后自动 fallback 到 sdk-bridge/index.ts；index.ts 顶部加 module resolution 假设说明（未来切 node16 / bundler 时怎么改）

**拆分顺序**（每步独立 commit + typecheck 通过）：3a constants/types/sdk-message-translate → 3b permission-responder + setTimeout 切换 → 3c can-use-tool → 3d recoverer + recovering Map 提到 facade → 3e stream-processor → 3f+3g facade 改名 + 删原文件

**1894 → 1678 → 1480 → 1206 → 1038 → 830 → 839** 行数演化（每步 commit 之间 typecheck 通过）。

### Step 4. `codex-cli/sdk-bridge.ts` 559 → `sdk-bridge/index.ts` 253 facade + 4 sub-module

按职责切分 ThreadLoop sub-class + 3 helper module：

```
src/main/adapters/codex-cli/sdk-bridge/
├── index.ts            (253) — Facade（state ownership：sessions Map + codex 单例 + codexCliPath；createSession / sendMessage / closeSession / interrupt / listPending wrapper + setCodexCliPath + ensureCodex）
├── constants.ts        ( 17) — AGENT_ID / 3 数字常量
├── types.ts            ( 51) — CodexSessionHandle / CodexBridgeOptions / InternalSession / BundledBinarySpec
├── codex-binary.ts     ( 68) — PLATFORM_BINARY_MAP + resolveBundledCodexBinary
└── thread-loop.ts      (242) — startNewThreadAndAwaitId + runTurnLoop
```

**拆分顺序**：4a constants/types/codex-binary → 4b thread-loop → 4c facade 改名 + 删原文件。**559 → 460 → 253** 行数演化。

**关键耦合点**：thread-loop 的 startNewThreadAndAwaitId 内 `this.ctx.sessions.delete(tempKey); this.ctx.sessions.set(realId, internal)` 直接操作 facade 持有的 sessions Map（与 facade 内 closeSession `this.sessions.delete(sessionId)` 同 Map ref）—— closeSession 同步原子序列保留在 facade（abort + intentionallyClosed=true + 清 pendingMessages + 移除 sessions），thread-loop 拿到的 internal 是同一份 InternalSession 对象。

### CLAUDE.md 新增「单文件 ≤ 500 行 — 超了必须试拆」节

记录三轮拆分实战经验：触发条件 + 3 档拆法（按风险升序：纯函数 / 目录化 / 拆 class）+「真不能拆」走「不动文件保护清单」+ 注明理由。配 CHANGELOG_50/51/52 三轮实例。

### 不动的文件（本轮明确保留）

- `claude-code/sdk-bridge/index.ts` (839) — facade state ownership 必须集中（sessions Map + recovering Map + permissionTimeoutMs + 4 sub-class 实例化 + 5 lifecycle 主路径方法），进一步拆 lifecycle class 会引入大量 wrapper boilerplate，收益<风险
- `claude-code/translate.ts` (485) — adapter 通用工具，与 sdk-bridge 子表无关，独立审

## 备注

- 13 atomic commit（11 拆分 + 1 INFO 收口 + 1 audio 资源 commit），各自可单独 revert
- 验证：每个 commit 之后 `pnpm typecheck` 通过；最后 `pnpm build` + 6 核心 vitest（claude-code/__tests__/ + codex-cli/ + session/__tests__/ + inbox-protocol）共 76/76 全过
- 不动 README：纯结构重构，无用户可见行为变化（audio commit 也不动 README，因为「内置默认音」对用户视角等同「之前 sound 不响 → 现在响 customSound 或内置」是行为增强但不是新功能）
- Deep code review 走 REVIEW_20（teammate 模式 reviewer-claude + lead 手动 Bash 调 codex 异构对抗扫本次 12 commit diff；reviewer-codex teammate 通道两次 Bash 被 Claude Code 层 deny，按 CLAUDE.md Fallback 手动 Bash 调 codex CLI 拿独立结论保留异构原则）
- INFO 收口：3 处「9 个 isXxx」注释 stale（实际 8 个）已在 review 同期 commit 修掉
