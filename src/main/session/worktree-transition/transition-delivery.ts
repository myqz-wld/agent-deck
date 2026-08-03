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
import type {
  WorktreeTransitionPhase,
  WorktreeTransitionRecord,
} from './types';

export type WorktreeInputSettlement =
  | {
      kind: 'phase';
      expected: WorktreeTransitionPhase;
      next: 'active' | 'cleared';
      lastError?: string | null;
    }
  | {
      kind: 'seal';
      expected: 'cleanup_pending';
      lastError: string;
    };

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
  settlement: WorktreeInputSettlement,
): Promise<WorktreeTransitionRecord> {
  return settleTransitionInputs(
    record,
    adapter,
    settlement,
    'abort',
  );
}

async function replayTransitionInputBatch(
  record: WorktreeTransitionRecord,
  adapter: AgentAdapter,
  idempotencyKind: 'abort' | 'input',
): Promise<void> {
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
        idempotencyKey: `${record.continuationKey}:${idempotencyKind}:${input.sequence}`,
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

export async function settleTransitionInputs(
  record: WorktreeTransitionRecord,
  adapter: AgentAdapter,
  settlement: WorktreeInputSettlement,
  idempotencyKind: 'abort' | 'input',
): Promise<WorktreeTransitionRecord> {
  while (true) {
    await replayTransitionInputBatch(record, adapter, idempotencyKind);
    const result = settlement.kind === 'phase'
      ? worktreeTransitionRepo.settleAfterInputDrain({
          sessionId: record.sessionId,
          generation: record.generation,
          expected: settlement.expected,
          next: settlement.next,
          updatedAt: Date.now(),
          lastError: settlement.lastError,
        })
      : worktreeTransitionRepo.sealInputAfterDrain({
          sessionId: record.sessionId,
          generation: record.generation,
          expected: settlement.expected,
          updatedAt: Date.now(),
          lastError: settlement.lastError,
        });
    if (result.settled) return result.record;
  }
}

export async function deliverTransitionWork(
  record: WorktreeTransitionRecord,
  adapter: AgentAdapter,
  transition: AgentCwdTransition,
  continuationAccepted: boolean,
  settlement: WorktreeInputSettlement,
): Promise<WorktreeTransitionRecord> {
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
  return settleTransitionInputs(
    record,
    adapter,
    settlement,
    'input',
  );
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
