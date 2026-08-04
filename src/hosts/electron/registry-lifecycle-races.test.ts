import { describe, expect, it, vi } from 'vitest';

import type { HostHello } from '@contracts/index';

import { ElectronHostRegistry } from './registry';
import {
  ControlledClient,
  deferred,
  standaloneHello,
  standaloneProfile,
} from './__tests__/registry-fixture';

describe('ElectronHostRegistry terminal lifecycle fences', () => {
  it('rejects connect during remove and never orphans a replacement binding', async () => {
    const profile = standaloneProfile('remove-connect-race');
    const current = new ControlledClient(standaloneHello(profile.clientId));
    const replacement = new ControlledClient(standaloneHello(profile.clientId));
    const closeGate = deferred<void>();
    current.closeSpy.mockImplementation(() => closeGate.promise);
    const bindings = [current, replacement];
    const createClient = vi.fn(() => ({ client: bindings.shift() as ControlledClient }));
    const registry = new ElectronHostRegistry({ appVersion: 'desktop-test', createClient });
    registry.register(profile);
    await registry.connect(profile.id);

    const removing = registry.remove(profile.id);
    await expect(registry.connect(profile.id)).rejects.toThrow('being removed');
    expect(() => registry.select(profile.id)).toThrow('being removed');
    expect(() => registry.updateNavigation(profile.id, { route: '/new' })).toThrow(
      'being removed',
    );
    expect(createClient).toHaveBeenCalledOnce();
    closeGate.resolve(undefined);
    await removing;

    expect(current.closeSpy).toHaveBeenCalledOnce();
    expect(replacement.closeSpy).not.toHaveBeenCalled();
    expect(createClient).toHaveBeenCalledOnce();
    expect(() => registry.state(profile.id)).toThrow('Unknown host profile');
  });

  it('makes stopAll terminal against active and later connect attempts', async () => {
    const profile = standaloneProfile('stop-connect-race');
    const hello = standaloneHello(profile.clientId);
    const client = new ControlledClient(hello);
    const connectGate = deferred<HostHello>();
    client.connect = vi.fn(() => connectGate.promise);
    const createClient = vi.fn(() => ({ client }));
    const registry = new ElectronHostRegistry({ appVersion: 'desktop-test', createClient });
    registry.register(profile);
    const connecting = registry.connect(profile.id);

    const stopping = registry.stopAll();
    await expect(registry.connect(profile.id)).rejects.toThrow('stopping');
    expect(() => registry.select(profile.id)).toThrow('stopping');
    expect(() => registry.register(standaloneProfile('after-stop'))).toThrow('stopping');
    connectGate.resolve(hello);
    await expect(connecting).rejects.toThrow('replaced');
    await stopping;

    expect(client.closeSpy).toHaveBeenCalledOnce();
    expect(createClient).toHaveBeenCalledOnce();
    expect(registry.getClient(profile.id)).toBeNull();
    await expect(registry.stopAll()).resolves.toBeUndefined();
    expect(client.closeSpy).toHaveBeenCalledOnce();
  });

  it('captures a connect before a reentrant state observer starts shutdown', async () => {
    const profile = standaloneProfile('reentrant-stop');
    const hello = standaloneHello(profile.clientId);
    const client = new ControlledClient(hello);
    const connectGate = deferred<HostHello>();
    client.connect = vi.fn(() => connectGate.promise);
    const registry = new ElectronHostRegistry({
      appVersion: 'desktop-test',
      createClient: () => ({ client }),
    });
    registry.register(profile);
    let stopping: Promise<void> | null = null;
    registry.onState((state) => {
      if (state.status === 'connecting' && !stopping) stopping = registry.stopAll();
    });

    const connecting = registry.connect(profile.id);
    expect(stopping).not.toBeNull();
    connectGate.resolve(hello);
    await expect(connecting).rejects.toThrow('replaced');
    await expect(stopping).resolves.toBeUndefined();
    expect(client.closeSpy).toHaveBeenCalledOnce();
    expect(registry.getClient(profile.id)).toBeNull();
  });

  it('retires a created binding when observeTransport setup throws', async () => {
    const profile = standaloneProfile('observe-setup-failure');
    const client = new ControlledClient(standaloneHello(profile.clientId));
    const registry = new ElectronHostRegistry({
      appVersion: 'desktop-test',
      createClient: () => ({
        client,
        observeTransport: () => {
          throw new Error('observe setup failed');
        },
      }),
    });
    registry.register(profile);

    await expect(registry.connect(profile.id)).rejects.toThrow('observe setup failed');
    expect(client.closeSpy).toHaveBeenCalledOnce();
    expect(registry.getClient(profile.id)).toBeNull();
  });

  it('retires a connected binding when event subscription setup throws', async () => {
    const profile = standaloneProfile('subscribe-setup-failure');
    const client = new ControlledClient(standaloneHello(profile.clientId));
    client.subscribe = vi.fn(() => {
      throw new Error('subscribe setup failed');
    });
    const registry = new ElectronHostRegistry({
      appVersion: 'desktop-test',
      createClient: () => ({ client }),
    });
    registry.register(profile);

    await expect(registry.connect(profile.id)).rejects.toThrow('subscribe setup failed');
    expect(client.closeSpy).toHaveBeenCalledOnce();
    expect(registry.getClient(profile.id)).toBeNull();
  });

  it('retires non-SSH bindings on event instance identity mismatch', async () => {
    const profile = standaloneProfile('event-identity-mismatch');
    const client = new ControlledClient(standaloneHello(profile.clientId));
    const registry = new ElectronHostRegistry({
      appVersion: 'desktop-test',
      createClient: () => ({ client }),
    });
    registry.register(profile);
    await registry.connect(profile.id);

    client.emitEvent({
      instanceId: 'different-instance',
      revision: 1,
      kind: 'session.updated',
      entityId: null,
      payload: {},
    });
    await vi.waitFor(() => expect(client.closeSpy).toHaveBeenCalledOnce());
    expect(registry.getClient(profile.id)).toBeNull();
    expect(registry.state(profile.id)).toMatchObject({
      status: 'incompatible',
      error: { code: 'host_identity_mismatch' },
    });
  });
});
