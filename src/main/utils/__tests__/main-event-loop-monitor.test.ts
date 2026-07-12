import { afterEach, describe, expect, it, vi } from 'vitest';

import { startMainEventLoopMonitor } from '../main-event-loop-monitor';

describe('startMainEventLoopMonitor', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports one actionable delay and rebases the next sample', () => {
    vi.useFakeTimers();
    let now = 0;
    const onDelay = vi.fn();
    const stop = startMainEventLoopMonitor({
      sampleIntervalMs: 100,
      warnThresholdMs: 200,
      warningCooldownMs: 1_000,
      suspendThresholdMs: 10_000,
      now: () => now,
      onDelay,
    });

    now = 450;
    vi.advanceTimersByTime(100);
    expect(onDelay).toHaveBeenCalledOnce();
    expect(onDelay).toHaveBeenCalledWith({
      lagMs: 350,
      sampleIntervalMs: 100,
      suppressedSinceLastWarning: 0,
      maxSuppressedLagMs: 0,
    });

    now = 550;
    vi.advanceTimersByTime(100);
    expect(onDelay).toHaveBeenCalledOnce();
    stop();
  });

  it('rate-limits repeated stalls and ignores likely system suspend', () => {
    vi.useFakeTimers();
    let now = 0;
    const onDelay = vi.fn();
    const stop = startMainEventLoopMonitor({
      sampleIntervalMs: 100,
      warnThresholdMs: 200,
      warningCooldownMs: 1_000,
      suspendThresholdMs: 5_000,
      now: () => now,
      onDelay,
    });

    now = 400;
    vi.advanceTimersByTime(100);
    now = 800;
    vi.advanceTimersByTime(100);
    expect(onDelay).toHaveBeenCalledOnce();

    now = 6_000;
    vi.advanceTimersByTime(100);
    expect(onDelay).toHaveBeenCalledOnce();
    stop();
  });

  it('stop cancels future sampling', () => {
    vi.useFakeTimers();
    let now = 0;
    const onDelay = vi.fn();
    const stop = startMainEventLoopMonitor({
      sampleIntervalMs: 100,
      warnThresholdMs: 200,
      now: () => now,
      onDelay,
    });
    stop();

    now = 1_000;
    vi.advanceTimersByTime(100);
    expect(onDelay).not.toHaveBeenCalled();
  });
});
