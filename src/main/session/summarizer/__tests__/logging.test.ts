import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  diagnosticMode: 'normal' as 'normal' | 'throw',
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
  getProcessRunId: () => 'summarizer-test-run',
}));
vi.mock('@main/utils/safe-diagnostic', () => ({
  safeDiagnostic: (value: unknown) => {
    if (mocks.diagnosticMode === 'throw') {
      throw new Error('safe diagnostic secret');
    }
    return value;
  },
}));

import { SummarizerDiagnosticCoordinator } from '../logging';

const SLOW_THRESHOLD_MS = 30_000;
const SUMMARY_INTERVAL_MS = 5 * 60_000;

function diagnostic(level: 'info' | 'warn', index = 0): Record<string, unknown> {
  return mocks.logger[level].mock.calls[index]?.[1] as Record<string, unknown>;
}

beforeEach(() => {
  mocks.diagnosticMode = 'normal';
  for (const method of Object.values(mocks.logger)) method.mockReset();
});

describe('SummarizerDiagnosticCoordinator', () => {
  it('keeps fast success silent, warns at the exact slow threshold, and recovers once', () => {
    let now = 0;
    const coordinator = new SummarizerDiagnosticCoordinator(() => now);

    const fastStartedAt = coordinator.begin();
    now = SLOW_THRESHOLD_MS - 1;
    coordinator.observeSuccess('session secret', fastStartedAt);
    expect(mocks.logger.warn).not.toHaveBeenCalled();
    expect(mocks.logger.info).not.toHaveBeenCalled();

    now = 40_000;
    const slowStartedAt = coordinator.begin();
    now += SLOW_THRESHOLD_MS;
    coordinator.observeSuccess('session secret', slowStartedAt);
    expect(mocks.logger.warn).toHaveBeenCalledOnce();
    expect(mocks.logger.warn.mock.calls[0]?.[0]).toBe(
      'summarizer state degraded',
    );
    expect(diagnostic('warn')).toEqual({
      event: 'summarizer-state',
      runId: 'summarizer-test-run',
      state: 'slow-success',
      previousState: 'healthy',
      transition: 'transition',
      durationMs: SLOW_THRESHOLD_MS,
      abnormalDurationMs: 0,
      suppressedCount: 0,
      suppressedCountCapped: false,
      maxDurationMs: SLOW_THRESHOLD_MS,
      slowThresholdMs: SLOW_THRESHOLD_MS,
      summaryIntervalMs: SUMMARY_INTERVAL_MS,
    });

    now += 1_000;
    const recoveryStartedAt = coordinator.begin();
    now += 1;
    coordinator.observeSuccess('session secret', recoveryStartedAt);
    expect(mocks.logger.info).toHaveBeenCalledOnce();
    expect(mocks.logger.info.mock.calls[0]?.[0]).toBe(
      'summarizer state recovered',
    );
    expect(diagnostic('info')).toMatchObject({
      state: 'healthy',
      previousState: 'slow-success',
      durationMs: 1,
      maxDurationMs: SLOW_THRESHOLD_MS,
    });

    coordinator.observeSuccess('session secret', null);
    expect(mocks.logger.info).toHaveBeenCalledOnce();
  });

  it('uses fixed transient and permanent failure signatures', () => {
    let now = 0;
    const coordinator = new SummarizerDiagnosticCoordinator(() => now);

    const timeoutStartedAt = coordinator.begin();
    now = 100;
    coordinator.observeTransientFailure(
      'session secret',
      new Error('__summarizer_timeout__'),
      timeoutStartedAt,
    );
    expect(diagnostic('warn')).toMatchObject({
      state: 'transient-failure:timeout',
      previousState: null,
      durationMs: 100,
    });

    now = 200;
    const abortedStartedAt = coordinator.begin();
    now = 210;
    coordinator.observeTransientFailure(
      'session secret',
      Object.assign(new Error('private abort detail'), { name: 'AbortError' }),
      abortedStartedAt,
    );
    expect(diagnostic('warn', 1)).toMatchObject({
      state: 'transient-failure:aborted',
      previousState: 'transient-failure:timeout',
      transition: 'transition',
    });

    now = 300;
    coordinator.observeTransientFailure(
      'session secret',
      new Error('unexpected provider payload https://example.test/?token=secret'),
      null,
    );
    expect(diagnostic('warn', 2)).toMatchObject({
      state: 'transient-failure:provider-error',
      previousState: 'transient-failure:aborted',
      durationMs: null,
    });

    coordinator.observeProviderCapabilityFailure(
      'codex-cli:https://provider.test/?token=secret',
      null,
    );
    expect(diagnostic('warn', 3)).toMatchObject({
      state: 'provider-capability-failure',
      previousState: null,
      durationMs: null,
    });

    const emitted = JSON.stringify(mocks.logger.warn.mock.calls);
    for (const forbidden of [
      'session secret',
      'private abort detail',
      'example.test',
      'provider.test',
      'token=secret',
      'codex-cli:',
    ]) {
      expect(emitted).not.toContain(forbidden);
    }
  });

  it('silences repeats and emits one capped five-minute summary with max duration', () => {
    let now = 0;
    const coordinator = new SummarizerDiagnosticCoordinator(() => now);
    const startedAt = coordinator.begin();
    now = 100;
    coordinator.observeTransientFailure(
      'repeat session',
      new Error('provider failure'),
      startedAt,
    );

    for (let index = 0; index < 10_000; index += 1) {
      coordinator.observeTransientFailure(
        'repeat session',
        new Error('different raw provider text'),
        null,
      );
    }
    expect(mocks.logger.warn).toHaveBeenCalledOnce();

    now = 100 + SUMMARY_INTERVAL_MS;
    coordinator.observeTransientFailure(
      'repeat session',
      new Error('another raw provider message'),
      null,
    );
    expect(mocks.logger.warn).toHaveBeenCalledTimes(2);
    expect(mocks.logger.warn.mock.calls[1]?.[0]).toBe(
      'summarizer state remains degraded',
    );
    expect(diagnostic('warn', 1)).toMatchObject({
      state: 'transient-failure:provider-error',
      previousState: 'transient-failure:provider-error',
      transition: 'periodic-summary',
      abnormalDurationMs: SUMMARY_INTERVAL_MS,
      suppressedCount: 9_999,
      suppressedCountCapped: true,
      maxDurationMs: 100,
    });
  });

  it('bounds correlation state to 256 deterministic LRU entries', () => {
    const coordinator = new SummarizerDiagnosticCoordinator(() => 1_000);
    for (let index = 0; index < 256; index += 1) {
      coordinator.observeUnexpectedFailure(`session-${index}`, null);
    }
    expect(mocks.logger.warn).toHaveBeenCalledTimes(256);

    coordinator.observeUnexpectedFailure('session-0', null);
    coordinator.observeUnexpectedFailure('session-256', null);
    coordinator.observeUnexpectedFailure('session-1', null);
    expect(mocks.logger.warn).toHaveBeenCalledTimes(258);
    expect(diagnostic('warn', 257)).toMatchObject({
      previousState: null,
      transition: 'initial',
    });
  });

  it('forgets deleted or renamed session state without manufacturing recovery', () => {
    const coordinator = new SummarizerDiagnosticCoordinator(() => 1_000);
    coordinator.observeUnexpectedFailure('old session', null);
    coordinator.forgetSession('old session');
    coordinator.observeUnexpectedFailure('old session', null);

    expect(mocks.logger.warn).toHaveBeenCalledTimes(2);
    expect(diagnostic('warn', 1)).toMatchObject({
      state: 'transient-failure:internal-error',
      previousState: null,
      transition: 'initial',
    });
    expect(mocks.logger.info).not.toHaveBeenCalled();
  });

  it('drops secrets and contains logger, serializer, and clock failures', () => {
    let clock: number | 'throw' = 1_000;
    const coordinator = new SummarizerDiagnosticCoordinator(() => {
      if (clock === 'throw') throw new Error('clock secret');
      return clock;
    });
    mocks.logger.warn.mockImplementationOnce(() => {
      throw new Error('logger sink secret');
    });

    expect(() => coordinator.observeTransientFailure(
      'session /Users/private token=secret',
      new Error('provider payload https://example.test/?token=secret'),
      null,
    )).not.toThrow();
    const emitted = JSON.stringify(mocks.logger.warn.mock.calls);
    for (const forbidden of [
      '/Users/private',
      'token=secret',
      'example.test',
      'provider payload',
      'logger sink secret',
    ]) {
      expect(emitted).not.toContain(forbidden);
    }

    mocks.diagnosticMode = 'throw';
    expect(() => coordinator.observeUnexpectedFailure('serializer session', null))
      .not.toThrow();
    expect(mocks.logger.warn).toHaveBeenCalledOnce();
    mocks.diagnosticMode = 'normal';

    clock = 'throw';
    const invalidStartedAt = coordinator.begin();
    coordinator.observeUnexpectedFailure('clock session', null);
    clock = Number.NaN;
    coordinator.observeUnexpectedFailure('clock session', null);
    expect(mocks.logger.warn).toHaveBeenCalledOnce();

    clock = 1_001;
    coordinator.observeSuccess(
      'session /Users/private token=secret',
      invalidStartedAt,
    );
    expect(mocks.logger.info).not.toHaveBeenCalled();

    clock = 500;
    coordinator.observeUnexpectedFailure('clock session', null);
    expect(mocks.logger.warn).toHaveBeenCalledOnce();
    clock = 501;
    coordinator.observeUnexpectedFailure('clock session', null);
    expect(mocks.logger.warn).toHaveBeenCalledTimes(2);
    expect(diagnostic('warn', 1)).toMatchObject({
      previousState: null,
      transition: 'initial',
    });
  });
});
