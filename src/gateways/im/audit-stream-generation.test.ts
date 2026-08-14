import { describe, expect, it } from 'vitest';
import { isJsonObject, type JsonValue } from '@contracts/index';
import { SshAgentDeckClient } from '@clients/ssh';
import { FakeSpawnHarness } from '@clients/ssh/__tests__/fake-process';
import type { FeishuAgentDeckClientFactory } from '.';
import {
  FakeCoreClient,
  FakeTransport,
  credential,
  flush,
  messageEvent,
  pending,
  select,
  session,
  setup,
} from './__tests__/fixture';

describe('stream generation and replay barriers', () => {
  it('adopts a first-contact HostHello baseline with the real SSH cursor contract', async () => {
    const harnesses: FakeSpawnHarness[] = [];
    const helloCursors: Array<number | null> = [];
    const factory: FeishuAgentDeckClientFactory = (input) => {
      const harness = new FakeSpawnHarness();
      harnesses.push(harness);
      const client = new SshAgentDeckClient({
        id: `feishu-${harnesses.length}`,
        label: 'Feishu cursor contract',
        topology: input.topology,
        hostname: 'example.test',
        port: 22,
        username: 'agentdeck',
        identityFile: '/tmp/feishu-key',
        knownHostsFile: '/tmp/feishu-known-hosts',
        accessSurface: 'feishu',
        expectedInstanceId: input.instanceId,
        expectedConnectionScope: input.credentialId,
      }, {
        spawn: harness.spawn,
        reconnect: { maxAttempts: 0 },
        timing: { pingIntervalMs: 0, pongTimeoutMs: 0 },
      });
      queueMicrotask(() => {
        const process = harness.latest;
        const message = process.takeWrittenMessages().find(
          (candidate) => isJsonObject(candidate) && candidate.type === 'hello',
        );
        if (
          !isJsonObject(message) || !isJsonObject(message.hello) ||
          typeof message.requestId !== 'string'
        ) {
          throw new Error('Expected a real SSH hello frame');
        }
        helloCursors.push(
          typeof message.hello.lastEventRevision === 'number'
            ? message.hello.lastEventRevision
            : null,
        );
        process.emitMessage({
          type: 'hello-result',
          requestId: message.requestId,
          hello: new FakeCoreClient(input).hello,
        } as unknown as JsonValue);
      });
      return client;
    };
    const { gateway } = setup({ clientFactory: factory });
    const handling = gateway.handle(messageEvent('real-ssh-cursor', '/sessions'));
    for (let index = 0; index < 4; index += 1) await flush();
    const activeProcess = harnesses[1]?.latest;
    expect(activeProcess).toBeDefined();
    const messages = activeProcess!.takeWrittenMessages();
    const subscription = messages.find(
      (message) => isJsonObject(message) && message.type === 'subscribe',
    );
    const request = messages.find(
      (message) => isJsonObject(message) && message.type === 'request',
    );
    expect(helloCursors).toEqual([0, 10]);
    expect(subscription).toMatchObject({ afterRevision: 10 });
    expect(request).toMatchObject({ method: 'session.console.list' });
    if (!isJsonObject(request) || typeof request.requestId !== 'string') {
      throw new Error('Expected a real SSH business request');
    }
    activeProcess!.emitMessage({
      type: 'result',
      requestId: request.requestId,
      result: { sessions: [], nextCursor: null, total: 0, revision: 10 },
      revision: 10,
    });
    await expect(handling).resolves.toMatchObject({ code: 'accepted' });
    await gateway.close();
  });

  it('admits synchronous subscribe replay and seeds the initial hello cursor first', async () => {
    const created: FakeCoreClient[] = [];
    const factory: FeishuAgentDeckClientFactory = (input) => {
      const client = new FakeCoreClient(input);
      client.subscribeHook = (listener) => listener({
        instanceId: credential.instanceId,
        revision: 11,
        kind: 'session.completed',
        entityId: 'session-1',
        payload: {},
      });
      created.push(client);
      return client;
    };
    const { gateway, store } = setup({ clientFactory: factory });
    await gateway.handle(messageEvent('sync-replay', '/sessions'));
    await flush();
    await flush();
    expect(created).toHaveLength(2);
    expect(created[0]?.closed).toBe(true);
    expect(created[0]?.subscribeRevisions).toEqual([]);
    expect(created[1]?.subscribeRevisions).toEqual([10]);
    expect(store.getCursor(credential.instanceId, credential.credentialId, 'chat-1')?.revision).toBe(
      11,
    );
  });

  it('holds reconnect behind retirement and rejects stale callbacks from the old epoch', async () => {
    const created: FakeCoreClient[] = [];
    let releaseClose!: () => void;
    const closeHold = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const factory: FeishuAgentDeckClientFactory = (input) => {
      const client = new FakeCoreClient(input);
      client.sessions.set('session-1', session('session-1'));
      if (created.length === 1) client.closeHold = closeHold;
      if (created.length >= 2) {
        client.revision = 11;
        (client.hello as { eventRevision: number }).eventRevision = 11;
      }
      client.pending.set('session-1', [pending()]);
      created.push(client);
      return client;
    };
    const transport = new FakeTransport();
    const { gateway, store } = setup({
      clientFactory: factory,
      transport,
      limits: { maxQueuedNotificationsPerChat: 1 },
    });
    await select(gateway);
    await gateway.handle(messageEvent('generation-subscribe', '/subscribe'));
    transport.messages.length = 0;
    transport.holdChat = 'chat-1';
    const old = created[1];
    old.emit({
      instanceId: credential.instanceId,
      revision: 11,
      kind: 'pending.created',
      entityId: 'pending-1',
      payload: {},
    });
    await flush();
    for (const revision of [12, 13]) {
      old.emit({
        instanceId: credential.instanceId,
        revision,
        kind: 'pending.created',
        entityId: 'pending-1',
        payload: {},
      });
    }
    const reconnect = gateway.handle(messageEvent('generation-reconnect', '/pending'));
    await flush();
    await flush();
    expect(created).toHaveLength(2);
    expect(old.closed).toBe(true);

    transport.holdChat = null;
    transport.releaseHold?.();
    releaseClose();
    await reconnect;
    expect(created).toHaveLength(3);
    expect(old.closeCalls).toBe(1);
    expect(old.subscriptionCloseCalls).toBe(1);
    expect(created[2]?.subscribeRevisions).toEqual([11]);

    old.emitStale({
      instanceId: credential.instanceId,
      revision: 99,
      kind: 'pending.created',
      entityId: 'pending-1',
      payload: {},
    });
    await flush();
    expect(store.getCursor(credential.instanceId, credential.credentialId, 'chat-1')?.revision).toBe(
      11,
    );
    expect(transport.messages.some((message) => message.eventId.startsWith('notify-99-'))).toBe(
      false,
    );
  });

  it('fences a connect racing shutdown before it can attach a lane', async () => {
    let releaseConnect!: () => void;
    const connectHold = new Promise<void>((resolve) => {
      releaseConnect = resolve;
    });
    let client!: FakeCoreClient;
    const { gateway, transport } = setup({
      clientFactory: (input) => {
        client = new FakeCoreClient(input);
        client.connectHold = connectHold;
        return client;
      },
    });
    const handling = gateway.handle(messageEvent('connect-close-race', '/sessions')).catch(
      (error: unknown) => error,
    );
    await flush();
    let closed = false;
    const closing = gateway.close().finally(() => {
      closed = true;
    });
    await flush();
    expect(closed).toBe(false);
    releaseConnect();
    await expect(handling).resolves.toMatchObject({ code: 'gateway_closed' });
    await closing;
    expect(client.listeners.size).toBe(0);
    expect(client.closeCalls).toBe(1);
    expect(transport.messages).toHaveLength(0);
  });

  it('memoizes client and subscription cleanup across retire/close races', async () => {
    let releaseClose!: () => void;
    const closeHold = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    let client!: FakeCoreClient;
    const transport = new FakeTransport();
    const { gateway } = setup({
      transport,
      limits: { maxQueuedNotificationsPerChat: 1 },
      clientFactory: (input) => {
        const candidate = new FakeCoreClient(input);
        candidate.sessions.set('session-1', session('session-1'));
        candidate.pending.set('session-1', [pending()]);
        if (client) candidate.closeHold = closeHold;
        client = candidate;
        return candidate;
      },
    });
    await select(gateway);
    await gateway.handle(messageEvent('retire-close-subscribe', '/subscribe'));
    transport.holdChat = 'chat-1';
    client.emit({
      instanceId: credential.instanceId,
      revision: 11,
      kind: 'pending.created',
      entityId: 'pending-1',
      payload: {},
    });
    await flush();
    for (const revision of [12, 13]) {
      client.emit({
        instanceId: credential.instanceId,
        revision,
        kind: 'pending.created',
        entityId: 'pending-1',
        payload: {},
      });
    }
    const closing = gateway.close();
    transport.holdChat = null;
    transport.releaseHold?.();
    releaseClose();
    await closing;
    expect(client.closeCalls).toBe(1);
    expect(client.subscriptionCloseCalls).toBe(1);
  });
});
