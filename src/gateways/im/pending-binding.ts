import { createHash } from 'node:crypto';
import type { JsonObject, JsonValue, PendingRequestDto } from '@contracts/index';
import { redactJson, truncateUtf8 } from './redaction';

function sortedJson(value: JsonValue): JsonValue {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortedJson);
  const output: JsonObject = {};
  for (const key of Object.keys(value).sort()) output[key] = sortedJson(value[key]);
  return output;
}

export function pendingSecurityDisplay(request: PendingRequestDto): JsonObject {
  const redacted = redactJson(request.display) as JsonObject;
  const encoded = JSON.stringify(redacted);
  const details = new TextEncoder().encode(encoded).byteLength <= 4_096
    ? redacted
    : { summary: truncateUtf8(encoded, 4_096) };
  return {
    requestKind: request.kind,
    sessionId: request.sessionId,
    requestId: request.id,
    details,
  };
}

export function pendingContentDigest(
  request: PendingRequestDto,
  revision: number,
): string {
  const content = sortedJson({
    revision,
    kind: request.kind,
    sessionId: request.sessionId,
    requestId: request.id,
    display: pendingSecurityDisplay(request),
  });
  return createHash('sha256').update(JSON.stringify(content), 'utf8').digest('base64url');
}
