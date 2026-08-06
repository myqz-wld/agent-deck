import { describe, expect, it, vi } from 'vitest';
import type { CheckpointBacklogWorkerLike } from '../checkpoint-backlog-worker-client';
import {
  CHECKPOINT_BACKLOG_WORKER_KIND,
  type CheckpointBacklogWorkerData,
} from '../checkpoint-backlog-worker-contract';

const mocks = vi.hoisted(() => ({
  createNodeWorker: vi.fn(),
}));

vi.mock('../checkpoint-backlog-worker?nodeWorker', () => ({
  default: mocks.createNodeWorker,
}));

import { createDesktopCheckpointBacklogWorker } from '../checkpoint-backlog-worker-host';

describe('checkpoint backlog desktop worker host', () => {
  it('owns the Electron-Vite transform and preserves the exact worker identity', () => {
    const worker = {} as CheckpointBacklogWorkerLike;
    const data: CheckpointBacklogWorkerData = {
      kind: CHECKPOINT_BACKLOG_WORKER_KIND,
      dbPath: '/tmp/agent-deck-backlog-host.test.db',
    };
    mocks.createNodeWorker.mockReturnValueOnce(worker);

    expect(createDesktopCheckpointBacklogWorker(data)).toBe(worker);
    expect(mocks.createNodeWorker).toHaveBeenCalledWith({
      name: 'agent-deck-checkpoint-backlog',
      workerData: data,
    });
  });
});
