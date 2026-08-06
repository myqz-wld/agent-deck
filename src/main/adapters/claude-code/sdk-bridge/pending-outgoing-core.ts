import type { PendingAgentMessage, QueuedAgentMessage } from '@main/adapters/types';
import type { InternalSession } from './types';

export interface ClaudePendingOutgoingHost {
  rememberIgnoredUserMessageId(internal: InternalSession, messageId: string): void;
}

type QueryWithAsyncMessageCancellation = InternalSession['query'] & {
  cancelAsyncMessage?: (messageId: string) => Promise<boolean>;
};

function findSession(
  sessions: ReadonlyMap<string, InternalSession>,
  sessionId: string,
): InternalSession | null {
  return [...sessions.values()].find(
    (candidate) =>
      candidate.applicationSid === sessionId || candidate.cliSessionId === sessionId,
  ) ?? null;
}

export function snapshotClaudeQueuedMessagesForHandOffCore(
  sessions: ReadonlyMap<string, InternalSession>,
  sessionId: string,
): QueuedAgentMessage[] {
  const internal = findSession(sessions, sessionId);
  if (!internal) return [];
  return internal.pendingUserMessages.flatMap((pending) => {
    const message = pending.handOffMessage;
    return message ? [{
      text: message.text,
      ...(message.attachments
        ? { attachments: message.attachments.map((attachment) => ({ ...attachment })) }
        : {}),
    }] : [];
  });
}

export function listClaudePendingOutgoingMessagesCore(
  sessions: ReadonlyMap<string, InternalSession>,
  sessionId: string,
): PendingAgentMessage[] {
  const internal = findSession(sessions, sessionId);
  if (!internal) return [];
  const pendingMessages = internal.pendingUserMessages.flatMap((pending) => {
    const deferred = pending.deferredUserEvent;
    if (!deferred?.turnCorrelationId) return [];
    return [{
      id: deferred.turnCorrelationId,
      text: deferred.text,
      ...(deferred.attachments
        ? { attachments: deferred.attachments.map((attachment) => ({ ...attachment })) }
      : {}),
    }];
  });
  const submitting = internal.submittingUserMessage;
  const deferred = submitting?.pending.deferredUserEvent;
  if (!deferred?.turnCorrelationId) return pendingMessages;
  return [{
    id: deferred.turnCorrelationId,
    text: deferred.text,
    ...(deferred.attachments
      ? { attachments: deferred.attachments.map((attachment) => ({ ...attachment })) }
      : {}),
  }, ...pendingMessages];
}

export async function removeClaudePendingOutgoingMessageCore(
  sessions: ReadonlyMap<string, InternalSession>,
  sessionId: string,
  messageId: string,
  host: ClaudePendingOutgoingHost,
): Promise<PendingAgentMessage | null> {
  const internal = findSession(sessions, sessionId);
  if (!internal) return null;
  const index = internal.pendingUserMessages.findIndex(
    (pending) => pending.deferredUserEvent?.turnCorrelationId === messageId,
  );
  if (index >= 0) {
    const [pending] = internal.pendingUserMessages.splice(index, 1);
    const removed = toPendingAgentMessage(pending);
    const notify = internal.notify;
    internal.notify = null;
    notify?.();
    return removed;
  }
  const submitting = internal.submittingUserMessage;
  const deferred = submitting?.pending.deferredUserEvent;
  if (
    !submitting ||
    submitting.status !== 'submitting' ||
    deferred?.turnCorrelationId !== messageId
  ) return null;
  const cancelAsyncMessage = (internal.query as QueryWithAsyncMessageCancellation)
    .cancelAsyncMessage;
  if (typeof cancelAsyncMessage !== 'function') return null;
  submitting.status = 'cancelling';
  let cancelled: boolean;
  try {
    cancelled = await cancelAsyncMessage.call(internal.query, submitting.providerMessageId);
  } catch (error) {
    if (internal.submittingUserMessage === submitting) submitting.status = 'submitting';
    throw error;
  }
  if (internal.submittingUserMessage !== submitting || submitting.status !== 'cancelling') {
    return null;
  }
  if (!cancelled) {
    submitting.status = 'submitting';
    return null;
  }
  host.rememberIgnoredUserMessageId(internal, submitting.providerMessageId);
  internal.submittingUserMessage = null;
  internal.userTurnInFlight = false;
  const notify = internal.notify;
  internal.notify = null;
  notify?.();
  return toPendingAgentMessage(submitting.pending);
}

function toPendingAgentMessage(pending: InternalSession['pendingUserMessages'][number] | undefined) {
  const deferred = pending?.deferredUserEvent;
  if (!deferred?.turnCorrelationId) return null;
  return {
    id: deferred.turnCorrelationId,
    text: deferred.text,
    ...(deferred.attachments
      ? { attachments: deferred.attachments.map((attachment) => ({ ...attachment })) }
      : {}),
  } satisfies PendingAgentMessage;
}
