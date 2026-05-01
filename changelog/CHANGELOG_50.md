# CHANGELOG_50: 大文件拆分（types barrel / ipc per-domain / sdk-bridge formatAskAnswers extract）

## 概要

仓库内 ≥ 500 行的「大文件」绝大多数是 review 沉淀（sdk-bridge.ts 一文件 9 次 review、ipc.ts 6 次、session/manager.ts 多次重灾区），不是 organic mess。本期选三个**确认零行为变更 + 收益明确**的拆分动手，把高风险大文件（sdk-bridge class 主体 / session/manager / UI 组件）保护起来；S1+S2+S3 三个 atomic commit，每步独立 typecheck 通过 + 可独立 revert。

## 变更内容

### S1. `src/shared/types.ts` (777 → 13) → barrel + 8 domain modules

`src/shared/types.ts` 由 777 行实定义改成 8 行 barrel `export * from './types/{...}';`；新增：

- `src/shared/types/agent.ts` — `AgentEventKind`, `AgentEvent<P>`
- `src/shared/types/session.ts` — `ActivityState`, `LifecycleState`, `PermissionMode`, `SessionSource`, `SessionRecord`
- `src/shared/types/team.ts` — `TeamMember`, `TeamConfig`, `TeamSnapshot`, `TeamSummary`, `TeamDataChangedEvent`, `TeamTaskPayload`, `TeamTeammateIdlePayload`（跨域 import `SessionRecord` / `AgentEvent`）
- `src/shared/types/permission.ts` — `PermissionRequest/Response`, `AskUser*`, `ExitPlanMode*`, `TeamPermission*`
- `src/shared/types/file.ts` — `FileChangeRecord`, `DiffPayload<T>`, `ImageSource`, `ImageToolResult`, `LoadImageBlobResult`
- `src/shared/types/summary.ts` — `SummaryRecord`
- `src/shared/types/task.ts` — `TaskStatus`, `TaskRecord`, `TaskChangedEvent`
- `src/shared/types/settings.ts` — `AppSettings`, `DEFAULT_SETTINGS`, `HookInstallStatus`, `SettingsSource`, `SettingsPermissionsBlock`, `SettingsLayer`, `MergedRule/Directory/Permissions`, `PermissionScanResult`

60 个 `from '@shared/types'` 调用方零变更（barrel 与原文件 export 完全等价）。纯类型位移，零运行时影响。

### S2. `src/main/ipc.ts` (997) → 删除，`src/main/ipc/` 子目录承接

按 domain 拆 10 个 register module：

- `_helpers.ts` — `on()` + `IpcInputError` + 8 个 `parseXxx`（PositiveInt / StringId / HookScope / HookCwd / PermissionMode / SandboxMode / TeamName / StringIdArray）
- `window-app.ts` — `AppGetVersion` + `Window*` + `Dialog*` + `AppPlayTestSound` + `AppShowTestNotification` + `DialogConfirm`
- `sessions.ts` — `Session*` + `SessionListHistory`
- `hooks.ts` — `HookInstall / Uninstall / Status`
- `settings.ts` — `SettingsGet / Set` 主体 + 9 个 `applyXxx` / `warnXxx` / `invalidateClaudeMdCache` + `ClaudeMd*`
- `adapters.ts` — `Adapter*` 全套（含 `setPermissionMode` 冷切 + REVIEW_11 Bug 2 修法 + 失败回滚）
- `permissions.ts` — `PermissionScanCwd` + `PermissionOpenFile`
- `images.ts` — `ImageLoadBlob` + `loadImageBlob` + `isPathInSessionWhitelist` + 双白名单 + TOCTOU 防护
- `teams.ts` — `SummarizerLastErrors` + `Team*` + `TeamPermission*`
- `index.ts` — `bootstrapIpc()` 按原顺序调用 8 个 register

`src/main/index.ts:6` 的 `import { bootstrapIpc } from './ipc'` 完全不动（TS module resolution 自动从 `./ipc` 命中 `./ipc/index.ts`）。channel 注册顺序与 SettingsSet 内 N6 事务 / setPermissionMode 冷切 / TeamForceCleanup C 方案 / 双白名单 等所有护栏完全保留。

### S3. `src/main/adapters/claude-code/sdk-bridge.ts` (1995 → 1972)

把末尾的 `formatAskAnswers` 纯函数（无 state / 无 IO，仅文件内 1 处调用）抽到独立 `sdk-bridge-helpers.ts`（31 行）。**`ClaudeSdkBridge` class 主体字节零变更**（9 次 review 加固的 race / lifecycle / fork 兜底路径不动）。

### S4. 明确不动的文件（本轮保护清单）

CLAUDE.md 明文护栏 + 多次 review 加固集中在以下文件，**任何拆分都需要单独 plan 评审**：

- `src/main/adapters/claude-code/sdk-bridge.ts` 的 `ClaudeSdkBridge` class 全部方法
- `src/main/adapters/codex-cli/sdk-bridge.ts`（同性质）
- `src/main/session/manager.ts`（REVIEW_5 / 9 / 12 加固重灾区）
- 所有 renderer UI 组件（`SessionDetail.tsx` / `TeamDetail.tsx` / `pending-rows/index.tsx` / `session-store.ts`）— 拆分需先看 React state 边界

## 备注

- 三个 atomic commit 互不依赖，各自可单独 revert
- 验证：`pnpm typecheck` 三次（每个 commit 后）+ `pnpm build` + `vitest` sdk-bridge / inbox-protocol / manager 共 54 测全过
- 不动 README：纯结构重构，无用户可见行为变化
- Deep code review 走 REVIEW_18（teammate 模式 reviewer-claude + reviewer-codex 异构对抗扫本次 diff）
