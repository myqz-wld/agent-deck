import type { MaintenanceEngineTick } from './maintenance-engine';
import type { StorageMaintenanceCheckpointResult } from './maintenance-worker-contract';

export interface StorageMaintenanceDiagnosticLogger {
  info(message: string, ...details: unknown[]): void;
  warn(message: string, ...details: unknown[]): void;
}

/** Bounded diagnostics for GC slices and worker-owned WAL checkpoints. */
export class StorageMaintenanceDiagnostics {
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
}
