import { vi } from 'vitest';

import type {
  RemoteHostProfileDto,
  RemoteHostSnapshotDto,
  RemoteHostStateDto,
} from '@shared/remote-host';
import type { RemoteHostSnapshotState } from './use-remote-host-snapshot';
import { emptyRemoteHostResourceRevisions } from './use-remote-host-snapshot';

const CAPABILITIES = [
  'projects.read',
  'session-console.read',
  'sessions.presentation.read',
  'sessions.history',
  'sessions.history.write',
  'events.replay',
  'sessions.write',
  'pending.read',
  'pending.index.read',
  'pending.respond',
  'sessions.runtime.read',
  'sessions.runtime.write',
];

export function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((settle, fail) => { resolve = settle; reject = fail; });
  return { promise, reject, resolve };
}

export function session(id: string, title: string) {
  return {
    id,
    adapterId: 'codex-cli',
    title,
    status: 'active-idle',
    createdAt: 1,
    updatedAt: 2,
  };
}

function profile(id: string): RemoteHostProfileDto {
  return {
    id,
    label: id,
    scope: 'remote',
    endpoint: {
      hostname: `${id}.example.test`,
      port: 22,
      username: 'agentdeck',
      hostKeyFingerprint: 'SHA256:test',
    },
  };
}

function state(id: string): RemoteHostStateDto {
  return {
    profileId: id,
    status: 'connected',
    recovery: null,
    authoritativeCoreId: `core-${id}`,
    workerGeneration: null,
    capabilities: CAPABILITIES,
    eventRevision: 1,
    error: null,
  };
}

export function hosts(profileId: string | null, dataRevision: number): RemoteHostSnapshotState {
  const remoteProfiles = [profile('remote-a'), profile('remote-b')];
  const snapshot: RemoteHostSnapshotDto = profileId
    ? {
        revision: dataRevision,
        sourceMode: 'remote',
        selectedRemoteProfileId: profileId,
        profiles: remoteProfiles,
        states: remoteProfiles.map((item) => state(item.id)),
      }
    : {
        revision: dataRevision,
        sourceMode: 'local',
        selectedRemoteProfileId: 'remote-a',
        profiles: remoteProfiles,
        states: remoteProfiles.map((item) => state(item.id)),
      };
  return {
    snapshot,
    dataRevisionByProfile: new Map(profileId ? [[profileId, dataRevision]] : []),
    resourceRevisionsByProfile: new Map(profileId
      ? [[profileId, Object.fromEntries(
          Object.keys(emptyRemoteHostResourceRevisions()).map((key) => [key, dataRevision]),
        ) as ReturnType<typeof emptyRemoteHostResourceRevisions>]]
      : []),
    mutations: {
      profileRegistry: false,
      sourceSelection: false,
      connectingProfileIds: new Set(),
      disconnectingProfileIds: new Set(),
    },
    busy: false,
    error: null,
    snapshotError: null,
    refresh: vi.fn(),
    addProfile: vi.fn(),
    updateProfile: vi.fn(),
    removeProfile: vi.fn(),
    selectProfile: vi.fn(),
    setSourceMode: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    clearError: vi.fn(),
  };
}
