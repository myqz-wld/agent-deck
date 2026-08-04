import type { FeishuCallbackAttempt } from './callback-attempt';
import { FeishuGatewayError } from './errors';
import type { FeishuGatewayStore } from './types';

function lost(callback: FeishuCallbackAttempt): never {
  callback.expire();
  throw new FeishuGatewayError(
    'delivery_generation_lost',
    'Delivery attempt generation is no longer authoritative',
    true,
  );
}

export function markPreTransport(
  store: FeishuGatewayStore,
  instanceId: string,
  eventId: string,
  callback: FeishuCallbackAttempt,
  now: () => number,
): void {
  if (!store.markDeliveryPreTransport(instanceId, eventId, callback.attempt, now())) {
    lost(callback);
  }
}

export function deliveryLedgerHooks(
  store: FeishuGatewayStore,
  instanceId: string,
  eventId: string,
  callback: FeishuCallbackAttempt,
  now: () => number,
  transportSafety: 'safe' | 'unknown',
  beforeDeliver: () => Promise<void>,
) {
  return {
    beforeDeliver,
    beforeTransport: async () => {
      if (!store.markDeliveryTransportInvoked(
        instanceId,
        eventId,
        callback.attempt,
        transportSafety,
        now(),
      )) lost(callback);
    },
    onDefinitelyNotAccepted: async () => {
      if (!store.markDeliveryNotAccepted(instanceId, eventId, callback.attempt, now())) {
        lost(callback);
      }
    },
  };
}

export function finishDeliveryOrFence(
  store: FeishuGatewayStore,
  instanceId: string,
  eventId: string,
  callback: FeishuCallbackAttempt,
  status: 'failed' | 'reconciling' | 'sent',
  now: number,
): void {
  if (!store.finishDelivery(instanceId, eventId, callback.attempt, status, now)) lost(callback);
}
