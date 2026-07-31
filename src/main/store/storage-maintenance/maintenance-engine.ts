import type { Database } from 'better-sqlite3';
import { runSnapshotGcSlice, type SnapshotMaintenanceSliceResult } from './file-snapshots';

export interface MaintenanceEngineOptions {
  yieldDelayMs?: number;
  idleDelayMs?: number;
  errorRetryMs?: number;
}

export interface MaintenanceEngineTick {
  result: SnapshotMaintenanceSliceResult | null;
  error: { task: 'file-snapshot-gc'; message: string } | null;
  nextDelayMs: number;
}

/** Owns synchronous GC slice policy for the dedicated SQLite maintenance connection. */
export class StorageMaintenanceEngine {
  private retryAt = 0;

  constructor(
    private readonly db: Database,
    private readonly options: MaintenanceEngineOptions = {},
  ) {}

  runTick(now = Date.now()): MaintenanceEngineTick {
    let result: SnapshotMaintenanceSliceResult | null = null;
    let error: MaintenanceEngineTick['error'] = null;
    if (now >= this.retryAt) {
      try {
        result = runSnapshotGcSlice(this.db);
        this.retryAt = 0;
      } catch (cause) {
        error = { task: 'file-snapshot-gc', message: boundedMaintenanceError(cause) };
        this.retryAt = now + (this.options.errorRetryMs ?? 30_000);
      }
    }
    return {
      result,
      error,
      nextDelayMs: this.nextScheduleDelay(now),
    };
  }
  private nextScheduleDelay(now: number): number {
    if (this.retryAt > now) return Math.max(1, this.retryAt - now);
    const pending = Number(
      this.db.prepare('SELECT COUNT(*) FROM file_snapshot_gc_queue').pluck().get(),
    );
    return pending > 0
      ? (this.options.yieldDelayMs ?? 25)
      : (this.options.idleDelayMs ?? 60_000);
  }
}

export function boundedMaintenanceError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, ' ').trim().slice(0, 2_000);
}
