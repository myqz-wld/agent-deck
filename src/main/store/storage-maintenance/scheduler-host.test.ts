import { describe, expect, it, vi } from 'vitest';
import type { StorageMaintenanceWorkerLike } from './scheduler';
import {
  STORAGE_MAINTENANCE_WORKER_KIND,
  type StorageMaintenanceWorkerData,
} from './maintenance-worker-contract';

const mocks = vi.hoisted(() => ({
  createNodeWorker: vi.fn(),
}));

vi.mock('./maintenance-worker?nodeWorker', () => ({
  default: mocks.createNodeWorker,
}));

import { createDesktopStorageMaintenanceWorker } from './scheduler-host';

describe('storage maintenance desktop worker host', () => {
  it('owns the Electron-Vite transform and preserves the exact worker identity', () => {
    const worker = {} as StorageMaintenanceWorkerLike;
    const data: StorageMaintenanceWorkerData = {
      kind: STORAGE_MAINTENANCE_WORKER_KIND,
      dbPath: '/tmp/agent-deck-storage-maintenance-host.test.db',
      engineOptions: {},
      autoCheckpointPages: 1_000,
      checkpointIntervalMs: 5_000,
      checkpointBacklogPages: 1_000,
      checkpointRetryMs: 250,
    };
    mocks.createNodeWorker.mockReturnValueOnce(worker);

    expect(createDesktopStorageMaintenanceWorker(data)).toBe(worker);
    expect(mocks.createNodeWorker).toHaveBeenCalledWith({
      name: 'agent-deck-storage-maintenance',
      workerData: data,
    });
  });
});
