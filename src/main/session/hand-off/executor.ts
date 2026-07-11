import type { CreateSessionOptions } from '@main/adapters/types';
import type { SessionRecord } from '@shared/types';
import { executeFreshSession } from '../continuation-context/fresh-session-executor';
import type { TrustedContinuationInitialTurn } from '../continuation-context/initial-turn';

export interface HandOffSourceCutoverPrecondition {
  eventRevision: number;
  rebuildAfterRevision: number;
  runtimeFingerprint: string;
}

export interface HandOffSourceCutoverCheck {
  sourceSessionId: string;
  expected: HandOffSourceCutoverPrecondition;
}

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
  ) {
    super(message);
    this.name = 'HandOffExecutionError';
  }
}

export interface ExecutePreparedHandOffInput<ResourceTransfer, FinalizationResult> {
  source: SessionRecord;
  sourcePrecondition: HandOffSourceCutoverPrecondition;
  sourcePreconditionMatches: (input: HandOffSourceCutoverCheck) => boolean;
  target: CreateSessionOptions;
  turn: TrustedContinuationInitialTurn;
  createSuccessor?: (
    target: CreateSessionOptions,
    turn: TrustedContinuationInitialTurn,
  ) => Promise<string>;
  transferResources: (input: {
    callerSessionId: string;
    callerRow: SessionRecord;
    newSessionId: string;
  }) => ResourceTransfer;
  resourceTransferFailed: (result: ResourceTransfer) => boolean;
  closeSuccessor: (sessionId: string) => Promise<void>;
  finalizeSource: (input: {
    source: SessionRecord;
    successorSessionId: string;
    resourceTransfer: ResourceTransfer;
  }) => FinalizationResult | Promise<FinalizationResult>;
}

export interface ExecutePreparedHandOffResult<ResourceTransfer, FinalizationResult> {
  successorSessionId: string;
  resourceTransfer: ResourceTransfer;
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
}): Promise<never> {
  let successorCleanup: 'ok' | 'failed' = 'ok';
  try {
    await input.closeSuccessor(input.successorSessionId);
  } catch {
    successorCleanup = 'failed';
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
  const successorSessionId = await createSuccessor(input.target, input.turn);
  let sourceMatches = false;
  try {
    sourceMatches = input.sourcePreconditionMatches({
      sourceSessionId: input.source.id,
      expected: input.sourcePrecondition,
    });
  } catch {
    sourceMatches = false;
  }
  if (!sourceMatches) {
    return failAfterSuccessor({
      stage: 'cutover',
      successorSessionId,
      closeSuccessor: input.closeSuccessor,
      resourceTransfer: null,
      transferError: null,
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
    });
  }
  if (transferFailed) {
    return failAfterSuccessor({
      stage: 'transfer',
      successorSessionId,
      closeSuccessor: input.closeSuccessor,
      resourceTransfer,
      transferError: null,
    });
  }

  try {
    const value = await input.finalizeSource({
      source: input.source,
      successorSessionId,
      resourceTransfer,
    });
    return {
      successorSessionId,
      resourceTransfer,
      sourceFinalization: { ok: true, value },
    };
  } catch (error) {
    return {
      successorSessionId,
      resourceTransfer,
      sourceFinalization: { ok: false, error: errorMessage(error) },
    };
  }
}
