import type { Database } from 'better-sqlite3';
import {
  classifyContinuationMessage,
  type ClassifiedContinuationMessage,
} from './message-classifier';
import { estimateRawUserTailTokens, selectRawUserTail } from './raw-user-tail';
import type { RawContinuationUserInput } from './types';
import { utf8ByteLength } from './token-estimator';

export interface CaptureSpoolRawTailResult {
  spoolBytes: number;
  retainedRawTokens: number;
  rawWarnings: Array<'legacy-wrapper-excluded' | 'legacy-wrapper-unwrapped'>;
  rawScanTruncated: boolean;
}

/** Capture the optional raw-user tail separately so fold-only background spools can skip it. */
export function captureSpoolRawTail(input: {
  db: Database;
  spoolId: string;
  sessionId: string;
  captureRevision: number;
  rawRetentionCeilingTokens: number;
  maxSpoolBytes: number;
  initialSpoolBytes: number;
}): CaptureSpoolRawTailResult {
  const rawCandidates: ClassifiedContinuationMessage[] = [];
  const rawWarnings = new Set<'legacy-wrapper-excluded' | 'legacy-wrapper-unwrapped'>();
  let rawCursor: { revision: number; id: number } | null = null;
  let rawScanBytes = 0;
  let rawScanTruncated = false;
  for (;;) {
    const params: Array<string | number> = [input.sessionId, input.captureRevision];
    const cursorClause = rawCursor
      ? `AND (COALESCE(change_revision, id), id) < (?, ?)`
      : '';
    if (rawCursor) params.push(rawCursor.revision, rawCursor.id);
    params.push(128);
    const rows = input.db
      .prepare(
        `SELECT id, COALESCE(change_revision, id) AS effective_revision,
                kind, payload_json, ts
           FROM events
          WHERE session_id = ?
            AND COALESCE(change_revision, id) <= ?
            ${cursorClause}
          ORDER BY COALESCE(change_revision, id) DESC, id DESC
          LIMIT ?`,
      )
      .all(...params) as Array<{
        id: number;
        effective_revision: number;
        kind: string;
        payload_json: string;
        ts: number;
      }>;
    for (const row of rows) {
      rawScanBytes += utf8ByteLength(row.payload_json) + 64;
      if (input.initialSpoolBytes + rawScanBytes > input.maxSpoolBytes) {
        rawScanTruncated = true;
        break;
      }
      const classified = classifyContinuationMessage({
        eventId: row.id,
        effectiveRevision: row.effective_revision,
        ts: row.ts,
        kind: row.kind,
        payloadJson: row.payload_json,
      });
      if (classified.warning) rawWarnings.add(classified.warning);
      if (classified.message) rawCandidates.push(classified.message);
    }
    if (rawScanTruncated) break;
    const selection = selectRawUserTail(rawCandidates, input.rawRetentionCeilingTokens);
    if (selection.stoppedAtEventId !== null || rows.length < 128) break;
    const last = rows.at(-1)!;
    rawCursor = { revision: last.effective_revision, id: last.id };
  }

  const rawSelection = selectRawUserTail(rawCandidates, input.rawRetentionCeilingTokens);
  const insertRaw = input.db.prepare(
    `INSERT INTO continuation_raw_spool (preparation_id, ordinal, input_json)
     VALUES (?, ?, ?)`,
  );
  const retainedRawNewestFirst: RawContinuationUserInput[] = [];
  let spoolBytes = input.initialSpoolBytes;
  for (const message of [...rawSelection.messages].reverse()) {
    const inputJson = JSON.stringify(message);
    const bytes = utf8ByteLength(inputJson) + 32;
    if (spoolBytes + bytes > input.maxSpoolBytes) {
      rawScanTruncated = true;
      break;
    }
    retainedRawNewestFirst.push(message);
    spoolBytes += bytes;
  }
  const retainedRaw = retainedRawNewestFirst.reverse();
  retainedRaw.forEach((message, index) => {
    insertRaw.run(input.spoolId, index, JSON.stringify(message));
  });
  return {
    spoolBytes,
    retainedRawTokens: estimateRawUserTailTokens(retainedRaw),
    rawWarnings: [...rawWarnings],
    rawScanTruncated,
  };
}
