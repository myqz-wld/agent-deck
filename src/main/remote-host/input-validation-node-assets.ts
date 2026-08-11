import {
  parseNodeAssetAdapterId,
  parseNodeAssetContentParams,
} from '@contracts/index';
import type {
  RemoteHostNodeAssetContentRequestDto,
  RemoteHostNodeAssetConventionRequestDto,
  RemoteHostNodeAssetListRequestDto,
} from '@shared/remote-host';

import { parseRemoteHostProfileId, RemoteHostInputError } from './input-validation';

function object(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RemoteHostInputError(field, 'must be an object');
  }
  return value as Record<string, unknown>;
}

function exact(raw: Record<string, unknown>, keys: readonly string[], field: string): void {
  const actual = Object.keys(raw).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new RemoteHostInputError(field, 'contains unexpected fields');
  }
}

export function parseRemoteHostNodeAssetList(
  value: unknown,
): RemoteHostNodeAssetListRequestDto {
  const raw = object(value, 'nodeAssetsList');
  exact(raw, ['profileId'], 'nodeAssetsList');
  return { profileId: parseRemoteHostProfileId(raw.profileId) };
}

export function parseRemoteHostNodeAssetContent(
  value: unknown,
): RemoteHostNodeAssetContentRequestDto {
  const raw = object(value, 'nodeAssetContent');
  exact(raw, [
    'adapterId', 'kind', 'location', 'name', 'profileId', 'qualifiedName', 'source',
  ], 'nodeAssetContent');
  try {
    return {
      profileId: parseRemoteHostProfileId(raw.profileId),
      ...parseNodeAssetContentParams({
        adapterId: raw.adapterId,
        kind: raw.kind,
        location: raw.location,
        source: raw.source,
        name: raw.name,
        qualifiedName: raw.qualifiedName,
      }),
    };
  } catch (error) {
    if (error instanceof RemoteHostInputError) throw error;
    throw new RemoteHostInputError('nodeAssetContent', 'asset identity is invalid');
  }
}

export function parseRemoteHostNodeAssetConvention(
  value: unknown,
): RemoteHostNodeAssetConventionRequestDto {
  const raw = object(value, 'nodeAssetConvention');
  exact(raw, ['adapterId', 'profileId'], 'nodeAssetConvention');
  try {
    return {
      profileId: parseRemoteHostProfileId(raw.profileId),
      adapterId: parseNodeAssetAdapterId(raw.adapterId),
    };
  } catch (error) {
    if (error instanceof RemoteHostInputError) throw error;
    throw new RemoteHostInputError('adapterId', 'must be a supported provider adapter');
  }
}
