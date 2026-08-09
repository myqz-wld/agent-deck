import { describe, expect, it } from 'vitest';
import {
  InMemoryFeishuGatewayStore,
  type FeishuAgentDeckClientFactory,
} from '.';
import {
  FakeCoreClient,
  credential,
  messageEvent,
  session,
  setup,
} from './__tests__/fixture';

const deliveryInput = {
  instanceId: credential.instanceId,
  eventId: 'crash-event',
  credentialId: credential.credentialId,
  chatId: 'chat-1',
  updatedAt: 0,
};

describe('crash-recoverable delivery phases', () => {
  it('keeps active attempts in progress, then safely reclaims Core and pre-transport phases', () => {
    const coreStore = new InMemoryFeishuGatewayStore();
    coreStore.claimDelivery(deliveryInput, 3, 10);
    expect(coreStore.claimDelivery({ ...deliveryInput, updatedAt: 9 }, 3, 10).state).toBe(
      'in-progress',
    );
    const reclaimed = coreStore.claimDelivery({ ...deliveryInput, updatedAt: 10 }, 3, 10);
    expect(reclaimed).toMatchObject({ state: 'claimed', record: { attempts: 2, phase: 'core' } });

    const preStore = new InMemoryFeishuGatewayStore();
    const pre = preStore.claimDelivery(deliveryInput, 3, 10);
    expect(preStore.markDeliveryPreTransport(
      credential.instanceId,
      deliveryInput.eventId,
      pre.record.attempts,
      1,
    )).toBe(true);
    expect(preStore.claimDelivery({ ...deliveryInput, updatedAt: 10 }, 3, 10)).toMatchObject({
      state: 'claimed',
      record: { attempts: 2, phase: 'core' },
    });
  });

  it('reconciles unknown accepted transport, but safely retries idempotent or NotAccepted phases', () => {
    const unknown = new InMemoryFeishuGatewayStore();
    const first = unknown.claimDelivery(deliveryInput, 3, 10);
    expect(unknown.markDeliveryPreTransport(credential.instanceId, deliveryInput.eventId, 1, 1)).toBe(true);
    expect(unknown.markDeliveryTransportInvoked(
      credential.instanceId,
      deliveryInput.eventId,
      first.record.attempts,
      'unknown',
      null,
      2,
    )).toBe(true);
    const reconcile = unknown.claimDelivery({ ...deliveryInput, updatedAt: 10 }, 3, 10);
    expect(reconcile).toMatchObject({
      state: 'reconciliation-required',
      record: { attempts: 1, status: 'reconciling' },
    });
    expect(unknown.requireDeliveryReconciliation(
      credential.instanceId,
      deliveryInput.eventId,
      1,
      11,
    )).toBe(true);
    expect(unknown.getDelivery(credential.instanceId, deliveryInput.eventId)?.status).toBe(
      'exhausted',
    );

    for (const safety of ['safe', 'not-accepted'] as const) {
      const store = new InMemoryFeishuGatewayStore();
      store.claimDelivery(deliveryInput, 3, 10);
      store.markDeliveryPreTransport(credential.instanceId, deliveryInput.eventId, 1, 1);
      store.markDeliveryTransportInvoked(
        credential.instanceId,
        deliveryInput.eventId,
        1,
        safety === 'safe' ? 'safe' : 'unknown',
        safety === 'safe' ? 3_602 : null,
        2,
      );
      if (safety === 'not-accepted') {
        expect(store.markDeliveryNotAccepted(
          credential.instanceId,
          deliveryInput.eventId,
          1,
          3,
        )).toBe(true);
      }
      expect(store.claimDelivery({ ...deliveryInput, updatedAt: 10 }, 3, 10)).toMatchObject({
        state: 'claimed',
        record: { attempts: 2 },
      });
    }
  });

  it('fences a late attempt after the next crash-recovery generation was claimed', () => {
    const store = new InMemoryFeishuGatewayStore();
    store.claimDelivery(deliveryInput, 3, 10);
    const second = store.claimDelivery({ ...deliveryInput, updatedAt: 10 }, 3, 10);
    expect(second.record.attempts).toBe(2);
    expect(store.markDeliveryPreTransport(
      credential.instanceId,
      deliveryInput.eventId,
      1,
      11,
    )).toBe(false);
    expect(store.finishDelivery(
      credential.instanceId,
      deliveryInput.eventId,
      1,
      'sent',
      12,
    )).toBe(false);
    expect(store.getDelivery(credential.instanceId, deliveryInput.eventId)).toMatchObject({
      attempts: 2,
      phase: 'core',
      status: 'pending',
    });
  });
});

describe('complete HostHello validation and snapshotting', () => {
  it('uses an immutable detached hello after validating every advertised field', async () => {
    let client!: FakeCoreClient;
    const factory: FeishuAgentDeckClientFactory = (input) => {
      client = new FakeCoreClient(input);
      client.sessions.set('session-1', session('session-1'));
      return client;
    };
    const { gateway, transport } = setup({ clientFactory: factory });
    await gateway.handle(messageEvent('hello-snapshot-1', '/sessions'));
    transport.messages.length = 0;
    (client.hello.capabilities as string[]).length = 0;
    (client.hello.limits as { maxFrameBytes: number }).maxFrameBytes = 0;
    await expect(gateway.handle(messageEvent('hello-snapshot-2', '/sessions'))).resolves.toMatchObject({
      code: 'accepted',
    });
    expect(transport.messages).toHaveLength(1);
  });

  it.each([
    ['protocol', (client: FakeCoreClient) => {
      (client.hello.protocolVersion as { major: number }).major = 99;
    }],
    ['protocol extra field', (client: FakeCoreClient) => {
      Object.assign(client.hello.protocolVersion, { nested: { unsafe: true } });
    }],
    ['duplicate capability', (client: FakeCoreClient) => {
      const first = client.hello.capabilities[0];
      (client.hello.capabilities as string[]).push(first);
    }],
    ['transport limit', (client: FakeCoreClient) => {
      (client.hello.limits as { maxQueuedEvents: number }).maxQueuedEvents = 0;
    }],
    ['authoritative Core', (client: FakeCoreClient) => {
      (client.hello.authoritativeCore as { id: string }).id = 'bad\u0000core';
    }],
  ] as const)('rejects malformed %s metadata', async (_label, mutate) => {
    const { gateway } = setup({
      clientFactory: (input) => {
        const client = new FakeCoreClient(input);
        mutate(client);
        return client;
      },
    });
    const eventId = `bad-hello-${_label.replaceAll(' ', '-')}`;
    expect((await gateway.handle(messageEvent(eventId, '/sessions'))).code).toBe(
      'invalid_core_response',
    );
  });
});
