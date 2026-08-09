import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Query } from '@anthropic-ai/claude-agent-sdk';
import { makeInternalSession, type InternalSession } from '../types';
import { closeClaudeSessionForRollback } from '../session-lifecycle';
import { sessionManager } from '@main/session/manager';

vi.mock('@main/session/manager', () => ({
  sessionManager: {
    releaseSdkClaim: vi.fn(),
    markRecentlyDeleted: vi.fn(),
  },
}));

function setup(interrupt: () => Promise<void> = async () => undefined): {
  sessions: Map<string, InternalSession>;
  internal: InternalSession;
} {
  const internal = makeInternalSession({
    cwd: '/repo',
    permissionMode: 'default',
    applicationSid: 'child',
  });
  internal.cliSessionId = 'native-child';
  internal.query = { interrupt: vi.fn(interrupt) } as unknown as Query;
  return { sessions: new Map([['child', internal]]), internal };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('Claude strict rollback close', () => {
  it('keeps ownership until provider stream drain proves termination', async () => {
    const { sessions, internal } = setup();
    const closing = closeClaudeSessionForRollback({
      sessions,
      emit: vi.fn(),
      sessionId: 'child',
    }, sessionManager);
    await Promise.resolve();

    expect(sessions.get('child')).toBe(internal);
    expect(sessionManager.releaseSdkClaim).not.toHaveBeenCalled();

    internal.resolveStreamDrained();
    await closing;

    expect(sessions.has('child')).toBe(false);
    expect(sessionManager.releaseSdkClaim).toHaveBeenCalledWith('child');
    expect(sessionManager.releaseSdkClaim).toHaveBeenCalledWith('native-child');
  });

  it('rejects a bounded drain timeout and retains the runtime for retry', async () => {
    vi.useFakeTimers();
    const { sessions, internal } = setup();
    const closing = closeClaudeSessionForRollback({
      sessions,
      emit: vi.fn(),
      sessionId: 'child',
    }, sessionManager);
    const rejection = expect(closing).rejects.toThrow(/could not prove provider stream termination/);

    await vi.advanceTimersByTimeAsync(1_000);
    await rejection;

    expect(sessions.get('child')).toBe(internal);
    expect(internal.expectedClose).toBeUndefined();
    expect(sessionManager.releaseSdkClaim).not.toHaveBeenCalled();
  });

  it('accepts interrupt failure only when an independent drain proves provider termination', async () => {
    const { sessions, internal } = setup(async () => {
      throw new Error('interrupt failed');
    });
    const closing = closeClaudeSessionForRollback({
      sessions,
      emit: vi.fn(),
      sessionId: 'child',
    }, sessionManager);
    internal.resolveStreamDrained();

    await expect(closing).resolves.toBeUndefined();
    expect(sessions.has('child')).toBe(false);
  });

  it('rejects a missing runtime instead of treating database lifecycle as proof', async () => {
    await expect(closeClaudeSessionForRollback({
      sessions: new Map(),
      emit: vi.fn(),
      sessionId: 'child',
    }, sessionManager)).rejects.toThrow(/cannot prove a live target runtime/);
  });
});
