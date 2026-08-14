import type { AgentDeckClient, CoreMethodMap } from '@contracts/index';
import { describe, expect, it, vi } from 'vitest';

import { createElectronHostClientFactory } from './client-factory';
import { ElectronHostRegistry } from './registry';

describe('Electron host production client boundary', () => {
  it('creates SSH clients in the host and exposes only renderer-safe profile fields', () => {
    const createStandalone = vi.fn(() => ({
      client: { close: vi.fn() } as unknown as AgentDeckClient<CoreMethodMap>,
    }));
    const registry = new ElectronHostRegistry({
      appVersion: 'test',
      createClient: createElectronHostClientFactory({ createStandalone }),
    });
    registry.register({
      id: 'remote-a',
      label: 'Remote A',
      clientId: 'desktop-a',
      topology: 'full',
      ssh: {
        id: 'remote-a',
        label: 'Remote A',
        topology: 'full',
        hostname: 'core.example.test',
        port: 22,
        username: 'agent-deck',
        identityFile: '/private/keys/agent-deck',
        knownHostsFile: '/private/trust/known_hosts',
        sshBinary: '/private/bin/ssh',
        expectedInstanceId: 'tenant-a',
      },
    });

    expect(registry.listProfiles()[0]).toMatchObject({
      ssh: { identityFile: '/private/keys/agent-deck' },
    });
    const publicJson = JSON.stringify(registry.listPublicProfiles());
    expect(publicJson).toContain('core.example.test');
    expect(publicJson).not.toContain('/private/keys');
    expect(publicJson).not.toContain('/private/trust');
    expect(publicJson).not.toContain('/private/bin');
  });

  it('keeps standalone creation behind the injected local Core binding', () => {
    const binding = {
      client: { close: vi.fn() } as unknown as AgentDeckClient<CoreMethodMap>,
    };
    const createStandalone = vi.fn(() => binding);
    const factory = createElectronHostClientFactory({ createStandalone });
    expect(
      factory({
        id: 'local',
        label: 'Local',
        clientId: 'desktop-local',
        topology: 'standalone',
      }),
    ).toBe(binding);
    expect(createStandalone).toHaveBeenCalledOnce();
  });
});
