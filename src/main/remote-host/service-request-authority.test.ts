import { describe, expect, it, vi } from 'vitest';

import type { ElectronHostRegistry } from '@hosts/electron';

import { RemoteHostRequestAuthority } from './service-request-authority';
import { RemoteHostScopeEpochs } from './service-scope';

describe('RemoteHostRequestAuthority mutation origin', () => {
  it('rejects a changed Core authority before selecting a client', async () => {
    const getClient = vi.fn();
    const authority = new RemoteHostRequestAuthority({
      active: () => true,
      registry: {
        getClient,
        state: vi.fn(() => ({
          status: 'connected',
          authoritativeCoreId: 'core-current',
          workerGeneration: 2,
        })),
      } as unknown as ElectronHostRegistry,
      scopes: new RemoteHostScopeEpochs(),
      source: () => ({ mode: 'remote', selectedProfileId: 'profile-a' }),
    });

    await expect(authority.request(
      'profile-a',
      'session.send',
      vi.fn(),
      [],
      { authoritativeCoreId: 'core-origin', workerGeneration: 1 },
    )).rejects.toMatchObject({ code: 'stale_scope' });
    expect(getClient).not.toHaveBeenCalled();
  });

  it('fails closed when a Remote mutation omits its origin authority', async () => {
    const getClient = vi.fn();
    const authority = new RemoteHostRequestAuthority({
      active: () => true,
      registry: { getClient } as unknown as ElectronHostRegistry,
      scopes: new RemoteHostScopeEpochs(),
      source: () => ({ mode: 'remote', selectedProfileId: 'profile-a' }),
    });

    await expect(authority.request('profile-a', 'session.send', vi.fn()))
      .rejects.toMatchObject({ code: 'stale_scope' });
    expect(getClient).not.toHaveBeenCalled();
  });
});
