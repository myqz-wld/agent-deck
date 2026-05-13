# CHANGELOG_85

## 瘦身 sdk-bridge/index.ts 816 → 495 → ≤ 500（plan deep-review-and-split-20260513 Phase 3 Step 3.2 / Tier 2 收口）

## 概要

`src/main/adapters/claude-code/sdk-bridge/index.ts` 是 adapter 层 Tier 2 第二个目标文件（CHANGELOG_52 第一轮已拆 1972→839，CHANGELOG_74 加 RestartController 后 866→816；本次再瘦到 495 ≤ 500）。本次按 plan §步骤 checklist Phase 3 Step 3.2 抽 6 个新 sub-module + 瘦 jsdoc 落地。typecheck 双端通过 + 28 个相关单测全过（22 sandbox-config + 6 can-use-tool）。

外部 caller import 路径不变（`from './sdk-bridge'` / `'@main/adapters/claude-code/sdk-bridge'` 自动 resolve 到 `sdk-bridge/index.ts`），`ClaudeSdkBridge` class surface + 5 个 thin wrapper 方法（restartWithPermissionMode / restartWithClaudeCodeSandbox / setPermissionMode / sendMessage / closeSession）100% 一致。

## 变更内容

### 新增 6 个 sub-module（src/main/adapters/claude-code/sdk-bridge/）

按「单一关注点」分组，让 facade `index.ts` 只关心 createSession 主流程 + sub-module 拼装：

- `pending-cancellation.ts` (125 行) — closeSession step 2-5 整套 cleanup 链：`cancelPendingAndEmit`（pending Maps cancel emit + clearTimeout + clear，原 37 行三段重复结构合并为单 helper）+ `runCloseSessionCleanup`（cancel + sessions.delete + sdkOwned release + markRecentlyDeleted + notify wakeup 整套抽出）
- `mcp-server-init.ts` (85 行) — `buildMcpServersForSession`：tasksServer + agentDeckMcpServer 拼装 + lazy provider 工厂（settings.enableTaskManager / enableAgentDeckMcp 两 toggle 独立）
- `query-options-builder.ts` (151 行) — `buildClaudeQueryOptions`：SDK `query({ options: <here> })` 整段抽到 pure builder（保留原 ~95 行紧贴各字段的设计 jsdoc 完整不删 — review-time context 关键）
- `send-validation.ts` (65 行) — `validateSendMessageOrThrow`：sendMessage 入口 3 段 pre-condition check（长度上限 / 队列上限 / pending warning emit）
- `session-finalize.ts` (68 行) — `finalizeSessionStart`：createSession 拿到 realId 后的 finalize 链（emit session-start → setClaudeCodeSandbox → 补 emit 首条 user message）
- `sandbox-resolve.ts` (35 行) — `resolveClaudeSandboxMode`：sandbox mode 4 级 fallback 链（opts → resume sessionRepo → settings → 'off'）

### 修改 `src/main/adapters/claude-code/sdk-bridge/types.ts` (107 → 132 行)

新增 `makeInternalSession(opts: { cwd, permissionMode? })` factory：把 createSession 内 11 字段 InternalSession 字面量集中到一处，避免 facade 内字段初值分散。

### 修改 `src/main/adapters/claude-code/sdk-bridge/index.ts` (816 → 495 行)

3 个高密度抽出点（共减 ~250 行）：
1. **createSession 内 mcp 拼装段（line 300-343, ~44 行）** → `buildMcpServersForSession(internal, tempKey)` 一行调用
2. **createSession 内 query() options 整段（line 344-441, ~95 行）** → `buildClaudeQueryOptions({...})` 调用（10 个字段 args）
3. **closeSession step 2-5 cleanup 链（~50 行）** → `runCloseSessionCleanup({...})` 一行调用

3 个低密度抽出点（共减 ~50 行）：
4. **createSession 内 sandbox mode 计算（13 行）** → `resolveClaudeSandboxMode(opts)` 调用
5. **createSession 内 internal 字面量（24 行）** → `makeInternalSession({...})` 调用
6. **createSession 末段 finalize 链（36 行）** → `finalizeSessionStart({...})` 调用 + sendMessage validation 抽 send-validation.ts

3 个 jsdoc 瘦身（共减 ~60 行）：
- class field jsdoc：5 个 sub-module field 的 jsdoc 从 ~50 行瘦到 5 句话（详见每行 sub-module ts 文件 jsdoc）
- ctor 内 sub-module 拼装：4 段拼装去掉冗余 `XxxCtx` typed 中间变量（直接 inline literal），删 4 处 inline 注释
- 2 个 thin wrapper 方法（restartWithPermissionMode / restartWithClaudeCodeSandbox / setPermissionMode）jsdoc 从 ~12 行瘦到 3 行

清理 stale type / value import：删 `Query` / `agentDeckTeamRepo` / `getTasksMcpServerForSession` / `getAgentDeckMcpServerForSession` / `AGENT_DECK_MCP_TOOL_PATTERN` / `MAX_MESSAGE_LENGTH` / `MAX_PENDING_MESSAGES` / `sessionRepo` / `settingsStore` / `ResponderCtx` / `RecovererCtx` / `StreamProcessorCtx` / `RestartCtx` 共 13 个 stale import（已迁到 sub-module）。

### 不修改业务行为

本拆分**仅文件物理拆分 + jsdoc 瘦身**，不修任何业务逻辑 / API surface / 行为：
- 所有 method 签名 100% 一致（含 5 个 thin wrapper 委托到 RestartController / PermissionResponder）
- emit 顺序 / SIGTERM / cancel 时序 / sdk_owned release / recentlyDeleted 黑名单 100% 一致
- sub-module ctx pattern 与 CHANGELOG_52 现有 4 个 sub-module 完全对齐（StreamProcessor / SessionRecoverer / PermissionResponder / RestartController），新增 6 个 sub-module 走「pure function 接 args 显式注入」模式不持 state（class state 仍只在 facade）

## 测试

- `pnpm typecheck` 双端（node + web）通过
- `pnpm exec vitest run sdk-bridge/__tests__/can-use-tool.test.ts` 6/6 通过
- `pnpm exec vitest run __tests__/sandbox-config.test.ts` 22/22 通过
- `pnpm exec vitest run __tests__/sdk-bridge.test.ts` Electron native binding 限制无法跑（HEAD baseline 同款失败，pre-existing 非本次责任，详 CHANGELOG_42 同款问题）
- dev smoke test 留 H5 完整冒烟一并做

## 关联

- plan `~/.claude/plans/piped-fluttering-moth.md` Phase 3 Step 3.2 / Tier 2 收口
- CHANGELOG_84 (Step 3.1 拆 pty-bridge) — 同 plan Phase 3 上一步
- CHANGELOG_74 (RestartController 抽出 + 第一轮瘦身 866→816) — 第一轮 Tier 2 起点
- CHANGELOG_52 (第三轮大文件拆分 1972→839 + 8 sub-module) — 历史最大幅度拆分
- 下一步 Phase 4 Step 4.1：拆 `src/main/session/manager.ts` (650+) 最高风险，按 plan 走 deep-code-review SKILL 异构对抗 + 单独 sub-plan

## Phase 3 收口（Tier 2 两大文件全瘦身完）

至此 plan §步骤 checklist Phase 3 Tier 2 两大文件（pty-bridge.ts / sdk-bridge/index.ts）全部 ≤ 500 行：

| Tier 2 文件 | 原 LOC | 拆后 max sub-file LOC | commit |
|---|---|---|---|
| `pty-bridge.ts` | 506 | 274 (pty-bridge/index.ts) | `84a306c` |
| `sdk-bridge/index.ts` | 816 | 495 (本次 facade) | 本次 |

H4 起进入 Phase 4（Tier 3：manager.ts 650+H1 增量 ≈ 730+ 行，最高风险，必须走 deep-code-review SKILL 异构对抗 + 单独 sub-plan）。
