const MAX_PENDING_INTENTS = 64;
const MAX_INTENT_KEY_BYTES = 128 * 1024;

export interface RemoteUserIntent {
  id: string;
  key: string;
}

function canonical(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  throw new Error('远程操作意图包含不支持的值。');
}

function defaultIntentId(): string {
  if (!globalThis.crypto?.randomUUID) throw new Error('当前环境无法创建远程操作意图。');
  return `intent-${globalThis.crypto.randomUUID()}`;
}

export class RemoteUserIntentLedger {
  private readonly entries = new Map<string, RemoteUserIntent>();

  constructor(private readonly createId: () => string = defaultIntentId) {}

  acquire(sourceIdentity: string, operation: string, payload: unknown): RemoteUserIntent {
    const key = canonical([sourceIdentity, operation, payload]);
    if (new TextEncoder().encode(key).byteLength > MAX_INTENT_KEY_BYTES) {
      throw new Error('远程操作意图过大。');
    }
    const existing = this.entries.get(key);
    if (existing) return existing;
    if (this.entries.size >= MAX_PENDING_INTENTS) {
      throw new Error('待确认的远程操作过多；请先核对远程状态。');
    }
    const intent = { id: this.createId(), key };
    this.entries.set(key, intent);
    return intent;
  }

  complete(intent: RemoteUserIntent): void {
    if (this.entries.get(intent.key)?.id === intent.id) this.entries.delete(intent.key);
  }

  async run<T>(
    sourceIdentity: string,
    operation: string,
    payload: unknown,
    request: (intentId: string) => Promise<T>,
  ): Promise<T> {
    const intent = this.acquire(sourceIdentity, operation, payload);
    const result = await request(intent.id);
    this.complete(intent);
    return result;
  }
}
