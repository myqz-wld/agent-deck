import type { Query } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runClaudeCloseSessionCleanupCore } from './pending-cancellation-core';
import { validateSessionAcceptsMessageOrThrow } from './send-validation';
import {
  closeClaudeSessionCore,
  closeClaudeSessionForRollbackCore,
  interruptClaudeSessionCore,
} from './session-lifecycle-core';
import { makeInternalSession } from './types';
import { createClaudeUserMessageStreamCore, makeClaudeUserMessageCore } from './user-message-stream-core';

function fixture() {
  const internal = makeInternalSession({ cwd: '/workspace', applicationSid: 'rollback-app' });
  internal.cliSessionId = 'rollback-native';
  const sessions = new Map([['rollback-app', internal]]);
  const emit = vi.fn();
  const inputHost = {
    readAttachmentBase64: vi.fn(async () => 'image'),
    createProviderMessageId: () => 'provider-message', now: () => 0,
  };
  const stream = createClaudeUserMessageStreamCore({ sessions, emit }, internal, inputHost)
    [Symbol.asyncIterator]();
  const cleanupHost = {
    now: () => 0, cleanupGatewaySandboxSettings: vi.fn(), releaseSdkClaim: vi.fn(),
    markRecentlyDeleted: vi.fn(),
  };
  const cleanupSession = vi.fn((input: Parameters<typeof runClaudeCloseSessionCleanupCore<typeof internal>>[0]) =>
    runClaudeCloseSessionCleanupCore(input, cleanupHost));
  const host = { cleanupSession, hasPersistedSession: () => true, warn: vi.fn(), info: vi.fn() };
  const interrupt = vi.fn(async () => undefined);
  const close = vi.fn();
  internal.query = { interrupt, close } as unknown as Query;
  const input = { sessions, emit, sessionId: 'rollback-app' };
  return { internal, sessions, stream, inputHost, cleanupHost, host, input, interrupt, close };
}

afterEach(() => vi.useRealTimers());

describe('Claude strict rollback stream termination', () => {
  it('closes a reusable query and seals its input before releasing ownership', async () => {
    const f = fixture();
    const waiting = f.stream.next();
    expect(f.internal.notify).toBeTypeOf('function');
    f.close.mockImplementation(() => {
      expect(f.internal.providerInputClosed).toBe(true);
      expect(f.sessions.get('rollback-app')).toBe(f.internal);
      expect(f.cleanupHost.releaseSdkClaim).not.toHaveBeenCalled();
    });
    const rollback = closeClaudeSessionForRollbackCore(f.input, f.host);
    await expect(waiting).resolves.toEqual({ done: true, value: undefined });
    // Input EOF is not proof that the provider output loop has ended.
    expect(f.host.cleanupSession).not.toHaveBeenCalled();
    expect(f.sessions.has('rollback-app')).toBe(true);
    f.internal.resolveStreamDrained();
    await rollback;
    expect(f.close).toHaveBeenCalledOnce();
    expect(f.interrupt).not.toHaveBeenCalled();
    expect(f.sessions.size).toBe(0);
    expect(f.cleanupHost.releaseSdkClaim.mock.calls).toEqual([['rollback-app'], ['rollback-native']]);
  });

  it.each([false, true])('retains a sealed runtime when termination is unproven (close throws: %s)', async (throws) => {
    vi.useFakeTimers();
    const f = fixture();
    if (throws) f.close.mockImplementation(() => { throw new Error('transport close failed'); });
    const rollback = closeClaudeSessionForRollbackCore(f.input, f.host);
    const failure = expect(rollback).rejects.toThrow('could not prove provider stream termination');
    await vi.advanceTimersByTimeAsync(1_001);
    await failure;
    expect(f.sessions.get('rollback-app')).toBe(f.internal);
    expect(f.host.cleanupSession).not.toHaveBeenCalled();
    expect(f.cleanupHost.releaseSdkClaim).not.toHaveBeenCalled();
    expect(f.internal.expectedClose).toBeUndefined();
    expect(() => validateSessionAcceptsMessageOrThrow(f.internal, 'rollback-app')).toThrow('正在关闭');
    await expect(f.stream.next()).resolves.toMatchObject({ done: true });
    // A retry may release the retained claims only after the real stream barrier settles.
    f.internal.resolveStreamDrained();
    await closeClaudeSessionForRollbackCore(f.input, f.host);
    expect(f.sessions.size).toBe(0);
  });

  it('does not yield an attachment that finishes materializing after rollback starts', async () => {
    const f = fixture();
    let read!: (value: string) => void;
    f.inputHost.readAttachmentBase64.mockImplementation(() => new Promise((resolve) => { read = resolve; }));
    f.internal.pendingUserMessages.push(makeClaudeUserMessageCore('rollback-app', 'image', [
      { kind: 'uploaded', path: '/fixture.png', mime: 'image/png', bytes: 1 },
    ], f.inputHost));
    const next = f.stream.next();
    const rollback = closeClaudeSessionForRollbackCore(f.input, f.host);
    read('encoded');
    await expect(next).resolves.toMatchObject({ done: true });
    expect(f.internal.userTurnInFlight).toBeFalsy();
    expect(f.host.cleanupSession).not.toHaveBeenCalled();
    f.internal.resolveStreamDrained();
    await rollback;
  });

  it('preserves ordinary interrupt/reuse and ordinary close cleanup ordering', async () => {
    const f = fixture();
    f.internal.pendingUserMessages.push(makeClaudeUserMessageCore('rollback-app', 'first', undefined, f.inputHost));
    await expect(f.stream.next()).resolves.toMatchObject({ done: false });
    await interruptClaudeSessionCore(f.sessions, 'rollback-native', f.host);
    expect(f.internal.providerInputClosed).toBeUndefined();
    f.internal.userTurnInFlight = false;
    const second = f.stream.next();
    f.internal.pendingUserMessages.push(makeClaudeUserMessageCore('rollback-app', 'second', undefined, f.inputHost));
    f.internal.notify?.();
    await expect(second).resolves.toMatchObject({ done: false, value: { message: { content: 'second' } } });
    const end = f.stream.next().then((result) => {
      expect(f.host.cleanupSession).toHaveBeenCalledOnce();
      f.internal.resolveStreamDrained();
      return result;
    });
    await closeClaudeSessionCore({ ...f.input, options: { markRecentlyDeleted: false } }, f.host);
    await expect(end).resolves.toMatchObject({ done: true });
    expect(f.close).not.toHaveBeenCalled();
    expect(f.cleanupHost.markRecentlyDeleted).not.toHaveBeenCalled();
  });

  it('rejects missing runtime evidence', async () => {
    const f = fixture();
    f.sessions.clear();
    await expect(closeClaudeSessionForRollbackCore(f.input, f.host)).rejects.toThrow('cannot prove a live target');
    expect(f.host.cleanupSession).not.toHaveBeenCalled();
  });
});
