import { describe, it, expect, vi } from 'vitest';
import { GrokTurnQueue } from '@main/adapters/grok-build/turn-queue';
import { createGrokTranslationState } from '@main/adapters/grok-build/translate';
import { PermissionResponderCore } from '@main/adapters/claude-code/sdk-bridge/permission-responder-core';
import { makeInternalSession } from '@main/adapters/claude-code/sdk-bridge/types';
import { respondToServerCorePending } from '@hosts/server-core/runtime-pending';
import { closeClaudeSessionCore, closeClaudeSessionForRollbackCore } from '@main/adapters/claude-code/sdk-bridge/session-lifecycle-core';
import { runClaudeCloseSessionCleanupCore } from '@main/adapters/claude-code/sdk-bridge/pending-cancellation-core';
import { createClaudeUserMessageStreamCore } from '@main/adapters/claude-code/sdk-bridge/user-message-stream-core';

describe('scan evidence: source modules with isolated boundaries', () => {
  it('reproduces Server Core approval replacing the Claude tool arguments with an empty object', async () => {
    const internal = makeInternalSession({ cwd: '/workspace', applicationSid: 'test-app' });
    const sessions = new Map([['test-app', internal]]);
    const resolved: unknown[] = [];
    const input = { file_path: '/workspace/app.txt', old_string: 'before', new_string: 'after' };
    const request = { type: 'permission-request' as const, requestId: 'permission-edit', toolName: 'Edit', toolInput: input };
    const responder = new PermissionResponderCore({ sessions, emit: () => {}, getPermissionTimeoutMs: () => 0 }, async () => '', {
      persistPermissionMode: () => {}, observeHotSwitchFailure: () => {}, observeColdSwitchFailure: () => {}, now: () => 0,
    });
    const install = () => internal.pendingPermissions.set(request.requestId, { payload: request, timer: null, resolver: r => resolved.push(r) });
    install();
    const adapter = {
      listPending: () => responder.listPending('test-app'),
      respondPermission: async (sid: string, id: string, response: any) => responder.respondPermission(sid, id, response),
    };
    const outcome = await respondToServerCorePending(adapter as any, {
      sessionId: 'test-app', requestId: request.requestId, action: 'approve',
    }, { respond: () => null } as any);
    expect(outcome).toBe('resolved');
    expect(resolved[0]).toMatchObject({ behavior: 'allow', updatedInput: {} });
    expect((resolved[0] as any).updatedInput).not.toEqual(input);
    install();
    responder.respondPermission('test-app', request.requestId, { decision: 'allow', updatedInput: input });
    expect((resolved[1] as any).updatedInput).toEqual(input);
    console.log('runtime-01', JSON.stringify({ outcome, originalInput: input, nativeResponse: resolved[0], explicitInputCounterexample: resolved[1] }));
  });

  it('reproduces strict rollback waiting for the still-open Claude input stream before the cleanup that ends it', async () => {
    vi.useFakeTimers();
    try {
      const internal = makeInternalSession({ cwd: '/workspace', applicationSid: 'rollback-app' });
      internal.cliSessionId = 'rollback-native';
      const sessions = new Map([['rollback-app', internal]]);
      const emit = vi.fn();
      const interrupt = vi.fn(async () => undefined);
      internal.query = { interrupt } as any;
      const input = createClaudeUserMessageStreamCore({ sessions, emit }, internal, {
        readAttachmentBase64: async () => '', createProviderMessageId: () => 'message', now: () => 0,
      })[Symbol.asyncIterator]();
      const end = input.next().then(result => { if (result.done) internal.resolveStreamDrained(); return result; });
      expect(internal.notify).toBeTypeOf('function');
      const cleanupHost = { now: () => 0, cleanupGatewaySandboxSettings: vi.fn(), releaseSdkClaim: vi.fn(), markRecentlyDeleted: vi.fn() };
      const cleanupSession = vi.fn((args: any) => runClaudeCloseSessionCleanupCore(args, cleanupHost));
      const host = { cleanupSession, hasPersistedSession: () => true, warn: vi.fn(), info: vi.fn() };
      const observed = closeClaudeSessionForRollbackCore({ sessions, emit, sessionId: 'rollback-app' }, host)
        .then(() => ({ resolved: true }), error => ({ error: error.message }));
      await vi.advanceTimersByTimeAsync(1001);
      const result = await observed;
      expect(result).toMatchObject({ error: expect.stringContaining('could not prove provider stream termination') });
      expect(cleanupSession).not.toHaveBeenCalled();
      expect(sessions.has('rollback-app')).toBe(true);
      expect(internal.notify).toBeTypeOf('function');
      console.log('runtime-02', JSON.stringify({ result, retainedRuntime: sessions.has('rollback-app'), cleanupCalls: cleanupSession.mock.calls.length, interruptCalls: interrupt.mock.calls.length }));
      await closeClaudeSessionCore({ sessions, emit, sessionId: 'rollback-app', options: {} }, host);
      expect((await end).done).toBe(true);
      expect(sessions.size).toBe(0);
      console.log('runtime-02 counterexample: ordinary close removes runtime and wakes input stream successfully');
    } finally { vi.useRealTimers(); }
  });
});


describe('scan evidence: Grok pending cancellation', () => {
  it('keeps a removed prompt RPC alive and later starts a second prompt on the same transport', async () => {
    vi.useFakeTimers();
    try {
      let originalSignal: AbortSignal | undefined;
      let resolveFirst: (r: any) => void = () => {};
      let promptCount = 0;
      const request = vi.fn((method: string, _params: unknown, options?: { cancellationSignal?: AbortSignal }) => {
        if (method !== 'session/prompt') return Promise.resolve({});
        promptCount++;
        if (promptCount > 1) return Promise.resolve({ stopReason: 'end_turn' });
        originalSignal = options?.cancellationSignal;
        return new Promise(resolve => { resolveFirst = resolve; });
      });
      const notify = vi.fn(async () => undefined);
      const runtime: any = {
        applicationSessionId: 'grok-app', nativeSessionId: 'grok-native', cwd: '/workspace',
        process: { connection: { agent: { request, notify } }, initializeResponse: { agentCapabilities: {} } },
        ready: true, queue: [], running: false, closed: false, sealed: false,
        pendingPermissions: new Map(), acceptedEnqueueFingerprints: new Map(),
        translation: createGrokTranslationState(), model: null, availableCommands: [],
      };
      const close = vi.fn(async () => undefined);
      const queue = new GrokTurnQueue({
        emit: () => {}, emitEvent: () => {}, emitError: () => {}, closeSession: close, recycleRuntime: async () => {},
        providerHistoryRoot: '/tmp/agent-deck-scan/2026-09-04-project-scan/runtime/empty-provider-history',
        providerCompletionPollMs: 1_000_000, firstModelEventTimeoutMs: 90_000,
      });
      queue.enqueue(runtime, 'cancel before provider echo', undefined, { deferUserEventUntilTurnStart: true, turnCorrelationId: 'pending-one' });
      await vi.advanceTimersByTimeAsync(0);
      expect(promptCount).toBe(1);
      expect(runtime.submittingMessage.promptRequestIssued).toBe(true);
      await expect(queue.removePendingOutgoingMessage(runtime, 'pending-one')).resolves.toMatchObject({ id: 'pending-one' });
      expect(notify).toHaveBeenCalledWith('session/cancel', { sessionId: 'grok-native' });
      expect(originalSignal?.aborted).toBe(false);
      queue.enqueue(runtime, 'next prompt');
      await vi.advanceTimersByTimeAsync(89_999);
      expect(promptCount).toBe(1);
      expect(runtime.running).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      expect(promptCount).toBe(2);
      expect(originalSignal?.aborted).toBe(false);
      expect(close).not.toHaveBeenCalled();
      console.log('runtime-03', JSON.stringify({ cancelNotified: true, originalRequestAborted: originalSignal?.aborted, promptCountAfterWatchdog: promptCount, closeCalls: close.mock.calls.length }));
      resolveFirst({ stopReason: 'cancelled' });
      await vi.advanceTimersByTimeAsync(0);
    } finally { vi.useRealTimers(); }
  });
});
