import { describe, expect, it, vi } from 'vitest';

import {
  AgentDeckCapability,
  issueRemoteOwnerAccessContext,
  type AgentDeckClient,
  type AgentDeckEventEnvelope,
  type AgentDeckSubscription,
  type ClientHello,
  type CoreMethodMap,
  type HostHello,
} from '@contracts/index';
import { CURRENT_PROTOCOL_VERSION } from '@protocol/version';
import { SshAgentDeckClient } from '@clients/ssh';
import {
  FakeSpawnHarness,
  helloRequestId,
  makeHostHello,
} from '@clients/ssh/__tests__/fake-process';

import { bindSshHostClient, type ElectronHostClientBinding } from './client-binding';
import {
  DEFAULT_ELECTRON_HOST_LIFECYCLE_POLICY,
  ElectronHostLifecycleController,
} from './lifecycle-policy';
import type { ElectronHostProfile, RemoteElectronHostProfile } from './model';
import { ElectronHostRegistry } from './registry';

function standaloneProfile(id = 'local'): ElectronHostProfile {
  return { id, label: 'Standalone', topology: 'standalone', clientId: `client-${id}` };
}

function remoteProfile(
  id: string,
  topology: 'relay' | 'full',
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

function standaloneHello(clientId: string): HostHello {
  return {
    protocolVersion: { ...CURRENT_PROTOCOL_VERSION },
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
      surface: 'desktop',
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

function remoteHello(profile: RemoteElectronHostProfile): HostHello {
  const relay = profile.topology === 'relay';
  const instanceId = profile.ssh.expectedInstanceId as string;
  return {
    protocolVersion: { ...CURRENT_PROTOCOL_VERSION },
    appVersion: 'host-test',
    topology: profile.topology,
    instanceId,
    authoritativeCore: {
      id: relay ? `worker-${profile.id}` : `core-${profile.id}`,
      location: relay ? 'local-worker' : 'server-appliance',
      generation: relay ? 7 : null,
    },
    access: issueRemoteOwnerAccessContext({
      topology: profile.topology,
      instanceId,
      clientId: profile.clientId,
      connectionScope: `credential-${profile.id}`,
      surface: 'desktop',
    }),
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

class FakeClient implements AgentDeckClient<CoreMethodMap> {
  readonly closeSpy = vi.fn(async () => undefined);
  readonly connectHellos: ClientHello[] = [];
  private readonly eventListeners = new Set<(event: AgentDeckEventEnvelope) => void>();

  constructor(private readonly hello: HostHello) {}

  async connect(hello: ClientHello): Promise<HostHello> {
    this.connectHellos.push(hello);
    return this.hello;
  }

  request: AgentDeckClient<CoreMethodMap>['request'] = vi.fn() as unknown as AgentDeckClient<CoreMethodMap>['request'];

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

function fakeRegistry(profiles: readonly ElectronHostProfile[]) {
  const clients = new Map<string, FakeClient>();
  for (const profile of profiles) {
    clients.set(
      profile.id,
      new FakeClient(
        profile.topology === 'standalone' ? standaloneHello(profile.clientId) : remoteHello(profile),
      ),
    );
  }
  const registry = new ElectronHostRegistry({
    appVersion: 'desktop-test',
    createClient: (profile): ElectronHostClientBinding => ({
      client: clients.get(profile.id) as FakeClient,
    }),
  });
  for (const profile of profiles) registry.register(profile);
  return { registry, clients };
}

describe('ElectronHostRegistry', () => {
  it('models Standalone, Server Core, and Relay as explicit selectable profiles', () => {
    const profiles = [
      standaloneProfile(),
      remoteProfile('server', 'full'),
      remoteProfile('relay', 'relay'),
    ] as const;
    const { registry } = fakeRegistry(profiles);
    expect(registry.listProfiles().map(({ topology }) => topology)).toEqual([
      'standalone',
      'full',
      'relay',
    ]);
    expect(registry.listStates().map(({ status }) => status)).toEqual([
      'offline',
      'offline',
      'offline',
    ]);
  });

  it('owns independent client lifecycle, navigation, cursor, and host-qualified cache scopes', async () => {
    const server = remoteProfile('server', 'full');
    const relay = remoteProfile('relay', 'relay');
    const { registry, clients } = fakeRegistry([server, relay]);
    const states: string[] = [];
    registry.onState((state) => states.push(`${state.profileId}:${state.status}`));
    await Promise.all([registry.connect(server.id), registry.connect(relay.id)]);
    expect(states).toEqual(
      expect.arrayContaining([
        'server:connecting',
        'server:connected',
        'relay:connecting',
        'relay:connected',
      ]),
    );
    expect(registry.getClient(server.id)).not.toBe(registry.getClient(relay.id));

    registry.select(server.id);
    expect(registry.selectedProfileId).toBe(server.id);
    expect(registry.selectedClient()).toBe(registry.getClient(server.id));
    registry.select(relay.id);
    expect(registry.selectedClient()).toBe(registry.getClient(relay.id));

    registry.updateNavigation(server.id, { selectedSessionId: 'session-a', route: '/chat' });
    expect(registry.navigation(server.id)).toMatchObject({ selectedSessionId: 'session-a' });
    expect(registry.navigation(relay.id)).toMatchObject({ selectedSessionId: null, revision: 0 });
    expect(registry.cacheKey(server.id, 'session', 'same-id')).not.toBe(
      registry.cacheKey(relay.id, 'session', 'same-id'),
    );

    clients.get(server.id)?.emitEvent({
      instanceId: server.ssh.expectedInstanceId as string,
      revision: 1,
      kind: 'session.updated',
      entityId: 'same-id',
      payload: {},
    });
    expect(registry.state(server.id).eventRevision).toBe(1);
    expect(registry.state(relay.id).eventRevision).toBe(0);
    await registry.disconnect(server.id);
    expect(clients.get(server.id)?.closeSpy).toHaveBeenCalledOnce();
    expect(clients.get(relay.id)?.closeSpy).not.toHaveBeenCalled();
  });

  it('keeps window close separate from transport stop and never owns remote Core lifecycle', async () => {
    const server = remoteProfile('server', 'full');
    const relay = remoteProfile('relay', 'relay');
    const { registry, clients } = fakeRegistry([server, relay]);
    await Promise.all([registry.connect(server.id), registry.connect(relay.id)]);
    const lifecycle = new ElectronHostLifecycleController(registry);
    expect(lifecycle.policy).toEqual(DEFAULT_ELECTRON_HOST_LIFECYCLE_POLICY);

    await lifecycle.handleWindowClosed();
    expect(clients.get(server.id)?.closeSpy).not.toHaveBeenCalled();
    expect(clients.get(relay.id)?.closeSpy).not.toHaveBeenCalled();

    await lifecycle.handleAppShutdown();
    expect(clients.get(server.id)?.closeSpy).toHaveBeenCalledOnce();
    expect(clients.get(relay.id)?.closeSpy).toHaveBeenCalledOnce();
    expect(lifecycle.policy.remoteCoreLifecycle).toBe('never-owned-by-electron');
  });

  it('maps Relay worker_offline into the host state while the SSH child remains owned by main', async () => {
    const profile = remoteProfile('relay-live', 'relay');
    const harness = new FakeSpawnHarness();
    const sshClient = new SshAgentDeckClient(profile.ssh, {
      spawn: harness.spawn,
      reconnect: { maxAttempts: 0 },
      timing: { pingIntervalMs: 0, pongTimeoutMs: 0 },
    });
    const registry = new ElectronHostRegistry({
      appVersion: 'desktop-test',
      createClient: () => bindSshHostClient(sshClient),
    });
    registry.register(profile);
    const connected = registry.connect(profile.id);
    const process = harness.latest;
    process.emitMessage({
      type: 'hello-result',
      requestId: helloRequestId(process),
      hello: {
        ...makeHostHello(profile.clientId, 'relay'),
        instanceId: profile.ssh.expectedInstanceId,
        access: {
          ...makeHostHello(profile.clientId, 'relay').access,
          instanceId: profile.ssh.expectedInstanceId,
        },
      },
    } as never);
    await connected;

    const result = registry.getClient(profile.id)?.request('session.list', {}, {
      requestId: 'relay-list',
    });
    process.emitMessage({
      type: 'error',
      requestId: 'relay-list',
      error: {
        code: 'worker_offline',
        message: 'Worker is offline',
        retryable: true,
        currentRevision: null,
        details: null,
      },
    });
    await expect(result).rejects.toMatchObject({ code: 'worker_offline' });
    expect(registry.state(profile.id)).toMatchObject({
      status: 'offline',
      error: { code: 'worker_offline' },
    });
    expect(process.killedSignals).toEqual([]);
    await registry.stopAll();
  });
});
