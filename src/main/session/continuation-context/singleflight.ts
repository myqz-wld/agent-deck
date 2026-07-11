export class AsyncSingleflight<T> {
  private readonly inFlight = new Map<string, Promise<T>>();

  run(key: string, work: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const pending = Promise.resolve().then(work);
    this.inFlight.set(key, pending);
    const cleanup = () => {
      if (this.inFlight.get(key) === pending) this.inFlight.delete(key);
    };
    void pending.then(cleanup, cleanup);
    return pending;
  }

  has(key: string): boolean {
    return this.inFlight.has(key);
  }

  clear(): void {
    this.inFlight.clear();
  }
}
