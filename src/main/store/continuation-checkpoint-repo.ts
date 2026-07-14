import type { Database } from 'better-sqlite3';
import { canonicalizeContinuationCheckpoint } from '@main/session/continuation-context/checkpoint-schema';
import { getDb } from './db';
import {
  assertCheckpointEvidenceWithinCoverage,
  latestValidatedContinuationCheckpoint,
  listContinuationCheckpointRows,
  readContinuationCheckpointRevisionState,
  readLatestContinuationCheckpointAtOrBefore,
  validateContinuationCheckpointRow,
  type ContinuationCheckpointRecord,
  type ContinuationCheckpointRevisionState,
  type ContinuationCheckpointRow,
} from './continuation-checkpoint-read';

export type { ContinuationCheckpointRecord } from './continuation-checkpoint-read';

const RETAINED_VALID_CHECKPOINTS = 3;

export interface CommitContinuationCheckpointInput {
  sessionId: string;
  expectedHeadId: number | null;
  expectedRebuildAfterRevision: number;
  sourceEventRevision: number;
  sourceMaxEventId: number | null;
  checkpoint: unknown;
  generatorAdapter: string;
  generatorModel: string | null;
  generatorThinking: string | null;
  trigger: string;
  inputTokens?: number | null;
  outputTokens?: number | null;
  checkpointTokens?: number | null;
  createdAt?: number;
  allowSameRevisionRefresh?: boolean;
}

export type CommitCheckpointConflictReason =
  | 'session-missing'
  | 'head-changed'
  | 'rebuild-epoch-changed'
  | 'source-revision-ahead'
  | 'coverage-regression'
  | 'same-revision-refresh-not-allowed';

export type CommitContinuationCheckpointResult =
  | { ok: true; checkpoint: ContinuationCheckpointRecord }
  | {
      ok: false;
      reason: CommitCheckpointConflictReason;
      currentHeadId: number | null;
      currentRevision: number | null;
      currentRebuildAfterRevision: number | null;
    };

export interface ContinuationCheckpointRepo {
  latest(sessionId: string): ContinuationCheckpointRecord | null;
  latestAtOrBefore(sessionId: string, revision: number): ContinuationCheckpointRecord | null;
  commit(input: CommitContinuationCheckpointInput): CommitContinuationCheckpointResult;
}

function assertSafeNonNegativeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
}

function validateOptionalCount(value: number | null | undefined, field: string): number | null {
  if (value == null) return null;
  assertSafeNonNegativeInteger(value, field);
  return value;
}

function validateText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} must not be empty`);
  return normalized;
}

function conflict(
  reason: CommitCheckpointConflictReason,
  state: ContinuationCheckpointRevisionState | null,
  currentHeadId: number | null,
): CommitContinuationCheckpointResult {
  return {
    ok: false,
    reason,
    currentHeadId,
    currentRevision: state?.revision ?? null,
    currentRebuildAfterRevision: state?.rebuild_after_revision ?? null,
  };
}

export function createContinuationCheckpointRepo(db: Database): ContinuationCheckpointRepo {
  function latest(sessionId: string): ContinuationCheckpointRecord | null {
    const state = readContinuationCheckpointRevisionState(db, sessionId);
    return state ? latestValidatedContinuationCheckpoint(db, sessionId, state) : null;
  }

  function latestAtOrBefore(
    sessionId: string,
    revision: number,
  ): ContinuationCheckpointRecord | null {
    return readLatestContinuationCheckpointAtOrBefore(db, sessionId, revision);
  }

  const commitTx = db.transaction(
    (input: CommitContinuationCheckpointInput): CommitContinuationCheckpointResult => {
      const state = readContinuationCheckpointRevisionState(db, input.sessionId);
      if (!state) return conflict('session-missing', null, null);

      const currentHead = latestValidatedContinuationCheckpoint(db, input.sessionId, state);
      if (state.rebuild_after_revision !== input.expectedRebuildAfterRevision) {
        return conflict('rebuild-epoch-changed', state, currentHead?.id ?? null);
      }
      if (currentHead?.id !== input.expectedHeadId && !(currentHead === null && input.expectedHeadId === null)) {
        return conflict('head-changed', state, currentHead?.id ?? null);
      }
      if (input.sourceEventRevision > state.revision) {
        return conflict('source-revision-ahead', state, currentHead?.id ?? null);
      }
      if (input.sourceEventRevision < state.rebuild_after_revision) {
        return conflict('rebuild-epoch-changed', state, currentHead?.id ?? null);
      }
      if (currentHead && input.sourceEventRevision < currentHead.sourceEventRevision) {
        return conflict('coverage-regression', state, currentHead.id);
      }
      if (
        currentHead &&
        input.sourceEventRevision === currentHead.sourceEventRevision &&
        input.allowSameRevisionRefresh !== true
      ) {
        return conflict('same-revision-refresh-not-allowed', state, currentHead.id);
      }

      const canonical = canonicalizeContinuationCheckpoint(input.checkpoint);
      assertCheckpointEvidenceWithinCoverage(canonical.checkpoint, input.sourceEventRevision);
      const maxGeneration = db
        .prepare(
          `SELECT COALESCE(MAX(generation), 0) AS generation
             FROM continuation_checkpoints
            WHERE session_id = ?`,
        )
        .get(input.sessionId) as { generation: number };
      const generation = maxGeneration.generation + 1;
      const createdAt = input.createdAt ?? Date.now();
      assertSafeNonNegativeInteger(createdAt, 'createdAt');

      const info = db
        .prepare(
          `INSERT INTO continuation_checkpoints (
             session_id, generation, parent_checkpoint_id, format_version,
             source_event_revision, source_rebuild_after_revision, source_max_event_id,
             payload_json, content_hash, generator_adapter, generator_model,
             generator_thinking, trigger, input_tokens, output_tokens,
             checkpoint_tokens, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.sessionId,
          generation,
          currentHead?.id ?? null,
          canonical.checkpoint.formatVersion,
          input.sourceEventRevision,
          input.expectedRebuildAfterRevision,
          input.sourceMaxEventId,
          canonical.payloadJson,
          canonical.contentHash,
          validateText(input.generatorAdapter, 'generatorAdapter'),
          input.generatorModel,
          input.generatorThinking,
          validateText(input.trigger, 'trigger'),
          validateOptionalCount(input.inputTokens, 'inputTokens'),
          validateOptionalCount(input.outputTokens, 'outputTokens'),
          validateOptionalCount(input.checkpointTokens, 'checkpointTokens'),
          createdAt,
        );
      const insertedId = Number(info.lastInsertRowid);

      const allRows = listContinuationCheckpointRows(db, input.sessionId);
      const validIds: number[] = [];
      for (const row of allRows) {
        if (validateContinuationCheckpointRow(row, state)) validIds.push(row.id);
      }
      const retainedIds = validIds.slice(0, RETAINED_VALID_CHECKPOINTS);
      if (retainedIds.length > 0) {
        const placeholders = retainedIds.map(() => '?').join(', ');
        db.prepare(
          `DELETE FROM continuation_checkpoints
            WHERE session_id = ? AND id NOT IN (${placeholders})`,
        ).run(input.sessionId, ...retainedIds);
      }

      const inserted = db
        .prepare(`SELECT * FROM continuation_checkpoints WHERE id = ?`)
        .get(insertedId) as ContinuationCheckpointRow | undefined;
      const checkpoint = inserted ? validateContinuationCheckpointRow(inserted, state) : null;
      if (!checkpoint) throw new Error('Committed continuation checkpoint failed read validation');
      return { ok: true, checkpoint };
    },
  );

  function commit(input: CommitContinuationCheckpointInput): CommitContinuationCheckpointResult {
    assertSafeNonNegativeInteger(input.expectedRebuildAfterRevision, 'expectedRebuildAfterRevision');
    assertSafeNonNegativeInteger(input.sourceEventRevision, 'sourceEventRevision');
    if (input.sourceMaxEventId != null) {
      assertSafeNonNegativeInteger(input.sourceMaxEventId, 'sourceMaxEventId');
    }
    if (input.expectedHeadId != null) {
      assertSafeNonNegativeInteger(input.expectedHeadId, 'expectedHeadId');
    }
    return commitTx.immediate(input);
  }

  return { latest, latestAtOrBefore, commit };
}

/** Production facade that resolves the current process database on every call. */
export const continuationCheckpointRepo: ContinuationCheckpointRepo = {
  latest: (sessionId) => createContinuationCheckpointRepo(getDb()).latest(sessionId),
  latestAtOrBefore: (sessionId, revision) =>
    createContinuationCheckpointRepo(getDb()).latestAtOrBefore(sessionId, revision),
  commit: (input) => createContinuationCheckpointRepo(getDb()).commit(input),
};
