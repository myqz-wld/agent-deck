import { describe, expect, it, vi } from 'vitest';

import type { SshConnectionState } from '@clients/ssh';

import { ElectronHostRegistry } from './registry';
import {
  ControlledClient,
  deferred,
  remoteHello,
  remoteProfile,
  standaloneHello,
  standaloneProfile,
} from './__tests__/registry-fixture';

describe('ElectronHostRegistry retirement barriers', () => {
  it('awaits incompatible binding cleanup before installing its replacement', async () => {
    const profile = standaloneProfile('incompatible-reconnect');
    const mismatchedProfile = remoteProfile('mismatched', 'server-core');
    const oldClient = new ControlledClient(remoteHello(mismatchedProfile));
    const replacement = new ControlledClient(standaloneHello(profile.clientId));
    const closeGate = deferred<void>();
    oldClient.closeSpy.mockImplementation(() => closeGate.promise);
    const clients = [oldClient, replacement];
    const createClient = vi.fn(() => ({ client: clients.shift() as ControlledClient }));
    const registry = new ElectronHostRegistry({ appVersion: 'desktop-test', createClient });
    registry.register(profile);

    await expect(registry.connect(profile.id)).rejects.toMatchObject({
      code: 'incompatible_handshake',
    });
    expect(oldClient.closeSpy).toHaveBeenCalledOnce();
    const reconnecting = registry.connect(profile.id);
    await Promise.resolve();
    expect(createClient).toHaveBeenCalledOnce();
    expect(registry.getClient(profile.id)).toBeNull();

    closeGate.resolve(undefined);
    await reconnecting;
    expect(createClient).toHaveBeenCalledTimes(2);
    expect(registry.getClient(profile.id)).toBe(replacement);
    await registry.stopAll();
  });

  it('makes remove await an already-running incompatible retirement', async () => {
    const profile = standaloneProfile('incompatible-remove');
    const mismatchedProfile = remoteProfile('mismatched-remove', 'server-core');
    const client = new ControlledClient(remoteHello(mismatchedProfile));
    const closeGate = deferred<void>();
    client.closeSpy.mockImplementation(() => closeGate.promise);
    const registry = new ElectronHostRegistry({
      appVersion: 'desktop-test',
      createClient: () => ({ client }),
    });
    registry.register(profile);
    await expect(registry.connect(profile.id)).rejects.toMatchObject({
      code: 'incompatible_handshake',
    });

    let removed = false;
    const removing = registry.remove(profile.id).then(() => {
      removed = true;
    });
    await Promise.resolve();
    expect(removed).toBe(false);
    closeGate.resolve(undefined);
    await removing;
    expect(removed).toBe(true);
    expect(() => registry.state(profile.id)).toThrowError('Unknown host profile');
  });

  it('keeps a rejected retirement as a fail-closed install barrier', async () => {
    const profile = standaloneProfile('cleanup-reject');
    const client = new ControlledClient(standaloneHello(profile.clientId));
    client.closeSpy.mockRejectedValue(new Error('child cleanup failed'));
    const createClient = vi.fn(() => ({ client }));
    const registry = new ElectronHostRegistry({ appVersion: 'desktop-test', createClient });
    registry.register(profile);
    await registry.connect(profile.id);
    await expect(registry.disconnect(profile.id)).rejects.toThrow('child cleanup failed');
    await expect(registry.connect(profile.id)).rejects.toThrow('child cleanup failed');
    expect(createClient).toHaveBeenCalledOnce();
    expect(registry.getClient(profile.id)).toBeNull();
    expect(registry.state(profile.id)).toMatchObject({
      status: 'offline',
      error: { code: 'transport-close-failed' },
    });
  });

  it('retires an internally incompatible transport before explicit reconnect', async () => {
    const profile = remoteProfile('transport-incompatible', 'server-core');
    const oldClient = new ControlledClient(remoteHello(profile));
    const replacement = new ControlledClient(remoteHello(profile));
    const closeGate = deferred<void>();
    oldClient.closeSpy.mockImplementation(() => closeGate.promise);
    let transportListener: ((state: SshConnectionState) => void) | null = null;
    const bindings = [
      {
        client: oldClient,
        observeTransport: (listener: (state: SshConnectionState) => void) => {
          transportListener = listener;
          return { close: () => undefined };
        },
      },
      { client: replacement },
    ];
    const registry = new ElectronHostRegistry({
      appVersion: 'desktop-test',
      createClient: () => bindings.shift() as (typeof bindings)[number],
    });
    registry.register(profile);
    await registry.connect(profile.id);
    const hello = remoteHello(profile);
    if (!transportListener) throw new Error('Missing transport listener');
    const notifyTransport = transportListener as (state: SshConnectionState) => void;
    notifyTransport({
      profileId: profile.id,
      topology: profile.topology,
      status: 'incompatible',
      attempt: 0,
      hello,
      reason: 'protocol rejected',
      errorCode: 'incompatible_protocol',
    });
    expect(registry.getClient(profile.id)).toBeNull();
    expect(registry.state(profile.id).status).toBe('incompatible');

    const reconnecting = registry.connect(profile.id);
    await Promise.resolve();
    expect(bindings).toHaveLength(1);
    closeGate.resolve(undefined);
    await reconnecting;
    expect(registry.getClient(profile.id)).toBe(replacement);
    await registry.stopAll();
  });
});
