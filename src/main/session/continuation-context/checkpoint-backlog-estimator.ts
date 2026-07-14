import type { Database } from 'better-sqlite3';
import type {
  EventRevisionCursor,
  RawEventRevisionRow,
} from '@main/store/event-revision-repo';
import { groupContinuationRows } from './checkpoint-fold-chunk';
import {
  CONTINUATION_CHECKPOINT_SECTIONS,
  parseContinuationCheckpointJson,
} from './checkpoint-schema';
import { estimateContinuationJsonTokens, utf8ByteLength } from './token-estimator';

export const DEFAULT_CHECKPOINT_BACKLOG_MAX_SOURCE_BYTES = 32 * 1024 * 1024;
export const DEFAULT_CHECKPOINT_BACKLOG_MAX_ROWS = 10_000;

export interface CheckpointBacklogEstimate {
  sessionId: string;
  /** Eligibility observation only; background capture may advance beyond this revision. */
  captureRevision: number;
  rebuildAfterRevision: number;
  checkpointThroughRevision: number;
  checkpointCreatedAt: number | null;
  estimatedTokens: number;
  sourceRows: number;
  /** True means a resource guard proved the safety threshold should fire, not an exact estimate. */
  saturated: boolean;
}

export interface EstimateCheckpointBacklogInput {
  db: Database;
  sessionId: string;
  /** Value returned after a resource guard; callers normally pass the safety threshold. */
  saturationTokens: number;
  maxSourceBytes?: number;
  maxRows?: number;
}

interface RevisionStateRow {
  session_id: string;
  revision: number;
  rebuild_after_revision: number;
}

interface CheckpointBaselineRow {
  source_event_revision: number;
  source_rebuild_after_revision: number;
  format_version: number;
  payload_json: string;
  content_hash: string;
  created_at: number;
}

interface RawEventRow {
  id: number;
  session_id: string;
  effective_revision: number;
  kind: string;
  payload_json: string;
  ts: number;
  tool_use_id: string | null;
}

function positiveSafeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive safe integer`);
  }
  return value;
}

function latestValidatedCheckpoint(
  db: Database,
  sessionId: string,
  state: RevisionStateRow,
): { sourceEventRevision: number; createdAt: number } | null {
  const rows = db.prepare(
    `SELECT source_event_revision, source_rebuild_after_revision, format_version,
            payload_json, content_hash, created_at
       FROM continuation_checkpoints
      WHERE session_id = ?
      ORDER BY generation DESC`,
  ).all(sessionId) as CheckpointBaselineRow[];
  for (const row of rows) {
    try {
      if (
        row.source_event_revision < state.rebuild_after_revision ||
        row.source_event_revision > state.revision ||
        row.source_rebuild_after_revision !== state.rebuild_after_revision ||
        row.source_rebuild_after_revision > row.source_event_revision
      ) continue;
      const canonical = parseContinuationCheckpointJson(row.payload_json);
      if (
        canonical.checkpoint.formatVersion !== row.format_version ||
        canonical.contentHash !== row.content_hash
      ) continue;
      let evidenceWithinCoverage = true;
      for (const section of CONTINUATION_CHECKPOINT_SECTIONS) {
        for (const fact of canonical.checkpoint[section]) {
          if (fact.evidence.some((evidence) => evidence.revision > row.source_event_revision)) {
            evidenceWithinCoverage = false;
            break;
          }
        }
        if (!evidenceWithinCoverage) break;
      }
      if (evidenceWithinCoverage) {
        return {
          sourceEventRevision: row.source_event_revision,
          createdAt: row.created_at,
        };
      }
    } catch {
      // Match the canonical checkpoint repo: malformed/corrupt generations are skipped.
    }
  }
  return null;
}

function listRawEvents(
  db: Database,
  sessionId: string,
  throughRevision: number,
  after: EventRevisionCursor,
): RawEventRevisionRow[] {
  const rows = db.prepare(
    `SELECT id, session_id, COALESCE(change_revision, id) AS effective_revision,
            kind, payload_json, ts, tool_use_id
       FROM events
      WHERE session_id = ?
        AND COALESCE(change_revision, id) <= ?
        AND (COALESCE(change_revision, id), id) > (?, ?)
      ORDER BY COALESCE(change_revision, id) ASC, id ASC
      LIMIT 1000`,
  ).all(sessionId, throughRevision, after.revision, after.id) as RawEventRow[];
  return rows.map((row) => ({
    id: row.id,
    sessionId: row.session_id,
    effectiveRevision: row.effective_revision,
    kind: row.kind,
    payloadJson: row.payload_json,
    ts: row.ts,
    toolUseId: row.tool_use_id,
  }));
}

/**
 * Estimate only normalized events not covered by the latest validated checkpoint. This is the
 * scheduler's cost gate, not the complete generator prompt size: the prior checkpoint and prompt
 * wrapper are deliberately excluded from the 8k/48k delta thresholds.
 */
export function estimateCheckpointBacklog(
  input: EstimateCheckpointBacklogInput,
): CheckpointBacklogEstimate | null {
  const saturationTokens = positiveSafeInteger(input.saturationTokens, 'saturationTokens');
  const maxSourceBytes = positiveSafeInteger(
    input.maxSourceBytes ?? DEFAULT_CHECKPOINT_BACKLOG_MAX_SOURCE_BYTES,
    'maxSourceBytes',
  );
  const maxRows = positiveSafeInteger(
    input.maxRows ?? DEFAULT_CHECKPOINT_BACKLOG_MAX_ROWS,
    'maxRows',
  );
  const state = input.db.prepare(
    `SELECT session_id, revision, rebuild_after_revision
       FROM session_event_revisions
      WHERE session_id = ?`,
  ).get(input.sessionId) as RevisionStateRow | undefined;
  if (!state) return null;
  const checkpoint = latestValidatedCheckpoint(input.db, input.sessionId, state);
  const checkpointThroughRevision = checkpoint?.sourceEventRevision ?? 0;
  const rows: RawEventRevisionRow[] = [];
  let sourceBytes = 0;
  let cursor: EventRevisionCursor = {
    revision: checkpointThroughRevision,
    id: Number.MAX_SAFE_INTEGER,
  };

  for (;;) {
    const page = listRawEvents(input.db, input.sessionId, state.revision, cursor);
    if (page.length === 0) break;
    for (const row of page) {
      sourceBytes +=
        utf8ByteLength(row.payloadJson) +
        utf8ByteLength(row.kind) +
        (row.toolUseId ? utf8ByteLength(row.toolUseId) : 0) +
        64;
      rows.push(row);
      if (sourceBytes > maxSourceBytes || rows.length >= maxRows) {
        return {
          sessionId: input.sessionId,
          captureRevision: state.revision,
          rebuildAfterRevision: state.rebuild_after_revision,
          checkpointThroughRevision,
          checkpointCreatedAt: checkpoint?.createdAt ?? null,
          estimatedTokens: saturationTokens,
          sourceRows: rows.length,
          saturated: true,
        };
      }
    }
    const last = page.at(-1)!;
    cursor = { revision: last.effectiveRevision, id: last.id };
    if (page.length < 1_000) break;
  }

  const normalized = groupContinuationRows(rows).flatMap((group) => group.normalized);
  return {
    sessionId: input.sessionId,
    captureRevision: state.revision,
    rebuildAfterRevision: state.rebuild_after_revision,
    checkpointThroughRevision,
    checkpointCreatedAt: checkpoint?.createdAt ?? null,
    estimatedTokens: normalized.length > 0 ? estimateContinuationJsonTokens(normalized) : 0,
    sourceRows: rows.length,
    saturated: false,
  };
}
