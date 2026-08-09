import { TrustedContinuationAcceptanceController } from '@main/adapters/trusted-continuation';
import { describe, expect, it, vi } from 'vitest';
import {
  finalizeClaudeStreamCore,
  type ClaudeStreamFinalizeHost,
} from './stream-finalize-core';
import { makeInternalSession } from './types';

describe('Claude stream finalization Core', () => {
  it('settles pending work, retires exact identities, and releases private resources', async () => {
    const continuation = new TrustedContinuationAcceptanceController();
    const internal = makeInternalSession({
      cwd: '/workspace',
      applicationSid: 'application-sid',
      trustedContinuationAcceptance: continuation,
    });
    internal.cliSessionId = 'cli-sid';
    internal.liveTokenEstimate = {
      bucketKey: 'claude-opus-4-8',
      estTokensSinceFlush: 1,
      lastFlushTs: 1,
      hasFlushAnchor: true,
      decodeElapsedMs: 5,
    };
    internal.turnUsageByBucket.set('claude-opus-4-8', {
      input: 1,
      output: 1,
      reasoning: 1,
      cacheRead: 0,
      cacheCreation: 0,
    });
    internal.pendingFileChangeIntents.set('tool-1', {} as never);
    const permission = vi.fn();
    const ask = vi.fn();
    const exitPlan = vi.fn();
    internal.pendingPermissions.set('permission-1', {
      payload: {} as never,
      resolver: permission,
      timer: null,
    });
    internal.pendingAskUserQuestions.set('ask-1', {
      payload: {} as never,
      resolver: ask,
      timer: null,
    });
    internal.pendingExitPlanModes.set('exit-1', {
      payload: {} as never,
      resolver: exitPlan,
      toolInput: {},
      timer: null,
    });
    const cleanup = vi.fn();
    internal.gatewaySandboxSettingsCleanup = cleanup;

    const other = makeInternalSession({ cwd: '/other', applicationSid: 'other-sid' });
    const sessions = new Map([
      ['application-sid', internal],
      ['temp-sid', internal],
      ['other-sid', other],
    ]);
    const emit = vi.fn();
    const host: ClaudeStreamFinalizeHost = {
      agentId: 'claude-core',
      now: vi.fn()
        .mockReturnValueOnce(7000)
        .mockReturnValueOnce(7001),
      resolveModel: () => 'claude-opus-4-8',
      emitTokenRateTick: vi.fn(),
      releaseSdkClaim: vi.fn(),
    };

    finalizeClaudeStreamCore({ sessions, emit }, internal, 'temp-sid', host);

    await expect(continuation.acceptance).resolves.toEqual({
      status: 'rejected',
      reason: 'provider-error',
    });
    expect(permission).toHaveBeenCalledWith({
      behavior: 'deny',
      message: 'session ended',
      interrupt: true,
    });
    expect(ask).toHaveBeenCalledWith({
      answers: [{ question: '__session_ended__', selected: [], other: '会话已结束' }],
    });
    expect(exitPlan).toHaveBeenCalledWith({
      decision: 'keep-planning',
      feedback: '会话已结束',
    });
    expect(internal.pendingFileChangeIntents.size).toBe(0);
    expect(internal.turnUsageByBucket.size).toBe(0);
    expect(internal.liveTokenEstimate).toBeUndefined();
    expect(host.emitTokenRateTick).toHaveBeenCalledWith({
      sessionId: 'application-sid',
      bucketKey: 'claude-opus-4-8',
      tps: 0,
      ts: 7000,
      done: true,
    });
    expect(emit).toHaveBeenCalledWith({
      sessionId: 'application-sid',
      agentId: 'claude-core',
      kind: 'session-end',
      payload: { reason: 'sdk-stream-ended' },
      ts: 7001,
      source: 'sdk',
    });
    expect(sessions.has('application-sid')).toBe(false);
    expect(sessions.has('temp-sid')).toBe(false);
    expect(sessions.get('other-sid')).toBe(other);
    expect(host.releaseSdkClaim).toHaveBeenNthCalledWith(1, 'application-sid');
    expect(host.releaseSdkClaim).toHaveBeenNthCalledWith(2, 'cli-sid');
    expect(cleanup).toHaveBeenCalledOnce();
    expect(internal.gatewaySandboxSettingsCleanup).toBeUndefined();
    await expect(internal.streamDrained).resolves.toBeUndefined();
  });

  it('always resolves the stream barrier when claim release throws', async () => {
    const internal = makeInternalSession({ cwd: '/workspace', applicationSid: 'session-a' });
    const cleanup = vi.fn();
    internal.gatewaySandboxSettingsCleanup = cleanup;
    const host: ClaudeStreamFinalizeHost = {
      agentId: 'claude-core',
      now: () => 1,
      resolveModel: () => null,
      emitTokenRateTick: vi.fn(),
      releaseSdkClaim: () => {
        throw new Error('release failed');
      },
    };

    expect(() => finalizeClaudeStreamCore(
      { sessions: new Map([['session-a', internal]]), emit: vi.fn() },
      internal,
      'session-a',
      host,
    )).toThrow('release failed');
    expect(cleanup).toHaveBeenCalledOnce();
    await expect(internal.streamDrained).resolves.toBeUndefined();
  });
});
