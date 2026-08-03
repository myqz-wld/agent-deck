import type {
  AgentEvent,
  SessionAdapterId,
  UploadedAttachmentRef,
} from '@shared/types';
import {
  worktreeTransitionInputRepo,
  WorktreeTransitionInputClosedError,
} from '@main/store/worktree-transition-input-repo';
import { worktreeTransitionRepo } from '@main/store/worktree-transition-repo';
import type { WorktreeTransitionQueuedInput } from './types';
import { isPendingWorktreeTransition } from './state-machine';
import log from '@main/utils/logger';
import { isDbInitialized } from '@main/store/db';

const logger = log.scope('worktree-transition-ingress');

export interface WorktreeTransitionIngressInput {
  sessionId: string;
  agentId: SessionAdapterId;
  text: string;
  attachments?: UploadedAttachmentRef[];
  emit: (event: AgentEvent) => void;
}

/**
 * Durably diverts user ingress while a cwd switch owns the next provider turn. Returning true is
 * the acceptance boundary: the adapter must neither steer the old turn nor append its live queue.
 */
export function guardWorktreeTransitionIngress(
  input: WorktreeTransitionIngressInput,
): boolean {
  if (!isDbInitialized()) return false;
  const transition = worktreeTransitionRepo.get(input.sessionId);
  if (
    !transition ||
    !isPendingWorktreeTransition(transition.phase) ||
    transition.toolUseId === null
  ) {
    return false;
  }
  let queued: WorktreeTransitionQueuedInput;
  try {
    queued = worktreeTransitionInputRepo.append({
      sessionId: input.sessionId,
      generation: transition.generation,
      agentId: input.agentId,
      text: input.text,
      attachments: input.attachments,
      createdAt: Date.now(),
    });
  } catch (error) {
    // The phase/tool id can settle after the optimistic read above. The append transaction is the
    // authority: a closed buffer means this same input must continue into the live post-switch
    // adapter queue instead of surfacing a retryable transport error.
    if (error instanceof WorktreeTransitionInputClosedError) return false;
    throw error;
  }
  try {
    input.emit({
      sessionId: input.sessionId,
      agentId: input.agentId,
      kind: 'message',
      payload: {
        text: input.text,
        role: 'user',
        worktreeTransitionBuffered: {
          generation: transition.generation,
          sequence: queued.sequence,
        },
        ...(input.attachments?.length
          ? { attachments: input.attachments }
          : {}),
      },
      ts: queued.createdAt,
      source: 'sdk',
    });
  } catch (error) {
    // The durable queue already accepted the input. Retrying at the transport boundary would
    // execute it twice, so projection failure is diagnostic-only.
    logger.warn(
      `failed to project buffered input ${input.sessionId}:${transition.generation}:${queued.sequence}`,
      error,
    );
  }
  return true;
}
