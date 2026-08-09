import type { MaintenanceEngineTick } from './maintenance-engine';
import type { StorageMaintenanceCheckpointResult } from './maintenance-worker-contract';

export interface StorageMaintenanceDiagnosticLogger {
  info(message: string, ...details: unknown[]): void;
  warn(message: string, ...details: unknown[]): void;
}

export interface StorageMaintenanceDiagnosticPort {
  observeTick(tick: MaintenanceEngineTick): void;
  observeCheckpoint(checkpoint: StorageMaintenanceCheckpointResult): void;
  warnCheckpointBacklog(checkpoint: StorageMaintenanceCheckpointResult | null): void;
  workerReady(): void;
  ignoredStaleResponse(messageType: string, requestId: number): void;
  ignoredMismatchedResponse(expected: string, actual: string): void;
  failedToRestoreMainCheckpoint(error: unknown): void;
  workerUnhealthy(message: string): void;
  workerStopped(message: string, terminalDisabled: boolean): void;
  workerUnavailable(message: string): void;
  workerTimedOut(): void;
}

export const NOOP_STORAGE_MAINTENANCE_DIAGNOSTICS: StorageMaintenanceDiagnosticPort = {
  observeTick: () => undefined,
  observeCheckpoint: () => undefined,
  warnCheckpointBacklog: () => undefined,
  workerReady: () => undefined,
  ignoredStaleResponse: () => undefined,
  ignoredMismatchedResponse: () => undefined,
  failedToRestoreMainCheckpoint: () => undefined,
  workerUnhealthy: () => undefined,
  workerStopped: () => undefined,
  workerUnavailable: () => undefined,
  workerTimedOut: () => undefined,
};

/** Bounded diagnostics for GC slices and worker-owned WAL checkpoints. */
export class StorageMaintenanceDiagnostics implements StorageMaintenanceDiagnosticPort {
  private lastErrorLog: { signature: string; at: number } | null = null;
  private lastCheckpointWarningAt = 0;

  constructor(
    private readonly slowSliceMs: number,
    private readonly now: () => number,
    private readonly logger: StorageMaintenanceDiagnosticLogger,
  ) {}

  observeTick(tick: MaintenanceEngineTick): void {
    if (tick.error) {
      const now = this.now();
      if (
        !this.lastErrorLog ||
        this.lastErrorLog.signature !== tick.error.message ||
        now - this.lastErrorLog.at >= 5 * 60_000
      ) {
        this.logger.warn(
          `[storage-maintenance] snapshot GC failed; will retry: ${tick.error.message}`,
        );
        this.lastErrorLog = { signature: tick.error.message, at: now };
      }
    }
    if (!tick.result) return;
    this.lastErrorLog = null;
    if (tick.result.durationMs >= this.slowSliceMs) {
      this.logger.warn('[performance] slow storage maintenance worker slice', {
        task: tick.result.task,
        phase: tick.result.phase,
        processed: tick.result.processed,
        durationMs: Math.round(tick.result.durationMs),
      });
    }
  }

  observeCheckpoint(checkpoint: StorageMaintenanceCheckpointResult): void {
    if (checkpoint.durationMs >= this.slowSliceMs) {
      this.logger.warn('[performance] slow storage worker WAL checkpoint', {
        durationMs: Math.round(checkpoint.durationMs),
        busy: checkpoint.busy,
        walPages: checkpoint.log,
        checkpointedPages: checkpoint.checkpointed,
      });
    }
  }

  warnCheckpointBacklog(checkpoint: StorageMaintenanceCheckpointResult | null): void {
    const now = this.now();
    if (now - this.lastCheckpointWarningAt < 60_000) return;
    this.lastCheckpointWarningAt = now;
    this.logger.warn('[storage-maintenance] snapshot GC paused for WAL checkpoint backlog', {
      busy: checkpoint?.busy ?? 0,
      walPages: checkpoint?.log ?? 0,
      checkpointedPages: checkpoint?.checkpointed ?? 0,
    });
  }

  workerReady(): void {
    this.logger.info('[storage-maintenance] worker ready; WAL checkpoints isolated from Electron main');
  }

  ignoredStaleResponse(messageType: string, requestId: number): void {
    this.logger.warn(
      `[storage-maintenance] ignored stale worker response ` +
        `(type=${messageType}, requestId=${requestId})`,
    );
  }

  ignoredMismatchedResponse(expected: string, actual: string): void {
    this.logger.warn(
      `[storage-maintenance] ignored mismatched worker response ` +
        `(expected=${expected}, actual=${actual})`,
    );
  }

  failedToRestoreMainCheckpoint(error: unknown): void {
    this.logger.warn('[storage-maintenance] failed to restore main WAL autocheckpoint', error);
  }

  workerUnhealthy(message: string): void {
    this.logger.warn(
      `[storage-maintenance] worker unhealthy; main checkpoint safety restored, ` +
        `waiting for worker close: ${message}`,
    );
  }

  workerStopped(message: string, terminalDisabled: boolean): void {
    this.logger.warn(
      terminalDisabled
        ? 'terminal-disabled storage maintenance worker stopped during shutdown'
        : `[storage-maintenance] worker stopped after failure: ${message}`,
    );
  }

  workerUnavailable(message: string): void {
    this.logger.warn(
      `[storage-maintenance] worker unavailable; restoring main checkpoint safety: ${message}`,
    );
  }

  workerTimedOut(): void {
    this.logger.warn('storage maintenance worker timed out; maintenance disabled until restart');
  }
}
