import { statfsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Database } from 'better-sqlite3';
import {
  beginEventSearchRestartVerification,
  runEventSearchSlice,
  type MaintenanceSliceResult,
} from './event-search';
import {
  beginSnapshotRestartVerification,
  runSnapshotGcSlice,
  runSnapshotMaintenanceSlice,
  type SnapshotMaintenanceSliceResult,
} from './file-snapshots';
import {
  boundedMaintenanceError,
  readMaintenanceState,
  updateMaintenanceState,
  type StorageMaintenanceState,
  type StorageMaintenanceTask,
} from './state';

const MIN_BACKFILL_FREE_BYTES = 2 * 1024 * 1024 * 1024;

export interface MaintenanceEngineOptions {
  yieldDelayMs?: number;
  idleDelayMs?: number;
  errorRetryMs?: number;
}

export type StorageMaintenanceSliceResult =
  | MaintenanceSliceResult
  | SnapshotMaintenanceSliceResult;

export interface MaintenanceEngineTick {
  result: StorageMaintenanceSliceResult | null;
  state: StorageMaintenanceState | null;
  error: { task: StorageMaintenanceTask; message: string } | null;
  restartTransitions: StorageMaintenanceTask[];
  nextDelayMs: number;
}

const ACTIVE_PHASES = new Set([
  'backfill',
  'verify',
  'restart-verify',
  'restart-verify-orphans',
  'restart-verify-search',
  'clear',
]);

export function isActiveMaintenancePhase(phase: string | undefined): boolean {
  return phase !== undefined && ACTIVE_PHASES.has(phase);
}

/**
 * Owns the synchronous slice policy for one dedicated SQLite connection. Timer and worker lifecycle
 * stay outside this class so one app-run restart snapshot can survive worker replacement.
 */
export class StorageMaintenanceEngine {
  private nextTask: StorageMaintenanceTask = 'event-search-v1';
  private gcTick = 0;
  private restartEligible: Set<StorageMaintenanceTask>;
  private transitionedRestartGates = false;
  private retryAt = new Map<StorageMaintenanceTask, number>();
  private diskGateCheckedAt = 0;
  private attemptedTask: StorageMaintenanceTask = 'event-search-v1';

  constructor(
    private readonly db: Database,
    restartEligible: readonly StorageMaintenanceTask[],
    private readonly options: MaintenanceEngineOptions = {},
  ) {
    this.restartEligible = new Set(restartEligible);
  }

  runTick(now = Date.now()): MaintenanceEngineTick {
    let result: StorageMaintenanceSliceResult | null = null;
    let error: MaintenanceEngineTick['error'] = null;
    const restartTransitions: StorageMaintenanceTask[] = [];
    try {
      result = this.runOneSlice(restartTransitions);
      if (result) {
        const stateTask = result.task === 'file-snapshot-gc'
          ? 'file-snapshot-blobs-v1'
          : result.task;
        this.retryAt.delete(stateTask);
      }
    } catch (cause) {
      const message = boundedMaintenanceError(cause);
      error = { task: this.attemptedTask, message };
      try {
        this.persistError(this.attemptedTask, message);
      } catch (persistCause) {
        error.message = boundedMaintenanceError(
          `${message}; failed to persist maintenance error: ${boundedMaintenanceError(persistCause)}`,
        );
      }
      this.retryAt.set(
        this.attemptedTask,
        now + (this.options.errorRetryMs ?? 30_000),
      );
    }

    const stateTask = result?.task === 'file-snapshot-gc'
      ? 'file-snapshot-blobs-v1'
      : result?.task;
    const state = stateTask ? readMaintenanceState(this.db, stateTask) : null;
    return {
      result,
      state,
      error,
      restartTransitions,
      nextDelayMs: this.nextScheduleDelay(this.options.yieldDelayMs ?? 25, now),
    };
  }

  /** Public deterministic seam; production invokes it only inside the maintenance worker. */
  runOneSlice(restartTransitions: StorageMaintenanceTask[] = []): StorageMaintenanceSliceResult | null {
    this.transitionRestartGates(restartTransitions);

    this.gcTick += 1;
    if (
      this.gcTick % 16 === 0 &&
      this.canAttempt('file-snapshot-blobs-v1') &&
      this.isSnapshotGcReady()
    ) {
      this.attemptedTask = 'file-snapshot-blobs-v1';
      const gc = runSnapshotGcSlice(this.db);
      if (gc.processed > 0) return gc;
    }

    const task = this.chooseRunnableTask();
    if (!task) return null;
    this.attemptedTask = task;
    this.nextTask = task === 'event-search-v1'
      ? 'file-snapshot-blobs-v1'
      : 'event-search-v1';
    this.ensureDiskHeadroom(task);
    return task === 'event-search-v1'
      ? runEventSearchSlice(this.db)
      : runSnapshotMaintenanceSlice(this.db);
  }

  private transitionRestartGates(transitions: StorageMaintenanceTask[]): void {
    if (this.transitionedRestartGates) return;
    if (this.restartEligible.has('event-search-v1') && this.canAttempt('event-search-v1')) {
      this.attemptedTask = 'event-search-v1';
      beginEventSearchRestartVerification(this.db);
      this.restartEligible.delete('event-search-v1');
      transitions.push('event-search-v1');
    }
    if (
      this.restartEligible.has('file-snapshot-blobs-v1') &&
      this.canAttempt('file-snapshot-blobs-v1')
    ) {
      this.attemptedTask = 'file-snapshot-blobs-v1';
      beginSnapshotRestartVerification(this.db);
      this.restartEligible.delete('file-snapshot-blobs-v1');
      transitions.push('file-snapshot-blobs-v1');
    }
    this.transitionedRestartGates = this.restartEligible.size === 0;
  }

  private chooseRunnableTask(): StorageMaintenanceTask | null {
    const other: StorageMaintenanceTask = this.nextTask === 'event-search-v1'
      ? 'file-snapshot-blobs-v1'
      : 'event-search-v1';
    for (const task of [this.nextTask, other]) {
      if (!this.canAttempt(task)) continue;
      if (isActiveMaintenancePhase(readMaintenanceState(this.db, task)?.phase)) return task;
    }
    return null;
  }

  private canAttempt(task: StorageMaintenanceTask, now = Date.now()): boolean {
    return (this.retryAt.get(task) ?? 0) <= now;
  }

  private nextScheduleDelay(defaultYieldMs: number, now: number): number {
    if (!this.hasActiveWork()) return this.options.idleDelayMs ?? 60_000;
    const runnableMigration = (['event-search-v1', 'file-snapshot-blobs-v1'] as const).some(
      (task) =>
        this.canAttempt(task, now) &&
        isActiveMaintenancePhase(readMaintenanceState(this.db, task)?.phase),
    );
    const gcPending = this.isSnapshotGcReady() && Number(
      this.db.prepare('SELECT COUNT(*) FROM file_snapshot_gc_queue').pluck().get(),
    ) > 0;
    if (runnableMigration || (gcPending && this.canAttempt('file-snapshot-blobs-v1', now))) {
      return defaultYieldMs;
    }
    const futureRetries = [...this.retryAt.values()].filter((at) => at > now);
    if (futureRetries.length === 0) return this.options.idleDelayMs ?? 60_000;
    return Math.max(1, Math.min(...futureRetries) - now);
  }

  private hasActiveWork(): boolean {
    if (this.restartEligible.size > 0) return true;
    const hasMigration = (['event-search-v1', 'file-snapshot-blobs-v1'] as const).some((task) =>
      isActiveMaintenancePhase(readMaintenanceState(this.db, task)?.phase),
    );
    if (hasMigration) return true;
    return this.isSnapshotGcReady() && Number(
      this.db.prepare('SELECT COUNT(*) FROM file_snapshot_gc_queue').pluck().get(),
    ) > 0;
  }

  private ensureDiskHeadroom(task: StorageMaintenanceTask): void {
    if (readMaintenanceState(this.db, task)?.phase !== 'backfill' || this.db.name === ':memory:') {
      return;
    }
    const now = Date.now();
    if (now - this.diskGateCheckedAt < 60_000) return;
    const stats = statfsSync(dirname(this.db.name));
    const availableBytes = stats.bavail * stats.bsize;
    if (availableBytes < MIN_BACKFILL_FREE_BYTES) {
      throw new Error(
        `storage backfill paused: freeBytes=${availableBytes}, ` +
          `requiredBytes=${MIN_BACKFILL_FREE_BYTES}`,
      );
    }
    this.diskGateCheckedAt = now;
  }

  private isSnapshotGcReady(): boolean {
    return readMaintenanceState(this.db, 'file-snapshot-blobs-v1')?.phase === 'complete';
  }

  private persistError(task: StorageMaintenanceTask, message: string): void {
    const state = readMaintenanceState(this.db, task);
    if (state && state.phase !== 'complete' && state.phase !== 'retire-on-shutdown') {
      updateMaintenanceState(this.db, task, { lastError: message });
    }
  }
}
