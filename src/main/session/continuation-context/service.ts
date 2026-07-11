import { createHash } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { getDb } from '@main/store/db';
import {
  ContinuationBudgetError,
  resolveContinuationBudgets,
  validateRawRetentionCeiling,
} from './budget-policy';
import { foldContinuationCheckpoint, type FoldContinuationCheckpointResult } from './checkpoint-fold';
import { projectContinuationCheckpoint, estimateCheckpointProjectionTokens } from './checkpoint-projection';
import type { ContinuationCheckpointGenerator } from './checkpoint-generator';
import { contextCapacityResolver, type ContextCapacityResolver } from './context-capacity-resolver';
import { createCheckpointGeneratorRuntime } from './runtime';
import { selectStoredRawUserTail } from './raw-user-tail';
import { renderContinuationContext, type RenderedContinuationContext } from './renderer';
import { AsyncSingleflight } from './singleflight';
import { ContinuationSourceSpoolStore, type ContinuationSpoolMetadata } from './source-spool';
import { estimateContinuationTokens } from './token-estimator';
import type {
  CheckpointProjection,
  ContinuationQuality,
  ContinuationWarning,
  PrepareContinuationContextInput,
  PreparedContinuationContext,
  RawContinuationUserInput,
} from './types';

interface ContinuationServiceDependencies {
  db?: Database;
  spool?: ContinuationSourceSpoolStore;
  capacityResolver?: ContextCapacityResolver;
  generatorFactory?: (input: PrepareContinuationContextInput['generator']) => ContinuationCheckpointGenerator;
  singleflight?: AsyncSingleflight<FoldContinuationCheckpointResult>;
  now?: () => number;
}

const checkpointSingleflight = new AsyncSingleflight<FoldContinuationCheckpointResult>();

function validateLimits(input: PrepareContinuationContextInput): void {
  if (!input.continuationInstruction.trim()) throw new Error('continuationInstruction must not be empty');
  if (!Number.isSafeInteger(input.limits.deadlineMs) || input.limits.deadlineMs <= 0) {
    throw new Error('deadlineMs must be a positive safe integer');
  }
  for (const field of ['maxFoldCalls', 'maxRepairCalls'] as const) {
    if (!Number.isSafeInteger(input.limits[field]) || input.limits[field] < 0) {
      throw new Error(`${field} must be a non-negative safe integer`);
    }
  }
  validateRawRetentionCeiling(input.limits.rawRetentionCeilingTokens);
}

function warningKey(warning: ContinuationWarning): string {
  return `${warning.code}\u0000${warning.message}`;
}

function uniqueWarnings(warnings: ContinuationWarning[]): ContinuationWarning[] {
  const seen = new Set<string>();
  return warnings.filter((warning) => {
    const key = warningKey(warning);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function fixedWrapperTokens(input: {
  request: PrepareContinuationContextInput;
  metadata: ContinuationSpoolMetadata;
}): number {
  const rendered = renderContinuationContext({
    purpose: input.request.purpose,
    sourceSessionId: input.request.sourceSessionId,
    source: {
      eventRevision: input.metadata.captureRevision,
      rebuildAfterRevision: input.metadata.rebuildAfterRevision,
      maxEventId: input.metadata.maxEventId,
    },
    checkpoint: null,
    rawUserInputs: [],
    continuationInstruction: input.request.continuationInstruction,
  });
  return Math.max(
    0,
    rendered.estimatedTokens -
      estimateContinuationTokens(JSON.stringify(input.request.continuationInstruction)),
  );
}

function foldKey(
  input: PrepareContinuationContextInput,
  metadata: ContinuationSpoolMetadata,
  generatorFoldInputBudgetTokens: number,
): string {
  return [
    metadata.sessionId,
    metadata.captureRevision,
    metadata.rebuildAfterRevision,
    metadata.materializedThroughRevision,
    input.generator.configFingerprint,
    input.purpose,
    generatorFoldInputBudgetTokens,
    input.limits.deadlineMs,
    input.limits.maxFoldCalls,
    input.limits.maxRepairCalls,
  ].join(':');
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
    .update(
      JSON.stringify({
        version: 1,
        providerPrompt: input.providerPrompt,
        persistedUserText: input.persistedUserText,
        sourceRevision: input.sourceRevision,
        rebuildAfterRevision: input.rebuildAfterRevision,
        checkpointHash: input.checkpointHash,
        generatorFingerprint: input.generatorFingerprint,
        targetFingerprint: input.targetFingerprint,
      }),
      'utf8',
    )
    .digest('hex');
}

function tryRender(input: Parameters<typeof renderContinuationContext>[0]): RenderedContinuationContext | null {
  try {
    return renderContinuationContext(input);
  } catch (error) {
    if (error instanceof ContinuationBudgetError && error.code === 'prompt-byte-limit') return null;
    throw error;
  }
}

export async function prepareContinuationContextWithDependencies(
  input: PrepareContinuationContextInput,
  dependencies: ContinuationServiceDependencies = {},
): Promise<PreparedContinuationContext> {
  validateLimits(input);
  const now = dependencies.now ?? Date.now;
  const startedAt = now();
  const db = dependencies.db ?? getDb();
  const spool = dependencies.spool ?? new ContinuationSourceSpoolStore(db);
  const ownsSpool = input.source.mode === 'capture';

  // Deliberately synchronous and before the first await: all mutable source evidence is copied to
  // connection-local SQLite TEMP tables before provider latency can race event updates/deletes.
  const metadata =
    input.source.mode === 'capture'
      ? spool.capture({
          sessionId: input.sourceSessionId,
          rawRetentionCeilingTokens: input.limits.rawRetentionCeilingTokens,
          now: startedAt,
        })
      : spool.metadata(input.source.spoolId, now());
  if (metadata.sessionId !== input.sourceSessionId) {
    if (ownsSpool) spool.cleanup(metadata.spoolId);
    throw new Error('Immutable continuation spool belongs to a different source session');
  }
  if (metadata.consumed) throw new Error('Immutable continuation spool has already been consumed');

  try {
    const resolver = dependencies.capacityResolver ?? contextCapacityResolver;
    const targetCapacity = input.target.contextWindowTokens
      ? {
          contextWindowTokens: input.target.contextWindowTokens,
          source: input.target.contextWindowSource ?? ('observed' as const),
        }
      : resolver.resolve(input.target.adapter, input.target.model);
    const budgets = resolveContinuationBudgets({
      rawRetentionCeilingTokens: input.limits.rawRetentionCeilingTokens,
      targetContextWindowTokens: targetCapacity.contextWindowTokens,
      generatorContextWindowTokens: input.generator.contextWindowTokens,
      continuationInstruction: input.continuationInstruction,
      fixedWrapperTokens: fixedWrapperTokens({ request: input, metadata }),
    });
    const warnings: ContinuationWarning[] = [];
    if (targetCapacity.source === 'fallback') {
      warnings.push({
        code: 'target-capacity-fallback',
        message: `No observed context window for ${input.target.adapter}/${input.target.model ?? 'default'}; using conservative fallback.`,
      });
    }
    if (metadata.uncoveredRevisionRange || metadata.rawScanTruncated) {
      warnings.push({
        code: 'spool-resource-guard',
        message: 'The immutable source spool reached its byte guard; coverage is reported explicitly.',
      });
    }
    for (const code of metadata.rawWarnings) {
      warnings.push({
        code,
        message:
          code === 'legacy-wrapper-unwrapped'
            ? 'A valid legacy continuation wrapper was reduced to its authoritative instruction.'
            : 'A malformed legacy continuation wrapper was excluded from retained history.',
      });
    }

    const generator = (dependencies.generatorFactory ?? createCheckpointGeneratorRuntime)(input.generator);
    const singleflight = dependencies.singleflight ?? checkpointSingleflight;
    const foldWork = () =>
      foldContinuationCheckpoint({
        db,
        spool,
        metadata,
        generatorSpec: input.generator,
        generator,
        generatorFoldInputBudgetTokens: budgets.generatorFoldInputBudgetTokens,
        deadlineAt: startedAt + input.limits.deadlineMs,
        maxFoldCalls: input.limits.maxFoldCalls,
        maxRepairCalls: input.limits.maxRepairCalls,
        ...(input.signal ? { signal: input.signal } : {}),
        now,
      });
    // AbortSignal ownership is caller-local. Sharing a fold that closes over one caller's signal
    // would let that caller cancel otherwise compatible preparations, so signalled work is kept
    // outside process-wide singleflight rather than pretending signal identity is a string key.
    const fold = input.signal
      ? await foldWork()
      : await singleflight.run(
          foldKey(input, metadata, budgets.generatorFoldInputBudgetTokens),
          foldWork,
        );
    warnings.push(...fold.warnings);
    if (fold.observedContextWindowTokens !== null) {
      resolver.observe(
        input.generator.adapter,
        input.generator.model,
        fold.observedContextWindowTokens,
      );
    }

    let projection = fold.checkpoint
      ? projectContinuationCheckpoint(fold.checkpoint, budgets.checkpointProjectionBudgetTokens)
      : null;
    if (
      projection &&
      estimateCheckpointProjectionTokens(projection) > budgets.checkpointProjectionBudgetTokens
    ) {
      projection = null;
      warnings.push({ code: 'checkpoint-omitted', message: 'Checkpoint provenance did not fit the projection budget.' });
    }
    if (projection?.omittedFacts) {
      warnings.push({
        code: 'checkpoint-projected',
        message: `${projection.omittedFacts} lower-priority checkpoint facts were omitted from the target projection.`,
      });
    }

    const capturedRaw = spool.readRawInputs(metadata.spoolId);
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
      purpose: input.purpose,
      sourceSessionId: input.sourceSessionId,
      source: {
        eventRevision: metadata.captureRevision,
        rebuildAfterRevision: metadata.rebuildAfterRevision,
        maxEventId: metadata.maxEventId,
      },
      checkpoint: projection,
      rawUserInputs: raw,
      continuationInstruction: input.continuationInstruction,
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
        } else if (next.omittedFacts === projection.omittedFacts && reducedBudget >= currentTokens) {
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
        message: `Checkpoint coverage is incomplete from revision ${uncoveredRevisionRange.from} through ${uncoveredRevisionRange.to}.`,
      });
    }
    if (!fold.checkpoint && raw.length === 0) {
      warnings.push({ code: 'instruction-only', message: 'No validated checkpoint or eligible user history was available.' });
    }

    const quality = qualityFor({
      checkpointExists: fold.checkpoint !== null,
      uncovered: uncoveredRevisionRange,
      projection,
      raw,
    });
    const hash = preparationHash({
      providerPrompt: rendered.prompt,
      persistedUserText: input.continuationInstruction,
      sourceRevision: metadata.captureRevision,
      rebuildAfterRevision: metadata.rebuildAfterRevision,
      checkpointHash: fold.checkpoint?.contentHash ?? null,
      generatorFingerprint: input.generator.configFingerprint,
      targetFingerprint: input.target.runtimeFingerprint,
    });
    return {
      version: 1,
      providerPrompt: rendered.prompt,
      persistedUserText: input.continuationInstruction,
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
        elapsedMs: Math.max(0, now() - startedAt),
        uncoveredRevisionRange,
      },
      warnings: uniqueWarnings(warnings),
      preparationHash: hash,
      spoolId: metadata.spoolId,
    };
  } catch (error) {
    if (ownsSpool) spool.cleanup(metadata.spoolId);
    throw error;
  }
}

export function prepareContinuationContext(
  input: PrepareContinuationContextInput,
): Promise<PreparedContinuationContext> {
  return prepareContinuationContextWithDependencies(input);
}
