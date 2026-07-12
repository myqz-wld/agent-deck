import type { StorageShutdownTaskResults } from './shutdown-tasks';

export const STORAGE_SHUTDOWN_WORKER_KIND = 'agent-deck-storage-shutdown-v1';

export interface StorageShutdownWorkerData {
  kind: typeof STORAGE_SHUTDOWN_WORKER_KIND;
  dbPath: string;
}

export type StorageShutdownWorkerMessage =
  | { type: 'task-start' }
  | { type: 'result'; results: StorageShutdownTaskResults }
  | { type: 'fatal'; error: string };
