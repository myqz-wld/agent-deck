import type { Query } from '@anthropic-ai/claude-agent-sdk';
import type { AgentEvent } from '@shared/types';
import { describe, expect, it, vi } from 'vitest';
import {
  createClaudeUserMessageStreamCore,
  makeClaudeUserMessageCore,
  type ClaudeUserMessageStreamHost,
} from './user-message-stream-core';
import { makeInternalSession, type InternalSession } from './types';
import { confirmClaudeUserMessageAcceptanceCore } from './user-message-acceptance-core';

function makeHost(
  readAttachmentBase64: (path: string) => Promise<string> = async () => 'encoded-image',
): ClaudeUserMessageStreamHost {
  return {
    readAttachmentBase64,
    createProviderMessageId: () => 'provider-message-1',
    now: () => 5150,
  };
}

function makeInternal(): InternalSession {
  const internal = makeInternalSession({
    cwd: '/tmp/user-message-stream-core',
    permissionMode: 'default',
    applicationSid: 'session-core',
  });
  internal.cliSessionId = 'session-core';
  internal.query = undefined as unknown as Query;
  return internal;
}

describe('Claude user message stream Core', () => {
  it('materializes attachments through the host while retaining handoff metadata', async () => {
    const readAttachmentBase64 = vi.fn(async () => 'base64-from-host');
    const pending = makeClaudeUserMessageCore(
      'session-core',
      'describe',
      [{ kind: 'uploaded', path: '/private/image.png', mime: 'image/png', bytes: 4 }],
      makeHost(readAttachmentBase64),
    );

    expect(pending.handOffMessage).toEqual({
      text: 'describe',
      attachments: [
        { kind: 'uploaded', path: '/private/image.png', mime: 'image/png', bytes: 4 },
      ],
    });
    await expect(pending()).resolves.toMatchObject({
      session_id: 'session-core',
      priority: 'now',
      message: {
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: 'base64-from-host',
            },
          },
          { type: 'text', text: 'describe' },
        ],
      },
    });
    expect(readAttachmentBase64).toHaveBeenCalledWith('/private/image.png');
  });

  it('owns dequeue identity and submitting state', async () => {
    const host = { ...makeHost(), refreshBrowserRuntime: vi.fn() };
    const internal = makeInternal();
    const pending = makeClaudeUserMessageCore('session-core', 'queued', undefined, host);
    pending.deferredUserEvent = { text: 'queued' };
    internal.pendingUserMessages.push(pending);
    const stream = createClaudeUserMessageStreamCore(
      { sessions: new Map([['session-core', internal]]), emit: vi.fn() },
      internal,
      host,
    )[Symbol.asyncIterator]();

    const next = await stream.next();

    expect(next.done).toBe(false);
    expect(next.value).toMatchObject({ uuid: 'provider-message-1', session_id: 'session-core' });
    expect(internal.pendingUserMessages).toEqual([]);
    expect(internal.userTurnInFlight).toBe(true);
    expect(internal.submittingUserMessage).toEqual({
      pending,
      providerMessageId: 'provider-message-1',
      status: 'submitting',
    });
    expect(host.refreshBrowserRuntime).toHaveBeenCalledWith('session-core');
    await stream.return?.();
  });

  it('keeps a failed deferred attachment queued and emits the host time', async () => {
    const host = makeHost(async () => {
      throw new Error('read failed');
    });
    const internal = makeInternal();
    const pending = makeClaudeUserMessageCore(
      'session-core',
      'queued',
      [{ kind: 'uploaded', path: '/missing.png', mime: 'image/png', bytes: 1 }],
      host,
    );
    pending.deferredUserEvent = { text: 'queued', turnCorrelationId: 'turn-1' };
    internal.pendingUserMessages.push(pending);
    const emitted: AgentEvent[] = [];
    const stream = createClaudeUserMessageStreamCore(
      {
        sessions: new Map([['session-core', internal]]),
        emit: (event) => {
          emitted.push(event);
          internal.retireBoundaryReached = true;
        },
      },
      internal,
      host,
    )[Symbol.asyncIterator]();

    await expect(stream.next()).resolves.toEqual({ done: true, value: undefined });
    expect(internal.pendingUserMessages).toEqual([pending]);
    expect(pending.materializationError).toBe('read failed');
    expect(emitted).toEqual([
      expect.objectContaining({
        sessionId: 'session-core',
        kind: 'message',
        ts: 5150,
        payload: expect.objectContaining({ error: true }),
      }),
    ]);
  });

  it('delivers composer input during an active turn and wakes the next input on acceptance', async () => {
    const host = makeHost();
    const internal = makeInternal();
    internal.userTurnInFlight = true;
    const emit = vi.fn();
    const first = makeClaudeUserMessageCore('session-core', 'correction one', undefined, host);
    first.deferredUserEvent = { text: 'correction one', turnCorrelationId: 'turn-1' };
    const second = makeClaudeUserMessageCore('session-core', 'correction two', undefined, host);
    second.deferredUserEvent = { text: 'correction two', turnCorrelationId: 'turn-2' };
    const stream = createClaudeUserMessageStreamCore(
      { sessions: new Map([['session-core', internal]]), emit }, internal, host,
    )[Symbol.asyncIterator]();
    const next = stream.next();
    internal.pendingUserMessages.push(first, second);
    internal.notify?.();

    try {
      await vi.waitFor(() => expect(internal.submittingUserMessage?.providerMessageId).toBe('turn-1'));
      await expect(next).resolves.toMatchObject({
        value: { uuid: 'turn-1', priority: 'now', message: { content: 'correction one' } },
      });
      expect(emit).not.toHaveBeenCalled();
      const following = stream.next();
      await vi.waitFor(() => expect(internal.notify).not.toBeNull());
      expect(internal.pendingUserMessages).toEqual([second]);

      confirmClaudeUserMessageAcceptanceCore(emit, 'session-core', {
        type: 'user', uuid: 'turn-1', parent_tool_use_id: null,
      }, internal, { agentId: 'claude-code', now: host.now });

      await expect(following).resolves.toMatchObject({ value: { uuid: 'turn-2' } });
      expect(internal.userTurnInFlight).toBe(true);
      expect(emit).toHaveBeenCalledOnce();
    } finally {
      internal.providerInputClosed = true;
      internal.notify?.();
      await stream.return?.();
    }
  });

  it('rechecks the cwd transition gate after attachment materialization', async () => {
    let finishRead!: (value: string) => void;
    const host = makeHost(() => new Promise((resolve) => { finishRead = resolve; }));
    const internal = makeInternal();
    const pending = makeClaudeUserMessageCore('session-core', 'correction', [
      { kind: 'uploaded', path: '/input.png', mime: 'image/png', bytes: 1 },
    ], host);
    pending.deferredUserEvent = { text: 'correction', turnCorrelationId: 'turn-1' };
    internal.pendingUserMessages.push(pending);
    const stream = createClaudeUserMessageStreamCore(
      { sessions: new Map([['session-core', internal]]), emit: vi.fn() }, internal, host,
    )[Symbol.asyncIterator]();
    const next = stream.next();
    internal.cwdTransitionGeneration = 1;
    finishRead('encoded');
    try {
      await vi.waitFor(() => expect(internal.notify).not.toBeNull());
      expect(internal.pendingUserMessages).toEqual([pending]);
      expect(internal.submittingUserMessage).toBeNull();
    } finally {
      internal.providerInputClosed = true;
      internal.notify?.();
      await next;
      await stream.return?.();
    }
  });
});
