import type { MaintenanceEngineTick, MaintenanceEngineOptions } from './maintenance-engine';
import type { StorageMaintenanceTask } from './state';

export const STORAGE_MAINTENANCE_WORKER_KIND = 'agent-deck-storage-maintenance-v1';

export interface StorageMaintenanceWorkerData {
  kind: typeof STORAGE_MAINTENANCE_WORKER_KIND;
  dbPath: string;
  restartEligible: StorageMaintenanceTask[];
  engineOptions: MaintenanceEngineOptions;
  autoCheckpointPages: number;
  checkpointIntervalMs: number;
  checkpointBacklogPages: number;
  checkpointRetryMs: number;
}

export type StorageMaintenanceWorkerCommand =
  | { type: 'run-slice'; requestId: number }
  | { type: 'checkpoint'; requestId: number }
  | { type: 'close'; requestId: number };

export interface StorageMaintenanceCheckpointResult {
  busy: number;
  log: number;
  checkpointed: number;
  durationMs: number;
}

export type StorageMaintenanceWorkerMessage =
  | { type: 'ready'; autoCheckpointPages: number }
  | {
      type: 'slice-result';
      requestId: number;
      tick: MaintenanceEngineTick | null;
      checkpoint: StorageMaintenanceCheckpointResult | null;
      pausedForCheckpoint: boolean;
      nextDelayMs: number;
    }
  | {
      type: 'checkpoint-result';
      requestId: number;
      checkpoint: StorageMaintenanceCheckpointResult;
    }
  | {
      type: 'closed';
      requestId: number;
      checkpoint: StorageMaintenanceCheckpointResult;
    }
  | { type: 'fatal'; error: string };
