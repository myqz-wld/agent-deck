import { classifyFeishuOperation, parseFeishuCommand } from './commands';
import { FeishuClientPool } from './client-pool';
import { FeishuCallbackAttempt } from './callback-attempt';
import { FeishuCommandExecutor } from './command-executor';
import { FeishuDeliveryService, transportIdempotencyWindow } from './delivery';
import { deliveryLedgerHooks, finishDeliveryOrFence, markPreTransport } from './delivery-ledger';
import {
  classifyGatewayError,
  FeishuGatewayError,
  FeishuGatewayLifecycleError,
} from './errors';
import { executePendingCardAction } from './pending-action';
import { deliverCoreNotification } from './notification-delivery';
import { truncateUtf8 } from './redaction';
import type {
  ConnectedFeishuClient,
  EnrolledFeishuCredential,
  FeishuCallbackResult,
  FeishuGatewayClock,
  FeishuGatewayLimits,
  FeishuGatewayBinding,
  FeishuGatewayOptions,
  FeishuGatewayStore,
  FeishuInboundEvent,
  FeishuMessageEvent,
  FeishuOutboundMessage,
  NotificationEvent,
  SessionConsoleView,
} from './types';
import {
  DEFAULT_FEISHU_CALLBACK_WINDOW_MS,
  DEFAULT_PENDING_PRESENTATION_LIFETIME_MS,
  MAX_FEISHU_CALLBACK_WINDOW_MS,
} from './types';
import { isActiveCredentialForEvent, parseFeishuInboundEvent } from './validation';
import {
  assertStoreBoundToGateway,
  credentialMatchesBinding,
  subjectMatchesBinding,
  validateGatewayBinding,
} from './gateway-binding';
import { FeishuGatewayLifecycle } from './gateway-lifecycle';
import { ValidatedFeishuGatewayStore } from './validated-store';
import { FeishuNotificationLanes } from './notification-lanes';
import { FeishuGatewayObservability } from './gateway-observability';
import {
  DEFAULT_GATEWAY_CLOCK,
  requireSafeDuration,
  resolveGatewayLimits,
} from './gateway-config';

export class FeishuSessionConsoleGateway {
  readonly callbackWindowMs: number;
  readonly pendingPresentationLifetimeMs: number;
  readonly limits: FeishuGatewayLimits;

  private readonly clock: FeishuGatewayClock;
  private readonly delivery: FeishuDeliveryService;
  private readonly pool: FeishuClientPool;
  private readonly commandExecutor: FeishuCommandExecutor;
  private readonly lifecycle: FeishuGatewayLifecycle;
  private readonly lanes: FeishuNotificationLanes;
  private readonly binding: FeishuGatewayBinding;
  private readonly store: FeishuGatewayStore;
  private readonly observability: FeishuGatewayObservability;
  private readonly transportWindow: number | null;
  private closePromise: Promise<void> | null = null;

  constructor(private readonly options: FeishuGatewayOptions) {
    this.callbackWindowMs = requireSafeDuration(
      options.callbackWindowMs ?? DEFAULT_FEISHU_CALLBACK_WINDOW_MS,
      'callbackWindowMs',
      MAX_FEISHU_CALLBACK_WINDOW_MS,
    );
    if (this.callbackWindowMs === 0) {
      throw new FeishuGatewayError('invalid_configuration', 'callbackWindowMs must be positive');
    }
    this.pendingPresentationLifetimeMs = requireSafeDuration(
      options.pendingPresentationLifetimeMs ?? DEFAULT_PENDING_PRESENTATION_LIFETIME_MS,
      'pendingPresentationLifetimeMs',
    );
    this.limits = resolveGatewayLimits(options.limits);
    this.clock = options.clock ?? DEFAULT_GATEWAY_CLOCK;
    this.observability = new FeishuGatewayObservability(
      options.audit,
      options.observer,
      () => this.clock.now(),
    );
    this.transportWindow = transportIdempotencyWindow(options.transport);
    this.delivery = new FeishuDeliveryService(
      options.transport,
      this.limits.maxTransportAttemptsPerCallback,
      this.limits.maxOutputBytes,
    );
    this.binding = validateGatewayBinding(options.binding);
    this.store = new ValidatedFeishuGatewayStore(options.store, this.binding, this.limits);
    assertStoreBoundToGateway(this.store, this.binding);
    this.lifecycle = new FeishuGatewayLifecycle(this.clock, this.callbackWindowMs);
    this.lanes = new FeishuNotificationLanes(
      this.limits.maxNotificationLanes,
      this.limits.maxQueuedNotificationsPerChat,
      () => this.lifecycle.isOpen(),
      (credential, chatId, epoch, event) =>
        this.deliverNotification(credential, chatId, epoch, event),
      this.options.observer,
      (credential, chatId, epoch) => {
        void this.pool.retireGeneration(credential, chatId, epoch).catch(() => {
          this.observability.error('lifecycle_failed', 'notification-resync-retire', true);
        });
      },
    );
    this.pool = new FeishuClientPool(
      options.appVersion,
      options.clientFactory,
      this.store,
      () => this.clock.now(),
      this.limits.maxConcurrentChatClients,
      (credential, chatId, epoch) => this.lanes.prepare(credential, chatId, epoch),
      (credential, chatId, epoch) => this.lanes.activate(credential, chatId, epoch),
      (credential, chatId, epoch) => this.lanes.start(credential, chatId, epoch),
      (credential, chatId, epoch, event) => this.lanes.push(credential, chatId, epoch, event),
      (code, operation) => this.observability.error(code, operation, true),
      (credential, chatId, epoch) => this.lanes.retire(credential, chatId, epoch),
    );
    this.commandExecutor = new FeishuCommandExecutor({
      store: this.store,
      nonce: options.nonce,
      limits: this.limits,
      pendingPresentationLifetimeMs: this.pendingPresentationLifetimeMs,
      now: () => this.clock.now(),
      beforeMutation: (credential, chatId) => this.assertActiveCredential(credential, chatId),
    });
  }

  start(): Promise<void> {
    return this.lifecycle.track(() => this.startOpen());
  }

  private async startOpen(): Promise<void> {
    assertStoreBoundToGateway(this.store, this.binding);
    this.store.pruneDeliveries(Math.max(0, this.clock.now() - this.limits.deliveryRetentionMs));
    this.store.pruneDeleteConfirmations(Math.max(0, this.clock.now() - 86_400_000), this.clock.now());
    const contexts = this.store.listContexts();
    const chatCount = new Set(
      contexts.map((context) => `${context.credentialId}\u001f${context.chatId}`),
    ).size;
    if (
      chatCount > this.limits.maxConcurrentChatClients ||
      chatCount > this.limits.maxNotificationLanes
    ) {
      throw new FeishuGatewayError(
        'invalid_configuration',
        'Persisted Feishu chats exceed the configured startup ceiling',
      );
    }
    const credentials = new Map(
      this.store
        .listActiveCredentials()
        .map((credential) => [
          `${credential.instanceId}\u001f${credential.credentialId}`,
          credential,
        ]),
    );
    const results = await Promise.allSettled(
      contexts.map(async (context) => {
        const credential = credentials.get(
          `${context.instanceId}\u001f${context.credentialId}`,
        );
        if (credential) await this.pool.get(credential, context.chatId);
      }),
    );
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason);
    if (failures.length > 0) {
      this.observability.error('lifecycle_failed', 'start', true);
      throw new FeishuGatewayLifecycleError(failures, 'start');
    }
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.lifecycle.beginClose();
    this.closePromise = this.closeOpen();
    return this.closePromise;
  }

  private async closeOpen(): Promise<void> {
    const poolResults = await Promise.allSettled([this.pool.close()]);
    const laneResults = await Promise.allSettled([this.lanes.close()]);
    const barrierResults = await Promise.allSettled([this.lifecycle.waitForBarrier()]);
    this.lifecycle.finishClose();
    const failures = [...poolResults, ...laneResults, ...barrierResults]
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason);
    if (failures.length > 0) throw new FeishuGatewayLifecycleError(failures, 'close');
  }

  handle(rawEvent: unknown): Promise<FeishuCallbackResult> {
    return this.lifecycle.track(() => this.handleOpen(rawEvent));
  }

  private async handleOpen(rawEvent: unknown): Promise<FeishuCallbackResult> {
    const event = parseFeishuInboundEvent(rawEvent, this.limits.maxEventBytes);
    const operation = classifyFeishuOperation(event);
    if (!subjectMatchesBinding(event, this.binding)) return this.ack(false, 'access_denied');
    const credential = this.store.resolveCredential(event);
    if (
      !credential ||
      !credentialMatchesBinding(credential, this.binding) ||
      !isActiveCredentialForEvent(credential, event)
    ) {
      this.observability.audit({
        at: this.clock.now(),
        eventId: event.eventId,
        instanceId: credential?.instanceId ?? null,
        credentialId: credential?.credentialId ?? null,
        chatId: event.chatId,
        operation,
        outcome: 'rejected',
        code: credential?.status === 'revoked' ? 'revoked' : 'access_denied',
        revision: null,
      });
      return this.ack(false, credential?.status === 'revoked' ? 'revoked' : 'access_denied');
    }
    const now = this.clock.now();
    const claim = this.store.claimDelivery(
      {
        instanceId: credential.instanceId,
        eventId: event.eventId,
        credentialId: credential.credentialId,
        chatId: event.chatId,
        updatedAt: now,
      },
      this.limits.maxEventAttempts,
      this.limits.deliveryAttemptLifetimeMs,
    );
    if (claim.state === 'duplicate') {
      return this.ack(true, 'deduplicated');
    }
    if (claim.state === 'in-progress') {
      throw new FeishuGatewayError(
        'event_in_progress',
        'Duplicate Feishu event is still being processed',
        true,
      );
    }
    if (claim.state === 'reconciliation-required') {
      if (!this.store.requireDeliveryReconciliation(
        credential.instanceId,
        event.eventId,
        claim.record.attempts,
        now,
      )) {
        throw new FeishuGatewayError(
          'delivery_generation_lost',
          'Delivery reconciliation generation was lost',
          true,
        );
      }
      return this.ack(false, 'reconciliation_required');
    }
    if (claim.state === 'exhausted') return this.ack(false, 'delivery_exhausted');
    this.store.getCursor(credential.instanceId, credential.credentialId, event.chatId);
    const context = this.ensureContext(
      credential, event.chatId, event.chatType, event.openId, now,
    );

    const callback = new FeishuCallbackAttempt(
      claim.record.attempts,
      this.callbackWindowMs,
      this.clock,
    );
    let view: SessionConsoleView;
    try {
      view = await this.withPlatformWindow(callback, async () => {
        const connected = await this.pool.get(credential, event.chatId);
        const result = event.kind === 'message'
          ? await this.executeMessage(event, credential, context, connected, callback)
          : await executePendingCardAction(
              event,
              credential,
              connected,
              callback,
              this.options.nonce,
              this.limits,
              () => this.assertActiveCredential(credential, event.chatId),
            );
        callback.remainingMs();
        markPreTransport(
          this.store,
          credential.instanceId,
          event.eventId,
          callback,
          () => this.clock.now(),
        );
        await this.delivery.deliver(
          this.outbound(event, credential, result),
          callback,
          deliveryLedgerHooks(
            this.store,
            credential.instanceId,
            event.eventId,
            callback,
            () => this.clock.now(),
            this.transportWindow === null ? 'unknown' : 'safe',
            this.transportWindow,
            () => this.assertActiveCredential(credential, event.chatId),
          ),
        );
        return result;
      });
    } catch (error) {
      const classified = classifyGatewayError(error);
      finishDeliveryOrFence(
        this.store,
        credential.instanceId,
        event.eventId,
        callback,
        classified.retryable
          ? callback.hasAmbiguousTransportOutcome() && this.transportWindow === null
            ? 'reconciling'
            : 'failed'
          : 'sent',
        this.clock.now(),
      );
      this.observability.result(
        event,
        credential,
        operation,
        classified.retryable ? 'retryable-failure' : 'rejected',
        classified.code,
        classified.currentRevision ?? null,
      );
      if (classified.retryable) {
        this.observability.error(classified.code, operation, true);
        throw new FeishuGatewayError(
          classified.code,
          classified.message,
          true,
          classified.currentRevision,
        );
      }
      return this.ack(false, classified.code);
    }
    finishDeliveryOrFence(
      this.store,
      credential.instanceId,
      event.eventId,
      callback,
      'sent',
      this.clock.now(),
    );
    this.observability.result(
      event, credential, operation, 'accepted', 'accepted', view.revision,
    );
    return this.ack(false, 'accepted');
  }

  private ensureContext(
    credential: EnrolledFeishuCredential,
    chatId: string,
    chatType: 'group' | 'p2p',
    openId: string,
    updatedAt: number,
  ) {
    const existing = this.store.getContext(
      credential.instanceId,
      credential.credentialId,
      chatId,
    );
    if (existing && existing.openId !== openId) {
      throw new FeishuGatewayError('access_denied', 'Chat is bound to another stable open-id');
    }
    if (existing) {
      if (existing.chatType !== chatType) {
        const updated = { ...existing, chatType, updatedAt };
        this.store.putContext(updated);
        return updated;
      }
      return existing;
    }
    const created = {
      instanceId: credential.instanceId,
      credentialId: credential.credentialId,
      chatId,
      chatType,
      openId,
      activeSessionId: null,
      updatedAt,
    };
    this.store.putContext(created);
    return created;
  }

  private async executeMessage(
    event: FeishuMessageEvent,
    credential: EnrolledFeishuCredential,
    context: ReturnType<FeishuSessionConsoleGateway['ensureContext']>,
    connected: ConnectedFeishuClient,
    callback: FeishuCallbackAttempt,
  ): Promise<SessionConsoleView> {
    const command = parseFeishuCommand(event.text, this.limits.maxTextBytes);
    return this.commandExecutor.execute(
      command,
      event,
      credential,
      context,
      connected,
      () => callback.remainingMs(),
    );
  }

  private async deliverNotification(
    credential: EnrolledFeishuCredential,
    chatId: string,
    epoch: number,
    event: NotificationEvent,
  ): Promise<void> {
    return deliverCoreNotification(
      {
        store: this.store,
        pool: this.pool,
        delivery: this.delivery,
        nonce: this.options.nonce,
        limits: this.limits,
        clock: this.clock,
        callbackWindowMs: this.callbackWindowMs,
        pendingPresentationLifetimeMs: this.pendingPresentationLifetimeMs,
        epoch,
        withinWindow: (callback, work) => this.withPlatformWindow(callback, work),
        beforeDeliver: (currentCredential, currentChatId) =>
          this.assertActiveCredential(currentCredential, currentChatId),
        transportSafety: this.transportWindow === null ? 'unknown' : 'safe',
        transportIdempotencyWindowMs: this.transportWindow,
        onTerminalExhausted: (current, currentChatId, eventId, currentEvent) =>
          this.observability.notificationExhausted(current, currentChatId, eventId, currentEvent),
      },
      credential,
      chatId,
      event,
    );
  }

  private async withPlatformWindow<T>(
    callback: FeishuCallbackAttempt,
    work: () => Promise<T>,
  ): Promise<T> {
    return this.lifecycle.withinWindow(callback, work);
  }

  private async assertActiveCredential(
    credential: EnrolledFeishuCredential,
    chatId: string,
  ): Promise<void> {
    const current = this.store.resolveCredential(credential);
    if (
      current &&
      credentialMatchesBinding(current, this.binding) &&
      current.status === 'active' &&
      current.credentialId === credential.credentialId
    ) {
      return;
    }
    const retirement = this.pool.retire(credential, chatId);
    void retirement.catch(() => {
      this.observability.error('lifecycle_failed', 'credential-revocation-retire', true);
    });
    throw new FeishuGatewayError('revoked', 'Feishu credential is no longer active');
  }

  private outbound(
    event: FeishuInboundEvent,
    credential: EnrolledFeishuCredential,
    view: SessionConsoleView,
  ): FeishuOutboundMessage {
    return {
      eventId: event.eventId,
      instanceId: credential.instanceId,
      credentialId: credential.credentialId,
      chatId: event.chatId,
      kind: event.kind === 'card-action' ? 'card-update' : 'reply',
      text: truncateUtf8(view.text, this.limits.maxOutputBytes),
      cards: (view.cards ?? []).slice(0, this.limits.maxPendingCards),
    };
  }

  private ack(duplicate: boolean, code: string): FeishuCallbackResult {
    return {
      acknowledged: true,
      duplicate,
      code,
      toast: duplicate ? '该事件已处理。' : code === 'accepted' ? '已接受。' : `请求未执行：${code}`,
    };
  }

}
