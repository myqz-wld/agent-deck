import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  getProcessRunId: () => 'checkpoint-refresh-test-run',
}));

import { CheckpointRefreshDiagnosticCoordinator } from '../checkpoint-refresh-diagnostics';

const SLOW_THRESHOLD_MS = 30_000;
const SUMMARY_INTERVAL_MS = 5 * 60_000;

function diagnostic(level: 'info' | 'warn', index = 0): Record<string, unknown> {
  return mocks.logger[level].mock.calls[index]?.[1] as Record<string, unknown>;
}

beforeEach(() => {
  for (const method of Object.values(mocks.logger)) method.mockReset();
});

describe('CheckpointRefreshDiagnosticCoordinator', () => {
  it('keeps fast success silent, reports slow success at info, and recovers from failures', () => {
    let now = 0;
    const coordinator = new CheckpointRefreshDiagnosticCoordinator(() => now);

    coordinator.begin('session-secret', 'normal', now);
    now = SLOW_THRESHOLD_MS - 1;
    coordinator.complete('session-secret', { trigger: 'normal', partial: false });
    expect(mocks.logger.warn).not.toHaveBeenCalled();
    expect(mocks.logger.info).not.toHaveBeenCalled();

    now = 40_000;
    coordinator.begin('session-secret', 'safety', now);
    now += SLOW_THRESHOLD_MS;
    coordinator.complete('session-secret', { trigger: 'safety', partial: false });
    expect(mocks.logger.warn).not.toHaveBeenCalled();
    expect(mocks.logger.info).toHaveBeenCalledOnce();
    expect(mocks.logger.info.mock.calls[0]?.[0]).toBe(
      'checkpoint refresh completed slowly',
    );
    expect(diagnostic('info')).toEqual({
      event: 'checkpoint-refresh-state',
      runId: 'checkpoint-refresh-test-run',
      sessionRef: expect.any(String),
      state: 'slow:safety',
      previousState: 'healthy',
      transition: 'transition',
      durationMs: SLOW_THRESHOLD_MS,
      observationWindowMs: 0,
      suppressedCount: 0,
      suppressedCountCapped: false,
      maxDurationMs: SLOW_THRESHOLD_MS,
      slowThresholdMs: SLOW_THRESHOLD_MS,
      summaryIntervalMs: SUMMARY_INTERVAL_MS,
    });

    now += 1_000;
    coordinator.fail('session-secret', {
      trigger: 'safety',
      category: 'provider-error',
      reason: 'provider-error',
    });
    expect(mocks.logger.warn).toHaveBeenCalledOnce();

    now += 1_000;
    coordinator.begin('session-secret', 'safety', now);
    now += 1;
    coordinator.complete('session-secret', { trigger: 'safety', partial: false });
    expect(mocks.logger.info).toHaveBeenCalledTimes(2);
    expect(mocks.logger.info.mock.calls[1]?.[0]).toBe(
      'checkpoint refresh state recovered',
    );
    expect(diagnostic('info', 1)).toMatchObject({
      state: 'healthy',
      previousState: 'failure:safety:provider-error:provider-error',
      transition: 'transition',
      durationMs: 1,
    });

    coordinator.complete('session-secret', { trigger: 'safety', partial: false });
    expect(mocks.logger.info).toHaveBeenCalledTimes(2);
  });

  it('distinguishes progressing and stalled partial refreshes from allowlisted failures', () => {
    let now = 0;
    const coordinator = new CheckpointRefreshDiagnosticCoordinator(() => now);

    coordinator.begin('partial-secret', 'normal', now);
    now = 100;
    coordinator.complete('partial-secret', {
      trigger: 'normal',
      partial: true,
      progress: {
        previousCheckpointRevision: 10,
        checkpointThroughRevision: 50,
        captureRevision: 100,
      },
    });
    expect(diagnostic('info')).toMatchObject({
      state: 'partial-progress:normal',
      previousState: null,
      transition: 'initial',
      durationMs: 100,
      progressedRevisionCount: 40,
      remainingRevisionCount: 50,
    });
    expect(mocks.logger.warn).not.toHaveBeenCalled();

    now = 200;
    coordinator.begin('partial-secret', 'safety', now);
    now = 300;
    coordinator.fail('partial-secret', {
      trigger: 'safety',
      category: 'timeout',
      reason: 'timeout',
    });
    expect(diagnostic('warn')).toMatchObject({
      state: 'failure:safety:timeout:timeout',
      previousState: 'partial-progress:normal',
      transition: 'transition',
      durationMs: 100,
    });

    now = 400;
    coordinator.fail('snapshot-secret', {
      trigger: 'snapshot',
      category: 'snapshot-error',
      reason: 'unclassified',
    });
    expect(diagnostic('warn', 1)).toMatchObject({
      state: 'failure:snapshot:snapshot-error:unclassified',
      previousState: null,
      durationMs: null,
    });

    now = 500;
    coordinator.begin('stalled-secret', 'normal', now);
    now = 600;
    coordinator.complete('stalled-secret', {
      trigger: 'normal',
      partial: true,
      progress: {
        previousCheckpointRevision: 50,
        checkpointThroughRevision: 50,
        captureRevision: 100,
      },
    });
    expect(diagnostic('warn', 2)).toMatchObject({
      state: 'partial-stalled:normal',
      progressedRevisionCount: 0,
      remainingRevisionCount: 50,
    });
  });

  it('silences repeats and emits one capped five-minute summary with max duration', () => {
    let now = 0;
    const coordinator = new CheckpointRefreshDiagnosticCoordinator(() => now);
    coordinator.begin('repeat-secret', 'safety', now);
    now = 100;
    coordinator.fail('repeat-secret', {
      trigger: 'safety',
      category: 'provider-error',
      reason: 'provider-error',
    });

    for (let index = 0; index < 10_000; index += 1) {
      coordinator.fail('repeat-secret', {
        trigger: 'safety',
        category: 'provider-error',
        reason: 'provider-error',
      });
    }
    expect(mocks.logger.warn).toHaveBeenCalledOnce();

    now = 100 + SUMMARY_INTERVAL_MS;
    coordinator.fail('repeat-secret', {
      trigger: 'safety',
      category: 'provider-error',
      reason: 'provider-error',
    });
    expect(mocks.logger.warn).toHaveBeenCalledTimes(2);
    expect(mocks.logger.warn.mock.calls[1]?.[0]).toBe(
      'checkpoint refresh state remains degraded',
    );
    expect(diagnostic('warn', 1)).toMatchObject({
      state: 'failure:safety:provider-error:provider-error',
      previousState: 'failure:safety:provider-error:provider-error',
      transition: 'periodic-summary',
      observationWindowMs: SUMMARY_INTERVAL_MS,
      suppressedCount: 9_999,
      suppressedCountCapped: true,
      maxDurationMs: 100,
    });
  });

  it('bounds session state to 256 deterministic LRU entries', () => {
    const coordinator = new CheckpointRefreshDiagnosticCoordinator(() => 1_000);
    for (let index = 0; index < 256; index += 1) {
      coordinator.fail(`session-${index}`, {
        trigger: 'normal',
        category: 'refresh-error',
        reason: 'unclassified',
      });
    }
    expect(mocks.logger.warn).toHaveBeenCalledTimes(256);

    coordinator.fail('session-0', {
      trigger: 'normal',
      category: 'refresh-error',
      reason: 'unclassified',
    });
    coordinator.fail('session-256', {
      trigger: 'normal',
      category: 'refresh-error',
      reason: 'unclassified',
    });
    coordinator.fail('session-1', {
      trigger: 'normal',
      category: 'refresh-error',
      reason: 'unclassified',
    });
    expect(mocks.logger.warn).toHaveBeenCalledTimes(258);
    expect(diagnostic('warn', 257)).toMatchObject({
      previousState: null,
      transition: 'initial',
    });
  });

  it('drops raw keys and unknown classifier text and contains sink/clock failures', () => {
    let clock: number | 'throw' = 1_000;
    const coordinator = new CheckpointRefreshDiagnosticCoordinator(() => {
      if (clock === 'throw') throw new Error('clock secret');
      return clock;
    });
    mocks.logger.warn.mockImplementationOnce(() => {
      throw new Error('sink secret');
    });

    expect(() => coordinator.fail('session /Users/private token=secret', {
      trigger: 'safety',
      category: 'provider payload private-category',
      reason: 'https://example.test/?token=secret',
    })).not.toThrow();
    const emitted = JSON.stringify(mocks.logger.warn.mock.calls);
    for (const forbidden of [
      '/Users/private',
      'token=secret',
      'private-category',
      'example.test',
      'session ',
      'sink secret',
    ]) {
      expect(emitted).not.toContain(forbidden);
    }

    clock = 'throw';
    expect(() => coordinator.fail('session', {
      trigger: 'normal',
      category: 'refresh-error',
      reason: 'unclassified',
    })).not.toThrow();
    clock = Number.NaN;
    coordinator.fail('session', {
      trigger: 'normal',
      category: 'refresh-error',
      reason: 'unclassified',
    });
    expect(mocks.logger.warn).toHaveBeenCalledOnce();

    clock = 500;
    coordinator.fail('session', {
      trigger: 'normal',
      category: 'refresh-error',
      reason: 'unclassified',
    });
    expect(mocks.logger.warn).toHaveBeenCalledOnce();
    expect(mocks.logger.info).not.toHaveBeenCalled();

    clock = 501;
    coordinator.fail('session', {
      trigger: 'normal',
      category: 'refresh-error',
      reason: 'unclassified',
    });
    expect(mocks.logger.warn).toHaveBeenCalledTimes(2);
    expect(diagnostic('warn', 1)).toMatchObject({
      previousState: null,
      transition: 'initial',
    });

    clock = 600;
    coordinator.fail('invalid-timing', {
      trigger: 'normal',
      category: 'refresh-error',
      reason: 'unclassified',
    });
    coordinator.begin('invalid-timing', 'normal', Number.NaN);
    clock = 601;
    coordinator.complete('invalid-timing', { trigger: 'normal', partial: false });
    expect(mocks.logger.info).not.toHaveBeenCalled();
  });
});
