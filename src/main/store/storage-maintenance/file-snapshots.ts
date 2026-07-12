import { performance } from 'node:perf_hooks';
import type { Database } from 'better-sqlite3';
import {
  assertStoredSnapshotMatches,
  decodeFileSnapshotBlob,
  encodePersistedFileSnapshot,
  FILE_SNAPSHOT_CODEC,
  type EncodedFileSnapshot,
  type StoredFileSnapshotBlob,
} from '../file-snapshot-codec';
import {
  adaptBatchSize,
  readMaintenanceState,
  updateMaintenanceState,
  type StorageMaintenanceState,
} from './state';

const TASK = 'file-snapshot-blobs-v1' as const;
const SNAPSHOT_SLICE_RAW_BUDGET = 512 * 1024;

export interface SnapshotMaintenanceSliceResult {
  task: typeof TASK | 'file-snapshot-gc';
  phase: string;
  processed: number;
  durationMs: number;
  doneForRun: boolean;
}

export interface SnapshotIndexPreparationResult {
  prepared: boolean;
  durationMs: number;
}

interface LegacyRow {
  id: number;
  before_snapshot: string | null;
  after_snapshot: string | null;
}

interface CurrentLegacyRow extends LegacyRow {
  before_snapshot_hash: unknown;
  after_snapshot_hash: unknown;
}

interface EncodedLegacyRow {
  row: LegacyRow;
  before: EncodedFileSnapshot | null;
  after: EncodedFileSnapshot | null;
}

/** Deterministic interleaving seam for real two-connection tests. */
export interface SnapshotMaintenanceTestHooks {
  beforeBackfillWrite?: () => void;
}

interface VerifyRow extends LegacyRow {
  before_snapshot_hash: Buffer | null;
  before_codec: unknown;
  before_raw_bytes: unknown;
  before_compressed_bytes: unknown;
  before_data: unknown;
  after_snapshot_hash: Buffer | null;
  after_codec: unknown;
  after_raw_bytes: unknown;
  after_compressed_bytes: unknown;
  after_data: unknown;
}

export function runSnapshotMaintenanceSlice(
  db: Database,
  testHooks: SnapshotMaintenanceTestHooks = {},
): SnapshotMaintenanceSliceResult | null {
  const state = readMaintenanceState(db, TASK);
  if (!state) return null;
  if (state.phase === 'backfill') return backfill(db, state, testHooks);
  if (state.phase === 'verify' || state.phase === 'restart-verify') {
    return verify(db, state);
  }
  if (state.phase === 'clear') return clearLegacy(db, state);
  return {
    task: TASK,
    phase: state.phase,
    processed: 0,
    durationMs: 0,
    doneForRun: true,
  };
}

/** Called only when awaiting-restart was already durable before this app run. */
export function beginSnapshotRestartVerification(db: Database): void {
  const state = readMaintenanceState(db, TASK);
  // Worker replacement reuses the app-run eligibility snapshot. Once this run already advanced
  // past awaiting-restart, replaying that eligibility must not rewind durable verification/clear.
  if (state?.phase !== 'awaiting-restart') return;
  updateMaintenanceState(db, TASK, {
    phase: 'restart-verify',
    cursor: 0,
    batchSize: 8,
    lastError: null,
  });
}

export function runSnapshotGcSlice(
  db: Database,
  limit = 25,
): SnapshotMaintenanceSliceResult {
  const started = performance.now();
  if (readMaintenanceState(db, TASK)?.phase !== 'complete') {
    return {
      task: 'file-snapshot-gc',
      phase: 'deferred',
      processed: 0,
      durationMs: performance.now() - started,
      doneForRun: true,
    };
  }
  const digests = db.prepare(
    `SELECT digest FROM file_snapshot_gc_queue ORDER BY queued_at ASC LIMIT ?`,
  ).pluck().all(limit) as Buffer[];
  if (digests.length === 0) {
    return {
      task: 'file-snapshot-gc',
      phase: 'idle',
      processed: 0,
      durationMs: performance.now() - started,
      doneForRun: true,
    };
  }
  const referenced = db.prepare(
    `SELECT 1 FROM file_changes WHERE before_snapshot_hash = ?
     UNION ALL
     SELECT 1 FROM file_changes WHERE after_snapshot_hash = ?
     LIMIT 1`,
  );
  const deleteBlob = db.prepare('DELETE FROM file_snapshot_blobs WHERE digest = ?');
  const dequeue = db.prepare('DELETE FROM file_snapshot_gc_queue WHERE digest = ?');
  const cleanup = db.transaction(() => {
    for (const digest of digests) {
      if (!referenced.get(digest, digest)) deleteBlob.run(digest);
      dequeue.run(digest);
    }
  });
  // A deferred read-then-write transaction can observe "unreferenced", lose a writer race, and
  // fail its upgrade with SQLITE_BUSY_SNAPSHOT. Acquire the WAL writer slot before probing so a
  // concurrent hash-only ingress either commits first and is visible here, or waits until cleanup
  // finishes and recreates its blob atomically with the new reference.
  cleanup.immediate();
  return {
    task: 'file-snapshot-gc',
    phase: 'cleanup',
    processed: digests.length,
    durationMs: performance.now() - started,
    doneForRun: false,
  };
}

function backfill(
  db: Database,
  state: StorageMaintenanceState,
  testHooks: SnapshotMaintenanceTestHooks,
): SnapshotMaintenanceSliceResult {
  const started = performance.now();
  const selectedRows = db.prepare(
    `SELECT id, before_snapshot, after_snapshot FROM file_changes
      WHERE id > ? AND id <= ? ORDER BY id ASC LIMIT ?`,
  ).all(state.cursor, state.upperBound, state.batchSize) as LegacyRow[];
  const rows = withinRawBudget(selectedRows);
  if (rows.length === 0) {
    updateMaintenanceState(db, TASK, {
      phase: 'verify',
      cursor: 0,
      batchSize: 8,
      lastError: null,
    });
    return result('verify', 0, performance.now() - started, false);
  }

  // SHA-256 and DEFLATE intentionally finish before acquiring the cross-connection writer lock.
  const encodedRows: EncodedLegacyRow[] = rows.map((row) => ({
    row,
    before: encodePersistedFileSnapshot(row.before_snapshot),
    after: encodePersistedFileSnapshot(row.after_snapshot),
  }));
  const unique = uniqueSnapshots(encodedRows.flatMap(({ before, after }) => [before, after]));
  // Existing-blob collision/integrity checks inflate and hash data. Keep those checks outside the
  // short write transaction too; an unexpected digest inserted after this preflight causes a safe
  // rollback/retry instead of moving expensive validation under the writer lock.
  const prevalidatedDigests = prevalidateSnapshotBlobs(db, unique);
  testHooks.beforeBackfillWrite?.();

  const readCurrent = db.prepare(
    `SELECT id, before_snapshot, after_snapshot,
            before_snapshot_hash, after_snapshot_hash
       FROM file_changes WHERE id = ?`,
  );
  const update = db.prepare(
    `UPDATE file_changes
        SET before_snapshot_hash = COALESCE(before_snapshot_hash, ?),
            after_snapshot_hash = COALESCE(after_snapshot_hash, ?)
      WHERE id = ?
        AND before_snapshot IS ?
        AND after_snapshot IS ?`,
  );

  const write = db.transaction(() => {
    const liveRows: EncodedLegacyRow[] = [];
    for (const encoded of encodedRows) {
      const current = readCurrent.get(encoded.row.id) as CurrentLegacyRow | undefined;
      // A concurrent session cascade already removed both the source row and any possible
      // reference. Treat it as processed, but never create a blob for it.
      if (!current) continue;
      if (
        current.before_snapshot !== encoded.row.before_snapshot ||
        current.after_snapshot !== encoded.row.after_snapshot
      ) {
        throw new Error(`snapshot source changed during backfill (id=${encoded.row.id})`);
      }
      assertCurrentHashMatches(encoded.row.id, 'before', current.before_snapshot_hash, encoded.before);
      assertCurrentHashMatches(encoded.row.id, 'after', current.after_snapshot_hash, encoded.after);
      liveRows.push(encoded);
    }

    const liveSnapshots = uniqueSnapshots(
      liveRows.flatMap(({ before, after }) => [before, after]),
    );
    for (const snapshot of liveSnapshots) {
      insertPrevalidatedSnapshotBlob(db, snapshot, prevalidatedDigests);
    }
    for (const encoded of liveRows) {
      const info = update.run(
        encoded.before?.digest ?? null,
        encoded.after?.digest ?? null,
        encoded.row.id,
        encoded.row.before_snapshot,
        encoded.row.after_snapshot,
      );
      if (info.changes !== 1) {
        throw new Error(`snapshot source changed during guarded update (id=${encoded.row.id})`);
      }
    }
    updateMaintenanceState(db, TASK, {
      cursor: rows[rows.length - 1].id,
      lastError: null,
    });
  });
  // Revalidation must happen after obtaining the writer slot. This keeps the source values stable
  // through blob insertion, hash assignment, and cursor commit while leaving all codec CPU outside.
  write.immediate();
  const durationMs = performance.now() - started;
  const batchSize = adaptBatchSize(state.batchSize, durationMs, { min: 1, max: 8 });
  if (batchSize !== state.batchSize) updateMaintenanceState(db, TASK, { batchSize });
  return result('backfill', rows.length, durationMs, false);
}

function verify(db: Database, state: StorageMaintenanceState): SnapshotMaintenanceSliceResult {
  const started = performance.now();
  const selectedRows = db.prepare(
    `${VERIFY_SELECT}
      WHERE fc.id > ? AND fc.id <= ?
        AND (fc.before_snapshot IS NOT NULL OR fc.after_snapshot IS NOT NULL)
      ORDER BY fc.id ASC LIMIT ?`,
  ).all(state.cursor, state.upperBound, state.batchSize) as VerifyRow[];
  const rows = withinRawBudget(selectedRows);
  if (rows.length === 0) {
    const unresolved = Number(db.prepare(
      `SELECT COUNT(*) FROM file_changes
        WHERE id <= ? AND (
          (before_snapshot IS NOT NULL AND before_snapshot_hash IS NULL) OR
          (after_snapshot IS NOT NULL AND after_snapshot_hash IS NULL)
        )`,
    ).pluck().get(state.upperBound));
    if (unresolved !== 0) throw new Error(`snapshot backfill has ${unresolved} unresolved values`);
    const nextPhase = state.phase === 'restart-verify' ? 'clear' : 'awaiting-restart';
    updateMaintenanceState(db, TASK, {
      phase: nextPhase,
      cursor: 0,
      batchSize: nextPhase === 'clear' ? 100 : 8,
      lastError: null,
    });
    return result(nextPhase, 0, performance.now() - started, nextPhase === 'awaiting-restart');
  }

  for (const row of rows) verifyRow(row);
  updateMaintenanceState(db, TASK, {
    cursor: rows[rows.length - 1].id,
    lastError: null,
  });
  const durationMs = performance.now() - started;
  const batchSize = adaptBatchSize(state.batchSize, durationMs, { min: 1, max: 12 });
  if (batchSize !== state.batchSize) updateMaintenanceState(db, TASK, { batchSize });
  return result(state.phase, rows.length, durationMs, false);
}

function clearLegacy(
  db: Database,
  state: StorageMaintenanceState,
): SnapshotMaintenanceSliceResult {
  const started = performance.now();
  const ids = db.prepare(
    `SELECT id FROM file_changes
      WHERE id > ? AND id <= ? ORDER BY id ASC LIMIT ?`,
  ).pluck().all(state.cursor, state.upperBound, state.batchSize) as number[];
  if (ids.length === 0) {
    const remaining = Number(db.prepare(
      `SELECT COUNT(*) FROM file_changes
        WHERE id <= ? AND (before_snapshot IS NOT NULL OR after_snapshot IS NOT NULL)`,
    ).pluck().get(state.upperBound));
    if (remaining !== 0) throw new Error(`snapshot clear left ${remaining} legacy rows`);
    updateMaintenanceState(db, TASK, {
      phase: 'indexes-on-shutdown',
      cursor: state.upperBound,
      lastError: null,
    });
    return result('indexes-on-shutdown', 0, performance.now() - started, true);
  }
  const clear = db.prepare(
    `UPDATE file_changes
        SET before_snapshot = CASE WHEN before_snapshot_hash IS NOT NULL THEN NULL ELSE before_snapshot END,
            after_snapshot = CASE WHEN after_snapshot_hash IS NOT NULL THEN NULL ELSE after_snapshot END
      WHERE id = ?`,
  );
  db.transaction(() => {
    for (const id of ids) clear.run(id);
    updateMaintenanceState(db, TASK, { cursor: ids[ids.length - 1], lastError: null });
  })();
  const durationMs = performance.now() - started;
  const batchSize = adaptBatchSize(state.batchSize, durationMs, { min: 25, max: 100 });
  if (batchSize !== state.batchSize) updateMaintenanceState(db, TASK, { batchSize });
  return result('clear', ids.length, durationMs, false);
}

/** Build GC lookup indexes only after ingress drained and large inline snapshots were cleared. */
export function prepareSnapshotGcIndexesOnShutdown(
  db: Database,
): SnapshotIndexPreparationResult {
  const state = readMaintenanceState(db, TASK);
  if (state?.phase !== 'indexes-on-shutdown') {
    return { prepared: false, durationMs: 0 };
  }
  const started = performance.now();
  db.transaction(() => {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_file_changes_before_snapshot_hash
        ON file_changes(before_snapshot_hash)
        WHERE before_snapshot_hash IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_file_changes_after_snapshot_hash
        ON file_changes(after_snapshot_hash)
        WHERE after_snapshot_hash IS NOT NULL;
    `);
    updateMaintenanceState(db, TASK, {
      phase: 'complete',
      lastError: null,
    });
  })();
  return { prepared: true, durationMs: performance.now() - started };
}

function prevalidateSnapshotBlobs(
  db: Database,
  snapshots: EncodedFileSnapshot[],
): Set<string> {
  const select = db.prepare(
    `SELECT codec, raw_bytes AS rawBytes, compressed_bytes AS compressedBytes, data
       FROM file_snapshot_blobs WHERE digest = ?`,
  );
  const prevalidated = new Set<string>();
  for (const snapshot of snapshots) {
    const stored = select.get(snapshot.digest) as StoredFileSnapshotBlob | undefined;
    if (!stored) continue;
    assertStoredSnapshotMatches(snapshot, stored);
    prevalidated.add(snapshot.digestHex);
  }
  return prevalidated;
}

function insertPrevalidatedSnapshotBlob(
  db: Database,
  snapshot: EncodedFileSnapshot,
  prevalidatedDigests: Set<string>,
): void {
  const info = db.prepare(
    `INSERT OR IGNORE INTO file_snapshot_blobs
      (digest, codec, raw_bytes, compressed_bytes, data) VALUES (?, ?, ?, ?, ?)`,
  ).run(
    snapshot.digest,
    FILE_SNAPSHOT_CODEC,
    snapshot.rawBytes,
    snapshot.compressedBytes,
    snapshot.data,
  );
  if (info.changes > 0) return;
  if (prevalidatedDigests.has(snapshot.digestHex)) return;
  // Another connection inserted this digest after the CPU-heavy preflight. Roll back the whole
  // data+cursor transaction; the next slice will validate that row outside the writer lock.
  throw new Error(`snapshot digest appeared after preflight (${snapshot.digestHex})`);
}

function assertCurrentHashMatches(
  id: number,
  side: 'before' | 'after',
  current: unknown,
  encoded: EncodedFileSnapshot | null,
): void {
  if (current == null) return;
  if (!encoded || !Buffer.isBuffer(current) || !current.equals(encoded.digest)) {
    throw new Error(`snapshot hash changed during backfill (id=${id}, side=${side})`);
  }
}

function verifyRow(row: VerifyRow): void {
  verifySide(row.id, 'before', row.before_snapshot, row.before_snapshot_hash, {
    codec: row.before_codec,
    rawBytes: row.before_raw_bytes,
    compressedBytes: row.before_compressed_bytes,
    data: row.before_data,
  });
  verifySide(row.id, 'after', row.after_snapshot, row.after_snapshot_hash, {
    codec: row.after_codec,
    rawBytes: row.after_raw_bytes,
    compressedBytes: row.after_compressed_bytes,
    data: row.after_data,
  });
}

function verifySide(
  id: number,
  side: string,
  legacy: string | null,
  digest: Buffer | null,
  stored: StoredFileSnapshotBlob,
): void {
  if (legacy === null) return;
  const expected = encodePersistedFileSnapshot(legacy)!;
  if (!digest || !digest.equals(expected.digest)) {
    throw new Error(`snapshot digest mismatch (id=${id}, side=${side})`);
  }
  if (decodeFileSnapshotBlob(digest, stored) !== legacy) {
    throw new Error(`snapshot round-trip mismatch (id=${id}, side=${side})`);
  }
}

function uniqueSnapshots(values: Array<EncodedFileSnapshot | null>): EncodedFileSnapshot[] {
  const byDigest = new Map<string, EncodedFileSnapshot>();
  for (const value of values) if (value) byDigest.set(value.digestHex, value);
  return [...byDigest.values()];
}

function withinRawBudget<T extends LegacyRow>(rows: T[]): T[] {
  let bytes = 0;
  let count = 0;
  for (const row of rows) {
    const rowBytes = Buffer.byteLength(row.before_snapshot ?? '', 'utf8') +
      Buffer.byteLength(row.after_snapshot ?? '', 'utf8');
    if (count > 0 && bytes + rowBytes > SNAPSHOT_SLICE_RAW_BUDGET) break;
    bytes += rowBytes;
    count += 1;
  }
  return rows.slice(0, count);
}

function result(
  phase: string,
  processed: number,
  durationMs: number,
  doneForRun: boolean,
): SnapshotMaintenanceSliceResult {
  return { task: TASK, phase, processed, durationMs, doneForRun };
}

const VERIFY_SELECT = `
  SELECT fc.id, fc.before_snapshot, fc.after_snapshot,
         fc.before_snapshot_hash,
         before_blob.codec AS before_codec,
         before_blob.raw_bytes AS before_raw_bytes,
         before_blob.compressed_bytes AS before_compressed_bytes,
         before_blob.data AS before_data,
         fc.after_snapshot_hash,
         after_blob.codec AS after_codec,
         after_blob.raw_bytes AS after_raw_bytes,
         after_blob.compressed_bytes AS after_compressed_bytes,
         after_blob.data AS after_data
    FROM file_changes fc
    LEFT JOIN file_snapshot_blobs before_blob ON before_blob.digest = fc.before_snapshot_hash
    LEFT JOIN file_snapshot_blobs after_blob ON after_blob.digest = fc.after_snapshot_hash`;
