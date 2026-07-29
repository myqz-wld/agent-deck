import { describe, expect, it } from 'vitest';

import { BoundedLogStateTracker } from '../log-state-tracker';

describe('BoundedLogStateTracker', () => {
  it('tracks healthy, abnormal, periodic-summary, and recovery transitions', () => {
    let now = 0;
    const tracker = new BoundedLogStateTracker<string, 'healthy' | 'slow'>({
      now: () => now,
      summaryIntervalMs: 1_000,
    });

    const initial = tracker.observe('provider', {
      signature: 'healthy',
      abnormal: false,
    });
    expect(initial).toMatchObject({
      kind: 'initial',
      flushed: null,
      current: {
        signature: 'healthy',
        abnormal: false,
        stateDurationMs: 0,
        abnormalDurationMs: null,
        suppressedCount: 0,
        suppressedCountCapped: false,
        maxMetric: null,
      },
    });

    now = 100;
    const degraded = tracker.observe('provider', {
      signature: 'slow',
      abnormal: true,
      metric: 10,
    });
    expect(degraded).toMatchObject({
      kind: 'transition',
      flushed: {
        signature: 'healthy',
        abnormal: false,
        stateDurationMs: 100,
        abnormalDurationMs: null,
        suppressedCount: 0,
      },
      current: {
        signature: 'slow',
        abnormal: true,
        stateDurationMs: 0,
        abnormalDurationMs: 0,
        maxMetric: 10,
      },
    });

    now = 200;
    const repeat = tracker.observe('provider', {
      signature: 'slow',
      abnormal: true,
      metric: 20,
    });
    expect(repeat).toMatchObject({
      kind: 'repeat',
      flushed: null,
      current: {
        suppressedCount: 1,
        suppressedCountCapped: false,
        abnormalDurationMs: 100,
        maxMetric: 20,
      },
    });

    now = 1_099;
    expect(
      tracker.observe('provider', {
        signature: 'slow',
        abnormal: true,
        metric: 15,
      }),
    ).toMatchObject({
      kind: 'repeat',
      current: { suppressedCount: 2, maxMetric: 20 },
    });

    now = 1_100;
    const summary = tracker.observe('provider', {
      signature: 'slow',
      abnormal: true,
      metric: 30,
    });
    expect(summary).toMatchObject({
      kind: 'periodic-summary',
      flushed: {
        signature: 'slow',
        abnormal: true,
        stateDurationMs: 1_000,
        abnormalDurationMs: 1_000,
        suppressedCount: 2,
        suppressedCountCapped: false,
        maxMetric: 30,
      },
      current: {
        signature: 'slow',
        abnormal: true,
        suppressedCount: 0,
        suppressedCountCapped: false,
        maxMetric: 30,
      },
    });

    now = 1_300;
    const recovered = tracker.observe('provider', {
      signature: 'healthy',
      abnormal: false,
    });
    expect(recovered).toMatchObject({
      kind: 'transition',
      flushed: {
        signature: 'slow',
        abnormal: true,
        stateDurationMs: 1_200,
        abnormalDurationMs: 1_200,
        suppressedCount: 0,
        maxMetric: 30,
      },
      current: {
        signature: 'healthy',
        abnormal: false,
        abnormalDurationMs: null,
        maxMetric: null,
      },
    });
  });

  it('evicts the least recently observed key and treats an evicted key as initial again', () => {
    let now = 0;
    const tracker = new BoundedLogStateTracker<string, 'healthy'>({
      capacity: 2,
      now: () => now,
    });

    tracker.observe('a', { signature: 'healthy', abnormal: false });
    now += 1;
    tracker.observe('b', { signature: 'healthy', abnormal: false });
    now += 1;
    expect(
      tracker.observe('a', { signature: 'healthy', abnormal: false }).kind,
    ).toBe('repeat');

    now += 1;
    tracker.observe('c', { signature: 'healthy', abnormal: false });
    expect(tracker.size).toBe(2);

    now += 1;
    expect(
      tracker.observe('b', { signature: 'healthy', abnormal: false }).kind,
    ).toBe('initial');
    expect(tracker.size).toBe(2);

    now += 1;
    expect(
      tracker.observe('c', { signature: 'healthy', abnormal: false }).kind,
    ).toBe('repeat');

    const oneEntry = new BoundedLogStateTracker<string, 'healthy'>({
      capacity: 0,
      now: () => now,
    });
    oneEntry.observe('first', { signature: 'healthy', abnormal: false });
    oneEntry.observe('second', { signature: 'healthy', abnormal: false });
    expect(oneEntry.size).toBe(1);
    expect(
      oneEntry.observe('first', { signature: 'healthy', abnormal: false }).kind,
    ).toBe('initial');
  });

  it('flushes a changed abnormal signature without resetting the abnormal episode', () => {
    let now = 0;
    const tracker = new BoundedLogStateTracker<string, 'timeout' | 'unavailable' | 'ok'>({
      now: () => now,
      summaryIntervalMs: 10_000,
    });

    tracker.observe('provider', {
      signature: 'timeout',
      abnormal: true,
      metric: 5,
    });
    now = 20;
    tracker.observe('provider', {
      signature: 'timeout',
      abnormal: true,
      metric: 8,
    });

    now = 50;
    const changed = tracker.observe('provider', {
      signature: 'unavailable',
      abnormal: true,
      metric: 7,
    });
    expect(changed).toMatchObject({
      kind: 'transition',
      flushed: {
        signature: 'timeout',
        abnormal: true,
        stateDurationMs: 50,
        abnormalDurationMs: 50,
        suppressedCount: 1,
        maxMetric: 8,
      },
      current: {
        signature: 'unavailable',
        abnormal: true,
        stateDurationMs: 0,
        abnormalDurationMs: 50,
        maxMetric: 8,
      },
    });

    now = 70;
    tracker.observe('provider', {
      signature: 'unavailable',
      abnormal: true,
      metric: 12,
    });
    now = 100;
    const recovered = tracker.observe('provider', {
      signature: 'ok',
      abnormal: false,
    });
    expect(recovered.flushed).toMatchObject({
      signature: 'unavailable',
      stateDurationMs: 50,
      abnormalDurationMs: 100,
      suppressedCount: 1,
      maxMetric: 12,
    });
  });

  it('emits an abnormal periodic summary exactly at the time boundary', () => {
    let now = 500;
    const tracker = new BoundedLogStateTracker<string, 'failed' | 'healthy'>({
      now: () => now,
      summaryIntervalMs: 100,
    });

    tracker.observe('operation', {
      signature: 'failed',
      abnormal: true,
    });
    now = 599;
    expect(
      tracker.observe('operation', {
        signature: 'failed',
        abnormal: true,
      }).kind,
    ).toBe('repeat');

    now = 600;
    expect(
      tracker.observe('operation', {
        signature: 'failed',
        abnormal: true,
      }),
    ).toMatchObject({
      kind: 'periodic-summary',
      flushed: { suppressedCount: 1, abnormalDurationMs: 100 },
    });

    const healthyTracker = new BoundedLogStateTracker<string, 'healthy'>({
      now: () => now,
      summaryIntervalMs: 0,
    });
    healthyTracker.observe('operation', {
      signature: 'healthy',
      abnormal: false,
    });
    expect(
      healthyTracker.observe('operation', {
        signature: 'healthy',
        abnormal: false,
      }).kind,
    ).toBe('repeat');
  });

  it('keeps time monotonic and ignores invalid metric values', () => {
    let clock: number | 'throw' = 1_000;
    const tracker = new BoundedLogStateTracker<string, 'failed'>({
      now: () => {
        if (clock === 'throw') throw new Error('clock failed');
        return clock;
      },
      summaryIntervalMs: 1_000,
    });

    expect(
      tracker.observe('operation', {
        signature: 'failed',
        abnormal: true,
        metric: Number.NaN,
      }).current,
    ).toMatchObject({
      abnormalDurationMs: 0,
      maxMetric: null,
    });

    clock = 900;
    expect(
      tracker.observe('operation', {
        signature: 'failed',
        abnormal: true,
        metric: Number.POSITIVE_INFINITY,
      }).current,
    ).toMatchObject({
      abnormalDurationMs: 0,
      suppressedCount: 1,
      maxMetric: null,
    });

    clock = Number.NaN;
    expect(
      tracker.observe('operation', {
        signature: 'failed',
        abnormal: true,
        metric: -1,
      }).current,
    ).toMatchObject({
      abnormalDurationMs: 0,
      suppressedCount: 2,
      maxMetric: null,
    });

    clock = 'throw';
    const afterThrow = tracker.observe('operation', {
      signature: 'failed',
      abnormal: true,
    });
    expect(afterThrow.current).toMatchObject({
      abnormalDurationMs: 0,
      suppressedCount: 3,
    });

    clock = 2_000;
    const summary = tracker.observe('operation', {
      signature: 'failed',
      abnormal: true,
      metric: Number.MAX_VALUE,
    });
    expect(summary).toMatchObject({
      kind: 'periodic-summary',
      flushed: {
        abnormalDurationMs: 1_000,
        suppressedCount: 3,
        maxMetric: Number.MAX_SAFE_INTEGER,
      },
    });
  });

  it('caps suppressed counts and flushes the capped state on transition', () => {
    let now = 0;
    const tracker = new BoundedLogStateTracker<string, 'failed' | 'healthy'>({
      now: () => now,
      maxSuppressedCount: 2,
      summaryIntervalMs: 10_000,
    });

    tracker.observe('operation', {
      signature: 'failed',
      abnormal: true,
    });
    let repeated = tracker.observe('operation', {
      signature: 'failed',
      abnormal: true,
    });
    for (let index = 0; index < 4; index += 1) {
      repeated = tracker.observe('operation', {
        signature: 'failed',
        abnormal: true,
      });
    }
    expect(repeated.current).toMatchObject({
      suppressedCount: 2,
      suppressedCountCapped: true,
    });

    now = 100;
    const recovered = tracker.observe('operation', {
      signature: 'healthy',
      abnormal: false,
    });
    expect(recovered.flushed).toMatchObject({
      signature: 'failed',
      suppressedCount: 2,
      suppressedCountCapped: true,
      abnormalDurationMs: 100,
    });
  });
});
