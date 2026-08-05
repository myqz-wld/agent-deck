import { isJsonObject } from '@contracts/index';
import {
  hasMalformedRemoteHostQuestionIds,
  REMOTE_HOST_MAX_PENDING_ITEMS,
  type RemoteHostAcceptedResultDto,
  type RemoteHostHistoryEntryDto,
  type RemoteHostHistoryPageDto,
  type RemoteHostPendingListDto,
  type RemoteHostPendingRequestDto,
  type RemoteHostPendingResponseResultDto,
  type RemoteHostRuntimeControlsDto,
  type RemoteHostRuntimeUpdateResultDto,
  type RemoteHostSendResultDto,
} from '@shared/remote-host';

import {
  parseRemoteHostJsonObject,
  parseRemoteHostJsonValue,
  RemoteHostInputError,
} from './input-validation';

const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

function object(value: unknown, field: string): Record<string, unknown> {
  if (!isJsonObject(value)) throw new RemoteHostInputError(field, 'invalid host result');
  return value;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  field: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new RemoteHostInputError(field, 'invalid host result shape');
  }
}

function token(value: unknown, field: string, max = 512): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    new TextEncoder().encode(value).byteLength > max ||
    !SAFE_TOKEN.test(value)
  ) {
    throw new RemoteHostInputError(field, 'invalid host result token');
  }
  return value;
}

function integer(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new RemoteHostInputError(field, 'invalid host result integer');
  }
  return value as number;
}

function nullableCursor(value: unknown, field: string): string | null {
  return value === null ? null : token(value, field);
}

function parseHistoryEntry(value: unknown): RemoteHostHistoryEntryDto {
  const raw = object(value, 'history.entry');
  exactKeys(raw, ['content', 'createdAt', 'id', 'role', 'sequence', 'sessionId'], 'history.entry');
  if (raw.role !== 'assistant' && raw.role !== 'system' && raw.role !== 'user') {
    throw new RemoteHostInputError('history.entry.role', 'invalid host result role');
  }
  return {
    id: token(raw.id, 'history.entry.id', 256),
    sessionId: token(raw.sessionId, 'history.entry.sessionId', 256),
    sequence: integer(raw.sequence, 'history.entry.sequence'),
    role: raw.role,
    content: parseRemoteHostJsonValue(raw.content, 'history.entry.content'),
    createdAt: integer(raw.createdAt, 'history.entry.createdAt'),
  };
}

export function parseRemoteHostHistoryPageResult(
  value: unknown,
  limit: number,
  sessionId: string,
): RemoteHostHistoryPageDto {
  const raw = object(value, 'history');
  exactKeys(raw, ['entries', 'nextCursor', 'revision'], 'history');
  if (!Array.isArray(raw.entries) || raw.entries.length > limit) {
    throw new RemoteHostInputError('history.entries', 'host exceeded requested bound');
  }
  const entries = raw.entries.map(parseHistoryEntry);
  if (
    new Set(entries.map((entry) => entry.id)).size !== entries.length ||
    entries.some((entry) => entry.sessionId !== sessionId)
  ) {
    throw new RemoteHostInputError('history.entries', 'host result identity mismatch');
  }
  return {
    entries,
    nextCursor: nullableCursor(raw.nextCursor, 'history.nextCursor'),
    revision: integer(raw.revision, 'history.revision'),
  };
}

export function parseRemoteHostSendResult(value: unknown): RemoteHostSendResultDto {
  const raw = object(value, 'send');
  exactKeys(raw, ['messageId', 'revision', 'sequence'], 'send');
  return {
    messageId: token(raw.messageId, 'send.messageId', 256),
    sequence: integer(raw.sequence, 'send.sequence'),
    revision: integer(raw.revision, 'send.revision'),
  };
}

function parsePendingRequest(value: unknown): RemoteHostPendingRequestDto {
  const raw = object(value, 'pending.request');
  exactKeys(raw, ['createdAt', 'display', 'expiresAt', 'id', 'kind', 'sessionId', 'status'], 'pending.request');
  const kinds = ['ask-user-question', 'diff-review', 'exit-plan', 'permission'] as const;
  const statuses = ['cancelled', 'denied', 'expired', 'pending', 'resolved', 'stale'] as const;
  if (!kinds.includes(raw.kind as typeof kinds[number])) {
    throw new RemoteHostInputError('pending.request.kind', 'invalid host result kind');
  }
  if (!statuses.includes(raw.status as typeof statuses[number])) {
    throw new RemoteHostInputError('pending.request.status', 'invalid host result status');
  }
  const display = parseRemoteHostJsonObject(raw.display, 'pending.request.display');
  if (raw.kind === 'ask-user-question' && hasMalformedRemoteHostQuestionIds(display)) {
    throw new RemoteHostInputError(
      'pending.request.display.questionIds',
      'host returned malformed question ids',
    );
  }
  return {
    id: token(raw.id, 'pending.request.id', 256),
    sessionId: token(raw.sessionId, 'pending.request.sessionId', 256),
    kind: raw.kind as RemoteHostPendingRequestDto['kind'],
    status: raw.status as RemoteHostPendingRequestDto['status'],
    createdAt: integer(raw.createdAt, 'pending.request.createdAt'),
    expiresAt: raw.expiresAt === null ? null : integer(raw.expiresAt, 'pending.request.expiresAt'),
    display,
  };
}

export function parseRemoteHostPendingListResult(
  value: unknown,
  sessionId: string,
): RemoteHostPendingListDto {
  const raw = object(value, 'pending');
  exactKeys(raw, ['requests', 'revision'], 'pending');
  if (!Array.isArray(raw.requests) || raw.requests.length > REMOTE_HOST_MAX_PENDING_ITEMS) {
    throw new RemoteHostInputError('pending.requests', 'host exceeded pending bound');
  }
  const requests = raw.requests.map(parsePendingRequest);
  if (
    new Set(requests.map((request) => request.id)).size !== requests.length ||
    requests.some((request) => request.sessionId !== sessionId)
  ) {
    throw new RemoteHostInputError('pending.requests', 'host result identity mismatch');
  }
  return { requests, revision: integer(raw.revision, 'pending.revision') };
}

export function parseRemoteHostRuntimeControlsResult(
  value: unknown,
): RemoteHostRuntimeControlsDto {
  const raw = object(value, 'runtime');
  exactKeys(raw, ['adapterId', 'revision', 'values'], 'runtime');
  return {
    adapterId: token(raw.adapterId, 'runtime.adapterId', 128),
    values: parseRemoteHostJsonObject(raw.values, 'runtime.values'),
    revision: integer(raw.revision, 'runtime.revision'),
  };
}

export function parseRemoteHostRuntimeUpdateResult(
  value: unknown,
): RemoteHostRuntimeUpdateResultDto {
  const raw = object(value, 'runtimeUpdate');
  exactKeys(raw, ['controls', 'effect', 'replacementSessionId'], 'runtimeUpdate');
  if (!['hot-applied', 'handoff-required', 'restart-required'].includes(String(raw.effect))) {
    throw new RemoteHostInputError('runtimeUpdate.effect', 'invalid host result effect');
  }
  return {
    controls: parseRemoteHostRuntimeControlsResult(raw.controls),
    effect: raw.effect as RemoteHostRuntimeUpdateResultDto['effect'],
    replacementSessionId: raw.replacementSessionId === null
      ? null
      : token(raw.replacementSessionId, 'runtimeUpdate.replacementSessionId', 256),
  };
}

export function parseRemoteHostPendingResponseResult(
  value: unknown,
): RemoteHostPendingResponseResultDto {
  const raw = object(value, 'pendingResponse');
  exactKeys(raw, ['revision', 'status'], 'pendingResponse');
  const statuses = ['cancelled', 'denied', 'expired', 'resolved', 'stale'] as const;
  if (!statuses.includes(raw.status as typeof statuses[number])) {
    throw new RemoteHostInputError('pendingResponse.status', 'invalid host result status');
  }
  return {
    status: raw.status as RemoteHostPendingResponseResultDto['status'],
    revision: integer(raw.revision, 'pendingResponse.revision'),
  };
}

export function parseRemoteHostAcceptedResult(value: unknown): RemoteHostAcceptedResultDto {
  const raw = object(value, 'accepted');
  exactKeys(raw, ['accepted', 'revision'], 'accepted');
  if (typeof raw.accepted !== 'boolean') {
    throw new RemoteHostInputError('accepted.accepted', 'invalid host result boolean');
  }
  return { accepted: raw.accepted, revision: integer(raw.revision, 'accepted.revision') };
}

export function assertSafeResultText(value: string, field: string): string {
  if (CONTROL.test(value)) throw new RemoteHostInputError(field, 'invalid host result text');
  return value;
}
