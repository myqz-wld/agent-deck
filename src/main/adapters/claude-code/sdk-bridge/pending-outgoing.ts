import type { PendingAgentMessage, QueuedAgentMessage } from '@main/adapters/types';
import type { InternalSession } from './types';

function findSession(
  sessions: ReadonlyMap<string, InternalSession>,
  sessionId: string,
): InternalSession | null {
  return [...sessions.values()].find(
    (candidate) =>
      candidate.applicationSid === sessionId || candidate.cliSessionId === sessionId,
  ) ?? null;
}

export function snapshotClaudeQueuedMessagesForHandOff(
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

export function listClaudePendingOutgoingMessages(
  sessions: ReadonlyMap<string, InternalSession>,
  sessionId: string,
): PendingAgentMessage[] {
  const internal = findSession(sessions, sessionId);
  if (!internal) return [];
  return internal.pendingUserMessages.flatMap((pending) => {
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
}

export function removeClaudePendingOutgoingMessage(
  sessions: ReadonlyMap<string, InternalSession>,
  sessionId: string,
  messageId: string,
): PendingAgentMessage | null {
  const internal = findSession(sessions, sessionId);
  if (!internal) return null;
  const index = internal.pendingUserMessages.findIndex(
    (pending) => pending.deferredUserEvent?.turnCorrelationId === messageId,
  );
  if (index < 0) return null;
  const [pending] = internal.pendingUserMessages.splice(index, 1);
  const deferred = pending?.deferredUserEvent;
  if (!deferred?.turnCorrelationId) return null;
  const notify = internal.notify;
  internal.notify = null;
  notify?.();
  return {
    id: deferred.turnCorrelationId,
    text: deferred.text,
    ...(deferred.attachments
      ? { attachments: deferred.attachments.map((attachment) => ({ ...attachment })) }
      : {}),
  };
}
