import type { Database } from 'better-sqlite3';
import {
  createContinuationCheckpointRepo,
  type ContinuationCheckpointRecord,
} from '@main/store/continuation-checkpoint-repo';
import type { RawEventRevisionRow } from '@main/store/event-revision-repo';
import {
  CONTINUATION_CHECKPOINT_SECTIONS,
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
  groupContinuationRows,
  priorCheckpointEvidence,
} from './checkpoint-fold-chunk';
import { buildCheckpointRepairPrompt } from './checkpoint-prompts';
import {
  assertActiveCheckpointFactsCarryForward,
  projectContinuationCheckpointWithCoverageMarker,
} from './checkpoint-projection';
import {
  buildCoverageGapFact,
  coverageGapRangeFromCheckpoint,
} from './checkpoint-fold-coverage-gap';
import type { ContinuationSourceSpoolStore, ContinuationSpoolMetadata } from './source-spool';
import { estimateContinuationJsonTokens, estimateContinuationTokens, truncateContinuationTextMiddle } from './token-estimator';
import type { ContinuationWarning, ResolvedContinuationGenerator } from './types';

const MAX_CANONICAL_CHECKPOINT_TOKENS = 24_000;

export interface FoldContinuationCheckpointInput {
  db: Database;
  spool: ContinuationSourceSpoolStore;
  metadata: ContinuationSpoolMetadata;
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
  uncoveredRevisionRange: { from: number; to: number } | null;
}

function emptyCheckpoint(): ContinuationCheckpoint {
  return Object.fromEntries([
    ['formatVersion', 1],
    ...CONTINUATION_CHECKPOINT_SECTIONS.map((section) => [section, []]),
  ]) as unknown as ContinuationCheckpoint;
}

function readAllRows(spool: ContinuationSourceSpoolStore, spoolId: string): RawEventRevisionRow[] {
  const rows: RawEventRevisionRow[] = [];
  let ordinal = -1;
  for (;;) {
    const page = spool.readSourceRows(spoolId, ordinal, 1_000);
    rows.push(...page);
    if (page.length < 1_000) return rows;
    ordinal += page.length;
  }
}

function deadlineRemaining(input: FoldContinuationCheckpointInput, now: () => number): number {
  if (input.signal?.aborted) throw new CheckpointGeneratorError('Checkpoint generation aborted', 'aborted');
  return Math.max(0, input.deadlineAt - now());
}

function uncovered(from: number, to: number): { from: number; to: number } | null {
  return from < to ? { from, to } : null;
}

export async function foldContinuationCheckpoint(
  input: FoldContinuationCheckpointInput,
): Promise<FoldContinuationCheckpointResult> {
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
  const rows = readAllRows(input.spool, input.metadata.spoolId);
  let remainingGroups = groupContinuationRows(rows).filter(
    (group) => group.revision > (current?.sourceEventRevision ?? 0),
  );

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
    const canonical = canonicalizeContinuationCheckpoint(checkpoint);
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
  };

  if (remainingGroups.every((group) => group.normalized.length === 0)) {
    if (input.metadata.materializedThroughRevision > (current?.sourceEventRevision ?? 0)) {
      try {
        commit(current?.checkpoint ?? emptyCheckpoint(), input.metadata.materializedThroughRevision, 'continuation-deterministic-fold');
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
      uncoveredRevisionRange:
        persistentCoverageGap() ??
        uncovered(current?.sourceEventRevision ?? 0, input.metadata.captureRevision),
    };
  }

  while (remainingGroups.length > 0) {
    if (deadlineRemaining(input, now) <= 0) break;
    const chunk = buildCheckpointFoldChunk({
      groups: remainingGroups,
      previous: current?.checkpoint ?? null,
      finalThroughRevision: input.metadata.materializedThroughRevision,
      budget: input.generatorFoldInputBudgetTokens,
    });
    if (!chunk) {
      warnings.push({
        code: 'coverage-gap',
        message: 'The next complete event-revision group exceeds the generator fold budget.',
      });
      break;
    }
    if (chunk.requiresCoverageMarker) {
      const marker = buildCoverageGapFact({
        coveredThroughRevision: current?.sourceEventRevision ?? 0,
        revision: chunk.groups[0].revision,
        rows: chunk.groups.flatMap((group) => group.rows),
        allowedEvidence: chunk.currentEvidence,
      });
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
          message: `Revision ${chunk.groups[0].revision} could not be represented by a bounded checkpoint marker without dropping required active facts.`,
        });
        break;
      }
      try {
        commit(
          bounded.checkpoint,
          chunk.throughRevision,
          'continuation-bounded-coverage-fold',
        );
        warnings.push({
          code: 'coverage-gap',
          message: `Revision ${chunk.groups[0].revision} was retained only as a durable bounded digest; full semantic coverage remains unavailable.`,
        });
      } catch (error) {
        warnings.push({
          code: 'checkpoint-generation-failed',
          message: error instanceof Error ? error.message : String(error),
        });
        current = repo.latestAtOrBefore(input.metadata.sessionId, input.metadata.captureRevision);
        break;
      }
      remainingGroups = remainingGroups.slice(chunk.groups.length);
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
      warnings.push({
        code:
          error instanceof CheckpointGeneratorError &&
          error.code === 'codex-generator-tools-unproven'
            ? 'codex-generator-tools-unproven'
            : 'checkpoint-generation-failed',
        message: error instanceof Error ? error.message : String(error),
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
        warnings.push({
          code: 'checkpoint-repair-failed',
          message: validationError instanceof Error ? validationError.message : String(validationError),
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
        warnings.push({
          code: 'checkpoint-repair-failed',
          message: repairError instanceof Error ? repairError.message : String(repairError),
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
      warnings.push({
        code: 'checkpoint-generation-failed',
        message: error instanceof Error ? error.message : String(error),
      });
      current = repo.latestAtOrBefore(input.metadata.sessionId, input.metadata.captureRevision);
      break;
    }
    remainingGroups = remainingGroups.slice(chunk.groups.length);
  }

  const uncoveredRevisionRange =
    persistentCoverageGap() ??
    uncovered(current?.sourceEventRevision ?? 0, input.metadata.captureRevision);
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
    uncoveredRevisionRange,
  };
}
