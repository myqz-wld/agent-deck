import { describe, expect, it } from 'vitest';

import {
  parseRemoteHostTeamAddMember,
  parseRemoteHostTeamList,
  parseRemoteHostTeamMutationTarget,
  parseRemoteHostUsageProvider,
  parseRemoteHostUsageToken,
} from './input-validation-teams-usage';

const EXPECTED_AUTHORITY = {
  authoritativeCoreId: 'core-a',
  workerGeneration: 3,
};

describe('Remote team and usage IPC input validation', () => {
  it('accepts exact bounded team reads and revision-bound mutations', () => {
    expect(parseRemoteHostTeamList({
      profileId: 'remote-a', includeArchived: false, limit: 200,
    })).toEqual({ profileId: 'remote-a', includeArchived: false, limit: 200 });
    expect(parseRemoteHostTeamMutationTarget({
      profileId: 'remote-a', teamId: 'team-a', expectedAuthority: EXPECTED_AUTHORITY,
      expectedRevision: 4, intentId: 'intent-a',
    })).toMatchObject({ teamId: 'team-a', expectedRevision: 4, intentId: 'intent-a' });
    expect(parseRemoteHostTeamAddMember({
      profileId: 'remote-a', teamId: 'team-a', sessionId: 'session-b', role: 'teammate',
      expectedAuthority: EXPECTED_AUTHORITY, expectedRevision: 4, intentId: 'intent-b',
    })).toMatchObject({ sessionId: 'session-b', role: 'teammate' });
  });

  it('rejects extra fields, missing intent fencing, and incompatible team roles', () => {
    expect(() => parseRemoteHostTeamList({
      profileId: 'remote-a', includeArchived: false, limit: 200, offset: 0,
    })).toThrow('unexpected fields');
    expect(() => parseRemoteHostTeamMutationTarget({
      profileId: 'remote-a', teamId: 'team-a', expectedRevision: 4,
    })).toThrow('unexpected fields');
    expect(() => parseRemoteHostTeamAddMember({
      profileId: 'remote-a', teamId: 'team-a', sessionId: 'session-b', role: 'owner',
      expectedAuthority: EXPECTED_AUTHORITY, expectedRevision: 4, intentId: 'intent-b',
    })).toThrow('invalid team member request');
  });

  it('accepts only exact bounded usage reads', () => {
    expect(parseRemoteHostUsageToken({
      profileId: 'remote-a', includeDaily: true, dailyLimit: 500,
    })).toEqual({ profileId: 'remote-a', includeDaily: true, dailyLimit: 500 });
    expect(parseRemoteHostUsageProvider({ profileId: 'remote-a', force: true }))
      .toEqual({ profileId: 'remote-a', force: true });
    expect(() => parseRemoteHostUsageToken({
      profileId: 'remote-a', includeDaily: true, dailyLimit: 0,
    })).toThrow('invalid token usage request');
    expect(() => parseRemoteHostUsageProvider({
      profileId: 'remote-a', force: false, provider: 'codex-cli',
    })).toThrow('unexpected fields');
  });
});
