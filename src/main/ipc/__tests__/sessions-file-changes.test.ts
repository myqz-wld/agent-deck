import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcMain } from 'electron';
import { IpcInvoke } from '@shared/ipc-channels';
import { IpcInputError } from '../_helpers';

const readRepo = vi.hoisted(() => ({
  listSummaryPage: vi.fn(),
  getPayload: vi.fn(),
}));

vi.mock('@main/store/file-change-read-repo', () => ({ fileChangeReadRepo: readRepo }));
vi.mock('@main/session/manager', () => ({
  sessionManager: {
    list: vi.fn(),
    get: vi.fn(),
    archive: vi.fn(),
    unarchive: vi.fn(),
    reactivate: vi.fn(),
    setPinned: vi.fn(),
    delete: vi.fn(),
    enrichWithTeamsBatch: vi.fn(),
  },
}));
vi.mock('@main/store/session-repo', () => ({
  sessionRepo: { get: vi.fn(), listHistory: vi.fn() },
  SessionRowMissingError: class SessionRowMissingError extends Error {},
}));
vi.mock('@main/store/agent-deck-team-repo', () => ({
  agentDeckTeamRepo: { findActiveTeamMembershipsBySession: vi.fn() },
}));
vi.mock('@main/store/event-repo', () => ({ eventRepo: { listForSession: vi.fn() } }));
vi.mock('@main/store/summary-repo', () => ({
  summaryRepo: { listForSession: vi.fn(), latestForSessions: vi.fn() },
}));
vi.mock('@main/store/task-repo', () => ({ taskRepo: { list: vi.fn() } }));
vi.mock('@main/session/final-file-diff', () => ({ getSessionFileFinalDiff: vi.fn() }));
vi.mock('@main/utils/logger', () => ({
  default: { scope: () => ({ warn: vi.fn() }) },
}));
vi.mock('../session-hand-off', () => ({ registerSessionHandOffIpc: vi.fn() }));

import { registerSessionsIpc } from '../sessions';

function handler(channel: string) {
  return vi.mocked(ipcMain.handle).mock.calls.find(([name]) => name === channel)?.[1];
}

describe('session file-change IPC', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readRepo.listSummaryPage.mockReturnValue({ items: [], nextCursor: null });
    readRepo.getPayload.mockReturnValue(null);
    registerSessionsIpc();
  });

  it('validates and forwards a bounded summary-page request', () => {
    const invoke = handler(IpcInvoke.SessionListFileChangePage);
    expect(invoke).toBeTypeOf('function');

    invoke!({} as never, 's1', { cursor: 'opaque', limit: 25 });

    expect(readRepo.listSummaryPage).toHaveBeenCalledWith('s1', {
      cursor: 'opaque',
      limit: 25,
    });
    expect(() => invoke!({} as never, 's1', { limit: 5000 })).toThrow(IpcInputError);
  });

  it('binds payload lookup to the requested session and numeric id', () => {
    const invoke = handler(IpcInvoke.SessionGetFileChange);
    expect(invoke).toBeTypeOf('function');

    invoke!({} as never, 's1', 42);
    expect(readRepo.getPayload).toHaveBeenCalledWith('s1', 42);
    expect(() => invoke!({} as never, 's1', '42')).toThrow(IpcInputError);
  });
});
