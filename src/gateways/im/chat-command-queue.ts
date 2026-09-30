import { FeishuGatewayError } from './errors';

/** In-flight work only; user message bodies never enter durable gateway state. */
export class FeishuChatCommandQueue {
  private readonly entries = new Map<string, { tail: Promise<void>; size: number }>();

  async run<T>(key: string, maximumQueued: number, remaining: () => number, work: () => Promise<T>, serialize = true): Promise<T> {
    if (!serialize) { remaining(); return work(); }
    const entry = this.entries.get(key) ?? { tail: Promise.resolve(), size: 0 };
    if (entry.size >= maximumQueued) throw new FeishuGatewayError('rate_limited', 'Chat command queue is full', true);
    const previous = entry.tail;
    let release!: () => void;
    entry.tail = new Promise<void>(resolve => { release = resolve; });
    entry.size += 1;
    this.entries.set(key, entry);
    try {
      await previous;
      remaining();
      return await work();
    } finally {
      entry.size -= 1;
      release();
      if (entry.size === 0 && this.entries.get(key) === entry) this.entries.delete(key);
    }
  }
}
