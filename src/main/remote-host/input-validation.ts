import { isJsonObject } from '@contracts/index';
import {
  REMOTE_HOST_MAX_HISTORY_LIMIT,
  REMOTE_HOST_MAX_JSON_BYTES,
  REMOTE_HOST_MAX_PAGE_LIMIT,
  REMOTE_HOST_MAX_TEXT_BYTES,
  type RemoteHostCreateSessionDto,
  type RemoteHostHistoryRequestDto,
  type RemoteHostJsonObject,
  type RemoteHostJsonValue,
  type RemoteHostMutationTargetDto,
  type RemoteHostPageRequestDto,
  type RemoteHostPendingAction,
  type RemoteHostPendingResponseDto,
  type RemoteHostProfileDraftDto,
  type RemoteHostRuntimeUpdateDto,
  type RemoteHostSendDto,
  type RemoteHostSessionPageRequestDto,
  type RemoteHostSessionTargetDto,
  type RemoteHostSourceMode,
} from '@shared/remote-host';

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const PENDING_ANSWER_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/u;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/;
const MAX_JSON_DEPTH = 16;
const MAX_JSON_NODES = 4_096;

export class RemoteHostInputError extends Error {
  constructor(field: string, reason: string) {
    super(`invalid remote host input: ${field} (${reason})`);
    this.name = 'RemoteHostInputError';
  }
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (!isJsonObject(value)) throw new RemoteHostInputError(field, 'must be an object');
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
    throw new RemoteHostInputError(field, 'contains unexpected fields');
  }
}

function text(value: unknown, field: string, maxBytes: number, allowEmpty = false): string {
  if (
    typeof value !== 'string' ||
    (!allowEmpty && value.length === 0) ||
    utf8Bytes(value) > maxBytes ||
    CONTROL.test(value)
  ) {
    throw new RemoteHostInputError(field, 'invalid or too long');
  }
  return value;
}

function multilineText(value: unknown, field: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    utf8Bytes(value) > REMOTE_HOST_MAX_TEXT_BYTES ||
    /[\u0000\u007f-\u009f\u2028\u2029]/u.test(value)
  ) {
    throw new RemoteHostInputError(field, 'invalid or too long');
  }
  return value;
}

function token(value: unknown, field: string, maxBytes = 512): string {
  const parsed = text(value, field, maxBytes);
  if (!SAFE_TOKEN.test(parsed)) throw new RemoteHostInputError(field, 'invalid token');
  return parsed;
}

function pendingAction(value: unknown): RemoteHostPendingAction {
  const parsed = token(value, 'action', 128);
  if (!['accept', 'approve', 'deny', 'reject', 'submit'].includes(parsed)) {
    throw new RemoteHostInputError('action', 'unsupported pending action');
  }
  return parsed as RemoteHostPendingAction;
}

function boundedPendingAnswer(value: RemoteHostJsonValue): boolean {
  if (typeof value === 'string') {
    return value.length > 0 && utf8Bytes(value) <= 4_096 && !PENDING_ANSWER_CONTROL.test(value);
  }
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 32 &&
    value.every((item) =>
      typeof item === 'string' &&
      item.length > 0 &&
      utf8Bytes(item) <= 4_096 &&
      !PENDING_ANSWER_CONTROL.test(item))
  );
}

function pendingValue(
  action: RemoteHostPendingAction,
  value: unknown,
): RemoteHostJsonValue | undefined {
  if (action !== 'submit') {
    if (value !== undefined) {
      throw new RemoteHostInputError('value', 'is not allowed for this pending action');
    }
    return undefined;
  }
  if (value === undefined) {
    throw new RemoteHostInputError('value', 'submit requires an answer object');
  }
  const parsed = parseRemoteHostJsonObject(value, 'value');
  const entries = Object.entries(parsed);
  if (
    entries.length === 0 ||
    entries.length > 32 ||
    entries.some(([key, answer]) =>
      utf8Bytes(key) > 128 ||
      PENDING_ANSWER_CONTROL.test(key) ||
      !boundedPendingAnswer(answer))
  ) {
    throw new RemoteHostInputError('value', 'invalid pending answer object');
  }
  return parsed;
}

function nullableText(value: unknown, field: string, maxBytes: number): string | null {
  return value === null ? null : text(value, field, maxBytes);
}

function nullableToken(value: unknown, field: string, maxBytes: number): string | null {
  return value === null ? null : token(value, field, maxBytes);
}

function positiveInteger(value: unknown, field: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > maximum) {
    throw new RemoteHostInputError(field, `must be in range 1..${maximum}`);
  }
  return value as number;
}

function revision(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new RemoteHostInputError(field, 'must be a non-negative safe integer');
  }
  return value as number;
}

export function parseRemoteHostProfileId(value: unknown): string {
  return token(value, 'profileId', 128);
}

export function parseRemoteHostSourceMode(value: unknown): RemoteHostSourceMode {
  if (value !== 'local' && value !== 'remote') {
    throw new RemoteHostInputError('sourceMode', 'must be local or remote');
  }
  return value;
}

export function parseRemoteHostProfileDraft(value: unknown): RemoteHostProfileDraftDto {
  const raw = object(value, 'profile');
  exactKeys(raw, [
    'expectedInstanceId',
    'hostKeyAlias',
    'hostname',
    'identitySelectionId',
    'knownHostsSelectionId',
    'label',
    'port',
    'topology',
    'username',
  ], 'profile');
  if (raw.topology !== 'server-core' && raw.topology !== 'relay') {
    throw new RemoteHostInputError('profile.topology', 'must be server-core or relay');
  }
  return {
    label: text(raw.label, 'profile.label', 256),
    topology: raw.topology,
    hostname: text(raw.hostname, 'profile.hostname', 253),
    port: positiveInteger(raw.port, 'profile.port', 65_535),
    username: text(raw.username, 'profile.username', 128),
    expectedInstanceId: nullableText(raw.expectedInstanceId, 'profile.expectedInstanceId', 128),
    hostKeyAlias: nullableText(raw.hostKeyAlias, 'profile.hostKeyAlias', 128),
    identitySelectionId: nullableToken(raw.identitySelectionId, 'profile.identitySelectionId', 256),
    knownHostsSelectionId: nullableToken(raw.knownHostsSelectionId, 'profile.knownHostsSelectionId', 256),
  };
}

function parsePageBase(value: unknown): {
  raw: Record<string, unknown>;
  profileId: string;
  cursor?: string;
  limit: number;
} {
  const raw = object(value, 'page');
  return {
    raw,
    profileId: parseRemoteHostProfileId(raw.profileId),
    ...(raw.cursor === undefined ? {} : { cursor: token(raw.cursor, 'cursor', 512) }),
    limit: positiveInteger(raw.limit, 'limit', REMOTE_HOST_MAX_PAGE_LIMIT),
  };
}

export function parseRemoteHostPageRequest(value: unknown): RemoteHostPageRequestDto {
  const page = parsePageBase(value);
  exactKeys(page.raw, page.cursor === undefined ? ['limit', 'profileId'] : ['cursor', 'limit', 'profileId'], 'page');
  return { profileId: page.profileId, ...(page.cursor ? { cursor: page.cursor } : {}), limit: page.limit };
}

export function parseRemoteHostSessionPageRequest(
  value: unknown,
): RemoteHostSessionPageRequestDto {
  const page = parsePageBase(value);
  const expected = ['limit', 'profileId'];
  if (page.cursor !== undefined) expected.push('cursor');
  if (page.raw.includeArchived !== undefined) expected.push('includeArchived');
  exactKeys(page.raw, expected, 'page');
  if (page.raw.includeArchived !== undefined && typeof page.raw.includeArchived !== 'boolean') {
    throw new RemoteHostInputError('includeArchived', 'must be boolean');
  }
  return {
    profileId: page.profileId,
    ...(page.cursor ? { cursor: page.cursor } : {}),
    limit: page.limit,
    ...(page.raw.includeArchived === undefined
      ? {}
      : { includeArchived: page.raw.includeArchived as boolean }),
  };
}

export function parseRemoteHostSessionTarget(value: unknown): RemoteHostSessionTargetDto {
  const raw = object(value, 'target');
  exactKeys(raw, ['profileId', 'sessionId'], 'target');
  return {
    profileId: parseRemoteHostProfileId(raw.profileId),
    sessionId: token(raw.sessionId, 'sessionId', 256),
  };
}

function intentId(value: unknown): string {
  return token(value, 'intentId', 128);
}

export function parseRemoteHostMutationTarget(value: unknown): RemoteHostMutationTargetDto {
  const raw = object(value, 'mutationTarget');
  exactKeys(raw, ['intentId', 'profileId', 'sessionId'], 'mutationTarget');
  return {
    ...parseRemoteHostSessionTarget({ profileId: raw.profileId, sessionId: raw.sessionId }),
    intentId: intentId(raw.intentId),
  };
}

export function parseRemoteHostHistoryRequest(value: unknown): RemoteHostHistoryRequestDto {
  const raw = object(value, 'history');
  const expected = ['limit', 'profileId', 'sessionId'];
  if (raw.cursor !== undefined) expected.push('cursor');
  exactKeys(raw, expected, 'history');
  return {
    profileId: parseRemoteHostProfileId(raw.profileId),
    sessionId: token(raw.sessionId, 'sessionId', 256),
    ...(raw.cursor === undefined ? {} : { cursor: token(raw.cursor, 'cursor', 512) }),
    limit: positiveInteger(raw.limit, 'limit', REMOTE_HOST_MAX_HISTORY_LIMIT),
  };
}

export function parseRemoteHostJsonValue(value: unknown, field: string): RemoteHostJsonValue {
  let nodes = 0;
  const visit = (entry: unknown, depth: number, path: string): RemoteHostJsonValue => {
    nodes += 1;
    if (nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) {
      throw new RemoteHostInputError(field, 'JSON is too complex');
    }
    if (entry === null || typeof entry === 'boolean' || typeof entry === 'string') return entry;
    if (typeof entry === 'number') {
      if (!Number.isFinite(entry)) throw new RemoteHostInputError(path, 'number must be finite');
      return entry;
    }
    if (Array.isArray(entry)) return entry.map((item, index) => visit(item, depth + 1, `${path}[${index}]`));
    if (!isJsonObject(entry)) throw new RemoteHostInputError(path, 'must be JSON');
    const result: Record<string, RemoteHostJsonValue> = {};
    for (const [key, item] of Object.entries(entry)) {
      if (!key || key.length > 256 || CONTROL.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) {
        throw new RemoteHostInputError(path, 'contains an invalid key');
      }
      result[key] = visit(item, depth + 1, `${path}.${key}`);
    }
    return result;
  };
  const cloned = visit(value, 0, field);
  if (utf8Bytes(JSON.stringify(cloned)) > REMOTE_HOST_MAX_JSON_BYTES) {
    throw new RemoteHostInputError(field, 'JSON is too large');
  }
  return cloned;
}

export function parseRemoteHostJsonObject(value: unknown, field: string): RemoteHostJsonObject {
  const cloned = parseRemoteHostJsonValue(value, field);
  if (!cloned || typeof cloned !== 'object' || Array.isArray(cloned)) {
    throw new RemoteHostInputError(field, 'must be a JSON object');
  }
  return cloned;
}

export function parseRemoteHostCreateSession(value: unknown): RemoteHostCreateSessionDto {
  const raw = object(value, 'create');
  exactKeys(raw, ['adapterId', 'intentId', 'options', 'profileId', 'projectRef'], 'create');
  return {
    profileId: parseRemoteHostProfileId(raw.profileId),
    adapterId: token(raw.adapterId, 'adapterId', 128),
    projectRef: token(raw.projectRef, 'projectRef', 256),
    options: parseRemoteHostJsonObject(raw.options, 'options'),
    intentId: intentId(raw.intentId),
  };
}

export function parseRemoteHostSend(value: unknown): RemoteHostSendDto {
  const raw = object(value, 'send');
  exactKeys(raw, ['intentId', 'profileId', 'sessionId', 'text'], 'send');
  return {
    ...parseRemoteHostSessionTarget({ profileId: raw.profileId, sessionId: raw.sessionId }),
    text: multilineText(raw.text, 'text'),
    intentId: intentId(raw.intentId),
  };
}

export function parseRemoteHostRuntimeUpdate(value: unknown): RemoteHostRuntimeUpdateDto {
  const raw = object(value, 'runtime');
  exactKeys(raw, ['expectedRevision', 'intentId', 'patch', 'profileId', 'sessionId'], 'runtime');
  return {
    ...parseRemoteHostSessionTarget({ profileId: raw.profileId, sessionId: raw.sessionId }),
    patch: parseRemoteHostJsonObject(raw.patch, 'patch'),
    expectedRevision: revision(raw.expectedRevision, 'expectedRevision'),
    intentId: intentId(raw.intentId),
  };
}

export function parseRemoteHostPendingResponse(value: unknown): RemoteHostPendingResponseDto {
  const raw = object(value, 'pendingResponse');
  const expected = ['action', 'expectedRevision', 'intentId', 'profileId', 'requestId', 'sessionId'];
  if (raw.value !== undefined) expected.push('value');
  exactKeys(raw, expected, 'pendingResponse');
  const action = pendingAction(raw.action);
  const parsedValue = pendingValue(action, raw.value);
  return {
    ...parseRemoteHostSessionTarget({ profileId: raw.profileId, sessionId: raw.sessionId }),
    requestId: token(raw.requestId, 'requestId', 256),
    action,
    ...(parsedValue === undefined ? {} : { value: parsedValue }),
    expectedRevision: revision(raw.expectedRevision, 'expectedRevision'),
    intentId: intentId(raw.intentId),
  };
}
