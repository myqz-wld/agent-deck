import { describe, expect, it, vi } from 'vitest';

import { AgentDeckCapability, type AgentDeckCapability as Capability } from '@contracts/index';
import { ElectronHostRegistry } from '@hosts/electron';
import {
  ControlledClient,
  deferred,
  remoteHello,
  remoteProfile,
  standaloneProfile,
} from '@hosts/electron/__tests__/registry-fixture';

import { MemoryCredentialMaterialStore, testConnectionSelections } from './test-connection-fixture';
import type { RemoteHostProfileDocument } from './profile-document';
import { RemoteHostProfileStore, type RemoteHostProfileBackend } from './profile-store';
import { RemoteHostService } from './service';

class MemoryBackend implements RemoteHostProfileBackend {
  constructor(public value: RemoteHostProfileDocument) {}
  read(): unknown { return structuredClone(this.value); }
  write(value: RemoteHostProfileDocument): void { this.value = structuredClone(value); }
}

function harness(options: { local?: boolean; twoRemotes?: boolean } = {}) {
  const local = standaloneProfile('local');
  const firstProfile = remoteProfile('remote-a', 'server-core');
  const secondProfile = remoteProfile('remote-b', 'server-core');
  const clients = new Map([
    [firstProfile.id, new ControlledClient({
      ...remoteHello(firstProfile),
      capabilities: Object.values(AgentDeckCapability) as Capability[],
    })],
    [secondProfile.id, new ControlledClient({
      ...remoteHello(secondProfile),
      capabilities: Object.values(AgentDeckCapability) as Capability[],
    })],
  ]);
  const registry = new ElectronHostRegistry({
    appVersion: 'desktop-test',
    createClient: (profile) => ({ client: clients.get(profile.id)! }),
  });
  const profiles = options.twoRemotes ? [local, firstProfile, secondProfile] : [local, firstProfile];
  const backend = new MemoryBackend({
    schemaVersion: 3,
    sourceMode: options.local ? 'local' : 'remote',
    selectedRemoteProfileId: firstProfile.id,
    profiles,
  });
  let id = 0;
  const createId = () => `race-${++id}`;
  const service = new RemoteHostService({
    registry,
    store: new RemoteHostProfileStore(backend, { create: createId }),
    connections: testConnectionSelections(createId),
    materials: new MemoryCredentialMaterialStore(),
    createId,
  });
  return { backend, clients, firstProfile, local, registry, secondProfile, service };
}

describe('RemoteHostService lifecycle admission', () => {
  it('switches to Local immediately and fences a later connect result without closing transport', async () => {
    const context = harness();
    const gate = deferred<ReturnType<typeof remoteHello>>();
    const client = context.clients.get(context.firstProfile.id)!;
    vi.spyOn(client, 'connect').mockImplementation(async (hello) => {
      client.connectHellos.push(hello);
      return gate.promise;
    });

    const connecting = context.service.connect(context.firstProfile.id);
    await Promise.resolve();
    const local = await context.service.setSourceMode('local');
    expect(local).toMatchObject({
      sourceMode: 'local',
      selectedRemoteProfileId: context.firstProfile.id,
    });
    expect(context.registry.selectedProfileId).toBe(context.local.id);
    expect(client.closeSpy).not.toHaveBeenCalled();

    gate.resolve(remoteHello(context.firstProfile));
    await expect(connecting).rejects.toMatchObject({ code: 'stale_scope' });
    expect((await context.service.getSnapshot()).sourceMode).toBe('local');
  });

  it('starts local SSH retirement during shutdown without waiting for a pending connect', async () => {
    const context = harness();
    const gate = deferred<ReturnType<typeof remoteHello>>();
    const client = context.clients.get(context.firstProfile.id)!;
    vi.spyOn(client, 'connect').mockImplementation(() => gate.promise);
    const connecting = context.service.connect(context.firstProfile.id);
    await Promise.resolve();

    const shutdown = context.service.shutdown();
    await Promise.resolve();
    await Promise.resolve();
    expect(client.closeSpy).toHaveBeenCalledOnce();

    gate.resolve(remoteHello(context.firstProfile));
    await expect(connecting).rejects.toBeTruthy();
    await expect(shutdown).resolves.toBeUndefined();
    await expect(context.service.connect(context.firstProfile.id)).rejects.toMatchObject({
      code: 'service_stopped',
    });
  });

  it('lets profile management remember and connect another remote while Local stays active', async () => {
    const context = harness({ local: true, twoRemotes: true });
    await context.service.selectProfile(context.secondProfile.id);
    await context.service.connect(context.secondProfile.id);
    await context.service.disconnect(context.secondProfile.id);

    const snapshot = await context.service.getSnapshot();
    expect(snapshot).toMatchObject({
      sourceMode: 'local',
      selectedRemoteProfileId: context.secondProfile.id,
    });
    expect(context.registry.selectedProfileId).toBe(context.local.id);
    expect(context.backend.value.sourceMode).toBe('local');
  });
});
