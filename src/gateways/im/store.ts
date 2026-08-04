import { FeishuGatewayError } from './errors';
import type {
  DeliveryClaim,
  EnrolledFeishuCredential,
  FeishuChatContext,
  FeishuCursorRecord,
  FeishuDeliveryRecord,
  FeishuGatewayStore,
  FeishuStableSubject,
  FeishuSubscriptionRecord,
} from './types';

function subjectKey(subject: FeishuStableSubject): string {
  return `${subject.appId}\u001f${subject.tenantKey}\u001f${subject.openId}`;
}

function contextKey(instanceId: string, credentialId: string, chatId: string): string {
  return `${instanceId}\u001f${credentialId}\u001f${chatId}`;
}

function subscriptionKey(
  instanceId: string,
  credentialId: string,
  chatId: string,
  sessionId: string,
): string {
  return `${contextKey(instanceId, credentialId, chatId)}\u001f${sessionId}`;
}

function deliveryKey(instanceId: string, eventId: string): string {
  return `${instanceId}\u001f${eventId}`;
}

function safeDeadline(now: number, lifetimeMs: number): number {
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(lifetimeMs) || lifetimeMs <= 0) {
    throw new FeishuGatewayError('invalid_configuration', 'Delivery attempt lifetime is invalid');
  }
  return Math.min(Number.MAX_SAFE_INTEGER, now + lifetimeMs);
}

function copyCredential(value: EnrolledFeishuCredential): EnrolledFeishuCredential {
  return { ...value };
}

/** Deterministic test/local metadata implementation; it intentionally has no business-body field. */
export class InMemoryFeishuGatewayStore implements FeishuGatewayStore {
  private readonly credentials = new Map<string, EnrolledFeishuCredential>();
  private readonly contexts = new Map<string, FeishuChatContext>();
  private readonly subscriptions = new Map<string, FeishuSubscriptionRecord>();
  private readonly deliveries = new Map<string, FeishuDeliveryRecord>();
  private readonly cursors = new Map<string, FeishuCursorRecord>();

  enroll(credential: EnrolledFeishuCredential): void {
    const key = subjectKey(credential);
    const existing = this.credentials.get(key);
    if (
      existing &&
      (existing.instanceId !== credential.instanceId ||
        existing.credentialId !== credential.credentialId)
    ) {
      throw new FeishuGatewayError(
        'identity_conflict',
        'Stable Feishu identity is already enrolled to another credential',
      );
    }
    for (const [otherKey, other] of this.credentials) {
      if (
        otherKey !== key &&
        other.instanceId === credential.instanceId &&
        other.credentialId === credential.credentialId
      ) {
        throw new FeishuGatewayError(
          'identity_conflict',
          'Feishu credential id is already bound to another stable identity',
        );
      }
    }
    this.credentials.set(key, copyCredential(credential));
  }

  resolveCredential(subject: FeishuStableSubject): EnrolledFeishuCredential | null {
    const value = this.credentials.get(subjectKey(subject));
    return value ? copyCredential(value) : null;
  }

  listActiveCredentials(): readonly EnrolledFeishuCredential[] {
    return [...this.credentials.values()]
      .filter((credential) => credential.status === 'active')
      .map(copyCredential);
  }

  getContext(
    instanceId: string,
    credentialId: string,
    chatId: string,
  ): FeishuChatContext | null {
    const value = this.contexts.get(contextKey(instanceId, credentialId, chatId));
    return value ? { ...value } : null;
  }

  listContexts(): readonly FeishuChatContext[] {
    return [...this.contexts.values()].map((value) => ({ ...value }));
  }

  putContext(context: FeishuChatContext): void {
    this.contexts.set(
      contextKey(context.instanceId, context.credentialId, context.chatId),
      { ...context },
    );
  }

  getSubscription(
    instanceId: string,
    credentialId: string,
    chatId: string,
    sessionId: string,
  ): FeishuSubscriptionRecord | null {
    const value = this.subscriptions.get(
      subscriptionKey(instanceId, credentialId, chatId, sessionId),
    );
    return value ? { ...value } : null;
  }

  listSubscriptions(
    instanceId: string,
    credentialId: string,
    chatId: string,
  ): readonly FeishuSubscriptionRecord[] {
    return [...this.subscriptions.values()]
      .filter(
        (value) =>
          value.instanceId === instanceId &&
          value.credentialId === credentialId &&
          value.chatId === chatId,
      )
      .map((value) => ({ ...value }));
  }

  putSubscription(subscription: FeishuSubscriptionRecord): void {
    this.subscriptions.set(
      subscriptionKey(
        subscription.instanceId,
        subscription.credentialId,
        subscription.chatId,
        subscription.sessionId,
      ),
      { ...subscription },
    );
  }

  claimDelivery(
    input: Omit<
      FeishuDeliveryRecord,
      'attemptDeadlineAt' | 'attempts' | 'phase' | 'status' | 'transportSafety'
    >,
    maximumEventAttempts: number,
    attemptLifetimeMs = 30_000,
  ): DeliveryClaim {
    const key = deliveryKey(input.instanceId, input.eventId);
    const existing = this.deliveries.get(key);
    if (existing) {
      if (
        existing.credentialId !== input.credentialId ||
        existing.chatId !== input.chatId
      ) {
        throw new FeishuGatewayError(
          'event_identity_mismatch',
          'Feishu event id was replayed under a different stable identity',
        );
      }
      if (existing.status === 'pending' && input.updatedAt < existing.attemptDeadlineAt) {
        return { state: 'in-progress', record: { ...existing } };
      }
      if (existing.status === 'pending' && existing.phase === 'transport-invoked') {
        if (existing.transportSafety !== 'safe') {
          const reconciling = {
            ...existing,
            status: 'reconciling' as const,
            updatedAt: input.updatedAt,
          };
          this.deliveries.set(key, reconciling);
          return { state: 'reconciliation-required', record: { ...reconciling } };
        }
      }
      if (existing.status === 'reconciling') {
        return { state: 'reconciliation-required', record: { ...existing } };
      }
      if (existing.status === 'exhausted') {
        return { state: 'exhausted', record: { ...existing } };
      }
      if (existing.status === 'sent' || existing.status === 'deduplicated') {
        const deduplicated = { ...existing, status: 'deduplicated' as const };
        this.deliveries.set(key, deduplicated);
        return { state: 'duplicate', record: { ...deduplicated } };
      }
      if (
        !Number.isSafeInteger(existing.attempts) ||
        existing.attempts < 1 ||
        existing.attempts >= maximumEventAttempts
      ) {
        const exhausted = { ...existing, status: 'exhausted' as const, updatedAt: input.updatedAt };
        this.deliveries.set(key, exhausted);
        return { state: 'exhausted', record: { ...exhausted } };
      }
      const retried = {
        ...existing,
        status: 'pending' as const,
        attempts: existing.attempts + 1,
        phase: 'core' as const,
        transportSafety: null,
        attemptDeadlineAt: safeDeadline(input.updatedAt, attemptLifetimeMs),
        updatedAt: input.updatedAt,
      };
      this.deliveries.set(key, retried);
      return { state: 'claimed', record: { ...retried } };
    }
    const created: FeishuDeliveryRecord = {
      ...input,
      status: 'pending',
      attempts: 1,
      phase: 'core',
      transportSafety: null,
      attemptDeadlineAt: safeDeadline(input.updatedAt, attemptLifetimeMs),
    };
    this.deliveries.set(key, created);
    return { state: 'claimed', record: { ...created } };
  }

  markDeliveryPreTransport(
    instanceId: string,
    eventId: string,
    expectedAttempt: number,
    updatedAt: number,
  ): boolean {
    return this.updatePendingPhase(
      instanceId,
      eventId,
      expectedAttempt,
      ['core'],
      'pre-transport',
      null,
      updatedAt,
    );
  }

  markDeliveryTransportInvoked(
    instanceId: string,
    eventId: string,
    expectedAttempt: number,
    safety: 'safe' | 'unknown',
    updatedAt: number,
  ): boolean {
    return this.updatePendingPhase(
      instanceId,
      eventId,
      expectedAttempt,
      safety === 'safe' ? ['pre-transport', 'transport-invoked'] : ['pre-transport'],
      'transport-invoked',
      safety,
      updatedAt,
    );
  }

  markDeliveryNotAccepted(
    instanceId: string,
    eventId: string,
    expectedAttempt: number,
    updatedAt: number,
  ): boolean {
    const key = deliveryKey(instanceId, eventId);
    const existing = this.deliveries.get(key);
    if (
      !existing ||
      existing.attempts !== expectedAttempt ||
      existing.phase !== 'transport-invoked' ||
      existing.transportSafety === null ||
      (existing.status !== 'pending' && existing.transportSafety !== 'unknown') ||
      !['exhausted', 'pending', 'reconciling'].includes(existing.status)
    ) return false;
    this.deliveries.set(key, {
      ...existing,
      status: existing.status === 'pending' ? 'pending' : 'failed',
      phase: 'pre-transport',
      transportSafety: null,
      updatedAt,
    });
    return true;
  }

  private updatePendingPhase(
    instanceId: string,
    eventId: string,
    expectedAttempt: number,
    allowed: readonly FeishuDeliveryRecord['phase'][],
    phase: FeishuDeliveryRecord['phase'],
    transportSafety: FeishuDeliveryRecord['transportSafety'],
    updatedAt: number,
  ): boolean {
    const key = deliveryKey(instanceId, eventId);
    const existing = this.deliveries.get(key);
    if (
      !existing ||
      existing.status !== 'pending' ||
      existing.attempts !== expectedAttempt ||
      !allowed.includes(existing.phase)
    ) {
      return false;
    }
    this.deliveries.set(key, { ...existing, phase, transportSafety, updatedAt });
    return true;
  }

  finishDelivery(
    instanceId: string,
    eventId: string,
    expectedAttempt: number,
    status: Extract<FeishuDeliveryRecord['status'], 'failed' | 'reconciling' | 'sent'>,
    updatedAt: number,
  ): boolean {
    const key = deliveryKey(instanceId, eventId);
    const existing = this.deliveries.get(key);
    if (!existing) {
      throw new FeishuGatewayError('delivery_missing', 'Cannot finish an unclaimed delivery');
    }
    if (existing.attempts !== expectedAttempt || existing.status !== 'pending') return false;
    this.deliveries.set(key, { ...existing, status, updatedAt });
    return true;
  }

  getDelivery(instanceId: string, eventId: string): FeishuDeliveryRecord | null {
    const value = this.deliveries.get(deliveryKey(instanceId, eventId));
    return value ? { ...value } : null;
  }

  requireDeliveryReconciliation(
    instanceId: string,
    eventId: string,
    expectedAttempt: number,
    updatedAt: number,
  ): boolean {
    const key = deliveryKey(instanceId, eventId);
    const existing = this.deliveries.get(key);
    if (
      !existing ||
      existing.attempts !== expectedAttempt ||
      existing.status !== 'reconciling'
    ) {
      return false;
    }
    this.deliveries.set(key, { ...existing, status: 'exhausted', updatedAt });
    return true;
  }

  getCursor(
    instanceId: string,
    credentialId: string,
    chatId: string,
  ): FeishuCursorRecord | null {
    const value = this.cursors.get(contextKey(instanceId, credentialId, chatId));
    return value ? { ...value } : null;
  }

  putCursor(cursor: FeishuCursorRecord): void {
    const key = contextKey(cursor.instanceId, cursor.credentialId, cursor.chatId);
    const existing = this.cursors.get(key);
    if (existing && cursor.revision < existing.revision) {
      throw new FeishuGatewayError('cursor_regression', 'Feishu cursor cannot move backwards');
    }
    this.cursors.set(key, { ...cursor });
  }

  /** Useful for restart tests. The snapshot contains metadata only by construction. */
  exportMetadataSnapshot(): string {
    return JSON.stringify({
      version: 1,
      credentials: [...this.credentials.values()],
      contexts: [...this.contexts.values()],
      subscriptions: [...this.subscriptions.values()],
      deliveries: [...this.deliveries.values()],
      cursors: [...this.cursors.values()],
    });
  }
}
