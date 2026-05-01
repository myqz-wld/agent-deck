import type {
  AskUserQuestionRequest,
  ExitPlanModeRequest,
  PermissionRequest,
  TeamPermissionCancelled,
  TeamPermissionRequest,
} from '@shared/types';

/**
 * AgentEvent payload 类型守卫集合（CHANGELOG_52 Step 2 / 第三轮大文件拆分）。
 *
 * 拆自 session-store.ts:85-155。9 个 isXxx 函数全部纯 type guard，无副作用，
 * 仅在 `useSessionStore.pushEvent` 内被分发使用。函数签名 / 实现完全等价于原版。
 *
 * 不变的 invariant（护栏 #16）：
 * - 9 个 guard 在 pushEvent 内的分发顺序与本文件 export 顺序无关，由 store 决定
 * - 每条 event 可能命中 0/1 个 guard（互斥），不会触发多个分支
 * - guard 必须只读、永远不抛
 */

export function isPermissionRequest(payload: unknown): payload is PermissionRequest {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    (payload as { type?: string }).type === 'permission-request' &&
    typeof (payload as { requestId?: unknown }).requestId === 'string'
  );
}

export function isTeamPermissionRequest(payload: unknown): payload is TeamPermissionRequest {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    (payload as { type?: string }).type === 'team-permission-request' &&
    typeof (payload as { requestId?: unknown }).requestId === 'string'
  );
}

export function isTeamPermissionCancelled(
  payload: unknown,
): payload is TeamPermissionCancelled {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    (payload as { type?: string }).type === 'team-permission-cancelled' &&
    typeof (payload as { requestId?: unknown }).requestId === 'string'
  );
}

export function isAskUserQuestion(payload: unknown): payload is AskUserQuestionRequest {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    (payload as { type?: string }).type === 'ask-user-question' &&
    typeof (payload as { requestId?: unknown }).requestId === 'string'
  );
}

export function isExitPlanMode(payload: unknown): payload is ExitPlanModeRequest {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    (payload as { type?: string }).type === 'exit-plan-mode' &&
    typeof (payload as { requestId?: unknown }).requestId === 'string'
  );
}

export function isPermissionCancelled(payload: unknown): payload is { requestId: string } {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    (payload as { type?: string }).type === 'permission-cancelled' &&
    typeof (payload as { requestId?: unknown }).requestId === 'string'
  );
}

export function isAskQuestionCancelled(payload: unknown): payload is { requestId: string } {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    (payload as { type?: string }).type === 'ask-question-cancelled' &&
    typeof (payload as { requestId?: unknown }).requestId === 'string'
  );
}

export function isExitPlanCancelled(payload: unknown): payload is { requestId: string } {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    (payload as { type?: string }).type === 'exit-plan-cancelled' &&
    typeof (payload as { requestId?: unknown }).requestId === 'string'
  );
}
