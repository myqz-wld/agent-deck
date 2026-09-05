import { describe, expect, it, vi } from 'vitest';
import {
  findClaudeSessionCore,
  retireClaudeSessionAfterCurrentTurnCore,
  setClaudePermissionModeCore,
  type ClaudeLifecycleSession,
  type ClaudeSessionLifecycleHost,
} from './session-lifecycle-core';

function makeSession(): ClaudeLifecycleSession {
  return {
    applicationSid: 'application',
    cliSessionId: 'native',
    query: {
      interrupt: vi.fn(async () => undefined),
      close: vi.fn(),
      setPermissionMode: vi.fn(async () => undefined),
    },
    streamDrained: Promise.resolve(),
    pendingUserMessages: ['queued'],
    notify: null,
    acceptedEnqueueFingerprints: new Map([['one', 'one']]),
    permissionMode: 'default',
  };
}

function makeHost(): ClaudeSessionLifecycleHost<ClaudeLifecycleSession, unknown> {
  return {
    cleanupSession: vi.fn(),
    hasPersistedSession: vi.fn(() => false),
    warn: vi.fn(),
    info: vi.fn(),
  };
}

describe('Claude session lifecycle Core', () => {
  it('resolves all runtime identities and seals retirement input synchronously', () => {
    const session = makeSession();
    const sessions = new Map([['map-key', session]]);
    expect(findClaudeSessionCore(sessions, 'native')?.internal).toBe(session);
    expect(findClaudeSessionCore(sessions, 'application')?.key).toBe('map-key');

    retireClaudeSessionAfterCurrentTurnCore(sessions, 'native');
    expect(session.retireRequested).toBe(true);
    expect(session.pendingUserMessages).toEqual([]);
    expect(session.acceptedEnqueueFingerprints).toHaveLength(0);
  });

  it('serializes permission updates and rolls back a failed provider update', async () => {
    const session = makeSession();
    vi.mocked(session.query.setPermissionMode)
      .mockRejectedValueOnce(new Error('first failed'))
      .mockResolvedValueOnce(undefined);
    const sessions = new Map([['session', session]]);
    const host = makeHost();

    const first = setClaudePermissionModeCore(
      { sessions, sessionId: 'session', mode: 'plan' }, host,
    );
    const second = setClaudePermissionModeCore(
      { sessions, sessionId: 'session', mode: 'bypassPermissions' }, host,
    );
    await expect(first).rejects.toThrow('first failed');
    await expect(second).resolves.toBeUndefined();
    expect(session.permissionMode).toBe('bypassPermissions');
    expect(session.query.setPermissionMode).toHaveBeenNthCalledWith(1, 'plan');
    expect(session.query.setPermissionMode).toHaveBeenNthCalledWith(2, 'bypassPermissions');
  });
});
