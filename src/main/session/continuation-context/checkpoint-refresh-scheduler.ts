/**
 * Dependency-injected scheduling core for background continuation-checkpoint refreshes.
 *
 * The caller owns persistence and provider work. In particular, `observePersistedActivity` must be
 * called only after the event/revision is durable. The supplied snapshot is an immutable
 * eligibility observation; the integration captures the latest durable source when refresh work
 * actually starts. This keeps provider turns and their native context untouched.
 */

export const DEFAULT_CHECKPOINT_REFRESH_INTERVAL_MS = 30 * 60 * 1_000;
export const DEFAULT_CHECKPOINT_REFRESH_QUIET_MS = 60 * 1_000;
export const DEFAULT_CHECKPOINT_REFRESH_NORMAL_TOKENS = 8_000;
export const DEFAULT_CHECKPOINT_REFRESH_SAFETY_TOKENS = 48_000;
export const DEFAULT_CHECKPOINT_REFRESH_FAILURE_RETRY_MS = 5 * 60 * 1_000;

const MAX_TIMER_DELAY_MS = 2_147_483_647;

export type CheckpointRefreshTrigger = 'normal' | 'safety';

/** A revision-bounded eligibility estimate returned after all observed source writes are durable. */
export interface CheckpointRefreshBacklogSnapshot {
  sessionId: string;
  sourceEventRevision: number;
  checkpointEventRevision: number;
  uncheckpointedNormalizedTokens: number;
}

export interface CheckpointRefreshPolicy {
  intervalMs: number;
  quietMs: number;
  normalThresholdTokens: number;
  safetyThresholdTokens: number;
  failureRetryMs: number;
}

export const DEFAULT_CHECKPOINT_REFRESH_POLICY: Readonly<CheckpointRefreshPolicy> = Object.freeze({
  intervalMs: DEFAULT_CHECKPOINT_REFRESH_INTERVAL_MS,
  quietMs: DEFAULT_CHECKPOINT_REFRESH_QUIET_MS,
  normalThresholdTokens: DEFAULT_CHECKPOINT_REFRESH_NORMAL_TOKENS,
  safetyThresholdTokens: DEFAULT_CHECKPOINT_REFRESH_SAFETY_TOKENS,
  failureRetryMs: DEFAULT_CHECKPOINT_REFRESH_FAILURE_RETRY_MS,
});

export interface CheckpointRefreshRequest<
  Snapshot extends CheckpointRefreshBacklogSnapshot = CheckpointRefreshBacklogSnapshot,
> {
  sessionId: string;
  trigger: CheckpointRefreshTrigger;
  /**
   * Eligibility observation only. The refresh integration atomically captures the latest durable
   * source when provider work begins. Events arriving before that capture coalesce into this batch;
   * events arriving afterward belong to a later batch.
   */
  snapshot: Readonly<Snapshot>;
  signal: AbortSignal;
  startedAt: number;
}

export interface CheckpointRefreshErrorContext<
  Snapshot extends CheckpointRefreshBacklogSnapshot = CheckpointRefreshBacklogSnapshot,
> {
  sessionId: string;
  stage: 'snapshot' | 'refresh';
  trigger: CheckpointRefreshTrigger | null;
  snapshot: Readonly<Snapshot> | null;
  retryAt: number;
}

export interface CheckpointRefreshSchedulerDependencies<
  Snapshot extends CheckpointRefreshBacklogSnapshot = CheckpointRefreshBacklogSnapshot,
> {
  loadBacklogSnapshot: (
    sessionId: string,
    signal: AbortSignal,
  ) => Snapshot | null | Promise<Snapshot | null>;
  /** Resolve only after the captured source was durably handled; reject to enter retry backoff. */
  refresh: (request: CheckpointRefreshRequest<Snapshot>) => Promise<void>;
  onError?: (error: unknown, context: CheckpointRefreshErrorContext<Snapshot>) => void;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

export interface ObserveCheckpointSessionInput {
  sessionId: string;
  /** Scheduler-clock time, not an untrusted provider payload timestamp. */
  observedAt?: number;
  /** Durable checkpoint creation/success time used as the first normal interval anchor. */
  baselineAt?: number;
}

export interface ObserveCheckpointIdleInput extends ObserveCheckpointSessionInput {
  /** Useful when registering an existing session during startup catch-up. */
  lastPersistedAt?: number;
}

interface RunningRefresh<Snapshot extends CheckpointRefreshBacklogSnapshot> {
  controller: AbortController;
  epoch: number;
  trigger: CheckpointRefreshTrigger;
  snapshot: Readonly<Snapshot>;
  settled: Promise<void>;
}

interface SessionState<Snapshot extends CheckpointRefreshBacklogSnapshot> {
  readonly sessionId: string;
  baselineAt: number;
  lastSuccessAt: number | null;
  lastPersistedAt: number;
  providerActive: boolean;
  paused: boolean;
  retryNotBefore: number;
  epoch: number;
  needsEvaluation: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  evaluationController: AbortController | null;
  evaluation: Promise<void> | null;
  running: RunningRefresh<Snapshot> | null;
}

function nonNegativeTimestamp(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${field} must be non-negative`);
  return value;
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${field} must be positive`);
  return value;
}

function resolvedPolicy(input: Partial<CheckpointRefreshPolicy> = {}): CheckpointRefreshPolicy {
  const policy = { ...DEFAULT_CHECKPOINT_REFRESH_POLICY, ...input };
  positiveInteger(policy.intervalMs, 'intervalMs');
  positiveInteger(policy.quietMs, 'quietMs');
  positiveInteger(policy.normalThresholdTokens, 'normalThresholdTokens');
  positiveInteger(policy.safetyThresholdTokens, 'safetyThresholdTokens');
  positiveInteger(policy.failureRetryMs, 'failureRetryMs');
  if (policy.safetyThresholdTokens <= policy.normalThresholdTokens) {
    throw new Error('safetyThresholdTokens must exceed normalThresholdTokens');
  }
  return policy;
}

function validateSnapshot<Snapshot extends CheckpointRefreshBacklogSnapshot>(
  sessionId: string,
  snapshot: Snapshot,
): void {
  if (snapshot.sessionId !== sessionId) throw new Error('Checkpoint backlog snapshot session mismatch');
  nonNegativeTimestamp(snapshot.sourceEventRevision, 'sourceEventRevision');
  nonNegativeTimestamp(snapshot.checkpointEventRevision, 'checkpointEventRevision');
  nonNegativeTimestamp(snapshot.uncheckpointedNormalizedTokens, 'uncheckpointedNormalizedTokens');
  if (snapshot.checkpointEventRevision > snapshot.sourceEventRevision) {
    throw new Error('Checkpoint revision cannot be ahead of source revision');
  }
}

/**
 * Event-driven scheduler with one refresh at a time per session.
 *
 * Normal refresh: backlog >= normal threshold, provider idle, interval elapsed, and no persisted
 * activity for the quiet window. Safety refresh: backlog >= safety threshold and retry backoff has
 * elapsed; it ignores interval, quiet, and provider-active state.
 */
export class CheckpointRefreshScheduler<
  Snapshot extends CheckpointRefreshBacklogSnapshot = CheckpointRefreshBacklogSnapshot,
> {
  private readonly states = new Map<string, SessionState<Snapshot>>();
  private readonly activeWork = new Set<Promise<void>>();
  private readonly now: () => number;
  private readonly setTimer: NonNullable<CheckpointRefreshSchedulerDependencies<Snapshot>['setTimer']>;
  private readonly clearTimer: NonNullable<CheckpointRefreshSchedulerDependencies<Snapshot>['clearTimer']>;
  private policy: CheckpointRefreshPolicy;
  private enabled: boolean;
  private disposed = false;

  constructor(
    private readonly dependencies: CheckpointRefreshSchedulerDependencies<Snapshot>,
    options: { enabled?: boolean; policy?: Partial<CheckpointRefreshPolicy> } = {},
  ) {
    this.now = dependencies.now ?? Date.now;
    this.setTimer = dependencies.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer = dependencies.clearTimer ?? ((timer) => clearTimeout(timer));
    this.policy = resolvedPolicy(options.policy);
    this.enabled = options.enabled ?? true;
  }

  /** Observe one newly durable event/revision. This immediately checks the safety threshold. */
  observePersistedActivity(input: ObserveCheckpointSessionInput & { providerActive?: boolean }): void {
    if (this.disposed) return;
    const observedAt = nonNegativeTimestamp(input.observedAt ?? this.now(), 'observedAt');
    const state = this.stateFor(input.sessionId, observedAt, input.baselineAt);
    state.lastPersistedAt = Math.max(state.lastPersistedAt, observedAt);
    if (input.providerActive !== undefined) state.providerActive = input.providerActive;
    state.paused = false;
    this.requestEvaluation(state);
  }

  /** Mark a provider turn active. Normal work waits; safety work remains eligible. */
  observeProviderActive(input: ObserveCheckpointSessionInput): void {
    if (this.disposed) return;
    const observedAt = nonNegativeTimestamp(input.observedAt ?? this.now(), 'observedAt');
    const state = this.stateFor(input.sessionId, observedAt, input.baselineAt);
    state.providerActive = true;
    state.paused = false;
    this.requestEvaluation(state);
  }

  /** Mark a provider turn idle and re-evaluate normal eligibility. */
  observeIdle(input: ObserveCheckpointIdleInput): void {
    if (this.disposed) return;
    const observedAt = nonNegativeTimestamp(input.observedAt ?? this.now(), 'observedAt');
    const existed = this.states.has(input.sessionId);
    const state = this.stateFor(input.sessionId, observedAt, input.baselineAt);
    if (input.lastPersistedAt !== undefined) {
      const lastPersistedAt = nonNegativeTimestamp(input.lastPersistedAt, 'lastPersistedAt');
      state.lastPersistedAt = existed ? Math.max(state.lastPersistedAt, lastPersistedAt) : lastPersistedAt;
    }
    state.providerActive = false;
    state.paused = false;
    this.requestEvaluation(state);
  }

  setEnabled(enabled: boolean): void {
    if (this.disposed || enabled === this.enabled) return;
    this.enabled = enabled;
    for (const state of this.states.values()) {
      this.clearScheduledTimer(state);
      if (!enabled) {
        state.epoch += 1;
        state.evaluationController?.abort();
        state.running?.controller.abort();
      } else {
        this.requestEvaluation(state);
      }
    }
  }

  updatePolicy(patch: Partial<CheckpointRefreshPolicy>): void {
    if (this.disposed) return;
    this.policy = resolvedPolicy({ ...this.policy, ...patch });
    for (const state of this.states.values()) {
      this.clearScheduledTimer(state);
      this.requestEvaluation(state);
    }
  }

  /** Cancel queued/in-flight work. The next observation re-arms this session. */
  cancelSession(sessionId: string): Promise<void> {
    const state = this.states.get(sessionId);
    if (!state) return Promise.resolve();
    state.paused = true;
    state.epoch += 1;
    state.needsEvaluation = false;
    this.clearScheduledTimer(state);
    state.evaluationController?.abort();
    state.running?.controller.abort();
    return this.settleStateWork(state);
  }

  /** Forget a deleted/renamed identity. Late async completion cannot recreate it. */
  removeSession(sessionId: string): Promise<void> {
    const state = this.states.get(sessionId);
    if (!state) return Promise.resolve();
    this.states.delete(sessionId);
    state.epoch += 1;
    this.clearScheduledTimer(state);
    state.evaluationController?.abort();
    state.running?.controller.abort();
    return this.settleStateWork(state);
  }

  /** Abort all work and wait for callbacks/loaders to settle before callers close their database. */
  async dispose(): Promise<void> {
    if (!this.disposed) {
      this.disposed = true;
      this.enabled = false;
      for (const state of this.states.values()) {
        state.epoch += 1;
        this.clearScheduledTimer(state);
        state.evaluationController?.abort();
        state.running?.controller.abort();
      }
      this.states.clear();
    }
    await Promise.allSettled([...this.activeWork]);
  }

  private stateFor(sessionId: string, observedAt: number, baselineAt?: number): SessionState<Snapshot> {
    if (!sessionId.trim()) throw new Error('sessionId must not be empty');
    const existing = this.states.get(sessionId);
    if (existing) {
      if (baselineAt !== undefined) {
        existing.baselineAt = Math.max(
          existing.baselineAt,
          nonNegativeTimestamp(baselineAt, 'baselineAt'),
        );
      }
      return existing;
    }
    const baseline = nonNegativeTimestamp(baselineAt ?? observedAt, 'baselineAt');
    const state: SessionState<Snapshot> = {
      sessionId,
      baselineAt: baseline,
      lastSuccessAt: null,
      lastPersistedAt: observedAt,
      providerActive: false,
      paused: false,
      retryNotBefore: 0,
      epoch: 0,
      needsEvaluation: false,
      timer: null,
      evaluationController: null,
      evaluation: null,
      running: null,
    };
    this.states.set(sessionId, state);
    return state;
  }

  private requestEvaluation(state: SessionState<Snapshot>): void {
    state.needsEvaluation = true;
    if (!this.enabled || this.disposed || state.paused || state.evaluation || state.running) return;
    state.needsEvaluation = false;
    this.clearScheduledTimer(state);
    const controller = new AbortController();
    state.evaluationController = controller;
    const pending = this.evaluate(state, controller.signal)
      .catch((error) => this.handleFailure(state, 'snapshot', null, null, error, controller.signal))
      .then(() => {
        if (state.evaluationController === controller) {
          state.evaluation = null;
          state.evaluationController = null;
        }
        if (state.needsEvaluation) this.requestEvaluation(state);
      });
    state.evaluation = pending;
    this.track(pending);
  }

  private async evaluate(state: SessionState<Snapshot>, signal: AbortSignal): Promise<void> {
    const snapshot = await this.dependencies.loadBacklogSnapshot(state.sessionId, signal);
    if (signal.aborted || !this.isCurrent(state) || !this.enabled || state.paused) return;
    if (!snapshot) {
      void this.removeSession(state.sessionId);
      return;
    }
    validateSnapshot(state.sessionId, snapshot);
    const now = this.now();
    const tokens = snapshot.uncheckpointedNormalizedTokens;
    if (tokens >= this.policy.safetyThresholdTokens) {
      if (now >= state.retryNotBefore) this.startRefresh(state, snapshot, 'safety');
      else this.scheduleAt(state, state.retryNotBefore);
      return;
    }
    if (tokens < this.policy.normalThresholdTokens) return;
    if (state.providerActive) return;
    const anchor = Math.max(state.lastSuccessAt ?? 0, state.baselineAt);
    const dueAt = Math.max(
      anchor + this.policy.intervalMs,
      state.lastPersistedAt + this.policy.quietMs,
      state.retryNotBefore,
    );
    if (now >= dueAt) this.startRefresh(state, snapshot, 'normal');
    else this.scheduleAt(state, dueAt);
  }

  private startRefresh(
    state: SessionState<Snapshot>,
    snapshot: Snapshot,
    trigger: CheckpointRefreshTrigger,
  ): void {
    if (state.running || !this.isCurrent(state) || state.paused || !this.enabled) return;
    const controller = new AbortController();
    const epoch = state.epoch;
    const startedAt = this.now();
    const eligibilitySnapshot: Readonly<Snapshot> = snapshot;
    let settled!: Promise<void>;
    settled = Promise.resolve()
      .then(() =>
        this.dependencies.refresh({
          sessionId: state.sessionId,
          trigger,
          snapshot: eligibilitySnapshot,
          signal: controller.signal,
          startedAt,
        }),
      )
      .then(
        () => this.finishRefresh(state, epoch, controller, true, trigger, eligibilitySnapshot, null),
        (error) =>
          this.finishRefresh(state, epoch, controller, false, trigger, eligibilitySnapshot, error),
      );
    state.running = { controller, epoch, trigger, snapshot: eligibilitySnapshot, settled };
    this.track(settled);
  }

  private finishRefresh(
    state: SessionState<Snapshot>,
    epoch: number,
    controller: AbortController,
    succeeded: boolean,
    trigger: CheckpointRefreshTrigger,
    snapshot: Readonly<Snapshot>,
    error: unknown,
  ): void {
    if (state.running?.controller === controller) state.running = null;
    if (!this.isCurrent(state)) return;
    if (state.epoch !== epoch || controller.signal.aborted) {
      if (state.needsEvaluation) this.requestEvaluation(state);
      return;
    }
    if (succeeded) {
      state.lastSuccessAt = this.now();
      state.retryNotBefore = 0;
      // A resolved callback owns the source captured at execution time. Activity observed while it
      // was running is evaluated again; already-coalesced rows then produce a zero backlog. Avoid
      // unconditional re-reads because a delayed durable view could otherwise hot-loop.
      if (state.needsEvaluation) this.requestEvaluation(state);
    } else {
      this.handleFailure(state, 'refresh', trigger, snapshot, error, controller.signal);
      if (state.needsEvaluation) this.requestEvaluation(state);
    }
  }

  private handleFailure(
    state: SessionState<Snapshot>,
    stage: 'snapshot' | 'refresh',
    trigger: CheckpointRefreshTrigger | null,
    snapshot: Readonly<Snapshot> | null,
    error: unknown,
    signal: AbortSignal,
  ): void {
    if (signal.aborted || !this.isCurrent(state) || state.paused || !this.enabled) return;
    state.retryNotBefore = this.now() + this.policy.failureRetryMs;
    try {
      this.dependencies.onError?.(error, {
        sessionId: state.sessionId,
        stage,
        trigger,
        snapshot,
        retryAt: state.retryNotBefore,
      });
    } catch {
      // Diagnostics must never turn a handled background failure into an unhandled rejection.
    }
    this.scheduleAt(state, state.retryNotBefore);
  }

  private scheduleAt(state: SessionState<Snapshot>, dueAt: number): void {
    if (!this.enabled || this.disposed || state.paused || state.running) return;
    this.clearScheduledTimer(state);
    const delay = Math.min(MAX_TIMER_DELAY_MS, Math.max(0, dueAt - this.now()));
    state.timer = this.setTimer(() => {
      state.timer = null;
      this.requestEvaluation(state);
    }, delay);
    state.timer.unref?.();
  }

  private clearScheduledTimer(state: SessionState<Snapshot>): void {
    if (!state.timer) return;
    this.clearTimer(state.timer);
    state.timer = null;
  }

  private isCurrent(state: SessionState<Snapshot>): boolean {
    return !this.disposed && this.states.get(state.sessionId) === state;
  }

  private settleStateWork(state: SessionState<Snapshot>): Promise<void> {
    return Promise.allSettled(
      [state.evaluation, state.running?.settled].filter((item): item is Promise<void> => item !== null && item !== undefined),
    ).then(() => undefined);
  }

  private track(promise: Promise<void>): void {
    this.activeWork.add(promise);
    void promise.then(
      () => this.activeWork.delete(promise),
      () => this.activeWork.delete(promise),
    );
  }
}
