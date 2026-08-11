import { describe, expect, it, vi } from 'vitest';

import type { RemoteHostScopedClient } from './service-scope';
import { RemoteHostSessionStateController } from './service-session-state';

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

describe('RemoteHostSessionStateController', () => {
  it('reads authoritative context usage without a desktop fallback', async () => {
    const clientRequest = vi.fn(async () => ({
      contextUsage: {
        usedTokens: 120,
        windowTokens: 1_000,
        updatedAt: 8,
        runtimeIdentity: null,
      },
      revision: 9,
    }));
    const scope = scoped(clientRequest);
    const controller = new RemoteHostSessionStateController(
      scope.request,
      vi.fn(),
      vi.fn(),
    );

    await expect(controller.context({ profileId: 'remote-a', sessionId: 'session-a' }))
      .resolves.toMatchObject({ contextUsage: { usedTokens: 120 }, revision: 9 });
    expect(clientRequest).toHaveBeenCalledWith(
      'session.context.get',
      { sessionId: 'session-a' },
      { deadlineMs: 45_000 },
    );
  });

  it('reads the adapter-owned active-turn image policy', async () => {
    const clientRequest = vi.fn(async () => ({
      adapterId: 'grok-build',
      activeTurn: {
        mode: 'interject',
        attachments: {
          disabledReason: null,
          enabled: true,
          maxBytesEach: 2_097_152,
          maxBytesTotal: 2_097_152,
          maxCount: 4,
          mimeTypes: ['image/png'],
        },
      },
      revision: 10,
    }));
    const scope = scoped(clientRequest);
    const controller = new RemoteHostSessionStateController(
      scope.request,
      vi.fn(),
      vi.fn(),
    );

    await expect(controller.inputCapabilities({
      profileId: 'remote-a', sessionId: 'session-a',
    })).resolves.toMatchObject({
      adapterId: 'grok-build',
      activeTurn: { mode: 'interject', attachments: { enabled: true } },
    });
    expect(clientRequest).toHaveBeenCalledWith(
      'session.input.capabilities',
      { sessionId: 'session-a' },
      { deadlineMs: 45_000 },
    );
  });
});
