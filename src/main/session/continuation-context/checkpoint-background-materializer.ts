import type { Database } from 'better-sqlite3';
import {
  readLatestContinuationCheckpointAtOrBefore,
  type ContinuationCheckpointRecord,
} from '@main/store/continuation-checkpoint-read';
import {
  createEventRevisionReadRepo,
  type EventRevisionCursor,
  type RawEventRevisionRow,
} from '@main/store/event-revision-read';
import { continuationSessionRuntimeFingerprint } from './runtime-fingerprint';
import {
  buildCheckpointFoldChunk,
  groupContinuationRows,
  type AsyncFoldChunkSource,
  type BuildFoldChunkViewInput,
  type FoldChunkView,
  type RevisionGroup,
} from './checkpoint-fold-chunk';
import { buildCoverageGapFact } from './checkpoint-fold-coverage-gap';
import { utf8ByteLength } from './token-estimator';

export const BACKGROUND_MATERIALIZE_MAX_SOURCE_BYTES = 32 * 1024 * 1024;
export const BACKGROUND_MATERIALIZE_MAX_ROWS = 10_000;
export const BACKGROUND_MATERIALIZE_MAX_WIRE_BYTES = 1024 * 1024;

export interface BackgroundMaterializedMetadata {
  sessionId: string;
  captureRevision: number;
  rebuildAfterRevision: number;
  maxEventId: number | null;
  runtimeFingerprint: string;
  checkpoint: ContinuationCheckpointRecord | null;
  checkpointThroughRevision: number;
  materializedThroughRevision: number;
  sourceRows: number;
  sourceBytes: number;
  groupCount: number;
  normalizedEventCount: number;
  truncatedBy: 'none' | 'rows' | 'source-bytes';
}

export interface MaterializedBackgroundCheckpointSource {
  metadata: BackgroundMaterializedMetadata;
  /** Worker-owned only. Never include this array in a worker message. */
  groups: RevisionGroup[];
}

export interface WorkerOwnedBackgroundFoldSource extends AsyncFoldChunkSource {
  readonly metadata: BackgroundMaterializedMetadata;
}

export interface MaterializeBackgroundCheckpointInput {
  sessionId: string;
  maxSourceBytes?: number;
  maxRows?: number;
}

function positiveSafeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${field} must be positive`);
  return value;
}

function rowBytes(row: RawEventRevisionRow): number {
  return utf8ByteLength(row.payloadJson) +
    utf8ByteLength(row.kind) +
    (row.toolUseId ? utf8ByteLength(row.toolUseId) : 0) +
    64;
}

/**
 * Capture the latest durable WAL snapshot and normalize a resource-bounded complete-revision
 * prefix. Production calls this only inside the readonly background worker.
 */
export function materializeBackgroundCheckpointSource(
  db: Database,
  input: MaterializeBackgroundCheckpointInput,
): MaterializedBackgroundCheckpointSource {
  if (!input.sessionId.trim()) throw new Error('sessionId must not be empty');
  const maxSourceBytes = positiveSafeInteger(
    input.maxSourceBytes ?? BACKGROUND_MATERIALIZE_MAX_SOURCE_BYTES,
    'maxSourceBytes',
  );
  const maxRows = positiveSafeInteger(
    input.maxRows ?? BACKGROUND_MATERIALIZE_MAX_ROWS,
    'maxRows',
  );

  return db.transaction(() => {
    // This first read pins the readonly WAL snapshot. In-place updates committed after it remain
    // visible as their old page version for the rest of this transaction.
    const revisionRepo = createEventRevisionReadRepo(db);
    const state = revisionRepo.state(input.sessionId);
    if (!state) {
      throw new Error(`Cannot materialize checkpoint source for missing session ${input.sessionId}`);
    }
    const captureRevision = state.revision;
    const checkpoint = readLatestContinuationCheckpointAtOrBefore(
      db,
      input.sessionId,
      captureRevision,
    );
    const checkpointThroughRevision = checkpoint?.sourceEventRevision ?? 0;
    const runtimeFingerprint = continuationSessionRuntimeFingerprint(db, input.sessionId);
    if (!runtimeFingerprint) {
      throw new Error(`Cannot capture runtime for missing session ${input.sessionId}`);
    }
    const maxEventId = db.prepare(
      `SELECT MAX(id) FROM events
        WHERE session_id = ? AND COALESCE(change_revision, id) <= ?`,
    ).pluck().get(input.sessionId, captureRevision) as number | null;

    const accepted: RawEventRevisionRow[] = [];
    let acceptedBytes = 0;
    let pending: RawEventRevisionRow[] = [];
    let pendingBytes = 0;
    let truncatedBy: BackgroundMaterializedMetadata['truncatedBy'] = 'none';
    let cursor: EventRevisionCursor = {
      revision: checkpointThroughRevision,
      id: Number.MAX_SAFE_INTEGER,
    };

    const storePending = (): boolean => {
      if (pending.length === 0) return true;
      if (accepted.length + pending.length > maxRows) {
        truncatedBy = 'rows';
        return false;
      }
      if (acceptedBytes + pendingBytes > maxSourceBytes) {
        truncatedBy = 'source-bytes';
        return false;
      }
      accepted.push(...pending);
      acceptedBytes += pendingBytes;
      pending = [];
      pendingBytes = 0;
      return true;
    };

    scan: for (;;) {
      const page = revisionRepo.listRawEvents({
        sessionId: input.sessionId,
        throughRevision: captureRevision,
        after: cursor,
        limit: 500,
      });
      if (page.length === 0) {
        storePending();
        break;
      }
      for (const row of page) {
        if (pending.length > 0 && pending[0].effectiveRevision !== row.effectiveRevision) {
          if (!storePending()) break scan;
        }
        pending.push(row);
        pendingBytes += rowBytes(row);
        // Stop as soon as the current whole group cannot fit. The group is discarded rather than
        // splitting a revision and falsely claiming semantic coverage through it.
        if (accepted.length + pending.length > maxRows) {
          truncatedBy = 'rows';
          break scan;
        }
        if (acceptedBytes + pendingBytes > maxSourceBytes) {
          truncatedBy = 'source-bytes';
          break scan;
        }
      }
      const last = page.at(-1)!;
      cursor = { revision: last.effectiveRevision, id: last.id };
      if (page.length < 500) {
        storePending();
        break;
      }
    }

    const groups = groupContinuationRows(accepted);
    const materializedThroughRevision =
      truncatedBy === 'none'
        ? captureRevision
        : groups.at(-1)?.revision ?? checkpointThroughRevision;
    return {
      metadata: {
        sessionId: input.sessionId,
        captureRevision,
        rebuildAfterRevision: state.rebuildAfterRevision,
        maxEventId,
        runtimeFingerprint,
        checkpoint,
        checkpointThroughRevision,
        materializedThroughRevision,
        sourceRows: accepted.length,
        sourceBytes: acceptedBytes,
        groupCount: groups.length,
        normalizedEventCount: groups.reduce(
          (total, group) => total + group.normalized.length,
          0,
        ),
        truncatedBy,
      },
      groups,
    };
  })();
}

function viewBytes(view: FoldChunkView): number {
  return utf8ByteLength(JSON.stringify({ chunk: view }));
}

/** Worker-only chunk search. It never returns raw rows or the complete group list. */
export function createWorkerOwnedBackgroundFoldSource(
  materialized: MaterializedBackgroundCheckpointSource,
  maxWireBytes = BACKGROUND_MATERIALIZE_MAX_WIRE_BYTES,
): WorkerOwnedBackgroundFoldSource {
  positiveSafeInteger(maxWireBytes, 'maxWireBytes');
  const groups = materialized.groups;

  const buildView = (
    input: BuildFoldChunkViewInput,
    cursor: number,
    candidateCount: number,
  ): FoldChunkView | null => {
    let exactCount = candidateCount;
    for (;;) {
      // Normalize exactly the raw prefix that the returned chunk will cover. A larger search
      // window may contain a completed tool end that deduplicates an earlier start even when the
      // token budget stops before that end. Rebuild on the consumed count until the prefix is
      // stable; the count only decreases, so this cannot loop without progress.
      const candidates = groupContinuationRows(
        groups
          .slice(cursor, cursor + exactCount)
          .flatMap((group) => group.rows),
      );
      const finalThroughRevision =
        cursor + exactCount === groups.length
          ? materialized.metadata.materializedThroughRevision
          : candidates.at(-1)!.revision;
      const chunk = buildCheckpointFoldChunk({
        groups: candidates,
        previous: input.previous,
        finalThroughRevision,
        budget: input.budget,
      });
      if (!chunk) return null;
      if (chunk.groups.length < exactCount) {
        exactCount = chunk.groups.length;
        continue;
      }
      if (chunk.groups.length !== exactCount) {
        throw new Error('Background fold chunk escaped its candidate prefix');
      }

      const nextCursor = cursor + exactCount;
      const marker = chunk.requiresCoverageMarker
        ? buildCoverageGapFact({
            coveredThroughRevision: input.coveredThroughRevision,
            revision: chunk.groups[0].revision,
            rows: chunk.groups.flatMap((group) => group.rows),
            allowedEvidence: chunk.currentEvidence,
          })
        : null;
      return {
        cursor,
        nextCursor,
        remainingAfter: nextCursor < groups.length,
        consumedGroupCount: exactCount,
        firstRevision: chunk.groups[0].revision,
        throughRevision: chunk.throughRevision,
        prompt: chunk.prompt,
        normalized: chunk.normalized,
        currentEvidence: chunk.currentEvidence,
        previousForFold: chunk.previousForFold,
        omittedPriorFacts: chunk.omittedPriorFacts,
        requiresCoverageMarker: chunk.requiresCoverageMarker,
        coverageMarker: marker,
      };
    }
  };

  return {
    metadata: materialized.metadata,
    async buildNextChunk(input): Promise<FoldChunkView | null> {
      let cursor = input.cursor;
      while (cursor < groups.length && groups[cursor].revision <= input.coveredThroughRevision) {
        cursor += 1;
      }
      if (cursor >= groups.length) return null;

      let low = 1;
      let high = groups.length - cursor;
      let best: FoldChunkView | null = null;
      while (low <= high) {
        const midpoint = Math.floor((low + high) / 2);
        const view = buildView(input, cursor, midpoint);
        if (!view) return best;
        if (viewBytes(view) <= maxWireBytes) {
          best = view;
          if (view.consumedGroupCount < midpoint) return view;
          low = midpoint + 1;
        } else {
          high = Math.min(midpoint - 1, view.consumedGroupCount - 1);
        }
      }
      if (best) return best;

      // Avoid a zero-progress retry loop when prompt + repair data duplicate one large group.
      const group = groupContinuationRows(groups[cursor].rows)[0];
      const evidence = group.normalized.map((event) => {
        const value = event as { eventId: number; effectiveRevision: number };
        return { eventId: value.eventId, revision: value.effectiveRevision };
      });
      const marker = buildCoverageGapFact({
        coveredThroughRevision: input.coveredThroughRevision,
        revision: group.revision,
        rows: group.rows,
        allowedEvidence: evidence,
      });
      if (!marker) throw new Error('One background revision group cannot fit the worker wire guard');
      const nextCursor = cursor + 1;
      const fallback: FoldChunkView = {
        cursor,
        nextCursor,
        remainingAfter: nextCursor < groups.length,
        consumedGroupCount: 1,
        firstRevision: group.revision,
        throughRevision:
          nextCursor === groups.length
            ? materialized.metadata.materializedThroughRevision
            : group.revision,
        prompt: '',
        normalized: [],
        currentEvidence: marker.evidence,
        previousForFold: input.previous,
        omittedPriorFacts: 0,
        requiresCoverageMarker: true,
        coverageMarker: marker,
      };
      if (viewBytes(fallback) > maxWireBytes) {
        throw new Error('Coverage marker exceeds the worker wire guard');
      }
      return fallback;
    },
  };
}
