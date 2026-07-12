import { statfsSync } from 'node:fs';
import { dirname } from 'node:path';
import { getDb, isDbClosed } from '../db';
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
  type StorageMaintenanceTask,
} from './state';
import log from '@main/utils/logger';

const logger = log.scope('storage-maintenance');
const MIN_BACKFILL_FREE_BYTES = 2 * 1024 * 1024 * 1024;

interface SchedulerOptions {
  initialDelayMs?: number;
  yieldDelayMs?: number;
  idleDelayMs?: number;
  errorRetryMs?: number;
  slowSliceMs?: number;
}

type SliceResult = MaintenanceSliceResult | SnapshotMaintenanceSliceResult;
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
 * Runs one small synchronous SQLite/codec slice at a time, yielding between slices. No full rebuild,
 * verification scan, legacy clear, or FTS cleanup is allowed in the startup migration transaction.
 */
export class StorageMaintenanceScheduler {
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private nextTask: StorageMaintenanceTask = 'event-search-v1';
  private gcTick = 0;
  private restartEligible = new Set<StorageMaintenanceTask>();
  private transitionedRestartGates = false;
  private lastPhase = new Map<string, string>();
  private lastProgress = new Map<string, number>();
  private lastErrorLog = new Map<StorageMaintenanceTask, { signature: string; at: number }>();
  private retryAt = new Map<StorageMaintenanceTask, number>();
  private diskGateCheckedAt = 0;
  private attemptedTask: StorageMaintenanceTask = 'event-search-v1';

  constructor(private readonly options: SchedulerOptions = {}) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.transitionedRestartGates = false;
    const db = getDb();
    this.restartEligible = new Set(
      (['event-search-v1', 'file-snapshot-blobs-v1'] as const).filter(
        (task) => readMaintenanceState(db, task)?.phase === 'awaiting-restart',
      ),
    );
    this.schedule(this.options.initialDelayMs ?? 15_000);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Public test/diagnostic seam; production scheduling still calls exactly one slice per tick. */
  runOneSlice(): SliceResult | null {
    if (isDbClosed()) return null;
    const db = getDb();
    this.transitionRestartGates(db);

    this.gcTick += 1;
    if (
      this.gcTick % 16 === 0 &&
      this.canAttempt('file-snapshot-blobs-v1') &&
      this.isSnapshotGcReady(db)
    ) {
      this.attemptedTask = 'file-snapshot-blobs-v1';
      const gc = runSnapshotGcSlice(db);
      if (gc.processed > 0) return gc;
    }

    const task = this.chooseRunnableTask(db);
    if (!task) return null;
    this.attemptedTask = task;
    this.nextTask = task === 'event-search-v1'
      ? 'file-snapshot-blobs-v1'
      : 'event-search-v1';
    this.ensureDiskHeadroom(db, task);
    return task === 'event-search-v1'
      ? runEventSearchSlice(db)
      : runSnapshotMaintenanceSlice(db);
  }

  private tick(): void {
    this.timer = null;
    if (this.stopped || isDbClosed()) return;
    let delay = this.options.yieldDelayMs ?? 25;
    try {
      const result = this.runOneSlice();
      if (result) {
        this.observeResult(result);
        const stateTask = result.task === 'file-snapshot-gc'
          ? 'file-snapshot-blobs-v1'
          : result.task;
        this.lastErrorLog.delete(stateTask);
        this.retryAt.delete(stateTask);
      }
      delay = this.nextScheduleDelay(delay);
    } catch (error) {
      const message = boundedMaintenanceError(error);
      this.persistError(this.attemptedTask, message);
      const signature = `${this.attemptedTask}:${message}`;
      const now = Date.now();
      const prior = this.lastErrorLog.get(this.attemptedTask);
      if (
        !prior ||
        prior.signature !== signature ||
        now - prior.at >= 5 * 60_000
      ) {
        logger.warn(`[storage-maintenance] slice failed; will retry: ${message}`);
        this.lastErrorLog.set(this.attemptedTask, { signature, at: now });
      }
      this.retryAt.set(this.attemptedTask, now + (this.options.errorRetryMs ?? 30_000));
      // A failed event-search slice must not throttle healthy snapshot work (or vice versa).
      // If both tasks are backed off, sleep until the nearest retry instead of spinning.
      delay = this.nextScheduleDelay(this.options.yieldDelayMs ?? 25);
    }
    this.schedule(delay);
  }

  private transitionRestartGates(db: ReturnType<typeof getDb>): void {
    if (this.transitionedRestartGates) return;
    if (this.restartEligible.has('event-search-v1') && this.canAttempt('event-search-v1')) {
      this.attemptedTask = 'event-search-v1';
      beginEventSearchRestartVerification(db);
      this.restartEligible.delete('event-search-v1');
      logger.info('[storage-maintenance] event search restart gate reached; verification resumed');
    }
    if (
      this.restartEligible.has('file-snapshot-blobs-v1') &&
      this.canAttempt('file-snapshot-blobs-v1')
    ) {
      this.attemptedTask = 'file-snapshot-blobs-v1';
      beginSnapshotRestartVerification(db);
      this.restartEligible.delete('file-snapshot-blobs-v1');
      logger.info('[storage-maintenance] snapshot restart gate passed; verification resumed');
    }
    this.transitionedRestartGates = this.restartEligible.size === 0;
  }

  private observeResult(result: SliceResult): void {
    const slowThreshold = this.options.slowSliceMs ?? 50;
    if (result.durationMs >= slowThreshold) {
      logger.warn('[performance] slow storage maintenance slice', {
        task: result.task,
        phase: result.phase,
        processed: result.processed,
        durationMs: Math.round(result.durationMs),
      });
    }
    const previousPhase = this.lastPhase.get(result.task);
    if (previousPhase !== result.phase) {
      this.lastPhase.set(result.task, result.phase);
      this.lastProgress.set(result.task, 0);
      logger.info(
        `[storage-maintenance] ${result.task} phase=${result.phase} ` +
          `(processed=${result.processed}, durationMs=${Math.round(result.durationMs)})`,
      );
      return;
    }
    const stateTask = result.task === 'file-snapshot-gc' ? null : result.task;
    if (!stateTask) return;
    const state = readMaintenanceState(getDb(), stateTask);
    if (!state) return;
    const interval = stateTask === 'event-search-v1' ? 10_000 : 1_000;
    const previous = this.lastProgress.get(stateTask) ?? 0;
    if (state.cursor - previous < interval) return;
    this.lastProgress.set(stateTask, state.cursor);
    logger.info(
      `[storage-maintenance] ${stateTask} progress=${state.cursor}/${state.upperBound} ` +
        `(batch=${state.batchSize})`,
    );
  }

  private hasActiveWork(): boolean {
    if (this.restartEligible.size > 0) return true;
    const db = getDb();
    const hasMigration = (['event-search-v1', 'file-snapshot-blobs-v1'] as const).some((task) => {
      const phase = readMaintenanceState(db, task)?.phase;
      return isActiveMaintenancePhase(phase);
    });
    if (hasMigration) return true;
    return this.isSnapshotGcReady(db) &&
      Number(db.prepare('SELECT COUNT(*) FROM file_snapshot_gc_queue').pluck().get()) > 0;
  }

  private chooseRunnableTask(
    db: ReturnType<typeof getDb>,
  ): StorageMaintenanceTask | null {
    const other: StorageMaintenanceTask = this.nextTask === 'event-search-v1'
      ? 'file-snapshot-blobs-v1'
      : 'event-search-v1';
    for (const task of [this.nextTask, other]) {
      if (!this.canAttempt(task)) continue;
      if (isActiveMaintenancePhase(readMaintenanceState(db, task)?.phase)) return task;
    }
    return null;
  }

  private canAttempt(task: StorageMaintenanceTask, now = Date.now()): boolean {
    return (this.retryAt.get(task) ?? 0) <= now;
  }

  private nextScheduleDelay(defaultYieldMs: number): number {
    if (!this.hasActiveWork()) return this.options.idleDelayMs ?? 60_000;
    const db = getDb();
    const now = Date.now();
    const runnableMigration = (['event-search-v1', 'file-snapshot-blobs-v1'] as const).some(
      (task) =>
        this.canAttempt(task, now) &&
        isActiveMaintenancePhase(readMaintenanceState(db, task)?.phase),
    );
    const gcPending = this.isSnapshotGcReady(db) && Number(
      db.prepare('SELECT COUNT(*) FROM file_snapshot_gc_queue').pluck().get(),
    ) > 0;
    if (runnableMigration || (gcPending && this.canAttempt('file-snapshot-blobs-v1', now))) {
      return defaultYieldMs;
    }
    const futureRetries = [...this.retryAt.values()].filter((at) => at > now);
    if (futureRetries.length === 0) return this.options.idleDelayMs ?? 60_000;
    return Math.max(1, Math.min(...futureRetries) - now);
  }

  private ensureDiskHeadroom(
    db: ReturnType<typeof getDb>,
    task: StorageMaintenanceTask,
  ): void {
    if (readMaintenanceState(db, task)?.phase !== 'backfill' || db.name === ':memory:') return;
    const now = Date.now();
    if (now - this.diskGateCheckedAt < 60_000) return;
    const stats = statfsSync(dirname(db.name));
    const availableBytes = stats.bavail * stats.bsize;
    if (availableBytes < MIN_BACKFILL_FREE_BYTES) {
      throw new Error(
        `storage backfill paused: freeBytes=${availableBytes}, ` +
          `requiredBytes=${MIN_BACKFILL_FREE_BYTES}`,
      );
    }
    this.diskGateCheckedAt = now;
  }

  private isSnapshotGcReady(db: ReturnType<typeof getDb>): boolean {
    return readMaintenanceState(db, 'file-snapshot-blobs-v1')?.phase === 'complete';
  }

  private persistError(task: StorageMaintenanceTask, message: string): void {
    const db = getDb();
    const state = readMaintenanceState(db, task);
    if (state && state.phase !== 'complete' && state.phase !== 'retire-on-shutdown') {
      updateMaintenanceState(db, task, { lastError: message });
    }
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => this.tick(), Math.max(0, delayMs));
  }
}
