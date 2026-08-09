import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@shared/types';
import {
  cancelClaudePendingAndEmitCore,
  runClaudeCloseSessionCleanupCore,
  type ClaudePendingCancellationHost,
  type ClaudePendingCancellationSession,
} from './pending-cancellation-core';

function makeSession(): ClaudePendingCancellationSession {
  return {
    applicationSid: 'application',
    cliSessionId: 'native',
    pendingPermissions: new Map(),
    pendingAskUserQuestions: new Map(),
    pendingExitPlanModes: new Map(),
    pendingUserMessages: ['queued'],
    submittingUserMessage: { id: 'submitting' },
    ignoredUserMessageIds: new Set(['ignored']),
    acceptedEnqueueFingerprints: new Map([['fingerprint', 'accepted']]),
    notify: null,
  };
}

function makeHost(
  trace: string[] = [],
): ClaudePendingCancellationHost<ClaudePendingCancellationSession> {
  return {
    now: vi.fn(() => 100),
    cleanupGatewaySandboxSettings: vi.fn(() => trace.push('sandbox')),
    releaseSdkClaim: vi.fn((sessionId) => trace.push(`release:${sessionId}`)),
    markRecentlyDeleted: vi.fn((sessionId) => trace.push(`mark:${sessionId}`)),
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Claude pending cancellation Core', () => {
  it('emits and resolves all pending kinds before clearing their timers and maps', async () => {
    vi.useFakeTimers();
    const session = makeSession();
    const permissionResolver = vi.fn();
    const askResolver = vi.fn();
    const exitResolver = vi.fn();
    const timerCallback = vi.fn();
    session.pendingPermissions = new Map([['permission', {
      payload: { requestId: 'permission' },
      resolver: permissionResolver,
      timer: setTimeout(timerCallback, 1_000) as unknown as NodeJS.Timeout,
    }]]);
    session.pendingAskUserQuestions = new Map([['ask', {
      payload: { requestId: 'ask' },
      resolver: askResolver,
      timer: setTimeout(timerCallback, 1_000) as unknown as NodeJS.Timeout,
    }]]);
    session.pendingExitPlanModes = new Map([['exit', {
      payload: { requestId: 'exit' },
      resolver: exitResolver,
      timer: setTimeout(timerCallback, 1_000) as unknown as NodeJS.Timeout,
    }]]);
    const emitted: AgentEvent[] = [];
    const now = vi.fn()
      .mockReturnValueOnce(101)
      .mockReturnValueOnce(102)
      .mockReturnValueOnce(103);

    cancelClaudePendingAndEmitCore(session, 'application', (event) => emitted.push(event), { now });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(emitted.map((event) => [
      (event.payload as { type: string }).type,
      event.ts,
    ])).toEqual([
      ['permission-cancelled', 101],
      ['ask-question-cancelled', 102],
      ['exit-plan-cancelled', 103],
    ]);
    expect(permissionResolver).toHaveBeenCalledWith({
      behavior: 'deny', message: 'session ended', interrupt: true,
    });
    expect(askResolver).toHaveBeenCalledWith({
      answers: [{ question: '__session_ended__', selected: [], other: '会话已结束' }],
    });
    expect(exitResolver).toHaveBeenCalledWith({
      decision: 'keep-planning', feedback: '会话已结束',
    });
    expect([...session.pendingPermissions.values()]).toEqual([]);
    expect([...session.pendingAskUserQuestions.values()]).toEqual([]);
    expect([...session.pendingExitPlanModes.values()]).toEqual([]);
    expect(timerCallback).not.toHaveBeenCalled();
  });

  it('cleans mutable state, releases every distinct identity, and wakes the stream last', () => {
    const trace: string[] = [];
    const host = makeHost(trace);
    const session = makeSession();
    const ignored = new Set(['ignored']);
    const accepted = new Map([['fingerprint', 'accepted']]);
    session.ignoredUserMessageIds = ignored;
    session.acceptedEnqueueFingerprints = accepted;
    session.notify = () => trace.push('notify');
    const sessions = new Map([['key', session]]);

    runClaudeCloseSessionCleanupCore({
      sessions,
      internal: session,
      key: 'key',
      sessionId: 'caller',
      emit: vi.fn(),
    }, host);

    expect(sessions.size).toBe(0);
    expect(session.pendingUserMessages.length).toBe(0);
    expect(session.submittingUserMessage).toBeNull();
    expect(ignored.size).toBe(0);
    expect(accepted.size).toBe(0);
    expect(session.notify).toBeNull();
    expect(trace).toEqual([
      'sandbox',
      'release:caller', 'release:application', 'release:native',
      'mark:caller', 'mark:application', 'mark:native',
      'notify',
    ]);
  });

  it('deduplicates identities, preserves a replaced map entry, and supports restart cleanup', () => {
    const host = makeHost();
    const session = makeSession();
    session.applicationSid = 'same';
    session.cliSessionId = 'same';
    session.notify = () => { throw new Error('wakeup failed'); };
    const replacement = makeSession();
    const sessions = new Map([['key', replacement]]);

    expect(() => runClaudeCloseSessionCleanupCore({
      sessions,
      internal: session,
      key: 'key',
      sessionId: 'same',
      emit: vi.fn(),
      markRecentlyDeleted: false,
    }, host)).not.toThrow();

    expect(sessions.get('key')).toBe(replacement);
    expect(host.releaseSdkClaim).toHaveBeenCalledOnce();
    expect(host.releaseSdkClaim).toHaveBeenCalledWith('same');
    expect(host.markRecentlyDeleted).not.toHaveBeenCalled();
    expect(session.notify).toBeNull();
  });
});
