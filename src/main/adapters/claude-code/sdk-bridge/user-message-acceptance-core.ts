import type { AgentEvent } from '@shared/types';
import type { InternalSession } from './types';

const MAX_IGNORED_USER_MESSAGE_IDS = 32;

export interface ClaudeUserMessageAcceptanceHost {
  readonly agentId: string;
  now(): number;
}

export function confirmClaudeUserMessageAcceptanceCore(
  emit: (event: AgentEvent) => void,
  sessionId: string,
  msg: { type: string; uuid?: unknown },
  internal: InternalSession,
  host: ClaudeUserMessageAcceptanceHost,
): void {
  if (msg.type !== 'user' || typeof msg.uuid !== 'string') return;
  if (internal.ignoredUserMessageIds?.delete(msg.uuid)) return;
  const submitting = internal.submittingUserMessage;
  if (!submitting || submitting.providerMessageId !== msg.uuid) return;
  internal.submittingUserMessage = null;
  const deferred = submitting.pending.deferredUserEvent;
  if (!deferred) return;
  emit({
    sessionId,
    agentId: host.agentId,
    kind: 'message',
    payload: {
      text: deferred.text,
      role: 'user',
      ...(deferred.attachments?.length ? { attachments: deferred.attachments } : {}),
      ...(deferred.turnCorrelationId
        ? { turnCorrelationId: deferred.turnCorrelationId }
        : {}),
    },
    ts: host.now(),
    source: 'sdk',
  });
}

export function discardClaudeSubmittingUserMessageCore(
  internal: InternalSession,
): void {
  const submitting = internal.submittingUserMessage;
  if (!submitting) return;
  rememberIgnoredClaudeUserMessageIdCore(internal, submitting.providerMessageId);
  internal.submittingUserMessage = null;
}

export function rememberIgnoredClaudeUserMessageIdCore(
  internal: InternalSession,
  messageId: string,
): void {
  const ignored = (internal.ignoredUserMessageIds ??= new Set());
  ignored.add(messageId);
  while (ignored.size > MAX_IGNORED_USER_MESSAGE_IDS) {
    const oldest = ignored.values().next().value;
    if (!oldest) break;
    ignored.delete(oldest);
  }
}
