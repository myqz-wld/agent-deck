/**
 * pending-rows barrel — 3 个待处理「行」组件 + 1 个 toolInput → DiffPayload 转换 helper，
 * 同时被 ActivityFeed（活动流时间线）与 PendingTab（集中待处理面板）复用。
 *
 * R3.E7：删 TeamPermissionRow（老 inbox 协议下线）。
 *
 * 三个 Row 接口相同：(event, payload, sessionId, agentId, isSdk, stillPending,
 * wasCancelled, onResolved)；event 仅用于显示时间戳（event.ts）。
 */
export { PermissionRow } from './PermissionRow';
export { AskRow } from './AskRow';
export { ExitPlanRow } from './ExitPlanRow';
export { toolInputToDiff } from './tool-input-diff';
