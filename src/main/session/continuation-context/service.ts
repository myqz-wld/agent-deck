import type { Database } from 'better-sqlite3';
import {
  createContextWindowCapacityService,
  type ContextWindowCapacityService,
} from '@main/session/context-window/service';
import { getDb } from '@main/store/db';
import {
  ContinuationBudgetError,
  resolveContinuationBudgets,
  targetNeedsLowerBudgetRetry,
  type ResolvedContinuationBudgets,
  validateRawRetentionCeiling,
} from './budget-policy';
import {
  foldContinuationCheckpoint,
  type FoldContinuationCheckpointResult,
} from './checkpoint-fold';
import type { ContinuationCheckpointGenerator } from './checkpoint-generator';
import { observeCheckpointGeneratorCapacity } from './generator-capacity-observation';
import { renderPreparedContinuation } from './preparation-renderer';
import { renderContinuationContext } from './renderer';
import { createCheckpointGeneratorRuntime } from './runtime';
import { AsyncSingleflight } from './singleflight';
import {
  ContinuationSourceSpoolStore,
  type ContinuationSpoolMetadata,
} from './source-spool';
import { estimateContinuationTokens } from './token-estimator';
import type {
  ContinuationWarning,
  PrepareContinuationContextInput,
  PreparedContinuationCandidates,
  PreparedContinuationContext,
} from './types';

interface ContinuationServiceDependencies {
  db?: Database;
  spool?: ContinuationSourceSpoolStore;
  capacityService?: ContextWindowCapacityService;
  generatorFactory?: (
    input: PrepareContinuationContextInput['generator'],
  ) => ContinuationCheckpointGenerator;
  singleflight?: AsyncSingleflight<FoldContinuationCheckpointResult>;
  now?: () => number;
}

const checkpointSingleflight = new AsyncSingleflight<FoldContinuationCheckpointResult>();

function validateLimits(input: PrepareContinuationContextInput): void {
  if (!input.continuationInstruction.trim()) {
    throw new Error('continuationInstruction must not be empty');
  }
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

function fixedWrapperTokens(input: {
  request: PrepareContinuationContextInput;
}): number {
  const rendered = renderContinuationContext({
    quality: 'instruction-only',
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

function sourceWarnings(
  metadata: ContinuationSpoolMetadata,
): ContinuationWarning[] {
  const warnings: ContinuationWarning[] = [];
  if (metadata.uncoveredRevisionRange || metadata.rawScanTruncated) {
    warnings.push({
      code: 'spool-resource-guard',
      message: 'The immutable source spool reached its byte guard; coverage is reported explicitly.',
    });
  }
  for (const code of metadata.rawWarnings) {
    warnings.push({
      code,
      message: 'A generated continuation context was excluded from retained history.',
    });
  }
  return warnings;
}

function targetCapacityWarning(input: {
  request: PrepareContinuationContextInput;
  retryPrepared: boolean;
  retryInstructionDidNotFit: boolean;
}): ContinuationWarning | null {
  const { request } = input;
  if (request.target.contextCapacity.status === 'observed') return null;
  const target = `${request.target.adapter}/${request.target.model ?? 'default'}`;
  if (request.purpose === 'recovery') {
    return {
      code: 'target-capacity-fallback',
      message:
        `Target context capacity is ${request.target.contextCapacity.status} for ${target}; ` +
        'using the tagged 64k conservative recovery policy.',
    };
  }
  if (input.retryPrepared) {
    return {
      code: 'target-capacity-fallback',
      message:
        `Target context capacity is ${request.target.contextCapacity.status} for ${target}; ` +
        'using tagged 64k primary and 32k retry policies.',
    };
  }
  return {
    code: 'target-capacity-fallback',
    message:
      `Target context capacity is ${request.target.contextCapacity.status} for ${target}; ` +
      (input.retryInstructionDidNotFit
        ? 'the current instruction fits the 64k primary policy but not the optional 32k retry, so preparation will continue without a lower-budget retry.'
        : 'using the tagged 64k primary policy without a lower-budget retry.'),
  };
}

export async function prepareContinuationCandidatesWithDependencies(
  input: PrepareContinuationContextInput,
  dependencies: ContinuationServiceDependencies = {},
): Promise<PreparedContinuationCandidates> {
  validateLimits(input);
  const now = dependencies.now ?? Date.now;
  const startedAt = now();
  const db = dependencies.db ?? getDb();
  const spool = dependencies.spool ?? new ContinuationSourceSpoolStore(db);
  const ownsSpool = input.source.mode === 'capture';

  // Synchronous before the first await: mutable evidence is copied into connection-local TEMP
  // tables before provider latency can race source updates or deletion.
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

  try {
    const wrapperTokens = fixedWrapperTokens({ request: input });
    const primaryBudgets = resolveContinuationBudgets({
      rawRetentionCeilingTokens: input.limits.rawRetentionCeilingTokens,
      targetCapacity: input.target.contextCapacity,
      generatorCapacity: input.generator.contextCapacity,
      continuationInstruction: input.continuationInstruction,
      fixedWrapperTokens: wrapperTokens,
    });
    const warnings = sourceWarnings(metadata);
    let retryBudgets: ResolvedContinuationBudgets | null = null;
    let retryInstructionDidNotFit = false;
    if (
      input.purpose === 'handoff' &&
      targetNeedsLowerBudgetRetry(input.target.contextCapacity)
    ) {
      try {
        retryBudgets = resolveContinuationBudgets({
          rawRetentionCeilingTokens: input.limits.rawRetentionCeilingTokens,
          targetCapacity: input.target.contextCapacity,
          generatorCapacity: input.generator.contextCapacity,
          targetVariant: 'lower-budget-retry',
          continuationInstruction: input.continuationInstruction,
          fixedWrapperTokens: wrapperTokens,
        });
      } catch (error) {
        if (
          !(error instanceof ContinuationBudgetError) ||
          error.code !== 'instruction-does-not-fit'
        ) {
          throw error;
        }
        retryInstructionDidNotFit = true;
      }
    }
    const fallbackWarning = targetCapacityWarning({
      request: input,
      retryPrepared: retryBudgets !== null,
      retryInstructionDidNotFit,
    });
    if (fallbackWarning) warnings.unshift(fallbackWarning);
    const generator = (dependencies.generatorFactory ?? createCheckpointGeneratorRuntime)(
      input.generator,
    );
    const singleflight = dependencies.singleflight ?? checkpointSingleflight;
    const foldWork = () =>
      foldContinuationCheckpoint({
        db,
        spool,
        metadata,
        generatorSpec: input.generator,
        generator,
        generatorFoldInputBudgetTokens: primaryBudgets.generatorFoldInputBudgetTokens,
        deadlineAt: startedAt + input.limits.deadlineMs,
        maxFoldCalls: input.limits.maxFoldCalls,
        maxRepairCalls: input.limits.maxRepairCalls,
        ...(input.signal ? { signal: input.signal } : {}),
        now,
      });
    // A caller-owned signal must not be able to cancel another compatible preparation.
    const fold = input.signal
      ? await foldWork()
      : await singleflight.run(
          foldKey(input, metadata, primaryBudgets.generatorFoldInputBudgetTokens),
          foldWork,
        );
    warnings.push(...fold.warnings);
    observeCheckpointGeneratorCapacity({
      service: dependencies.capacityService ?? createContextWindowCapacityService(db),
      adapter: input.generator.adapter,
      evidence: fold.observedContextWindowEvidence,
      observedAt: now(),
    });

    const capturedRaw = spool.readRawInputs(metadata.spoolId);
    const elapsedMs = Math.max(0, now() - startedAt);
    const primary = renderPreparedContinuation({
      request: input,
      metadata,
      fold,
      budgets: primaryBudgets,
      capturedRaw,
      baseWarnings: warnings,
      elapsedMs,
    });
    const lowerBudgetRetry = retryBudgets
      ? renderPreparedContinuation({
          request: input,
          metadata,
          fold,
          budgets: retryBudgets,
          capturedRaw,
          baseWarnings: warnings,
          elapsedMs,
        })
      : null;
    return { primary, lowerBudgetRetry };
  } catch (error) {
    if (ownsSpool) spool.cleanup(metadata.spoolId);
    throw error;
  }
}

export async function prepareContinuationContextWithDependencies(
  input: PrepareContinuationContextInput,
  dependencies: ContinuationServiceDependencies = {},
): Promise<PreparedContinuationContext> {
  return (await prepareContinuationCandidatesWithDependencies(input, dependencies)).primary;
}

export function prepareContinuationCandidates(
  input: PrepareContinuationContextInput,
): Promise<PreparedContinuationCandidates> {
  return prepareContinuationCandidatesWithDependencies(input);
}

export function prepareContinuationContext(
  input: PrepareContinuationContextInput,
): Promise<PreparedContinuationContext> {
  return prepareContinuationContextWithDependencies(input);
}
