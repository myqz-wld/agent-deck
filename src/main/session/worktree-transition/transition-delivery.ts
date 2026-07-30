import type {
  AgentAdapter,
  AgentCwdTransition,
} from '@main/adapters/types';
import { worktreeTransitionInputRepo } from '@main/store/worktree-transition-input-repo';
import { worktreeTransitionRepo } from '@main/store/worktree-transition-repo';
import type { UploadedAttachmentRef } from '@shared/types';
import {
  WORKTREE_TRANSITION_CONTINUATION,
  WORKTREE_TRANSITION_FAILURE_CONTINUATION,
} from './constants';
import type { WorktreeTransitionRecord } from './types';

export function toAgentCwdTransition(
  record: WorktreeTransitionRecord,
): AgentCwdTransition {
  return {
    sessionId: record.sessionId,
    generation: record.generation,
    direction: record.direction,
    fromCwd:
      record.direction === 'enter'
        ? record.originalCwd
        : record.worktreePath,
    targetCwd: record.targetCwd,
    continuationKey: record.continuationKey,
    continuationText: WORKTREE_TRANSITION_CONTINUATION,
  };
}

export async function replayAbortedTransitionInputs(
  record: WorktreeTransitionRecord,
  adapter: AgentAdapter,
): Promise<void> {
  if (!adapter.enqueueMessage) {
    throw new Error(`${adapter.id} cannot replay aborted transition input.`);
  }
  for (const input of worktreeTransitionInputRepo.listPending(
    record.sessionId,
    record.generation,
  )) {
    await adapter.enqueueMessage(
      record.sessionId,
      input.text,
      input.attachments as UploadedAttachmentRef[],
      {
        bypassQueueLimit: true,
        userEventAlreadyPersisted: true,
        bypassWorktreeTransitionGuard: true,
        idempotencyKey: `${record.continuationKey}:abort:${input.sequence}`,
      },
    );
    worktreeTransitionInputRepo.markDelivered(
      record.sessionId,
      record.generation,
      input.sequence,
      Date.now(),
    );
  }
}

export async function deliverTransitionWork(
  record: WorktreeTransitionRecord,
  adapter: AgentAdapter,
  transition: AgentCwdTransition,
  continuationAccepted: boolean,
): Promise<void> {
  if (!record.continuationDelivered) {
    if (!continuationAccepted) {
      if (!adapter.enqueueCwdTransitionContinuation) {
        throw new Error(
          `${adapter.id} cannot enqueue the fixed cwd continuation.`,
        );
      }
      await adapter.enqueueCwdTransitionContinuation(
        transition,
        WORKTREE_TRANSITION_CONTINUATION,
      );
    }
    worktreeTransitionRepo.markContinuationDelivered(
      record.sessionId,
      record.generation,
      record.continuationKey,
      Date.now(),
    );
  }
  if (!adapter.enqueueMessage) {
    throw new Error(`${adapter.id} cannot replay transition-buffered input.`);
  }
  for (const input of worktreeTransitionInputRepo.listPending(
    record.sessionId,
    record.generation,
  )) {
    await adapter.enqueueMessage(
      record.sessionId,
      input.text,
      input.attachments as UploadedAttachmentRef[],
      {
        bypassQueueLimit: true,
        userEventAlreadyPersisted: true,
        bypassWorktreeTransitionGuard: true,
        idempotencyKey: `${record.continuationKey}:input:${input.sequence}`,
      },
    );
    worktreeTransitionInputRepo.markDelivered(
      record.sessionId,
      record.generation,
      input.sequence,
      Date.now(),
    );
  }
}

export async function compensateTransitionRuntime(
  adapter: AgentAdapter,
  transition: AgentCwdTransition,
): Promise<void> {
  const compensation: AgentCwdTransition = {
    ...transition,
    fromCwd: transition.targetCwd,
    targetCwd: transition.fromCwd,
    continuationKey: `${transition.continuationKey}:rollback`,
    continuationText: WORKTREE_TRANSITION_FAILURE_CONTINUATION,
  };
  try {
    await adapter.switchCwdForTransition?.(compensation);
  } catch (rollbackError) {
    throw new Error(
      `Runtime cwd changed but persistence failed, and runtime compensation also failed: ${
        rollbackError instanceof Error
          ? rollbackError.message
          : String(rollbackError)
      }`,
      { cause: rollbackError },
    );
  }
}
