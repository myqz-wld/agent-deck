import {
  type JsonObject,
  type JsonValue,
  type PendingRequestDto,
  parseProjectListResult,
  parseProjectResolveResult,
  parseSessionConsoleCreateResult,
  parseSessionConsoleGetResult,
  parseSessionConsoleListResult,
  type ProjectListResult,
  type ProjectResolveResult,
  type SessionHistoryEntryDto,
  type SessionConsoleCreateResult,
  type SessionConsoleGetResult,
  type SessionConsoleListResult,
  type SessionRuntimeControlsDto,
} from '@contracts/index';
import { assertBoundedCoreValue } from './core-bounds';
import { FeishuGatewayError } from './errors';
import type { FeishuGatewayLimits } from './types';

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@/$-]*$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const PENDING_KINDS = new Set(['ask-user-question', 'diff-review', 'exit-plan', 'permission']);
const PENDING_STATES = new Set(['cancelled', 'denied', 'expired', 'pending', 'resolved', 'stale']);

function fail(field: string): never {
  throw new FeishuGatewayError('invalid_core_response', `Core returned malformed ${field}`);
}

function jsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactObject(
  value: unknown,
  fields: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!jsonObject(value)) fail(label);
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (
    actual.length !== expected.length ||
    actual.some((field, index) => field !== expected[index])
  ) fail(label);
  return value;
}

export function coreIdentifier(value: unknown, field: string, maximumBytes = 256): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    new TextEncoder().encode(value).byteLength > maximumBytes ||
    !TOKEN.test(value)
  ) {
    fail(field);
  }
  return value;
}

export function coreRevision(value: unknown, field = 'revision'): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail(field);
  return value as number;
}

function coreTime(value: unknown, field: string): number {
  return coreRevision(value, field);
}

function contractResult<T>(
  value: unknown,
  limits: FeishuGatewayLimits,
  field: string,
  parse: () => T,
): T {
  assertBoundedCoreValue(value, limits, field);
  try {
    return parse();
  } catch {
    fail(field);
  }
}

export function validateSessionConsoleListResult(
  value: unknown,
  requestedLimit: number,
  limits: FeishuGatewayLimits,
): SessionConsoleListResult {
  return contractResult(value, limits, 'session-console list', () =>
    parseSessionConsoleListResult(value, requestedLimit));
}

export function validateSessionConsoleGetResult(
  value: unknown,
  expectedId: string,
  limits: FeishuGatewayLimits,
): SessionConsoleGetResult {
  const result = contractResult(value, limits, 'session-console get', () =>
    parseSessionConsoleGetResult(value));
  if (result.session && result.session.id !== expectedId) fail('session-console get session.id');
  return result;
}

export function validateProjectListResult(
  value: unknown,
  requestedLimit: number,
  limits: FeishuGatewayLimits,
): ProjectListResult {
  return contractResult(value, limits, 'project list', () =>
    parseProjectListResult(value, requestedLimit));
}

export function validateProjectResolveResult(
  value: unknown,
  expectedAlias: string,
  limits: FeishuGatewayLimits,
): ProjectResolveResult {
  const result = contractResult(value, limits, 'project resolve', () =>
    parseProjectResolveResult(value));
  if (result.project && result.project.alias !== expectedAlias) fail('project resolve alias');
  return result;
}

export function validateSessionConsoleCreateResult(
  value: unknown,
  limits: FeishuGatewayLimits,
): SessionConsoleCreateResult {
  return contractResult(value, limits, 'session-console create', () =>
    parseSessionConsoleCreateResult(value));
}

export function validateHistoryEntries(
  value: unknown,
  sessionId: string,
  limits: FeishuGatewayLimits,
): SessionHistoryEntryDto[] {
  assertBoundedCoreValue(value, limits, 'history entries', limits.maxHistoryEntries);
  return (value as SessionHistoryEntryDto[]).map((item) => {
    const entry = exactObject(
      item,
      ['content', 'createdAt', 'id', 'role', 'sequence', 'sessionId'],
      'history entry',
    ) as unknown as SessionHistoryEntryDto;
    if (!['assistant', 'system', 'user'].includes(entry.role)) fail('history.role');
    const validatedSessionId = coreIdentifier(entry.sessionId, 'history.sessionId');
    if (validatedSessionId !== sessionId) fail('history.sessionId');
    return {
      id: coreIdentifier(entry.id, 'history.id'),
      sessionId: validatedSessionId,
      sequence: coreRevision(entry.sequence, 'history.sequence'),
      role: entry.role,
      content: entry.content as JsonValue,
      createdAt: coreTime(entry.createdAt, 'history.createdAt'),
    };
  });
}

export function validatePendingRequests(
  value: unknown,
  sessionId: string,
  limits: FeishuGatewayLimits,
): PendingRequestDto[] {
  assertBoundedCoreValue(value, limits, 'pending requests', limits.maxPendingResults);
  return (value as PendingRequestDto[]).map((item) => {
    const request = exactObject(
      item,
      ['createdAt', 'display', 'expiresAt', 'id', 'kind', 'sessionId', 'status'],
      'pending request',
    ) as unknown as PendingRequestDto;
    const validatedSessionId = coreIdentifier(request.sessionId, 'pending.sessionId');
    if (validatedSessionId !== sessionId) fail('pending.sessionId');
    if (!PENDING_KINDS.has(request.kind)) fail('pending.kind');
    if (!PENDING_STATES.has(request.status)) fail('pending.status');
    if (!jsonObject(request.display)) fail('pending.display');
    const expiresAt = request.expiresAt === null
      ? null
      : coreTime(request.expiresAt, 'pending.expiresAt');
    const questionIds = (request.display as JsonObject).questionIds;
    if (
      request.kind === 'ask-user-question' &&
      questionIds !== undefined &&
      (!Array.isArray(questionIds) ||
        questionIds.length === 0 ||
        questionIds.length > 32 ||
        questionIds.some(
          (item) =>
            typeof item !== 'string' ||
            item.length === 0 ||
            new TextEncoder().encode(item).byteLength > 128 ||
            CONTROL.test(item),
        ) ||
        new Set(questionIds).size !== questionIds.length)
    ) {
      fail('pending.display.questionIds');
    }
    return {
      id: coreIdentifier(request.id, 'pending.id'),
      sessionId: validatedSessionId,
      kind: request.kind,
      status: request.status,
      createdAt: coreTime(request.createdAt, 'pending.createdAt'),
      expiresAt,
      display: request.display as JsonObject,
    };
  });
}

export function validateRuntimeControls(
  value: unknown,
  limits: FeishuGatewayLimits,
): SessionRuntimeControlsDto {
  assertBoundedCoreValue(value, limits, 'runtime controls');
  const record = exactObject(value, ['adapterId', 'revision', 'values'], 'runtime controls');
  if (!jsonObject(record.values)) {
    fail('runtime controls');
  }
  return {
    adapterId: coreIdentifier(record.adapterId, 'runtime.adapterId', 128),
    values: record.values as JsonObject,
    revision: coreRevision(record.revision, 'runtime.revision'),
  };
}

export function validateHistoryResult(
  value: unknown,
  sessionId: string,
  limits: FeishuGatewayLimits,
) {
  return contractResult(value, limits, 'history result', () => {
    const result = exactObject(value, ['entries', 'nextCursor', 'revision'], 'history result');
    return {
      entries: validateHistoryEntries(result.entries, sessionId, limits),
      nextCursor: result.nextCursor === null
        ? null
        : coreIdentifier(result.nextCursor, 'history.nextCursor', 512),
      revision: coreRevision(result.revision),
    };
  });
}

export function validatePendingListResult(
  value: unknown,
  sessionId: string,
  limits: FeishuGatewayLimits,
) {
  return contractResult(value, limits, 'pending list result', () => {
    const result = exactObject(value, ['requests', 'revision'], 'pending list result');
    return {
      requests: validatePendingRequests(result.requests, sessionId, limits),
      revision: coreRevision(result.revision),
    };
  });
}

export function validateSendResult(value: unknown, limits: FeishuGatewayLimits) {
  return contractResult(value, limits, 'session send result', () => {
    const result = exactObject(value, ['messageId', 'revision', 'sequence'], 'session send result');
    return {
      messageId: coreIdentifier(result.messageId, 'session.send.messageId'),
      sequence: coreRevision(result.sequence, 'session.send.sequence'),
      revision: coreRevision(result.revision),
    };
  });
}

export function validateRuntimeUpdateResult(value: unknown, limits: FeishuGatewayLimits) {
  return contractResult(value, limits, 'runtime update result', () => {
    const result = exactObject(
      value,
      ['controls', 'effect', 'replacementSessionId'],
      'runtime update result',
    );
    if (!['handoff-required', 'hot-applied', 'restart-required'].includes(String(result.effect))) {
      fail('runtime effect');
    }
    return {
      controls: validateRuntimeControls(result.controls, limits),
      effect: result.effect as 'handoff-required' | 'hot-applied' | 'restart-required',
      replacementSessionId: result.replacementSessionId === null
        ? null
        : coreIdentifier(result.replacementSessionId, 'runtime.replacementSessionId'),
    };
  });
}

export function validateSubscriptionResult(value: unknown, limits: FeishuGatewayLimits) {
  return contractResult(value, limits, 'subscription result', () => {
    const result = exactObject(value, ['revision', 'subscribed'], 'subscription result');
    if (typeof result.subscribed !== 'boolean') fail('subscription result');
    return { subscribed: result.subscribed, revision: coreRevision(result.revision) };
  });
}

export function validatePendingRespondResult(value: unknown, limits: FeishuGatewayLimits) {
  return contractResult(value, limits, 'pending response result', () => {
    const result = exactObject(value, ['revision', 'status'], 'pending response result');
    if (!['cancelled', 'denied', 'expired', 'resolved', 'stale'].includes(String(result.status))) {
      fail('pending response status');
    }
    return {
      status: result.status as Exclude<PendingRequestDto['status'], 'pending'>,
      revision: coreRevision(result.revision),
    };
  });
}
