import {
  isJsonObject,
  parseSessionMessagesListParams,
  parseSessionPermissionsGetParams,
  parseSessionOutgoingListParams,
  parseSessionOutgoingRemoveParams,
} from '@contracts/index';
import type {
  RemoteHostSessionMessagesRequestDto,
  RemoteHostSessionPermissionsRequestDto,
  RemoteHostSessionOutgoingRequestDto,
  RemoteHostSessionOutgoingRemoveRequestDto,
} from '@shared/remote-host';

import {
  parseRemoteHostMutationAuthority,
  parseRemoteHostProfileId,
  RemoteHostInputError,
} from './input-validation';

function exact(value: unknown, keys: readonly string[], field: string): Record<string, unknown> {
  if (!isJsonObject(value)) throw new RemoteHostInputError(field, 'must be an object');
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new RemoteHostInputError(field, 'contains unexpected fields');
  }
  return value;
}

export function parseRemoteHostSessionOutgoingRequest(
  value: unknown,
): RemoteHostSessionOutgoingRequestDto {
  const raw = exact(value, ['adapterId', 'profileId', 'sessionId'], 'sessionOutgoing');
  if (!['claude-code', 'codex-cli', 'grok-build'].includes(String(raw.adapterId))) {
    throw new RemoteHostInputError('sessionOutgoing.adapterId', 'is invalid');
  }
  try {
    return {
      profileId: parseRemoteHostProfileId(raw.profileId),
      adapterId: raw.adapterId as RemoteHostSessionOutgoingRequestDto['adapterId'],
      ...parseSessionOutgoingListParams({ sessionId: raw.sessionId }),
    };
  } catch (error) {
    if (error instanceof RemoteHostInputError) throw error;
    throw new RemoteHostInputError('sessionOutgoing', 'is invalid');
  }
}

export function parseRemoteHostSessionOutgoingRemoveRequest(
  value: unknown,
): RemoteHostSessionOutgoingRemoveRequestDto {
  const raw = exact(
    value,
    ['expectedAuthority', 'intentId', 'messageId', 'profileId', 'sessionId'],
    'sessionOutgoingRemove',
  );
  try {
    const parsed = parseSessionOutgoingRemoveParams({
      sessionId: raw.sessionId,
      messageId: raw.messageId,
    });
    if (typeof raw.intentId !== 'string' || !raw.intentId || raw.intentId.length > 256) {
      throw new Error('invalid intent');
    }
    return {
      profileId: parseRemoteHostProfileId(raw.profileId),
      ...parsed,
      expectedAuthority: parseRemoteHostMutationAuthority(raw.expectedAuthority),
      intentId: raw.intentId,
    };
  } catch (error) {
    if (error instanceof RemoteHostInputError) throw error;
    throw new RemoteHostInputError('sessionOutgoingRemove', 'is invalid');
  }
}

export function parseRemoteHostSessionPermissionsRequest(
  value: unknown,
): RemoteHostSessionPermissionsRequestDto {
  const raw = exact(value, ['adapterId', 'profileId', 'sessionId'], 'sessionPermissions');
  if (!['claude-code', 'codex-cli', 'grok-build'].includes(String(raw.adapterId))) {
    throw new RemoteHostInputError('sessionPermissions.adapterId', 'is invalid');
  }
  try {
    return {
      profileId: parseRemoteHostProfileId(raw.profileId),
      adapterId: raw.adapterId as RemoteHostSessionPermissionsRequestDto['adapterId'],
      ...parseSessionPermissionsGetParams({ sessionId: raw.sessionId }),
    };
  } catch (error) {
    if (error instanceof RemoteHostInputError) throw error;
    throw new RemoteHostInputError('sessionPermissions', 'is invalid');
  }
}

export function parseRemoteHostSessionMessagesRequest(
  value: unknown,
): RemoteHostSessionMessagesRequestDto {
  const raw = exact(value, ['limit', 'profileId', 'sessionId'], 'sessionMessages');
  try {
    return {
      profileId: parseRemoteHostProfileId(raw.profileId),
      ...parseSessionMessagesListParams({ sessionId: raw.sessionId, limit: raw.limit }),
    };
  } catch (error) {
    if (error instanceof RemoteHostInputError) throw error;
    throw new RemoteHostInputError('sessionMessages', 'is invalid');
  }
}
