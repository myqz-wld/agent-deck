import type { JsonValue } from './json';
import { SessionConsoleContractError } from './session-console-common';

export const SESSION_EVENT_MAX_ITEMS = 100;
export const SESSION_EVENT_MAX_PAYLOAD_BYTES = 256 * 1024;
export const SESSION_EVENT_MAX_RESPONSE_BYTES = 3 * 1024 * 1024;
export const SESSION_EVENT_MAX_JSON_DEPTH = 32;
export const SESSION_EVENT_MAX_JSON_NODES = 16_384;

export type SessionEventKind =
  | 'session-start'
  | 'message'
  | 'message-display'
  | 'thinking'
  | 'tool-use-start'
  | 'tool-use-end'
  | 'file-changed'
  | 'context-compaction-start'
  | 'context-compaction-end'
  | 'subagent-start'
  | 'subagent-end'
  | 'waiting-for-user'
  | 'finished'
  | 'session-end'
  | 'team-task-created'
  | 'team-task-completed'
  | 'team-teammate-idle'
  | 'context-usage'
  | 'token-usage';

export interface SessionEventDto {
  id: number;
  sessionId: string;
  agentId: string;
  kind: SessionEventKind;
  payload: JsonValue;
  ts: number;
}

export interface SessionEventListParams {
  sessionId: string;
  limit: number;
}

export interface SessionEventListResult {
  events: SessionEventDto[];
  revision: number;
  truncated: boolean;
}

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/u;
const EVENT_KINDS = new Set<SessionEventKind>([
  'session-start', 'message', 'message-display', 'thinking', 'tool-use-start',
  'tool-use-end', 'file-changed', 'context-compaction-start',
  'context-compaction-end', 'subagent-start', 'subagent-end', 'waiting-for-user',
  'finished', 'session-end', 'team-task-created', 'team-task-completed',
  'team-teammate-idle', 'context-usage', 'token-usage',
]);

function fail(field: string): never {
  throw new SessionConsoleContractError(field);
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(field);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(field);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], field: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(field);
  }
}

function bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function token(value: unknown, field: string, maximum = 256): string {
  if (
    typeof value !== 'string' || !TOKEN.test(value) || CONTROL.test(value) ||
    bytes(value) > maximum
  ) fail(field);
  return value;
}

function integer(value: unknown, field: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    fail(field);
  }
  return value as number;
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') fail(field);
  return value;
}

function boundedJson(value: unknown, field: string): JsonValue {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > SESSION_EVENT_MAX_JSON_NODES || current.depth > SESSION_EVENT_MAX_JSON_DEPTH) {
      fail(field);
    }
    const item = current.value;
    if (
      item === null || typeof item === 'string' || typeof item === 'boolean' ||
      (typeof item === 'number' && Number.isFinite(item))
    ) continue;
    if (Array.isArray(item)) {
      for (const child of item) stack.push({ value: child, depth: current.depth + 1 });
      continue;
    }
    const raw = object(item, field);
    for (const [key, child] of Object.entries(raw)) {
      if (CONTROL.test(key) || bytes(key) > 256) fail(field);
      stack.push({ value: child, depth: current.depth + 1 });
    }
  }
  let encoded: string;
  try { encoded = JSON.stringify(value); } catch { fail(field); }
  if (bytes(encoded!) > SESSION_EVENT_MAX_PAYLOAD_BYTES) fail(field);
  return value as JsonValue;
}

export function parseSessionEventListParams(value: unknown): SessionEventListParams {
  const raw = object(value, 'session.events.list.params');
  exactKeys(raw, ['limit', 'sessionId'], 'session.events.list.params');
  return {
    sessionId: token(raw.sessionId, 'session.events.list.sessionId'),
    limit: integer(raw.limit, 'session.events.list.limit', 1, SESSION_EVENT_MAX_ITEMS),
  };
}

function event(value: unknown, sessionId: string, index: number): SessionEventDto {
  const field = `session.events.list.events[${index}]`;
  const raw = object(value, field);
  exactKeys(raw, ['agentId', 'id', 'kind', 'payload', 'sessionId', 'ts'], field);
  const parsedSessionId = token(raw.sessionId, `${field}.sessionId`);
  if (parsedSessionId !== sessionId || !EVENT_KINDS.has(raw.kind as SessionEventKind)) fail(field);
  return {
    id: integer(raw.id, `${field}.id`, 1),
    sessionId: parsedSessionId,
    agentId: token(raw.agentId, `${field}.agentId`),
    kind: raw.kind as SessionEventKind,
    payload: boundedJson(raw.payload, `${field}.payload`),
    ts: integer(raw.ts, `${field}.ts`),
  };
}

export function parseSessionEventListResult(
  value: unknown,
  sessionId: string,
  limit: number,
): SessionEventListResult {
  const raw = object(value, 'session.events.list.result');
  exactKeys(raw, ['events', 'revision', 'truncated'], 'session.events.list.result');
  if (!Array.isArray(raw.events) || raw.events.length > limit) fail('session.events.list.events');
  const events = raw.events.map((item, index) => event(item, sessionId, index));
  if (new Set(events.map((item) => item.id)).size !== events.length) {
    fail('session.events.list.events');
  }
  const result = {
    events,
    revision: integer(raw.revision, 'session.events.list.revision'),
    truncated: boolean(raw.truncated, 'session.events.list.truncated'),
  };
  if (bytes(JSON.stringify(result)) > SESSION_EVENT_MAX_RESPONSE_BYTES) {
    fail('session.events.list.result');
  }
  return result;
}
