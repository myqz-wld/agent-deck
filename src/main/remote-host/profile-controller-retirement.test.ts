import { describe, expect, it, vi } from 'vitest';

import { ElectronHostRegistry } from '@hosts/electron';
import {
  ControlledClient,
  remoteHello,
  remoteProfile,
  standaloneProfile,
} from '@hosts/electron/__tests__/registry-fixture';

import type { RemoteHostProfileDocument } from './profile-document';
import { RemoteHostProfileController } from './profile-controller';
import { RemoteHostProfileStore, type RemoteHostProfileBackend } from './profile-store';
import {
  MemoryCredentialMaterialStore,
  testConnectionCredential,
  testConnectionSelections,
} from './test-connection-fixture';

class MemoryBackend implements RemoteHostProfileBackend {
  constructor(public value: RemoteHostProfileDocument) {}
  read(): unknown { return structuredClone(this.value); }
  write(value: RemoteHostProfileDocument): void { this.value = structuredClone(value); }
}

describe('RemoteHostProfileController retirement fencing', () => {
  it('keeps an uncertain retirement fail-closed without consuming credentials or spawning twice', async () => {
    const local = standaloneProfile('local');
    const remote = remoteProfile('server-a', 'full');
    const client = new ControlledClient(remoteHello(remote));
    const createClient = vi.fn(() => ({ client }));
    const registry = new ElectronHostRegistry({ appVersion: 'desktop-test', createClient });
    const backend = new MemoryBackend({
      schemaVersion: 4,
      sourceMode: 'remote',
      selectedRemoteProfileId: remote.id,
      profiles: [local, remote],
    });
    let generated = 0;
    const createId = () => `generated-${++generated}`;
    const connections = testConnectionSelections(createId, () => testConnectionCredential({
      label: 'Replacement', instanceId: 'replacement',
      endpoint: { hostname: 'replacement.example.test', port: 22, username: 'agentdeck' },
    }));
    const controller = new RemoteHostProfileController(backend.value, {
      registry,
      store: new RemoteHostProfileStore(backend, { create: createId }),
      connections,
      materials: new MemoryCredentialMaterialStore(),
      createId,
      onProfileRescope: vi.fn(),
      onSourceRescope: vi.fn(),
    });
    await controller.connect(remote.id);
    client.closeSpy.mockRejectedValue(new Error('child retirement uncertain'));
    const before = structuredClone(backend.value);
    const connection = connections.capture('/new/fenced.agentdeck-connection');
    const replacement = {
      label: '不得安装的替代 Core',
      connectionSelectionId: connection.selectionId,
    };

    await expect(controller.update(remote.id, replacement))
      .rejects.toThrow('child retirement uncertain');
    await expect(controller.update(remote.id, replacement))
      .rejects.toThrow('child retirement uncertain');

    expect(backend.value).toEqual(before);
    expect(createClient).toHaveBeenCalledOnce();
    expect(client.connectHellos).toHaveLength(1);
    expect(client.closeSpy).toHaveBeenCalledOnce();
    expect(registry.getClient(remote.id)).toBeNull();
    expect(connections.resolve(connection.selectionId)).toMatchObject({ instanceId: 'replacement' });
  });
});
