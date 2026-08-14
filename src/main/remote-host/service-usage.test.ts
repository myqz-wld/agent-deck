import { describe, expect, it, vi } from 'vitest';

import type { RemoteHostScopedClient } from './service-scope';
import { RemoteHostUsageController } from './service-usage';

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

describe('Remote usage service controller', () => {
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
