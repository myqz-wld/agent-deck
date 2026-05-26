# CHANGELOG_51: 第二轮大文件拆分（pending-rows / SessionDetail / TeamDetail / session/manager pure helpers）

## 概要

CHANGELOG_50 第一轮（types barrel / ipc per-domain / sdk-bridge formatAskAnswers）落地后，按 plan 继续把 4 个 ≥500 行候选拆完。每步 atomic commit，typecheck 通过才进下一步；最终 `pnpm build` + 3 套核心 vitest 共 54/54 全过。

| 文件 | 行数变化 | 拆分形式 |
|---|---|---|
| `pending-rows/index.tsx` | 728 → 22（barrel） | 同目录拆 4 row + 1 helper + barrel |
| `SessionDetail.tsx` | 618 → 删除（迁到 `SessionDetail/index.tsx` 322 行） | 同目录拆 5 sub-component + helpers |
| `TeamDetail.tsx` | 587 → 删除（迁到 `TeamDetail/index.tsx` 257 行） | 同目录拆 6 sub-component / helper / chrome |
| `session/manager.ts` | 548 → 486 | 仅抽 4 个 module-level pure helpers，class 主体字节零变更 |

## 变更内容

### P1. `src/renderer/components/pending-rows/`

- 新增 `PermissionRow.tsx` (~120 行) / `AskRow.tsx` (~183 行) / `ExitPlanRow.tsx` (~228 行) / `TeamPermissionRow.tsx` (~115 行) / `tool-input-diff.ts` (~58 行)
- `index.tsx` 改 22 行 barrel re-export
- 3 个 import 站点（PendingTab / activity-feed/index / activity-feed/rows/tool-row）零变更
- 跨 Row 内部未互调，每个独立 file 按需 import 自己的 type / component

### P2. `src/renderer/components/SessionDetail/`

- 删除原 `SessionDetail.tsx`，迁到 `SessionDetail/index.tsx`（TS module resolution 自动从 `./SessionDetail` 命中目录的 `index.tsx`）
- 新增 `SourceBadge.tsx` / `ComposerSdk.tsx` / `CliFooter.tsx` / `ChangeTimeline.tsx` / `helpers.ts`（decodeBlob）
- `App.tsx` 的 `import { SessionDetail } from './components/SessionDetail'` 零变更
- 子组件全部 prop-driven，仅 `ComposerSdk` 用 `useSessionStore` 读 `permissionMode`（与原文件相同）
- 主体保留所有 effect / memo / state，包含 file_changes 节流订阅 + sequence counter / cancel toast 5s 自动消失等护栏

### P3. `src/renderer/components/TeamDetail/`

- 删除原 `TeamDetail.tsx`，迁到 `TeamDetail/index.tsx`
- 新增 `lead-session.ts`（pickLeadSession） / `SendToTeammate.tsx`（含 REVIEW_17 R3 / M1-R3 prompt-injection 防护：fenced code block 包装 + target charset 校验） / `ForceCleanupButton.tsx`（含 1.2s 反馈展示防 onBack 抢切） / `TeamEventRow.tsx` / `chrome.tsx`（Header + Section + Stat 三个 layout helper）
- `TeamHub.tsx` 的 `import { TeamDetail } from './TeamDetail'` 零变更
- 主体保留 REVIEW_17 R1 / M3 的 `snapRef` 护栏（避免 effect deps 含 snap 引发 unsubscribe + 重 subscribe + onAgentEvent 重 register 翻倍）

### P4. `src/main/session/manager.ts` + `manager-helpers.ts`

- 新增 `manager-helpers.ts` (~81 行)：`normalizeCwd` / `nextActivityState` / `extractCwd` / `deriveTitle`
- `manager.ts` 删除 4 个原 module-level helper 定义，改 `import { ... } from './manager-helpers'`
- **`SessionManagerClass` 主体字节零变更**（class 共享的 `sdkOwned` / `pendingSdkCwds` / `recentlyDeleted` Maps 与所有 race 路径不动，CLAUDE.md 多处护栏完整保留）
- 6 个 import 站点（adapter / ipc / tests）零变更
- `manager.test.ts` 14/14 passed 验证 `nextActivityState` / `normalizeCwd` 行为等价

### 不动的文件（本轮明确保护）

- `session/manager.ts` 的 `SessionManagerClass` 全部方法（state ownership 不重组）
- `codex-cli/sdk-bridge.ts`（同 claude sdk-bridge 性质，需独立 plan）
- `claude-code/sdk-bridge.ts` 的 `ClaudeSdkBridge` class（保护中的保护）
- `stores/session-store.ts` (534) — renderer state，需独立看 selector 边界
- `claude-code/translate.ts` (485) — adapter 通用工具，需独立审

## 备注

- 4 个 atomic commit 互不依赖，各自可单独 revert
- 验证：每个 commit 之后 `pnpm typecheck` 通过；最后 `pnpm build` + 3 核心 vitest（sdk-bridge / inbox-protocol / manager）共 54/54 全过
- 不动 README：纯结构重构，无用户可见行为变化
- Deep code review 走 REVIEW_19（teammate 模式 reviewer-claude + reviewer-codex 异构对抗扫本次 4 commit diff；reviewer-codex 余额未恢复时单方推进 + 明标 `heterogeneous_dual_completed: false`）
