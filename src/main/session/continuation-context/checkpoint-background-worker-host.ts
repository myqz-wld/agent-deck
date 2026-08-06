import createCheckpointBackgroundWorker from './checkpoint-background-worker?nodeWorker';
import {
  openCheckpointBackgroundSource,
  type CheckpointBackgroundChunkSource,
  type CheckpointBackgroundWorkerLike,
  type OpenCheckpointBackgroundSourceInput,
} from './checkpoint-background-worker-client';
import type { CheckpointBackgroundWorkerData } from './checkpoint-background-worker-contract';

export function createDesktopCheckpointBackgroundWorker(
  data: CheckpointBackgroundWorkerData,
): CheckpointBackgroundWorkerLike {
  return createCheckpointBackgroundWorker({
    name: 'agent-deck-checkpoint-background',
    workerData: data,
  });
}

/** Electron-Vite adapter for the otherwise host-neutral background checkpoint source. */
export function openDesktopCheckpointBackgroundSource(
  input: OpenCheckpointBackgroundSourceInput,
): Promise<CheckpointBackgroundChunkSource> {
  return openCheckpointBackgroundSource({
    ...input,
    createWorker: input.createWorker ?? createDesktopCheckpointBackgroundWorker,
  });
}
