import type { Database } from 'better-sqlite3';
import type { AgentEvent, SummaryRecord } from '@shared/types';
import { getDb } from '@main/store/db';
import {
  createContinuationCheckpointRepo,
  type ContinuationCheckpointRecord,
} from '@main/store/continuation-checkpoint-repo';
import { createEventRevisionRepo, type RawEventRevisionRow } from '@main/store/event-revision-repo';
import { classifyContinuationMessage } from '../continuation-context/message-classifier';
import { normalizeContinuationEvent } from '../continuation-context/event-normalizer';
import { projectContinuationCheckpoint } from '../continuation-context/checkpoint-projection';
import { selectRawUserTail } from '../continuation-context/raw-user-tail';
import { estimateContinuationJsonTokens } from '../continuation-context/token-estimator';

const MAX_ACTIVITY_ROWS = 120;
const MAX_RAW_USER_CANDIDATES = 64;
const MAX_NORMALIZED_ACTIVITY_BYTES = 2 * 1024;
const ACTIVITY_BUDGET_TOKENS = 5_000;
const RAW_USER_BUDGET_TOKENS = 3_000;
const CHECKPOINT_BUDGET_TOKENS = 2_500;
const PREVIOUS_SUMMARY_MAX_CHARS = 1_200;

interface EvidenceRow {
  id: number;
  session_id: string;
  effective_revision: number;
  kind: string;
  payload_json: string;
  ts: number;
  tool_use_id: string | null;
}

export interface PeriodicSummaryEvidenceSnapshot {
  sourceEventRevision: number;
  rebuildAfterRevision: number;
  events: (AgentEvent & { id: number })[];
  promptContext: string;
  activityTruncated: boolean;
  rawUserInputsTruncated: boolean;
}

function toRawRow(row: EvidenceRow): RawEventRevisionRow {
  return {
    id: row.id,
    sessionId: row.session_id,
    effectiveRevision: row.effective_revision,
    kind: row.kind,
    payloadJson: row.payload_json,
    ts: row.ts,
    toolUseId: row.tool_use_id,
  };
}

function activityRows(
  db: Database,
  sessionId: string,
  throughRevision: number,
  afterRevision: number | null,
): { rows: RawEventRevisionRow[]; truncated: boolean } {
  const usableAfter = afterRevision !== null;
  const rows = db
    .prepare(
      `SELECT id, session_id, COALESCE(change_revision, id) AS effective_revision,
              kind, payload_json, ts, tool_use_id
         FROM events
        WHERE session_id = ?
          AND COALESCE(change_revision, id) <= ?
          ${usableAfter ? 'AND COALESCE(change_revision, id) > ?' : ''}
          AND kind NOT IN ('thinking', 'token-usage')
        ORDER BY COALESCE(change_revision, id) DESC, id DESC
        LIMIT ?`,
    )
    .all(
      sessionId,
      throughRevision,
      ...(usableAfter ? [afterRevision] : []),
      MAX_ACTIVITY_ROWS + 1,
    ) as EvidenceRow[];
  return {
    rows: rows.slice(0, MAX_ACTIVITY_ROWS).map(toRawRow),
    truncated: rows.length > MAX_ACTIVITY_ROWS,
  };
}

function boundedActivity(rows: RawEventRevisionRow[]): {
  events: (AgentEvent & { id: number })[];
  truncated: boolean;
} {
  const events: (AgentEvent & { id: number })[] = [];
  let tokens = 0;
  let truncated = false;
  for (const row of rows) {
    const normalized = normalizeContinuationEvent(row, MAX_NORMALIZED_ACTIVITY_BYTES);
    if (!normalized) continue;
    const nextTokens = estimateContinuationJsonTokens(normalized, { structuralOverhead: 4 });
    if (tokens + nextTokens > ACTIVITY_BUDGET_TOKENS) {
      truncated = true;
      break;
    }
    tokens += nextTokens;
    events.push({
      id: normalized.eventId,
      sessionId: row.sessionId,
      agentId: '',
      kind: normalized.kind as AgentEvent['kind'],
      payload: normalized.payload,
      ts: normalized.ts,
    });
  }
  return { events, truncated };
}

function recentRawUserCandidates(
  db: Database,
  sessionId: string,
  throughRevision: number,
) {
  const rows = db
    .prepare(
      `SELECT id, session_id, COALESCE(change_revision, id) AS effective_revision,
              kind, payload_json, ts, tool_use_id
         FROM events
        WHERE session_id = ?
          AND COALESCE(change_revision, id) <= ?
          AND kind = 'message'
          AND CASE WHEN json_valid(payload_json) THEN (
            json_extract(payload_json, '$.role') = 'user'
            AND COALESCE(json_extract(payload_json, '$.error'), 0) != 1
            AND COALESCE(json_extract(payload_json, '$.synthetic'), 0) != 1
          ) ELSE 0 END
        ORDER BY COALESCE(change_revision, id) DESC, id DESC
        LIMIT ?`,
    )
    .all(sessionId, throughRevision, MAX_RAW_USER_CANDIDATES + 1) as EvidenceRow[];
  const candidates = rows
    .slice(0, MAX_RAW_USER_CANDIDATES)
    .flatMap((row) => {
      const classified = classifyContinuationMessage({
        eventId: row.id,
        effectiveRevision: row.effective_revision,
        ts: row.ts,
        kind: row.kind,
        payloadJson: row.payload_json,
      });
      return classified.message ? [classified.message] : [];
    });
  const selected = selectRawUserTail(candidates, RAW_USER_BUDGET_TOKENS);
  return {
    messages: selected.messages,
    truncated:
      rows.length > MAX_RAW_USER_CANDIDATES ||
      selected.stoppedAtEventId !== null ||
      selected.truncatedBoundaryMessages > 0,
  };
}

function displayCheckpoint(record: ContinuationCheckpointRecord | null) {
  if (!record) return null;
  const projection = projectContinuationCheckpoint(record, CHECKPOINT_BUDGET_TOKENS);
  const facts = Object.fromEntries(
    Object.entries(projection.facts).map(([section, entries]) => [
      section,
      (entries ?? []).map((fact) => ({
        status: fact.status,
        text: fact.text,
        ...(fact.rationale ? { rationale: fact.rationale } : {}),
        ...(fact.validation ? { validation: fact.validation } : {}),
      })),
    ]),
  );
  return {
    throughRevision: projection.sourceEventRevision,
    omittedFacts: projection.omittedFacts,
    facts,
  };
}

function previousSummaryEvidence(previous: SummaryRecord | null) {
  if (!previous) return null;
  return {
    throughRevision: previous.sourceEventRevision,
    rebuildAfterRevision: previous.sourceRebuildAfterRevision,
    generationSource: previous.generationSource,
    content:
      previous.content.length > PREVIOUS_SUMMARY_MAX_CHARS
        ? `${previous.content.slice(0, PREVIOUS_SUMMARY_MAX_CHARS)}…`
        : previous.content,
  };
}

/** Capture one bounded, read-only evidence snapshot before the summary provider await. */
export function capturePeriodicSummaryEvidence(
  sessionId: string,
  previous: SummaryRecord | null,
  db: Database = getDb(),
): PeriodicSummaryEvidenceSnapshot | null {
  const capture = db.transaction(() => {
    const revisionState = createEventRevisionRepo(db).state(sessionId);
    if (!revisionState) return null;
    const afterRevision =
      previous?.sourceEventRevision != null &&
      previous.sourceRebuildAfterRevision === revisionState.rebuildAfterRevision &&
      previous.sourceEventRevision >= revisionState.rebuildAfterRevision &&
      previous.sourceEventRevision <= revisionState.revision
        ? previous.sourceEventRevision
        : null;
    const rawActivity = activityRows(
      db,
      sessionId,
      revisionState.revision,
      afterRevision,
    );
    const activity = boundedActivity(rawActivity.rows);
    const rawUsers = recentRawUserCandidates(db, sessionId, revisionState.revision);
    const checkpoint = createContinuationCheckpointRepo(db).latestAtOrBefore(
      sessionId,
      revisionState.revision,
    );
    const promptContext = JSON.stringify(
      {
        version: 1,
        source: {
          eventRevision: revisionState.revision,
          rebuildAfterRevision: revisionState.rebuildAfterRevision,
        },
        previousDisplaySummary: previousSummaryEvidence(previous),
        validatedCheckpoint: displayCheckpoint(checkpoint),
        recentUserInputs: rawUsers.messages,
        evidenceLimits: {
          activityTruncated: rawActivity.truncated || activity.truncated,
          rawUserInputsTruncated: rawUsers.truncated,
        },
      },
      null,
      2,
    );
    return {
      sourceEventRevision: revisionState.revision,
      rebuildAfterRevision: revisionState.rebuildAfterRevision,
      events: activity.events,
      promptContext,
      activityTruncated: rawActivity.truncated || activity.truncated,
      rawUserInputsTruncated: rawUsers.truncated,
    };
  });
  return capture();
}
