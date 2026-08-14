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
      schemaVersion: 4,
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

  it('loads only the current profile document without rewriting it', () => {
    const backend = new MemoryBackend({
      schemaVersion: 4,
      sourceMode: 'remote',
      selectedRemoteProfileId: 'server-a',
      profiles: [
      { id: 'local', label: '本机', topology: 'standalone', clientId: 'client-local' },
      {
        id: 'server-a',
        label: '生产 Core',
        topology: 'full',
        clientId: 'client-server-a',
        ssh: {
          id: 'server-a',
          label: '生产 Core',
          topology: 'full',
          hostname: 'core.example.test',
          port: 22,
          username: 'agentdeck',
          identityFile: '/private/key',
          knownHostsFile: '/private/known_hosts',
          expectedConnectionScope: 'scope-desktop-a',
        },
      },
      ],
    });
    expect(new RemoteHostProfileStore(backend, ids()).load()).toMatchObject({
      schemaVersion: 4,
      sourceMode: 'remote',
      selectedRemoteProfileId: 'server-a',
      profiles: [
        expect.anything(),
        { topology: 'full', ssh: { expectedConnectionScope: 'scope-desktop-a' } },
      ],
    });
    expect(backend.writes).toHaveLength(0);
  });

  it('fails closed for unknown schemas, duplicate ids, or a missing Standalone profile', () => {
    const invalid = [
      { schemaVersion: 99, selectedProfileId: 'x', profiles: [] },
      { schemaVersion: 1, activeProfileId: 'x', profiles: [] },
      { schemaVersion: 2, selectedProfileId: 'x', profiles: [] },
      { schemaVersion: 3, sourceMode: 'local', selectedRemoteProfileId: null, profiles: [] },
      {
        schemaVersion: 4,
        sourceMode: 'local',
        selectedRemoteProfileId: null,
        profiles: [
          { id: 'same', label: 'A', topology: 'standalone', clientId: 'a' },
          { id: 'same', label: 'B', topology: 'standalone', clientId: 'b' },
        ],
      },
      {
        schemaVersion: 4,
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
      {
        schemaVersion: 4,
        sourceMode: 'local',
        selectedRemoteProfileId: null,
        profiles: [
          { id: 'local', label: '本机', topology: 'standalone', clientId: 'client-local' },
          { id: 'old', label: '旧值', topology: 'server-core', clientId: 'client-old' },
        ],
      },
    ];

    for (const value of invalid) {
      const store = new RemoteHostProfileStore(new MemoryBackend(value), ids());
      expect(() => store.load()).toThrow();
    }
  });
});
