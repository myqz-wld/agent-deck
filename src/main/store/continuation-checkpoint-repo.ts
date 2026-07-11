import type { Database } from 'better-sqlite3';
import {
  CONTINUATION_CHECKPOINT_SECTIONS,
  canonicalizeContinuationCheckpoint,
  parseContinuationCheckpointJson,
  type ContinuationCheckpoint,
} from '@main/session/continuation-context/checkpoint-schema';
import { getDb } from './db';

const RETAINED_VALID_CHECKPOINTS = 3;

export interface ContinuationCheckpointRecord {
  id: number;
  sessionId: string;
  generation: number;
  parentCheckpointId: number | null;
  formatVersion: number;
  sourceEventRevision: number;
  sourceRebuildAfterRevision: number;
  sourceMaxEventId: number | null;
  checkpoint: ContinuationCheckpoint;
  payloadJson: string;
  contentHash: string;
  generatorAdapter: string;
  generatorModel: string | null;
  generatorThinking: string | null;
  trigger: string;
  inputTokens: number | null;
  outputTokens: number | null;
  checkpointTokens: number | null;
  createdAt: number;
}

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

interface CheckpointRow {
  id: number;
  session_id: string;
  generation: number;
  parent_checkpoint_id: number | null;
  format_version: number;
  source_event_revision: number;
  source_rebuild_after_revision: number;
  source_max_event_id: number | null;
  payload_json: string;
  content_hash: string;
  generator_adapter: string;
  generator_model: string | null;
  generator_thinking: string | null;
  trigger: string;
  input_tokens: number | null;
  output_tokens: number | null;
  checkpoint_tokens: number | null;
  created_at: number;
}

interface RevisionStateRow {
  revision: number;
  rebuild_after_revision: number;
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

function assertEvidenceWithinCoverage(
  checkpoint: ContinuationCheckpoint,
  sourceEventRevision: number,
): void {
  for (const section of CONTINUATION_CHECKPOINT_SECTIONS) {
    for (const fact of checkpoint[section]) {
      for (const evidence of fact.evidence) {
        if (evidence.revision > sourceEventRevision) {
          throw new Error(
            `Checkpoint fact ${fact.id} cites revision ${evidence.revision} beyond source revision ${sourceEventRevision}`,
          );
        }
      }
    }
  }
}

function readRevisionState(db: Database, sessionId: string): RevisionStateRow | null {
  return (
    (db
      .prepare(
        `SELECT revision, rebuild_after_revision
           FROM session_event_revisions
          WHERE session_id = ?`,
      )
      .get(sessionId) as RevisionStateRow | undefined) ?? null
  );
}

function validateRow(
  row: CheckpointRow,
  state: RevisionStateRow,
): ContinuationCheckpointRecord | null {
  try {
    if (
      row.source_event_revision < state.rebuild_after_revision ||
      row.source_event_revision > state.revision ||
      row.source_rebuild_after_revision !== state.rebuild_after_revision ||
      row.source_rebuild_after_revision > row.source_event_revision
    ) {
      return null;
    }
    const canonical = parseContinuationCheckpointJson(row.payload_json);
    assertEvidenceWithinCoverage(canonical.checkpoint, row.source_event_revision);
    if (
      canonical.checkpoint.formatVersion !== row.format_version ||
      canonical.contentHash !== row.content_hash
    ) {
      return null;
    }
    return {
      id: row.id,
      sessionId: row.session_id,
      generation: row.generation,
      parentCheckpointId: row.parent_checkpoint_id,
      formatVersion: row.format_version,
      sourceEventRevision: row.source_event_revision,
      sourceRebuildAfterRevision: row.source_rebuild_after_revision,
      sourceMaxEventId: row.source_max_event_id,
      checkpoint: canonical.checkpoint,
      payloadJson: canonical.payloadJson,
      contentHash: row.content_hash,
      generatorAdapter: row.generator_adapter,
      generatorModel: row.generator_model,
      generatorThinking: row.generator_thinking,
      trigger: row.trigger,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      checkpointTokens: row.checkpoint_tokens,
      createdAt: row.created_at,
    };
  } catch {
    return null;
  }
}

function listRows(
  db: Database,
  sessionId: string,
  atOrBeforeRevision?: number,
): CheckpointRow[] {
  if (atOrBeforeRevision === undefined) {
    return db
      .prepare(
        `SELECT * FROM continuation_checkpoints
          WHERE session_id = ?
          ORDER BY generation DESC`,
      )
      .all(sessionId) as CheckpointRow[];
  }
  return db
    .prepare(
      `SELECT * FROM continuation_checkpoints
        WHERE session_id = ? AND source_event_revision <= ?
        ORDER BY generation DESC`,
    )
    .all(sessionId, atOrBeforeRevision) as CheckpointRow[];
}

function latestValidated(
  db: Database,
  sessionId: string,
  state: RevisionStateRow,
  atOrBeforeRevision?: number,
): ContinuationCheckpointRecord | null {
  for (const row of listRows(db, sessionId, atOrBeforeRevision)) {
    const checkpoint = validateRow(row, state);
    if (checkpoint) return checkpoint;
  }
  return null;
}

function conflict(
  reason: CommitCheckpointConflictReason,
  state: RevisionStateRow | null,
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
    const state = readRevisionState(db, sessionId);
    return state ? latestValidated(db, sessionId, state) : null;
  }

  function latestAtOrBefore(
    sessionId: string,
    revision: number,
  ): ContinuationCheckpointRecord | null {
    assertSafeNonNegativeInteger(revision, 'revision');
    const state = readRevisionState(db, sessionId);
    return state ? latestValidated(db, sessionId, state, revision) : null;
  }

  const commitTx = db.transaction(
    (input: CommitContinuationCheckpointInput): CommitContinuationCheckpointResult => {
      const state = readRevisionState(db, input.sessionId);
      if (!state) return conflict('session-missing', null, null);

      const currentHead = latestValidated(db, input.sessionId, state);
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
      assertEvidenceWithinCoverage(canonical.checkpoint, input.sourceEventRevision);
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

      const allRows = listRows(db, input.sessionId);
      const validIds: number[] = [];
      for (const row of allRows) {
        if (validateRow(row, state)) validIds.push(row.id);
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
        .get(insertedId) as CheckpointRow | undefined;
      const checkpoint = inserted ? validateRow(inserted, state) : null;
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
