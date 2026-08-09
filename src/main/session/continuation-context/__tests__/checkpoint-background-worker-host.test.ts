import { describe, expect, it, vi } from 'vitest';
import type { CheckpointBackgroundWorkerLike } from '../checkpoint-background-worker-client';
import {
  CHECKPOINT_BACKGROUND_WORKER_KIND,
  type CheckpointBackgroundWorkerData,
} from '../checkpoint-background-worker-contract';

const mocks = vi.hoisted(() => ({
  createNodeWorker: vi.fn(),
}));

vi.mock('../checkpoint-background-worker?nodeWorker', () => ({
  default: mocks.createNodeWorker,
}));

import { createDesktopCheckpointBackgroundWorker } from '../checkpoint-background-worker-host';

describe('checkpoint background desktop worker host', () => {
  it('owns the Electron-Vite transform and preserves the exact worker identity', () => {
    const worker = {} as CheckpointBackgroundWorkerLike;
    const data: CheckpointBackgroundWorkerData = {
      kind: CHECKPOINT_BACKGROUND_WORKER_KIND,
      dbPath: '/tmp/agent-deck-background-host.test.db',
      sessionId: 'session-a',
      maxSourceBytes: 1024,
      maxRows: 10,
      maxWireBytes: 2048,
    };
    mocks.createNodeWorker.mockReturnValueOnce(worker);

    expect(createDesktopCheckpointBackgroundWorker(data)).toBe(worker);
    expect(mocks.createNodeWorker).toHaveBeenCalledWith({
      name: 'agent-deck-checkpoint-background',
      workerData: data,
    });
  });
});
