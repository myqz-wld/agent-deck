import { describe, expect, it, vi } from 'vitest';
import { readMessageDeliveryRecovery } from '@shared/message-delivery-recovery';
import { classifyContinuationMessage } from '@main/session/continuation-context/message-classifier';
import { preserveClaudeUserMessageCore } from './user-message-recovery-core';
import { makeInternalSession } from '@main/adapters/claude-code/sdk-bridge/types';
import { sendClaudeMessageCore } from '@main/adapters/claude-code/sdk-bridge/message-controller-core';
import { createClaudeUserMessageStreamCore, makeClaudeUserMessageCore } from '@main/adapters/claude-code/sdk-bridge/user-message-stream-core';
import { translateSdkMessageCore, type ClaudeSdkMessageTranslationHost } from '@main/adapters/claude-code/sdk-bridge/sdk-message-translate-core';
import { finalizeClaudeStreamCore } from '@main/adapters/claude-code/sdk-bridge/stream-finalize-core';
import { listClaudePendingOutgoingMessagesCore } from '@main/adapters/claude-code/sdk-bridge/pending-outgoing-core';

function fixture() {
  const internal = makeInternalSession({ cwd: '/workspace', applicationSid: 'session-a' });
  const sessions = new Map([['session-a', internal]]);
  const emit = vi.fn();
  const now = () => 100;
  const inputHost = { now, createProviderMessageId: () => 'input-a',
    readAttachmentBase64: async () => '' };
  const host: ClaudeSdkMessageTranslationHost = {
    agentId: 'claude-code', now,
    runtimeMetadata: { read: () => null, setModel: vi.fn(), setEffort: vi.fn(),
      emitUpdated: vi.fn(), warnFailure: vi.fn() },
    liveRate: { resolveModel: () => null, emitTokenRateTick: vi.fn() },
    state: { read: () => null, setPermissionMode: vi.fn(), publishUpdated: vi.fn() },
  };
  return { internal, sessions, emit, now, inputHost, host,
    queue: () => listClaudePendingOutgoingMessagesCore(sessions, 'session-a'),
    userEvents: () => emit.mock.calls.filter(([event]) => event.kind === 'message' && event.payload?.role === 'user'),
    send: (id: string) => sendClaudeMessageCore({ sessions, emit, recoverAndSend: vi.fn(),
      makeUserMessage: (sid, text, attachments) => makeClaudeUserMessageCore(sid, text, attachments, inputHost),
    }, { sessionId: 'session-a', text: `synthetic ${id}`, enqueueOptions: {
      deferUserEventUntilTurnStart: true, turnCorrelationId: id,
    } }, { now, guardSourceIngress: () => false, acceptedEnqueueEventFailed: vi.fn() }),
  };
}

describe('Claude terminal input recovery', () => {
  it('retains idle input as delivery-unknown before clearing an unacknowledged error result', async () => {
    const f = fixture();
    await f.send('input-a');
    const stream = createClaudeUserMessageStreamCore(f, f.internal, f.inputHost)[Symbol.asyncIterator]();
    await stream.next();
    expect(f.queue()).toHaveLength(1);
    expect(f.userEvents()).toHaveLength(0);
    translateSdkMessageCore(f.emit, 'session-a', { type: 'result',
      subtype: 'error_during_execution', is_error: true, errors: ['synthetic startup failure'] }, f.internal, f.host);
    expect(f.queue()).toHaveLength(0);
    expect(f.userEvents()).toHaveLength(0);
    const recovery = f.emit.mock.calls.map(([event]) => readMessageDeliveryRecovery(event)).filter(Boolean);
    expect(recovery).toEqual([{ status: 'unknown', messageId: 'input-a', text: 'synthetic input-a',
      attachmentCount: 0, attachments: [], textTruncated: false }]);
    translateSdkMessageCore(f.emit, 'session-a', { type: 'user', uuid: 'input-a',
      message: { role: 'user', content: 'synthetic input-a' } }, f.internal, f.host);
    expect(f.userEvents()).toHaveLength(0);
    expect(f.emit.mock.calls.filter(([e]) => readMessageDeliveryRecovery(e))).toHaveLength(1);
    await stream.return?.();
  });

  it('retains submitted and queued input separately when the SDK stream ends', async () => {
    const f = fixture();
    await f.send('input-a');
    await f.send('input-b');
    const stream = createClaudeUserMessageStreamCore(f, f.internal, f.inputHost)[Symbol.asyncIterator]();
    await stream.next();
    expect(f.queue()).toHaveLength(2);
    finalizeClaudeStreamCore(f, f.internal, 'session-a', { agentId: 'claude-code', now: f.now,
      resolveModel: () => null, emitTokenRateTick: vi.fn(), releaseSdkClaim: vi.fn() });
    expect(f.queue()).toHaveLength(0);
    expect(f.userEvents()).toHaveLength(0);
    expect(f.sessions.has('session-a')).toBe(false);
    const recoveries = f.emit.mock.calls.map(([event]) => readMessageDeliveryRecovery(event)).filter(Boolean);
    expect(recoveries.map((message) => [message!.messageId, message!.status, message!.text])).toEqual([
      ['input-a', 'unknown', 'synthetic input-a'], ['input-b', 'not-sent', 'synthetic input-b'],
    ]);
    // Records survive runtime removal and ordinary JSON persistence without becoming user input.
    for (const [event] of f.emit.mock.calls.filter(([e]) => readMessageDeliveryRecovery(e))) {
      expect(readMessageDeliveryRecovery(JSON.parse(JSON.stringify(event)))).toEqual(readMessageDeliveryRecovery(event));
      expect(classifyContinuationMessage({ eventId: 1, effectiveRevision: 1, ts: event.ts,
        kind: event.kind, payloadJson: JSON.stringify(event.payload) }).message).toBeNull();
    }
    await stream.return?.();
  });

  it('reproduces a mid-turn correction staying pending when all subsequent frames lack input correlation', async () => {
    const f = fixture();
    f.internal.userTurnInFlight = true;
    await f.send('input-a');
    const stream = createClaudeUserMessageStreamCore(f, f.internal, f.inputHost)[Symbol.asyncIterator]();
    await stream.next();
    for (const frame of [
      { type: 'result', subtype: 'success' },
      { type: 'user', uuid: 'rewritten-id', message: { role: 'user', content: 'synthetic input-a' } },
      { type: 'stream_event', event: { type: 'message_start', message: { role: 'assistant' } } },
      { type: 'result', subtype: 'success' },
    ]) translateSdkMessageCore(f.emit, 'session-a', frame, f.internal, f.host);
    expect(f.queue()).toHaveLength(1);
    expect(f.userEvents()).toHaveLength(0);
    expect(f.internal.submittingUserMessage?.precedingTurn).toBe('finished');
    await stream.return?.();
  });
  it('preserves attachments and records each input only once', async () => {
    const f = fixture();
    await f.send('input-a');
    const pending = f.internal.pendingUserMessages[0]!;
    pending.deferredUserEvent!.attachments = [
      { kind: 'uploaded', path: '/synthetic/image.png', mime: 'image/png', bytes: 42 },
    ];
    preserveClaudeUserMessageCore(f.emit, 'session-a', pending, 'unknown', f.host);
    preserveClaudeUserMessageCore(f.emit, 'session-a', pending, 'unknown', f.host);
    const recovered = readMessageDeliveryRecovery(f.emit.mock.calls[0]![0]);
    expect(recovered?.attachments).toEqual(pending.deferredUserEvent!.attachments);
    expect(recovered?.attachmentCount).toBe(1);
    expect(f.emit).toHaveBeenCalledOnce();
  });

  it('retains the submitting input when persistence fails and permits a later recovery attempt', async () => {
    const f = fixture();
    await f.send('input-a');
    const stream = createClaudeUserMessageStreamCore(f, f.internal, f.inputHost)[Symbol.asyncIterator]();
    await stream.next();
    f.emit.mockImplementationOnce(() => { throw new Error('persistence failed'); });
    const result = { type: 'result', subtype: 'error_during_execution', is_error: true };
    expect(() => translateSdkMessageCore(f.emit, 'session-a', result, f.internal, f.host))
      .toThrow('persistence failed');
    expect(f.queue()).toHaveLength(1);
    translateSdkMessageCore(f.emit, 'session-a', result, f.internal, f.host);
    expect(f.queue()).toHaveLength(0);
    expect(readMessageDeliveryRecovery(f.emit.mock.calls[1]![0])?.text).toBe('synthetic input-a');
    await stream.return?.();
  });

  it('does not lose the input when persisting an acceptance event fails', async () => {
    const f = fixture();
    await f.send('input-a');
    const stream = createClaudeUserMessageStreamCore(f, f.internal, f.inputHost)[Symbol.asyncIterator]();
    await stream.next();
    f.emit.mockImplementationOnce(() => { throw new Error('persistence failed'); });
    expect(() => translateSdkMessageCore(f.emit, 'session-a', { type: 'user', uuid: 'input-a' },
      f.internal, f.host)).toThrow('persistence failed');
    expect(f.queue()).toHaveLength(1);
    finalizeClaudeStreamCore(f, f.internal, 'session-a', { agentId: 'claude-code', now: f.now,
      resolveModel: () => null, emitTokenRateTick: vi.fn(), releaseSdkClaim: vi.fn() });
    expect(f.emit.mock.calls.map(([e]) => readMessageDeliveryRecovery(e)).filter(Boolean))
      .toEqual([expect.objectContaining({ messageId: 'input-a', status: 'unknown' })]);
    await stream.return?.();
  });

  it.each(['expectedClose', 'retireRequested'] as const)(
    'does not duplicate intentionally cancelled or transferred work (%s)', async (flag) => {
      const f = fixture();
      await f.send('input-a');
      f.internal[flag] = true;
      finalizeClaudeStreamCore(f, f.internal, 'session-a', { agentId: 'claude-code', now: f.now,
        resolveModel: () => null, emitTokenRateTick: vi.fn(), releaseSdkClaim: vi.fn() });
      expect(f.emit.mock.calls.map(([e]) => readMessageDeliveryRecovery(e)).filter(Boolean)).toEqual([]);
    },
  );

  it.each([false, true])('ignores late attachment materialization after stream termination (reject: %s)', async (reject) => {
    const f = fixture();
    await f.send('input-a');
    const pending = f.internal.pendingUserMessages[0]!;
    let finish!: (value: Awaited<ReturnType<typeof pending>>) => void;
    let fail!: (reason: Error) => void;
    const delayed = Object.assign(() => new Promise<Awaited<ReturnType<typeof pending>>>((resolve, reject) => {
      finish = resolve;
      fail = reject;
    }), { deferredUserEvent: pending.deferredUserEvent });
    f.internal.pendingUserMessages[0] = delayed;
    const stream = createClaudeUserMessageStreamCore(f, f.internal, f.inputHost)[Symbol.asyncIterator]();
    const next = stream.next();
    finalizeClaudeStreamCore(f, f.internal, 'session-a', { agentId: 'claude-code', now: f.now,
      resolveModel: () => null, emitTokenRateTick: vi.fn(), releaseSdkClaim: vi.fn() });
    if (reject) fail(new Error('late read failure'));
    else finish(await pending());
    await expect(next).resolves.toMatchObject({ done: true });
    expect(f.internal.submittingUserMessage).toBeFalsy();
    expect(f.emit.mock.calls.some(([e]) => String(e.payload?.text).includes('仍在等待队列'))).toBe(false);
    expect(f.emit.mock.calls.map(([e]) => readMessageDeliveryRecovery(e)).filter(Boolean))
      .toEqual([expect.objectContaining({ status: 'not-sent' })]);
  });

});
