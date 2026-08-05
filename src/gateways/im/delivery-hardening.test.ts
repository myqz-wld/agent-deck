import { describe, expect, it, vi } from 'vitest';
import {
  FeishuCallbackAttempt,
  FeishuDeliveryService,
  FeishuGatewayError,
  FeishuNotificationLane,
  FeishuTransportNotAcceptedError,
  InMemoryFeishuGatewayStore,
  type FeishuDeliveryAttemptContext,
  type FeishuOutboundMessage,
  type FeishuTransportPort,
} from '.';
import { deliveryLedgerHooks, markPreTransport } from './delivery-ledger';
import { credential, flush } from './__tests__/fixture';

function input(eventId: string, updatedAt: number) {
  return {
    instanceId: credential.instanceId,
    eventId,
    credentialId: credential.credentialId,
    chatId: 'chat-1',
    updatedAt,
  };
}

function invokeSafe(
  store: InMemoryFeishuGatewayStore,
  eventId: string,
  expiresAt: number,
): void {
  store.claimDelivery(input(eventId, 0), 3, 10);
  expect(store.markDeliveryPreTransport(credential.instanceId, eventId, 1, 1)).toBe(true);
  expect(store.markDeliveryTransportInvoked(
    credential.instanceId,
    eventId,
    1,
    'safe',
    expiresAt,
    2,
  )).toBe(true);
}

describe('provider delivery horizon and retention', () => {
  it('reclaims a safe invocation only before its provider idempotency horizon', () => {
    const within = new InMemoryFeishuGatewayStore();
    invokeSafe(within, 'safe-within', 3_602);
    expect(within.claimDelivery(input('safe-within', 3_601), 3, 10)).toMatchObject({
      state: 'claimed',
      record: { attempts: 2, phase: 'core', transportIdempotencyExpiresAt: null },
    });

    const expired = new InMemoryFeishuGatewayStore();
    invokeSafe(expired, 'safe-expired', 3_602);
    expect(expired.markDeliveryTransportInvoked(
      credential.instanceId,
      'safe-expired',
      1,
      'safe',
      3_700,
      100,
    )).toBe(true);
    expect(expired.getDelivery(credential.instanceId, 'safe-expired'))
      .toMatchObject({ transportIdempotencyExpiresAt: 3_602 });
    expect(expired.claimDelivery(input('safe-expired', 3_602), 3, 10)).toMatchObject({
      state: 'exhausted',
      record: { attempts: 1, phase: 'transport-invoked', status: 'exhausted' },
    });
    expect(expired.markDeliveryPreTransport(
      credential.instanceId,
      'safe-expired',
      1,
      3_603,
    )).toBe(false);
    expect(expired.finishDelivery(
      credential.instanceId,
      'safe-expired',
      1,
      'sent',
      3_603,
    )).toBe(false);

    const failed = new InMemoryFeishuGatewayStore();
    invokeSafe(failed, 'safe-failed', 3_602);
    expect(failed.finishDelivery(
      credential.instanceId,
      'safe-failed',
      1,
      'failed',
      3,
    )).toBe(true);
    expect(failed.claimDelivery(input('safe-failed', 6 * 60 * 60 * 1_000), 3, 10))
      .toMatchObject({ state: 'exhausted', record: { attempts: 1 } });
  });

  it('prunes only old terminal metadata and retains unresolved evidence', () => {
    const store = new InMemoryFeishuGatewayStore();
    store.claimDelivery(input('pending-old', 0), 3, 1_000);

    store.claimDelivery(input('reconciling-old', 0), 3, 10);
    store.markDeliveryPreTransport(credential.instanceId, 'reconciling-old', 1, 1);
    store.markDeliveryTransportInvoked(
      credential.instanceId,
      'reconciling-old',
      1,
      'unknown',
      null,
      2,
    );
    store.claimDelivery(input('reconciling-old', 10), 3, 10);

    const sent = store.claimDelivery(input('sent-old', 0), 3, 10);
    store.finishDelivery(credential.instanceId, 'sent-old', sent.record.attempts, 'sent', 20);
    const fresh = store.claimDelivery(input('sent-fresh', 0), 3, 10);
    store.finishDelivery(credential.instanceId, 'sent-fresh', fresh.record.attempts, 'sent', 200);

    expect(store.pruneDeliveries(100)).toBe(1);
    expect(store.getDelivery(credential.instanceId, 'sent-old')).toBeNull();
    expect(store.getDelivery(credential.instanceId, 'sent-fresh')?.status).toBe('sent');
    expect(store.getDelivery(credential.instanceId, 'pending-old')?.status).toBe('pending');
    expect(store.getDelivery(credential.instanceId, 'reconciling-old')?.status).toBe(
      'reconciling',
    );
  });

  it('does not erase an earlier ambiguous invocation when a later retry was not accepted', async () => {
    class AmbiguousThenNotAccepted implements FeishuTransportPort {
      readonly deliverySemantics = 'event-id-idempotent' as const;
      readonly deliveryIdempotencyWindowMs = 3_600;
      calls = 0;

      async deliver(
        _message: FeishuOutboundMessage,
        _context: FeishuDeliveryAttemptContext,
      ): Promise<void> {
        this.calls += 1;
        if (this.calls === 1) throw new Error('provider acceptance was ambiguous');
        throw new FeishuTransportNotAcceptedError();
      }
    }

    const store = new InMemoryFeishuGatewayStore();
    const eventId = 'mixed-transport-outcomes';
    const claim = store.claimDelivery(input(eventId, 0), 3, 10);
    const clock = {
      now: () => 0,
      setTimer: () => ({ cancel: () => undefined }),
    };
    const callback = new FeishuCallbackAttempt(claim.record.attempts, 2_800, clock);
    markPreTransport(store, credential.instanceId, eventId, callback, () => 1);
    let invokedAt = 1;
    const transport = new AmbiguousThenNotAccepted();
    const service = new FeishuDeliveryService(transport, 2, 12_000);
    await expect(service.deliver({
      eventId,
      instanceId: credential.instanceId,
      credentialId: credential.credentialId,
      chatId: 'chat-1',
      kind: 'reply',
      text: '已接受。',
      cards: [],
    }, callback, deliveryLedgerHooks(
      store,
      credential.instanceId,
      eventId,
      callback,
      () => ++invokedAt,
      'safe',
      transport.deliveryIdempotencyWindowMs,
      async () => undefined,
    ))).rejects.toMatchObject({ code: 'delivery_failed' });
    expect(store.getDelivery(credential.instanceId, eventId)).toMatchObject({
      phase: 'transport-invoked',
      transportSafety: 'safe',
      transportIdempotencyExpiresAt: 3_602,
    });
  });
});

describe('notification replay churn', () => {
  it('fences an in-progress replay without scheduling an immediate reconnect', async () => {
    const onFailure = vi.fn();
    const consume = vi.fn(async () => {
      throw new FeishuGatewayError('event_in_progress', 'Delivery is still owned', true);
    });
    const lane = new FeishuNotificationLane('chat-1', 4, consume, undefined, onFailure);
    expect(lane.prepare(1)).toBe(true);
    expect(lane.activate(1)).toBe(true);
    expect(lane.push(1, {
      instanceId: credential.instanceId,
      revision: 11,
      kind: 'pending.created',
      entityId: 'pending-1',
    })).toBe(true);
    await flush();
    await flush();
    expect(consume).toHaveBeenCalledOnce();
    expect(onFailure).not.toHaveBeenCalled();
    expect(lane.push(1, {
      instanceId: credential.instanceId,
      revision: 12,
      kind: 'pending.created',
      entityId: 'pending-2',
    })).toBe(false);
    await lane.close();
  });
});
