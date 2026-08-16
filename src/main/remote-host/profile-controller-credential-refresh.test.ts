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

describe('RemoteHostProfileController credential refresh', () => {
  it('blocks a migrated credential until an imported replacement clears the marker', async () => {
    const local = standaloneProfile('local');
    const remote = {
      ...remoteProfile('server-a', 'full'),
      connectionCredentialStatus: 'refresh-required' as const,
    };
    const client = new ControlledClient(remoteHello(remote));
    const createClient = vi.fn(() => ({ client }));
    const registry = new ElectronHostRegistry({ appVersion: 'desktop-test', createClient });
    const backend = new MemoryBackend({
      schemaVersion: 4,
      sourceMode: 'local',
      selectedRemoteProfileId: remote.id,
      profiles: [local, remote],
    });
    let generated = 0;
    const createId = () => `generated-${++generated}`;
    const connections = testConnectionSelections(createId, () => testConnectionCredential({
      label: 'Replacement',
      instanceId: remote.ssh.expectedInstanceId,
      connectionScope: `credential-${remote.id}`,
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

    await expect(controller.connect(remote.id)).rejects.toThrow('重新导入连接凭据');
    expect(() => controller.setSourceMode('remote')).toThrow('重新导入连接凭据');
    expect(createClient).not.toHaveBeenCalled();

    const selection = connections.capture('/replacement.agentdeck-connection');
    await controller.update(remote.id, {
      label: 'Replacement',
      connectionSelectionId: selection.selectionId,
    });

    expect(backend.value.profiles[1]).not.toHaveProperty('connectionCredentialStatus');
    expect(backend.value.profiles[1]).toMatchObject({
      ssh: { expectedConnectionScope: `credential-${remote.id}` },
    });
    await expect(controller.connect(remote.id)).resolves.toBeUndefined();
    expect(createClient).toHaveBeenCalledOnce();
  });
});
