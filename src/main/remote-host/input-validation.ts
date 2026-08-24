import {
  isJsonObject,
  MCP_PRESENTATION_MAX_FEEDBACK_LENGTH,
  parseSessionConsoleAttachments,
  parseSessionConsoleCapabilitiesParams,
  parseSessionConsoleCreateOptions,
  parseSessionConsoleInitialMessage,
  parseProjectTrustRequest,
  parseMcpPresentationFeedback,
  parseWorkspaceDirectoryListParams,
  parseWorkspaceDirectoryRef,
} from '@contracts/index';
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
  type RemoteHostRuntimeUpdateDto,
  type RemoteHostSendDto,
  type RemoteHostSessionCapabilitiesRequestDto,
  type RemoteHostSessionTargetDto,
  type RemoteHostWorkspaceDirectoryRequestDto,
} from '@shared/remote-host';

import { RemoteHostInputError } from './input-validation-error';
import { parseRemoteHostMutationAuthority } from './input-validation-mutation-authority';

export { RemoteHostInputError } from './input-validation-error';
export { parseRemoteHostMutationAuthority } from './input-validation-mutation-authority';
export { parseRemoteHostProfileDraft, parseRemoteHostSourceMode } from './input-validation-profile';

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const PENDING_ANSWER_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/u;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/;
const MAX_JSON_DEPTH = 16;
const MAX_JSON_NODES = 4_096;
const EXIT_PLAN_TARGET_MODES = new Set(['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions']);

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

function contractValue<T>(read: () => T, field: string, reason: string): T {
  try { return read(); }
  catch { throw new RemoteHostInputError(field, reason); }
}

function token(value: unknown, field: string, maxBytes = 512): string {
  const parsed = text(value, field, maxBytes);
  if (!SAFE_TOKEN.test(parsed)) throw new RemoteHostInputError(field, 'invalid token');
  return parsed;
}

function pendingPresentationDigest(value: unknown): string {
  const parsed = token(value, 'expectedPresentationDigest', 72);
  if (!/^sha256:[0-9a-f]{64}$/u.test(parsed)) {
    throw new RemoteHostInputError('expectedPresentationDigest', 'invalid digest');
  }
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
  if (Array.isArray(value)) {
    return value.length > 0 && value.length <= 32 && value.every((item) =>
      typeof item === 'string' && item.length > 0 && utf8Bytes(item) <= 4_096 &&
      !PENDING_ANSWER_CONTROL.test(item)) && new Set(value).size === value.length;
  }
  if (!isJsonObject(value)) return false;
  const keys = Object.keys(value);
  if (
    !Object.hasOwn(value, 'selected') ||
    keys.some((key) => !['note', 'other', 'selected'].includes(key))
  ) return false;
  if (
    !Array.isArray(value.selected) || value.selected.length > 32 ||
    !value.selected.every((item) =>
      typeof item === 'string' && item.length > 0 && utf8Bytes(item) <= 4_096 &&
      !PENDING_ANSWER_CONTROL.test(item)) ||
    new Set(value.selected).size !== value.selected.length
  ) return false;
  return ['other', 'note'].every((key) => {
    const item = value[key];
    return item === undefined || (
      typeof item === 'string' && utf8Bytes(item) <= 4_096 &&
      !PENDING_ANSWER_CONTROL.test(item)
    );
  });
}

function meaningfulPendingAnswer(value: RemoteHostJsonValue): boolean {
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return isJsonObject(value) && (
    (Array.isArray(value.selected) && value.selected.length > 0) ||
    (typeof value.other === 'string' && value.other.trim().length > 0)
  );
}

function pendingValue(
  action: RemoteHostPendingAction,
  value: unknown,
): RemoteHostJsonValue | undefined {
  if (action === 'accept' && value !== undefined) {
    const parsed = parseRemoteHostJsonObject(value, 'value', 256);
    if (
      Object.keys(parsed).length !== 1 ||
      !Object.hasOwn(parsed, 'targetMode') ||
      typeof parsed.targetMode !== 'string' ||
      !EXIT_PLAN_TARGET_MODES.has(parsed.targetMode)
    ) {
      throw new RemoteHostInputError('value', 'invalid exit-plan target mode');
    }
    return parsed;
  }
  if (action === 'reject' && value !== undefined) {
    try {
      const feedback = parseMcpPresentationFeedback(parseRemoteHostJsonValue(
        value,
        'value',
        (MCP_PRESENTATION_MAX_FEEDBACK_LENGTH * 4) + 64,
      ));
      return feedback ? { feedback } : {};
    } catch {
      throw new RemoteHostInputError('value', 'invalid presentation feedback');
    }
  }
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
      !boundedPendingAnswer(answer)) ||
    !entries.some(([, answer]) => meaningfulPendingAnswer(answer))
  ) {
    throw new RemoteHostInputError('value', 'invalid pending answer object');
  }
  return parsed;
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

export function parseRemoteHostSessionTarget(value: unknown): RemoteHostSessionTargetDto {
  const raw = object(value, 'target');
  exactKeys(raw, ['profileId', 'sessionId'], 'target');
  return {
    profileId: parseRemoteHostProfileId(raw.profileId),
    sessionId: token(raw.sessionId, 'sessionId', 256),
  };
}

export function parseRemoteHostSessionCapabilitiesRequest(
  value: unknown,
): RemoteHostSessionCapabilitiesRequestDto {
  const raw = object(value, 'sessionCapabilities');
  exactKeys(
    raw,
    ['adapterId', 'profileId', 'provider', 'workingDirectory'],
    'sessionCapabilities',
  );
  try {
    const parsed = parseSessionConsoleCapabilitiesParams({
      adapterId: raw.adapterId,
      provider: raw.provider,
      workingDirectory: raw.workingDirectory,
    });
    return { profileId: parseRemoteHostProfileId(raw.profileId), ...parsed };
  } catch {
    throw new RemoteHostInputError('sessionCapabilities', 'invalid capability request');
  }
}

export function parseRemoteHostWorkspaceDirectoryRequest(
  value: unknown,
): RemoteHostWorkspaceDirectoryRequestDto {
  const raw = object(value, 'workspaceDirectory');
  exactKeys(raw, ['directory', 'profileId'], 'workspaceDirectory');
  try {
    return {
      profileId: parseRemoteHostProfileId(raw.profileId),
      ...parseWorkspaceDirectoryListParams({ directory: raw.directory }),
    };
  } catch {
    throw new RemoteHostInputError(
      'workspaceDirectory',
      'must be a relative directory inside Workspace',
    );
  }
}

function intentId(value: unknown): string {
  return token(value, 'intentId', 128);
}

export function parseRemoteHostMutationTarget(value: unknown): RemoteHostMutationTargetDto {
  const raw = object(value, 'mutationTarget');
  exactKeys(
    raw,
    ['expectedAuthority', 'intentId', 'profileId', 'sessionId'],
    'mutationTarget',
  );
  return {
    ...parseRemoteHostSessionTarget({ profileId: raw.profileId, sessionId: raw.sessionId }),
    expectedAuthority: parseRemoteHostMutationAuthority(raw.expectedAuthority),
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

export function parseRemoteHostJsonValue(
  value: unknown,
  field: string,
  maximumBytes = REMOTE_HOST_MAX_JSON_BYTES,
): RemoteHostJsonValue {
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
  if (utf8Bytes(JSON.stringify(cloned)) > maximumBytes) {
    throw new RemoteHostInputError(field, 'JSON is too large');
  }
  return cloned;
}

export function parseRemoteHostJsonObject(
  value: unknown,
  field: string,
  maximumBytes = REMOTE_HOST_MAX_JSON_BYTES,
): RemoteHostJsonObject {
  const cloned = parseRemoteHostJsonValue(value, field, maximumBytes);
  if (!cloned || typeof cloned !== 'object' || Array.isArray(cloned)) {
    throw new RemoteHostInputError(field, 'must be a JSON object');
  }
  return cloned;
}

export function parseRemoteHostCreateSession(value: unknown): RemoteHostCreateSessionDto {
  const raw = object(value, 'create');
  exactKeys(raw, [
    'adapterId', 'attachments', 'capabilityRevision', 'initialMessage', 'intentId',
    'expectedAuthority', 'options', 'profileId', 'projectTrust', 'workingDirectory',
  ], 'create');
  let workingDirectory: string;
  try {
    workingDirectory = parseWorkspaceDirectoryRef(raw.workingDirectory, 'workingDirectory');
  } catch {
    throw new RemoteHostInputError('workingDirectory', 'must be a relative directory inside Workspace');
  }
  return {
    profileId: parseRemoteHostProfileId(raw.profileId),
    adapterId: token(raw.adapterId, 'adapterId', 128),
    attachments: contractValue(
      () => parseSessionConsoleAttachments(raw.attachments, 'attachments'),
      'attachments', 'invalid Remote image attachments'),
    capabilityRevision: token(raw.capabilityRevision, 'capabilityRevision', 128),
    initialMessage: contractValue(
      () => parseSessionConsoleInitialMessage(raw.initialMessage, 'initialMessage'),
      'initialMessage', 'invalid or too long'),
    projectTrust: contractValue(
      () => parseProjectTrustRequest(raw.projectTrust, 'projectTrust'),
      'projectTrust', 'invalid project trust request'),
    workingDirectory,
    options: contractValue(
      () => parseSessionConsoleCreateOptions(raw.options),
      'options', 'invalid create options'),
    expectedAuthority: parseRemoteHostMutationAuthority(raw.expectedAuthority),
    intentId: intentId(raw.intentId),
  };
}

export function parseRemoteHostSend(value: unknown): RemoteHostSendDto {
  const raw = object(value, 'send');
  const expected = ['expectedAuthority', 'intentId', 'profileId', 'sessionId', 'text'];
  if (raw.attachments !== undefined) expected.push('attachments');
  exactKeys(raw, expected, 'send');
  let attachments;
  try { attachments = parseSessionConsoleAttachments(raw.attachments ?? [], 'attachments'); }
  catch { throw new RemoteHostInputError('attachments', 'invalid Remote image attachments'); }
  if (
    typeof raw.text !== 'string' ||
    (raw.text.trim().length === 0 && attachments.length === 0)
  ) throw new RemoteHostInputError('text', 'message or attachment is required');
  return {
    ...parseRemoteHostSessionTarget({ profileId: raw.profileId, sessionId: raw.sessionId }),
    text: raw.text.length === 0 ? '' : multilineText(raw.text, 'text'),
    ...(raw.attachments === undefined ? {} : { attachments }),
    expectedAuthority: parseRemoteHostMutationAuthority(raw.expectedAuthority),
    intentId: intentId(raw.intentId),
  };
}

export function parseRemoteHostRuntimeUpdate(value: unknown): RemoteHostRuntimeUpdateDto {
  const raw = object(value, 'runtime');
  exactKeys(raw, [
    'expectedAuthority', 'expectedRevision', 'intentId', 'patch', 'profileId', 'sessionId',
  ], 'runtime');
  return {
    ...parseRemoteHostSessionTarget({ profileId: raw.profileId, sessionId: raw.sessionId }),
    patch: parseRemoteHostJsonObject(raw.patch, 'patch'),
    expectedRevision: revision(raw.expectedRevision, 'expectedRevision'),
    expectedAuthority: parseRemoteHostMutationAuthority(raw.expectedAuthority),
    intentId: intentId(raw.intentId),
  };
}

export function parseRemoteHostPendingResponse(value: unknown): RemoteHostPendingResponseDto {
  const raw = object(value, 'pendingResponse');
  const expected = [
    'action', 'expectedPresentationDigest', 'expectedRevision', 'intentId',
    'expectedAuthority', 'profileId', 'requestId', 'sessionId',
  ];
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
    expectedPresentationDigest: pendingPresentationDigest(raw.expectedPresentationDigest),
    expectedAuthority: parseRemoteHostMutationAuthority(raw.expectedAuthority),
    intentId: intentId(raw.intentId),
  };
}
