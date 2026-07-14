import type { ContinuationCheckpointRecord } from '@main/store/continuation-checkpoint-repo';
import type { RawEventRevisionRow } from '@main/store/event-revision-repo';
import {
  groupContinuationRows,
  type AsyncFoldChunkSource,
  type FoldChunk,
  type FoldChunkView,
  type RevisionGroup,
} from './checkpoint-fold-chunk';
import { buildCoverageGapFact } from './checkpoint-fold-coverage-gap';
import {
  CONTINUATION_CHECKPOINT_SECTIONS,
  type ContinuationCheckpoint,
} from './checkpoint-schema';
import type { ContinuationSourceSpoolStore } from './source-spool';

export interface CheckpointFoldMetadata {
  spoolId?: string;
  sessionId: string;
  captureRevision: number;
  rebuildAfterRevision: number;
  maxEventId: number | null;
  checkpoint: ContinuationCheckpointRecord | null;
  materializedThroughRevision: number;
  normalizedEventCount?: number;
}

export interface CheckpointFoldSourceSelection {
  spool?: ContinuationSourceSpoolStore;
  backgroundSource?: AsyncFoldChunkSource;
}

export function emptyContinuationCheckpoint(): ContinuationCheckpoint {
  return Object.fromEntries([
    ['formatVersion', 1],
    ...CONTINUATION_CHECKPOINT_SECTIONS.map((section) => [section, []]),
  ]) as unknown as ContinuationCheckpoint;
}

export function calculateUncoveredRevisionRange(
  from: number,
  to: number,
): { from: number; to: number } | null {
  return from < to ? { from, to } : null;
}

export function assertCheckpointFoldSource(
  source: CheckpointFoldSourceSelection,
  metadata: CheckpointFoldMetadata,
): void {
  if ((source.spool ? 1 : 0) + (source.backgroundSource ? 1 : 0) !== 1) {
    throw new Error('Checkpoint fold requires exactly one source');
  }
  if (source.spool && !metadata.spoolId) {
    throw new Error('Foreground checkpoint fold requires a spool id');
  }
}

function readAllRows(
  spool: ContinuationSourceSpoolStore,
  spoolId: string,
): RawEventRevisionRow[] {
  const rows: RawEventRevisionRow[] = [];
  let ordinal = -1;
  for (;;) {
    const page = spool.readSourceRows(spoolId, ordinal, 1_000);
    rows.push(...page);
    if (page.length < 1_000) return rows;
    ordinal += page.length;
  }
}

export function foregroundRevisionGroups(input: {
  spool?: ContinuationSourceSpoolStore;
  metadata: CheckpointFoldMetadata;
  afterRevision: number;
}): RevisionGroup[] {
  if (!input.spool) return [];
  return groupContinuationRows(readAllRows(input.spool, input.metadata.spoolId!)).filter(
    (group) => group.revision > input.afterRevision,
  );
}

export function foregroundChunkView(input: {
  chunk: FoldChunk;
  remainingGroupCount: number;
  coveredThroughRevision: number;
}): FoldChunkView {
  const marker = input.chunk.requiresCoverageMarker
    ? buildCoverageGapFact({
        coveredThroughRevision: input.coveredThroughRevision,
        revision: input.chunk.groups[0].revision,
        rows: input.chunk.groups.flatMap((group) => group.rows),
        allowedEvidence: input.chunk.currentEvidence,
      })
    : null;
  return {
    cursor: 0,
    nextCursor: input.chunk.groups.length,
    remainingAfter: input.chunk.groups.length < input.remainingGroupCount,
    consumedGroupCount: input.chunk.groups.length,
    firstRevision: input.chunk.groups[0].revision,
    throughRevision: input.chunk.throughRevision,
    prompt: input.chunk.prompt,
    normalized: input.chunk.normalized,
    currentEvidence: input.chunk.currentEvidence,
    previousForFold: input.chunk.previousForFold,
    omittedPriorFacts: input.chunk.omittedPriorFacts,
    requiresCoverageMarker: input.chunk.requiresCoverageMarker,
    coverageMarker: marker,
  };
}
