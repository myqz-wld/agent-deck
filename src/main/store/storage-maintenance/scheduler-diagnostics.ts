import type { MaintenanceEngineTick } from './maintenance-engine';
import type { StorageMaintenanceCheckpointResult } from './maintenance-worker-contract';
import type { StorageMaintenanceTask } from './state';

export interface StorageMaintenanceDiagnosticLogger {
  info(message: string, ...details: unknown[]): void;
  warn(message: string, ...details: unknown[]): void;
}

/** State-only diagnostics kept separate from the worker lifecycle controller. */
export class StorageMaintenanceDiagnostics {
  private readonly lastPhase = new Map<string, string>();
  private readonly lastProgress = new Map<string, number>();
  private readonly lastErrorLog = new Map<
    StorageMaintenanceTask,
    { signature: string; at: number }
  >();
  private lastCheckpointWarningAt = 0;

  constructor(
    private readonly slowSliceMs: number,
    private readonly now: () => number,
    private readonly logger: StorageMaintenanceDiagnosticLogger,
  ) {}

  observeTick(tick: MaintenanceEngineTick): void {
    for (const task of tick.restartTransitions) {
      this.logger.info(`[storage-maintenance] ${task} restart gate passed; verification resumed`);
    }
    if (tick.error) {
      const signature = `${tick.error.task}:${tick.error.message}`;
      const now = this.now();
      const prior = this.lastErrorLog.get(tick.error.task);
      if (!prior || prior.signature !== signature || now - prior.at >= 5 * 60_000) {
        this.logger.warn(
          `[storage-maintenance] worker slice failed; will retry: ${tick.error.message}`,
        );
        this.lastErrorLog.set(tick.error.task, { signature, at: now });
      }
    }
    if (!tick.result) return;
    const stateTask = tick.result.task === 'file-snapshot-gc'
      ? 'file-snapshot-blobs-v1'
      : tick.result.task;
    this.lastErrorLog.delete(stateTask);
    if (tick.result.durationMs >= this.slowSliceMs) {
      this.logger.warn('[performance] slow storage maintenance worker slice', {
        task: tick.result.task,
        phase: tick.result.phase,
        processed: tick.result.processed,
        durationMs: Math.round(tick.result.durationMs),
      });
    }
    const previousPhase = this.lastPhase.get(tick.result.task);
    if (previousPhase !== tick.result.phase) {
      this.lastPhase.set(tick.result.task, tick.result.phase);
      this.lastProgress.set(tick.result.task, 0);
      this.logger.info(
        `[storage-maintenance] ${tick.result.task} phase=${tick.result.phase} ` +
          `(processed=${tick.result.processed}, durationMs=${Math.round(tick.result.durationMs)})`,
      );
      return;
    }
    if (!tick.state || tick.result.task === 'file-snapshot-gc') return;
    const interval = tick.state.task === 'event-search-v1' ? 10_000 : 1_000;
    const previous = this.lastProgress.get(tick.state.task) ?? 0;
    if (tick.state.cursor - previous < interval) return;
    this.lastProgress.set(tick.state.task, tick.state.cursor);
    this.logger.info(
      `[storage-maintenance] ${tick.state.task} progress=${tick.state.cursor}/` +
        `${tick.state.upperBound} (batch=${tick.state.batchSize})`,
    );
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
    this.logger.warn('[storage-maintenance] staged writes paused for WAL checkpoint backlog', {
      busy: checkpoint?.busy ?? 0,
      walPages: checkpoint?.log ?? 0,
      checkpointedPages: checkpoint?.checkpointed ?? 0,
    });
  }
}
