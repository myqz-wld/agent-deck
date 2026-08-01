import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IpcEvent } from '@shared/ipc-channels';
import type { CallerArchiveFailedEvent } from '@shared/types';

const mocks = vi.hoisted(() => ({
  on: vi.fn(),
  off: vi.fn(),
}));

vi.mock('electron', () => ({ ipcRenderer: mocks }));

import { eventsApi } from './events';

describe('preload archive-failure event contract', () => {
  beforeEach(() => vi.clearAllMocks());

  it('forwards the shared payload and unsubscribes the exact listener', () => {
    const callback = vi.fn();
    const unsubscribe = eventsApi.onCallerArchiveFailed(callback);
    const handler = mocks.on.mock.calls[0]?.[1] as
      | ((event: unknown, payload: CallerArchiveFailedEvent) => void)
      | undefined;
    const payload: CallerArchiveFailedEvent = {
      sessionId: 'source-session',
      toolName: 'SessionHandOffCommit',
      reason: 'archive database remained locked',
      reasonKind: 'archive-throw',
    };

    expect(mocks.on).toHaveBeenCalledWith(IpcEvent.CallerArchiveFailed, handler);
    handler?.({}, payload);
    expect(callback).toHaveBeenCalledWith(payload);

    unsubscribe();
    expect(mocks.off).toHaveBeenCalledWith(IpcEvent.CallerArchiveFailed, handler);
  });
});
