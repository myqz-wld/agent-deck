import { vi } from 'vitest';

import {
  AgentDeckCapability,
  type AgentDeckCapability as Capability,
} from '@contracts/index';
import type { SshConnectionState } from '@clients/ssh';
import { ElectronHostRegistry, type ElectronHostClientBinding } from '@hosts/electron';
import {
  ControlledClient,
  remoteHello,
  remoteProfile,
  standaloneProfile,
} from '@hosts/electron/__tests__/registry-fixture';

import type { RemoteHostProfileDocument } from './profile-document';
import { RemoteHostProfileStore, type RemoteHostProfileBackend } from './profile-store';
import { RemoteHostService } from './service';
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

export function fullHello(profile: ReturnType<typeof remoteProfile>) {
  return {
    ...remoteHello(profile),
    capabilities: Object.values(AgentDeckCapability) as Capability[],
  };
}

export function expectedAuthority(profileId: string) {
  return { authoritativeCoreId: `core-${profileId}`, workerGeneration: null };
}

export function remoteHostServiceHarness(bindings?: ElectronHostClientBinding[]) {
  const local = standaloneProfile('local');
  const remote = remoteProfile('server-a', 'full');
  remote.ssh.identityFile = '/private/keys/desktop-key';
  remote.ssh.knownHostsFile = '/private/trust/known_hosts';
  const first = new ControlledClient(fullHello(remote));
  const queue = bindings ?? [{ client: first }];
  const registry = new ElectronHostRegistry({
    appVersion: 'desktop-test',
    createClient: () => queue.shift() as ElectronHostClientBinding,
  });
  const backend = new MemoryBackend({
    schemaVersion: 4,
    sourceMode: 'remote',
    selectedRemoteProfileId: remote.id,
    profiles: [local, remote],
  });
  let generated = 0;
  const createId = () => `generated-${++generated}`;
  const connections = testConnectionSelections(createId, (filePath) => filePath.includes('relay')
    ? testConnectionCredential({
        label: 'Relay', topology: 'relay', instanceId: 'relay-instance',
        endpoint: { hostname: 'relay.example.test', port: 22, username: 'agentdeck' },
      })
    : testConnectionCredential({
        label: 'Updated Core', instanceId: 'server-a',
        endpoint: { hostname: 'new-core.example.test', port: 2222, username: 'agentdeck' },
      }));
  const materials = new MemoryCredentialMaterialStore();
  const service = new RemoteHostService({
    registry,
    store: new RemoteHostProfileStore(backend, { create: createId }),
    connections,
    materials,
    createId,
  });
  return { backend, connections, first, local, materials, registry, remote, service };
}

export function observedRemoteHostServiceHarness(topology: 'relay' | 'full') {
  const local = standaloneProfile('local');
  const remote = remoteProfile(`${topology}-observed`, topology);
  const client = new ControlledClient(fullHello(remote));
  let observer: ((state: SshConnectionState) => void) | null = null;
  const registry = new ElectronHostRegistry({
    appVersion: 'desktop-test',
    createClient: () => ({
      client,
      observeTransport: (listener) => {
        observer = listener;
        return { close: vi.fn() };
      },
    }),
  });
  const backend = new MemoryBackend({
    schemaVersion: 4,
    sourceMode: 'remote',
    selectedRemoteProfileId: remote.id,
    profiles: [local, remote],
  });
  let generated = 0;
  const createId = () => `observed-${++generated}`;
  const service = new RemoteHostService({
    registry,
    store: new RemoteHostProfileStore(backend, { create: createId }),
    connections: testConnectionSelections(createId),
    materials: new MemoryCredentialMaterialStore(),
    createId,
  });
  return {
    client,
    emit(state: SshConnectionState): void {
      if (!observer) throw new Error('transport observer is not installed');
      observer(state);
    },
    registry,
    remote,
    service,
  };
}
