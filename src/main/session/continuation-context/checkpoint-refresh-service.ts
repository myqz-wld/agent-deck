import {
  DEFAULT_CONTINUATION_CHECKPOINT_MAX_CONCURRENT,
  type AgentEvent,
  type AppSettings,
  type SessionRecord,
} from '@shared/types';
import { eventBus, type TypedEventBus } from '@main/event-bus';
import { getDb } from '@main/store/db';
import { createContinuationCheckpointRepo } from '@main/store/continuation-checkpoint-repo';
import { sessionRepo } from '@main/store/session-repo';
import {
  type CheckpointBacklogEstimate,
} from './checkpoint-backlog-estimator';
import {
  type CheckpointBacklogEstimator,
} from './checkpoint-backlog-worker-client';
import { createDesktopCheckpointBacklogEstimator } from './checkpoint-backlog-worker-host';
import {
  BackgroundCheckpointRefreshIncompleteError,
  refreshContinuationCheckpoint,
  type ContinuationCheckpointRefreshSnapshot,
} from './checkpoint-background-refresh';
import {
  CheckpointRefreshScheduler,
  type CheckpointRefreshRequest,
} from './checkpoint-refresh-scheduler';
import { CheckpointRefreshQueue } from './checkpoint-refresh-queue';
import { CheckpointRefreshDiagnosticCoordinator } from './checkpoint-refresh-diagnostics';

const EVENT_EVALUATION_THROTTLE_MS = 5_000;
const SESSION_PAGE_SIZE = 100;

interface CheckpointRefreshServiceDependencies {
  bus?: Pick<TypedEventBus, 'on'>;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  listSessions?: (limit: number, offset: number) => SessionRecord[];
  getSession?: (sessionId: string) => SessionRecord | null;
  checkpointBaseline?: (sessionId: string) => number | null;
  estimateBacklog?: (
    sessionId: string,
    signal: AbortSignal,
  ) => CheckpointBacklogEstimate | null | Promise<CheckpointBacklogEstimate | null>;
  backlogEstimator?: CheckpointBacklogEstimator;
  refresh?: typeof refreshContinuationCheckpoint;
}

interface PendingObservation {
  timer: ReturnType<typeof setTimeout>;
  observedAt: number;
}

type CheckpointRefreshSettings = Pick<
  AppSettings,
  'continuationCheckpointAutoRefreshEnabled' |
  'continuationCheckpointAutoRefreshIntervalMinutes'
> & Partial<Pick<AppSettings, 'continuationCheckpointMaxConcurrent'>>;

function isProviderActive(session: SessionRecord, event?: AgentEvent): boolean {
  if (event?.kind === 'session-end' || event?.kind === 'finished') return false;
  return (
    session.lifecycle === 'active' &&
    (session.activity === 'working' || session.activity === 'waiting')
  );
}

function snapshotFromEstimate(
  estimate: CheckpointBacklogEstimate,
): ContinuationCheckpointRefreshSnapshot {
  return {
    sessionId: estimate.sessionId,
    sourceEventRevision: estimate.captureRevision,
    checkpointEventRevision: estimate.checkpointThroughRevision,
    uncheckpointedNormalizedTokens: estimate.estimatedTokens,
    rebuildAfterRevision: estimate.rebuildAfterRevision,
    checkpointCreatedAt: estimate.checkpointCreatedAt,
    saturated: estimate.saturated,
  };
}

export class ContinuationCheckpointRefreshService {
  private readonly bus: Pick<TypedEventBus, 'on'>;
  private readonly now: () => number;
  private readonly setTimer: NonNullable<CheckpointRefreshServiceDependencies['setTimer']>;
  private readonly clearTimer: NonNullable<CheckpointRefreshServiceDependencies['clearTimer']>;
  private readonly off: Array<() => void> = [];
  private readonly pending = new Map<string, PendingObservation>();
  private readonly foregroundLeases = new Map<string, number>();
  private readonly scheduler: CheckpointRefreshScheduler<ContinuationCheckpointRefreshSnapshot>;
  private readonly refreshQueue: CheckpointRefreshQueue;
  private readonly diagnostics: CheckpointRefreshDiagnosticCoordinator;
  private backlogEstimator: CheckpointBacklogEstimator | null;
  private started = false;

  constructor(
    settings: CheckpointRefreshSettings,
    private readonly dependencies: CheckpointRefreshServiceDependencies = {},
  ) {
    this.bus = dependencies.bus ?? eventBus;
    this.now = dependencies.now ?? Date.now;
    this.setTimer = dependencies.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer = dependencies.clearTimer ?? ((timer) => clearTimeout(timer));
    this.backlogEstimator = dependencies.backlogEstimator ?? null;
    this.diagnostics = new CheckpointRefreshDiagnosticCoordinator(this.now);
    this.refreshQueue = new CheckpointRefreshQueue(
      settings.continuationCheckpointMaxConcurrent ??
        DEFAULT_CONTINUATION_CHECKPOINT_MAX_CONCURRENT,
    );
    this.scheduler = new CheckpointRefreshScheduler<ContinuationCheckpointRefreshSnapshot>(
      {
        loadBacklogSnapshot: (sessionId, signal) => this.loadSnapshot(sessionId, signal),
        refresh: (request) => this.enqueueRefresh(request),
        onError: (error, context) => {
          const foldFailure =
            error instanceof BackgroundCheckpointRefreshIncompleteError
              ? error.foldFailure
              : null;
          const incompleteWithProgress =
            error instanceof BackgroundCheckpointRefreshIncompleteError &&
            foldFailure === null &&
            error.checkpointThroughRevision >
              (context.snapshot?.checkpointEventRevision ?? 0);
          if (incompleteWithProgress) {
            if (context.trigger) {
              this.diagnostics.complete(context.sessionId, {
                trigger: context.trigger,
                partial: true,
                progress: {
                  previousCheckpointRevision:
                    context.snapshot?.checkpointEventRevision ?? 0,
                  checkpointThroughRevision: error.checkpointThroughRevision,
                  captureRevision:
                    context.snapshot?.sourceEventRevision ??
                    error.materializedThroughRevision,
                },
              });
            }
            return;
          }
          const trigger = context.stage === 'snapshot' ? 'snapshot' : context.trigger;
          if (!trigger) return;
          this.diagnostics.fail(context.sessionId, {
            trigger,
            category:
              foldFailure?.category ??
              (error instanceof BackgroundCheckpointRefreshIncompleteError
                ? 'incomplete-coverage'
                : context.stage === 'snapshot'
                  ? 'snapshot-error'
                  : 'refresh-error'),
            reason:
              foldFailure?.reason ??
              (error instanceof BackgroundCheckpointRefreshIncompleteError
                ? 'fold-budget-or-call-limit'
                : 'unclassified'),
          });
        },
        now: this.now,
        setTimer: this.setTimer,
        clearTimer: this.clearTimer,
      },
      {
        enabled: settings.continuationCheckpointAutoRefreshEnabled,
        policy: {
          intervalMs: settings.continuationCheckpointAutoRefreshIntervalMinutes * 60_000,
        },
      },
    );
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.off.push(
      this.bus.on('agent-event', (event) => this.onPersistedEvent(event)),
      this.bus.on('session-upserted', (session) => this.observeSession(session)),
      this.bus.on('session-removed', (sessionId) => this.removeSession(sessionId)),
      this.bus.on('session-renamed', ({ from, to }) => {
        this.removeSession(from);
        const renamed = this.getSession(to);
        if (renamed) this.observeSession(renamed);
      }),
    );
    for (let offset = 0; ; offset += SESSION_PAGE_SIZE) {
      const page = (this.dependencies.listSessions ?? sessionRepo.listActiveAndDormant)(
        SESSION_PAGE_SIZE,
        offset,
      );
      page.forEach((session) => this.observeSession(session));
      if (page.length < SESSION_PAGE_SIZE) break;
    }
  }

  updateSettings(settings: CheckpointRefreshSettings): void {
    if (settings.continuationCheckpointMaxConcurrent !== undefined) {
      this.refreshQueue.setMaxConcurrent(settings.continuationCheckpointMaxConcurrent);
    }
    this.scheduler.updatePolicy({
      intervalMs: settings.continuationCheckpointAutoRefreshIntervalMinutes * 60_000,
    });
    this.scheduler.setEnabled(settings.continuationCheckpointAutoRefreshEnabled);
  }

  async acquireForegroundLease(sessionId: string): Promise<() => void> {
    this.foregroundLeases.set(sessionId, (this.foregroundLeases.get(sessionId) ?? 0) + 1);
    this.clearPending(sessionId);
    await this.scheduler.cancelSession(sessionId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.foregroundLeases.get(sessionId) ?? 1) - 1;
      if (remaining > 0) {
        this.foregroundLeases.set(sessionId, remaining);
        return;
      }
      this.foregroundLeases.delete(sessionId);
      const session = this.getSession(sessionId);
      if (session) this.observeSession(session);
    };
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.off.splice(0).forEach((unsubscribe) => unsubscribe());
    for (const sessionId of [...this.pending.keys()]) this.clearPending(sessionId);
    this.foregroundLeases.clear();
    await this.scheduler.dispose();
    const estimator = this.backlogEstimator;
    this.backlogEstimator = null;
    const results = await Promise.allSettled([
      this.refreshQueue.whenIdle(),
      estimator?.stop() ?? Promise.resolve(),
    ]);
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    this.diagnostics.reset();
    if (failure) throw failure.reason;
  }

  private getSession(sessionId: string): SessionRecord | null {
    return (this.dependencies.getSession ?? sessionRepo.get)(sessionId);
  }

  private checkpointBaseline(session: SessionRecord): number {
    const checkpointCreatedAt = this.dependencies.checkpointBaseline
      ? this.dependencies.checkpointBaseline(session.id)
      : createContinuationCheckpointRepo(getDb()).latest(session.id)?.createdAt ?? null;
    return checkpointCreatedAt ?? session.startedAt;
  }

  private observeSession(session: SessionRecord, event?: AgentEvent): void {
    if (!this.started || this.foregroundLeases.has(session.id)) return;
    if (session.archivedAt !== null) {
      void this.scheduler.cancelSession(session.id);
      return;
    }
    if (session.lifecycle === 'closed' && event?.kind !== 'session-end') {
      void this.scheduler.cancelSession(session.id);
      return;
    }
    const observedAt = event ? this.now() : Math.max(0, session.lastEventAt);
    const baselineAt = this.checkpointBaseline(session);
    if (isProviderActive(session, event)) {
      this.scheduler.observeProviderActive({ sessionId: session.id, observedAt, baselineAt });
    } else {
      this.scheduler.observeIdle({
        sessionId: session.id,
        observedAt,
        baselineAt,
        lastPersistedAt: event ? observedAt : Math.max(0, session.lastEventAt),
      });
    }
  }

  private onPersistedEvent(event: AgentEvent): void {
    if (!this.started || this.foregroundLeases.has(event.sessionId)) return;
    const session = this.getSession(event.sessionId);
    if (!session) {
      this.removeSession(event.sessionId);
      return;
    }
    if (!isProviderActive(session, event)) {
      this.clearPending(event.sessionId);
      this.observeSession(session, event);
      return;
    }
    const observedAt = this.now();
    const existing = this.pending.get(event.sessionId);
    if (existing) {
      existing.observedAt = observedAt;
      return;
    }
    const timer = this.setTimer(() => {
      const pending = this.pending.get(event.sessionId);
      this.pending.delete(event.sessionId);
      if (!pending || this.foregroundLeases.has(event.sessionId)) return;
      const current = this.getSession(event.sessionId);
      if (current) this.observeSession(current, { ...event, ts: pending.observedAt });
    }, EVENT_EVALUATION_THROTTLE_MS);
    timer.unref?.();
    this.pending.set(event.sessionId, { timer, observedAt });
  }

  private async loadSnapshot(
    sessionId: string,
    signal: AbortSignal,
  ): Promise<ContinuationCheckpointRefreshSnapshot | null> {
    if (signal.aborted || this.foregroundLeases.has(sessionId)) return null;
    const session = this.getSession(sessionId);
    if (!session || session.archivedAt !== null) return null;
    const estimate = this.dependencies.estimateBacklog
      ? await this.dependencies.estimateBacklog(sessionId, signal)
      : await this.getBacklogEstimator().estimate(sessionId, signal);
    if (signal.aborted || this.foregroundLeases.has(sessionId)) return null;
    const current = this.getSession(sessionId);
    if (!current || current.archivedAt !== null) return null;
    return estimate ? snapshotFromEstimate(estimate) : null;
  }

  private getBacklogEstimator(): CheckpointBacklogEstimator {
    this.backlogEstimator ??= createDesktopCheckpointBacklogEstimator(getDb().name);
    return this.backlogEstimator;
  }

  private enqueueRefresh(
    request: CheckpointRefreshRequest<ContinuationCheckpointRefreshSnapshot>,
  ): Promise<void> {
    this.diagnostics.begin(request.sessionId, request.trigger, request.startedAt);
    return this.refreshQueue.enqueue(async () => {
      if (request.signal.aborted || this.foregroundLeases.has(request.sessionId)) {
        throw new Error('Background checkpoint refresh cancelled before execution');
      }
      const result = await (this.dependencies.refresh ?? refreshContinuationCheckpoint)({
        sessionId: request.sessionId,
        trigger: request.trigger,
        snapshot: request.snapshot,
        signal: request.signal,
      });
      if (!request.signal.aborted) {
        this.diagnostics.complete(request.sessionId, {
          trigger: request.trigger,
          partial:
            result.checkpointThroughRevision < result.captureRevision ||
            result.uncoveredRevisionRange !== null,
          progress: {
            previousCheckpointRevision: request.snapshot.checkpointEventRevision,
            checkpointThroughRevision: result.checkpointThroughRevision,
            captureRevision: result.captureRevision,
          },
        });
      }
      if (
        result.checkpointThroughRevision < result.captureRevision &&
        !request.signal.aborted &&
        !this.foregroundLeases.has(request.sessionId)
      ) {
        // Resource guards intentionally materialize only a complete-revision prefix. Re-arm before
        // this refresh settles so the scheduler evaluates the remaining durable backlog: safety
        // work continues immediately, while smaller deltas return to the normal interval gate.
        const session = this.getSession(request.sessionId);
        if (session && session.archivedAt === null) {
          const observedAt = this.now();
          const baselineAt = this.checkpointBaseline(session);
          if (isProviderActive(session)) {
            this.scheduler.observeProviderActive({
              sessionId: session.id,
              observedAt,
              baselineAt,
            });
          } else {
            this.scheduler.observeIdle({
              sessionId: session.id,
              observedAt,
              baselineAt,
              lastPersistedAt: Math.max(0, session.lastEventAt),
            });
          }
        }
      }
    }, request.signal);
  }

  private removeSession(sessionId: string): void {
    this.clearPending(sessionId);
    this.foregroundLeases.delete(sessionId);
    this.diagnostics.forget(sessionId);
    void this.scheduler.removeSession(sessionId);
  }

  private clearPending(sessionId: string): void {
    const pending = this.pending.get(sessionId);
    if (!pending) return;
    this.clearTimer(pending.timer);
    this.pending.delete(sessionId);
  }
}

let checkpointRefreshService: ContinuationCheckpointRefreshService | null = null;

export function startContinuationCheckpointRefreshService(settings: AppSettings): void {
  checkpointRefreshService ??= new ContinuationCheckpointRefreshService(settings);
  checkpointRefreshService.start();
}

export function getContinuationCheckpointRefreshService(): ContinuationCheckpointRefreshService | null {
  return checkpointRefreshService;
}

export async function stopContinuationCheckpointRefreshService(): Promise<void> {
  const current = checkpointRefreshService;
  checkpointRefreshService = null;
  await current?.stop();
}

export async function acquireContinuationCheckpointForegroundLease(
  sessionId: string,
): Promise<() => void> {
  return checkpointRefreshService?.acquireForegroundLease(sessionId) ?? (() => undefined);
}
