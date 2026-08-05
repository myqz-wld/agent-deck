import { FeishuGatewayError } from './errors';
import { boundFeishuOutboundMessage } from './outbound-bounds';
import { FeishuTransportNotAcceptedError } from './types';
import type { FeishuCallbackAttempt } from './callback-attempt';
import type {
  FeishuGatewayObserver,
  FeishuOutboundMessage,
  FeishuTransportPort,
  NotificationEvent,
} from './types';

export function transportIdempotencyWindow(transport: FeishuTransportPort): number | null {
  const value = transport.deliveryIdempotencyWindowMs;
  return transport.deliverySemantics === 'event-id-idempotent' &&
    Number.isSafeInteger(value) && (value as number) > 0
    ? value as number
    : null;
}

export class FeishuDeliveryService {
  constructor(
    private readonly transport: FeishuTransportPort,
    private readonly maximumAttempts: number,
    private readonly maximumBytes: number,
  ) {}

  async deliver(
    message: FeishuOutboundMessage,
    callback: FeishuCallbackAttempt,
    hooks: {
      beforeDeliver(): Promise<void>;
      beforeTransport(): Promise<void>;
      onDefinitelyNotAccepted(): Promise<boolean>;
    },
  ): Promise<void> {
    const bounded = boundFeishuOutboundMessage(message, this.maximumBytes);
    for (let transportTry = 1; transportTry <= this.maximumAttempts; transportTry += 1) {
      callback.remainingMs();
      await hooks.beforeDeliver();
      callback.remainingMs();
      await hooks.beforeTransport();
      callback.remainingMs();
      callback.setTransportPending(true);
      try {
        await this.transport.deliver(bounded, callback.transportContext(transportTry));
        callback.remainingMs();
        return;
      } catch (error) {
        if (error instanceof FeishuTransportNotAcceptedError) {
          if (await hooks.onDefinitelyNotAccepted()) callback.markDefinitelyNotAccepted();
        }
        callback.remainingMs();
        const safeToRetry =
          transportIdempotencyWindow(this.transport) !== null ||
          error instanceof FeishuTransportNotAcceptedError;
        if (!safeToRetry) {
          callback.markAmbiguousTransportOutcome();
          throw new FeishuGatewayError(
            'delivery_ambiguous',
            'Feishu transport acceptance is ambiguous',
            true,
          );
        }
      } finally {
        callback.setTransportPending(false);
      }
    }
    throw new FeishuGatewayError(
      'delivery_failed',
      'Feishu transport did not accept the bounded delivery',
      true,
    );
  }
}

/** Queues only event identity/revision metadata; business payloads are always re-read from Core. */
export class FeishuNotificationLane {
  private readonly queued: Array<{ epoch: number; event: NotificationEvent }> = [];
  private running = false;
  private state: 'attaching' | 'closed' | 'open' | 'resync-required' = 'resync-required';
  private epoch: number | null = null;
  private readonly idleWaiters = new Set<() => void>();

  constructor(
    private readonly chatId: string,
    private readonly maximumQueued: number,
    private readonly consume: (epoch: number, event: NotificationEvent) => Promise<void>,
    private readonly observer: FeishuGatewayObserver | undefined,
    private readonly onStreamFailure: (epoch: number) => void,
  ) {}

  prepare(epoch: number): boolean {
    if (this.state === 'closed' || this.running || !Number.isSafeInteger(epoch) || epoch < 1) {
      return false;
    }
    this.queued.length = 0;
    this.epoch = epoch;
    this.state = 'attaching';
    return true;
  }

  activate(epoch: number): boolean {
    if (this.state !== 'attaching' || this.epoch !== epoch) return false;
    this.state = 'open';
    return true;
  }

  start(epoch: number): void {
    if (this.state === 'open' && this.epoch === epoch && !this.running && this.queued.length > 0) {
      void this.drain();
    }
  }

  push(epoch: number, event: NotificationEvent): boolean {
    if (!['attaching', 'open'].includes(this.state) || this.epoch !== epoch) {
      this.notifyError();
      return false;
    }
    if (this.queued.length >= this.maximumQueued) {
      this.fence(epoch);
      this.notifyDropped(event.revision);
      return false;
    }
    this.queued.push({ epoch, event: { ...event } });
    if (this.state === 'open' && !this.running) void this.drain();
    return true;
  }

  private async drain(): Promise<void> {
    this.running = true;
    try {
      while (this.queued.length > 0) {
        const item = this.queued.shift() as { epoch: number; event: NotificationEvent };
        if (this.state !== 'open' || item.epoch !== this.epoch) break;
        try {
          await this.consume(item.epoch, item.event);
        } catch (error) {
          this.fence(item.epoch);
          this.notifyError();
          if (!(error instanceof FeishuGatewayError && error.code === 'event_in_progress')) {
            this.onStreamFailure(item.epoch);
          }
          break;
        }
      }
    } finally {
      this.running = false;
      if (this.state === 'open' && this.queued.length > 0) void this.drain();
      if (!this.running) {
        for (const resolve of this.idleWaiters) resolve();
        this.idleWaiters.clear();
      }
    }
  }

  fence(epoch: number): void {
    if (this.state === 'closed' || this.epoch !== epoch) return;
    this.state = 'resync-required';
    this.queued.length = 0;
  }

  async retire(epoch: number): Promise<boolean> {
    this.fence(epoch);
    if (this.epoch !== epoch) return false;
    if (this.running) {
      await new Promise<void>((resolve) => this.idleWaiters.add(resolve));
    }
    return this.epoch === epoch;
  }

  async close(): Promise<void> {
    this.state = 'closed';
    this.queued.length = 0;
    if (!this.running) return;
    await new Promise<void>((resolve) => this.idleWaiters.add(resolve));
  }

  private notifyDropped(revision: number): void {
    try {
      this.observer?.onDeliveryDropped({
        chatId: this.chatId,
        revision,
        reason: 'queue-full',
      });
    } catch {
      // Observability is intentionally isolated from delivery and provider execution.
    }
  }

  private notifyError(): void {
    try {
      this.observer?.onError({
        code: 'notification_delivery_failed',
        operation: 'core-event',
        retryable: true,
      });
    } catch {
      // Observability is intentionally isolated from delivery and provider execution.
    }
  }
}
