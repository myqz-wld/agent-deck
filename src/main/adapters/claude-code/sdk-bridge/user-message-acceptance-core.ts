import type { AgentEvent } from '@shared/types';
import type { InternalSession } from './types';

const MAX_IGNORED_USER_MESSAGE_IDS = 32;

export interface ClaudeUserMessageAcceptanceHost {
  readonly agentId: string;
  now(): number;
}

interface ClaudeAcceptanceFrame {
  type: string;
  uuid?: unknown;
  parent_tool_use_id?: unknown;
  user_message_uuid?: unknown;
  user_message_uuids?: unknown;
}

export function confirmClaudeUserMessageAcceptanceCore(
  emit: (event: AgentEvent) => void,
  sessionId: string,
  msg: ClaudeAcceptanceFrame,
  internal: InternalSession,
  host: ClaudeUserMessageAcceptanceHost,
): void {
  if (
    msg.type === 'user' &&
    typeof msg.uuid === 'string' &&
    internal.ignoredUserMessageIds?.delete(msg.uuid)
  ) return;
  const submitting = internal.submittingUserMessage;
  if (!submitting || msg.parent_tool_use_id != null) return;
  if (msg.type === 'user') {
    if (typeof msg.uuid !== 'string') return;
    if (submitting.providerMessageId !== msg.uuid) return;
  } else {
    if (!['assistant', 'stream_event', 'result'].includes(msg.type)) return;
    const ids = Array.isArray(msg.user_message_uuids) ? msg.user_message_uuids : [];
    const correlated = msg.user_message_uuid === submitting.providerMessageId
      || ids.includes(submitting.providerMessageId);
    if (!correlated && (
      msg.type !== 'assistant'
      || submitting.precedingTurn != null
      || typeof msg.user_message_uuid === 'string'
      || ids.length > 0
    )) return;
  }
  // Replay acknowledgements retain the input UUID even when persisted user frames replace it.
  // Uncorrelated assistant fallback is safe only for input submitted while the provider was idle.
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
  const notify = internal.notify;
  internal.notify = null;
  notify?.();
}

/** An older turn's result must not drop a correction already handed to the SDK. */
export function finishClaudeUserMessageTurnCore(internal: InternalSession): void {
  const submitting = internal.submittingUserMessage;
  if (submitting?.precedingTurn) {
    submitting.precedingTurn = 'finished';
    return;
  }
  discardClaudeSubmittingUserMessageCore(internal);
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
