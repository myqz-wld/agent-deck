import { vi } from 'vitest';

import {
  AgentDeckCapability,
  type AgentDeckClient,
  type AgentDeckEventEnvelope,
  type AgentDeckSubscription,
  type ClientHello,
  type CoreMethodMap,
  type HostHello,
} from '@contracts/index';

import type { ElectronHostProfile, RemoteElectronHostProfile } from '../model';

export function standaloneProfile(id = 'local'): ElectronHostProfile {
  return { id, label: 'Standalone', topology: 'standalone', clientId: `client-${id}` };
}

export function remoteProfile(
  id: string,
  topology: 'relay' | 'server-core',
): RemoteElectronHostProfile {
  const instanceId = topology === 'relay' ? `relay-${id}` : `server-${id}`;
  return {
    id,
    label: id,
    topology,
    clientId: `client-${id}`,
    ssh: {
      id,
      label: id,
      topology,
      hostname: `${id}.example.test`,
      port: 22,
      username: 'agentdeck',
      identityFile: `/tmp/${id}-key`,
      knownHostsFile: `/tmp/${id}-known-hosts`,
      expectedInstanceId: instanceId,
    },
  };
}

export function standaloneHello(clientId: string): HostHello {
  return {
    protocolVersion: { major: 1, minor: 0 },
    appVersion: 'host-test',
    topology: 'standalone',
    instanceId: 'local',
    authoritativeCore: { id: 'local-core', location: 'local-process', generation: null },
    access: {
      kind: 'standalone',
      topology: 'standalone',
      instanceId: 'local',
      clientId,
      transport: 'local-ipc',
      accessCredentialId: null,
      authority: 'local-owner',
      surface: 'desktop-full',
    },
    capabilities: [AgentDeckCapability.SessionsRead],
    limits: {
      maxFrameBytes: 1024,
      maxBlobBytes: 4096,
      maxConcurrentRequests: 8,
      maxQueuedEvents: 64,
    },
    eventRevision: 0,
  };
}

export function remoteHello(
  profile: RemoteElectronHostProfile,
  overrides: Partial<HostHello['authoritativeCore']> = {},
): HostHello {
  const relay = profile.topology === 'relay';
  const instanceId = profile.ssh.expectedInstanceId as string;
  return {
    protocolVersion: { major: 1, minor: 0 },
    appVersion: 'host-test',
    topology: profile.topology,
    instanceId,
    authoritativeCore: {
      id: relay ? `worker-${profile.id}` : `core-${profile.id}`,
      location: relay ? 'local-worker' : 'server-appliance',
      generation: relay ? 1 : null,
      ...overrides,
    },
    access: {
      kind: 'authenticated-client',
      topology: profile.topology,
      instanceId,
      clientId: profile.clientId,
      transport: 'ssh',
      accessCredentialId: `credential-${profile.id}`,
      authority: 'owner-equivalent',
      surface: 'desktop-full',
    },
    capabilities: [AgentDeckCapability.SessionsRead],
    limits: {
      maxFrameBytes: 1024,
      maxBlobBytes: 4096,
      maxConcurrentRequests: 8,
      maxQueuedEvents: 64,
    },
    eventRevision: 0,
  };
}

export class ControlledClient implements AgentDeckClient<CoreMethodMap> {
  readonly closeSpy = vi.fn<() => Promise<void>>(() => Promise.resolve());
  readonly connectHellos: ClientHello[] = [];
  private readonly eventListeners = new Set<(event: AgentDeckEventEnvelope) => void>();

  constructor(public hello: HostHello) {}

  async connect(hello: ClientHello): Promise<HostHello> {
    this.connectHellos.push(hello);
    return this.hello;
  }

  request: AgentDeckClient<CoreMethodMap>['request'] =
    vi.fn() as unknown as AgentDeckClient<CoreMethodMap>['request'];

  subscribe(
    _afterRevision: number,
    listener: (event: AgentDeckEventEnvelope) => void,
  ): AgentDeckSubscription {
    this.eventListeners.add(listener);
    return { close: () => this.eventListeners.delete(listener) };
  }

  close(): Promise<void> {
    return this.closeSpy();
  }

  emitEvent(event: AgentDeckEventEnvelope): void {
    for (const listener of this.eventListeners) listener(event);
  }
}

export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}
