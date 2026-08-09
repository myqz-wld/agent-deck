import { FeishuGatewayError } from './errors';
import type { FeishuDeliveryAttemptContext, FeishuGatewayClock } from './types';

export class FeishuCallbackAttempt {
  readonly controller = new AbortController();
  readonly deadlineAt: number;
  private transportPending = false;
  private pendingWhenExpired = false;

  constructor(
    readonly attempt: number,
    windowMs: number,
    private readonly clock: FeishuGatewayClock,
  ) {
    this.deadlineAt = clock.now() + windowMs;
  }

  expire(): void {
    if (this.transportPending) this.pendingWhenExpired = true;
    this.controller.abort();
  }

  hasAmbiguousTransportOutcome(): boolean {
    return this.pendingWhenExpired;
  }

  markAmbiguousTransportOutcome(): void {
    this.pendingWhenExpired = true;
  }

  markDefinitelyNotAccepted(): void {
    this.pendingWhenExpired = false;
  }

  setTransportPending(pending: boolean): void {
    this.transportPending = pending;
  }

  remainingMs(): number {
    const remaining = this.deadlineAt - this.clock.now();
    if (remaining <= 0 && !this.controller.signal.aborted) this.expire();
    if (this.controller.signal.aborted) {
      throw new FeishuGatewayError(
        'platform_window_exceeded',
        'Feishu callback window elapsed',
        true,
      );
    }
    return remaining;
  }

  transportContext(transportTry: number): FeishuDeliveryAttemptContext {
    return {
      attempt: this.attempt,
      transportTry,
      deadlineAt: this.deadlineAt,
      signal: this.controller.signal,
      remainingMs: () => this.remainingMs(),
    };
  }
}
