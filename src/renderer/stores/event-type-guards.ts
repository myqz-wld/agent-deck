import type {
  AskUserQuestionRequest,
  ExitPlanModeRequest,
  PermissionRequest,
} from '@shared/types';

/**
 * AgentEvent payload 类型守卫集合。
 *
 * R3.E7：删 isTeamPermissionRequest / isTeamPermissionCancelled（老 inbox 协议下线，
 * 永不再出现 type='team-permission-*' payload）。
 */

export function isPermissionRequest(payload: unknown): payload is PermissionRequest {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    (payload as { type?: string }).type === 'permission-request' &&
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
