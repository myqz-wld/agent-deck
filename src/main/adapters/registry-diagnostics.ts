import {
  BoundedLogStateTracker,
  type LogStateDecision,
  type LogStateSnapshot,
} from '@main/utils/log-state-tracker';
import log from '@main/utils/logger';
import { getProcessRunId } from '@main/utils/run-context';
import { safeDiagnostic } from '@main/utils/safe-diagnostic';
import type {
  AdapterRegistryDiagnosticPort,
  AdapterRegistryOperation,
} from './registry-core';

const TRACKER_CAPACITY = 2;
const SUMMARY_INTERVAL_MS = 300_000;
const MAX_DIAGNOSTIC_COUNT = 10_000;
const MAX_NUMERIC_VALUE = Number.MAX_SAFE_INTEGER;
type RegistryState = 'healthy' | 'slow' | 'partial-failure' | 'failed';

const THRESHOLD_BY_OPERATION: Record<AdapterRegistryOperation, number> = {
  init: 10_000,
  shutdown: 5_000,
};

function createLogger() {
  try {
    return log.scope('adapter-registry');
  } catch {
    return null;
  }
}

const logger = createLogger();

function readClock(): number | null {
  try {
    const value = Date.now();
    if (!Number.isFinite(value) || value < 0) return null;
    return Math.min(MAX_NUMERIC_VALUE, value);
  } catch {
    return null;
  }
}

function classifyState(
  totalCount: number,
  failedCount: number,
  durationMs: number | null,
  thresholdMs: number,
): RegistryState {
  if (totalCount === 0) return 'healthy';
  if (failedCount >= totalCount) return 'failed';
  if (failedCount > 0) return 'partial-failure';
  if (durationMs !== null && durationMs >= thresholdMs) return 'slow';
  return 'healthy';
}

function boundedCount(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(MAX_DIAGNOSTIC_COUNT, Math.floor(value));
}

function emitDecision(
  decision: LogStateDecision<RegistryState>,
  phase: AdapterRegistryOperation,
  durationMs: number | null,
  thresholdMs: number,
  totalCount: number,
  failedCount: number,
): void {
  if (decision.kind === 'repeat') return;
  if (decision.kind === 'initial' && !decision.current.abnormal) return;
  const prior: LogStateSnapshot<RegistryState> | null =
    decision.flushed?.abnormal ? decision.flushed : null;
  if (!decision.current.abnormal && !prior) return;
  const aggregate = decision.kind === 'periodic-summary'
    ? prior ?? decision.current
    : decision.current.abnormal
      ? decision.current
      : prior ?? decision.current;
  const suppressed = prior ?? decision.current;

  try {
    const details = safeDiagnostic({
      event: 'adapter-registry-state',
      runId: getProcessRunId(),
      phase,
      state: decision.current.signature,
      previousState: decision.flushed?.signature ?? null,
      transition: decision.kind,
      durationMs,
      abnormalDuration: aggregate.abnormalDurationMs,
      maxDuration: aggregate.maxMetric,
      thresholdMs,
      suppressedCount: suppressed.suppressedCount,
      capped: suppressed.suppressedCountCapped,
      summaryInterval: SUMMARY_INTERVAL_MS,
      totalCount: boundedCount(totalCount),
      failedCount: boundedCount(failedCount),
    });
    if (decision.current.abnormal) {
      logger?.warn(
        decision.kind === 'periodic-summary'
          ? 'adapter registry phase remains degraded'
          : 'adapter registry phase degraded',
        details,
      );
    } else {
      logger?.info('adapter registry phase recovered', details);
    }
  } catch {
    // Serialization, run identity, and sinks are all best-effort.
  }
}

export class DesktopAdapterRegistryDiagnostics implements AdapterRegistryDiagnosticPort {
  private readonly tracker = this.createTracker();

  begin(): number | null {
    return readClock();
  }

  observe(
    phase: AdapterRegistryOperation,
    totalCount: number,
    failedCount: number,
    startedAtMs: number | null,
  ): void {
    try {
      if (!this.tracker) return;
      const endedAtMs = readClock();
      const durationMs = startedAtMs === null || endedAtMs === null || endedAtMs < startedAtMs
        ? null
        : Math.min(MAX_NUMERIC_VALUE, endedAtMs - startedAtMs);
      const thresholdMs = THRESHOLD_BY_OPERATION[phase];
      const state = classifyState(totalCount, failedCount, durationMs, thresholdMs);
      const decision = this.tracker.observe(phase, {
        signature: state,
        abnormal: state !== 'healthy',
        metric: durationMs,
      });
      emitDecision(decision, phase, durationMs, thresholdMs, totalCount, failedCount);
    } catch {
      // Diagnostics cannot change adapter results or execution order.
    }
  }

  private createTracker(): BoundedLogStateTracker<AdapterRegistryOperation, RegistryState> | null {
    try {
      return new BoundedLogStateTracker({
        capacity: TRACKER_CAPACITY,
        summaryIntervalMs: SUMMARY_INTERVAL_MS,
        now: () => Date.now(),
      });
    } catch {
      return null;
    }
  }
}
