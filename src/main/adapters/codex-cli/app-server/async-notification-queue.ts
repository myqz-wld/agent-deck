export class AsyncNotificationQueue<T> implements AsyncIterable<T> {
  private values: T[] = [];
  private waiters: Array<{
    resolve: (result: IteratorResult<T>) => void;
    reject: (err: Error) => void;
  }> = [];
  private closed = false;
  private error: Error | null = null;

  constructor(private readonly maxBufferedValues = 2_048) {}

  push(value: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ value, done: false });
      return;
    }
    if (this.values.length >= this.maxBufferedValues) {
      this.throw(new Error('Codex app-server notification queue exceeded its bounded capacity'));
      return;
    }
    this.values.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ value: undefined as T, done: true });
    }
  }

  throw(err: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.error = err;
    this.values.length = 0;
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(err);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        const value = this.values.shift();
        if (value !== undefined) return Promise.resolve({ value, done: false });
        if (this.error) return Promise.reject(this.error);
        if (this.closed) return Promise.resolve({ value: undefined as T, done: true });
        return new Promise<IteratorResult<T>>((resolve, reject) => {
          this.waiters.push({ resolve, reject });
        });
      },
    };
  }
}
