import { resolve } from 'node:path';
import type { AgentEvent } from '@shared/types';

export const ALLOWED_FENCED_EVENTS = new Set<AgentEvent['kind']>([
  'finished',
  'session-end',
  'context-usage',
  'token-usage',
]);

export function eventPayload(event: AgentEvent): Record<string, unknown> {
  return event.payload && typeof event.payload === 'object'
    ? (event.payload as Record<string, unknown>)
    : {};
}

export function isSuccessfulToolResult(event: AgentEvent): boolean {
  const value = eventPayload(event);
  const status = typeof value.status === 'string' ? value.status.toLowerCase() : '';
  return (
    (value.error == null || value.error === false) &&
    !['failed', 'error', 'denied', 'cancelled', 'canceled'].includes(status)
  );
}

export function worktreeErrorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isSameWorktreePath(left: string | null, right: string): boolean {
  return left !== null && resolve(left) === resolve(right);
}
