import type { Database } from 'better-sqlite3';
import { getDb } from '@main/store/db';
import { createContinuationCheckpointRepo } from '@main/store/continuation-checkpoint-repo';
import { resolveGeneratorFoldInputBudgetTokens } from './budget-policy';
import {
  foldContinuationCheckpoint,
  type FoldContinuationCheckpointResult,
} from './checkpoint-fold';
import type {
  CheckpointRefreshBacklogSnapshot,
  CheckpointRefreshTrigger,
} from './checkpoint-refresh-scheduler';
import type { ContinuationCheckpointGenerator } from './checkpoint-generator';
import { resolveContinuationGeneratorSnapshot } from './resolver';
import { createCheckpointGeneratorRuntime } from './runtime';
import { contextCapacityResolver } from './context-capacity-resolver';
import {
  openCheckpointBackgroundSource,
  type CheckpointBackgroundChunkSource,
  type OpenCheckpointBackgroundSourceInput,
} from './checkpoint-background-worker-client';
import type { ResolvedContinuationGenerator } from './types';

export const BACKGROUND_CHECKPOINT_DEADLINE_MS = 300_000;
export const BACKGROUND_CHECKPOINT_MAX_FOLD_CALLS = 2;
export const BACKGROUND_CHECKPOINT_MAX_REPAIR_CALLS = 1;

export interface ContinuationCheckpointRefreshSnapshot
  extends CheckpointRefreshBacklogSnapshot {
  rebuildAfterRevision: number;
  checkpointCreatedAt: number | null;
  saturated: boolean;
}

export interface BackgroundCheckpointRefreshResult {
  trigger: CheckpointRefreshTrigger;
  captureRevision: number;
  materializedThroughRevision: number;
  checkpointThroughRevision: number;
  refreshed: boolean;
  foldCalls: number;
  repairCalls: number;
  uncoveredRevisionRange: { from: number; to: number } | null;
}

interface BackgroundCheckpointRefreshDependencies {
  db?: Database;
  now?: () => number;
  resolveGenerator?: () => ResolvedContinuationGenerator;
  generatorFactory?: (generator: ResolvedContinuationGenerator) => ContinuationCheckpointGenerator;
  openBackgroundSource?: (
    input: OpenCheckpointBackgroundSourceInput,
  ) => Promise<CheckpointBackgroundChunkSource>;
}

/** Fold the latest durable revision once this job reaches the bounded provider queue. */
export async function refreshContinuationCheckpointWithDependencies(
  input: {
    sessionId: string;
    trigger: CheckpointRefreshTrigger;
    snapshot: Readonly<ContinuationCheckpointRefreshSnapshot>;
    signal?: AbortSignal;
  },
  dependencies: BackgroundCheckpointRefreshDependencies = {},
): Promise<BackgroundCheckpointRefreshResult> {
  if (input.snapshot.sessionId !== input.sessionId) {
    throw new Error('Background checkpoint snapshot belongs to another session');
  }
  const db = dependencies.db ?? getDb();
  const now = dependencies.now ?? Date.now;
  const startedAt = now();
  const deadlineAt = startedAt + BACKGROUND_CHECKPOINT_DEADLINE_MS;
  const generatorSpec = (dependencies.resolveGenerator ?? resolveContinuationGeneratorSnapshot)();
  const backgroundSource = await (
    dependencies.openBackgroundSource ?? openCheckpointBackgroundSource
  )({
    dbPath: db.name,
    sessionId: input.sessionId,
    deadlineAt,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  try {
    const metadata = backgroundSource.metadata;
    // The estimator revision is only an eligibility observation. Event rows are mutable in place,
    // so a historical revision number cannot reconstruct an immutable source without MVCC. Capture
    // the latest source atomically at execution time instead: updates that happened while queued
    // are coalesced into this fold, while updates after capture remain for the next fold.
    if (metadata.captureRevision < input.snapshot.sourceEventRevision) {
      throw new Error('Background checkpoint capture regressed behind its eligibility observation');
    }
    if (
      metadata.captureRevision > metadata.checkpointThroughRevision &&
      metadata.materializedThroughRevision <= metadata.checkpointThroughRevision
    ) {
      throw new Error('Background checkpoint materialization made no revision progress');
    }
    const generator = (dependencies.generatorFactory ?? createCheckpointGeneratorRuntime)(
      generatorSpec,
    );
    const fold: FoldContinuationCheckpointResult = await foldContinuationCheckpoint({
      db,
      backgroundSource,
      metadata,
      generatorSpec,
      generator,
      generatorFoldInputBudgetTokens: resolveGeneratorFoldInputBudgetTokens(
        generatorSpec.contextWindowTokens,
      ),
      deadlineAt,
      maxFoldCalls: BACKGROUND_CHECKPOINT_MAX_FOLD_CALLS,
      maxRepairCalls: BACKGROUND_CHECKPOINT_MAX_REPAIR_CALLS,
      ...(input.signal ? { signal: input.signal } : {}),
      now,
    });
    if (fold.observedContextWindowTokens !== null) {
      contextCapacityResolver.observe(
        generatorSpec.adapter,
        generatorSpec.model,
        fold.observedContextWindowTokens,
      );
    }
    const latest = createContinuationCheckpointRepo(db).latest(input.sessionId);
    const checkpointThroughRevision = latest?.sourceEventRevision ?? 0;
    if (checkpointThroughRevision < metadata.materializedThroughRevision) {
      throw new Error(
        `Background checkpoint covered revision ${checkpointThroughRevision} of materialized revision ${metadata.materializedThroughRevision}`,
      );
    }
    return {
      trigger: input.trigger,
      captureRevision: metadata.captureRevision,
      materializedThroughRevision: metadata.materializedThroughRevision,
      checkpointThroughRevision,
      refreshed: fold.refreshed,
      foldCalls: fold.foldCalls,
      repairCalls: fold.repairCalls,
      uncoveredRevisionRange: fold.uncoveredRevisionRange,
    };
  } finally {
    await backgroundSource.close();
  }
}

export function refreshContinuationCheckpoint(input: {
  sessionId: string;
  trigger: CheckpointRefreshTrigger;
  snapshot: Readonly<ContinuationCheckpointRefreshSnapshot>;
  signal?: AbortSignal;
}): Promise<BackgroundCheckpointRefreshResult> {
  return refreshContinuationCheckpointWithDependencies(input);
}
