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
    const entry = item as SessionHistoryEntryDto;
    if (!entry || typeof entry !== 'object') fail('history entry');
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
    const request = item as PendingRequestDto;
    if (!request || typeof request !== 'object') fail('pending request');
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
  value: SessionRuntimeControlsDto,
  limits: FeishuGatewayLimits,
): SessionRuntimeControlsDto {
  assertBoundedCoreValue(value, limits, 'runtime controls');
  if (!value || typeof value !== 'object' || !jsonObject(value.values)) {
    fail('runtime controls');
  }
  return {
    adapterId: coreIdentifier(value.adapterId, 'runtime.adapterId', 128),
    values: value.values as JsonObject,
    revision: coreRevision(value.revision, 'runtime.revision'),
  };
}
