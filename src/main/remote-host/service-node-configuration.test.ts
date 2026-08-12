import { describe, expect, it, vi } from 'vitest';

import type { RemoteHostScopedClient } from './service-scope';
import { RemoteHostNodeConfigurationController } from './service-node-configuration';

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
        supported: true,
        state: 'installed',
        scope: 'user',
        writeAllowed: true,
        disabledReason: null,
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
      expectedAuthority: EXPECTED_AUTHORITY,
      intentId: 'intent-a',
    });
    expect(clientRequest).toHaveBeenCalledWith(
      'node.hook.projection.install',
      { adapterId: 'claude-code' },
      {
        deadlineMs: 45_000,
        idempotencyKey: 'node-hook-install:remote-a:intent-a',
      },
    );
  });

  it('rejects a Hook projection returned for a different adapter', async () => {
    const clientRequest = vi.fn(async () => ({
      adapterId: 'grok-build',
      revision: 6,
      status: {
        supported: false,
        state: 'unavailable',
        scope: null,
        writeAllowed: false,
        disabledReason: 'adapter-unavailable',
      },
    }));
    const scope = scoped(clientRequest);
    const controller = new RemoteHostNodeConfigurationController(
      scope.request,
      vi.fn(() => 'mutation-a'),
    );
    await expect(controller.status({
      profileId: 'remote-a',
      adapterId: 'claude-code',
    })).rejects.toMatchObject({ code: 'protocol_violation' });
  });
});
