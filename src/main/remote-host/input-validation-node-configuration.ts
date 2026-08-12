import { isJsonObject, parseNodeConfigurationAdapterId } from '@contracts/index';
import type {
  RemoteHostNodeConfigurationRequestDto,
  RemoteHostNodeHookMutationDto,
  RemoteHostNodeHookRequestDto,
} from '@shared/remote-host';

import {
  parseRemoteHostMutationAuthority,
  parseRemoteHostProfileId,
  RemoteHostInputError,
} from './input-validation';

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/;

function object(value: unknown, field: string): Record<string, unknown> {
  if (!isJsonObject(value)) throw new RemoteHostInputError(field, 'must be an object');
  return value;
}

function exact(raw: Record<string, unknown>, keys: readonly string[], field: string): void {
  const actual = Object.keys(raw).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new RemoteHostInputError(field, 'contains unexpected fields');
  }
}

function intent(value: unknown): string {
  if (
    typeof value !== 'string' || !TOKEN.test(value) ||
    new TextEncoder().encode(value).byteLength > 128
  ) throw new RemoteHostInputError('intentId', 'must be a bounded token');
  return value;
}

export function parseRemoteHostNodeConfiguration(
  value: unknown,
): RemoteHostNodeConfigurationRequestDto {
  const raw = object(value, 'nodeConfiguration');
  exact(raw, ['profileId'], 'nodeConfiguration');
  return { profileId: parseRemoteHostProfileId(raw.profileId) };
}

export function parseRemoteHostNodeHook(
  value: unknown,
): RemoteHostNodeHookRequestDto {
  const raw = object(value, 'nodeHook');
  exact(raw, ['adapterId', 'profileId'], 'nodeHook');
  try {
    return {
      profileId: parseRemoteHostProfileId(raw.profileId),
      adapterId: parseNodeConfigurationAdapterId(raw.adapterId),
    };
  } catch (error) {
    if (error instanceof RemoteHostInputError) throw error;
    throw new RemoteHostInputError('adapterId', 'must be a supported provider adapter');
  }
}

export function parseRemoteHostNodeHookMutation(
  value: unknown,
): RemoteHostNodeHookMutationDto {
  const raw = object(value, 'nodeHookMutation');
  exact(raw, [
    'adapterId', 'expectedAuthority', 'intentId', 'profileId',
  ], 'nodeHookMutation');
  return {
    ...parseRemoteHostNodeHook({ adapterId: raw.adapterId, profileId: raw.profileId }),
    expectedAuthority: parseRemoteHostMutationAuthority(raw.expectedAuthority),
    intentId: intent(raw.intentId),
  };
}
