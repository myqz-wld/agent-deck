import type { AgentEvent, SessionAdapterId, UploadedAttachmentRef } from '@shared/types';
import { eventBus } from '@main/event-bus';
import { sessionRepo } from '@main/store/session-repo';
import log from '@main/utils/logger';
import { handOffCutoverCoordinator } from './cutover-coordinator';

const logger = log.scope('handoff-input-buffer');

export interface BufferHandOffSourceInput {
  sourceSessionId: string;
  agentId: SessionAdapterId;
  text: string;
  attachments?: UploadedAttachmentRef[];
  emit: (event: AgentEvent) => void;
  replay: (sourceSessionId: string) => Promise<void>;
}

function markReplayedSourceWorking(sourceSessionId: string): void {
  try {
    const source = sessionRepo.get(sourceSessionId);
    if (!source || source.lifecycle === 'closed') return;
    sessionRepo.setActivity(
      sourceSessionId,
      'working',
      Math.max(Date.now(), source.lastEventAt),
    );
    const updated = sessionRepo.get(sourceSessionId);
    if (updated) eventBus.emit('session-upserted', updated);
  } catch (error) {
    // The provider input was already replayed. Never surface this best-effort UI state update as a
    // replay failure, because the coordinator would otherwise retry and execute the message twice.
    logger.warn(`failed to mark replayed source working: ${sourceSessionId}`, error);
  }
}

/** Divert source ingress into durable history while an active handoff owns the next execution. */
export function bufferHandOffSourceInput(input: BufferHandOffSourceInput): boolean {
  return handOffCutoverCoordinator.tryBufferInput(input.sourceSessionId, {
    record: (sourceSessionId) => {
      input.emit({
        sessionId: sourceSessionId,
        agentId: input.agentId,
        kind: 'message',
        payload: {
          text: input.text,
          role: 'user',
          // Persisted evidence, but execution is owned by the cutover gate rather than the source.
          handOffBuffered: true,
          ...(input.attachments && input.attachments.length > 0
            ? { attachments: input.attachments }
            : {}),
        },
        ts: Date.now(),
        source: 'sdk',
      });
    },
    replay: async (sourceSessionId) => {
      await input.replay(sourceSessionId);
      markReplayedSourceWorking(sourceSessionId);
    },
    onReplayFailed: (sourceSessionId) => {
      input.emit({
        sessionId: sourceSessionId,
        agentId: input.agentId,
        kind: 'message',
        payload: {
          text: '⚠ 会话交接失败后，暂存输入未能恢复到源会话，请重新发送。',
          error: true,
        },
        ts: Date.now(),
        source: 'sdk',
      });
    },
  });
}
