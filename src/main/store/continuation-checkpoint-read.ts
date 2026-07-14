import type { Database } from 'better-sqlite3';
import {
  CONTINUATION_CHECKPOINT_SECTIONS,
  parseContinuationCheckpointJson,
  type ContinuationCheckpoint,
} from '@main/session/continuation-context/checkpoint-schema';

/** Persisted checkpoint shape returned by both process-local and worker-local readers. */
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

export interface ContinuationCheckpointRow {
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

export interface ContinuationCheckpointRevisionState {
  revision: number;
  rebuild_after_revision: number;
}

function assertSafeNonNegativeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
}

export function assertCheckpointEvidenceWithinCoverage(
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

export function readContinuationCheckpointRevisionState(
  db: Database,
  sessionId: string,
): ContinuationCheckpointRevisionState | null {
  return (
    (db
      .prepare(
        `SELECT revision, rebuild_after_revision
           FROM session_event_revisions
          WHERE session_id = ?`,
      )
      .get(sessionId) as ContinuationCheckpointRevisionState | undefined) ?? null
  );
}

export function validateContinuationCheckpointRow(
  row: ContinuationCheckpointRow,
  state: ContinuationCheckpointRevisionState,
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
    assertCheckpointEvidenceWithinCoverage(canonical.checkpoint, row.source_event_revision);
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

export function listContinuationCheckpointRows(
  db: Database,
  sessionId: string,
  atOrBeforeRevision?: number,
): ContinuationCheckpointRow[] {
  if (atOrBeforeRevision === undefined) {
    return db
      .prepare(
        `SELECT * FROM continuation_checkpoints
          WHERE session_id = ?
          ORDER BY generation DESC`,
      )
      .all(sessionId) as ContinuationCheckpointRow[];
  }
  return db
    .prepare(
      `SELECT * FROM continuation_checkpoints
        WHERE session_id = ? AND source_event_revision <= ?
        ORDER BY generation DESC`,
    )
    .all(sessionId, atOrBeforeRevision) as ContinuationCheckpointRow[];
}

export function latestValidatedContinuationCheckpoint(
  db: Database,
  sessionId: string,
  state: ContinuationCheckpointRevisionState,
  atOrBeforeRevision?: number,
): ContinuationCheckpointRecord | null {
  for (const row of listContinuationCheckpointRows(db, sessionId, atOrBeforeRevision)) {
    const checkpoint = validateContinuationCheckpointRow(row, state);
    if (checkpoint) return checkpoint;
  }
  return null;
}

/**
 * Worker-safe equivalent of `createContinuationCheckpointRepo(db).latestAtOrBefore(...)`.
 * This module deliberately has no process DB facade, logger, Electron, or migration imports.
 */
export function readLatestContinuationCheckpointAtOrBefore(
  db: Database,
  sessionId: string,
  revision: number,
): ContinuationCheckpointRecord | null {
  assertSafeNonNegativeInteger(revision, 'revision');
  const state = readContinuationCheckpointRevisionState(db, sessionId);
  return state
    ? latestValidatedContinuationCheckpoint(db, sessionId, state, revision)
    : null;
}
