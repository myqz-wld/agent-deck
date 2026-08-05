import { describe, expect, it } from 'vitest';

import type { RemoteHostProfileDocument } from './profile-document';
import { RemoteHostProfileStore, type RemoteHostProfileBackend } from './profile-store';

class MemoryBackend implements RemoteHostProfileBackend {
  writes: RemoteHostProfileDocument[] = [];

  constructor(public value: unknown) {}

  read(): unknown {
    return structuredClone(this.value);
  }

  write(value: RemoteHostProfileDocument): void {
    this.value = structuredClone(value);
    this.writes.push(structuredClone(value));
  }
}

function ids(...values: string[]) {
  let index = 0;
  return { create: () => values[index++] as string };
}

describe('RemoteHostProfileStore', () => {
  it('creates and persists one stable Standalone profile without a server dependency', () => {
    const backend = new MemoryBackend(undefined);
    const store = new RemoteHostProfileStore(backend, ids('local-profile', 'local-client'));

    const document = store.load();

    expect(document).toEqual({
      schemaVersion: 3,
      sourceMode: 'local',
      selectedRemoteProfileId: null,
      profiles: [{
        id: 'standalone-local-profile',
        label: '本机',
        topology: 'standalone',
        clientId: 'electron-local-client',
      }],
    });
    expect(backend.writes).toHaveLength(1);
  });

  it('migrates the endpoint-based v1 document while keeping secrets main-only', () => {
    const backend = new MemoryBackend({
      schemaVersion: 1,
      activeProfileId: 'server-a',
      profiles: [
        { id: 'local', label: '本机', topology: 'standalone', clientId: 'client-local' },
        {
          id: 'server-a',
          label: '生产 Core',
          topology: 'server-core',
          clientId: 'client-server-a',
          endpoint: {
            hostname: 'core.example.test',
            port: 22,
            username: 'agentdeck',
            expectedInstanceId: 'server-instance',
          },
          identityFile: '/private/keys/agent-deck',
          knownHostsFile: '/private/trust/known_hosts',
        },
      ],
    });
    const store = new RemoteHostProfileStore(backend, ids());

    const document = store.load();

    expect(document.schemaVersion).toBe(3);
    expect(document.sourceMode).toBe('remote');
    expect(document.selectedRemoteProfileId).toBe('server-a');
    expect(document.profiles[1]).toMatchObject({
      ssh: {
        identityFile: '/private/keys/agent-deck',
        knownHostsFile: '/private/trust/known_hosts',
      },
    });
    expect(backend.writes).toHaveLength(1);
    expect(backend.writes[0]?.schemaVersion).toBe(3);
  });

  it('migrates v2 selection into independent source mode and last remote profile', () => {
    const profiles = [
      { id: 'local', label: '本机', topology: 'standalone', clientId: 'client-local' },
      {
        id: 'server-a',
        label: '生产 Core',
        topology: 'server-core',
        clientId: 'client-server-a',
        ssh: {
          id: 'server-a',
          label: '生产 Core',
          topology: 'server-core',
          hostname: 'core.example.test',
          port: 22,
          username: 'agentdeck',
          identityFile: '/private/key',
          knownHostsFile: '/private/known_hosts',
        },
      },
    ];
    const local = new RemoteHostProfileStore(new MemoryBackend({
      schemaVersion: 2,
      selectedProfileId: 'local',
      profiles,
    }), ids()).load();
    const remote = new RemoteHostProfileStore(new MemoryBackend({
      schemaVersion: 2,
      selectedProfileId: 'server-a',
      profiles,
    }), ids()).load();

    expect(local).toMatchObject({
      schemaVersion: 3,
      sourceMode: 'local',
      selectedRemoteProfileId: 'server-a',
    });
    expect(remote).toMatchObject({
      schemaVersion: 3,
      sourceMode: 'remote',
      selectedRemoteProfileId: 'server-a',
    });
  });

  it('fails closed for unknown schemas, duplicate ids, or a missing Standalone profile', () => {
    const invalid = [
      { schemaVersion: 99, selectedProfileId: 'x', profiles: [] },
      {
        schemaVersion: 3,
        sourceMode: 'local',
        selectedRemoteProfileId: null,
        profiles: [
          { id: 'same', label: 'A', topology: 'standalone', clientId: 'a' },
          { id: 'same', label: 'B', topology: 'standalone', clientId: 'b' },
        ],
      },
      {
        schemaVersion: 3,
        sourceMode: 'remote',
        selectedRemoteProfileId: 'remote',
        profiles: [{
          id: 'remote',
          label: '远程',
          topology: 'relay',
          clientId: 'client-remote',
          ssh: {
            hostname: 'relay.example.test',
            port: 22,
            username: 'agentdeck',
            identityFile: '/private/key',
            knownHostsFile: '/private/known_hosts',
          },
        }],
      },
    ];

    for (const value of invalid) {
      const store = new RemoteHostProfileStore(new MemoryBackend(value), ids());
      expect(() => store.load()).toThrow();
    }
  });
});
