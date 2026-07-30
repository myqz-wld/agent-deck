import type { Database } from 'better-sqlite3';
import createStorageMaintenanceWorker from './maintenance-worker?nodeWorker';
import { getDb } from '../db';
import type { MaintenanceEngineOptions } from './maintenance-engine';
import {
  STORAGE_MAINTENANCE_WORKER_KIND,
  type StorageMaintenanceWorkerCommand,
  type StorageMaintenanceWorkerData,
  type StorageMaintenanceWorkerMessage,
} from './maintenance-worker-contract';
import { StorageMaintenanceDiagnostics } from './scheduler-diagnostics';
import { MainWalCheckpointLease } from './main-checkpoint-lease';
import { readMaintenanceState, type StorageMaintenanceTask } from './state';
import log from '@main/utils/logger';

export { isActiveMaintenancePhase } from './maintenance-engine';

const logger = log.scope('storage-maintenance');
const DEFAULT_AUTO_CHECKPOINT_PAGES = 1_000;

export interface SchedulerOptions extends MaintenanceEngineOptions {
  initialDelayMs?: number;
  slowSliceMs?: number;
  checkpointIntervalMs?: number;
  checkpointBacklogPages?: number;
  checkpointRetryMs?: number;
  workerAutoCheckpointPages?: number;
  requestTimeoutMs?: number;
}

export interface StorageMaintenanceWorkerLike {
  postMessage(command: StorageMaintenanceWorkerCommand): void;
  on(event: 'message', listener: (message: StorageMaintenanceWorkerMessage) => void): this;
  on(event: 'messageerror', listener: (error: Error) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'exit', listener: (code: number) => void): this;
}

export interface StorageMaintenanceSchedulerDependencies {
  getDatabase(): Database;
  createWorker(data: StorageMaintenanceWorkerData): StorageMaintenanceWorkerLike;
  now(): number;
}

const DEFAULT_DEPENDENCIES: StorageMaintenanceSchedulerDependencies = {
  getDatabase: getDb,
  createWorker: (workerData) => createStorageMaintenanceWorker({
    name: 'agent-deck-storage-maintenance',
    workerData,
  }),
  now: Date.now,
};

interface ActiveWorker {
  generation: number;
  instance: StorageMaintenanceWorkerLike;
  ready: boolean;
  retiring: boolean;
  failureReason: string | null;
}

interface InFlightRequest {
  id: number;
  type: StorageMaintenanceWorkerCommand['type'];
}

/**
 * Main-process controller for the persistent maintenance/checkpoint worker. No staged SQLite query,
 * codec operation, write, or checkpoint is executed by this class.
 */
export class StorageMaintenanceScheduler {
  private timer: NodeJS.Timeout | null = null;
  private respawnTimer: NodeJS.Timeout | null = null;
  private requestTimer: NodeJS.Timeout | null = null;
  private stopped = true;
  private terminalDisabled = false;
  private terminalCloseRequested = false;
  private worker: ActiveWorker | null = null;
  private workerGeneration = 0;
  private requestId = 0;
  private inFlight: InFlightRequest | null = null;
  private mainDb: Database | null = null;
  private readonly checkpointLease = new MainWalCheckpointLease();
  private restartEligible: StorageMaintenanceTask[] = [];
  private maintenanceStartsAt = 0;
  private nextSliceAt = 0;
  private stopWaiter: { promise: Promise<void>; resolve: () => void } | null = null;
  private readonly diagnostics: StorageMaintenanceDiagnostics;

  constructor(
    private readonly options: SchedulerOptions = {},
    private readonly dependencies: StorageMaintenanceSchedulerDependencies = DEFAULT_DEPENDENCIES,
  ) {
    this.diagnostics = new StorageMaintenanceDiagnostics(
      this.options.slowSliceMs ?? 50,
      () => this.dependencies.now(),
      logger,
    );
  }

  start(): void {
    if (!this.stopped || this.terminalDisabled) return;
    this.stopped = false;
    this.mainDb = this.dependencies.getDatabase();
    this.restartEligible = (['event-search-v1', 'file-snapshot-blobs-v1'] as const).filter(
      (task) => readMaintenanceState(this.mainDb!, task)?.phase === 'awaiting-restart',
    );
    this.maintenanceStartsAt = this.dependencies.now() + (this.options.initialDelayMs ?? 15_000);
    this.nextSliceAt = this.maintenanceStartsAt;
    this.spawnWorker();
  }

  /** Waits for the current synchronous request and asks the worker to checkpoint and close. */
  stop(): Promise<void> {
    if (this.stopped) return this.stopWaiter?.promise ?? Promise.resolve();
    this.stopped = true;
    this.clearTimers();
    const promise = new Promise<void>((resolve) => {
      this.stopWaiter = { promise: Promise.resolve(), resolve };
    });
    this.stopWaiter!.promise = promise;
    if (!this.worker) {
      this.releaseMainCheckpointLease();
      this.finishStop();
      return promise;
    }
    // Queue close behind a synchronous request so a lost active reply cannot hang shutdown.
    if (this.worker.ready) this.queueCloseAfterCurrent();
    return promise;
  }

  private spawnWorker(): void {
    if (this.stopped || this.terminalDisabled) return;
    this.clearRespawnTimer();
    const generation = ++this.workerGeneration;
    const workerData: StorageMaintenanceWorkerData = {
      kind: STORAGE_MAINTENANCE_WORKER_KIND,
      dbPath: this.mainDb!.name,
      restartEligible: [...this.restartEligible],
      engineOptions: {
        yieldDelayMs: this.options.yieldDelayMs,
        idleDelayMs: this.options.idleDelayMs,
        errorRetryMs: this.options.errorRetryMs,
      },
      autoCheckpointPages: this.options.workerAutoCheckpointPages ??
        DEFAULT_AUTO_CHECKPOINT_PAGES,
      checkpointIntervalMs: this.options.checkpointIntervalMs ?? 5_000,
      checkpointBacklogPages: this.options.checkpointBacklogPages ?? 1_000,
      checkpointRetryMs: this.options.checkpointRetryMs ?? 250,
    };
    try {
      const instance = this.dependencies.createWorker(workerData);
      this.worker = {
        generation,
        instance,
        ready: false,
        retiring: false,
        failureReason: null,
      };
      instance.on('message', (message) => this.onWorkerMessage(generation, message));
      instance.on('messageerror', (error) => this.retireWorker(generation, error));
      instance.on('error', (error) => this.retireWorker(generation, error));
      instance.on('exit', (code) => {
        if (this.worker?.generation === generation) {
          this.completeWorkerExit(
            generation,
            new Error(`storage maintenance worker exited unexpectedly (code=${code})`),
          );
        }
      });
    } catch (error) {
      this.scheduleRespawn(error);
    }
  }

  private onWorkerMessage(
    generation: number,
    message: StorageMaintenanceWorkerMessage,
  ): void {
    if (this.worker?.generation !== generation) return;
    if (this.terminalDisabled) {
      if (message.type === 'fatal') {
        this.completeWorkerExit(generation, new Error(message.error));
      } else if (message.type === 'closed') {
        this.inFlight = null;
        this.clearRequestTimerHandle();
        this.diagnostics.observeCheckpoint(message.checkpoint);
        this.worker = null;
        this.releaseMainCheckpointLease();
        if (this.stopped) this.finishStop();
      }
      return;
    }
    if (message.type === 'ready') {
      this.onWorkerReady(generation, message.autoCheckpointPages);
      return;
    }
    if (message.type === 'fatal') {
      // Worker fatal is emitted only after its SQLite connection has closed.
      this.completeWorkerExit(generation, new Error(message.error));
      return;
    }
    if (!this.takeRequest(message.requestId, message.type)) return;

    if (message.type === 'slice-result') {
      if (message.checkpoint) this.diagnostics.observeCheckpoint(message.checkpoint);
      if (message.tick) this.diagnostics.observeTick(message.tick);
      if (message.pausedForCheckpoint) {
        this.diagnostics.warnCheckpointBacklog(message.checkpoint);
      }
      this.nextSliceAt = this.dependencies.now() + message.nextDelayMs;
      this.afterRequest();
      return;
    }
    if (message.type === 'checkpoint-result') {
      this.diagnostics.observeCheckpoint(message.checkpoint);
      this.afterRequest();
      return;
    }
    this.diagnostics.observeCheckpoint(message.checkpoint);
    const retired = this.worker?.retiring === true;
    const reason = this.worker?.failureReason ?? 'worker retired';
    this.worker = null;
    this.releaseMainCheckpointLease();
    if (this.stopped) this.finishStop();
    else if (retired && !this.terminalDisabled) this.scheduleRespawn(new Error(reason));
  }

  private onWorkerReady(generation: number, autoCheckpointPages: number): void {
    if (
      this.worker?.generation !== generation ||
      this.worker.ready ||
      this.worker.retiring
    ) return;
    if (this.stopped) {
      this.worker.ready = true;
      this.queueCloseAfterCurrent();
      return;
    }
    const expected = this.options.workerAutoCheckpointPages ?? DEFAULT_AUTO_CHECKPOINT_PAGES;
    if (autoCheckpointPages !== expected) {
      this.retireWorker(
        generation,
        new Error(
          `storage maintenance worker checkpoint threshold mismatch ` +
            `(expected=${expected}, actual=${autoCheckpointPages})`,
        ),
      );
      return;
    }
    try {
      this.acquireMainCheckpointLease();
    } catch (error) {
      this.retireWorker(generation, error);
      return;
    }
    this.worker.ready = true;
    logger.info('[storage-maintenance] worker ready; WAL checkpoints isolated from Electron main');
    this.scheduleNextRequest();
  }

  private scheduleNextRequest(): void {
    if (this.stopped || this.terminalDisabled || !this.worker?.ready || this.inFlight) return;
    if (this.timer) clearTimeout(this.timer);
    const now = this.dependencies.now();
    const checkpointInterval = this.options.checkpointIntervalMs ?? 5_000;
    const delay = Math.max(0, Math.min(this.nextSliceAt - now, checkpointInterval));
    this.timer = setTimeout(() => this.dispatchNextRequest(), delay);
  }

  private dispatchNextRequest(): void {
    this.timer = null;
    if (this.stopped || this.terminalDisabled || !this.worker?.ready || this.inFlight) return;
    if (this.dependencies.now() >= this.nextSliceAt) this.sendRequest('run-slice');
    else this.sendRequest('checkpoint');
  }

  private sendRequest(type: 'run-slice' | 'checkpoint' | 'close'): void {
    if (!this.worker || this.inFlight || this.terminalDisabled) return;
    const requestId = ++this.requestId;
    this.inFlight = { id: requestId, type };
    try {
      this.worker.instance.postMessage({ type, requestId });
      this.startRequestTimer(this.worker.generation, requestId, type);
    } catch (error) {
      this.inFlight = null;
      this.retireWorker(this.worker.generation, error);
    }
  }

  private sendClose(): void { this.sendRequest('close'); }

  private queueCloseAfterCurrent(): void {
    if (this.terminalDisabled) {
      this.queueTerminalClose();
      return;
    }
    if (!this.worker || this.inFlight?.type === 'close') return;
    const generation = this.worker.generation;
    const requestId = ++this.requestId;
    this.clearRequestTimerHandle();
    // The prior result becomes stale; worker serialization still completes it before this close.
    this.inFlight = { id: requestId, type: 'close' };
    try {
      this.worker.instance.postMessage({ type: 'close', requestId });
      this.startRequestTimer(generation, requestId, 'close');
    } catch (error) {
      this.inFlight = null;
      this.retireWorker(generation, error);
    }
  }

  private takeRequest(requestId: number, messageType: string): boolean {
    if (!this.inFlight || this.inFlight.id !== requestId) {
      logger.warn(
        `[storage-maintenance] ignored stale worker response ` +
          `(type=${messageType}, requestId=${requestId})`,
      );
      return false;
    }
    const expected = this.inFlight.type === 'run-slice'
      ? 'slice-result'
      : this.inFlight.type === 'checkpoint'
        ? 'checkpoint-result'
        : 'closed';
    if (messageType !== expected) {
      logger.warn(
        `[storage-maintenance] ignored mismatched worker response ` +
          `(expected=${expected}, actual=${messageType})`,
      );
      return false;
    }
    this.inFlight = null;
    this.clearRequestTimerHandle();
    return true;
  }

  private afterRequest(): void {
    if (this.stopped) this.sendClose();
    else this.scheduleNextRequest();
  }

  private acquireMainCheckpointLease(): void {
    this.checkpointLease.acquire(this.mainDb!);
  }

  private releaseMainCheckpointLease(): void {
    if (!this.checkpointLease.active || !this.mainDb) return;
    try {
      this.checkpointLease.release(this.mainDb);
    } catch (error) {
      logger.warn('[storage-maintenance] failed to restore main WAL autocheckpoint', error);
    }
  }

  private retireWorker(generation: number, error: unknown): void {
    if (this.worker?.generation !== generation) return;
    const message = error instanceof Error ? error.message : String(error);
    if (this.worker.retiring) return;
    this.worker.retiring = true;
    this.worker.failureReason = message;
    this.clearRequestTimer();
    this.clearRequestTimerHandle();
    this.inFlight = null;
    this.releaseMainCheckpointLease();
    logger.warn(
      `[storage-maintenance] worker unhealthy; main checkpoint safety restored, ` +
        `waiting for worker close: ${message}`,
    );
    const closeRequestId = ++this.requestId;
    this.inFlight = { id: closeRequestId, type: 'close' };
    try {
      this.worker.instance.postMessage({ type: 'close', requestId: closeRequestId });
    } catch {
      this.inFlight = null;
    }
  }

  private completeWorkerExit(generation: number, error: unknown): void {
    if (this.worker?.generation !== generation) return;
    const message = error instanceof Error ? error.message : String(error);
    this.clearRequestTimer();
    this.clearRequestTimerHandle();
    this.worker = null;
    this.inFlight = null;
    this.releaseMainCheckpointLease();
    if (this.stopped) {
      logger.warn(
        this.terminalDisabled
          ? 'terminal-disabled storage maintenance worker stopped during shutdown'
          : `[storage-maintenance] worker stopped after failure: ${message}`,
      );
      this.finishStop();
      return;
    }
    if (this.terminalDisabled) return;
    this.scheduleRespawn(error);
  }

  private startRequestTimer(
    generation: number,
    requestId: number,
    type: StorageMaintenanceWorkerCommand['type'],
  ): void {
    this.clearRequestTimerHandle();
    this.requestTimer = setTimeout(() => {
      this.requestTimer = null;
      if (this.inFlight?.id !== requestId) return;
      this.disableAfterRequestTimeout(generation, requestId, type);
    }, this.options.requestTimeoutMs ?? 15_000);
  }

  private scheduleRespawn(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`[storage-maintenance] worker unavailable; restoring main checkpoint safety: ${message}`);
    this.releaseMainCheckpointLease();
    if (this.stopped || this.terminalDisabled || this.respawnTimer) return;
    const retryMs = this.options.errorRetryMs ?? 30_000;
    this.nextSliceAt = Math.max(this.nextSliceAt, this.dependencies.now() + retryMs);
    this.respawnTimer = setTimeout(() => {
      this.respawnTimer = null;
      this.spawnWorker();
    }, retryMs);
  }

  private disableAfterRequestTimeout(
    generation: number,
    requestId: number,
    type: StorageMaintenanceWorkerCommand['type'],
  ): void {
    if (
      this.terminalDisabled ||
      this.worker?.generation !== generation ||
      this.inFlight?.id !== requestId
    ) return;
    this.terminalDisabled = true;
    this.worker.retiring = true;
    this.worker.failureReason = 'request-timeout';
    this.clearRequestTimer();
    this.clearRespawnTimer();
    this.clearRequestTimerHandle();
    this.releaseMainCheckpointLease();
    logger.warn(
      'storage maintenance worker timed out; maintenance disabled until restart',
    );
    if (type === 'close') {
      this.terminalCloseRequested = true;
      return;
    }
    this.inFlight = null;
    this.queueTerminalClose();
  }

  private queueTerminalClose(): void {
    if (!this.worker || this.terminalCloseRequested) return;
    this.terminalCloseRequested = true;
    const requestId = ++this.requestId;
    this.inFlight = { id: requestId, type: 'close' };
    try {
      this.worker.instance.postMessage({ type: 'close', requestId });
    } catch {
      this.inFlight = null;
    }
  }

  private finishStop(): void {
    const waiter = this.stopWaiter;
    this.stopWaiter = null;
    waiter?.resolve();
  }

  private clearTimers(): void {
    this.clearRequestTimer();
    this.clearRespawnTimer();
    this.clearRequestTimerHandle();
  }

  private clearRequestTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private clearRespawnTimer(): void {
    if (this.respawnTimer) clearTimeout(this.respawnTimer);
    this.respawnTimer = null;
  }

  private clearRequestTimerHandle(): void {
    if (this.requestTimer) clearTimeout(this.requestTimer);
    this.requestTimer = null;
  }
}
