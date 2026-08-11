import { describe, expect, it, vi } from 'vitest';

import type { RemoteHostScopedClient } from './service-scope';
import { RemoteHostNodeConfigurationController } from './service-node-configuration';

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

describe('RemoteHostNodeConfigurationController', () => {
  it('reads the selected Core configuration without a local fallback', async () => {
    const clientRequest = vi.fn(async () => ({
      providerDefaults: {
        claudeCodeSandbox: 'strict',
        codexSandbox: 'read-only',
        enableAgentDeckMcp: true,
        grokSandbox: 'off',
        permissionTimeoutMs: 30_000,
        summaryModel: 'summary',
        summaryThinking: 'low',
        summaryTimeoutMs: 60_000,
      },
      revision: 5,
    }));
    const scope = scoped(clientRequest);
    const controller = new RemoteHostNodeConfigurationController(
      scope.request,
      vi.fn(() => 'mutation-a'),
    );
    await expect(controller.get({ profileId: 'remote-a' })).resolves.toMatchObject({
      revision: 5,
      providerDefaults: { claudeCodeSandbox: 'strict' },
    });
    expect(scope.admitted).toHaveBeenCalledWith(
      'remote-a',
      'node.configuration.get',
      expect.any(Function),
    );
  });

  it('binds Hook installation to the selected Core and a stable intent', async () => {
    const clientRequest = vi.fn(async () => ({
      adapterId: 'claude-code',
      revision: 6,
      status: {
        installed: true,
        installedHooks: ['SessionStart'],
        scope: 'user',
        settingsPath: '/provider-home/.claude/settings.json',
      },
    }));
    const scope = scoped(clientRequest);
    const controller = new RemoteHostNodeConfigurationController(
      scope.request,
      (operation, profileId, intentId) => `${operation}:${profileId}:${intentId}`,
    );
    await controller.install({
      profileId: 'remote-a',
      adapterId: 'claude-code',
      intentId: 'intent-a',
    });
    expect(clientRequest).toHaveBeenCalledWith(
      'node.hook.install',
      { adapterId: 'claude-code' },
      {
        deadlineMs: 45_000,
        idempotencyKey: 'node-hook-install:remote-a:intent-a',
      },
    );
  });
});
