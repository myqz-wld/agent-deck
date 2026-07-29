import {
  BoundedLogStateTracker,
  type LogStateDecision,
  type LogStateSnapshot,
} from '@main/utils/log-state-tracker';
import log from '@main/utils/logger';
import { getProcessRunId } from '@main/utils/run-context';
import { safeDiagnostic } from '@main/utils/safe-diagnostic';

const logger = log.scope('session-summarizer');

const MAX_CORRELATION_ENTRIES = 256;
export const SUMMARIZER_SLOW_THRESHOLD_MS = 30_000;
export const SUMMARIZER_SUMMARY_INTERVAL_MS = 5 * 60_000;
const MAX_NUMERIC_VALUE = Number.MAX_SAFE_INTEGER;

type TransientFailureCategory =
  | 'timeout'
  | 'aborted'
  | 'provider-error'
  | 'internal-error';
type SummarizerDiagnosticState =
  | 'healthy'
  | 'slow-success'
  | `transient-failure:${TransientFailureCategory}`
  | 'provider-capability-failure';

const TIMEOUT_MESSAGES = new Set([
  '__summarizer_timeout__',
  '__codex_summarizer_timeout__',
  '__grok_summarizer_timeout__',
]);

/**
 * Bounded state-transition diagnostics for periodic summarization. Raw session/provider keys are
 * used only by the tracker and never enter returned snapshots or emitted payloads.
 */
export class SummarizerDiagnosticCoordinator {
  private readonly tracker: BoundedLogStateTracker<
    string,
    SummarizerDiagnosticState
  >;
  private lastClockMs: number | null = null;
  private clockMs = 0;

  constructor(private readonly now: () => number = Date.now) {
    this.tracker = new BoundedLogStateTracker({
      capacity: MAX_CORRELATION_ENTRIES,
      summaryIntervalMs: SUMMARIZER_SUMMARY_INTERVAL_MS,
      now: () => this.clockMs,
    });
  }

  begin(): number | null {
    try {
      return this.readClock();
    } catch {
      return null;
    }
  }

  observeSuccess(sessionId: string, startedAtMs: number | null): void {
    try {
      const current = this.readClock();
      if (current === null) return;
      const durationMs = measuredDuration(startedAtMs, current);
      if (durationMs === null) return;
      const state: SummarizerDiagnosticState =
        durationMs >= SUMMARIZER_SLOW_THRESHOLD_MS
          ? 'slow-success'
          : 'healthy';
      this.observe(sessionCorrelationKey(sessionId), state, state !== 'healthy', durationMs);
    } catch {
      // Diagnostics cannot affect UI error state, results, persistence, or cleanup.
    }
  }

  observeTransientFailure(
    sessionId: string,
    error: unknown,
    startedAtMs: number | null,
  ): void {
    try {
      const current = this.readClock();
      if (current === null) return;
      const category = classifyTransientFailure(error);
      this.observe(
        sessionCorrelationKey(sessionId),
        `transient-failure:${category}`,
        true,
        measuredDuration(startedAtMs, current),
      );
    } catch {
      // Diagnostics cannot affect raw UI error preservation or fallback behavior.
    }
  }

  observeUnexpectedFailure(
    sessionId: string,
    startedAtMs: number | null,
  ): void {
    try {
      const current = this.readClock();
      if (current === null) return;
      this.observe(
        sessionCorrelationKey(sessionId),
        'transient-failure:internal-error',
        true,
        measuredDuration(startedAtMs, current),
      );
    } catch {
      // Diagnostics cannot affect persistence errors or in-flight cleanup.
    }
  }

  observeProviderCapabilityFailure(
    providerKey: string,
    startedAtMs: number | null,
  ): void {
    try {
      const current = this.readClock();
      if (current === null) return;
      this.observe(
        providerCorrelationKey(providerKey),
        'provider-capability-failure',
        true,
        measuredDuration(startedAtMs, current),
      );
    } catch {
      // Diagnostics cannot affect the process-lifetime provider capability circuit.
    }
  }

  forgetSession(sessionId: string): void {
    try {
      this.tracker.forget(sessionCorrelationKey(sessionId));
    } catch {
      // Diagnostics are best-effort.
    }
  }

  reset(): void {
    try {
      this.tracker.clear();
      this.lastClockMs = null;
      this.clockMs = 0;
    } catch {
      // Diagnostics are best-effort.
    }
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
      this.tracker.clear();
      this.lastClockMs = bounded;
      this.clockMs = bounded;
      return null;
    }
    this.lastClockMs = bounded;
    this.clockMs = bounded;
    return bounded;
  }

  private observe(
    key: string,
    state: SummarizerDiagnosticState,
    abnormal: boolean,
    durationMs: number | null,
  ): void {
    let decision: LogStateDecision<SummarizerDiagnosticState>;
    try {
      decision = this.tracker.observe(key, {
        signature: state,
        abnormal,
        metric: durationMs,
      });
    } catch {
      this.tracker.forget(key);
      return;
    }
    emitDecision(decision, durationMs);
  }
}

function emitDecision(
  decision: LogStateDecision<SummarizerDiagnosticState>,
  durationMs: number | null,
): void {
  if (decision.kind === 'repeat') return;
  if (decision.kind === 'initial' && !decision.current.abnormal) return;

  const priorAbnormal: LogStateSnapshot<SummarizerDiagnosticState> | null =
    decision.flushed?.abnormal ? decision.flushed : null;
  const aggregate =
    decision.kind === 'periodic-summary'
      ? priorAbnormal ?? decision.current
      : decision.current.abnormal
        ? decision.current
        : priorAbnormal ?? decision.current;
  const suppressed = priorAbnormal ?? decision.current;
  const details = safeDiagnostic({
    event: 'summarizer-state',
    runId: getProcessRunId(),
    state: decision.current.signature,
    previousState: decision.flushed?.signature ?? null,
    transition: decision.kind,
    durationMs,
    abnormalDurationMs: aggregate.abnormalDurationMs,
    suppressedCount: suppressed.suppressedCount,
    suppressedCountCapped: suppressed.suppressedCountCapped,
    maxDurationMs: aggregate.maxMetric,
    slowThresholdMs: SUMMARIZER_SLOW_THRESHOLD_MS,
    summaryIntervalMs: SUMMARIZER_SUMMARY_INTERVAL_MS,
  });

  try {
    if (decision.current.abnormal) {
      logger.warn(
        decision.kind === 'periodic-summary'
          ? 'summarizer state remains degraded'
          : 'summarizer state degraded',
        details,
      );
    } else if (priorAbnormal) {
      logger.info('summarizer state recovered', details);
    }
  } catch {
    // Diagnostic sinks cannot affect summarizer behavior.
  }
}

function classifyTransientFailure(error: unknown): Exclude<
  TransientFailureCategory,
  'internal-error'
> {
  const name = readStringField(error, 'name');
  const code = readStringField(error, 'code');
  if (name === 'AbortError' || code === 'ABORT_ERR') return 'aborted';
  const message = readStringField(error, 'message');
  if (
    code === 'ETIMEDOUT' ||
    (message !== null && TIMEOUT_MESSAGES.has(message))
  ) {
    return 'timeout';
  }
  return 'provider-error';
}

function readStringField(
  value: unknown,
  field: 'name' | 'code' | 'message',
): string | null {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) {
    return null;
  }
  try {
    const candidate = (value as Record<string, unknown>)[field];
    return typeof candidate === 'string' ? candidate : null;
  } catch {
    return null;
  }
}

function sessionCorrelationKey(sessionId: string): string {
  return `session\u0000${sessionId}`;
}

function providerCorrelationKey(providerKey: string): string {
  return `provider\u0000${providerKey}`;
}

function measuredDuration(startedAtMs: number | null, current: number): number | null {
  if (
    startedAtMs === null ||
    !Number.isFinite(startedAtMs) ||
    startedAtMs < 0 ||
    startedAtMs > current
  ) {
    return null;
  }
  return Math.min(MAX_NUMERIC_VALUE, current - startedAtMs);
}
