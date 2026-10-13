import type { Query } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, vi } from 'vitest';
import {
  ClaudeStreamProcessorCore,
  type ClaudeStreamProcessorHost,
} from './stream-processor-core';
import { makeInternalSession } from './types';

function queryFrom(generator: () => AsyncGenerator<unknown>): Query {
  return {
    [Symbol.asyncIterator]: generator,
    interrupt: vi.fn(() => Promise.resolve()),
  } as unknown as Query;
}

function host(): ClaudeStreamProcessorHost & {
  warn: ReturnType<typeof vi.fn>;
  finalize: ClaudeStreamProcessorHost['finalize'] & {
    releaseSdkClaim: ReturnType<typeof vi.fn>;
  };
  identity: ClaudeStreamProcessorHost['identity'] & {
    renameSdkSession: ReturnType<typeof vi.fn>;
  };
} {
  const now = () => 7_000;
  return {
    agentId: 'claude-core',
    now,
    warn: vi.fn(),
    userMessages: {
      readAttachmentBase64: vi.fn(() => Promise.resolve('base64')),
      createProviderMessageId: () => 'provider-message-id',
      now,
    },
    translation: {
      agentId: 'claude-core',
      now,
      runtimeMetadata: {
        read: () => null,
        setModel: vi.fn(),
        setEffort: vi.fn(),
        emitUpdated: vi.fn(),
        warnFailure: vi.fn(),
      },
      liveRate: {
        resolveModel: () => null,
        emitTokenRateTick: vi.fn(),
      },
      state: {
        read: () => null,
        setPermissionMode: vi.fn(),
        publishUpdated: vi.fn(),
      },
    },
    finalize: {
      agentId: 'claude-core',
      now,
      resolveModel: () => null,
      emitTokenRateTick: vi.fn(),
      releaseSdkClaim: vi.fn(),
    },
    identity: {
      warn: vi.fn(),
      renameSdkSession: vi.fn(),
      updateCliSessionId: vi.fn(),
    },
  };
}

describe('Claude stream processor Core', () => {
  it('adopts the first provider id, translates content, and finalizes exact ownership', async () => {
    const internal = makeInternalSession({ cwd: '/workspace', applicationSid: 'temp-sid' });
    internal.query = queryFrom(async function* () {
      yield {
        type: 'assistant',
        session_id: 'provider-sid',
        message: { content: [{ type: 'text', text: 'hello from Core' }] },
      };
    });
    const sessions = new Map([['temp-sid', internal]]);
    const emit = vi.fn();
    const ports = host();
    const firstId = vi.fn();
    const processor = new ClaudeStreamProcessorCore({ sessions, emit }, ports);

    await expect(processor.consume(internal, 'temp-sid', firstId)).resolves.toBe(
      'provider-sid',
    );

    expect(firstId).toHaveBeenCalledWith('provider-sid');
    expect(ports.identity.renameSdkSession).toHaveBeenCalledWith(
      'temp-sid',
      'provider-sid',
    );
    expect(emit).toHaveBeenCalledWith({
      sessionId: 'provider-sid',
      agentId: 'claude-core',
      kind: 'message',
      payload: { text: 'hello from Core', role: 'assistant' },
      ts: 7_000,
      source: 'sdk',
    });
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'provider-sid',
      kind: 'session-end',
    }));
    expect(sessions.size).toBe(0);
    expect(ports.finalize.releaseSdkClaim).toHaveBeenCalledWith('provider-sid');
    await expect(internal.streamDrained).resolves.toBeUndefined();
  });

  it('projects unexpected provider failures and still completes the final barrier', async () => {
    const internal = makeInternalSession({ cwd: '/workspace', applicationSid: 'session-a' });
    internal.query = queryFrom(async function* () {
      throw new Error('provider exploded');
    });
    const sessions = new Map([['session-a', internal]]);
    const emit = vi.fn();
    const ports = host();
    const processor = new ClaudeStreamProcessorCore({ sessions, emit }, ports);

    await expect(processor.consume(internal, 'session-a', vi.fn())).resolves.toBeNull();

    expect(ports.warn).toHaveBeenCalledWith(
      '[sdk-bridge] query loop ended',
      expect.objectContaining({ message: 'provider exploded' }),
    );
    expect(emit).toHaveBeenCalledWith({
      sessionId: 'session-a',
      agentId: 'claude-core',
      kind: 'message',
      payload: { text: '⚠ SDK 流中断：provider exploded', error: true },
      ts: 7_000,
      source: 'sdk',
    });
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ kind: 'session-end' }));
    expect(sessions.size).toBe(0);
    await expect(internal.streamDrained).resolves.toBeUndefined();
  });

  it('keeps a streamed correction pending across the old result and records it before its reply', async () => {
    const internal = makeInternalSession({ cwd: '/workspace', applicationSid: 'session-a' });
    internal.userTurnInFlight = true;
    const emit = vi.fn();
    const ports = host();
    const processor = new ClaudeStreamProcessorCore({
      sessions: new Map([['session-a', internal]]), emit,
    }, ports);
    const pending = processor.makeUserMessage('session-a', 'new direction');
    pending.deferredUserEvent = { text: 'new direction', turnCorrelationId: 'correction-1' };
    internal.pendingUserMessages.push(pending);
    const input = processor.createUserMessageStream(internal, 'session-a')[Symbol.asyncIterator]();
    await expect(input.next()).resolves.toMatchObject({ value: { uuid: 'correction-1' } });
    const observations: unknown[] = [];
    internal.query = queryFrom(async function* () {
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'old reply' }] } };
      yield { type: 'result', subtype: 'success', user_message_uuid: 'original-1' };
      observations.push({
        pending: internal.submittingUserMessage?.providerMessageId,
        inFlight: internal.userTurnInFlight,
      });
      yield { type: 'user', uuid: 'correction-1', isReplay: true, parent_tool_use_id: null };
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'new reply' }] } };
      yield { type: 'result', subtype: 'success', user_message_uuid: 'correction-1' };
      observations.push({ pending: internal.submittingUserMessage, inFlight: internal.userTurnInFlight });
    });

    await processor.consume(internal, 'session-a', vi.fn());
    await input.return?.();

    expect(ports.warn).not.toHaveBeenCalled();
    expect(observations).toEqual([
      { pending: 'correction-1', inFlight: true },
      { pending: null, inFlight: false },
    ]);
    expect(emit.mock.calls.map(([event]) => event).filter((event) => event.kind === 'message')
      .map((event) => event.payload)).toEqual([
      { role: 'assistant', text: 'old reply' },
      { role: 'user', text: 'new direction', turnCorrelationId: 'correction-1' },
      { role: 'assistant', text: 'new reply' },
    ]);
  });

  it.each(['after-result', 'before-result', 'burst', 'legacy'])(
    'continues consecutive corrections without execution errors (%s)', async (order) => {
      const internal = makeInternalSession({ cwd: '/workspace', applicationSid: 'session-a' });
      internal.userTurnInFlight = true;
      const emit = vi.fn();
      const ports = host();
      const processor = new ClaudeStreamProcessorCore({
        sessions: new Map([['session-a', internal]]), emit,
      }, ports);
      for (const id of ['correction-1', 'correction-2']) {
        const pending = processor.makeUserMessage('session-a', id);
        pending.deferredUserEvent = { text: id, turnCorrelationId: id };
        internal.pendingUserMessages.push(pending);
      }
      const input = processor.createUserMessageStream(internal, 'session-a')[Symbol.asyncIterator]();
      await expect(input.next()).resolves.toMatchObject({ value: { uuid: 'correction-1' } });
      const echo = (uuid: string) => ({ type: 'user', uuid, isReplay: true, parent_tool_use_id: null });
      const interrupted = (uuid: string) => ({
        type: 'result', subtype: 'error_during_execution', is_error: true,
        user_message_uuid: uuid, terminal_reason: 'aborted_streaming',
        errors: ['[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null'],
      });
      const inFlight: boolean[] = [];
      internal.query = queryFrom(async function* () {
        if (order !== 'after-result') yield echo('correction-1');
        if (order === 'burst') {
          await expect(input.next()).resolves.toMatchObject({ value: { uuid: 'correction-2' } });
          yield echo('correction-2');
        }
        yield order === 'legacy'
          ? { ...interrupted('original'), user_message_uuid: undefined,
              terminal_reason: undefined, queued_turn_count: 1 }
          : interrupted('original');
        inFlight.push(internal.userTurnInFlight === true);
        if (order === 'after-result') yield echo('correction-1');
        if (order !== 'burst') {
          await expect(input.next()).resolves.toMatchObject({ value: { uuid: 'correction-2' } });
          yield echo('correction-2');
        }
        yield interrupted('correction-1');
        inFlight.push(internal.userTurnInFlight === true);
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'updated reply' }] } };
        yield { type: 'result', subtype: 'success', user_message_uuid: 'correction-2' };
        inFlight.push(internal.userTurnInFlight === true);
      });

      await processor.consume(internal, 'session-a', vi.fn());
      await input.return?.();

      expect(ports.warn).not.toHaveBeenCalled();
      expect(inFlight).toEqual([true, true, false]);
      const events = emit.mock.calls.map(([event]) => event);
      expect(events.filter((event) => event.kind === 'finished').map((event) => event.payload)).toEqual([
        { ok: false, subtype: 'interrupted' },
        { ok: false, subtype: 'interrupted' },
        { ok: true, subtype: 'success' },
      ]);
      expect(events.filter((event) => event.kind === 'message').map((event) => event.payload)).toEqual([
        { role: 'user', text: 'correction-1', turnCorrelationId: 'correction-1' },
        { role: 'user', text: 'correction-2', turnCorrelationId: 'correction-2' },
        { role: 'assistant', text: 'updated reply' },
      ]);
      expect(internal.midTurnUserMessageIds?.size).toBe(0);
    },
  );
});
