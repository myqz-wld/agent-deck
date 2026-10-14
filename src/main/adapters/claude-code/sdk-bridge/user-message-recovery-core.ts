import type { AgentEvent } from '@shared/types';
import type { MessageDeliveryRecoveryStatus } from '@shared/message-delivery-recovery';
import type { InternalSession, PendingUserMessage } from './types';

// A thunk can reach more than one terminal path. Mark it only after durable event emission succeeds.
const recorded = new WeakSet<PendingUserMessage>();

export function preserveClaudeUserMessageCore(
  emit: (event: AgentEvent) => void,
  sessionId: string,
  pending: PendingUserMessage,
  status: MessageDeliveryRecoveryStatus,
  host: { agentId: string; now(): number },
): void {
  const deferred = pending.deferredUserEvent;
  if (!deferred || recorded.has(pending)) return;
  emit({
    sessionId,
    agentId: host.agentId,
    kind: 'message',
    payload: {
      role: 'system',
      error: true,
      text: deferred.text,
      ...(deferred.attachments?.length
        ? { attachments: deferred.attachments.map((attachment) => ({ ...attachment })) } : {}),
      messageDeliveryRecovery: {
        status,
        originalTextLength: deferred.text.length,
        messageId: deferred.turnCorrelationId ?? null,
        attachmentCount: deferred.attachments?.length ?? 0,
      },
    },
    ts: host.now(),
    source: 'sdk',
  });
  recorded.add(pending);
}

/** Expected retirement transfers or cancels its queue elsewhere; only unexpected loss is recovered. */
export function preserveClaudeStreamInputsCore(
  emit: (event: AgentEvent) => void,
  internal: InternalSession,
  host: { agentId: string; now(): number },
): void {
  if (internal.expectedClose || internal.retireRequested) return;
  const submitting = internal.submittingUserMessage;
  if (submitting) {
    preserveClaudeUserMessageCore(emit, internal.applicationSid, submitting.pending, 'unknown', host);
    internal.submittingUserMessage = null;
  }
  // Remove each item only after its recovery record exists. A persistence failure retains the rest.
  while (internal.pendingUserMessages.length) {
    const pending = internal.pendingUserMessages[0]!;
    preserveClaudeUserMessageCore(emit, internal.applicationSid, pending, 'not-sent', host);
    internal.pendingUserMessages.shift();
  }
}
