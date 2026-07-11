import { randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import {
  createContinuationCheckpointRepo,
  type ContinuationCheckpointRecord,
} from '@main/store/continuation-checkpoint-repo';
import {
  createEventRevisionRepo,
  type EventRevisionCursor,
  type RawEventRevisionRow,
} from '@main/store/event-revision-repo';
import {
  classifyContinuationMessage,
  type ClassifiedContinuationMessage,
} from './message-classifier';
import { estimateRawUserTailTokens, selectRawUserTail } from './raw-user-tail';
import type { RawContinuationUserInput } from './types';
import { utf8ByteLength } from './token-estimator';
import { continuationSessionRuntimeFingerprint } from './runtime-fingerprint';

export { continuationSessionRuntimeFingerprint } from './runtime-fingerprint';

export const DEFAULT_CONTINUATION_SPOOL_TTL_MS = 10 * 60 * 1000;
export const DEFAULT_CONTINUATION_SPOOL_MAX_BYTES = 32 * 1024 * 1024;

export interface CaptureContinuationSourceInput {
  sessionId: string;
  rawRetentionCeilingTokens: number;
  maxSpoolBytes?: number;
  ttlMs?: number;
  now?: number;
}

export interface ContinuationSpoolMetadata {
  spoolId: string;
  sessionId: string;
  createdAt: number;
  expiresAt: number;
  lastAccessedAt: number;
  captureRevision: number;
  rebuildAfterRevision: number;
  maxEventId: number | null;
  runtimeFingerprint: string;
  checkpoint: ContinuationCheckpointRecord | null;
  checkpointThroughRevision: number;
  materializedThroughRevision: number;
  uncoveredRevisionRange: { from: number; to: number } | null;
  spoolBytes: number;
  rawTailTokens: number;
  rawWarnings: Array<'legacy-wrapper-excluded' | 'legacy-wrapper-unwrapped'>;
  rawScanTruncated: boolean;
  consumed: boolean;
}

interface MetaRow {
  preparation_id: string;
  session_id: string;
  created_at: number;
  expires_at: number;
  last_accessed_at: number;
  capture_revision: number;
  rebuild_after_revision: number;
  max_event_id: number | null;
  runtime_fingerprint: string;
  checkpoint_json: string | null;
  checkpoint_through_revision: number;
  materialized_through_revision: number;
  spool_bytes: number;
  raw_tail_tokens: number;
  raw_warnings_json: string;
  raw_scan_truncated: number;
  consumed: number;
}

interface SourceRow {
  event_id: number;
  effective_revision: number;
  kind: string;
  payload_json: string;
  ts: number;
  tool_use_id: string | null;
}

function ensurePositiveSafeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${field} must be a positive safe integer`);
  return value;
}

function sourceRowBytes(row: RawEventRevisionRow): number {
  return utf8ByteLength(row.payloadJson) + utf8ByteLength(row.kind) + (row.toolUseId?.length ?? 0) + 64;
}

export class ContinuationSourceSpoolStore {
  constructor(private readonly db: Database) {
    this.ensureTables();
  }

  private ensureTables(): void {
    this.db.exec(`
      CREATE TEMP TABLE IF NOT EXISTS continuation_spool_meta (
        preparation_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        last_accessed_at INTEGER NOT NULL,
        capture_revision INTEGER NOT NULL,
        rebuild_after_revision INTEGER NOT NULL,
        max_event_id INTEGER,
        runtime_fingerprint TEXT NOT NULL,
        checkpoint_json TEXT,
        checkpoint_through_revision INTEGER NOT NULL,
        materialized_through_revision INTEGER NOT NULL,
        spool_bytes INTEGER NOT NULL,
        raw_tail_tokens INTEGER NOT NULL,
        raw_warnings_json TEXT NOT NULL,
        raw_scan_truncated INTEGER NOT NULL DEFAULT 0,
        consumed INTEGER NOT NULL DEFAULT 0
      );
      CREATE TEMP TABLE IF NOT EXISTS continuation_source_spool (
        preparation_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        event_id INTEGER NOT NULL,
        effective_revision INTEGER NOT NULL,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        ts INTEGER NOT NULL,
        tool_use_id TEXT,
        PRIMARY KEY(preparation_id, ordinal)
      );
      CREATE INDEX IF NOT EXISTS continuation_source_spool_revision
        ON continuation_source_spool(preparation_id, effective_revision, event_id);
      CREATE TEMP TABLE IF NOT EXISTS continuation_raw_spool (
        preparation_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        input_json TEXT NOT NULL,
        PRIMARY KEY(preparation_id, ordinal)
      );
    `);
  }

  capture(input: CaptureContinuationSourceInput): ContinuationSpoolMetadata {
    const maxSpoolBytes = ensurePositiveSafeInteger(
      input.maxSpoolBytes ?? DEFAULT_CONTINUATION_SPOOL_MAX_BYTES,
      'maxSpoolBytes',
    );
    const ttlMs = ensurePositiveSafeInteger(input.ttlMs ?? DEFAULT_CONTINUATION_SPOOL_TTL_MS, 'ttlMs');
    if (!Number.isSafeInteger(input.rawRetentionCeilingTokens) || input.rawRetentionCeilingTokens < 0) {
      throw new Error('rawRetentionCeilingTokens must be a non-negative safe integer');
    }
    const now = input.now ?? Date.now();
    const spoolId = randomUUID();
    const transaction = this.db.transaction(() => {
      const revisionRepo = createEventRevisionRepo(this.db);
      const state = revisionRepo.state(input.sessionId);
      if (!state) throw new Error(`Cannot capture continuation source for missing session ${input.sessionId}`);
      const checkpoint = createContinuationCheckpointRepo(this.db).latest(input.sessionId);
      const checkpointThroughRevision = checkpoint?.sourceEventRevision ?? 0;
      const runtimeFingerprint = continuationSessionRuntimeFingerprint(this.db, input.sessionId);
      if (!runtimeFingerprint) {
        throw new Error(`Cannot capture runtime for missing session ${input.sessionId}`);
      }
      const maxEventId = this.db
        .prepare(`SELECT MAX(id) FROM events WHERE session_id = ?`)
        .pluck()
        .get(input.sessionId) as number | null;
      const checkpointJson = checkpoint ? JSON.stringify(checkpoint) : null;
      let spoolBytes = checkpointJson ? utf8ByteLength(checkpointJson) : 0;
      let ordinal = 0;
      let materializedThroughRevision = checkpointThroughRevision;
      let cursor: EventRevisionCursor = {
        revision: checkpointThroughRevision,
        id: Number.MAX_SAFE_INTEGER,
      };
      let resourceGuardHit = false;
      let pendingGroup: RawEventRevisionRow[] = [];
      const insertSource = this.db.prepare(
        `INSERT INTO continuation_source_spool
           (preparation_id, ordinal, event_id, effective_revision, kind, payload_json, ts, tool_use_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );

      const storeGroup = (group: RawEventRevisionRow[]): boolean => {
        if (group.length === 0) return true;
        const groupBytes = group.reduce((total, row) => total + sourceRowBytes(row), 0);
        if (spoolBytes + groupBytes > maxSpoolBytes) return false;
        for (const row of group) {
          insertSource.run(
            spoolId,
            ordinal,
            row.id,
            row.effectiveRevision,
            row.kind,
            row.payloadJson,
            row.ts,
            row.toolUseId,
          );
          ordinal += 1;
        }
        spoolBytes += groupBytes;
        materializedThroughRevision = group[0].effectiveRevision;
        return true;
      };

      for (;;) {
        const page = revisionRepo.listRawEvents({
          sessionId: input.sessionId,
          throughRevision: state.revision,
          after: cursor,
          limit: 500,
        });
        if (page.length === 0) {
          if (!storeGroup(pendingGroup)) resourceGuardHit = true;
          pendingGroup = [];
          if (resourceGuardHit) break;
          materializedThroughRevision = state.revision;
          break;
        }
        for (const row of page) {
          if (
            pendingGroup.length > 0 &&
            pendingGroup[0].effectiveRevision !== row.effectiveRevision
          ) {
            if (!storeGroup(pendingGroup)) {
              resourceGuardHit = true;
              break;
            }
            pendingGroup = [];
          }
          pendingGroup.push(row);
        }
        if (resourceGuardHit) break;
        const last = page.at(-1)!;
        cursor = { revision: last.effectiveRevision, id: last.id };
        if (page.length < 500) {
          if (!storeGroup(pendingGroup)) resourceGuardHit = true;
          pendingGroup = [];
          if (resourceGuardHit) break;
          materializedThroughRevision = state.revision;
          break;
        }
      }

      const rawCandidates: ClassifiedContinuationMessage[] = [];
      const rawWarnings = new Set<'legacy-wrapper-excluded' | 'legacy-wrapper-unwrapped'>();
      let rawCursor: EventRevisionCursor | null = null;
      let rawScanBytes = 0;
      let rawScanTruncated = false;
      for (;;) {
        const params: Array<string | number> = [input.sessionId, state.revision];
        const cursorClause = rawCursor
          ? `AND (COALESCE(change_revision, id), id) < (?, ?)`
          : '';
        if (rawCursor) params.push(rawCursor.revision, rawCursor.id);
        params.push(128);
        const rows = this.db
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
          if (spoolBytes + rawScanBytes > maxSpoolBytes) {
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
      const insertRaw = this.db.prepare(
        `INSERT INTO continuation_raw_spool (preparation_id, ordinal, input_json)
         VALUES (?, ?, ?)`,
      );
      const retainedRawNewestFirst: RawContinuationUserInput[] = [];
      for (const message of [...rawSelection.messages].reverse()) {
        const inputJson = JSON.stringify(message);
        const bytes = utf8ByteLength(inputJson) + 32;
        if (spoolBytes + bytes > maxSpoolBytes) {
          rawScanTruncated = true;
          break;
        }
        retainedRawNewestFirst.push(message);
        spoolBytes += bytes;
      }
      const retainedRaw = retainedRawNewestFirst.reverse();
      retainedRaw.forEach((message, index) => {
        insertRaw.run(spoolId, index, JSON.stringify(message));
      });
      const retainedRawTokens = estimateRawUserTailTokens(retainedRaw);

      this.db
        .prepare(
          `INSERT INTO continuation_spool_meta (
             preparation_id, session_id, created_at, expires_at, last_accessed_at,
             capture_revision, rebuild_after_revision, max_event_id, runtime_fingerprint, checkpoint_json,
             checkpoint_through_revision, materialized_through_revision, spool_bytes,
             raw_tail_tokens, raw_warnings_json, raw_scan_truncated, consumed
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
        )
        .run(
          spoolId,
          input.sessionId,
          now,
          now + ttlMs,
          now,
          state.revision,
          state.rebuildAfterRevision,
          maxEventId,
          runtimeFingerprint,
          checkpointJson,
          checkpointThroughRevision,
          materializedThroughRevision,
          spoolBytes,
          retainedRawTokens,
          JSON.stringify([...rawWarnings]),
          rawScanTruncated ? 1 : 0,
        );
    });
    transaction.immediate();
    return this.metadata(spoolId, now);
  }

  metadata(spoolId: string, now?: number): ContinuationSpoolMetadata {
    const accessedAt = now ?? Date.now();
    const row = this.db
      .prepare(`SELECT * FROM continuation_spool_meta WHERE preparation_id = ?`)
      .get(spoolId) as MetaRow | undefined;
    if (!row) throw new Error(`Continuation source spool not found: ${spoolId}`);
    if (now !== undefined && row.expires_at <= accessedAt) {
      this.cleanup(spoolId);
      throw new Error(`Continuation source spool expired: ${spoolId}`);
    }
    this.db
      .prepare(`UPDATE continuation_spool_meta SET last_accessed_at = ? WHERE preparation_id = ?`)
      .run(accessedAt, spoolId);
    return {
      spoolId: row.preparation_id,
      sessionId: row.session_id,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      lastAccessedAt: accessedAt,
      captureRevision: row.capture_revision,
      rebuildAfterRevision: row.rebuild_after_revision,
      maxEventId: row.max_event_id,
      runtimeFingerprint: row.runtime_fingerprint,
      checkpoint: row.checkpoint_json
        ? (JSON.parse(row.checkpoint_json) as ContinuationCheckpointRecord)
        : null,
      checkpointThroughRevision: row.checkpoint_through_revision,
      materializedThroughRevision: row.materialized_through_revision,
      uncoveredRevisionRange:
        row.materialized_through_revision < row.capture_revision
          ? { from: row.materialized_through_revision, to: row.capture_revision }
          : null,
      spoolBytes: row.spool_bytes,
      rawTailTokens: row.raw_tail_tokens,
      rawWarnings: JSON.parse(row.raw_warnings_json) as ContinuationSpoolMetadata['rawWarnings'],
      rawScanTruncated: row.raw_scan_truncated === 1,
      consumed: row.consumed === 1,
    };
  }

  readSourceRows(spoolId: string, afterOrdinal = -1, limit = 500): RawEventRevisionRow[] {
    const safeLimit = Math.min(1_000, ensurePositiveSafeInteger(limit, 'limit'));
    const sessionId = this.metadata(spoolId).sessionId;
    const rows = this.db
      .prepare(
        `SELECT event_id, effective_revision, kind, payload_json, ts, tool_use_id
           FROM continuation_source_spool
          WHERE preparation_id = ? AND ordinal > ?
          ORDER BY ordinal ASC
          LIMIT ?`,
      )
      .all(spoolId, afterOrdinal, safeLimit) as SourceRow[];
    return rows.map((row) => ({
      id: row.event_id,
      sessionId,
      effectiveRevision: row.effective_revision,
      kind: row.kind,
      payloadJson: row.payload_json,
      ts: row.ts,
      toolUseId: row.tool_use_id,
    }));
  }

  readRawInputs(spoolId: string): RawContinuationUserInput[] {
    this.metadata(spoolId);
    return (
      this.db
        .prepare(
          `SELECT input_json FROM continuation_raw_spool
            WHERE preparation_id = ? ORDER BY ordinal ASC`,
        )
        .pluck()
        .all(spoolId) as string[]
    ).map((json) => JSON.parse(json) as RawContinuationUserInput);
  }

  markConsumed(spoolId: string): boolean {
    return (
      this.db
        .prepare(
          `UPDATE continuation_spool_meta SET consumed = 1
            WHERE preparation_id = ? AND consumed = 0`,
        )
        .run(spoolId).changes === 1
    );
  }

  cleanup(spoolId: string): void {
    const tx = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM continuation_source_spool WHERE preparation_id = ?`).run(spoolId);
      this.db.prepare(`DELETE FROM continuation_raw_spool WHERE preparation_id = ?`).run(spoolId);
      this.db.prepare(`DELETE FROM continuation_spool_meta WHERE preparation_id = ?`).run(spoolId);
    });
    tx.immediate();
  }

  cleanupSession(sessionId: string): void {
    const ids = this.db
      .prepare(`SELECT preparation_id FROM continuation_spool_meta WHERE session_id = ?`)
      .pluck()
      .all(sessionId) as string[];
    ids.forEach((id) => this.cleanup(id));
  }

  purgeExpired(now = Date.now()): number {
    const ids = this.db
      .prepare(`SELECT preparation_id FROM continuation_spool_meta WHERE expires_at <= ?`)
      .pluck()
      .all(now) as string[];
    ids.forEach((id) => this.cleanup(id));
    return ids.length;
  }

  evictToByteLimit(maxBytes: number): number {
    ensurePositiveSafeInteger(maxBytes, 'maxBytes');
    const rows = this.db
      .prepare(
        `SELECT preparation_id, spool_bytes FROM continuation_spool_meta
          ORDER BY last_accessed_at DESC, created_at DESC`,
      )
      .all() as Array<{ preparation_id: string; spool_bytes: number }>;
    let retainedBytes = 0;
    let evicted = 0;
    for (const row of rows) {
      if (retainedBytes + row.spool_bytes <= maxBytes) {
        retainedBytes += row.spool_bytes;
      } else {
        this.cleanup(row.preparation_id);
        evicted += 1;
      }
    }
    return evicted;
  }

  cleanupAll(): void {
    this.db.exec(`
      DELETE FROM continuation_source_spool;
      DELETE FROM continuation_raw_spool;
      DELETE FROM continuation_spool_meta;
    `);
  }
}
