const caches = new Set<{ clear(): void }>();

/** Bounded in-memory read projections; callers still revalidate and fence writes. */
export class RemoteReadCache<T> {
  private readonly entries = new Map<string, { value: T; at: number }>();
  private readonly flights = new Map<string, Promise<T>>();
  private epoch = 0;

  constructor(private readonly limit = 16, private readonly maxAgeMs = 5 * 60_000) { caches.add(this); }

  get(key: string): T | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (Date.now() - entry.at > this.maxAgeMs) { this.entries.delete(key); return null; }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T): void {
    this.flights.delete(key);
    this.entries.delete(key);
    this.entries.set(key, { value, at: Date.now() });
    while (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value!);
  }

  delete(key: string): void { this.entries.delete(key); this.flights.delete(key); }

  read(key: string, read: () => Promise<T>): Promise<T> {
    const existing = this.flights.get(key);
    if (existing) return existing;
    const epoch = this.epoch;
    const request = Promise.resolve().then(read).then(value => {
      if (epoch === this.epoch && this.flights.get(key) === request) this.set(key, value);
      return value;
    }).finally(() => { if (this.flights.get(key) === request) this.flights.delete(key); });
    this.flights.set(key, request);
    return request;
  }

  clear(): void { this.epoch += 1; this.entries.clear(); this.flights.clear(); }
}

export function clearRemoteReadCaches(): void { for (const cache of caches) cache.clear(); }
