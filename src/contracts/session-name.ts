import { isJsonObject } from './json';

export const SESSION_NAME_MAX_BYTES = 512;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
export interface SessionNameUpdateParams { sessionId: string; title: string; expectedTitle: string | null }
export interface SessionNameUpdateResult { sessionId: string; title: string; revision: number }

export function parseSessionName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() ||
    new TextEncoder().encode(value).byteLength > SESSION_NAME_MAX_BYTES || CONTROL.test(value)) {
    throw new Error('Session name must be trimmed, non-empty, single-line text within 512 UTF-8 bytes');
  }
  return value;
}

export function parseSessionNameUpdate(value: unknown): SessionNameUpdateParams {
  if (!isJsonObject(value) || Object.keys(value).sort().join(',') !== 'expectedTitle,sessionId,title' ||
    typeof value.sessionId !== 'string' || value.sessionId.length > 256 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@-]*$/.test(value.sessionId)) throw new Error('Invalid session name update');
  if (value.expectedTitle !== null && (typeof value.expectedTitle !== 'string' ||
    new TextEncoder().encode(value.expectedTitle).byteLength > SESSION_NAME_MAX_BYTES || CONTROL.test(value.expectedTitle))) {
    throw new Error('Expected session name must match the last read title or null');
  }
  return { sessionId: value.sessionId, title: parseSessionName(value.title), expectedTitle: value.expectedTitle };
}

export function parseSessionNameUpdateResult(value: unknown): SessionNameUpdateResult {
  if (!isJsonObject(value) || Object.keys(value).sort().join(',') !== 'revision,sessionId,title' ||
    typeof value.sessionId !== 'string' || value.sessionId.length > 256 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@-]*$/.test(value.sessionId) ||
    !Number.isSafeInteger(value.revision) || Number(value.revision) < 0) throw new Error('Invalid session name result');
  return { sessionId: value.sessionId, title: parseSessionName(value.title), revision: Number(value.revision) };
}
