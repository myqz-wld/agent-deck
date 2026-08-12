import { describe, expect, it, vi } from 'vitest';

import type { RemoteHostScopedClient } from './service-scope';
import { RemoteHostTeamController, RemoteHostUsageController } from './service-teams-usage';

const EXPECTED_AUTHORITY = {
  authoritativeCoreId: 'core-a',
  workerGeneration: 3,
};

function scoped(clientRequest: ReturnType<typeof vi.fn>) {
  const admitted = vi.fn(async (
    _profileId: string,
    _method: string,
    run: (scope: RemoteHostScopedClient) => Promise<unknown>,
  ) => run({
    client: { request: clientRequest } as unknown as RemoteHostScopedClient['client'],
    profileEpoch: 1,
    profileId: 'remote-a',
    sourceEpoch: 1,
  }));
  return { admitted, request: admitted as never };
}

const summary = {
  id: 'team-a', name: 'Reviewers', createdAt: 1, archivedAt: null,
  memberCount: 1, lastEventAt: 2,
} as const;

describe('Remote team and usage service controllers', () => {
  it('binds Team mutations to the admitted profile, revision, and stable idempotency key', async () => {
    const clientRequest = vi.fn(async () => ({ team: summary, revision: 5 }));
    const scope = scoped(clientRequest);
    const controller = new RemoteHostTeamController(
      scope.request,
      (operation, profileId, intentId) => `${operation}:${profileId}:${intentId}`,
    );

    await expect(controller.archive({
      profileId: 'remote-a', teamId: 'team-a', expectedAuthority: EXPECTED_AUTHORITY,
      expectedRevision: 4, intentId: 'intent-a',
    })).resolves.toEqual({ team: summary, revision: 5 });
    expect(scope.admitted).toHaveBeenCalledWith(
      'remote-a', 'teams.archive', expect.any(Function), [], EXPECTED_AUTHORITY,
    );
    expect(clientRequest).toHaveBeenCalledWith(
      'teams.archive',
      { teamId: 'team-a' },
      { deadlineMs: 45_000, expectedRevision: 4, idempotencyKey: 'archive:remote-a:intent-a' },
    );
  });

  it('requests exact bounded Team lists and rejects an inexact Core response', async () => {
    const clientRequest = vi.fn(async (): Promise<unknown> => ({ teams: [summary], revision: 4 }));
    const scope = scoped(clientRequest);
    const controller = new RemoteHostTeamController(scope.request, vi.fn(() => 'mutation-a'));
    await expect(controller.list({
      profileId: 'remote-a', includeArchived: false, limit: 20,
    })).resolves.toEqual({ teams: [summary], revision: 4 });
    expect(clientRequest).toHaveBeenCalledWith(
      'teams.list',
      { includeArchived: false, limit: 20 },
      { deadlineMs: 45_000 },
    );
    clientRequest.mockResolvedValueOnce({ teams: [{ ...summary, hostPath: '/private' }], revision: 4 });
    await expect(controller.list({
      profileId: 'remote-a', includeArchived: false, limit: 20,
    })).rejects.toThrow();
    clientRequest.mockResolvedValueOnce({
      teams: [{ ...summary, archivedAt: 3 }], revision: 4,
    });
    await expect(controller.list({
      profileId: 'remote-a', includeArchived: false, limit: 20,
    })).rejects.toThrow();
  });

  it('rejects a targeted Team response for another entity', async () => {
    const clientRequest = vi.fn(async (): Promise<unknown> => ({
      team: { ...summary, id: 'team-other' }, revision: 5,
    }));
    const scope = scoped(clientRequest);
    const controller = new RemoteHostTeamController(scope.request, vi.fn(() => 'mutation-a'));

    await expect(controller.archive({
      profileId: 'remote-a', teamId: 'team-a', expectedAuthority: EXPECTED_AUTHORITY,
      expectedRevision: 4, intentId: 'intent-a',
    })).rejects.toThrow();
  });

  it('forwards token and provider usage reads through capability admission', async () => {
    const clientRequest = vi.fn(async (method: string) => method === 'usage.tokens.get'
      ? {
          rates: [], topToday: [], daily: [], dailyTruncated: false,
          today: '2026-08-10', revision: 4,
        }
      : { snapshots: [], revision: 4 });
    const scope = scoped(clientRequest);
    const controller = new RemoteHostUsageController(scope.request);

    await expect(controller.tokens({
      profileId: 'remote-a', includeDaily: true, dailyLimit: 500,
    })).resolves.toMatchObject({ daily: [], revision: 4 });
    await expect(controller.providers({ profileId: 'remote-a', force: true }))
      .resolves.toEqual({ snapshots: [], revision: 4 });
    expect(clientRequest).toHaveBeenNthCalledWith(
      1, 'usage.tokens.get', { includeDaily: true, dailyLimit: 500 }, { deadlineMs: 45_000 },
    );
    expect(clientRequest).toHaveBeenNthCalledWith(
      2, 'usage.providers.get', { force: true }, { deadlineMs: 45_000 },
    );
  });
});
