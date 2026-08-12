import {
  isJsonObject,
  parseTeamAddMemberParams,
  parseTeamGetParams,
  parseTeamListParams,
  parseUsageProviderParams,
  parseUsageTokenParams,
} from '@contracts/index';
import type {
  RemoteHostTeamAddMemberDto,
  RemoteHostTeamListRequestDto,
  RemoteHostTeamMutationTargetDto,
  RemoteHostTeamTargetDto,
  RemoteHostUsageProviderRequestDto,
  RemoteHostUsageTokenRequestDto,
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
    Buffer.byteLength(value, 'utf8') > 256
  ) throw new RemoteHostInputError('intentId', 'must be a bounded token');
  return value;
}

function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new RemoteHostInputError('expectedRevision', 'must be a non-negative integer');
  }
  return value as number;
}

export function parseRemoteHostTeamList(value: unknown): RemoteHostTeamListRequestDto {
  const raw = object(value, 'teams');
  exact(raw, ['includeArchived', 'limit', 'profileId'], 'teams');
  try {
    return {
      profileId: parseRemoteHostProfileId(raw.profileId),
      ...parseTeamListParams({ includeArchived: raw.includeArchived, limit: raw.limit }),
    };
  } catch (error) {
    if (error instanceof RemoteHostInputError) throw error;
    throw new RemoteHostInputError('teams', 'invalid team list request');
  }
}

export function parseRemoteHostTeamTarget(value: unknown): RemoteHostTeamTargetDto {
  const raw = object(value, 'team');
  exact(raw, ['profileId', 'teamId'], 'team');
  try {
    return {
      profileId: parseRemoteHostProfileId(raw.profileId),
      ...parseTeamGetParams({ teamId: raw.teamId }),
    };
  } catch (error) {
    if (error instanceof RemoteHostInputError) throw error;
    throw new RemoteHostInputError('team', 'invalid team request');
  }
}

export function parseRemoteHostTeamMutationTarget(
  value: unknown,
): RemoteHostTeamMutationTargetDto {
  const raw = object(value, 'teamMutation');
  exact(raw, [
    'expectedAuthority', 'expectedRevision', 'intentId', 'profileId', 'teamId',
  ], 'teamMutation');
  const target = parseRemoteHostTeamTarget({ profileId: raw.profileId, teamId: raw.teamId });
  return {
    ...target,
    expectedAuthority: parseRemoteHostMutationAuthority(raw.expectedAuthority),
    intentId: intent(raw.intentId),
    expectedRevision: revision(raw.expectedRevision),
  };
}

export function parseRemoteHostTeamAddMember(value: unknown): RemoteHostTeamAddMemberDto {
  const raw = object(value, 'teamMember');
  exact(raw, [
    'expectedAuthority', 'expectedRevision', 'intentId', 'profileId', 'role', 'sessionId',
    'teamId',
  ], 'teamMember');
  const mutation = parseRemoteHostTeamMutationTarget({
    expectedRevision: raw.expectedRevision,
    expectedAuthority: raw.expectedAuthority,
    intentId: raw.intentId,
    profileId: raw.profileId,
    teamId: raw.teamId,
  });
  try {
    return {
      ...mutation,
      ...parseTeamAddMemberParams({
        role: raw.role,
        sessionId: raw.sessionId,
        teamId: raw.teamId,
      }),
    };
  } catch {
    throw new RemoteHostInputError('teamMember', 'invalid team member request');
  }
}

export function parseRemoteHostUsageToken(
  value: unknown,
): RemoteHostUsageTokenRequestDto {
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
