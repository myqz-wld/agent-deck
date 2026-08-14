import { describe, expect, it, vi } from 'vitest';

import {
  AgentDeckCapability,
  createPermissionPreviewDisplay,
  type AgentDeckCapability as Capability,
  type CoreMethodMap,
} from '@contracts/index';
import { sessionConsoleCreateOptionsFixture } from '@contracts/session-console-capabilities.fixture';
import { ElectronHostRegistry, type ElectronHostClientBinding } from '@hosts/electron';
import { ControlledClient, deferred, remoteHello, remoteProfile, standaloneProfile } from '@hosts/electron/__tests__/registry-fixture';
import type { SshConnectionState } from '@clients/ssh';

import type { RemoteHostProfileDocument } from './profile-document';
import { RemoteHostProfileStore, type RemoteHostProfileBackend } from './profile-store';
import { RemoteHostService } from './service';
import { remoteHostPendingPresentationDigest } from './pending-response-policy';
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

function fullHello(profile: ReturnType<typeof remoteProfile>) {
  return {
    ...remoteHello(profile),
    capabilities: Object.values(AgentDeckCapability) as Capability[],
  };
}

function expectedAuthority(profileId: string) {
  return { authoritativeCoreId: `core-${profileId}`, workerGeneration: null };
}

function harness(bindings?: ElectronHostClientBinding[]) {
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
  const connections = testConnectionSelections(createId, (path) => path.includes('relay')
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

function observedHarness(topology: 'relay' | 'full') {
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

describe('RemoteHostService', () => {
  it('redacts paths, client identity, access context, and raw transport errors', async () => {
    const { service } = harness();

    const snapshot = await service.getSnapshot();
    const serialized = JSON.stringify(snapshot);

    expect(snapshot.profiles[1]).toMatchObject({
      endpoint: { hostname: 'server-a.example.test' },
      credentials: { connectionCredentialConfigured: true },
    });
    expect(serialized).not.toContain('/private/');
    expect(serialized).not.toContain('client-server-a');
    expect(serialized).not.toContain('accessCredentialId');
    expect(serialized).not.toContain('desktop-key');
  });

  it('persists profile CRUD and keeps connect/disconnect limited to the local transport', async () => {
    const context = harness();
    await context.service.connect(context.remote.id);
    await context.service.disconnect(context.remote.id);
    expect(context.first.closeSpy).toHaveBeenCalledOnce();
    expect(context.first.request).not.toHaveBeenCalled();

    await context.service.setSourceMode('local');
    const connection = context.service.captureConnection('/private/new-relay.agentdeck-connection');
    const addedSnapshot = await context.service.addProfile({
      label: 'Relay',
      connectionSelectionId: connection.selectionId,
    });
    const added = addedSnapshot.profiles.find((profile) => profile.label === 'Relay');
    expect(added).toMatchObject({
      scope: 'remote',
      credentials: { connectionCredentialConfigured: true },
    });
    expect(JSON.stringify(added)).not.toContain('/private/');
    expect(context.backend.value.profiles.find((profile) => profile.id === added!.id)).toMatchObject({
      topology: 'relay',
      ssh: {
        expectedInstanceId: 'relay-instance',
        expectedConnectionScope: 'scope-desktop-a',
      },
    });

    await context.service.selectProfile(added!.id);
    const removedSnapshot = await context.service.removeProfile(added!.id);
    expect(removedSnapshot).toMatchObject({
      sourceMode: 'local',
      selectedRemoteProfileId: context.remote.id,
    });
    expect(removedSnapshot.profiles).not.toContainEqual(expect.objectContaining({ id: added!.id }));
    expect(context.backend.value.profiles).not.toContainEqual(expect.objectContaining({ id: added!.id }));
  });

  it('switches to Local without disconnecting and preserves the last remote profile', async () => {
    const context = harness();
    await context.service.connect(context.remote.id);

    const snapshot = await context.service.setSourceMode('local');

    expect(snapshot).toMatchObject({
      sourceMode: 'local',
      selectedRemoteProfileId: context.remote.id,
    });
    expect(context.first.closeSpy).not.toHaveBeenCalled();
    expect(context.registry.selectedProfileId).toBe(context.local.id);
    expect(context.backend.value).toMatchObject({
      sourceMode: 'local',
      selectedRemoteProfileId: context.remote.id,
    });
  });

  it('uses only cwd-free project/presentation methods for list and create', async () => {
    const { first, remote, service } = harness();
    vi.mocked(first.request).mockImplementation((async (method: keyof CoreMethodMap) => {
      switch (method) {
        case 'project.list':
          return { projects: [{ projectId: 'p1', projectRef: '.', alias: 'workspace', title: null }], nextCursor: null, total: 1, revision: 3 };
        case 'session.presentation.list':
          return {
            sessions: [{
              id: 's1', adapterId: 'codex-cli', title: 'Remote', source: 'sdk',
              lifecycle: 'active', activity: 'idle', archived: false, pinned: false,
              createdAt: 1, updatedAt: 2, endedAt: null, model: null, thinking: null,
              runtimeProvider: null, context: null, spawnedBy: null, spawnDepth: 0,
              teams: [], summary: null, summaryGenerationSource: null,
              workspaceLabel: 'Workspace', contextOnly: false,
            }],
            nextCursor: null,
            counts: { total: 1, active: 1, dormant: 0, closed: 0, working: 0, waiting: 0 },
            contextTruncated: false,
            revision: 4,
          };
        case 'session.console.create':
          return { sessionId: 's2', revision: 5 };
        default:
          throw new Error(`unexpected ${method}`);
      }
    }) as typeof first.request);
    await service.connect(remote.id);

    const projects = await service.listProjects({ profileId: remote.id, limit: 20 });
    const sessions = await service.listSessionPresentations({
      profileId: remote.id,
      kind: 'live',
      limit: 20,
    });
    const created = await service.createSession({
      profileId: remote.id,
      adapterId: 'codex-cli',
      attachments: [],
      capabilityRevision: `sha256:${'a'.repeat(64)}`,
      initialMessage: 'Inspect the repository',
      workingDirectory: projects.projects[0]!.projectRef,
      options: sessionConsoleCreateOptionsFixture('codex-cli'),
      expectedAuthority: expectedAuthority(remote.id),
      intentId: 'intent-create-1',
    });

    expect(sessions.sessions[0]?.id).toBe('s1');
    expect(created.sessionId).toBe('s2');
    const calls = vi.mocked(first.request).mock.calls;
    expect(calls.map((call) => call[0])).toEqual([
      'project.list',
      'session.presentation.list',
      'session.console.create',
    ]);
    expect(JSON.stringify(calls)).not.toContain('cwd');
    expect(calls[2]?.[1]).toMatchObject({
      initialMessage: 'Inspect the repository',
      workingDirectory: '.',
    });
    expect(calls.every((call) => call[2]?.deadlineMs === 45_000)).toBe(true);
    expect(calls[2]?.[2]).toMatchObject({ idempotencyKey: expect.stringMatching(/^electron-create-/) });
  });

  it('validates the bounded history, send, runtime, and pending business surface', async () => {
    const { first, remote, service } = harness();
    vi.mocked(first.request).mockImplementation((async (method: keyof CoreMethodMap) => {
      switch (method) {
        case 'session.console.get':
          return { session: { id: 's1', adapterId: 'codex-cli', title: null, status: 'active', createdAt: 1, updatedAt: 2 }, revision: 6 };
        case 'session.history':
          return { entries: [{ id: 'h1', sessionId: 's1', sequence: 1, role: 'user', content: 'hello', createdAt: 2 }], nextCursor: null, revision: 7 };
        case 'session.send':
          return { messageId: 'm1', sequence: 2, revision: 8 };
        case 'session.interrupt':
        case 'session.steer':
          return { accepted: true, revision: 8 };
        case 'pending.list':
          return {
            requests: [{
              id: 'r1', sessionId: 's1', kind: 'permission', status: 'pending',
              createdAt: 3, expiresAt: null,
              display: createPermissionPreviewDisplay('Bash', { command: 'pwd' }),
            }],
            revision: 9,
          };
        case 'pending.respond':
          return { status: 'resolved', revision: 10 };
        case 'session.runtime.get':
          return { adapterId: 'codex-cli', values: { model: 'gpt-5' }, revision: 11 };
        case 'session.runtime.update':
          return { controls: { adapterId: 'codex-cli', values: { model: 'gpt-5.1' }, revision: 12 }, effect: 'hot-applied', replacementSessionId: null };
        default:
          throw new Error(`unexpected ${method}`);
      }
    }) as typeof first.request);
    await service.connect(remote.id);
    const target = { profileId: remote.id, sessionId: 's1' };
    const mutationTarget = {
      ...target,
      expectedAuthority: expectedAuthority(remote.id),
      intentId: 'intent-business-1',
    };

    expect((await service.getSession(target))?.id).toBe('s1');
    expect((await service.listHistory({ ...target, limit: 20 })).entries).toHaveLength(1);
    expect((await service.send({ ...mutationTarget, text: 'hello' })).messageId).toBe('m1');
    expect((await service.interrupt(mutationTarget)).accepted).toBe(true);
    expect((await service.steer({ ...mutationTarget, text: 'adjust' })).accepted).toBe(true);
    const pending = await service.listPending(target);
    expect((await service.respondPending({
      ...mutationTarget,
      requestId: 'r1',
      action: 'approve',
      expectedRevision: pending.revision,
      expectedPresentationDigest: remoteHostPendingPresentationDigest(pending.requests[0]!),
    })).status).toBe('resolved');
    const runtime = await service.getRuntime(target);
    expect((await service.updateRuntime({ ...mutationTarget, patch: { model: 'gpt-5.1' }, expectedRevision: runtime.revision })).effect).toBe('hot-applied');

    const pendingCalls = vi.mocked(first.request).mock.calls.filter(
      (call) => call[0] === 'pending.respond',
    );
    expect(pendingCalls).toEqual([[
      'pending.respond',
      { sessionId: 's1', requestId: 'r1', action: 'approve' },
      {
        deadlineMs: 45_000,
        idempotencyKey: expect.stringMatching(/^electron-pending-/),
        expectedRevision: 9,
      },
    ]]);
  });

  it('waits for transport recovery instead of probing a Relay worker_offline binding', async () => {
    const context = observedHarness('relay');
    await context.service.connect(context.remote.id);
    const hello = fullHello(context.remote);
    context.emit({
      profileId: context.remote.id,
      topology: 'relay',
      status: 'offline',
      attempt: 1,
      hello,
      reason: 'worker offline',
      errorCode: 'worker_offline',
    });
    expect(context.registry.state(context.remote.id)).toMatchObject({
      status: 'offline',
      error: { code: 'worker_offline' },
    });
    await expect(context.service.listProjects({
      profileId: context.remote.id,
      limit: 20,
    })).rejects.toMatchObject({ code: 'not_connected' });
    expect(context.client.request).not.toHaveBeenCalled();

    context.emit({
      profileId: context.remote.id,
      topology: 'relay',
      status: 'connected',
      attempt: 1,
      hello,
      reason: null,
      errorCode: null,
    });
    expect(context.registry.state(context.remote.id)).toMatchObject({
      status: 'connected',
      error: null,
    });
    await context.service.shutdown();
  });

  it('does not probe an offline Server Core even if its error code is worker_offline', async () => {
    const context = observedHarness('full');
    await context.service.connect(context.remote.id);
    context.emit({
      profileId: context.remote.id,
      topology: 'full',
      status: 'offline',
      attempt: 1,
      hello: fullHello(context.remote),
      reason: 'offline',
      errorCode: 'worker_offline',
    });

    await expect(context.service.listProjects({
      profileId: context.remote.id,
      limit: 20,
    })).rejects.toMatchObject({ code: 'not_connected' });
    expect(context.client.request).not.toHaveBeenCalled();
    await context.service.shutdown();
  });

  it('drops a response after profile selection rescope instead of applying stale data', async () => {
    const { first, remote, service } = harness();
    const response = deferred<CoreMethodMap['session.history']['result']>();
    vi.mocked(first.request).mockReturnValueOnce(response.promise as never);
    await service.connect(remote.id);

    const history = service.listHistory({ profileId: remote.id, sessionId: 's1', limit: 20 });
    await service.setSourceMode('local');
    response.resolve({ entries: [], nextCursor: null, revision: 1 });

    await expect(history).rejects.toMatchObject({ code: 'stale_scope' });
  });

  it('does not invalidate the active profile when an unrelated profile is added', async () => {
    const { first, remote, service } = harness();
    const response = deferred<CoreMethodMap['session.history']['result']>();
    vi.mocked(first.request).mockReturnValueOnce(response.promise as never);
    await service.connect(remote.id);
    const history = service.listHistory({ profileId: remote.id, sessionId: 's1', limit: 20 });
    const connection = service.captureConnection('/private/unrelated-relay.agentdeck-connection');

    await service.addProfile({
      label: 'Unrelated Relay',
      connectionSelectionId: connection.selectionId,
    });
    response.resolve({ entries: [], nextCursor: null, revision: 3 });

    await expect(history).resolves.toMatchObject({ revision: 3 });
  });

  it('retires the old SSH binding and reconnects a replaced profile under a new scope', async () => {
    const remote = remoteProfile('server-a', 'full');
    const first = new ControlledClient(fullHello(remote));
    const second = new ControlledClient(fullHello(remote));
    const context = harness([{ client: first }, { client: second }]);
    await context.service.connect(context.remote.id);
    const oldResponse = deferred<CoreMethodMap['session.history']['result']>();
    vi.mocked(first.request).mockReturnValueOnce(oldResponse.promise as never);
    const staleHistory = context.service.listHistory({
      profileId: context.remote.id,
      sessionId: 'old-session',
      limit: 20,
    });
    const connection = context.service.captureConnection('/new/core.agentdeck-connection');

    await context.service.updateProfile(context.remote.id, {
      label: '更新后的 Core',
      connectionSelectionId: connection.selectionId,
    });

    expect(first.closeSpy).toHaveBeenCalledOnce();
    expect(second.connectHellos).toHaveLength(1);
    expect(JSON.stringify(await context.service.getSnapshot())).not.toContain('/new/');
    oldResponse.resolve({ entries: [], nextCursor: null, revision: 3 });
    await expect(staleHistory).rejects.toMatchObject({ code: 'stale_scope' });
  });

  it('surfaces host-key incompatibility without leaking offending known_hosts paths', async () => {
    const remote = remoteProfile('server-a', 'full');
    const client = new ControlledClient(fullHello(remote));
    let observe!: Parameters<NonNullable<ElectronHostClientBinding['observeTransport']>>[0];
    const binding: ElectronHostClientBinding = {
      client,
      observeTransport: (listener) => {
        observe = listener;
        return { close: vi.fn() };
      },
    };
    const context = harness([binding]);
    await context.service.connect(context.remote.id);

    observe({
      profileId: context.remote.id,
      topology: 'full',
      status: 'incompatible',
      attempt: 1,
      hello: fullHello(context.remote),
      reason: 'Offending key in /private/trust/known_hosts:7',
      errorCode: 'host_key_verification_failed',
    });
    const snapshot = await context.service.getSnapshot();
    const error = snapshot.states.find((state) => state.profileId === context.remote.id)?.error;

    expect(error).toEqual({
      code: 'host_key_verification_failed',
      message: '服务器身份校验失败，请重新获取或核对连接凭证。',
    });
    expect(JSON.stringify(snapshot)).not.toContain('/private/trust');
    await expect(context.service.listProjects({
      profileId: context.remote.id,
      limit: 20,
    })).rejects.toMatchObject({ code: 'not_connected' });
    expect(client.request).not.toHaveBeenCalled();
  });

  it('app shutdown retires only the local client transport', async () => {
    const { first, remote, service } = harness();
    await service.connect(remote.id);

    await service.shutdown();

    expect(first.closeSpy).toHaveBeenCalledOnce();
    expect(first.request).not.toHaveBeenCalled();
  });

  it('makes shutdown terminal and invalidates an in-flight business request', async () => {
    const { first, remote, service } = harness();
    await service.connect(remote.id);
    const response = deferred<CoreMethodMap['session.history']['result']>();
    vi.mocked(first.request).mockReturnValueOnce(response.promise as never);
    const history = service.listHistory({
      profileId: remote.id,
      sessionId: 's1',
      limit: 20,
    });

    const shutdown = service.shutdown();
    expect(service.shutdown()).toBe(shutdown);
    await shutdown;
    response.resolve({ entries: [], nextCursor: null, revision: 1 });

    await expect(history).rejects.toMatchObject({ code: 'service_stopped' });
    await expect(service.connect(remote.id)).rejects.toMatchObject({ code: 'service_stopped' });
    await expect(service.setSourceMode('local')).rejects.toMatchObject({ code: 'service_stopped' });
    await expect(service.removeProfile(remote.id)).rejects.toMatchObject({ code: 'service_stopped' });
    await expect(service.listProjects({ profileId: remote.id, limit: 20 })).rejects.toMatchObject({
      code: 'service_stopped',
    });
    expect(() => service.captureConnection('/new/key')).toThrowError(
      expect.objectContaining({ code: 'service_stopped' }),
    );
    await expect(service.getSnapshot()).resolves.toMatchObject({
      sourceMode: 'remote',
      selectedRemoteProfileId: remote.id,
      states: expect.arrayContaining([
        expect.objectContaining({ profileId: remote.id, status: 'offline' }),
      ]),
    });
    expect(first.connectHellos).toHaveLength(1);
    expect(first.closeSpy).toHaveBeenCalledOnce();
  });
});
