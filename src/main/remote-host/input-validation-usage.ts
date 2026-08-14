import {
  isJsonObject,
  parseUsageProviderParams,
  parseUsageTokenParams,
} from '@contracts/index';
import type {
  RemoteHostUsageProviderRequestDto,
  RemoteHostUsageTokenRequestDto,
} from '@shared/remote-host';
import { parseRemoteHostProfileId, RemoteHostInputError } from './input-validation';

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

export function parseRemoteHostUsageToken(value: unknown): RemoteHostUsageTokenRequestDto {
  const raw = object(value, 'usageTokens');
  exact(raw, ['dailyLimit', 'includeDaily', 'profileId'], 'usageTokens');
  try {
    return {
      profileId: parseRemoteHostProfileId(raw.profileId),
      ...parseUsageTokenParams({ includeDaily: raw.includeDaily, dailyLimit: raw.dailyLimit }),
    };
  } catch (error) {
    if (error instanceof RemoteHostInputError) throw error;
    throw new RemoteHostInputError('usageTokens', 'invalid token usage request');
  }
}

export function parseRemoteHostUsageProvider(
  value: unknown,
): RemoteHostUsageProviderRequestDto {
  const raw = object(value, 'usageProviders');
  exact(raw, ['force', 'profileId'], 'usageProviders');
  try {
    return {
      profileId: parseRemoteHostProfileId(raw.profileId),
      ...parseUsageProviderParams({ force: raw.force }),
    };
  } catch (error) {
    if (error instanceof RemoteHostInputError) throw error;
    throw new RemoteHostInputError('usageProviders', 'invalid provider usage request');
  }
}
