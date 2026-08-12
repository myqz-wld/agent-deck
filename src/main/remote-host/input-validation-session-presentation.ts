import {
  isJsonObject,
  parsePendingIndexListParams,
  parseSessionPresentationListParams,
} from '@contracts/index';
import type {
  RemoteHostPendingIndexRequestDto,
  RemoteHostSessionPresentationRequestDto,
} from '@shared/remote-host';

import { RemoteHostInputError, parseRemoteHostProfileId } from './input-validation';

function object(value: unknown, field: string): Record<string, unknown> {
  if (!isJsonObject(value)) throw new RemoteHostInputError(field, 'must be an object');
  return value;
}

function exact(value: Record<string, unknown>, keys: readonly string[], field: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new RemoteHostInputError(field, 'contains unexpected fields');
  }
}

export function parseRemoteHostSessionPresentationRequest(
  value: unknown,
): RemoteHostSessionPresentationRequestDto {
  const raw = object(value, 'sessionPresentation');
  const keys = ['kind', 'limit', 'profileId'];
  if (raw.cursor !== undefined) keys.push('cursor');
  if (raw.query !== undefined) keys.push('query');
  exact(raw, keys, 'sessionPresentation');
  try {
    const params = parseSessionPresentationListParams({
      kind: raw.kind,
      limit: raw.limit,
      ...(raw.cursor === undefined ? {} : { cursor: raw.cursor }),
      ...(raw.query === undefined ? {} : { query: raw.query }),
    });
    return { profileId: parseRemoteHostProfileId(raw.profileId), ...params };
  } catch (error) {
    if (error instanceof RemoteHostInputError) throw error;
    throw new RemoteHostInputError('sessionPresentation', 'invalid list request');
  }
}

export function parseRemoteHostPendingIndexRequest(
  value: unknown,
): RemoteHostPendingIndexRequestDto {
  const raw = object(value, 'pendingIndex');
  const keys = raw.cursor === undefined
    ? ['limit', 'profileId']
    : ['cursor', 'limit', 'profileId'];
  exact(raw, keys, 'pendingIndex');
  try {
    const params = parsePendingIndexListParams({
      limit: raw.limit,
      ...(raw.cursor === undefined ? {} : { cursor: raw.cursor }),
    });
    return { profileId: parseRemoteHostProfileId(raw.profileId), ...params };
  } catch (error) {
    if (error instanceof RemoteHostInputError) throw error;
    throw new RemoteHostInputError('pendingIndex', 'invalid list request');
  }
}
