import { assertFeishuMethod, feishuClientId, type FeishuClientPool } from './client-pool';
import { FeishuCallbackAttempt } from './callback-attempt';
import { validatePendingListResult } from './core-output';
import type { FeishuDeliveryService } from './delivery';
import { FeishuGatewayError } from './errors';
import {
  deliveryLedgerHooks,
  finishDeliveryOrFence,
  markPreTransport,
} from './delivery-ledger';
import { renderPending } from './render';
import { truncateUtf8 } from './redaction';
import { readFeishuAssistantMessage } from './notification-message';
import { labelFeishuPendingSources } from './source-presentation';
import type {
  EnrolledFeishuCredential,
  FeishuGatewayClock,
  FeishuGatewayLimits,
  FeishuGatewayStore,
  NotificationEvent,
  PendingActionNoncePort,
  SessionConsoleView,
} from './types';

export interface NotificationDeliveryOptions {
  store: FeishuGatewayStore;
  pool: FeishuClientPool;
  delivery: FeishuDeliveryService;
  nonce: PendingActionNoncePort;
  limits: FeishuGatewayLimits;
  clock: FeishuGatewayClock;
  callbackWindowMs: number;
  pendingPresentationLifetimeMs: number;
  epoch: number;
  withinWindow<T>(callback: FeishuCallbackAttempt, work: () => Promise<T>): Promise<T>;
  beforeDeliver(credential: EnrolledFeishuCredential, chatId: string): Promise<void>;
  transportSafety: 'safe' | 'unknown';
  transportIdempotencyWindowMs: number | null;
  onTerminalExhausted(
    credential: EnrolledFeishuCredential,
    chatId: string,
    eventId: string,
    event: NotificationEvent,
  ): void;
}

function advanceCursor(
  options: NotificationDeliveryOptions,
  credential: EnrolledFeishuCredential,
  chatId: string,
  revision: number,
): void {
  options.store.putCursor({
    instanceId: credential.instanceId,
    credentialId: credential.credentialId,
    chatId,
    revision,
    updatedAt: options.clock.now(),
  });
}

function relevant(event: NotificationEvent): boolean {
  return (
    event.persisted !== undefined ||
    event.kind.startsWith('pending.') ||
    ['session.completed', 'session.failed', 'session.waiting-for-input'].includes(event.kind)
  );
}

function consumeTerminalExhausted(
  options: NotificationDeliveryOptions,
  credential: EnrolledFeishuCredential,
  chatId: string,
  eventId: string,
  event: NotificationEvent,
): void {
  try {
    options.onTerminalExhausted(credential, chatId, eventId, event);
  } catch {
    // Observability must never poison the durable cursor or the next notification revision.
  }
  advanceCursor(options, credential, chatId, event.revision);
}

export async function deliverCoreNotification(
  options: NotificationDeliveryOptions,
  credential: EnrolledFeishuCredential,
  chatId: string,
  event: NotificationEvent,
): Promise<void> {
  const current = options.store.resolveCredential(credential);
  if (
    !current ||
    current.status !== 'active' ||
    current.credentialId !== credential.credentialId ||
    current.instanceId !== credential.instanceId
  ) {
    throw new FeishuGatewayError('revoked', 'Feishu credential is no longer active');
  }
  const cursor = options.store.getCursor(
    credential.instanceId,
    credential.credentialId,
    chatId,
  );
  const context = options.store.getContext(
    credential.instanceId,
    credential.credentialId,
    chatId,
  );
  if (!context) {
    throw new FeishuGatewayError('invalid_configuration', 'Notification chat context is missing');
  }
  if (cursor && event.revision <= cursor.revision) return;
  if (!relevant(event)) return advanceCursor(options, credential, chatId, event.revision);
  if (context.chatType === 'group' && event.persisted?.kind === 'message') {
    return advanceCursor(options, credential, chatId, event.revision);
  }

  const subscriptions = options.store
    .listSubscriptions(credential.instanceId, credential.credentialId, chatId)
    .filter(
      (subscription) =>
        subscription.status === 'active' &&
        // Core pending changes identify the owning session, just like persisted/provider events.
        (event.entityId === null || subscription.sessionId === event.entityId),
    );
  if (
    subscriptions.length > options.limits.maxSubscriptionsPerChat ||
    subscriptions.length > options.limits.maxNotificationCoreRequests
  ) {
    throw new FeishuGatewayError(
      'subscription_limit_exceeded',
      'Persisted notification subscriptions exceed the bounded Core request fanout',
    );
  }
  if (subscriptions.length === 0) {
    return advanceCursor(options, credential, chatId, event.revision);
  }

  const eventId = `notify-${event.revision}-${feishuClientId(credential, chatId)}`;
  const claim = options.store.claimDelivery(
    {
      instanceId: credential.instanceId,
      eventId,
      credentialId: credential.credentialId,
      chatId,
      updatedAt: options.clock.now(),
    },
    options.limits.maxEventAttempts,
    options.limits.deliveryAttemptLifetimeMs,
  );
  if (claim.state === 'duplicate') {
    return advanceCursor(options, credential, chatId, event.revision);
  }
  if (claim.state === 'in-progress') {
    throw new FeishuGatewayError(
      'event_in_progress',
      'Notification is already in progress',
      true,
    );
  }
  if (claim.state === 'reconciliation-required') {
    const reconciled = options.store.requireDeliveryReconciliation(
      credential.instanceId,
      eventId,
      claim.record.attempts,
      options.clock.now(),
    );
    if (!reconciled) {
      throw new FeishuGatewayError(
        'delivery_generation_lost',
        'Notification reconciliation generation was lost',
        true,
      );
    }
    return consumeTerminalExhausted(options, credential, chatId, eventId, event);
  }
  if (claim.state === 'exhausted') {
    return consumeTerminalExhausted(options, credential, chatId, eventId, event);
  }

  const callback = new FeishuCallbackAttempt(
    claim.record.attempts,
    options.callbackWindowMs,
    options.clock,
  );
  try {
    await options.withinWindow(callback, async () => {
      const connected = await options.pool.getForGeneration(credential, chatId, options.epoch);
      const assistantMessage = event.persisted?.kind === 'message'
        ? await readFeishuAssistantMessage(connected, event, options.limits, () => callback.remainingMs(),
            subscriptions.find(s => s.sessionId === event.entityId)?.purpose === 'assistant' ? '/chat history' : '/history')
        : undefined;
      if (assistantMessage === null) return;
      const cards = [] as NonNullable<SessionConsoleView['cards']>[number][];
      for (const subscription of assistantMessage === undefined ? subscriptions : []) {
        assertFeishuMethod(connected.hello, 'pending.list');
        const raw = await connected.client.request(
          'pending.list',
          { sessionId: subscription.sessionId },
          { deadlineMs: callback.remainingMs() },
        );
        const result = validatePendingListResult(raw, subscription.sessionId, options.limits);
        cards.push(
          ...(renderPending(
            result.requests.filter((item) => item.status === 'pending'),
            {
              credential,
              chatId,
              chatType: context.chatType,
              sessionId: subscription.sessionId,
              nonce: options.nonce,
              pendingPresentationLifetimeMs: options.pendingPresentationLifetimeMs,
              maxOutputBytes: options.limits.maxOutputBytes,
              maxPendingCards: options.limits.maxPendingCards,
              now: () => options.clock.now(),
            },
            result.revision,
          ).cards ?? []),
        );
      }
      if (assistantMessage === undefined && cards.length === 0 &&
        (event.kind.startsWith('pending.') || event.persisted?.kind === 'waiting-for-user')) return;
      markPreTransport(
        options.store,
        credential.instanceId,
        eventId,
        callback,
        () => options.clock.now(),
      );
      await options.delivery.deliver(
        {
          eventId,
          instanceId: credential.instanceId,
          credentialId: credential.credentialId,
          chatId,
          kind: 'notification',
          ...(event.entityId && subscriptions.find(s => s.sessionId === event.entityId)?.purpose === 'session'
            ? { presentation: { title: `工作会话 · ${event.entityId.slice(0, 8)}`, standalone: true } }
            : assistantMessage === undefined ? { presentation: { title: 'Agent Deck · 待确认事项', standalone: true } } : {}),
          text: truncateUtf8(
            assistantMessage ?? (event.kind.startsWith('pending.') || event.persisted?.kind === 'waiting-for-user'
              ? '有新的待确认事项。'
              : '状态已更新。'),
            options.limits.maxOutputBytes,
          ),
          cards: labelFeishuPendingSources(cards.slice(0, options.limits.maxPendingCards), subscriptions),
        },
        callback,
        deliveryLedgerHooks(
          options.store,
          credential.instanceId,
          eventId,
          callback,
          () => options.clock.now(),
          options.transportSafety,
          options.transportIdempotencyWindowMs,
          async () => {
            await options.beforeDeliver(credential, chatId);
            if (assistantMessage !== undefined && (
              options.store.getContext(credential.instanceId, credential.credentialId, chatId)?.chatType !== 'p2p' ||
              options.store.getSubscription(
                credential.instanceId, credential.credentialId, chatId, event.entityId!,
              )?.status !== 'active'
            )) throw new FeishuGatewayError('access_denied', 'Reply subscription is no longer active');
          },
        ),
      );
    });
  } catch (error) {
    finishDeliveryOrFence(
      options.store,
      credential.instanceId,
      eventId,
      callback,
      callback.hasAmbiguousTransportOutcome() && options.transportSafety === 'unknown'
        ? 'reconciling'
        : 'failed',
      options.clock.now(),
    );
    throw error;
  }
  finishDeliveryOrFence(
    options.store,
    credential.instanceId,
    eventId,
    callback,
    'sent',
    options.clock.now(),
  );
  advanceCursor(options, credential, chatId, event.revision);
}
