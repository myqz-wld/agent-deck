import { FeishuCallbackAttempt } from './callback-attempt';
import { FeishuGatewayError } from './errors';
import type { FeishuGatewayClock } from './types';

export class FeishuGatewayLifecycle {
  private state: 'closed' | 'closing' | 'open' = 'open';
  private readonly attempts = new Set<FeishuCallbackAttempt>();
  private readonly active = new Set<Promise<unknown>>();
  private readonly background = new Set<Promise<unknown>>();

  constructor(
    private readonly clock: FeishuGatewayClock,
    private readonly callbackWindowMs: number,
  ) {}

  assertOpen(): void {
    if (this.state !== 'open') {
      throw new FeishuGatewayError('gateway_closed', 'Feishu gateway is closing or closed', true);
    }
  }

  isOpen(): boolean {
    return this.state === 'open';
  }

  track<T>(factory: () => Promise<T>): Promise<T> {
    try {
      this.assertOpen();
    } catch (error) {
      return Promise.reject(error);
    }
    const operation = factory();
    this.active.add(operation);
    void operation.finally(() => this.active.delete(operation)).catch(() => undefined);
    return operation;
  }

  withinWindow<T>(
    callback: FeishuCallbackAttempt,
    work: () => Promise<T>,
  ): Promise<T> {
    this.assertOpen();
    this.attempts.add(callback);
    const workPromise = Promise.resolve().then(work);
    this.background.add(workPromise);
    void workPromise
      .finally(() => {
        this.attempts.delete(callback);
        this.background.delete(workPromise);
      })
      .catch(() => undefined);

    return new Promise<T>((resolve, reject) => {
      const fail = (code: 'gateway_closed' | 'platform_window_exceeded') => {
        reject(
          new FeishuGatewayError(
            code,
            code === 'gateway_closed'
              ? 'Feishu gateway closed during callback processing'
              : 'Feishu callback window elapsed before Core acceptance',
            true,
          ),
        );
      };
      const onAbort = () => fail(
        this.state === 'open' ? 'platform_window_exceeded' : 'gateway_closed',
      );
      callback.controller.signal.addEventListener('abort', onAbort, { once: true });
      const timer = this.clock.setTimer(() => callback.expire(), this.callbackWindowMs);
      workPromise.then(resolve, reject).finally(() => {
        timer.cancel();
        callback.controller.signal.removeEventListener('abort', onAbort);
      }).catch(() => undefined);
    });
  }

  beginClose(): boolean {
    if (this.state !== 'open') return false;
    this.state = 'closing';
    for (const attempt of this.attempts) attempt.expire();
    return true;
  }

  async waitForBarrier(): Promise<void> {
    while (this.active.size > 0 || this.background.size > 0) {
      await Promise.allSettled([...this.active, ...this.background]);
    }
  }

  finishClose(): void {
    this.state = 'closed';
  }
}
