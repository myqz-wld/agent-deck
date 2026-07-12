import type { Database } from 'better-sqlite3';

export type StorageMaintenanceTask = 'event-search-v1' | 'file-snapshot-blobs-v1';

export interface StorageMaintenanceState {
  task: StorageMaintenanceTask;
  phase: string;
  cursor: number;
  upperBound: number;
  batchSize: number;
  lastError: string | null;
  updatedAt: number;
}

interface StateRow {
  task: StorageMaintenanceTask;
  phase: string;
  cursor: number;
  upper_bound: number;
  batch_size: number;
  last_error: string | null;
  updated_at: number;
}

export function readMaintenanceState(
  db: Database,
  task: StorageMaintenanceTask,
): StorageMaintenanceState | null {
  const row = db.prepare(
    `SELECT task, phase, cursor, upper_bound, batch_size, last_error, updated_at
       FROM storage_maintenance_state WHERE task = ?`,
  ).get(task) as StateRow | undefined;
  return row ? fromRow(row) : null;
}

export function updateMaintenanceState(
  db: Database,
  task: StorageMaintenanceTask,
  patch: Partial<Pick<
    StorageMaintenanceState,
    'phase' | 'cursor' | 'upperBound' | 'batchSize' | 'lastError'
  >>,
  now = Date.now(),
): void {
  const assignments: string[] = [];
  const values: unknown[] = [];
  const add = (column: string, value: unknown): void => {
    assignments.push(`${column} = ?`);
    values.push(value);
  };
  if (patch.phase !== undefined) add('phase', patch.phase);
  if (patch.cursor !== undefined) add('cursor', patch.cursor);
  if (patch.upperBound !== undefined) add('upper_bound', patch.upperBound);
  if (patch.batchSize !== undefined) add('batch_size', patch.batchSize);
  if (patch.lastError !== undefined) add('last_error', patch.lastError);
  add('updated_at', now);
  values.push(task);
  db.prepare(
    `UPDATE storage_maintenance_state SET ${assignments.join(', ')} WHERE task = ?`,
  ).run(...values);
}

export function adaptBatchSize(
  current: number,
  durationMs: number,
  limits: { min: number; max: number; targetMs?: number },
): number {
  const target = limits.targetMs ?? 18;
  if (durationMs > target * 1.4) return Math.max(limits.min, Math.floor(current / 2));
  if (durationMs < target * 0.45) return Math.min(limits.max, current * 2);
  return Math.min(limits.max, Math.max(limits.min, current));
}

export function boundedMaintenanceError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, ' ').trim().slice(0, 2_000);
}

function fromRow(row: StateRow): StorageMaintenanceState {
  return {
    task: row.task,
    phase: row.phase,
    cursor: row.cursor,
    upperBound: row.upper_bound,
    batchSize: row.batch_size,
    lastError: row.last_error,
    updatedAt: row.updated_at,
  };
}
