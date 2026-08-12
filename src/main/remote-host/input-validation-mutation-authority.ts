import { isJsonObject } from '@contracts/index';
import type { RemoteHostMutationAuthorityDto } from '@shared/remote-host';

import { RemoteHostInputError } from './input-validation-error';

const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/;

export function parseRemoteHostMutationAuthority(
  value: unknown,
): RemoteHostMutationAuthorityDto {
  if (!isJsonObject(value)) {
    throw new RemoteHostInputError('expectedAuthority', 'must be an object');
  }
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== 'authoritativeCoreId' || keys[1] !== 'workerGeneration') {
    throw new RemoteHostInputError('expectedAuthority', 'contains unexpected fields');
  }
  const rawCoreId = value.authoritativeCoreId;
  const authoritativeCoreId = rawCoreId === null ? null : parseCoreId(rawCoreId);
  const workerGeneration = value.workerGeneration;
  if (
    workerGeneration !== null &&
    (!Number.isSafeInteger(workerGeneration) || (workerGeneration as number) < 0)
  ) {
    throw new RemoteHostInputError(
      'workerGeneration',
      'must be null or a non-negative safe integer',
    );
  }
  return { authoritativeCoreId, workerGeneration: workerGeneration as number | null };
}

function parseCoreId(value: unknown): string {
  if (
    typeof value !== 'string' || value.length === 0 ||
    new TextEncoder().encode(value).byteLength > 256 || !SAFE_TOKEN.test(value)
  ) {
    throw new RemoteHostInputError('authoritativeCoreId', 'invalid token');
  }
  return value;
}
