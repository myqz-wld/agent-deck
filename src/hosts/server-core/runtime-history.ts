import { isJsonObject, isJsonValue, type JsonObject, type JsonValue } from '@contracts/index';
import type { StoredAgentEvent } from '@shared/types';

import { canonicalJson } from './runtime-validation';

const HISTORY_CONTENT_BYTES = 8 * 1024;

function clipped(value: string): string {
  const bytes = Buffer.from(value);
  if (bytes.byteLength <= HISTORY_CONTENT_BYTES) return value;
  return `${bytes.subarray(0, HISTORY_CONTENT_BYTES).toString('utf8')}…`;
}

export function serverCoreHistoryEntry(event: StoredAgentEvent): JsonObject {
  const payload = isJsonObject(event.payload) ? event.payload : null;
  const role = payload && ['assistant', 'system', 'user'].includes(String(payload.role))
    ? String(payload.role)
    : 'system';
  let content: JsonValue;
  if (payload && typeof payload.text === 'string') content = clipped(payload.text);
  else if (isJsonValue(event.payload)) content = clipped(canonicalJson(event.payload));
  else content = '[event unavailable]';
  return {
    id: `event-${event.id}`,
    sessionId: event.sessionId,
    sequence: event.id,
    role,
    content,
    createdAt: event.ts,
  };
}
