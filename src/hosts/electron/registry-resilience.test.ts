import { describe, expect, it, vi } from 'vitest';

import type { HostHello, JsonValue } from '@contracts/index';
import { SshAgentDeckClient } from '@clients/ssh';
import {
  FakeSpawnHarness,
  helloRequestId,
  makeHostHello,
} from '@clients/ssh/__tests__/fake-process';

import { bindSshHostClient, type ElectronHostClientBinding } from './client-binding';
import { ElectronHostRegistry } from './registry';
import type { RemoteElectronHostProfile } from './model';
import {
  ControlledClient,
  deferred,
  remoteHello,
  remoteProfile,
  standaloneHello,
  standaloneProfile,
} from './__tests__/registry-fixture';

function relayWireHello(
  profile: RemoteElectronHostProfile,
  coreId: string,
  generation: number,
): HostHello {
  const base = makeHostHello(profile.clientId, 'relay');
  if (base.access.kind !== 'authenticated-client') throw new Error('Expected SSH access context');
  return {
    ...base,
    instanceId: profile.ssh.expectedInstanceId as string,
    authoritativeCore: { ...base.authoritativeCore, id: coreId, generation },
    access: {
      ...base.access,
      instanceId: profile.ssh.expectedInstanceId as string,
    },
  };
}

function emitHello(
  harness: FakeSpawnHarness,
  hello: HostHello,
): void {
  const process = harness.latest;
  process.emitMessage({
    type: 'hello-result',
    requestId: helloRequestId(process),
    hello,
  } as unknown as JsonValue);
}

describe('ElectronHostRegistry resilience boundaries', () => {
  it('validates HostHello locally and isolates state/selection/event observers', async () => {
    const invalidProfile = standaloneProfile('invalid');
    const invalidRemote = remoteProfile('different', 'server-core');
    const invalidClient = new ControlledClient(remoteHello(invalidRemote));
    const invalidRegistry = new ElectronHostRegistry({
      appVersion: 'desktop-test',
      createClient: () => ({ client: invalidClient }),
    });
    invalidRegistry.register(invalidProfile);
    await expect(invalidRegistry.connect(invalidProfile.id)).rejects.toMatchObject({
      code: 'incompatible_handshake',
    });
    expect(invalidRegistry.state(invalidProfile.id).status).toBe('incompatible');

    const profile = standaloneProfile('observer-safe');
    const client = new ControlledClient(standaloneHello(profile.clientId));
    const registry = new ElectronHostRegistry({
      appVersion: 'desktop-test',
      createClient: () => ({ client }),
    });
    registry.register(profile);
    registry.onState(() => {
      throw new Error('state observer');
    });
    registry.onSelection(() => {
      throw new Error('selection observer');
    });
    registry.onEvent(() => {
      throw new Error('event observer');
    });
    const selections: Array<string | null> = [];
    const events: number[] = [];
    registry.onSelection((profileId) => selections.push(profileId));
    registry.onEvent((event) => events.push(event.revision));

    await registry.connect(profile.id);
    registry.select(profile.id);
    client.emitEvent({
      instanceId: 'local',
      revision: 1,
      kind: 'session.updated',
      entityId: null,
      payload: {},
    });
    expect(selections).toEqual([profile.id]);
    expect(events).toEqual([1]);
    expect(registry.state(profile.id)).toMatchObject({ status: 'connected', eventRevision: 1 });
    const leaked = registry.state(profile.id);
    (leaked.capabilities as string[]).push('mutated');
    expect(registry.state(profile.id).capabilities).toEqual(['sessions.read']);
    await registry.stopAll();
  });

  it('rescopes Relay cache identity on reconnect takeover without changing another profile', async () => {
    vi.useFakeTimers();
    try {
      const firstProfile = remoteProfile('relay-first', 'relay');
      const otherProfile = remoteProfile('relay-other', 'relay');
      const firstHarness = new FakeSpawnHarness();
      const otherHarness = new FakeSpawnHarness();
      const clients = new Map([
        [
          firstProfile.id,
          new SshAgentDeckClient(firstProfile.ssh, {
            spawn: firstHarness.spawn,
            reconnect: { initialDelayMs: 10, maxDelayMs: 10, multiplier: 1, maxAttempts: 1 },
            timing: { pingIntervalMs: 0, pongTimeoutMs: 0 },
          }),
        ],
        [
          otherProfile.id,
          new SshAgentDeckClient(otherProfile.ssh, {
            spawn: otherHarness.spawn,
            reconnect: { maxAttempts: 0 },
            timing: { pingIntervalMs: 0, pongTimeoutMs: 0 },
          }),
        ],
      ]);
      const registry = new ElectronHostRegistry({
        appVersion: 'desktop-test',
        createClient: (profile): ElectronHostClientBinding =>
          bindSshHostClient(clients.get(profile.id) as SshAgentDeckClient),
      });
      registry.register(firstProfile);
      registry.register(otherProfile);
      const firstConnected = registry.connect(firstProfile.id);
      emitHello(firstHarness, relayWireHello(firstProfile, 'worker-stable', 1));
      const otherConnected = registry.connect(otherProfile.id);
      emitHello(otherHarness, relayWireHello(otherProfile, 'worker-other', 4));
      await Promise.all([firstConnected, otherConnected]);
      const firstKey = registry.cacheKey(firstProfile.id, 'session', 'same');
      const otherKey = registry.cacheKey(otherProfile.id, 'session', 'same');
      const otherState = registry.state(otherProfile.id);

      firstHarness.latest.exit(255);
      await vi.advanceTimersByTimeAsync(10);
      emitHello(firstHarness, relayWireHello(firstProfile, 'worker-stable', 2));
      expect(registry.state(firstProfile.id)).toMatchObject({
        status: 'connected',
        instanceId: firstProfile.ssh.expectedInstanceId,
        authoritativeCoreId: 'worker-stable',
        workerGeneration: 2,
      });
      expect(registry.cacheKey(firstProfile.id, 'session', 'same')).not.toBe(firstKey);
      expect(registry.cacheKey(otherProfile.id, 'session', 'same')).toBe(otherKey);
      expect(registry.state(otherProfile.id)).toEqual(otherState);
      await registry.stopAll();
    } finally {
      vi.useRealTimers();
    }
  });

  it('fences slow disconnect completion from a newer connect epoch', async () => {
    const profile = standaloneProfile('disconnect-race');
    const first = new ControlledClient(standaloneHello(profile.clientId));
    const second = new ControlledClient(standaloneHello(profile.clientId));
    const closeGate = deferred<void>();
    first.closeSpy.mockImplementation(() => closeGate.promise);
    const clients = [first, second];
    const registry = new ElectronHostRegistry({
      appVersion: 'desktop-test',
      createClient: () => ({ client: clients.shift() as ControlledClient }),
    });
    registry.register(profile);
    await registry.connect(profile.id);
    const disconnecting = registry.disconnect(profile.id);
    const reconnecting = registry.connect(profile.id);
    await Promise.resolve();
    expect(registry.getClient(profile.id)).toBeNull();
    expect(clients).toEqual([second]);
    closeGate.resolve(undefined);
    await disconnecting;
    await reconnecting;
    expect(registry.getClient(profile.id)).toBe(second);
    expect(registry.state(profile.id).status).toBe('connected');
    await registry.stopAll();
  });

  it('cleans every entry and aggregates close failures', async () => {
    const firstProfile = standaloneProfile('close-failure-a');
    const secondProfile = standaloneProfile('close-failure-b');
    const first = new ControlledClient(standaloneHello(firstProfile.clientId));
    const second = new ControlledClient(standaloneHello(secondProfile.clientId));
    first.closeSpy.mockRejectedValue(new Error('first close failed'));
    second.closeSpy.mockRejectedValue(new Error('second close failed'));
    const clients = new Map([
      [firstProfile.id, first],
      [secondProfile.id, second],
    ]);
    const createClient = vi.fn((profile: { id: string }) => ({
      client: clients.get(profile.id) as ControlledClient,
    }));
    const registry = new ElectronHostRegistry({
      appVersion: 'desktop-test',
      createClient,
    });
    registry.register(firstProfile);
    registry.register(secondProfile);
    await Promise.all([registry.connect(firstProfile.id), registry.connect(secondProfile.id)]);
    await expect(registry.stopAll()).rejects.toBeInstanceOf(AggregateError);
    expect(first.closeSpy).toHaveBeenCalledOnce();
    expect(second.closeSpy).toHaveBeenCalledOnce();
    await expect(registry.connect(firstProfile.id)).rejects.toThrow('registry is stopping');
    expect(createClient).toHaveBeenCalledTimes(2);
    expect(registry.state(firstProfile.id)).toMatchObject({
      status: 'offline',
      error: { code: 'transport-close-failed' },
    });
    expect(registry.state(secondProfile.id).status).toBe('offline');
  });

  it('does not relabel a live Relay worker_offline channel until Worker success', async () => {
    const profile = remoteProfile('relay-live-reaffirm', 'relay');
    const harness = new FakeSpawnHarness();
    const client = new SshAgentDeckClient(profile.ssh, {
      spawn: harness.spawn,
      reconnect: { maxAttempts: 0 },
      timing: { pingIntervalMs: 0, pongTimeoutMs: 0 },
    });
    const registry = new ElectronHostRegistry({
      appVersion: 'desktop-test',
      createClient: () => bindSshHostClient(client),
    });
    registry.register(profile);
    const connected = registry.connect(profile.id);
    emitHello(harness, relayWireHello(profile, 'worker-live', 1));
    await connected;
    const process = harness.latest;
    const offline = client.request('session.list', {}, { requestId: 'offline' });
    process.emitMessage({
      type: 'error',
      requestId: 'offline',
      error: {
        code: 'worker_offline',
        message: 'worker offline',
        retryable: true,
        currentRevision: null,
        details: null,
      },
    });
    await expect(offline).rejects.toMatchObject({ code: 'worker_offline' });
    expect(registry.state(profile.id).status).toBe('offline');
    await registry.connect(profile.id);
    expect(registry.state(profile.id).status).toBe('offline');

    const recovered = client.request('system.health', {}, { requestId: 'recovered' });
    process.emitMessage({
      type: 'result',
      requestId: 'recovered',
      result: { ok: true, revision: 1 },
      revision: 1,
    });
    await recovered;
    expect(registry.state(profile.id).status).toBe('connected');
    await registry.stopAll();
  });
});
