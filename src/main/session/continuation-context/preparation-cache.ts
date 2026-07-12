import { randomUUID } from 'node:crypto';
import type { CreateSessionOptions } from '@main/adapters/types';
import type { PreparedContinuationContext, ResolvedContinuationGenerator, ResolvedSuccessorSpec } from './types';
import { utf8ByteLength } from './token-estimator';

export const DEFAULT_PREPARATION_CACHE_TTL_MS = 10 * 60 * 1000;
export const DEFAULT_PREPARATION_CACHE_MAX_ENTRIES = 8;
export const DEFAULT_PREPARATION_CACHE_MAX_BYTES = 8 * 1024 * 1024;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export interface CachedContinuationPreparation {
  preparationId: string;
  ownerSessionId: string;
  sourceSessionId: string;
  createdAt: number;
  expiresAt: number;
  lastAccessedAt: number;
  consumed: boolean;
  retryAvailable: boolean;
  prepared: PreparedContinuationContext;
  generator: ResolvedContinuationGenerator;
  target: ResolvedSuccessorSpec;
  frozen?: {
    sourceRuntimeFingerprint: string;
    settingsFingerprint: string;
    targetSelection: unknown;
    createOptions: CreateSessionOptions;
    targetRuntimeFingerprint: string;
    createOptionsFingerprint: string;
    preparedIntegrityFingerprint: string;
  };
  spoolBytes: number;
  bytes: number;
  /** Main-process lifecycle hook for resources owned for exactly this cache entry. */
  onDiscard?: () => void;
}

export interface PreparationCacheOptions {
  ttlMs?: number;
  maxEntries?: number;
  maxBytes?: number;
  onEvict?: (entry: CachedContinuationPreparation) => void;
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${field} must be positive`);
  return value;
}

export class ContinuationPreparationCache {
  private readonly entries = new Map<string, CachedContinuationPreparation>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: PreparationCacheOptions = {}) {
    this.ttlMs = positiveInteger(options.ttlMs ?? DEFAULT_PREPARATION_CACHE_TTL_MS, 'ttlMs');
    this.maxEntries = positiveInteger(
      options.maxEntries ?? DEFAULT_PREPARATION_CACHE_MAX_ENTRIES,
      'maxEntries',
    );
    this.maxBytes = positiveInteger(options.maxBytes ?? DEFAULT_PREPARATION_CACHE_MAX_BYTES, 'maxBytes');
  }

  put(input: {
    ownerSessionId: string;
    sourceSessionId: string;
    prepared: PreparedContinuationContext;
    generator: ResolvedContinuationGenerator;
    target: ResolvedSuccessorSpec;
    frozen?: CachedContinuationPreparation['frozen'];
    spoolBytes?: number;
    onDiscard?: () => void;
    now?: number;
  }): CachedContinuationPreparation {
    const now = input.now ?? Date.now();
    const spoolBytes = input.spoolBytes ?? 0;
    if (!Number.isSafeInteger(spoolBytes) || spoolBytes < 0) {
      throw new Error('spoolBytes must be a non-negative safe integer');
    }
    const bytes =
      spoolBytes +
      utf8ByteLength(input.prepared.providerPrompt) +
      utf8ByteLength(input.prepared.persistedUserText) +
      utf8ByteLength(
        JSON.stringify({
          generator: input.generator,
          target: input.target,
          frozen: input.frozen,
          preparationHash: input.prepared.preparationHash,
        }),
      );
    if (bytes > this.maxBytes) throw new Error('Prepared continuation context exceeds cache byte limit');
    const entry: CachedContinuationPreparation = {
      preparationId: randomUUID(),
      ownerSessionId: input.ownerSessionId,
      sourceSessionId: input.sourceSessionId,
      createdAt: now,
      expiresAt: now + this.ttlMs,
      lastAccessedAt: now,
      consumed: false,
      retryAvailable: true,
      prepared: input.prepared,
      generator: input.generator,
      target: input.target,
      frozen: input.frozen,
      spoolBytes,
      bytes,
      ...(input.onDiscard ? { onDiscard: input.onDiscard } : {}),
    };
    this.makeRoomFor(entry.bytes, now);
    this.entries.set(entry.preparationId, entry);
    this.scheduleExpiry();
    return entry;
  }

  get(preparationId: string, ownerSessionId: string, now = Date.now()): CachedContinuationPreparation {
    this.purgeExpired(now);
    const entry = this.entries.get(preparationId);
    if (!entry || entry.ownerSessionId !== ownerSessionId) {
      throw new Error('Continuation preparation not found or not authorized');
    }
    entry.lastAccessedAt = now;
    return entry;
  }

  peek(preparationId: string, ownerSessionId: string, now = Date.now()): CachedContinuationPreparation {
    this.purgeExpired(now);
    const entry = this.entries.get(preparationId);
    if (!entry || entry.ownerSessionId !== ownerSessionId) {
      throw new Error('Continuation preparation not found or not authorized');
    }
    return entry;
  }

  consume(preparationId: string, ownerSessionId: string, now = Date.now()): CachedContinuationPreparation {
    const entry = this.get(preparationId, ownerSessionId, now);
    if (entry.consumed) throw new Error('Continuation preparation has already been consumed');
    entry.consumed = true;
    this.scheduleExpiry();
    return entry;
  }

  releasePreSpawnFailure(preparationId: string, ownerSessionId: string, now = Date.now()): boolean {
    const entry = this.get(preparationId, ownerSessionId, now);
    if (!entry.consumed || !entry.retryAvailable) return false;
    if (entry.expiresAt <= now) {
      this.remove(entry.preparationId);
      this.scheduleExpiry();
      return false;
    }
    entry.consumed = false;
    entry.retryAvailable = false;
    this.scheduleExpiry();
    return true;
  }

  delete(preparationId: string): boolean {
    const deleted = this.remove(preparationId);
    if (deleted) this.scheduleExpiry();
    return deleted;
  }

  invalidateSource(sourceSessionId: string): number {
    const ids = [...this.entries.values()]
      .filter((entry) => entry.sourceSessionId === sourceSessionId && !entry.consumed)
      .map((entry) => entry.preparationId);
    ids.forEach((id) => this.remove(id));
    this.scheduleExpiry();
    return ids.length;
  }

  purgeExpired(now = Date.now()): number {
    const count = this.purgeExpiredEntries(now);
    this.scheduleExpiry();
    return count;
  }

  clear(): void {
    this.cancelExpiryTimer();
    [...this.entries.values()]
      .filter((entry) => !entry.consumed)
      .forEach((entry) => this.remove(entry.preparationId));
    this.scheduleExpiry();
  }

  get size(): number {
    return this.entries.size;
  }

  get totalBytes(): number {
    return [...this.entries.values()].reduce((total, entry) => total + entry.bytes, 0);
  }

  private makeRoomFor(incomingBytes: number, now: number): void {
    this.purgeExpiredEntries(now);
    const pinned = [...this.entries.values()].filter((entry) => entry.consumed);
    const pinnedBytes = pinned.reduce((total, entry) => total + entry.bytes, 0);
    if (pinned.length + 1 > this.maxEntries || pinnedBytes + incomingBytes > this.maxBytes) {
      throw new Error('Preparation cache capacity is occupied by in-flight handoffs');
    }
    const oldestFirst = [...this.entries.values()]
      .filter((entry) => !entry.consumed)
      .sort(
        (left, right) =>
          left.lastAccessedAt - right.lastAccessedAt || left.createdAt - right.createdAt,
      );
    let bytes = [...this.entries.values()].reduce((total, entry) => total + entry.bytes, 0);
    let entries = this.entries.size;
    while (entries + 1 > this.maxEntries || bytes + incomingBytes > this.maxBytes) {
      const oldest = oldestFirst.shift();
      if (!oldest) break;
      bytes -= oldest.bytes;
      entries -= 1;
      this.remove(oldest.preparationId);
    }
  }

  private remove(preparationId: string): boolean {
    const entry = this.entries.get(preparationId);
    if (!entry) return false;
    this.entries.delete(preparationId);
    try {
      entry.onDiscard?.();
    } finally {
      this.options.onEvict?.(entry);
    }
    return true;
  }

  private purgeExpiredEntries(now: number): number {
    const ids = [...this.entries.values()]
      .filter((entry) => !entry.consumed && entry.expiresAt <= now)
      .map((entry) => entry.preparationId);
    ids.forEach((id) => this.remove(id));
    return ids.length;
  }

  private cancelExpiryTimer(): void {
    if (!this.expiryTimer) return;
    clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
  }

  private scheduleExpiry(): void {
    this.cancelExpiryTimer();
    let earliestExpiry = Number.POSITIVE_INFINITY;
    for (const entry of this.entries.values()) {
      if (entry.consumed) continue;
      earliestExpiry = Math.min(earliestExpiry, entry.expiresAt);
    }
    if (!Number.isFinite(earliestExpiry)) return;

    const delay = Math.min(MAX_TIMER_DELAY_MS, Math.max(0, earliestExpiry - Date.now()));
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = null;
      this.purgeExpired();
    }, delay);
    this.expiryTimer.unref?.();
  }
}
