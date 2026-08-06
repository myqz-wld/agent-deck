import createStorageMaintenanceWorker from './maintenance-worker?nodeWorker';
import { getDb } from '../db';
import log from '@main/utils/logger';
import {
  StorageMaintenanceScheduler,
  type SchedulerOptions,
  type StorageMaintenanceWorkerLike,
} from './scheduler';
import type { StorageMaintenanceWorkerData } from './maintenance-worker-contract';
import { StorageMaintenanceDiagnostics } from './scheduler-diagnostics';

const logger = log.scope('storage-maintenance');

export function createDesktopStorageMaintenanceWorker(
  data: StorageMaintenanceWorkerData,
): StorageMaintenanceWorkerLike {
  return createStorageMaintenanceWorker({
    name: 'agent-deck-storage-maintenance',
    workerData: data,
  });
}

/** Electron-Vite composition for the otherwise host-neutral storage maintenance scheduler. */
export function createDesktopStorageMaintenanceScheduler(
  options: SchedulerOptions = {},
): StorageMaintenanceScheduler {
  return new StorageMaintenanceScheduler(options, {
    getDatabase: getDb,
    createWorker: createDesktopStorageMaintenanceWorker,
    now: Date.now,
    diagnostics: new StorageMaintenanceDiagnostics(
      options.slowSliceMs ?? 50,
      Date.now,
      logger,
    ),
  });
}
