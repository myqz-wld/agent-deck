export type LogStateDecisionKind =
  | 'initial'
  | 'transition'
  | 'repeat'
  | 'periodic-summary';

export interface LogStateObservation<Signature extends string> {
  signature: Signature;
  abnormal: boolean;
  metric?: number | null;
}

export interface LogStateSnapshot<Signature extends string> {
  signature: Signature;
  abnormal: boolean;
  stateDurationMs: number;
  abnormalDurationMs: number | null;
  suppressedCount: number;
  suppressedCountCapped: boolean;
  maxMetric: number | null;
}

export interface LogStateDecision<Signature extends string> {
  kind: LogStateDecisionKind;
  /**
   * The state after this observation. For a periodic summary, suppression counters have already
   * been reset for the next window.
   */
  current: LogStateSnapshot<Signature>;
  /**
   * The aggregate a caller may emit. Transitions flush the previous state; periodic summaries
   * flush the continuing abnormal state. Initial/repeat decisions do not flush an aggregate.
   */
  flushed: LogStateSnapshot<Signature> | null;
}

export interface BoundedLogStateTrackerOptions {
  capacity?: number;
  summaryIntervalMs?: number;
  maxSuppressedCount?: number;
  now?: () => number;
}

interface TrackedState<Signature extends string> {
  signature: Signature;
  abnormal: boolean;
  stateStartedAtMs: number;
  abnormalStartedAtMs: number | null;
  lastEmissionAtMs: number;
  suppressedCount: number;
  suppressedCountCapped: boolean;
  maxMetric: number | null;
}

const DEFAULT_CAPACITY = 256;
const MAX_CAPACITY = 10_000;
const DEFAULT_SUMMARY_INTERVAL_MS = 60_000;
const DEFAULT_MAX_SUPPRESSED_COUNT = 9_999;
const MAX_SUPPRESSED_COUNT = 1_000_000;
const MAX_NUMERIC_VALUE = Number.MAX_SAFE_INTEGER;

/**
 * Pure per-key state-transition tracker for bounded, rate-limited diagnostics.
 *
 * Keys are retained only for internal correlation. The returned decisions contain signatures and
 * numeric aggregates, never the key itself, so callers cannot accidentally persist raw IDs.
 */
export class BoundedLogStateTracker<Key, Signature extends string> {
  private readonly capacity: number;
  private readonly summaryIntervalMs: number;
  private readonly maxSuppressedCount: number;
  private readonly now: () => number;
  private readonly states = new Map<Key, TrackedState<Signature>>();
  private lastNowMs = 0;

  constructor(options: BoundedLogStateTrackerOptions = {}) {
    this.capacity = boundedInteger(options.capacity, DEFAULT_CAPACITY, MAX_CAPACITY);
    this.summaryIntervalMs = boundedDuration(
      options.summaryIntervalMs,
      DEFAULT_SUMMARY_INTERVAL_MS,
    );
    this.maxSuppressedCount = boundedInteger(
      options.maxSuppressedCount,
      DEFAULT_MAX_SUPPRESSED_COUNT,
      MAX_SUPPRESSED_COUNT,
    );
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    return this.states.size;
  }

  observe(
    key: Key,
    observation: LogStateObservation<Signature>,
  ): LogStateDecision<Signature> {
    const nowMs = this.currentTime();
    const metric = normalizedMetric(observation.metric);
    const existing = this.states.get(key);

    if (!existing) {
      this.evictIfFull();
      const initial = this.createInitialState(observation, metric, nowMs);
      this.states.set(key, initial);
      return {
        kind: 'initial',
        current: snapshot(initial, nowMs),
        flushed: null,
      };
    }

    if (
      existing.signature !== observation.signature ||
      existing.abnormal !== observation.abnormal
    ) {
      const flushed = snapshot(existing, nowMs);
      const transitioned = this.createTransitionedState(
        existing,
        observation,
        metric,
        nowMs,
      );
      this.touch(key, transitioned);
      return {
        kind: 'transition',
        current: snapshot(transitioned, nowMs),
        flushed,
      };
    }

    if (existing.abnormal) {
      existing.maxMetric = maximumMetric(existing.maxMetric, metric);
    }

    if (
      existing.abnormal &&
      nowMs - existing.lastEmissionAtMs >= this.summaryIntervalMs
    ) {
      const flushed = snapshot(existing, nowMs);
      existing.lastEmissionAtMs = nowMs;
      existing.suppressedCount = 0;
      existing.suppressedCountCapped = false;
      this.touch(key, existing);
      return {
        kind: 'periodic-summary',
        current: snapshot(existing, nowMs),
        flushed,
      };
    }

    this.incrementSuppressedCount(existing);
    this.touch(key, existing);
    return {
      kind: 'repeat',
      current: snapshot(existing, nowMs),
      flushed: null,
    };
  }

  forget(key: Key): boolean {
    return this.states.delete(key);
  }

  clear(): void {
    this.states.clear();
  }

  private createInitialState(
    observation: LogStateObservation<Signature>,
    metric: number | null,
    nowMs: number,
  ): TrackedState<Signature> {
    return {
      signature: observation.signature,
      abnormal: observation.abnormal,
      stateStartedAtMs: nowMs,
      abnormalStartedAtMs: observation.abnormal ? nowMs : null,
      lastEmissionAtMs: nowMs,
      suppressedCount: 0,
      suppressedCountCapped: false,
      maxMetric: observation.abnormal ? metric : null,
    };
  }

  private createTransitionedState(
    previous: TrackedState<Signature>,
    observation: LogStateObservation<Signature>,
    metric: number | null,
    nowMs: number,
  ): TrackedState<Signature> {
    const continuingAbnormal = previous.abnormal && observation.abnormal;
    return {
      signature: observation.signature,
      abnormal: observation.abnormal,
      stateStartedAtMs: nowMs,
      abnormalStartedAtMs: observation.abnormal
        ? continuingAbnormal
          ? previous.abnormalStartedAtMs ?? nowMs
          : nowMs
        : null,
      lastEmissionAtMs: nowMs,
      suppressedCount: 0,
      suppressedCountCapped: false,
      maxMetric: observation.abnormal
        ? maximumMetric(continuingAbnormal ? previous.maxMetric : null, metric)
        : null,
    };
  }

  private incrementSuppressedCount(state: TrackedState<Signature>): void {
    if (state.suppressedCount < this.maxSuppressedCount) {
      state.suppressedCount += 1;
      return;
    }
    state.suppressedCountCapped = true;
  }

  private evictIfFull(): void {
    if (this.states.size < this.capacity) return;
    const oldest = this.states.keys().next();
    if (!oldest.done) this.states.delete(oldest.value);
  }

  private touch(key: Key, state: TrackedState<Signature>): void {
    this.states.delete(key);
    this.states.set(key, state);
  }

  private currentTime(): number {
    let candidate: number;
    try {
      candidate = this.now();
    } catch {
      return this.lastNowMs;
    }
    if (!Number.isFinite(candidate)) return this.lastNowMs;
    const bounded = Math.min(MAX_NUMERIC_VALUE, Math.max(0, candidate));
    this.lastNowMs = Math.max(this.lastNowMs, bounded);
    return this.lastNowMs;
  }
}

function snapshot<Signature extends string>(
  state: TrackedState<Signature>,
  nowMs: number,
): LogStateSnapshot<Signature> {
  return {
    signature: state.signature,
    abnormal: state.abnormal,
    stateDurationMs: boundedDelta(nowMs, state.stateStartedAtMs),
    abnormalDurationMs:
      state.abnormalStartedAtMs === null
        ? null
        : boundedDelta(nowMs, state.abnormalStartedAtMs),
    suppressedCount: state.suppressedCount,
    suppressedCountCapped: state.suppressedCountCapped,
    maxMetric: state.maxMetric,
  };
}

function boundedDelta(later: number, earlier: number): number {
  return Math.min(MAX_NUMERIC_VALUE, Math.max(0, later - earlier));
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(1, Math.trunc(value)));
}

function boundedDuration(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(MAX_NUMERIC_VALUE, Math.max(0, value));
}

function normalizedMetric(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.min(MAX_NUMERIC_VALUE, value);
}

function maximumMetric(current: number | null, next: number | null): number | null {
  if (current === null) return next;
  if (next === null) return current;
  return Math.max(current, next);
}
