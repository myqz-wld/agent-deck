import type { CreateSessionOptions, QueuedAgentMessage } from '@main/adapters/types';
import type { SessionRecord, UploadedAttachmentRef } from '@shared/types';
import { executeFreshSession } from '../continuation-context/fresh-session-executor';
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
    readonly successorSessionId: string,
    readonly successorCleanup: 'ok' | 'failed',
    /** Structured coordinator result when transfer completed but reported failure. */
    readonly resourceTransfer: ResourceTransfer | null,
    /** Explicit error detail when the transfer callback or its result classifier threw. */
    readonly transferError: string | null,
    /** Source incompatibility detected after successor creation, when stage is cutover. */
    readonly cutoverReason: HandOffSourceCutoverRejectionReason | null = null,
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
  createSuccessor?: (
    target: CreateSessionOptions,
    turn: TrustedContinuationInitialTurn,
  ) => Promise<string>;
  deliverLateMessages?: (
    input: DeliverHandOffLateMessagesInput,
  ) => Promise<UploadedAttachmentRef[]>;
  cleanupLateMessageAttachments?: (
    attachments: HandOffLateMessageDeliveryError['createdAttachments'],
  ) => Promise<void>;
  transferResources: (input: {
    callerSessionId: string;
    callerRow: SessionRecord;
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
  const createSuccessor = input.createSuccessor ?? executeFreshSession;
  const deliverLateMessages = input.deliverLateMessages ?? deliverHandOffLateMessages;
  const successorSessionId = await createSuccessor(input.target, input.turn);
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
          origin: 'legacy-unwrapped' as const,
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
        ...(failedAttachments.length > 0
          ? {
              afterClose: () => cleanupLateMessageAttachments(failedAttachments),
            }
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
      callerRow: input.source,
      newSessionId: successorSessionId,
    });
  } catch (error) {
    return failAfterSuccessor({
      stage: 'transfer',
      successorSessionId,
      closeSuccessor: input.closeSuccessor,
      resourceTransfer: null,
      transferError: errorMessage(error),
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
    };
  } catch (error) {
    return {
      successorSessionId,
      queuedMessagesDelivered: queuedMessages.length,
      resourceTransfer,
      sourceCutover,
      sourceFinalization: { ok: false, error: errorMessage(error) },
    };
  }
}
