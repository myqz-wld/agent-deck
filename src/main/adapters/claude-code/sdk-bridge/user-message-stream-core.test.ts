import type { Query } from '@anthropic-ai/claude-agent-sdk';
import type { AgentEvent } from '@shared/types';
import { describe, expect, it, vi } from 'vitest';
import {
  createClaudeUserMessageStreamCore,
  makeClaudeUserMessageCore,
  type ClaudeUserMessageStreamHost,
} from './user-message-stream-core';
import { makeInternalSession, type InternalSession } from './types';

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
});
