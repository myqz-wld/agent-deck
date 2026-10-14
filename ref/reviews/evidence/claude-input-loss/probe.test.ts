import { describe, expect, it, vi } from 'vitest';
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

describe('current Claude input loss probes', () => {
  it('reproduces idle input disappearing after an uncorrelated error result before acknowledgement', async () => {
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
    expect(f.emit.mock.calls.some(([e]) => e.payload?.error)).toBe(true);
    await stream.return?.();
  });

  it('reproduces both submitting and queued inputs disappearing when the SDK stream ends', async () => {
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
});
