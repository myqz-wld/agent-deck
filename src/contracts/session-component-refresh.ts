import { isJsonObject } from './json';
import type { SessionComponentAction, SessionComponentRefreshStatus } from '@shared/session-component-refresh';

export interface SessionComponentRefreshParams { sessionId: string; action: SessionComponentAction }
export interface SessionComponentRefreshResponse { status: SessionComponentRefreshStatus; revision: number }
export function parseSessionComponentAction(value: unknown): SessionComponentAction {
  if (value !== 'refresh' && value !== 'cancel') throw new Error('扩展刷新操作无效。');
  return value;
}
export function parseSessionComponentRefreshParams(value: unknown): SessionComponentRefreshParams {
  if (!isJsonObject(value) || Object.keys(value).some(key => !['sessionId', 'action'].includes(key))
    || typeof value.sessionId !== 'string' || !value.sessionId || value.sessionId.length > 256) {
    throw new Error('扩展刷新目标无效。');
  }
  return { sessionId: value.sessionId, action: parseSessionComponentAction(value.action) };
}
export function parseSessionComponentRefreshResponse(value: unknown): SessionComponentRefreshResponse {
  if (!isJsonObject(value) || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0
    || !isJsonObject(value.status)) throw new Error('扩展刷新结果无效。');
  const status = value.status;
  if (!['idle', 'queued', 'applying', 'completed', 'partial', 'failed', 'cancelled'].includes(String(status.phase))
    || !Number.isSafeInteger(status.revision) || Number(status.revision) < 0 || !Array.isArray(status.results)
    || status.results.length > 4 || (status.detail !== undefined && (typeof status.detail !== 'string' || status.detail.length > 1024))) {
    throw new Error('扩展刷新状态无效。');
  }
  for (const result of status.results) {
    if (!isJsonObject(result) || !['mcp', 'skills', 'plugins', 'instructions'].includes(String(result.component))
      || !['updated', 'unchanged', 'new-session-required', 'cache-deferred', 'failed'].includes(String(result.outcome))
      || typeof result.detail !== 'string' || result.detail.length > 1024) throw new Error('组件刷新结果无效。');
  }
  // Native metadata is not carried across the UI control response; detailed evidence uses events.
  return { revision: Number(value.revision), status: {
    phase: status.phase as SessionComponentRefreshStatus['phase'], revision: Number(status.revision),
    results: status.results as unknown as SessionComponentRefreshStatus['results'],
    ...(typeof status.detail === 'string' ? { detail: status.detail } : {}),
  } };
}
