import type { Database } from 'better-sqlite3';
import { assertContinuationPromptByteLimit } from './budget-policy';
import {
  createContinuationCheckpointRepo,
  type ContinuationCheckpointRecord,
} from '@main/store/continuation-checkpoint-repo';
import {
  canonicalizeContinuationCheckpoint,
  type ContinuationCheckpoint,
} from './checkpoint-schema';
import {
  CheckpointGeneratorError,
  rawGeneratorOutput,
  validateGeneratedContinuationCheckpoint,
  type ContinuationCheckpointGenerator,
} from './checkpoint-generator';
import {
  buildCheckpointFoldChunk,
  priorCheckpointEvidence,
  type FoldChunkView,
} from './checkpoint-fold-chunk';
import {
  fitCanonicalCheckpointForPersistence,
  MAX_CANONICAL_CHECKPOINT_TOKENS,
} from './checkpoint-canonical-fit';
import { buildCheckpointRepairPrompt, CONTINUATION_CHECKPOINT_SYSTEM_PROMPT } from './checkpoint-prompts';
import {
  assertActiveCheckpointFactsCarryForward,
  projectContinuationCheckpointWithCoverageMarker,
} from './checkpoint-projection';
import {
  coverageGapRangeFromCheckpoint,
} from './checkpoint-fold-coverage-gap';
import {
  assertCheckpointFoldSource,
  emptyContinuationCheckpoint,
  foregroundChunkView,
  foregroundRevisionGroups,
  calculateUncoveredRevisionRange,
  type CheckpointFoldMetadata,
  type CheckpointFoldSourceSelection,
} from './checkpoint-fold-source';
import { estimateContinuationJsonTokens, estimateContinuationTokens, truncateContinuationTextMiddle } from './token-estimator';
import type { ContinuationWarning, ResolvedContinuationGenerator } from './types';
import {
  recordCheckpointFoldFailure,
  type CheckpointFoldFailureDiagnostic,
} from './checkpoint-fold-failure';

export interface FoldContinuationCheckpointInput extends CheckpointFoldSourceSelection {
  db: Database;
  metadata: CheckpointFoldMetadata;
  generatorSpec: ResolvedContinuationGenerator;
  generator: ContinuationCheckpointGenerator;
  generatorFoldInputBudgetTokens: number;
  deadlineAt: number;
  maxFoldCalls: number;
  maxRepairCalls: number;
  signal?: AbortSignal;
  now?: () => number;
}

export interface FoldContinuationCheckpointResult {
  checkpoint: ContinuationCheckpointRecord | null;
  refreshed: boolean;
  foldCalls: number;
  repairCalls: number;
  inputTokens: number;
  outputTokens: number;
  observedContextWindowTokens: number | null;
  warnings: ContinuationWarning[];
  failure: CheckpointFoldFailureDiagnostic | null;
  uncoveredRevisionRange: { from: number; to: number } | null;
}

function deadlineRemaining(input: FoldContinuationCheckpointInput, now: () => number): number {
  if (input.signal?.aborted) throw new CheckpointGeneratorError('Checkpoint generation aborted', 'aborted');
  return Math.max(0, input.deadlineAt - now());
}

function diagnosticDeadlineRemaining(
  input: FoldContinuationCheckpointInput,
  now: () => number,
): number {
  return Math.max(0, input.deadlineAt - now());
}

export async function foldContinuationCheckpoint(
  input: FoldContinuationCheckpointInput,
): Promise<FoldContinuationCheckpointResult> {
  assertCheckpointFoldSource(input, input.metadata);
  const now = input.now ?? Date.now;
  const repo = createContinuationCheckpointRepo(input.db);
  const storedAtCapture = repo.latestAtOrBefore(
    input.metadata.sessionId,
    input.metadata.captureRevision,
  );
  const initial =
    storedAtCapture &&
    storedAtCapture.sourceEventRevision >= (input.metadata.checkpoint?.sourceEventRevision ?? 0)
      ? storedAtCapture
      : input.metadata.checkpoint;
  let current = initial;
  let refreshed = false;
  let foldCalls = 0;
  let repairCalls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let observedContextWindowTokens: number | null = null;
  const warnings: ContinuationWarning[] = [];
  let failure: CheckpointFoldFailureDiagnostic | null = null;
  let remainingGroups = foregroundRevisionGroups({
    spool: input.spool,
    metadata: input.metadata,
    afterRevision: current?.sourceEventRevision ?? 0,
  });
  let backgroundCursor = 0;
  let backgroundRemaining = input.backgroundSource !== undefined &&
    input.metadata.materializedThroughRevision > (current?.sourceEventRevision ?? 0);

  const persistentCoverageGap = () =>
    coverageGapRangeFromCheckpoint(current?.checkpoint ?? null, input.metadata.captureRevision);
  const addPersistentCoverageWarning = () => {
    const range = persistentCoverageGap();
    if (range && !warnings.some((warning) => warning.code === 'coverage-gap')) {
      warnings.push({
        code: 'coverage-gap',
        message: `Full semantic checkpoint coverage stops after revision ${range.from}; durable bounded digest markers persist through revision ${range.to}.`,
      });
    }
    return range;
  };
  addPersistentCoverageWarning();

  const commit = (checkpoint: ContinuationCheckpoint, throughRevision: number, trigger: string) => {
    const candidate = canonicalizeContinuationCheckpoint(checkpoint).checkpoint;
    const fit = fitCanonicalCheckpointForPersistence({
      candidate,
      previous: current?.checkpoint ?? null,
    });
    if (!fit.ok) throw new Error(`Canonical checkpoint fit failed: ${fit.reason}`);
    const canonical = canonicalizeContinuationCheckpoint(fit.checkpoint);
    const checkpointTokens = estimateContinuationJsonTokens(canonical.checkpoint, { structuralOverhead: 8 });
    if (checkpointTokens > MAX_CANONICAL_CHECKPOINT_TOKENS) {
      throw new Error(`Canonical checkpoint exceeds ${MAX_CANONICAL_CHECKPOINT_TOKENS} estimated tokens`);
    }
    const result = repo.commit({
      sessionId: input.metadata.sessionId,
      expectedHeadId: current?.id ?? null,
      expectedRebuildAfterRevision: input.metadata.rebuildAfterRevision,
      sourceEventRevision: throughRevision,
      sourceMaxEventId: input.metadata.maxEventId,
      checkpoint: canonical.checkpoint,
      generatorAdapter: input.generatorSpec.adapter,
      generatorModel: input.generatorSpec.model,
      generatorThinking: input.generatorSpec.thinking,
      trigger,
      inputTokens,
      outputTokens,
      checkpointTokens,
    });
    if (!result.ok) throw new Error(`Checkpoint CAS conflict: ${result.reason}`);
    current = result.checkpoint;
    refreshed = true;
    if (fit.omittedFacts > 0) {
      warnings.push({
        code: 'checkpoint-projected',
        message: `${fit.omittedFacts} lower-priority inactive facts were pruned from the canonical checkpoint at its ${fit.mode} capacity boundary.`,
      });
    }
  };

  const normalizedSourceIsEmpty = input.backgroundSource
    ? input.metadata.normalizedEventCount === 0
    : remainingGroups.every((group) => group.normalized.length === 0);
  if (normalizedSourceIsEmpty) {
    if (input.metadata.materializedThroughRevision > (current?.sourceEventRevision ?? 0)) {
      try {
        commit(current?.checkpoint ?? emptyContinuationCheckpoint(), input.metadata.materializedThroughRevision, 'continuation-deterministic-fold');
      } catch {
        current = repo.latestAtOrBefore(input.metadata.sessionId, input.metadata.captureRevision);
      }
    }
    return {
      checkpoint: current,
      refreshed,
      foldCalls,
      repairCalls,
      inputTokens,
      outputTokens,
      observedContextWindowTokens,
      warnings,
      failure,
      uncoveredRevisionRange:
        persistentCoverageGap() ??
        calculateUncoveredRevisionRange(current?.sourceEventRevision ?? 0, input.metadata.captureRevision),
    };
  }

  while (input.backgroundSource ? backgroundRemaining : remainingGroups.length > 0) {
    if (deadlineRemaining(input, now) <= 0) break;
    let chunk: FoldChunkView | null;
    if (input.backgroundSource) {
      chunk = await input.backgroundSource.buildNextChunk({
        cursor: backgroundCursor,
        coveredThroughRevision: current?.sourceEventRevision ?? 0,
        previous: current?.checkpoint ?? null,
        budget: input.generatorFoldInputBudgetTokens,
      });
    } else {
      const foregroundChunk = buildCheckpointFoldChunk({
        groups: remainingGroups,
        previous: current?.checkpoint ?? null,
        finalThroughRevision: input.metadata.materializedThroughRevision,
        budget: input.generatorFoldInputBudgetTokens,
      });
      chunk = foregroundChunk
        ? foregroundChunkView({
            chunk: foregroundChunk,
            remainingGroupCount: remainingGroups.length,
            coveredThroughRevision: current?.sourceEventRevision ?? 0,
          })
        : null;
    }
    if (!chunk) {
      warnings.push({
        code: 'coverage-gap',
        message: 'The next complete event-revision group exceeds the generator fold budget.',
      });
      break;
    }
    if (chunk.requiresCoverageMarker) {
      const marker = chunk.coverageMarker;
      const bounded = marker
        ? projectContinuationCheckpointWithCoverageMarker({
            previous: current?.checkpoint ?? null,
            marker,
            tokenBudget: MAX_CANONICAL_CHECKPOINT_TOKENS,
          })
        : null;
      if (!bounded) {
        warnings.push({
          code: 'coverage-gap',
          message: `Revision ${chunk.firstRevision} could not be represented by a bounded checkpoint marker without dropping required active facts.`,
        });
        break;
      }
      try {
        commit(
          bounded.checkpoint,
          chunk.throughRevision,
          'continuation-bounded-coverage-fold',
        );
        if (bounded.omittedFacts > 0) {
          warnings.push({
            code: 'checkpoint-projected',
            message: `${bounded.omittedFacts} lower-priority inactive facts were pruned while adding the durable coverage marker.`,
          });
        }
        warnings.push({
          code: 'coverage-gap',
          message: `Revision ${chunk.firstRevision} was retained only as a durable bounded digest; full semantic coverage remains unavailable.`,
        });
      } catch (error) {
        failure = recordCheckpointFoldFailure({
          warnings,
          code: 'checkpoint-generation-failed',
          stage: 'bounded-marker-commit',
          error,
          providerCalls: foldCalls + repairCalls,
          checkpointRevision: current?.sourceEventRevision ?? 0,
          captureRevision: input.metadata.captureRevision,
          deadlineRemainingMs: diagnosticDeadlineRemaining(input, now),
        });
        current = repo.latestAtOrBefore(input.metadata.sessionId, input.metadata.captureRevision);
        break;
      }
      if (input.backgroundSource) {
        backgroundCursor = chunk.nextCursor;
        backgroundRemaining = chunk.remainingAfter;
      } else {
        remainingGroups = remainingGroups.slice(chunk.consumedGroupCount);
      }
      continue;
    }
    if (foldCalls >= input.maxFoldCalls) break;

    let generated;
    try {
      generated = await input.generator.generate({
        prompt: chunk.prompt,
        timeoutMs: deadlineRemaining(input, now),
        maxOutputBytes: 256 * 1024,
        remainingCalls: input.maxFoldCalls - foldCalls,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      foldCalls += generated.providerCalls;
      inputTokens += generated.inputTokens ?? estimateContinuationTokens(chunk.prompt);
      outputTokens += generated.outputTokens ?? estimateContinuationJsonTokens(generated.output);
      if (generated.contextWindowTokens !== null) {
        observedContextWindowTokens =
          observedContextWindowTokens === null
            ? generated.contextWindowTokens
            : Math.min(observedContextWindowTokens, generated.contextWindowTokens);
      }
    } catch (error) {
      if (error instanceof CheckpointGeneratorError) foldCalls += error.providerCalls;
      failure = recordCheckpointFoldFailure({
        warnings,
        code: 'checkpoint-generation-failed',
        stage: 'fold-generate',
        error,
        providerCalls: foldCalls + repairCalls,
        checkpointRevision: current?.sourceEventRevision ?? 0,
        captureRevision: input.metadata.captureRevision,
        deadlineRemainingMs: diagnosticDeadlineRemaining(input, now),
      });
      break;
    }

    let canonical;
    try {
      canonical = validateGeneratedContinuationCheckpoint({
        output: generated.output,
        previousCheckpoint: chunk.previousForFold,
        allowedEvidence: [
          ...priorCheckpointEvidence(chunk.previousForFold),
          ...chunk.currentEvidence,
        ],
        currentDeltaEvidence: chunk.currentEvidence,
      });
      assertActiveCheckpointFactsCarryForward({
        previous: current?.checkpoint ?? null,
        next: canonical.checkpoint,
        currentDeltaEvidence: chunk.currentEvidence,
      });
    } catch (validationError) {
      if (repairCalls >= input.maxRepairCalls || deadlineRemaining(input, now) <= 0) {
        failure = recordCheckpointFoldFailure({
          warnings,
          code: 'checkpoint-repair-failed',
          stage: 'fold-validate',
          error: validationError,
          providerCalls: foldCalls + repairCalls,
          checkpointRevision: current?.sourceEventRevision ?? 0,
          captureRevision: input.metadata.captureRevision,
          deadlineRemainingMs: diagnosticDeadlineRemaining(input, now),
        });
        break;
      }
      try {
        const boundedInvalid = truncateContinuationTextMiddle(
          rawGeneratorOutput(generated.output),
          Math.max(256, Math.floor(input.generatorFoldInputBudgetTokens / 4)),
        ).text;
        const repairPrompt = buildCheckpointRepairPrompt({
          previousCheckpoint: chunk.previousForFold,
          sourceThroughRevision: chunk.throughRevision,
          normalizedDelta: chunk.normalized,
          allowedEvidence: [
            ...priorCheckpointEvidence(chunk.previousForFold),
            ...chunk.currentEvidence,
          ],
          invalidOutput: boundedInvalid,
          validationError:
            validationError instanceof Error ? validationError.message : String(validationError),
        });
        assertContinuationPromptByteLimit(CONTINUATION_CHECKPOINT_SYSTEM_PROMPT + repairPrompt);
        const repaired = await input.generator.generate({
          prompt: repairPrompt,
          timeoutMs: deadlineRemaining(input, now),
          maxOutputBytes: 256 * 1024,
          remainingCalls: input.maxRepairCalls - repairCalls,
          ...(input.signal ? { signal: input.signal } : {}),
        });
        repairCalls += repaired.providerCalls;
        inputTokens += repaired.inputTokens ?? estimateContinuationTokens(repairPrompt);
        outputTokens += repaired.outputTokens ?? estimateContinuationJsonTokens(repaired.output);
        canonical = validateGeneratedContinuationCheckpoint({
          output: repaired.output,
          previousCheckpoint: chunk.previousForFold,
          allowedEvidence: [
            ...priorCheckpointEvidence(chunk.previousForFold),
            ...chunk.currentEvidence,
          ],
          currentDeltaEvidence: chunk.currentEvidence,
        });
        assertActiveCheckpointFactsCarryForward({
          previous: current?.checkpoint ?? null,
          next: canonical.checkpoint,
          currentDeltaEvidence: chunk.currentEvidence,
        });
      } catch (repairError) {
        if (repairError instanceof CheckpointGeneratorError) repairCalls += repairError.providerCalls;
        failure = recordCheckpointFoldFailure({
          warnings,
          code: 'checkpoint-repair-failed',
          stage: 'repair',
          error: repairError,
          providerCalls: foldCalls + repairCalls,
          checkpointRevision: current?.sourceEventRevision ?? 0,
          captureRevision: input.metadata.captureRevision,
          deadlineRemainingMs: diagnosticDeadlineRemaining(input, now),
        });
        break;
      }
    }

    try {
      commit(canonical.checkpoint, chunk.throughRevision, 'continuation-fold');
      if (chunk.omittedPriorFacts > 0) {
        warnings.push({
          code: 'checkpoint-projected',
          message: `${chunk.omittedPriorFacts} lower-priority prior facts were omitted from this generator fold input to preserve revision progress.`,
        });
      }
    } catch (error) {
      failure = recordCheckpointFoldFailure({
        warnings,
        code: 'checkpoint-generation-failed',
        stage: 'fold-commit',
        error,
        providerCalls: foldCalls + repairCalls,
        checkpointRevision: current?.sourceEventRevision ?? 0,
        captureRevision: input.metadata.captureRevision,
        deadlineRemainingMs: diagnosticDeadlineRemaining(input, now),
      });
      current = repo.latestAtOrBefore(input.metadata.sessionId, input.metadata.captureRevision);
      break;
    }
    if (input.backgroundSource) {
      backgroundCursor = chunk.nextCursor;
      backgroundRemaining = chunk.remainingAfter;
    } else {
      remainingGroups = remainingGroups.slice(chunk.consumedGroupCount);
    }
  }

  const uncoveredRevisionRange =
    persistentCoverageGap() ??
    calculateUncoveredRevisionRange(current?.sourceEventRevision ?? 0, input.metadata.captureRevision);
  if (uncoveredRevisionRange && !warnings.some((warning) => warning.code === 'coverage-gap')) {
    warnings.push({
      code: 'coverage-gap',
      message: `Checkpoint coverage stops at revision ${uncoveredRevisionRange.from}; source capture is ${uncoveredRevisionRange.to}.`,
    });
  }
  return {
    checkpoint: current,
    refreshed,
    foldCalls,
    repairCalls,
    inputTokens,
    outputTokens,
    observedContextWindowTokens,
    warnings,
    failure,
    uncoveredRevisionRange,
  };
}
