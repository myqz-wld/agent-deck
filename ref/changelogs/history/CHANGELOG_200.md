# CHANGELOG_200 — pending tab resume 可见性 + 新建会话选项记忆

> plan `pending-tab-resume-and-new-session-default-20260602`

两个用户报修（2026-06-02），单 plan 一起收口。

## 概要

- **BUG 1**：SDK 会话 resume 后，会话详情页「活动」tab 看不到首条 AskUserQuestion 等 in-process 等待请求（pending tab 看得见）。修根因：ActivityFeed 加 `onSessionUpserted` 监听，resume / 重连 / lifecycle 切换时强制重拉 `listAdapterPending` 同步 in-process 等待态进 store。**用户明确拒绝**在详情页顶部加额外 banner，保持现有 5 个 tab 不动。
- **BUG 2**：issue 详情「起新会话解决」弹窗里权限模式 / 系统沙盒没记忆，每次重选。修法：建 `useLastSessionDefaults` 模块顶层 `let` store（不持久化，跨重启丢），按 adapter 维度分桶（claude-code / codex-cli 互不串味），NewSessionDialog + ResolveInNewSessionDialog 共享同一组 last-used。

## 变更内容

### BUG 1 修复

- **`src/renderer/components/activity-feed/index.tsx`**：新增一个 `useEffect`，deps = `[sessionId, agentId, isSdk, setPending]`，内部挂 `onSessionUpserted`：当同 sessionId 到达时（resume / 重连 / lifecycle 切换都会 emit）调 `listAdapterPending(agentId, sessionId)` 调一次 `setPendingRequests` store action 把 in-process 等待态覆盖进 store。**幂等**：setPendingRequests 内部 length===0 时 delete key、否则 set（line 392-407），与 pushEvent 增量更新同款语义。**不引入新组件 / 不动 SessionDetail 顶部 banner（用户明确反对）**。

### BUG 2 修复

- **新增 `src/renderer/hooks/useLastSessionDefaults.ts`**（58 行）：
  - 模块顶层 `let store: Record<AdapterId, Defaults>` 存记忆
  - `getLastDefaults(adapter)`：读本 adapter 维度（claude-code 读 permissionMode + claudeCodeSandbox / codex-cli 读 codexSandbox），跨 adapter 字段故意不返
  - `setLastDefaults(adapter, patch)`：merge 写 + adapter 隔离（codex 写 sandbox 不允许串到 claude）
  - **不**走 AppSettings / localStorage（用户明确"自动记住上次选的"不要 settings 默认值；重启 app 后清空符合 issue 解决场景的"每次重新审视"语义）
- **`src/renderer/components/NewSessionDialog.tsx`**：
  - 新增 `useEffect` deps `[open, agentId]`：dialog 重开 + adapter 切换时从 `getLastDefaults(agentId)` 拉上次值
  - 三个 `select` onChange 加 `setLastDefaults(agentId, { field: v })` 写回
  - `PermissionModeChoice` 类型从 sandbox-options.ts 导入（之前 inline `'default' | 'acceptEdits' | 'plan' | 'bypassPermissions'`）
- **`src/renderer/components/ResolveInNewSessionDialog.tsx`**：
  - `useState('')` 三处初值改为 `useState<...>('default' | '')`（permissionMode 改为 'default' / codexSandbox / claudeCodeSandbox 仍 ''，与 NewSessionDialog 对齐）
  - 新增 `useEffect` deps `[adapter]`：adapter 切换时从 `getLastDefaults(adapter)` 拉
  - 三个 `select` onChange 写回 `setLastDefaults(adapter, { field: v })`
  - `<option value="">跟随默认</option>` 三处删除（现在永远是有效值不是 ''）
  - handleSubmit `permissionMode ?` 判空改为 `permissionMode !== 'default'`（'default' 仍视为"跟随默认"不传给主进程，与 IPC 契约一致）

## 设计决策

- **D1 BUG 1 只修根因，不在详情页加 banner**（用户明确反对）。现状：ActivityFeed useEffect deps 包含 sessionId/agentId/isSdk，resume 路径下 SessionDetail 不重 mount，listAdapterPending 不会重跑。修法：onSessionUpserted 触发强制重拉。
- **D2 BUG 2 跨重启不持久**（用户明确"自动记住上次选的"，不要 settings 默认值）。模块顶层 `let` 跨 mount 持久，跨 app 重启由 JS 上下文销毁自然清空。
- **D3 BUG 2 跨 adapter 分桶**（N3 不串味）。claude-code 选 'workspace-write' 系统沙盒不串到 codex；codex 选 'workspace-write' sandbox 不串到 claude。
- **D4 复用现有 setPendingRequests 幂等性**（line 392-407 length===0 delete key），不做 merge 写。多次 onSessionUpserted 触发覆盖写无副作用。

## 验证

- `pnpm typecheck` 干净通过（node + web 两 project）
- 计划改的文件全部 typecheck 验证 + 现有契约不动
- Plan 文件：`ref/plans/pending-tab-resume-and-new-session-default-20260602.md`（archive_plan 同步归档）

## 已知踩坑 / 残留

- onSessionUpserted 在 lifecycle 转 dormant 时也会 emit（不是只在 resume 触发），重复拉 listAdapterPending 不会造成 bug（store action 幂等 + 全量覆盖语义），但 IPC 调用频次略增。可接受 — 同一会话 lifecycle 切换低频。
- BUG 2 不写 localStorage：用户如果清空 localStorage / 应用重装（罕见），记忆自然清空。不持久化的语义与"自动记住上次选的" 用户意图一致（明确说不要走 settings）。
