/**
 * pending-rows barrel — 4 个待处理「行」组件 + 1 个 toolInput → DiffPayload 转换 helper，
 * 同时被 ActivityFeed（活动流时间线）与 PendingTab（集中待处理面板）复用。
 *
 * 历史：原本三个 Row 与 toolInputToDiff 都是 ActivityFeed.tsx 的内部函数。
 * 增加 PendingTab 之后需要跨文件复用，搬到此处统一 export，逻辑零改动。
 *
 * 三个 Row 的接口均以 (event, payload, sessionId, agentId, isSdk, stillPending,
 * wasCancelled, onResolved) 为入参；event 仅用于显示时间戳（event.ts）。
 * stillPending=true 表示此 row 仍可响应，false 时按钮区域降级为「已响应 / 已取消」状态。
 * wasCancelled=true 区分「SDK 主动取消」与「用户已响应」，用于灰度文案与样式。
 *
 * onResolved 由调用方提供：通常是 store 的 resolveX(sessionId, requestId)，
 * Row 内部调 window.api.respondX 完成响应后调用，让 store 同步删掉 pending 列表里这条。
 */
export { PermissionRow } from './PermissionRow';
export { AskRow } from './AskRow';
export { ExitPlanRow } from './ExitPlanRow';
export { TeamPermissionRow } from './TeamPermissionRow';
export { toolInputToDiff } from './tool-input-diff';
