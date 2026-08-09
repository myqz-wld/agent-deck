import createCheckpointBacklogWorker from './checkpoint-backlog-worker?nodeWorker';
import {
  CheckpointBacklogWorkerClient,
  type CheckpointBacklogEstimator,
  type CheckpointBacklogWorkerClientOptions,
  type CheckpointBacklogWorkerLike,
} from './checkpoint-backlog-worker-client';
import type { CheckpointBacklogWorkerData } from './checkpoint-backlog-worker-contract';

export function createDesktopCheckpointBacklogWorker(
  data: CheckpointBacklogWorkerData,
): CheckpointBacklogWorkerLike {
  return createCheckpointBacklogWorker({
    name: 'agent-deck-checkpoint-backlog',
    workerData: data,
  });
}

/** Electron-Vite adapter for the otherwise host-neutral checkpoint backlog RPC client. */
export function createDesktopCheckpointBacklogEstimator(
  dbPath: string,
  options: CheckpointBacklogWorkerClientOptions = {},
): CheckpointBacklogEstimator {
  return new CheckpointBacklogWorkerClient(dbPath, {
    ...options,
    createWorker: options.createWorker ?? createDesktopCheckpointBacklogWorker,
  });
}
