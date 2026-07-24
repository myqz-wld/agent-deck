import type { PendingAgentMessage } from '@main/adapters/types';
import type { AgentEvent } from '@shared/types';
import { AGENT_ID } from './constants';
import type {
  CodexDeferredUserEvent,
  CodexSubmittingUserMessage,
  InternalSession,
} from './types';

export function pendingCodexUserMessage(
  deferred: CodexDeferredUserEvent | null | undefined,
): PendingAgentMessage | null {
  if (!deferred?.turnCorrelationId) return null;
  return {
    id: deferred.turnCorrelationId,
    text: deferred.text,
    ...(deferred.attachments
      ? { attachments: deferred.attachments.map((attachment) => ({ ...attachment })) }
      : {}),
  };
}

export function acceptCodexSubmittingUserMessage(
  emit: (event: AgentEvent) => void,
  internal: InternalSession,
  submission: CodexSubmittingUserMessage | null,
): void {
  if (!submission || internal.submittingUserMessage !== submission) return;
  internal.submittingUserMessage = null;
  if (submission.cancelled) return;
  const deferred = submission.event;
  emit({
    sessionId: internal.applicationSid,
    agentId: AGENT_ID,
    kind: 'message',
    payload: {
      text: deferred.text,
      role: 'user',
      ...(submission.kind === 'steer' ? { steer: true } : {}),
      ...(deferred.attachments?.length ? { attachments: deferred.attachments } : {}),
      ...(deferred.turnCorrelationId
        ? { turnCorrelationId: deferred.turnCorrelationId }
        : {}),
    },
    ts: Date.now(),
    source: 'sdk',
  });
}
