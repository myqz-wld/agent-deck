import { performance } from 'node:perf_hooks';

import {
  BoundedLogStateTracker,
  type LogStateDecision,
  type LogStateSnapshot,
} from '@main/utils/log-state-tracker';
import log from '@main/utils/logger';
import { getProcessRunId } from '@main/utils/run-context';
import { safeDiagnostic } from '@main/utils/safe-diagnostic';

const logger = log.scope('main-event-loop');

const DEFAULT_SAMPLE_INTERVAL_MS = 250;
const DEFAULT_WARN_THRESHOLD_MS = 500;
const DEFAULT_SUSPEND_THRESHOLD_MS = 60_000;
const SUMMARY_INTERVAL_MS = 60_000;
const HEALTHY_SAMPLES_TO_RECOVER = 4;
const TRACKER_KEY = 'main-event-loop';
const MAX_NUMERIC_VALUE = Number.MAX_SAFE_INTEGER;

type EventLoopMonitorState = 'healthy' | 'lagging';

interface EventLoopPowerMonitor {
  on(event: 'resume' | 'suspend', listener: () => void): unknown;
  removeListener(event: 'resume' | 'suspend', listener: () => void): unknown;
}

interface EventLoopMonitorOptions {
  sampleIntervalMs?: number;
  warnThresholdMs?: number;
  suspendThresholdMs?: number;
  now?: () => number;
  powerMonitor?: EventLoopPowerMonitor;
}

interface EventLoopDiagnosticContext {
  sampleIntervalMs: number;
  warnThresholdMs: number;
  suspendThresholdMs: number;
}

/**
 * Monitor Electron's main event-loop drift so rare global stalls can be separated from slow
 * MCP handlers or SQLite writes. Suspend, invalid-clock, and rollback samples only rebase the
 * schedule; they do not advance the diagnostic state machine.
 */
export function startMainEventLoopMonitor(options: EventLoopMonitorOptions = {}): () => void {
  const sampleIntervalMs = positiveDuration(
    options.sampleIntervalMs,
    DEFAULT_SAMPLE_INTERVAL_MS,
  );
  const warnThresholdMs = nonnegativeDuration(
    options.warnThresholdMs,
    DEFAULT_WARN_THRESHOLD_MS,
  );
  const suspendThresholdMs = nonnegativeDuration(
    options.suspendThresholdMs,
    DEFAULT_SUSPEND_THRESHOLD_MS,
  );
  const now = options.now ?? (() => performance.now());
  const diagnosticContext = {
    sampleIntervalMs,
    warnThresholdMs,
    suspendThresholdMs,
  };

  let diagnosticClockMs = 0;
  let tracker = createTracker(() => diagnosticClockMs);
  let expectedAt: number | null = null;
  let lastClockAt: number | null = null;
  let degraded = false;
  let consecutiveHealthySamples = 0;
  let suspended = false;

  const rebaseSchedule = (): void => {
    const current = readClock(now);
    expectedAt = current === null ? null : boundedSum(current, sampleIntervalMs);
    lastClockAt = current;
    consecutiveHealthySamples = 0;
  };
  const handleSuspend = (): void => {
    suspended = true;
    expectedAt = null;
    lastClockAt = null;
    consecutiveHealthySamples = 0;
  };
  const handleResume = (): void => {
    suspended = false;
    rebaseSchedule();
  };

  rebaseSchedule();
  options.powerMonitor?.on('suspend', handleSuspend);
  options.powerMonitor?.on('resume', handleResume);

  const observe = (
    state: EventLoopMonitorState,
    abnormal: boolean,
    lagMs: number,
    recoveryHealthySamples: number,
  ): void => {
    let decision: LogStateDecision<EventLoopMonitorState>;
    try {
      decision = tracker.observe(TRACKER_KEY, {
        signature: state,
        abnormal,
        metric: roundedMetric(lagMs),
      });
    } catch {
      tracker = createTracker(() => diagnosticClockMs);
      return;
    }
    emitDecision(
      decision,
      lagMs,
      recoveryHealthySamples,
      diagnosticContext,
    );
  };

  const timer = setInterval(() => {
    if (suspended) return;
    const current = readClock(now);
    if (current === null) {
      expectedAt = null;
      lastClockAt = null;
      consecutiveHealthySamples = 0;
      return;
    }
    if (
      expectedAt === null ||
      lastClockAt === null ||
      current <= lastClockAt
    ) {
      expectedAt = boundedSum(current, sampleIntervalMs);
      lastClockAt = current;
      consecutiveHealthySamples = 0;
      return;
    }

    const elapsedMs = current - lastClockAt;
    const lagMs = Math.max(0, current - expectedAt);
    expectedAt = boundedSum(current, sampleIntervalMs);
    lastClockAt = current;

    if (lagMs >= suspendThresholdMs) {
      consecutiveHealthySamples = 0;
      return;
    }

    diagnosticClockMs = boundedSum(diagnosticClockMs, elapsedMs);
    if (lagMs >= warnThresholdMs) {
      degraded = true;
      consecutiveHealthySamples = 0;
      observe('lagging', true, lagMs, 0);
      return;
    }
    if (!degraded) return;

    consecutiveHealthySamples += 1;
    if (consecutiveHealthySamples < HEALTHY_SAMPLES_TO_RECOVER) return;
    degraded = false;
    observe('healthy', false, lagMs, consecutiveHealthySamples);
  }, sampleIntervalMs);
  timer.unref();

  return () => {
    clearInterval(timer);
    options.powerMonitor?.removeListener('suspend', handleSuspend);
    options.powerMonitor?.removeListener('resume', handleResume);
  };
}

function createTracker(
  now: () => number,
): BoundedLogStateTracker<typeof TRACKER_KEY, EventLoopMonitorState> {
  return new BoundedLogStateTracker({
    capacity: 1,
    summaryIntervalMs: SUMMARY_INTERVAL_MS,
    now,
  });
}

function emitDecision(
  decision: LogStateDecision<EventLoopMonitorState>,
  lagMs: number,
  recoveryHealthySamples: number,
  context: EventLoopDiagnosticContext,
): void {
  if (decision.kind === 'repeat') return;
  if (decision.kind === 'initial' && !decision.current.abnormal) return;

  const priorAbnormal: LogStateSnapshot<EventLoopMonitorState> | null =
    decision.flushed?.abnormal ? decision.flushed : null;
  const aggregate =
    decision.kind === 'periodic-summary'
      ? priorAbnormal ?? decision.current
      : decision.current.abnormal
        ? decision.current
        : priorAbnormal ?? decision.current;
  const details = safeDiagnostic({
    event: 'main-event-loop-state',
    runId: getProcessRunId(),
    state: decision.current.signature,
    previousState: decision.flushed?.signature ?? null,
    transition: decision.kind,
    abnormalDurationMs: aggregate.abnormalDurationMs,
    lagMs: roundedMetric(lagMs),
    maxLagMs: aggregate.maxMetric,
    suppressedCount: aggregate.suppressedCount,
    suppressedCountCapped: aggregate.suppressedCountCapped,
    sampleIntervalMs: context.sampleIntervalMs,
    lagThresholdMs: context.warnThresholdMs,
    suspendThresholdMs: context.suspendThresholdMs,
    recoveryHealthySamples,
    recoveryHealthySamplesRequired: HEALTHY_SAMPLES_TO_RECOVER,
  });

  if (decision.current.abnormal) {
    const message =
      decision.kind === 'periodic-summary'
        ? 'main event loop state remains degraded'
        : 'main event loop state degraded';
    try {
      logger.warn(message, details);
    } catch {
      // Diagnostics must never interrupt the sampling interval.
    }
    return;
  }
  if (!priorAbnormal) return;
  try {
    logger.info('main event loop state recovered', details);
  } catch {
    // Diagnostics must never interrupt the sampling interval.
  }
}

function readClock(now: () => number): number | null {
  try {
    const value = now();
    if (!Number.isFinite(value)) return null;
    return Math.min(MAX_NUMERIC_VALUE, Math.max(0, value));
  } catch {
    return null;
  }
}

function positiveDuration(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.min(MAX_NUMERIC_VALUE, value);
}

function nonnegativeDuration(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return Math.min(MAX_NUMERIC_VALUE, value);
}

function boundedSum(left: number, right: number): number {
  return Math.min(MAX_NUMERIC_VALUE, Math.max(0, left + right));
}

function roundedMetric(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.min(MAX_NUMERIC_VALUE, Math.round(value));
}
