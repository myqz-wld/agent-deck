import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcMain } from 'electron';
import { IpcInvoke } from '@shared/ipc-channels';
import { IpcInputError } from '../_helpers';
import { rememberSessionFocusRequest } from '@main/session-focus-request';

const setPinned = vi.hoisted(() => vi.fn());

vi.mock('@main/session/manager', () => ({
  sessionManager: {
    setPinned,
    list: vi.fn(),
    get: vi.fn(),
    archive: vi.fn(),
    unarchive: vi.fn(),
    reactivate: vi.fn(),
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
vi.mock('@main/store/file-change-repo', () => ({
  fileChangeRepo: { listForSession: vi.fn() },
}));
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

describe('SessionSetPinned IPC', () => {
  beforeEach(() => {
    setPinned.mockReset().mockReturnValue({
      id: 'session-1',
      lifecycle: 'active',
      archivedAt: null,
      pinnedAt: 123,
    });
    vi.mocked(ipcMain.handle).mockClear();
    registerSessionsIpc();
  });

  it('validates the id and strict boolean before returning the committed record', () => {
    const handler = vi
      .mocked(ipcMain.handle)
      .mock.calls.find(([channel]) => channel === IpcInvoke.SessionSetPinned)?.[1];
    expect(handler).toBeTypeOf('function');

    expect(handler!({} as never, 'session-1', true)).toMatchObject({
      id: 'session-1',
      pinnedAt: 123,
    });
    expect(setPinned).toHaveBeenCalledWith('session-1', true);

    for (const invalid of [1, 'true', null, undefined]) {
      expect(() => handler!({} as never, 'session-1', invalid)).toThrow(IpcInputError);
    }
    expect(() => handler!({} as never, '', false)).toThrow(IpcInputError);
    expect(setPinned).toHaveBeenCalledTimes(1);
  });

  it('lets a cold renderer consume the latest pending focus request once', () => {
    rememberSessionFocusRequest('session-focus');
    const handler = vi
      .mocked(ipcMain.handle)
      .mock.calls.find(([channel]) => channel === IpcInvoke.SessionTakePendingFocus)?.[1];
    expect(handler).toBeTypeOf('function');
    expect(handler!({} as never)).toBe('session-focus');
    expect(handler!({} as never)).toBeNull();
  });
});
