import { isJsonObject, parseWorkspaceDirectoryCreateParams } from '@contracts/index';
import type { RemoteHostWorkspaceDirectoryCreateDto } from '@shared/remote-host';

import {
  parseRemoteHostMutationAuthority,
  parseRemoteHostProfileId,
  RemoteHostInputError,
} from './input-validation';

export function parseRemoteHostWorkspaceDirectoryCreate(
  value: unknown,
): RemoteHostWorkspaceDirectoryCreateDto {
  if (!isJsonObject(value)) {
    throw new RemoteHostInputError('workspaceDirectoryCreate', 'must be an object');
  }
  const actual = Object.keys(value).sort();
  const expected = [
    'expectedAuthority', 'intentId', 'name', 'parentDirectory', 'profileId',
  ].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new RemoteHostInputError('workspaceDirectoryCreate', 'contains unexpected fields');
  }
  try {
    if (typeof value.intentId !== 'string' || !value.intentId || value.intentId.length > 128) {
      throw new Error('invalid intent');
    }
    return {
      profileId: parseRemoteHostProfileId(value.profileId),
      ...parseWorkspaceDirectoryCreateParams({
        parentDirectory: value.parentDirectory,
        name: value.name,
      }),
      expectedAuthority: parseRemoteHostMutationAuthority(value.expectedAuthority),
      intentId: value.intentId,
    };
  } catch (error) {
    if (error instanceof RemoteHostInputError) throw error;
    throw new RemoteHostInputError('workspaceDirectoryCreate', 'is invalid');
  }
}
