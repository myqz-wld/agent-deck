import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@main/utils/logger', () => ({
  default: {
    ...mocks.logger,
    scope: () => mocks.logger,
  },
}));
vi.mock('@main/utils/run-context', () => ({
  getProcessRunId: () => 'event-loop-test-run',
}));

import { startMainEventLoopMonitor } from '../main-event-loop-monitor';

const SAMPLE_INTERVAL_MS = 250;
const LAG_THRESHOLD_MS = 500;
const SUSPEND_THRESHOLD_MS = 60_000;

class FakePowerMonitor {
  private readonly listeners = {
    resume: new Set<() => void>(),
    suspend: new Set<() => void>(),
  };

  on(event: 'resume' | 'suspend', listener: () => void): this {
    this.listeners[event].add(listener);
    return this;
  }

  removeListener(event: 'resume' | 'suspend', listener: () => void): this {
    this.listeners[event].delete(listener);
    return this;
  }

  emit(event: 'resume' | 'suspend'): void {
    for (const listener of this.listeners[event]) listener();
  }

  listenerCount(event: 'resume' | 'suspend'): number {
    return this.listeners[event].size;
  }
}

function startHarness() {
  let now = 0;
  const stop = startMainEventLoopMonitor({ now: () => now });
  return {
    sample(lagMs: number): void {
      now += SAMPLE_INTERVAL_MS + lagMs;
      vi.advanceTimersByTime(SAMPLE_INTERVAL_MS);
    },
    sampleAt(value: number): void {
      now = value;
      vi.advanceTimersByTime(SAMPLE_INTERVAL_MS);
    },
    stop,
  };
}

function diagnostic(level: 'info' | 'warn', index = 0): Record<string, unknown> {
  return mocks.logger[level].mock.calls[index]?.[1] as Record<string, unknown>;
}

beforeEach(() => {
  vi.useFakeTimers();
  for (const method of Object.values(mocks.logger)) method.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('startMainEventLoopMonitor', () => {
  it('warns at the exact lag threshold with only fixed safe fields', () => {
    const monitor = startHarness();

    monitor.sample(LAG_THRESHOLD_MS - 1);
    expect(mocks.logger.warn).not.toHaveBeenCalled();

    monitor.sample(LAG_THRESHOLD_MS);
    expect(mocks.logger.warn).toHaveBeenCalledOnce();
    expect(mocks.logger.warn.mock.calls[0]?.[0]).toBe(
      'main event loop state degraded',
    );
    expect(diagnostic('warn')).toEqual({
      event: 'main-event-loop-state',
      runId: 'event-loop-test-run',
      state: 'lagging',
      previousState: null,
      transition: 'initial',
      abnormalDurationMs: 0,
      lagMs: LAG_THRESHOLD_MS,
      maxLagMs: LAG_THRESHOLD_MS,
      suppressedCount: 0,
      suppressedCountCapped: false,
      sampleIntervalMs: SAMPLE_INTERVAL_MS,
      lagThresholdMs: LAG_THRESHOLD_MS,
      suspendThresholdMs: SUSPEND_THRESHOLD_MS,
      recoveryHealthySamples: 0,
      recoveryHealthySamplesRequired: 4,
    });
    expect(JSON.stringify(mocks.logger.warn.mock.calls)).not.toContain('[performance]');
    monitor.stop();
  });

  it('silences repeats and emits one 60-second summary with bounded aggregates', () => {
    const monitor = startHarness();

    monitor.sample(LAG_THRESHOLD_MS);
    for (let index = 0; index < 80; index += 1) {
      monitor.sample(index === 0 ? 700 : LAG_THRESHOLD_MS);
    }

    expect(mocks.logger.warn).toHaveBeenCalledTimes(2);
    expect(mocks.logger.warn.mock.calls[1]?.[0]).toBe(
      'main event loop state remains degraded',
    );
    expect(diagnostic('warn', 1)).toMatchObject({
      state: 'lagging',
      previousState: 'lagging',
      transition: 'periodic-summary',
      abnormalDurationMs: 60_200,
      lagMs: LAG_THRESHOLD_MS,
      maxLagMs: 700,
      suppressedCount: 79,
      suppressedCountCapped: false,
    });

    monitor.sample(LAG_THRESHOLD_MS);
    expect(mocks.logger.warn).toHaveBeenCalledTimes(2);
    monitor.stop();
  });

  it('recovers only after four consecutive healthy samples', () => {
    const monitor = startHarness();

    monitor.sample(800);
    for (let index = 0; index < 3; index += 1) monitor.sample(0);
    expect(mocks.logger.info).not.toHaveBeenCalled();

    monitor.sample(0);
    expect(mocks.logger.info).toHaveBeenCalledOnce();
    expect(mocks.logger.info.mock.calls[0]?.[0]).toBe(
      'main event loop state recovered',
    );
    expect(diagnostic('info')).toMatchObject({
      state: 'healthy',
      previousState: 'lagging',
      transition: 'transition',
      abnormalDurationMs: 1_000,
      lagMs: 0,
      maxLagMs: 800,
      recoveryHealthySamples: 4,
    });

    monitor.sample(0);
    expect(mocks.logger.info).toHaveBeenCalledOnce();
    monitor.stop();
  });

  it('resets the recovery streak when lag relapses before the fourth sample', () => {
    const monitor = startHarness();

    monitor.sample(LAG_THRESHOLD_MS);
    for (let index = 0; index < 3; index += 1) monitor.sample(0);
    monitor.sample(900);
    expect(mocks.logger.warn).toHaveBeenCalledOnce();

    for (let index = 0; index < 3; index += 1) monitor.sample(0);
    expect(mocks.logger.info).not.toHaveBeenCalled();
    monitor.sample(0);
    expect(mocks.logger.info).toHaveBeenCalledOnce();
    expect(diagnostic('info')).toMatchObject({
      maxLagMs: 900,
      suppressedCount: 1,
      recoveryHealthySamples: 4,
    });
    monitor.stop();
  });

  it('rebases suspend gaps without manufacturing a transition', () => {
    const monitor = startHarness();

    monitor.sample(700);
    for (let index = 0; index < 3; index += 1) monitor.sample(0);
    monitor.sample(SUSPEND_THRESHOLD_MS);
    expect(mocks.logger.warn).toHaveBeenCalledOnce();
    expect(mocks.logger.info).not.toHaveBeenCalled();

    for (let index = 0; index < 3; index += 1) monitor.sample(0);
    expect(mocks.logger.info).not.toHaveBeenCalled();
    monitor.sample(0);
    expect(mocks.logger.info).toHaveBeenCalledOnce();
    expect(diagnostic('info')).toMatchObject({
      abnormalDurationMs: 1_750,
      maxLagMs: 700,
    });
    monitor.stop();
  });

  it('uses power events to exclude short system sleeps from event-loop lag', () => {
    let now = 0;
    const powerMonitor = new FakePowerMonitor();
    const stop = startMainEventLoopMonitor({
      now: () => now,
      powerMonitor,
    });

    powerMonitor.emit('suspend');
    now += 29_000;
    vi.advanceTimersByTime(1_000);
    expect(mocks.logger.warn).not.toHaveBeenCalled();

    powerMonitor.emit('resume');
    now += SAMPLE_INTERVAL_MS;
    vi.advanceTimersByTime(SAMPLE_INTERVAL_MS);
    expect(mocks.logger.warn).not.toHaveBeenCalled();
    expect(powerMonitor.listenerCount('suspend')).toBe(1);
    expect(powerMonitor.listenerCount('resume')).toBe(1);

    stop();
    expect(powerMonitor.listenerCount('suspend')).toBe(0);
    expect(powerMonitor.listenerCount('resume')).toBe(0);
  });

  it('rebases clock rollback and nonfinite readings without false transitions', () => {
    const monitor = startHarness();

    monitor.sample(600);
    for (let index = 0; index < 3; index += 1) monitor.sample(0);
    monitor.sampleAt(Number.NaN);
    monitor.sampleAt(100);
    monitor.sampleAt(50);
    expect(mocks.logger.info).not.toHaveBeenCalled();

    for (let index = 0; index < 3; index += 1) monitor.sample(0);
    expect(mocks.logger.info).not.toHaveBeenCalled();
    monitor.sample(0);
    expect(mocks.logger.info).toHaveBeenCalledOnce();
    expect(mocks.logger.warn).toHaveBeenCalledOnce();
    monitor.stop();
  });

  it('keeps sampling when a diagnostic sink throws', () => {
    const monitor = startHarness();
    mocks.logger.warn.mockImplementationOnce(() => {
      throw new Error('diagnostic sink failure');
    });

    expect(() => monitor.sample(600)).not.toThrow();
    for (let index = 0; index < 4; index += 1) monitor.sample(0);
    expect(mocks.logger.info).toHaveBeenCalledOnce();

    monitor.sample(700);
    expect(mocks.logger.warn).toHaveBeenCalledTimes(2);
    monitor.stop();
  });

  it('stop clears the interval and prevents future sampling', () => {
    const monitor = startHarness();
    expect(vi.getTimerCount()).toBe(1);

    monitor.stop();
    expect(vi.getTimerCount()).toBe(0);
    monitor.sample(800);
    expect(mocks.logger.warn).not.toHaveBeenCalled();
  });
});
