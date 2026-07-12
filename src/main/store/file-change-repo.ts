import type { FileChangeRecord } from '@shared/types';
import {
  isEffectiveCodexFileChange,
  isIncompleteCodexFileChangeStatus,
} from '@shared/codex-file-change';
import { getDb } from './db';
import { safeStringifyPayload, safeTruncateBlob } from './payload-truncate';
import {
  assertStoredSnapshotMatches,
  encodeFileSnapshot,
  FILE_SNAPSHOT_CODEC,
  type EncodedFileSnapshot,
  type StoredFileSnapshotBlob,
} from './file-snapshot-codec';
import { FileSnapshotReader } from './file-snapshot-reader';
import log from '@main/utils/logger';

const logger = log.scope('store-file-change-repo');
const SLOW_FILE_CHANGE_WRITE_MS = 250;

interface Row {
  id: number;
  session_id: string;
  file_path: string;
  kind: string;
  before_blob: string | null;
  after_blob: string | null;
  before_snapshot?: string | null;
  after_snapshot?: string | null;
  before_snapshot_hash?: Buffer | null;
  after_snapshot_hash?: Buffer | null;
  before_snapshot_codec?: unknown;
  before_snapshot_raw_bytes?: unknown;
  before_snapshot_compressed_bytes?: unknown;
  before_snapshot_data?: unknown;
  after_snapshot_codec?: unknown;
  after_snapshot_raw_bytes?: unknown;
  after_snapshot_compressed_bytes?: unknown;
  after_snapshot_data?: unknown;
  metadata_json: string;
  tool_call_id: string | null;
  ts: number;
}

function rowToRecord(r: Row, snapshots: FileSnapshotReader): FileChangeRecord {
  // metadata_json 单条解析失败不能炸全列表（renderer 拉取走 .map(rowToRecord)，
  // 一条异常 → 整个 SessionDetail diff tab 抛错）。回落 {} + warn，让 dev 能看到
  // 但用户不受影响。REVIEW_2 修。
  let metadata: Record<string, unknown> = {};
  try {
    metadata = JSON.parse(r.metadata_json) as Record<string, unknown>;
  } catch (err) {
    logger.warn(
      `[file-change-repo] metadata_json parse failed for id=${r.id} session=${r.session_id}:`,
      err,
    );
  }
  return {
    id: r.id,
    sessionId: r.session_id,
    filePath: r.file_path,
    kind: r.kind,
    beforeBlob: r.before_blob,
    afterBlob: r.after_blob,
    beforeSnapshot: snapshots.read(
      snapshotSelection(r, 'before'),
      r.before_snapshot,
      `id=${r.id} session=${r.session_id} side=before`,
    ),
    afterSnapshot: snapshots.read(
      snapshotSelection(r, 'after'),
      r.after_snapshot,
      `id=${r.id} session=${r.session_id} side=after`,
    ),
    metadata,
    toolCallId: r.tool_call_id,
    ts: r.ts,
  };
}

function snapshotSelection(r: Row, side: 'before' | 'after') {
  return {
    hash: r[`${side}_snapshot_hash`],
    codec: r[`${side}_snapshot_codec`],
    rawBytes: r[`${side}_snapshot_raw_bytes`],
    compressedBytes: r[`${side}_snapshot_compressed_bytes`],
    data: r[`${side}_snapshot_data`],
  };
}

function shouldExposeFileChange(rec: FileChangeRecord): boolean {
  if (rec.kind !== 'text') return true;
  if (rec.metadata.source !== 'codex') return true;
  if (isIncompleteCodexFileChangeStatus(rec.metadata.patchStatus)) return false;
  const diff = typeof rec.metadata.diff === 'string' ? rec.metadata.diff : undefined;
  return isEffectiveCodexFileChange(readCodexChangeKind(rec.metadata.changeKind), diff);
}

function readCodexChangeKind(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const type = (value as { type?: unknown }).type;
    return typeof type === 'string' ? type : undefined;
  }
  return undefined;
}

function insertSnapshotBlob(
  db: ReturnType<typeof getDb>,
  snapshot: EncodedFileSnapshot,
): void {
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO file_snapshot_blobs
       (digest, codec, raw_bytes, compressed_bytes, data)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      snapshot.digest,
      FILE_SNAPSHOT_CODEC,
      snapshot.rawBytes,
      snapshot.compressedBytes,
      snapshot.data,
    );
  if (result.changes > 0) return;

  const stored = db
    .prepare(
      `SELECT codec,
              raw_bytes AS rawBytes,
              compressed_bytes AS compressedBytes,
              data
         FROM file_snapshot_blobs
        WHERE digest = ?`,
    )
    .get(snapshot.digest) as StoredFileSnapshotBlob | undefined;
  assertStoredSnapshotMatches(snapshot, stored);
}

function uniqueSnapshots(
  before: EncodedFileSnapshot | null,
  after: EncodedFileSnapshot | null,
): EncodedFileSnapshot[] {
  const byDigest = new Map<string, EncodedFileSnapshot>();
  if (before) byDigest.set(before.digestHex, before);
  if (after) byDigest.set(after.digestHex, after);
  return [...byDigest.values()];
}

export const fileChangeRepo = {
  insert(rec: Omit<FileChangeRecord, 'id'>): number {
    const startedAt = performance.now();
    const beforeSnapshot = encodeFileSnapshot(rec.beforeSnapshot);
    const afterSnapshot = encodeFileSnapshot(rec.afterSnapshot);
    const snapshots = uniqueSnapshots(beforeSnapshot, afterSnapshot);
    const rawBytes = snapshots.reduce((total, snapshot) => total + snapshot.rawBytes, 0);
    const compressedBytes = snapshots.reduce(
      (total, snapshot) => total + snapshot.compressedBytes,
      0,
    );
    const beforeBlob = safeTruncateBlob(rec.beforeBlob);
    const afterBlob = safeTruncateBlob(rec.afterBlob);
    const metadataJson = safeStringifyPayload(rec.metadata ?? {});
    try {
      const db = getDb();
      const insertAtomically = db.transaction(() => {
        for (const snapshot of snapshots) insertSnapshotBlob(db, snapshot);
        const info = db
          .prepare(
            `INSERT INTO file_changes
             (session_id, file_path, kind, before_blob, after_blob,
              before_snapshot, after_snapshot, before_snapshot_hash, after_snapshot_hash,
              metadata_json, tool_call_id, ts)
             VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?)`,
          )
          .run(
            rec.sessionId,
            rec.filePath,
            rec.kind,
            beforeBlob,
            afterBlob,
            beforeSnapshot?.digest ?? null,
            afterSnapshot?.digest ?? null,
            metadataJson,
            rec.toolCallId,
            rec.ts,
          );
        return Number(info.lastInsertRowid);
      });
      return insertAtomically();
    } finally {
      const durationMs = performance.now() - startedAt;
      if (durationMs >= SLOW_FILE_CHANGE_WRITE_MS) {
        logger.warn('[performance] slow file-change persistence', {
          durationMs: Math.round(durationMs),
          sessionId: rec.sessionId.slice(0, 8),
          snapshotCount: snapshots.length,
          rawBytes,
          compressedBytes,
        });
      }
    }
  },

  listForSession(sessionId: string): FileChangeRecord[] {
    // 同毫秒写入（Edit + 紧跟 Read 触发的二次 file-changed）次序由 SQLite 内部决定，
    // 不稳定会让 SessionDetail 文件列表 / ChangeTimeline 在刷新后 row 顺序跳动。
    // 加 id DESC 作为 secondary key（自增 PK 单调），同 ts 也能稳定。REVIEW_2 修。
    const rows = getDb()
      .prepare(
        `SELECT fc.*,
                before_blob_row.codec AS before_snapshot_codec,
                before_blob_row.raw_bytes AS before_snapshot_raw_bytes,
                before_blob_row.compressed_bytes AS before_snapshot_compressed_bytes,
                before_blob_row.data AS before_snapshot_data,
                after_blob_row.codec AS after_snapshot_codec,
                after_blob_row.raw_bytes AS after_snapshot_raw_bytes,
                after_blob_row.compressed_bytes AS after_snapshot_compressed_bytes,
                after_blob_row.data AS after_snapshot_data
           FROM file_changes AS fc
      LEFT JOIN file_snapshot_blobs AS before_blob_row
             ON before_blob_row.digest = fc.before_snapshot_hash
      LEFT JOIN file_snapshot_blobs AS after_blob_row
             ON after_blob_row.digest = fc.after_snapshot_hash
          WHERE fc.session_id = ?
       ORDER BY fc.ts DESC, fc.id DESC`,
      )
      .all(sessionId) as Row[];
    const snapshots = new FileSnapshotReader((message, err) => logger.warn(message, err));
    return rows.map((row) => rowToRecord(row, snapshots)).filter(shouldExposeFileChange);
  },

  countForSession(sessionId: string): number {
    const r = getDb()
      .prepare(`SELECT COUNT(*) as c FROM file_changes WHERE session_id = ?`)
      .get(sessionId) as { c: number };
    return r.c;
  },
};
