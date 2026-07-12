import createStorageShutdownWorker from './shutdown-worker?nodeWorker';
import { awaitStorageShutdownWorker } from './shutdown-runner-protocol';
import {
  STORAGE_SHUTDOWN_WORKER_KIND,
  type StorageShutdownWorkerData,
} from './shutdown-contract';
import type { StorageShutdownTaskResults } from './shutdown-tasks';

/** Spawn the bundled worker only after lifecycle code has proven every ingress owner drained. */
export function runStorageShutdownMaintenance(
  dbPath: string,
): Promise<StorageShutdownTaskResults> {
  const workerData: StorageShutdownWorkerData = {
    kind: STORAGE_SHUTDOWN_WORKER_KIND,
    dbPath,
  };
  const worker = createStorageShutdownWorker({
    name: 'agent-deck-storage-shutdown',
    workerData,
  });
  return awaitStorageShutdownWorker(worker);
}
