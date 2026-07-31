import { performance } from 'node:perf_hooks';
import type { Database } from 'better-sqlite3';

export interface SnapshotMaintenanceSliceResult {
  task: 'file-snapshot-gc';
  phase: 'idle' | 'cleanup';
  processed: number;
  durationMs: number;
}

/** Delete queued blobs that are no longer referenced by any current file-change row. */
export function runSnapshotGcSlice(
  db: Database,
  limit = 25,
): SnapshotMaintenanceSliceResult {
  const started = performance.now();
  const digests = db
    .prepare(`SELECT digest FROM file_snapshot_gc_queue ORDER BY queued_at ASC LIMIT ?`)
    .pluck()
    .all(limit) as Buffer[];
  if (digests.length === 0) {
    return {
      task: 'file-snapshot-gc',
      phase: 'idle',
      processed: 0,
      durationMs: performance.now() - started,
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
  // Acquire the WAL writer slot before probing. A concurrent snapshot writer then either commits
  // first and is visible here, or waits and recreates the blob with its reference atomically.
  cleanup.immediate();
  return {
    task: 'file-snapshot-gc',
    phase: 'cleanup',
    processed: digests.length,
    durationMs: performance.now() - started,
  };
}
