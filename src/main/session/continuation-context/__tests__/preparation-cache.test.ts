import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PreparedContinuationContext, ResolvedContinuationGenerator, ResolvedSuccessorSpec } from '../types';
import { ContinuationPreparationCache } from '../preparation-cache';
import { AsyncSingleflight } from '../singleflight';

const generator: ResolvedContinuationGenerator = {
  adapter: 'claude-code', model: null, thinking: 'low', contextWindowTokens: null, configFingerprint: 'g',
};
const target: ResolvedSuccessorSpec = {
  adapter: 'claude-code', model: null, thinking: 'low', sandbox: null, permissionMode: null,
  networkAccessEnabled: false, additionalDirectories: [], contextWindowTokens: 128_000, runtimeFingerprint: 't',
};
const prepared: PreparedContinuationContext = {
  version: 1,
  providerPrompt: 'prompt',
  persistedUserText: 'next',
  source: { eventRevision: 1, rebuildAfterRevision: 0, maxEventId: 1 },
  checkpoint: { id: null, throughRevision: 0, formatVersion: 1, refreshed: false },
  projection: { canonicalHash: null, omittedFacts: 0 },
  quality: 'raw-only',
  metrics: {
    rawRetentionCeilingTokens: 8_000, targetPromptCapacityTokens: 100_000,
    checkpointProjectionBudgetTokens: 2_000, generatorFoldInputBudgetTokens: 32_000,
    estimatedPromptTokens: 10, checkpointTokens: 1, rawTailTokens: 1, includedUserMessages: 1,
    truncatedBoundaryMessages: 0, foldCalls: 0, repairCalls: 0, elapsedMs: 1,
    uncoveredRevisionRange: null,
  },
  warnings: [], preparationHash: 'h', spoolId: 'spool',
};

describe('continuation preparation cache and singleflight', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('enforces ownership, TTL, one consume, and one pre-spawn retry', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const evicted = vi.fn();
    const cache = new ContinuationPreparationCache({ ttlMs: 100, onEvict: evicted });
    const entry = cache.put({ ownerSessionId: 'owner', sourceSessionId: 'source', prepared, generator, target, now: 1_000 });
    expect(entry.preparationId).toMatch(/^[a-f0-9-]{36}$/);
    expect(() => cache.get(entry.preparationId, 'other', 1_001)).toThrow(/not authorized/);
    expect(cache.consume(entry.preparationId, 'owner', 1_002).consumed).toBe(true);
    expect(() => cache.consume(entry.preparationId, 'owner', 1_003)).toThrow(/already/);
    expect(cache.releasePreSpawnFailure(entry.preparationId, 'owner', 1_003)).toBe(true);
    expect(cache.consume(entry.preparationId, 'owner', 1_004).consumed).toBe(true);
    expect(cache.releasePreSpawnFailure(entry.preparationId, 'owner', 1_005)).toBe(false);
    expect(cache.purgeExpired(1_100)).toBe(0);
    expect(cache.size).toBe(1);
    expect(cache.delete(entry.preparationId)).toBe(true);
    expect(evicted).toHaveBeenCalledTimes(1);
  });

  it('pins an in-flight entry against expiry, invalidation, clear, and capacity eviction', () => {
    vi.useFakeTimers();
    vi.setSystemTime(30_000);
    const discarded = vi.fn();
    const evicted = vi.fn();
    const cache = new ContinuationPreparationCache({
      ttlMs: 100,
      maxEntries: 1,
      maxBytes: 10_000,
      onEvict: evicted,
    });
    const entry = cache.put({
      ownerSessionId: 'owner',
      sourceSessionId: 'source',
      prepared,
      generator,
      target,
      onDiscard: discarded,
    });
    cache.consume(entry.preparationId, 'owner');

    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(1_000);
    expect(cache.purgeExpired()).toBe(0);
    expect(cache.invalidateSource('source')).toBe(0);
    cache.clear();
    expect(cache.size).toBe(1);
    expect(discarded).not.toHaveBeenCalled();
    expect(evicted).not.toHaveBeenCalled();
    expect(() =>
      cache.put({
        ownerSessionId: 'owner',
        sourceSessionId: 'other-source',
        prepared: { ...prepared, spoolId: 'other-spool' },
        generator,
        target,
      }),
    ).toThrow(/in-flight handoffs/);
    expect(cache.peek(entry.preparationId, 'owner').consumed).toBe(true);

    expect(cache.delete(entry.preparationId)).toBe(true);
    expect(discarded).toHaveBeenCalledOnce();
    expect(evicted).toHaveBeenCalledOnce();
  });

  it('expires a pinned entry instead of exposing a retry after pre-spawn failure', () => {
    const cache = new ContinuationPreparationCache({ ttlMs: 100 });
    const entry = cache.put({
      ownerSessionId: 'owner',
      sourceSessionId: 'source',
      prepared,
      generator,
      target,
      now: 1_000,
    });
    cache.consume(entry.preparationId, 'owner', 1_050);

    expect(cache.releasePreSpawnFailure(entry.preparationId, 'owner', 1_100)).toBe(false);
    expect(cache.size).toBe(0);
  });

  it('accounts immutable spool bytes and keeps peek non-touching for LRU', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const evicted = vi.fn();
    const cache = new ContinuationPreparationCache({ maxEntries: 1, maxBytes: 10_000, onEvict: evicted });
    const first = cache.put({
      ownerSessionId: 'owner', sourceSessionId: 'source', prepared, generator, target,
      spoolBytes: 4_096, now: 1,
    });
    expect(first.spoolBytes).toBe(4_096);
    expect(first.bytes).toBeGreaterThan(4_096);
    expect(cache.totalBytes).toBe(first.bytes);
    expect(cache.peek(first.preparationId, 'owner', 50).lastAccessedAt).toBe(1);

    const second = cache.put({
      ownerSessionId: 'owner', sourceSessionId: 'source-2',
      prepared: { ...prepared, spoolId: 'spool-2' }, generator, target, now: 100,
    });
    expect(cache.size).toBe(1);
    expect(cache.peek(second.preparationId, 'owner', 101).sourceSessionId).toBe('source-2');
    expect(evicted).toHaveBeenCalledWith(expect.objectContaining({ preparationId: first.preparationId }));
    cache.clear();
  });

  it('actively expires entries at their TTL and runs eviction cleanup without cache access', () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const evicted = vi.fn();
    const cache = new ContinuationPreparationCache({ ttlMs: 100, onEvict: evicted });
    const entry = cache.put({
      ownerSessionId: 'owner', sourceSessionId: 'source', prepared, generator, target,
    });

    vi.advanceTimersByTime(99);
    expect(cache.size).toBe(1);
    expect(evicted).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(cache.size).toBe(0);
    expect(evicted).toHaveBeenCalledOnce();
    expect(evicted).toHaveBeenCalledWith(expect.objectContaining({ preparationId: entry.preparationId }));
  });

  it('reschedules for the next expiry and clear cancels pending work while remaining reusable', () => {
    vi.useFakeTimers();
    vi.setSystemTime(20_000);
    const evicted = vi.fn();
    const cache = new ContinuationPreparationCache({ ttlMs: 100, onEvict: evicted });
    const first = cache.put({
      ownerSessionId: 'owner', sourceSessionId: 'source-1', prepared, generator, target,
    });
    vi.advanceTimersByTime(50);
    const second = cache.put({
      ownerSessionId: 'owner', sourceSessionId: 'source-2',
      prepared: { ...prepared, spoolId: 'spool-2' }, generator, target,
    });

    vi.advanceTimersByTime(50);
    expect(cache.size).toBe(1);
    expect(evicted).toHaveBeenCalledWith(expect.objectContaining({ preparationId: first.preparationId }));
    expect(evicted).not.toHaveBeenCalledWith(expect.objectContaining({ preparationId: second.preparationId }));

    cache.clear();
    expect(cache.size).toBe(0);
    expect(evicted).toHaveBeenCalledWith(expect.objectContaining({ preparationId: second.preparationId }));
    const cleanupCalls = evicted.mock.calls.length;
    vi.advanceTimersByTime(1_000);
    expect(evicted).toHaveBeenCalledTimes(cleanupCalls);

    const third = cache.put({
      ownerSessionId: 'owner', sourceSessionId: 'source-3',
      prepared: { ...prepared, spoolId: 'spool-3' }, generator, target,
    });
    vi.advanceTimersByTime(100);
    expect(evicted).toHaveBeenCalledWith(expect.objectContaining({ preparationId: third.preparationId }));
    expect(cache.size).toBe(0);
  });

  it('coalesces identical asynchronous work and clears after settlement', async () => {
    const singleflight = new AsyncSingleflight<number>();
    const work = vi.fn(async () => 42);
    const [left, right] = await Promise.all([singleflight.run('same', work), singleflight.run('same', work)]);
    expect([left, right]).toEqual([42, 42]);
    expect(work).toHaveBeenCalledTimes(1);
    await singleflight.run('same', work);
    expect(work).toHaveBeenCalledTimes(2);
  });
});
