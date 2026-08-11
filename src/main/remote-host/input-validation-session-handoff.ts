import {
  isJsonObject,
  parseSessionHandOffCommitParams,
  parseSessionHandOffPreviewParams,
} from '@contracts/index';
import type {
  RemoteHostHandOffCommitRequestDto,
  RemoteHostHandOffPreviewRequestDto,
} from '@shared/remote-host';

import { parseRemoteHostProfileId, RemoteHostInputError } from './input-validation';

const INTENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/;

function exactObject(
  value: unknown,
  expected: readonly string[],
  field: string,
): Record<string, unknown> {
  if (!isJsonObject(value)) throw new RemoteHostInputError(field, 'must be an object');
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new RemoteHostInputError(field, 'contains unexpected fields');
  }
  return value;
}

function intentId(value: unknown): string {
  if (
    typeof value !== 'string' || value.length === 0 ||
    Buffer.byteLength(value) > 128 || !INTENT_ID.test(value)
  ) throw new RemoteHostInputError('intentId', 'invalid token');
  return value;
}

export function parseRemoteHostHandOffPreview(
  value: unknown,
): RemoteHostHandOffPreviewRequestDto {
  const raw = exactObject(
    value,
    ['continuationInstruction', 'profileId', 'sessionId', 'target'],
    'handoffPreview',
  );
  try {
    return {
      profileId: parseRemoteHostProfileId(raw.profileId),
      ...parseSessionHandOffPreviewParams({
        continuationInstruction: raw.continuationInstruction,
        sessionId: raw.sessionId,
        target: raw.target,
      }),
    };
  } catch (error) {
    if (error instanceof RemoteHostInputError) throw error;
    throw new RemoteHostInputError('handoffPreview', 'invalid Remote handoff preview');
  }
}

export function parseRemoteHostHandOffCommit(
  value: unknown,
): RemoteHostHandOffCommitRequestDto {
  const raw = exactObject(value, [
    'continuationInstruction', 'expectedBindingDigest', 'intentId',
    'profileId', 'sessionId', 'target',
  ], 'handoffCommit');
  try {
    return {
      profileId: parseRemoteHostProfileId(raw.profileId),
      ...parseSessionHandOffCommitParams({
        continuationInstruction: raw.continuationInstruction,
        expectedBindingDigest: raw.expectedBindingDigest,
        sessionId: raw.sessionId,
        target: raw.target,
      }),
      intentId: intentId(raw.intentId),
    };
  } catch (error) {
    if (error instanceof RemoteHostInputError) throw error;
    throw new RemoteHostInputError('handoffCommit', 'invalid Remote handoff commit');
  }
}
