import type { AgentEvent } from '@shared/types';
import { eventKey } from '../format';

const objectDigestCache = new WeakMap<object, string>();

/**
 * Activity row and viewer identities extend the established event key with the complete payload
 * digest. The original key keeps reloads stable; the digest closes same-millisecond fallbacks.
 */
export function activityEventIdentity(event: AgentEvent): string {
  return `${eventKey(event)}:${payloadDigest(event.payload)}:${event.source ?? ''}:${event.hookOrigin ?? ''}`;
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
