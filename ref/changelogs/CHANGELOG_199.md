# CHANGELOG_199 — PendingTab 批量行收紧：plan / ask 不再被批量、删除 select 下拉

## 概要

`PendingTab` 每会话 section header 的「全部允许」「全部拒绝」批量按钮之前会把 `permissions + exitPlanModes` 一起批（`batchableCount = permissions.length + exitPlanModes.length`），并配一个仅作用于批量 plan 切档的 3 档 `select` 下拉（`default / acceptEdits / plan`，缺 `bypassPermissions`「不再询问」）。这次收紧语义：**批量按钮只作用于 `PermissionRequest`**；`ExitPlanModeRequest` 跟 `AskUserQuestion` 一样必须逐条在 row 内处理。header 行的 `select` 整行删掉——下拉原本只为批量 plan 切档用，plan 退出批量后无意义，「不再询问」也因而下拉不再补（这条档本来就只在单条 `ExitPlanRow` 内走冷切重启用，批量路径强不留）。

预期视觉：batch 行只剩「全部允许」「全部拒绝」两个按钮，权限模式选择完全由 `ExitPlanRow` / `PermissionRow` 单条 row 内置的 `select` 处理（`ExitPlanRow` 4 档齐全含「⚠️ 不再询问」）。当一个 session 只有 plan + ask 等待时 batch 按钮置灰，tooltip 提示「仅剩需要你逐条处理的计划 / 问题」。

## 变更内容

### 代码改动

- **`src/renderer/components/PendingTab.tsx`**:
  - 删 `batchTargetMode` state + `setBatchTargetMode` setter + `targetModeLabel` 整组（仅服务于批量 plan 切档，plan 退出批量后无 consumer）
  - `batchableCount` 计算改为 `permissions.length`（原 `permissions.length + exitPlanModes.length`）
  - `batchDisabled` 条件保持 `batchableCount === 0 || !isSdk || batchBusy` 不变 — `batchableCount` 改完后语义自动对齐「无 permission 时置灰」
  - `onBatchAllow` / `onBatchDeny` 删 `for (const req of exitPlanModes)` 子循环 + 删 `targetMode: batchTargetMode` / `decision: 'keep-planning'` 路径
  - `batchTooltip` 文案改：`!isSdk` 路径不变；`batchableCount === 0` 分支改「仅剩需要你逐条处理的计划 / 问题（请展开对应行）」；正常分支去掉 plan 切档引用，改为 `批量响应 N 项权限请求；M 项计划批准 + K 个问题需要逐条处理`（仅在有 plan/ask 时追加）
  - header 行 JSX 删整段 `{exitPlanModes.length > 0 && (<select ...>...</select>)}` — 外层 `onClick stopPropagation` 的 div 保留包住两个按钮即可
  - 顶部 doc 注释 line 22-25 改写：明确「批量按钮仅作用于 PermissionRequest；ExitPlanModeRequest / AskUserQuestion 必须人审，不参与批量——plan 模式逐条在 ExitPlanRow 内点『批准并切到 X』/『继续规划』/『⚠️ 不再询问』，ask 逐条在 AskRow 内回答选项」

### 不变项（用户已确认）

- `PermissionRow.tsx` 单条 row 不动（`suggestions` 驱动的「始终允许」按钮保留，是单条 permission 能力，与批量无关）
- `ExitPlanRow.tsx` 不动（单条 row 的 4 档 `select` 已含 `bypassPermissions`「⚠️ 不再询问」）
- `AskRow.tsx` 不动
- IPC handlers / `session-store.ts` / `selectPendingBuckets` / `TeamDetail.PendingSection` / `ActivityFeed` 全部不动

## 验证

- `pnpm typecheck`：本次 PendingTab.tsx 0 错误（已有 2 个基线错误在 `ResolveInNewSessionDialog.tsx` 与本次无关）
- dev 起 session 触发 PermissionRequest + ExitPlanMode（`/plan` 模式）→ 切到 PendingTab：batch 行无 select 下拉、「全部允许」**只**批 permission 不批 plan、单条 `ExitPlanRow` 4 档 select 正常含「⚠️ 不再询问」
- 制造只含 ExitPlanMode 的 session：batch 按钮置灰，tooltip 「仅剩需要你逐条处理的计划 / 问题」
- 制造只含 AskUserQuestion 的 session：同上置灰
