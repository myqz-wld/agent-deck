import type { CreateSessionOptions, QueuedAgentMessage } from '@main/adapters/types';
import type { SessionRecord, UploadedAttachmentRef } from '@shared/types';
import type { TrustedContinuationSessionCandidate } from '@main/adapters/trusted-continuation';
import {
  executeTrustedContinuationCandidate,
  rollbackTrustedContinuationCandidate,
} from '../continuation-context/fresh-session-executor';
import type { TrustedContinuationInitialTurn } from '../continuation-context/initial-turn';
import {
  cleanupHandOffLateMessageAttachments,
  deliverHandOffLateMessages,
  HandOffLateMessageDeliveryError,
  type DeliverHandOffLateMessagesInput,
} from './late-message-delivery';
import type {
  HandOffSourceCutoverCheck,
  HandOffSourceCutoverPrecondition,
  HandOffSourceCutoverRejectionReason,
  HandOffSourceCutoverResult,
} from './source-precondition';
import {
  selectTrustedContinuationCandidate,
  TrustedContinuationGateFailure,
  type HandOffSuccessorCleanup,
  type HandOffTrustedContinuationFailureReason,
} from './trusted-continuation-gate';

const MAX_LATE_MESSAGE_DELIVERY_PASSES = 8;

export type {
  HandOffSourceCutoverCheck,
  HandOffSourceCutoverPrecondition,
  HandOffSourceCutoverResult,
} from './source-precondition';

export class HandOffExecutionError<ResourceTransfer> extends Error {
  constructor(
    message: string,
    readonly stage: 'cutover' | 'transfer',
    readonly successorSessionId: string | null,
    readonly successorCleanup: HandOffSuccessorCleanup,
    /** Structured coordinator result when transfer completed but reported failure. */
    readonly resourceTransfer: ResourceTransfer | null,
    /** Explicit error detail when the transfer callback or its result classifier threw. */
    readonly transferError: string | null,
    /** Source incompatibility detected after successor creation, when stage is cutover. */
    readonly cutoverReason:
      | HandOffSourceCutoverRejectionReason
      | HandOffTrustedContinuationFailureReason
      | null = null,
    readonly usedLowerBudgetRetry = false,
  ) {
    super(message);
    this.name = 'HandOffExecutionError';
  }
}

export interface ExecutePreparedHandOffInput<ResourceTransfer, FinalizationResult> {
  source: SessionRecord;
  /** Provider turns accepted before the ingress gate, but not yet started on the source. */
  queuedMessages?: QueuedAgentMessage[];
  sourcePrecondition: HandOffSourceCutoverPrecondition;
  sourcePreconditionCheck: (input: HandOffSourceCutoverCheck) => HandOffSourceCutoverResult;
  target: CreateSessionOptions;
  turn: TrustedContinuationInitialTurn;
  trustedContinuationReadiness?: {
    capacityStatus: 'observed' | 'stale' | 'unknown';
    lowerBudgetRetryTurn: TrustedContinuationInitialTurn | null;
    /** Test seam; production uses the fixed 90-second absolute deadline. */
    deadlineMs?: number;
  };
  createSuccessor?: (
    target: CreateSessionOptions,
    turn: TrustedContinuationInitialTurn,
  ) => Promise<TrustedContinuationSessionCandidate>;
  rollbackRejectedSuccessor?: (sessionId: string) => Promise<void>;
  deliverLateMessages?: (
    input: DeliverHandOffLateMessagesInput,
  ) => Promise<UploadedAttachmentRef[]>;
  cleanupLateMessageAttachments?: (
    attachments: HandOffLateMessageDeliveryError['createdAttachments'],
  ) => Promise<void>;
  /**
   * Wait for claims that crossed the ingress/cutover boundary before this execution started.
   * The hook must not start a new claim and returns false on its bounded timeout.
   */
  drainMessageDeliveries?: (sourceSessionId: string) => Promise<boolean>;
  transferResources: (input: {
    callerSessionId: string;
    newSessionId: string;
  }) => ResourceTransfer;
  resourceTransferFailed: (result: ResourceTransfer) => boolean;
  /** Atomically switch ingress ownership after durable transfer and before async finalization. */
  commitIngress?: (successorSessionId: string) => void;
  /** Revoke an in-flight UI execution when the source is explicitly closed or removed. */
  sourceOwnershipCheck?: () => boolean;
  closeSuccessor: (sessionId: string) => Promise<void>;
  finalizeSource: (input: {
    source: SessionRecord;
    successorSessionId: string;
    resourceTransfer: ResourceTransfer;
  }) => FinalizationResult | Promise<FinalizationResult>;
}

export interface ExecutePreparedHandOffResult<ResourceTransfer, FinalizationResult> {
  successorSessionId: string;
  queuedMessagesDelivered: number;
  resourceTransfer: ResourceTransfer;
  sourceCutover: Extract<HandOffSourceCutoverResult, { ok: true }>;
  sourceFinalization:
    | { ok: true; value: FinalizationResult }
    | { ok: false; error: string };
  /** Safe diagnostic; provider prompts and runtime evidence remain private. */
  usedLowerBudgetRetry: boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function failAfterSuccessor<ResourceTransfer>(input: {
  stage: 'cutover' | 'transfer';
  successorSessionId: string;
  closeSuccessor: (sessionId: string) => Promise<void>;
  resourceTransfer: ResourceTransfer | null;
  transferError: string | null;
  cutoverReason?: HandOffSourceCutoverRejectionReason | null;
  usedLowerBudgetRetry: boolean;
  afterClose?: () => Promise<void>;
}): Promise<never> {
  let successorCleanup: 'ok' | 'failed' = 'ok';
  try {
    await input.closeSuccessor(input.successorSessionId);
  } catch {
    successorCleanup = 'failed';
  }
  if (successorCleanup === 'ok' && input.afterClose) {
    try {
      await input.afterClose();
    } catch {
      // Upload reaper remains the final fallback; cleanup failure must not mask cutover failure.
    }
  }
  throw new HandOffExecutionError(
    input.stage === 'cutover'
      ? 'Source changed while the handoff successor was being created; source resources remain untouched'
      : input.transferError
        ? `Mandatory handoff resource transfer threw: ${input.transferError}`
        : 'Mandatory handoff resource transfer failed; source session remains usable',
    input.stage,
    input.successorSessionId,
    successorCleanup,
    input.resourceTransfer,
    input.transferError,
    input.cutoverReason ?? null,
    input.usedLowerBudgetRetry,
  );
}

/**
 * Shared lifecycle ordering for UI and MCP handoff. Source state is untouched until successor
 * creation and mandatory resource transfer both succeed. A transfer failure closes the orphaned
 * successor best-effort and reports its stable id if cleanup also fails.
 */
export async function executePreparedHandOff<ResourceTransfer, FinalizationResult>(
  input: ExecutePreparedHandOffInput<ResourceTransfer, FinalizationResult>,
): Promise<ExecutePreparedHandOffResult<ResourceTransfer, FinalizationResult>> {
  const createSuccessor = input.createSuccessor ?? executeTrustedContinuationCandidate;
  const deliverLateMessages = input.deliverLateMessages ?? deliverHandOffLateMessages;
  const readiness = input.trustedContinuationReadiness ?? {
    capacityStatus: 'observed' as const,
    lowerBudgetRetryTurn: null,
  };
  let selected: Awaited<ReturnType<typeof selectTrustedContinuationCandidate>>;
  try {
    selected = await selectTrustedContinuationCandidate({
      capacityStatus: readiness.capacityStatus,
      primaryTurn: input.turn,
      lowerBudgetRetryTurn: readiness.lowerBudgetRetryTurn,
      createCandidate: (turn) => createSuccessor(input.target, turn),
      rollbackRejectedCandidate:
        input.rollbackRejectedSuccessor ??
        ((sessionId) => rollbackTrustedContinuationCandidate(input.target, sessionId)),
      closeCandidateBestEffort: input.closeSuccessor,
      ...(readiness.deadlineMs !== undefined ? { deadlineMs: readiness.deadlineMs } : {}),
    });
  } catch (error) {
    if (!(error instanceof TrustedContinuationGateFailure)) throw error;
    throw new HandOffExecutionError(
      error.message,
      'cutover',
      error.successorSessionId,
      error.successorCleanup,
      null,
      null,
      error.reason,
      error.usedLowerBudgetRetry,
    );
  }
  const successorSessionId = selected.candidate.sessionId;
  const deliveredLateMessageIds = new Set<number>();
  const createdLateAttachments: UploadedAttachmentRef[] = [];
  const cleanupLateMessageAttachments =
    input.cleanupLateMessageAttachments ?? cleanupHandOffLateMessageAttachments;
  const cleanupCreatedAttachments = (): Promise<void> =>
    cleanupLateMessageAttachments(createdLateAttachments);
  const ownershipIsHeld = (): boolean => {
    try {
      return input.sourceOwnershipCheck?.() ?? true;
    } catch {
      return false;
    }
  };
  const queuedMessages = input.queuedMessages ?? [];
  if (queuedMessages.length > 0) {
    try {
      const created = await deliverLateMessages({
        successorSessionId,
        target: input.target,
        messages: queuedMessages.map((message, index) => ({
          eventId: -(index + 1),
          text: message.text,
          attachments: message.attachments ?? [],
          origin: 'user' as const,
        })),
      });
      createdLateAttachments.push(...created);
    } catch (error) {
      const failedAttachments =
        error instanceof HandOffLateMessageDeliveryError
          ? [...createdLateAttachments, ...error.createdAttachments]
          : createdLateAttachments;
      return failAfterSuccessor({
        stage: 'cutover',
        successorSessionId,
        closeSuccessor: input.closeSuccessor,
        resourceTransfer: null,
        transferError: errorMessage(error),
        cutoverReason: 'late-message-delivery-failed',
        usedLowerBudgetRetry: selected.usedLowerBudgetRetry,
        ...(failedAttachments.length > 0
          ? {
              afterClose: () => cleanupLateMessageAttachments(failedAttachments),
            }
          : {}),
      });
    }
  }
  if (input.drainMessageDeliveries) {
    if (!ownershipIsHeld()) {
      return failAfterSuccessor({
        stage: 'cutover',
        successorSessionId,
        closeSuccessor: input.closeSuccessor,
        resourceTransfer: null,
        transferError: null,
        cutoverReason: 'source-not-open',
        usedLowerBudgetRetry: selected.usedLowerBudgetRetry,
        ...(createdLateAttachments.length > 0
          ? { afterClose: cleanupCreatedAttachments }
          : {}),
      });
    }
    let drained = false;
    try {
      drained = await input.drainMessageDeliveries(input.source.id);
    } catch {
      drained = false;
    }
    if (!drained) {
      return failAfterSuccessor({
        stage: 'cutover',
        successorSessionId,
        closeSuccessor: input.closeSuccessor,
        resourceTransfer: null,
        transferError: null,
        cutoverReason: 'message-delivery-drain-timeout',
        usedLowerBudgetRetry: selected.usedLowerBudgetRetry,
        ...(createdLateAttachments.length > 0
          ? { afterClose: cleanupCreatedAttachments }
          : {}),
      });
    }
  }
  let sourceCutover: Extract<HandOffSourceCutoverResult, { ok: true }> | null = null;
  // Permit eight delivery batches plus one final scan that proves the tail is quiescent.
  for (let pass = 0; pass <= MAX_LATE_MESSAGE_DELIVERY_PASSES; pass += 1) {
    if (!ownershipIsHeld()) {
      return failAfterSuccessor({
        stage: 'cutover',
        successorSessionId,
        closeSuccessor: input.closeSuccessor,
        resourceTransfer: null,
        transferError: null,
        cutoverReason: 'source-not-open',
        usedLowerBudgetRetry: selected.usedLowerBudgetRetry,
        ...(createdLateAttachments.length > 0
          ? { afterClose: cleanupCreatedAttachments }
          : {}),
      });
    }
    let current: HandOffSourceCutoverResult;
    try {
      current = input.sourcePreconditionCheck({
        sourceSessionId: input.source.id,
        expected: input.sourcePrecondition,
      });
    } catch {
      current = { ok: false, reason: 'check-failed', currentEventRevision: null };
    }
    if (!current.ok) {
      return failAfterSuccessor({
        stage: 'cutover',
        successorSessionId,
        closeSuccessor: input.closeSuccessor,
        resourceTransfer: null,
        transferError: null,
        cutoverReason: current.reason,
        usedLowerBudgetRetry: selected.usedLowerBudgetRetry,
        ...(createdLateAttachments.length > 0
          ? { afterClose: cleanupCreatedAttachments }
          : {}),
      });
    }
    const pendingMessages = current.lateMessages.filter(
      (message) => !deliveredLateMessageIds.has(message.eventId),
    );
    if (pendingMessages.length === 0) {
      sourceCutover = current;
      break;
    }
    if (pass === MAX_LATE_MESSAGE_DELIVERY_PASSES) break;
    try {
      const created = await deliverLateMessages({
        successorSessionId,
        target: input.target,
        messages: pendingMessages,
      });
      createdLateAttachments.push(...created);
      for (const message of pendingMessages) deliveredLateMessageIds.add(message.eventId);
    } catch (error) {
      const failedAttachments =
        error instanceof HandOffLateMessageDeliveryError
          ? [...createdLateAttachments, ...error.createdAttachments]
          : createdLateAttachments;
      return failAfterSuccessor({
        stage: 'cutover',
        successorSessionId,
        closeSuccessor: input.closeSuccessor,
        resourceTransfer: null,
        transferError: errorMessage(error),
        cutoverReason: 'late-message-delivery-failed',
        usedLowerBudgetRetry: selected.usedLowerBudgetRetry,
        ...(failedAttachments.length > 0
          ? {
              afterClose: () => cleanupLateMessageAttachments(failedAttachments),
            }
          : {}),
      });
    }
  }
  if (!sourceCutover) {
    return failAfterSuccessor({
      stage: 'cutover',
      successorSessionId,
      closeSuccessor: input.closeSuccessor,
      resourceTransfer: null,
      transferError: null,
      cutoverReason: 'source-kept-changing',
      usedLowerBudgetRetry: selected.usedLowerBudgetRetry,
      ...(createdLateAttachments.length > 0
        ? { afterClose: cleanupCreatedAttachments }
        : {}),
    });
  }

  if (!ownershipIsHeld()) {
    return failAfterSuccessor({
      stage: 'cutover',
      successorSessionId,
      closeSuccessor: input.closeSuccessor,
      resourceTransfer: null,
      transferError: null,
      cutoverReason: 'source-not-open',
      usedLowerBudgetRetry: selected.usedLowerBudgetRetry,
      ...(createdLateAttachments.length > 0
        ? { afterClose: cleanupCreatedAttachments }
        : {}),
    });
  }

  // The production transfer is deliberately synchronous. Once the post-create guard succeeds,
  // no provider/event-loop turn can interleave before ownership moves and finalization starts.
  let resourceTransfer: ResourceTransfer;
  try {
    resourceTransfer = input.transferResources({
      callerSessionId: input.source.id,
      newSessionId: successorSessionId,
    });
  } catch (error) {
    return failAfterSuccessor({
      stage: 'transfer',
      successorSessionId,
      closeSuccessor: input.closeSuccessor,
      resourceTransfer: null,
      transferError: errorMessage(error),
      usedLowerBudgetRetry: selected.usedLowerBudgetRetry,
      ...(createdLateAttachments.length > 0
        ? { afterClose: cleanupCreatedAttachments }
        : {}),
    });
  }
  let transferFailed: boolean;
  try {
    transferFailed = input.resourceTransferFailed(resourceTransfer);
  } catch (error) {
    return failAfterSuccessor({
      stage: 'transfer',
      successorSessionId,
      closeSuccessor: input.closeSuccessor,
      resourceTransfer,
      transferError: errorMessage(error),
      usedLowerBudgetRetry: selected.usedLowerBudgetRetry,
      ...(createdLateAttachments.length > 0
        ? { afterClose: cleanupCreatedAttachments }
        : {}),
    });
  }
  if (transferFailed) {
    return failAfterSuccessor({
      stage: 'transfer',
      successorSessionId,
      closeSuccessor: input.closeSuccessor,
      resourceTransfer,
      transferError: null,
      usedLowerBudgetRetry: selected.usedLowerBudgetRetry,
      ...(createdLateAttachments.length > 0
        ? { afterClose: cleanupCreatedAttachments }
        : {}),
    });
  }

  input.commitIngress?.(successorSessionId);

  try {
    const value = await input.finalizeSource({
      source: input.source,
      successorSessionId,
      resourceTransfer,
    });
    return {
      successorSessionId,
      queuedMessagesDelivered: queuedMessages.length,
      resourceTransfer,
      sourceCutover,
      sourceFinalization: { ok: true, value },
      usedLowerBudgetRetry: selected.usedLowerBudgetRetry,
    };
  } catch (error) {
    return {
      successorSessionId,
      queuedMessagesDelivered: queuedMessages.length,
      resourceTransfer,
      sourceCutover,
      sourceFinalization: { ok: false, error: errorMessage(error) },
      usedLowerBudgetRetry: selected.usedLowerBudgetRetry,
    };
  }
}
