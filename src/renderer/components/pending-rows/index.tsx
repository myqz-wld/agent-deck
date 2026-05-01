/**
 * pending-rows barrel — 4 个待处理「行」组件 + 1 个 toolInput → DiffPayload 转换 helper，
 * 同时被 ActivityFeed（活动流时间线）与 PendingTab（集中待处理面板）复用。
 *
 * 历史：原本三个 Row（PermissionRow / AskRow / ExitPlanRow）与 toolInputToDiff 都是
 * ActivityFeed.tsx 的内部函数。增加 PendingTab 之后需要跨文件复用，搬到此处统一 export，
 * 逻辑零改动。CHANGELOG_45 起新增 TeamPermissionRow（teammate inbox 权限请求）成为第 4 个 Row。
 *
 * 三个 SDK Row 的接口相同：(event, payload, sessionId, agentId, isSdk, stillPending,
 * wasCancelled, onResolved)；event 仅用于显示时间戳（event.ts）。
 * stillPending=true 表示此 row 仍可响应，false 时按钮区域降级为「已响应 / 已取消」状态。
 * wasCancelled=true 区分「SDK 主动取消」与「用户已响应」，用于灰度文案与样式。
 *
 * onResolved 由调用方提供：通常是 store 的 resolveX(sessionId, requestId)，
 * Row 内部调 window.api.respondX 完成响应后调用，让 store 同步删掉 pending 列表里这条。
 *
 * **TeamPermissionRow 例外**：走 inbox 文件协议而非 SDK canUseTool，props 不含 agentId / isSdk
 * （inbox 走 teamName + fromMemberSlug 路由），且 wasCancelled 可选 + 多一个 onJump prop（PendingTab
 * 跳 lead session detail）。
 */
export { PermissionRow } from './PermissionRow';
export { AskRow } from './AskRow';
export { ExitPlanRow } from './ExitPlanRow';
export { TeamPermissionRow } from './TeamPermissionRow';
export { toolInputToDiff } from './tool-input-diff';
