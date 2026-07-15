interface QueuedRefresh {
  run: () => Promise<void>;
  signal: AbortSignal;
  state: 'queued' | 'running' | 'settled';
  resolve: () => void;
  reject: (error: unknown) => void;
  onAbort: () => void;
}

function cancelledBeforeExecution(): Error {
  return new Error('Background checkpoint refresh cancelled before execution');
}

/** Dynamically resizable FIFO queue for cross-session background provider work. */
export class CheckpointRefreshQueue {
  private readonly queued: QueuedRefresh[] = [];
  private readonly idleWaiters = new Set<() => void>();
  private active = 0;

  constructor(private maxConcurrent: number) {
    this.assertMaxConcurrent(maxConcurrent);
  }

  enqueue(run: () => Promise<void>, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(cancelledBeforeExecution());
    return new Promise<void>((resolve, reject) => {
      const item: QueuedRefresh = {
        run,
        signal,
        state: 'queued',
        resolve,
        reject,
        onAbort: () => {
          if (item.state !== 'queued') return;
          item.state = 'settled';
          const index = this.queued.indexOf(item);
          if (index >= 0) this.queued.splice(index, 1);
          signal.removeEventListener('abort', item.onAbort);
          reject(cancelledBeforeExecution());
          this.pump();
          this.resolveIdleWaiters();
        },
      };
      signal.addEventListener('abort', item.onAbort, { once: true });
      this.queued.push(item);
      this.pump();
    });
  }

  setMaxConcurrent(maxConcurrent: number): void {
    this.assertMaxConcurrent(maxConcurrent);
    this.maxConcurrent = maxConcurrent;
    this.pump();
  }

  whenIdle(): Promise<void> {
    if (this.active === 0 && this.queued.length === 0) return Promise.resolve();
    return new Promise<void>((resolve) => this.idleWaiters.add(resolve));
  }

  private pump(): void {
    while (this.active < this.maxConcurrent) {
      const item = this.queued.shift();
      if (!item) break;
      if (item.state !== 'queued') continue;
      item.state = 'running';
      item.signal.removeEventListener('abort', item.onAbort);
      this.active += 1;
      void Promise.resolve()
        .then(item.run)
        .then(item.resolve, item.reject)
        .finally(() => {
          item.state = 'settled';
          this.active -= 1;
          this.pump();
          this.resolveIdleWaiters();
        });
    }
  }

  private resolveIdleWaiters(): void {
    if (this.active > 0 || this.queued.length > 0) return;
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }

  private assertMaxConcurrent(value: number): void {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new RangeError(`Checkpoint refresh concurrency must be a positive integer: ${value}`);
    }
  }
}
