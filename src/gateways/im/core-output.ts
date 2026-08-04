import {
  type JsonObject,
  type JsonValue,
  type PendingRequestDto,
  type SessionHistoryEntryDto,
  type SessionListItemDto,
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

function coreText(value: unknown, field: string, maximumBytes: number): string {
  if (
    typeof value !== 'string' ||
    new TextEncoder().encode(value).byteLength > maximumBytes ||
    CONTROL.test(value)
  ) {
    fail(field);
  }
  return value;
}

export function validateSessionItem(
  value: SessionListItemDto,
  limits: FeishuGatewayLimits,
  expectedId?: string,
): SessionListItemDto {
  assertBoundedCoreValue(value, limits, 'session');
  if (!value || typeof value !== 'object') fail('session');
  const id = coreIdentifier(value.id, 'session.id');
  if (expectedId !== undefined && id !== expectedId) fail('session.id');
  const title = value.title === null ? null : coreText(value.title, 'session.title', 512);
  const cwd = coreText(value.cwd, 'session.cwd', 4_096);
  if (cwd.length === 0) fail('session.cwd');
  return {
    id,
    adapterId: coreIdentifier(value.adapterId, 'session.adapterId', 128),
    cwd,
    title,
    status: coreIdentifier(value.status, 'session.status', 128),
    createdAt: coreTime(value.createdAt, 'session.createdAt'),
    updatedAt: coreTime(value.updatedAt, 'session.updatedAt'),
  };
}

export function validateSessionList(
  value: unknown,
  limits: FeishuGatewayLimits,
): SessionListItemDto[] {
  assertBoundedCoreValue(value, limits, 'session list', limits.maxSessionResults);
  return (value as SessionListItemDto[]).map((item) => validateSessionItem(item, limits));
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
