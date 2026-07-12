import { performance } from 'node:perf_hooks';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { StorageMaintenanceEngine } from './maintenance-engine';
import {
  STORAGE_MAINTENANCE_WORKER_KIND,
  type StorageMaintenanceCheckpointResult,
  type StorageMaintenanceWorkerCommand,
  type StorageMaintenanceWorkerData,
  type StorageMaintenanceWorkerMessage,
} from './maintenance-worker-contract';
import { boundedMaintenanceError } from './state';

interface CheckpointRow {
  busy: number;
  log: number;
  checkpointed: number;
}

/** PASSIVE is the only live checkpoint mode: it never waits for readers or writers to drain. */
export function runPassiveCheckpoint(db: Database.Database): StorageMaintenanceCheckpointResult {
  const started = performance.now();
  const rows = db.pragma('wal_checkpoint(PASSIVE)') as CheckpointRow[];
  const row = rows[0] ?? { busy: 0, log: 0, checkpointed: 0 };
  return { ...row, durationMs: performance.now() - started };
}

function runWorker(data: StorageMaintenanceWorkerData): void {
  if (!parentPort) return;
  const port = parentPort;
  const db = new Database(data.dbPath, { fileMustExist: true });
  let closed = false;
  let lastCheckpointAt = 0;
  let checkpointBacklog = 0;

  const closeDatabase = (): void => {
    if (closed) return;
    db.close();
    closed = true;
  };
  const fail = (cause: unknown): void => {
    let error = boundedMaintenanceError(cause);
    let closeSucceeded = false;
    try {
      try {
        closeDatabase();
        closeSucceeded = true;
      } catch (closeCause) {
        error = boundedMaintenanceError(
          `${error}; worker database close failed: ${boundedMaintenanceError(closeCause)}`,
        );
      }
      if (closeSucceeded) {
        // Fatal is observable only after the worker connection is closed, so lifecycle code cannot
        // interpret the message as permission to open shutdown maintenance concurrently.
        port.postMessage({ type: 'fatal', error } satisfies StorageMaintenanceWorkerMessage);
      }
    } finally {
      port.close();
    }
    // A close failure cannot use `fatal`, whose protocol meaning is "connection already closed".
    // Let Worker error/exit establish the safe replacement boundary after thread teardown instead.
    if (!closeSucceeded) throw new Error(error);
  };

  try {
    db.pragma('busy_timeout = 5000');
    db.pragma('foreign_keys = ON');
    db.pragma('trusted_schema = ON');
    const journalMode = String(db.pragma('journal_mode', { simple: true })).toLowerCase();
    if (journalMode !== 'wal') {
      throw new Error(`storage maintenance worker requires WAL mode (actual=${journalMode})`);
    }
    db.pragma(`wal_autocheckpoint = ${data.autoCheckpointPages}`);
    const engine = new StorageMaintenanceEngine(
      db,
      data.restartEligible,
      data.engineOptions,
    );

    const checkpoint = (): StorageMaintenanceCheckpointResult => {
      const result = runPassiveCheckpoint(db);
      lastCheckpointAt = Date.now();
      checkpointBacklog = Math.max(0, result.log - result.checkpointed);
      return result;
    };
    const maybeCheckpoint = (): StorageMaintenanceCheckpointResult | null => {
      if (
        checkpointBacklog < data.checkpointBacklogPages &&
        Date.now() - lastCheckpointAt < data.checkpointIntervalMs
      ) {
        return null;
      }
      return checkpoint();
    };

    port.on('message', (command: StorageMaintenanceWorkerCommand) => {
      if (closed) return;
      try {
        if (command.type === 'run-slice') {
          const checkpointResult = maybeCheckpoint();
          const pausedForCheckpoint = checkpointBacklog >= data.checkpointBacklogPages;
          const tick = pausedForCheckpoint ? null : engine.runTick();
          port.postMessage({
            type: 'slice-result',
            requestId: command.requestId,
            tick,
            checkpoint: checkpointResult,
            pausedForCheckpoint,
            nextDelayMs: pausedForCheckpoint
              ? data.checkpointRetryMs
              : (tick?.nextDelayMs ?? data.checkpointRetryMs),
          } satisfies StorageMaintenanceWorkerMessage);
          return;
        }
        if (command.type === 'checkpoint') {
          port.postMessage({
            type: 'checkpoint-result',
            requestId: command.requestId,
            checkpoint: checkpoint(),
          } satisfies StorageMaintenanceWorkerMessage);
          return;
        }
        if (command.type === 'close') {
          const finalCheckpoint = checkpoint();
          closeDatabase();
          port.postMessage({
            type: 'closed',
            requestId: command.requestId,
            checkpoint: finalCheckpoint,
          } satisfies StorageMaintenanceWorkerMessage);
          port.close();
        }
      } catch (cause) {
        fail(cause);
      }
    });

    port.postMessage({
      type: 'ready',
      autoCheckpointPages: data.autoCheckpointPages,
    } satisfies StorageMaintenanceWorkerMessage);
  } catch (cause) {
    fail(cause);
  }
}

function isWorkerData(value: unknown): value is StorageMaintenanceWorkerData {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const data = value as Record<string, unknown>;
  return data.kind === STORAGE_MAINTENANCE_WORKER_KIND &&
    typeof data.dbPath === 'string' && data.dbPath.length > 0 &&
    Array.isArray(data.restartEligible) &&
    typeof data.engineOptions === 'object' && data.engineOptions !== null &&
    isPositiveInteger(data.autoCheckpointPages) &&
    isPositiveInteger(data.checkpointIntervalMs) &&
    isPositiveInteger(data.checkpointBacklogPages) &&
    isPositiveInteger(data.checkpointRetryMs);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

// The explicit marker prevents Vitest's own worker pool from executing this entry accidentally.
if (!isMainThread && parentPort && isWorkerData(workerData)) runWorker(workerData);
