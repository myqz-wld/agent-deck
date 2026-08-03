import { createHash } from 'node:crypto';
import { ContinuationBudgetError, type ResolvedContinuationBudgets } from './budget-policy';
import type { FoldContinuationCheckpointResult } from './checkpoint-fold';
import {
  estimateCheckpointProjectionTokens,
  projectContinuationCheckpoint,
} from './checkpoint-projection';
import { selectStoredRawUserTail } from './raw-user-tail';
import {
  renderContinuationContext,
  type RenderedContinuationContext,
} from './renderer';
import type { ContinuationSpoolMetadata } from './source-spool';
import type {
  CheckpointProjection,
  ContinuationQuality,
  ContinuationWarning,
  PrepareContinuationContextInput,
  PreparedContinuationContext,
  RawContinuationUserInput,
} from './types';

function uniqueWarnings(warnings: ContinuationWarning[]): ContinuationWarning[] {
  const seen = new Set<string>();
  return warnings.filter((warning) => {
    const key = `${warning.code}\u0000${warning.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function qualityFor(input: {
  checkpointExists: boolean;
  uncovered: { from: number; to: number } | null;
  projection: CheckpointProjection | null;
  raw: RawContinuationUserInput[];
}): ContinuationQuality {
  if (input.uncovered) return 'coverage-gap';
  if (!input.checkpointExists) return input.raw.length > 0 ? 'raw-only' : 'instruction-only';
  if (!input.projection || input.projection.omittedFacts > 0) return 'projected';
  return 'full';
}

function preparationHash(input: {
  providerPrompt: string;
  persistedUserText: string;
  sourceRevision: number;
  rebuildAfterRevision: number;
  checkpointHash: string | null;
  generatorFingerprint: string;
  targetFingerprint: string;
}): string {
  return createHash('sha256')
    .update(JSON.stringify({ version: 1, ...input }), 'utf8')
    .digest('hex');
}

function tryRender(
  input: Parameters<typeof renderContinuationContext>[0],
): RenderedContinuationContext | null {
  try {
    return renderContinuationContext(input);
  } catch (error) {
    if (error instanceof ContinuationBudgetError && error.code === 'prompt-byte-limit') return null;
    throw error;
  }
}

export function renderPreparedContinuation(input: {
  request: PrepareContinuationContextInput;
  metadata: ContinuationSpoolMetadata;
  fold: FoldContinuationCheckpointResult;
  budgets: ResolvedContinuationBudgets;
  capturedRaw: RawContinuationUserInput[];
  baseWarnings: readonly ContinuationWarning[];
  elapsedMs: number;
}): PreparedContinuationContext {
  const { request, metadata, fold, budgets, capturedRaw } = input;
  const warnings = [...input.baseWarnings];
  let projection = fold.checkpoint
    ? projectContinuationCheckpoint(fold.checkpoint, budgets.checkpointProjectionBudgetTokens)
    : null;
  if (
    projection &&
    estimateCheckpointProjectionTokens(projection) > budgets.checkpointProjectionBudgetTokens
  ) {
    projection = null;
    warnings.push({
      code: 'checkpoint-omitted',
      message: 'Checkpoint provenance did not fit the projection budget.',
    });
  }
  if (projection?.omittedFacts) {
    warnings.push({
      code: 'checkpoint-projected',
      message: `${projection.omittedFacts} lower-priority checkpoint facts were omitted from the target projection.`,
    });
  }

  const projectionTokens = estimateCheckpointProjectionTokens(projection);
  let rawSelection = selectStoredRawUserTail(
    capturedRaw,
    Math.min(
      budgets.rawRetentionCeilingTokens,
      Math.max(0, budgets.historicalCapacityTokens - projectionTokens),
    ),
  );
  let raw = rawSelection.messages;
  const renderInput = () => ({
    purpose: request.purpose,
    sourceSessionId: request.sourceSessionId,
    source: {
      eventRevision: metadata.captureRevision,
      rebuildAfterRevision: metadata.rebuildAfterRevision,
      maxEventId: metadata.maxEventId,
    },
    checkpoint: projection,
    rawUserInputs: raw,
    continuationInstruction: request.continuationInstruction,
  });
  let rendered = tryRender(renderInput());
  while (!rendered || rendered.estimatedTokens > budgets.targetPromptCapacityTokens) {
    if (raw.length > 0) {
      const overflow = rendered
        ? rendered.estimatedTokens - budgets.targetPromptCapacityTokens
        : Math.max(1, Math.ceil(rawSelection.estimatedTokens / 4));
      rawSelection = selectStoredRawUserTail(
        raw,
        Math.max(0, rawSelection.estimatedTokens - Math.max(1, overflow) - 8),
      );
      raw = rawSelection.messages;
      continue;
    }
    if (projection) {
      const currentTokens = estimateCheckpointProjectionTokens(projection);
      const overflow = rendered
        ? rendered.estimatedTokens - budgets.targetPromptCapacityTokens
        : Math.max(1, Math.ceil(currentTokens / 4));
      const reducedBudget = Math.max(0, currentTokens - Math.max(1, overflow) - 8);
      const next = fold.checkpoint
        ? projectContinuationCheckpoint(fold.checkpoint, reducedBudget)
        : null;
      if (!next || estimateCheckpointProjectionTokens(next) > reducedBudget) {
        projection = null;
      } else if (
        next.omittedFacts === projection.omittedFacts &&
        reducedBudget >= currentTokens
      ) {
        projection = null;
      } else {
        projection = next;
      }
      continue;
    }
    throw new ContinuationBudgetError(
      'Continuation wrapper and authoritative instruction cannot fit the target prompt capacity',
      'instruction-does-not-fit',
    );
  }

  if (raw.length < capturedRaw.length) {
    warnings.push({
      code: 'raw-history-omitted',
      message: `${capturedRaw.length - raw.length} older retained user inputs did not fit the target budget.`,
    });
  }
  if (rawSelection.truncatedBoundaryMessages > 0 || raw.some((message) => message.truncated)) {
    warnings.push({
      code: 'raw-boundary-truncated',
      message: 'The oldest retained boundary input was UTF-8 safely truncated.',
    });
  }
  const uncoveredRevisionRange = fold.uncoveredRevisionRange ?? metadata.uncoveredRevisionRange;
  if (uncoveredRevisionRange) {
    warnings.push({
      code: 'coverage-gap',
      message: `Checkpoint coverage stops at revision ${uncoveredRevisionRange.from}; source capture is revision ${uncoveredRevisionRange.to}.`,
    });
  }
  if (!fold.checkpoint && raw.length === 0) {
    warnings.push({
      code: 'instruction-only',
      message: 'No validated checkpoint or eligible user history was available.',
    });
  }

  const quality = qualityFor({
    checkpointExists: fold.checkpoint !== null,
    uncovered: uncoveredRevisionRange,
    projection,
    raw,
  });
  return {
    version: 1,
    providerPrompt: rendered.prompt,
    persistedUserText: request.continuationInstruction,
    source: {
      eventRevision: metadata.captureRevision,
      rebuildAfterRevision: metadata.rebuildAfterRevision,
      maxEventId: metadata.maxEventId,
    },
    checkpoint: {
      id: fold.checkpoint?.id ?? null,
      throughRevision: fold.checkpoint?.sourceEventRevision ?? 0,
      formatVersion: fold.checkpoint?.formatVersion ?? 1,
      refreshed: fold.refreshed,
    },
    projection: {
      canonicalHash: projection?.canonicalHash ?? null,
      omittedFacts: projection?.omittedFacts ?? 0,
    },
    quality,
    metrics: {
      rawRetentionCeilingTokens: budgets.rawRetentionCeilingTokens,
      targetPromptCapacityTokens: budgets.targetPromptCapacityTokens,
      checkpointProjectionBudgetTokens: budgets.checkpointProjectionBudgetTokens,
      generatorFoldInputBudgetTokens: budgets.generatorFoldInputBudgetTokens,
      estimatedPromptTokens: rendered.estimatedTokens,
      checkpointTokens: rendered.checkpointTokens,
      rawTailTokens: rendered.rawTailTokens,
      includedUserMessages: raw.length,
      truncatedBoundaryMessages: raw.filter((message) => message.truncated).length,
      foldCalls: fold.foldCalls,
      repairCalls: fold.repairCalls,
      elapsedMs: input.elapsedMs,
      uncoveredRevisionRange,
    },
    warnings: uniqueWarnings(warnings),
    preparationHash: preparationHash({
      providerPrompt: rendered.prompt,
      persistedUserText: request.continuationInstruction,
      sourceRevision: metadata.captureRevision,
      rebuildAfterRevision: metadata.rebuildAfterRevision,
      checkpointHash: fold.checkpoint?.contentHash ?? null,
      generatorFingerprint: request.generator.configFingerprint,
      targetFingerprint: request.target.runtimeFingerprint,
    }),
    spoolId: metadata.spoolId,
  };
}
