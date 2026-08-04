import {
  BoundedLogStateTracker,
  type LogStateDecision,
  type LogStateSnapshot,
} from '@main/utils/log-state-tracker';
import log from '@main/utils/logger';
import { getProcessRunId } from '@main/utils/run-context';
import { safeDiagnostic } from '@main/utils/safe-diagnostic';
import { runScopedCorrelationId } from '@main/utils/runtime-correlation';
import type {
  CheckpointFoldFailureCategory,
  CheckpointFoldFailureReason,
} from './checkpoint-fold-failure';
import type { CheckpointRefreshTrigger } from './checkpoint-refresh-scheduler';

const logger = log.scope('checkpoint-refresh');

const MAX_SESSION_ENTRIES = 256;
export const CHECKPOINT_REFRESH_SLOW_THRESHOLD_MS = 30_000;
export const CHECKPOINT_REFRESH_SUMMARY_INTERVAL_MS = 5 * 60_000;
const MAX_NUMERIC_VALUE = Number.MAX_SAFE_INTEGER;
const TRACKER_KEY = 'checkpoint-refresh';

type DiagnosticTrigger = CheckpointRefreshTrigger | 'snapshot';
type DiagnosticCategory =
  | CheckpointFoldFailureCategory
  | 'incomplete-coverage'
  | 'refresh-error'
  | 'snapshot-error';
type DiagnosticReason =
  | CheckpointFoldFailureReason
  | 'fold-budget-or-call-limit';
type CheckpointRefreshDiagnosticState =
  | 'healthy'
  | `slow:${CheckpointRefreshTrigger}`
  | `partial-progress:${CheckpointRefreshTrigger}`
  | `partial-stalled:${CheckpointRefreshTrigger}`
  | `failure:${DiagnosticTrigger}:${DiagnosticCategory}:${DiagnosticReason}`;

interface RefreshProgressObservation {
  previousCheckpointRevision: number;
  checkpointThroughRevision: number;
  captureRevision: number;
}

interface RefreshProgressDetails {
  progressedRevisionCount: number;
  remainingRevisionCount: number;
}

interface SessionDiagnosticEntry {
  startedAtMs: number | null;
  trigger: CheckpointRefreshTrigger | null;
  tracker: BoundedLogStateTracker<
    typeof TRACKER_KEY,
    CheckpointRefreshDiagnosticState
  >;
}

interface FailureObservation {
  trigger: DiagnosticTrigger;
  category: unknown;
  reason: unknown;
}

const FAILURE_CATEGORIES = new Set<DiagnosticCategory>([
  'timeout',
  'aborted',
  'output-too-large',
  'schema-unsupported',
  'provider-error',
  'tool-use-observed',
  'checkpoint-validation',
  'checkpoint-commit',
  'internal-error',
  'incomplete-coverage',
  'refresh-error',
  'snapshot-error',
]);

const FAILURE_REASONS = new Set<DiagnosticReason>([
  'timeout',
  'aborted',
  'output-too-large',
  'schema-unsupported',
  'provider-error',
  'tool-use-observed',
  'invalid-json',
  'schema-invalid',
  'evidence-outside-current-delta',
  'coverage-marker-invariant',
  'canonical-capacity',
  'patch-no-op',
  'patch-target-invalid',
  'patch-semantic-invalid',
  'evidence-outside-allowlist',
  'active-fact-removed',
  'active-fact-changed-without-evidence',
  'duplicate-fact-id',
  'checkpoint-cas-conflict',
  'fold-budget-or-call-limit',
  'unclassified',
]);

/**
 * Owns bounded, content-free checkpoint refresh diagnostics. Raw session IDs are used only as
 * internal correlation keys and are never copied into a diagnostic payload.
 */
export class CheckpointRefreshDiagnosticCoordinator {
  private readonly entries = new Map<string, SessionDiagnosticEntry>();
  private lastClockMs: number | null = null;
  private clockMs = 0;

  constructor(private readonly now: () => number = Date.now) {}

  begin(
    sessionId: string,
    trigger: CheckpointRefreshTrigger,
    startedAt: number,
  ): void {
    try {
      const current = this.readClock();
      if (current === null) return;
      const entry = this.getOrCreateEntry(sessionId);
      entry.startedAtMs = validStartedAt(startedAt, current);
      entry.trigger = trigger;
    } catch {
      // Diagnostics cannot affect refresh execution or scheduling.
    }
  }

  complete(
    sessionId: string,
    input: {
      trigger: CheckpointRefreshTrigger;
      partial: boolean;
      progress?: RefreshProgressObservation;
    },
  ): void {
    try {
      const current = this.readClock();
      if (current === null) return;
      const entry = this.getExistingEntry(sessionId);
      if (!entry || entry.trigger !== input.trigger) return;
      const durationMs = measuredDuration(entry.startedAtMs, current);
      entry.startedAtMs = null;
      entry.trigger = null;
      if (durationMs === null && !input.partial) return;
      const progress = refreshProgressDetails(input.progress);
      const state: CheckpointRefreshDiagnosticState = input.partial
        ? progress && progress.progressedRevisionCount > 0
          ? `partial-progress:${input.trigger}`
          : `partial-stalled:${input.trigger}`
        : durationMs !== null && durationMs >= CHECKPOINT_REFRESH_SLOW_THRESHOLD_MS
          ? `slow:${input.trigger}`
          : 'healthy';
      this.observe(
        sessionId,
        entry,
        state,
        state.startsWith('failure:') || state.startsWith('partial-stalled:'),
        durationMs,
        progress,
      );
    } catch {
      // Diagnostics cannot affect refresh results, persistence, or scheduling.
    }
  }

  fail(sessionId: string, input: FailureObservation): void {
    try {
      const current = this.readClock();
      if (current === null) return;
      const entry = this.getOrCreateEntry(sessionId);
      const durationMs =
        input.trigger !== 'snapshot' && entry.trigger === input.trigger
          ? measuredDuration(entry.startedAtMs, current)
          : null;
      entry.startedAtMs = null;
      entry.trigger = null;
      const category = diagnosticCategory(input.category, input.trigger);
      const reason = diagnosticReason(input.reason);
      this.observe(
        sessionId,
        entry,
        `failure:${input.trigger}:${category}:${reason}`,
        true,
        durationMs,
        null,
      );
    } catch {
      // Diagnostics cannot affect handled failures, retry, or scheduling.
    }
  }

  forget(sessionId: string): void {
    try {
      this.entries.delete(sessionId);
    } catch {
      // Diagnostics are best-effort.
    }
  }

  reset(): void {
    this.entries.clear();
    this.lastClockMs = null;
    this.clockMs = 0;
  }

  private readClock(): number | null {
    let candidate: number;
    try {
      candidate = this.now();
    } catch {
      return null;
    }
    if (!Number.isFinite(candidate)) return null;
    const bounded = Math.min(MAX_NUMERIC_VALUE, Math.max(0, candidate));
    if (this.lastClockMs !== null && bounded < this.lastClockMs) {
      this.entries.clear();
      this.lastClockMs = bounded;
      this.clockMs = bounded;
      return null;
    }
    this.lastClockMs = bounded;
    this.clockMs = bounded;
    return bounded;
  }

  private getExistingEntry(sessionId: string): SessionDiagnosticEntry | null {
    const entry = this.entries.get(sessionId);
    if (!entry) return null;
    this.touch(sessionId, entry);
    return entry;
  }

  private getOrCreateEntry(sessionId: string): SessionDiagnosticEntry {
    const existing = this.getExistingEntry(sessionId);
    if (existing) return existing;
    if (this.entries.size >= MAX_SESSION_ENTRIES) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    const entry: SessionDiagnosticEntry = {
      startedAtMs: null,
      trigger: null,
      tracker: new BoundedLogStateTracker({
        capacity: 1,
        summaryIntervalMs: CHECKPOINT_REFRESH_SUMMARY_INTERVAL_MS,
        now: () => this.clockMs,
      }),
    };
    this.entries.set(sessionId, entry);
    return entry;
  }

  private touch(sessionId: string, entry: SessionDiagnosticEntry): void {
    this.entries.delete(sessionId);
    this.entries.set(sessionId, entry);
  }

  private observe(
    sessionId: string,
    entry: SessionDiagnosticEntry,
    state: CheckpointRefreshDiagnosticState,
    abnormal: boolean,
    durationMs: number | null,
    progress: RefreshProgressDetails | null,
  ): void {
    let decision: LogStateDecision<CheckpointRefreshDiagnosticState>;
    try {
      decision = entry.tracker.observe(TRACKER_KEY, {
        signature: state,
        abnormal,
        metric: durationMs,
      });
    } catch {
      this.entries.delete(sessionId);
      return;
    }
    emitDecision(sessionId, decision, durationMs, progress);
  }
}

function emitDecision(
  sessionId: string,
  decision: LogStateDecision<CheckpointRefreshDiagnosticState>,
  durationMs: number | null,
  progress: RefreshProgressDetails | null,
): void {
  if (decision.kind === 'repeat') return;
  const isSlow = decision.current.signature.startsWith('slow:');
  const isPartialProgress = decision.current.signature.startsWith('partial-progress:');
  if (
    decision.kind === 'initial' &&
    !decision.current.abnormal &&
    !isSlow &&
    !isPartialProgress
  ) return;

  const priorAbnormal: LogStateSnapshot<CheckpointRefreshDiagnosticState> | null =
    decision.flushed?.abnormal ? decision.flushed : null;
  const aggregate =
    decision.kind === 'periodic-summary'
      ? priorAbnormal ?? decision.current
      : decision.current.abnormal
        ? decision.current
        : priorAbnormal ?? decision.current;
  const suppressed = priorAbnormal ?? decision.current;
  const details = safeDiagnostic({
    event: 'checkpoint-refresh-state',
    runId: getProcessRunId(),
    sessionRef: runScopedCorrelationId('checkpoint', sessionId),
    state: decision.current.signature,
    previousState: decision.flushed?.signature ?? null,
    transition: decision.kind,
    durationMs,
    observationWindowMs: aggregate.stateDurationMs,
    suppressedCount: suppressed.suppressedCount,
    suppressedCountCapped: suppressed.suppressedCountCapped,
    maxDurationMs:
      isSlow || isPartialProgress ? durationMs : aggregate.maxMetric,
    ...(progress ?? {}),
    slowThresholdMs: CHECKPOINT_REFRESH_SLOW_THRESHOLD_MS,
    summaryIntervalMs: CHECKPOINT_REFRESH_SUMMARY_INTERVAL_MS,
  });

  try {
    if (decision.current.abnormal) {
      logger.warn(
        decision.kind === 'periodic-summary'
          ? 'checkpoint refresh state remains degraded'
          : 'checkpoint refresh state degraded',
        details,
      );
    } else if (priorAbnormal) {
      logger.info('checkpoint refresh state recovered', details);
    } else if (isPartialProgress) {
      logger.info('checkpoint refresh made partial progress', details);
    } else if (isSlow) {
      logger.info('checkpoint refresh completed slowly', details);
    }
  } catch {
    // Diagnostic sinks cannot affect checkpoint refresh behavior.
  }
}

function diagnosticCategory(
  value: unknown,
  trigger: DiagnosticTrigger,
): DiagnosticCategory {
  if (typeof value === 'string' && FAILURE_CATEGORIES.has(value as DiagnosticCategory)) {
    return value as DiagnosticCategory;
  }
  return trigger === 'snapshot' ? 'snapshot-error' : 'refresh-error';
}

function diagnosticReason(value: unknown): DiagnosticReason {
  return typeof value === 'string' && FAILURE_REASONS.has(value as DiagnosticReason)
    ? value as DiagnosticReason
    : 'unclassified';
}

function validStartedAt(value: number, current: number): number | null {
  if (!Number.isFinite(value) || value < 0 || value > current) return null;
  return Math.min(MAX_NUMERIC_VALUE, value);
}

function measuredDuration(startedAtMs: number | null, current: number): number | null {
  if (startedAtMs === null) return null;
  const elapsed = current - startedAtMs;
  if (!Number.isFinite(elapsed) || elapsed < 0) return null;
  return Math.min(MAX_NUMERIC_VALUE, elapsed);
}

function refreshProgressDetails(
  progress: RefreshProgressObservation | undefined,
): RefreshProgressDetails | null {
  if (!progress) return null;
  const previous = validRevision(progress.previousCheckpointRevision);
  const through = validRevision(progress.checkpointThroughRevision);
  const capture = validRevision(progress.captureRevision);
  if (previous === null || through === null || capture === null) return null;
  return {
    progressedRevisionCount: Math.max(0, through - previous),
    remainingRevisionCount: Math.max(0, capture - through),
  };
}

function validRevision(value: number): number | null {
  if (!Number.isSafeInteger(value) || value < 0) return null;
  return value;
}
