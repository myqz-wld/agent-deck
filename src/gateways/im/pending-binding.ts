import { createHash } from 'node:crypto';
import type { JsonObject, JsonValue, PendingRequestDto } from '@contracts/index';
import { redactJson, truncateUtf8 } from './redaction';

const SAFE_DISPLAY_FIELDS: Readonly<Record<PendingRequestDto['kind'], readonly string[]>> = {
  'ask-user-question': ['prompt', 'summary'],
  'diff-review': ['description', 'summary', 'title'],
  'exit-plan': ['description', 'summary', 'title'],
  permission: ['command', 'description', 'reason', 'summary', 'tool'],
};

function sortedJson(value: JsonValue): JsonValue {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortedJson);
  const output: JsonObject = {};
  for (const key of Object.keys(value).sort()) output[key] = sortedJson(value[key]);
  return output;
}

function safeDetails(request: PendingRequestDto): JsonObject {
  const details: JsonObject = {};
  for (const field of SAFE_DISPLAY_FIELDS[request.kind]) {
    const value = request.display[field];
    if (typeof value === 'string') {
      details[field] = truncateUtf8(redactJson(value) as string, 1_024);
    } else if (typeof value === 'boolean' || typeof value === 'number') {
      details[field] = value;
    }
  }
  return details;
}

export function pendingSecurityDisplay(
  request: PendingRequestDto,
  chatType: 'group' | 'p2p',
): JsonObject {
  if (chatType === 'group') {
    return {
      requestKind: request.kind,
      notice: '群聊中已隐藏敏感的 pending 详情。请使用完整客户端查看。',
    };
  }
  const projected: JsonObject = {
    requestKind: request.kind,
    sessionId: request.sessionId,
    requestId: request.id,
  };
  const details = safeDetails(request);
  if (Object.keys(details).length > 0) projected.details = details;
  const questionIds = request.display.questionIds;
  if (
    request.kind === 'ask-user-question' &&
    Array.isArray(questionIds) &&
    questionIds.every((value) => typeof value === 'string')
  ) projected.questionIds = questionIds as string[];
  return projected;
}

export function pendingContentDigest(
  request: PendingRequestDto,
  revision: number,
  chatType: 'group' | 'p2p',
): string {
  const content = sortedJson({
    revision,
    kind: request.kind,
    sessionId: request.sessionId,
    requestId: request.id,
    display: pendingSecurityDisplay(request, chatType),
  });
  return createHash('sha256').update(JSON.stringify(content), 'utf8').digest('base64url');
}
