import Database from 'better-sqlite3';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { boundedMaintenanceError } from './state';
import {
  runStorageShutdownTasks,
  type StorageShutdownTaskResults,
} from './shutdown-tasks';
import {
  STORAGE_SHUTDOWN_WORKER_KIND,
  type StorageShutdownWorkerData,
  type StorageShutdownWorkerMessage,
} from './shutdown-contract';

/** File-backed worker entry. The main process keeps its own connection open but idle. */
export function runStorageShutdownWorker(data: StorageShutdownWorkerData): StorageShutdownTaskResults {
  const db = new Database(data.dbPath);
  try {
    db.pragma('busy_timeout = 5000');
    db.pragma('foreign_keys = ON');
    db.pragma('trusted_schema = ON');
    return runStorageShutdownTasks(db);
  } finally {
    db.close();
  }
}

function isWorkerData(value: unknown): value is StorageShutdownWorkerData {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const data = value as Record<string, unknown>;
  return data.kind === STORAGE_SHUTDOWN_WORKER_KIND &&
    typeof data.dbPath === 'string' && data.dbPath.length > 0;
}

// The explicit marker prevents Vitest's own worker pool from accidentally executing this entry.
if (!isMainThread && parentPort && isWorkerData(workerData)) {
  parentPort.postMessage({ type: 'task-start' } satisfies StorageShutdownWorkerMessage);
  try {
    const results = runStorageShutdownWorker(workerData);
    parentPort.postMessage({ type: 'result', results } satisfies StorageShutdownWorkerMessage);
  } catch (error) {
    parentPort.postMessage({
      type: 'fatal',
      error: boundedMaintenanceError(error),
    } satisfies StorageShutdownWorkerMessage);
  }
}
