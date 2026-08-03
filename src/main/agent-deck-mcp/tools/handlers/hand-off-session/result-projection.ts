import type { PreparedContinuationContext } from '@main/session/continuation-context/types';
import type { HandOffSessionResult } from '../../schemas';

export function publicContinuationResult(input: {
  primary: PreparedContinuationContext;
  lowerBudgetRetry: PreparedContinuationContext | null;
  usedLowerBudgetRetry: boolean;
  cutoverEventRevision: number;
  lateMessagesDelivered: number;
}): HandOffSessionResult['continuationContext'] {
  const prepared = input.usedLowerBudgetRetry ? input.lowerBudgetRetry : input.primary;
  if (!prepared) {
    throw new Error('Handoff selected a lower-budget retry without a prepared retry context');
  }
  return {
    version: prepared.version,
    quality: prepared.quality,
    sourceEventRevision: prepared.source.eventRevision,
    cutoverEventRevision: input.cutoverEventRevision,
    rebuildAfterRevision: prepared.source.rebuildAfterRevision,
    checkpoint: {
      id: prepared.checkpoint.id,
      formatVersion: prepared.checkpoint.formatVersion,
      throughRevision: prepared.checkpoint.throughRevision,
      refreshed: prepared.checkpoint.refreshed,
    },
    preparationHash: prepared.preparationHash,
    tokenStats: {
      rawRetentionCeiling: prepared.metrics.rawRetentionCeilingTokens,
      targetPromptCapacity: prepared.metrics.targetPromptCapacityTokens,
      checkpointProjectionBudget: prepared.metrics.checkpointProjectionBudgetTokens,
      generatorFoldInputBudget: prepared.metrics.generatorFoldInputBudgetTokens,
      estimatedPrompt: prepared.metrics.estimatedPromptTokens,
      checkpoint: prepared.metrics.checkpointTokens,
      rawTail: prepared.metrics.rawTailTokens,
    },
    includedUserMessages: prepared.metrics.includedUserMessages,
    lateMessagesDelivered: input.lateMessagesDelivered,
    usedLowerBudgetRetry: input.usedLowerBudgetRetry,
    truncatedBoundaryMessages: prepared.metrics.truncatedBoundaryMessages,
    foldCalls: prepared.metrics.foldCalls,
    repairCalls: prepared.metrics.repairCalls,
    warningCodes: prepared.warnings.map((warning) => warning.code),
  };
}
