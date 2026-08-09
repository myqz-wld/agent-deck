import type { RemoteSessionCreateInput } from './source-types';

const MAX_PENDING_INTENTS_PER_SOURCE = 64;
const MAX_INTENT_KEY_BYTES = 128 * 1024;

export interface RemoteUserIntent {
  id: string;
  key: string;
  sourceIdentity: string;
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

async function sha256(value: string): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error('当前环境无法创建远程附件意图。');
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/** Replaces inline attachment bodies with content-bound digests before idempotency-keying. */
export async function remoteSessionCreateIntentPayload(
  input: RemoteSessionCreateInput,
): Promise<unknown> {
  return {
    ...input,
    attachments: await Promise.all(input.attachments.map(async (attachment) => ({
      bytes: attachment.bytes,
      digest: await sha256(attachment.base64),
      kind: attachment.kind,
      mime: attachment.mime,
    }))),
  };
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
    const pendingForSource = [...this.entries.values()]
      .filter((intent) => intent.sourceIdentity === sourceIdentity).length;
    if (pendingForSource >= MAX_PENDING_INTENTS_PER_SOURCE) {
      throw new Error('待确认的远程操作过多；请先核对远程状态。');
    }
    const intent = { id: this.createId(), key, sourceIdentity };
    this.entries.set(key, intent);
    return intent;
  }

  retainSources(sourceIdentities: ReadonlySet<string>): void {
    for (const [key, intent] of this.entries) {
      if (!sourceIdentities.has(intent.sourceIdentity)) this.entries.delete(key);
    }
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
