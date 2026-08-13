import { isJsonObject, parseSessionHistoryMutationParams } from '@contracts/index';
import type { RemoteHostSessionHistoryMutationDto } from '@shared/remote-host';

import {
  parseRemoteHostMutationAuthority,
  parseRemoteHostProfileId,
  RemoteHostInputError,
} from './input-validation';

export function parseRemoteHostSessionHistoryMutation(
  value: unknown,
): RemoteHostSessionHistoryMutationDto {
  if (!isJsonObject(value)) {
    throw new RemoteHostInputError('sessionHistoryMutation', 'must be an object');
  }
  const actual = Object.keys(value).sort();
  const expected = [
    'expectedArchived', 'expectedAuthority', 'expectedUpdatedAt',
    'intentId', 'profileId', 'sessionId',
  ].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new RemoteHostInputError('sessionHistoryMutation', 'contains unexpected fields');
  }
  try {
    if (typeof value.intentId !== 'string' || !value.intentId || value.intentId.length > 128) {
      throw new Error('invalid intent');
    }
    return {
      profileId: parseRemoteHostProfileId(value.profileId),
      ...parseSessionHistoryMutationParams({
        sessionId: value.sessionId,
        expectedArchived: value.expectedArchived,
        expectedUpdatedAt: value.expectedUpdatedAt,
      }),
      expectedAuthority: parseRemoteHostMutationAuthority(value.expectedAuthority),
      intentId: value.intentId,
    };
  } catch (error) {
    if (error instanceof RemoteHostInputError) throw error;
    throw new RemoteHostInputError('sessionHistoryMutation', 'is invalid');
  }
}
