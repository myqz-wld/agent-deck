import type { Query } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, vi } from 'vitest';

import {
  listClaudePendingOutgoingMessagesCore,
  removeClaudePendingOutgoingMessageCore,
  snapshotClaudeQueuedMessagesForHandOffCore,
  type ClaudePendingOutgoingHost,
} from './pending-outgoing-core';
import {
  makeInternalSession,
  type InternalSession,
  type PendingUserMessage,
} from './types';

function internal(sessionId = 'application-a'): InternalSession {
  const session = makeInternalSession({
    cwd: '/workspace',
    permissionMode: 'default',
    applicationSid: sessionId,
  });
  session.cliSessionId = `cli-${sessionId}`;
  return session;
}

function pending(
  text: string,
  correlationId: string,
): PendingUserMessage {
  const message = vi.fn(async () => ({})) as unknown as PendingUserMessage;
  message.handOffMessage = {
    text,
    attachments: [
      { kind: 'uploaded', path: `/${correlationId}.png`, mime: 'image/png', bytes: 1 },
    ],
  };
  message.deferredUserEvent = {
    text,
    turnCorrelationId: correlationId,
    attachments: message.handOffMessage.attachments,
  };
  return message;
}

function host(): ClaudePendingOutgoingHost & {
  rememberIgnoredUserMessageId: ReturnType<typeof vi.fn>;
} {
  return {
    rememberIgnoredUserMessageId: vi.fn(),
  };
}

describe('Claude pending outgoing Core', () => {
  it('finds either application or CLI identity and clones handoff metadata', () => {
    const session = internal();
    const queued = pending('handoff tail', 'turn-1');
    session.pendingUserMessages.push(queued);
    const sessions = new Map([['storage-key', session]]);

    const snapshot = snapshotClaudeQueuedMessagesForHandOffCore(
      sessions,
      'cli-application-a',
    );

    expect(snapshot).toEqual([queued.handOffMessage]);
    expect(snapshot[0]).not.toBe(queued.handOffMessage);
    expect(snapshot[0]?.attachments).not.toBe(queued.handOffMessage?.attachments);
  });

  it('lists the submitting message before queued messages without provider ids', () => {
    const session = internal();
    const queued = pending('queued', 'turn-queued');
    const submitting = pending('submitting', 'turn-submitting');
    session.pendingUserMessages.push(queued);
    session.submittingUserMessage = {
      pending: submitting,
      providerMessageId: 'provider-private-id',
      status: 'submitting',
    };

    expect(listClaudePendingOutgoingMessagesCore(
      new Map([['application-a', session]]),
      'application-a',
    )).toEqual([
      expect.objectContaining({ id: 'turn-submitting', text: 'submitting' }),
      expect.objectContaining({ id: 'turn-queued', text: 'queued' }),
    ]);
  });

  it('atomically removes one queued message and wakes the stream', async () => {
    const session = internal();
    const first = pending('first', 'turn-1');
    const second = pending('second', 'turn-2');
    const notify = vi.fn();
    session.pendingUserMessages.push(first, second);
    session.notify = notify;
    const sessions = new Map([['application-a', session]]);

    await expect(removeClaudePendingOutgoingMessageCore(
      sessions,
      'application-a',
      'turn-1',
      host(),
    )).resolves.toEqual(expect.objectContaining({ id: 'turn-1', text: 'first' }));
    expect(session.pendingUserMessages).toEqual([second]);
    expect(session.notify).toBeNull();
    expect(notify).toHaveBeenCalledOnce();
  });

  it('commits a successful provider cancellation and fences its late echo', async () => {
    const session = internal();
    const submitting = pending('submitting', 'turn-submitting');
    const cancelAsyncMessage = vi.fn(async () => true);
    const dependencies = host();
    const notify = vi.fn();
    session.query = { cancelAsyncMessage } as unknown as Query;
    session.submittingUserMessage = {
      pending: submitting,
      providerMessageId: 'provider-message',
      status: 'submitting',
    };
    session.userTurnInFlight = true;
    session.notify = notify;

    await expect(removeClaudePendingOutgoingMessageCore(
      new Map([['application-a', session]]),
      'application-a',
      'turn-submitting',
      dependencies,
    )).resolves.toEqual(expect.objectContaining({ id: 'turn-submitting' }));
    expect(cancelAsyncMessage).toHaveBeenCalledWith('provider-message');
    expect(dependencies.rememberIgnoredUserMessageId).toHaveBeenCalledWith(
      session,
      'provider-message',
    );
    expect(session.submittingUserMessage).toBeNull();
    expect(session.userTurnInFlight).toBe(false);
    expect(notify).toHaveBeenCalledOnce();
  });

  it('restores submitting state after a rejected or failed provider cancellation', async () => {
    const session = internal();
    const submitting = pending('submitting', 'turn-submitting');
    const cancellation = vi.fn(async () => false);
    session.query = { cancelAsyncMessage: cancellation } as unknown as Query;
    session.submittingUserMessage = {
      pending: submitting,
      providerMessageId: 'provider-message',
      status: 'submitting',
    };
    const sessions = new Map([['application-a', session]]);

    await expect(removeClaudePendingOutgoingMessageCore(
      sessions,
      'application-a',
      'turn-submitting',
      host(),
    )).resolves.toBeNull();
    expect(session.submittingUserMessage.status).toBe('submitting');

    cancellation.mockRejectedValueOnce(new Error('provider unavailable'));
    await expect(removeClaudePendingOutgoingMessageCore(
      sessions,
      'application-a',
      'turn-submitting',
      host(),
    )).rejects.toThrow('provider unavailable');
    expect(session.submittingUserMessage.status).toBe('submitting');
  });
});
