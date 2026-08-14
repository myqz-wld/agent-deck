import { describe, expect, it, vi } from 'vitest';

import type { SshConnectionState } from '@clients/ssh';
import { AgentDeckCapability, type AgentDeckCapability as Capability } from '@contracts/index';
import { sessionConsoleCreateOptionsFixture } from '@contracts/session-console-capabilities.fixture';
import { ElectronHostRegistry } from '@hosts/electron';
import {
  ControlledClient,
  deferred,
  remoteHello,
  remoteProfile,
  standaloneProfile,
} from '@hosts/electron/__tests__/registry-fixture';

import { MemoryCredentialMaterialStore, testConnectionSelections } from './test-connection-fixture';
import type { RemoteHostDesktopBrokerPort } from './desktop-browser-broker';
import type { RemoteHostProfileDocument } from './profile-document';
import { RemoteHostProfileStore, type RemoteHostProfileBackend } from './profile-store';
import { RemoteHostService } from './service';

class MemoryBackend implements RemoteHostProfileBackend {
  constructor(public value: RemoteHostProfileDocument) {}
  read(): unknown { return structuredClone(this.value); }
  write(value: RemoteHostProfileDocument): void { this.value = structuredClone(value); }
}

function harness(options: {
  desktopBroker?: RemoteHostDesktopBrokerPort;
  local?: boolean;
  twoRemotes?: boolean;
} = {}) {
  const local = standaloneProfile('local');
  const firstProfile = remoteProfile('remote-a', 'full');
  const secondProfile = remoteProfile('remote-b', 'full');
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
  const transportListeners = new Map<string, (state: SshConnectionState) => void>();
  const registry = new ElectronHostRegistry({
    appVersion: 'desktop-test',
    createClient: (profile) => ({
      client: clients.get(profile.id)!,
      observeTransport: (listener) => {
        transportListeners.set(profile.id, listener);
        return { close: () => transportListeners.delete(profile.id) };
      },
    }),
  });
  const profiles = options.twoRemotes ? [local, firstProfile, secondProfile] : [local, firstProfile];
  const backend = new MemoryBackend({
    schemaVersion: 4,
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
    desktopBroker: options.desktopBroker,
  });
  return {
    backend,
    clients,
    firstProfile,
    local,
    registry,
    secondProfile,
    service,
    emitTransport(profileId: string, state: SshConnectionState): void {
      const listener = transportListeners.get(profileId);
      if (!listener) throw new Error(`Missing transport listener for ${profileId}`);
      listener(state);
    },
  };
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
    const brokerGate = deferred<void>();
    const context = harness({
      desktopBroker: {
        handleState: () => undefined,
        handleEvent: () => undefined,
        stop: () => brokerGate.promise,
      },
    });
    const gate = deferred<ReturnType<typeof remoteHello>>();
    const client = context.clients.get(context.firstProfile.id)!;
    vi.spyOn(client, 'connect').mockImplementation(() => gate.promise);
    const connecting = context.service.connect(context.firstProfile.id);
    await Promise.resolve();

    const shutdown = context.service.shutdown();
    await vi.waitFor(() => expect(client.closeSpy).toHaveBeenCalledOnce());

    gate.resolve(remoteHello(context.firstProfile));
    brokerGate.resolve(undefined);
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

  it('preserves a terminal handoff result without selecting it after a source switch', async () => {
    const context = harness();
    await context.service.connect(context.firstProfile.id);
    const gate = deferred<unknown>();
    const client = context.clients.get(context.firstProfile.id)!;
    vi.mocked(client.request).mockReturnValue(gate.promise as never);
    const committing = context.service.handoff.commit({
      profileId: context.firstProfile.id,
      sessionId: 'source-session',
      continuationInstruction: 'Continue.',
      target: {
        adapterId: 'codex-cli', workingDirectory: null, capabilityRevision: null,
        options: sessionConsoleCreateOptionsFixture(),
      },
      expectedAuthority: {
        authoritativeCoreId: `core-${context.firstProfile.id}`,
        workerGeneration: null,
      },
      expectedBindingDigest: `sha256:${'a'.repeat(64)}`,
      intentId: 'terminal-intent',
    });
    await Promise.resolve();
    await context.service.setSourceMode('local');
    gate.resolve({
      successorSessionId: 'successor-session', cutoverEventRevision: 7,
      lateMessagesDelivered: 0, usedLowerBudgetRetry: false,
      sourceFinalizationWarning: null, revision: 8,
    });

    await expect(committing).resolves.toMatchObject({ successorSessionId: 'successor-session' });
    expect(context.registry.navigation(context.firstProfile.id).selectedSessionId).toBeNull();
  });

  it('does not admit new business work from retained capabilities while reconnecting', async () => {
    const context = harness();
    await context.service.connect(context.firstProfile.id);
    const client = context.clients.get(context.firstProfile.id)!;
    context.emitTransport(context.firstProfile.id, {
      profileId: context.firstProfile.id,
      topology: 'full',
      status: 'reconnecting',
      attempt: 1,
      hello: client.hello,
      reason: 'heartbeat timed out',
      errorCode: 'heartbeat_timeout',
    });

    await expect(context.service.listSessionPresentations({
      profileId: context.firstProfile.id,
      kind: 'live',
      limit: 20,
    })).rejects.toMatchObject({ code: 'not_connected' });
    await expect(context.service.issues.list({
      profileId: context.firstProfile.id,
      statuses: [],
      kinds: [],
      titleKeyword: null,
      includeDeleted: false,
      limit: 20,
      offset: 0,
    })).rejects.toMatchObject({ code: 'not_connected' });
    await expect(context.service.usage.tokens({
      profileId: context.firstProfile.id,
      includeDaily: false,
      dailyLimit: 1,
    })).rejects.toMatchObject({ code: 'not_connected' });
    expect(client.request).not.toHaveBeenCalled();
  });
});
