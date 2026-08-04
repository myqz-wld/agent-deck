import type { AgentEvent } from '@shared/types';

const objectDigestCache = new WeakMap<object, string>();

/**
 * Uses the durable SQLite id when available and a complete stable digest for live-only events.
 * This identity is shared by store deduplication and React row keys.
 */
export function agentEventIdentity(event: AgentEvent): string {
  const storedId = (event as AgentEvent & { id?: unknown }).id;
  if (typeof storedId === 'number' && Number.isSafeInteger(storedId) && storedId > 0) {
    return `stored-event:${storedId}`;
  }
  return `${baseEventIdentity(event)}:${payloadDigest(event.payload)}:${event.source ?? ''}:${event.hookOrigin ?? ''}`;
}

function baseEventIdentity(event: AgentEvent): string {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  if (event.kind === 'tool-use-start' || event.kind === 'tool-use-end') {
    const toolUseId = typeof payload.toolUseId === 'string' ? payload.toolUseId : '';
    if (toolUseId) return `${event.kind}:${toolUseId}`;
  }
  if (event.kind === 'waiting-for-user') {
    const type = typeof payload.type === 'string' ? payload.type : '';
    const requestId = typeof payload.requestId === 'string' ? payload.requestId : '';
    if (requestId) return `waiting:${type}:${requestId}`;
  }
  return `${event.sessionId}:${event.kind}:${event.ts}`;
}

function payloadDigest(payload: unknown): string {
  if (payload !== null && typeof payload === 'object') {
    const cached = objectDigestCache.get(payload);
    if (cached) return cached;
    const digest = hashText(serializePayload(payload));
    objectDigestCache.set(payload, digest);
    return digest;
  }
  return hashText(serializePayload(payload));
}

function serializePayload(payload: unknown): string {
  try {
    const serialized = JSON.stringify(payload);
    return serialized === undefined ? String(payload) : serialized;
  } catch {
    return Object.prototype.toString.call(payload);
  }
}

function hashText(value: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(36)}${(second >>> 0).toString(36)}`;
}
